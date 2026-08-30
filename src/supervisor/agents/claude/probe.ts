import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentCapability, AgentTerminalAuthMethod } from "@/shared/contracts";
import { sanitizePrivilegedChildEnvironment } from "@/supervisor/privilegedChildEnvironment";
import type { SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import {
  readWslLoginShellCommandOutputAsync,
  type CapabilitiesProbeResult,
  type DetectProbeCtx,
} from "../base";
import { CLAUDE_FAST_MODE_DISABLED_MESSAGE } from "./detection";
import { resolveFastModeCachePath } from "./fastModeCache";
import { resolveFastAvailability } from "./fastModeProbe";
import { claudeCapabilitiesFromCliVersion, claudeCapabilitiesFromSdkModels } from "./models";
import { AsyncPromptQueue } from "./promptQueue";
import { spawnClaudeProbeProcess } from "./sdkProbeProcess";
import { buildVerifiedWslEsmArgv, deployFilesToWslTempBase } from "../../wsl/wslDeploy";

export { claudeCapabilitiesFromCliVersion } from "./models";

const CLAUDE_TERMINAL_AUTH_METHOD: AgentTerminalAuthMethod = {
  type: "terminal",
  id: "claude-login",
  name: "Claude login",
  args: ["auth", "login"],
};

export function claudeTerminalAuthMethod(env?: Record<string, string>): AgentTerminalAuthMethod {
  return env ? { ...CLAUDE_TERMINAL_AUTH_METHOD, env } : CLAUDE_TERMINAL_AUTH_METHOD;
}

/** Provider label carried by Claude's own (SDK-reported) skill entries. */
export const CLAUDE_NATIVE_SKILL_PROVIDER = "Claude";

/**
 * Prompt-style invocation for a model-invoked skill. Per the Agent SDK docs a
 * skill is invoked by the model through the `Skill` tool, which streams events
 * normally; sending the bare `/name` slash text instead makes the CLI run an
 * opaque local command that emits nothing until it finishes.
 */
export function claudeSkillInvocation(name: string): string {
  return `Use the ${name} skill.`;
}

/**
 * `skillNames` are the entries the SDK reports under `skills` on the session's
 * `system` init message. Bundled skills appear in *both* that list and the
 * slash-command list, so a command whose name is a known skill is re-flavored
 * as a skill entry (model-invoked, streams) instead of a slash command
 * (opaque local command, no stream events).
 */
export function mapClaudeSlashCommands(
  commands: readonly SlashCommand[],
  skillNames?: ReadonlySet<string>,
): NonNullable<AgentCapability["slashCommands"]> {
  return commands.map((c) => {
    const base = {
      id: c.name,
      label: c.description?.trim() ? `${c.name} — ${c.description}` : c.name,
      ...(c.description?.trim() ? { description: c.description } : {}),
      ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
    };
    if (!skillNames?.has(c.name)) return base;
    return {
      ...base,
      section: "skills" as const,
      skillName: c.name,
      skillInvocation: claudeSkillInvocation(c.name),
      skillProvider: CLAUDE_NATIVE_SKILL_PROVIDER,
      // Provider-native skills carry no SKILL.md path; scope is only used for
      // display/precedence, and the SDK reports one flat catalog.
      skillScope: "global" as const,
    };
  });
}

/**
 * Skill names for the session, read through the SDK's skill-list control
 * request. Used by the probes, which never consume the message stream and so
 * cannot read `skills` off the `system` init message. Returns `undefined` when
 * the CLI does not support the request.
 */
export async function readClaudeSkillNames(runtime: {
  reloadSkills: () => Promise<{ skills: readonly { name: string }[] }>;
}): Promise<Set<string> | undefined> {
  try {
    const { skills } = await runtime.reloadSkills();
    return new Set(skills.map((skill) => skill.name));
  } catch {
    return undefined;
  }
}

function probeDir(): string {
  return typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
}

function getSdkWorkerPath(): string {
  const adjacent = join(probeDir(), "claudeSdkProbeWorker.mjs");
  return existsSync(adjacent)
    ? adjacent
    : join(process.cwd(), "dist", "main", "claudeSdkProbeWorker.mjs");
}

/**
 * Windows `C:\...` or `\\wsl$\...` → `/mnt/c/...` style path for in-distro `node`.
 */
export function win32PathToWslMount(winPath: string): string {
  const norm = winPath.replace(/\\/g, "/");
  const unc = /^\/\/wsl(?:\.localhost|\$)\/[^/]+\/(.*)$/i.exec(norm);
  if (unc) return `/${unc[1]!.replace(/\\/g, "/")}`.replace(/^\/+/, "/");
  const drive = /^([a-zA-Z]):\/(.*)$/i.exec(norm);
  if (drive) return `/mnt/${drive[1]!.toLowerCase()}/${drive[2]}`;
  return norm;
}

async function probeClaudeSdkPartialNative(
  executablePath: string,
  timeoutMs: number,
  envOverrides?: Record<string, string>,
  signal?: AbortSignal,
): Promise<Partial<AgentCapability> | undefined> {
  if (signal?.aborted) return undefined;
  try {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const abort = new AbortController();
    const abortFromParent = () => abort.abort();
    signal?.addEventListener("abort", abortFromParent, { once: true });
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    const queue = new AsyncPromptQueue();
    try {
      const q = query({
        prompt: queue,
        options: {
          abortController: abort,
          pathToClaudeCodeExecutable: executablePath,
          persistSession: false,
          cwd: process.platform === "win32" ? (process.env.USERPROFILE ?? process.cwd()) : "/tmp",
          env: sanitizePrivilegedChildEnvironment({ ...process.env, ...(envOverrides ?? {}) }),
          settingSources: [],
          strictMcpConfig: true,
          mcpServers: {},
          tools: [],
          allowedTools: [],
          stderr: () => {},
          spawnClaudeCodeProcess: spawnClaudeProbeProcess,
        },
      });
      const init = await q.initializationResult();
      const slashCommands = mapClaudeSlashCommands(init.commands, await readClaudeSkillNames(q));
      const modelCapabilities = claudeCapabilitiesFromSdkModels(init.models);
      const fastAvailable = await resolveFastAvailability(
        q,
        queue,
        init.account?.email,
        resolveFastModeCachePath(),
      );
      const fastDisabledReason =
        fastAvailable === false ? CLAUDE_FAST_MODE_DISABLED_MESSAGE : undefined;
      try {
        queue.close();
        q.close();
      } catch {
        // ignore
      }
      abort.abort();
      if (slashCommands.length === 0 && !fastDisabledReason && !modelCapabilities) return undefined;
      return {
        ...(modelCapabilities ?? {}),
        ...(slashCommands.length > 0 ? { slashCommands } : {}),
        ...(fastDisabledReason ? { fastDisabledReason } : {}),
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromParent);
      abort.abort();
    }
  } catch (error) {
    console.log(
      "[claude-probe] native sdk:",
      error instanceof Error ? error.message : String(error),
    );
    return undefined;
  }
}

async function probeClaudeSdkPartialWsl(
  ctx: DetectProbeCtx,
  timeoutMs: number,
  envOverrides?: Record<string, string>,
): Promise<Partial<AgentCapability> | undefined> {
  if (ctx.location.kind !== "wsl" || !ctx.executablePath) return undefined;

  const workerHostPath = getSdkWorkerPath();
  let workerContent: Buffer;
  try {
    // Electron validates this read against ASAR integrity. Only the resulting
    // non-secret bytes cross into WSL; no mutable JavaScript is loaded into the
    // key-holding supervisor from app.asar.unpacked.
    workerContent = readFileSync(workerHostPath);
  } catch {
    return undefined;
  }
  const deployed = deployFilesToWslTempBase(
    ctx.location.distro,
    `y-space-claude-sdk-${process.pid}`,
    [{ content: workerContent, relDest: "claude-sdk/claude-sdk-probe-worker.mjs" }],
  );
  if (!deployed) return undefined;
  const workerWslPath = `${deployed.linuxBaseDir}/claude-sdk/claude-sdk-probe-worker.mjs`;
  // The worker runs in-distro, so hand it the fast-mode cache as a `/mnt/c/...`
  // mount; it reads/writes the same file the native path uses (keyed by account
  // hash), so the billed turn runs at most once per account.
  const cacheHostPath = resolveFastModeCachePath();
  const cacheWslPath =
    process.platform === "win32" ? win32PathToWslMount(cacheHostPath) : cacheHostPath;

  try {
    const result = await readWslLoginShellCommandOutputAsync(
      ctx.location.distro,
      "/tmp",
      "node",
      buildVerifiedWslEsmArgv(workerWslPath, workerContent, [
        ctx.executablePath,
        String(timeoutMs),
        cacheWslPath,
      ]),
      {
        timeout: timeoutMs + 3000,
        ...(envOverrides ? { env: envOverrides } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      },
    );

    if (!result.ok) {
      console.log(
        "[claude-probe] wsl worker:",
        (result.stderr || result.stdout || "(empty)").slice(0, 500),
      );
      return undefined;
    }

    try {
      const parsed = JSON.parse(result.stdout) as {
        slashCommands?: AgentCapability["slashCommands"];
        modelEfforts?: AgentCapability["modelEfforts"];
        fastModels?: AgentCapability["fastModels"];
        fastAvailable?: boolean;
        error?: string;
      };
      if (parsed.error) {
        console.log("[claude-probe] wsl worker error field:", parsed.error);
        return undefined;
      }
      const fastDisabledReason =
        parsed.fastAvailable === false ? CLAUDE_FAST_MODE_DISABLED_MESSAGE : undefined;
      const hasModelCapabilities =
        parsed.modelEfforts !== undefined || parsed.fastModels !== undefined;
      if (!parsed.slashCommands?.length && !fastDisabledReason && !hasModelCapabilities) {
        return undefined;
      }
      return {
        ...(parsed.modelEfforts ? { modelEfforts: parsed.modelEfforts } : {}),
        ...(parsed.fastModels ? { fastModels: parsed.fastModels } : {}),
        ...(parsed.slashCommands?.length ? { slashCommands: parsed.slashCommands } : {}),
        ...(fastDisabledReason ? { fastDisabledReason } : {}),
      };
    } catch {
      console.log("[claude-probe] wsl worker: invalid json stdout");
      return undefined;
    }
  } finally {
    deployed.cleanup();
  }
}

export async function probeClaudeCapabilities(
  ctx: DetectProbeCtx,
  options?: { env?: Record<string, string>; authMethodEnv?: Record<string, string> },
): Promise<CapabilitiesProbeResult | undefined> {
  if (!ctx.executablePath) return undefined;

  // Both paths may run a one-off fast-mode availability turn on a cache miss, so
  // allow extra headroom over a plain init probe.
  const timeoutMs = process.platform === "win32" ? 25_000 : 20_000;
  const sdkPartial =
    ctx.location.kind === "wsl"
      ? await probeClaudeSdkPartialWsl(ctx, timeoutMs, options?.env)
      : await probeClaudeSdkPartialNative(ctx.executablePath, timeoutMs, options?.env, ctx.signal);

  const versionPartial = claudeCapabilitiesFromCliVersion(ctx.version);

  // Always advertise the terminal login + `claude auth logout` capabilities
  // when the binary is installed — the Settings UI gates the Login/Logout
  // controls on these fields, and the supervisor's logout dispatcher uses
  // the adapter's `buildAcpLogoutCommand` to invoke `claude auth logout`.
  return {
    ...(sdkPartial ?? {}),
    ...(versionPartial ?? {}),
    // Probe isolation must never leak into the intentional `auth login` lane.
    // Profile adapters pass their original launch env separately.
    authMethods: [claudeTerminalAuthMethod(options?.authMethodEnv)],
    authLogoutSupported: true,
  };
}
