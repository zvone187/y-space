import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILT_IN_MCP_SERVER_NAMES, type ResolvedMcpServer } from "@/shared/contracts";
import { toWslUncPath } from "@/shared/wsl";
import { buildGeminiMcpServers } from "../../userMcp";
import { getWslCommand, type AgentEnvContext } from "../../base";
import {
  FORWARD_RUNTIME_FILE,
  buildNativeHookCommandHeads,
  buildWslHookCommandHead,
  copyForwardRuntimeFile,
  copyPluginAssetsIfStale,
  createPluginSourceResolver,
  ctxCacheKey,
  getNativeHookWrapperFilename,
  getNativePluginBaseDir,
  getWslPluginBaseDirs,
  hasNativeHookWrapper,
  isWslPluginContext,
  memoByCtx,
  readBundledPluginVersion,
  readPluginManifest,
  removeStagedPluginDir,
  stagePluginAssetsToWsl,
  writeNativeHookWrapper,
  type PluginManifest,
} from "../../plugin/installerBase";

export interface GeminiPluginPaths {
  pluginDir: string;
  settingsPath: string;
  version: string;
}

interface GeminiHookEntry {
  matcher?: string;
  hooks: Array<{
    name: string;
    type: "command";
    command: string;
    timeout: number;
  }>;
}

interface GeminiSettings {
  hooksConfig: {
    notifications: false;
  };
  hooks: Record<string, GeminiHookEntry[]>;
  mcpServers?: Record<
    string,
    {
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      httpUrl?: string;
      url?: string;
      cwd?: string;
      headers?: Record<string, string>;
      timeout?: number;
    }
  >;
}

type GeminiSettingsDocument = Partial<GeminiSettings> & Record<string, unknown>;

/**
 * Minimal hook surface for Gemini status tracking. Every entry produces a
 * distinct state edge in the supervisor:
 *   - SessionStart   → `session.started`         (bookkeeping / install proof-of-life)
 *   - BeforeAgent    → `session.turn_started`    (turn-open edge)
 *   - AfterAgent     → `session.turn_finished`   (turn-close edge)
 *   - Notification   → `session.needs_approval`  (approval prompts only)
 *
 * `BeforeModel` / `BeforeTool` / `AfterTool` were intentionally dropped:
 * they all converged on `session.turn_started`, fired up to 2N+ times per
 * turn (matcher: "*"), and the supervisor already deduplicates identical
 * state transitions in `ThreadOutputPipeline.updateState`. Tool-level
 * granularity is recoverable from Gemini's OSC title status, and per-tool
 * extras were only consumed by `hookDebug` for diagnostics.
 */
const GEMINI_HOOK_SPECS: ReadonlyArray<{ event: string; matcher?: string }> = [
  { event: "SessionStart" },
  { event: "BeforeAgent" },
  { event: "AfterAgent" },
  { event: "Notification" },
];

const callerDir =
  typeof __dirname !== "undefined"
    ? __dirname
    : dirname(fileURLToPath(import.meta.url ?? "file://"));

const resolveSourceDir = createPluginSourceResolver({
  kind: "gemini",
  sourceEnvVar: "PORACODE_GEMINI_PLUGIN_SOURCE",
  callerDir,
});

export function readBundledGeminiPluginVersion(): string {
  return readBundledPluginVersion(resolveSourceDir);
}

function computeGeminiPluginPaths(ctx?: AgentEnvContext): GeminiPluginPaths {
  if (isWslPluginContext(ctx)) {
    const wsl = getWslPluginBaseDirs(ctx.wslDistro, "gemini");
    if (!wsl) return { pluginDir: "", settingsPath: "", version: "0.0.0" };
    let version = "0.0.0";
    try {
      version = readPluginManifest(wsl.uncBase).version;
    } catch {
      // staged manifest missing or distro unreachable
    }
    return {
      pluginDir: wsl.linuxBase,
      settingsPath: `${wsl.linuxBase}/settings.json`,
      version,
    };
  }
  const pluginDir = getNativePluginBaseDir("gemini", ctx?.baseDir);
  let version = "0.0.0";
  try {
    version = readPluginManifest(pluginDir).version;
  } catch {
    // staged manifest missing; caller should install first
  }
  return {
    pluginDir,
    settingsPath: join(pluginDir, "settings.json"),
    version,
  };
}

const geminiPluginPathsMemo = memoByCtx(computeGeminiPluginPaths, ctxCacheKey);

export function getGeminiPluginPaths(ctx?: AgentEnvContext): GeminiPluginPaths {
  return geminiPluginPathsMemo.call(ctx);
}

function resolveSettingsWritePath(ctx: AgentEnvContext | undefined, settingsPath: string): string {
  return isWslPluginContext(ctx) ? toWslUncPath(ctx.wslDistro, settingsPath) : settingsPath;
}

const LEGACY_MANAGED_MCP_NAMES = new Set(
  Object.values(BUILT_IN_MCP_SERVER_NAMES).map((name) => name.toLowerCase()),
);
const LEGACY_PIPEDREAM_MCP_NAME_RE = /^pipedream(?:[-_.:]|$)/u;
const LEGACY_APP_ROUTING_SECRET_HEADERS = new Set(["x-poracode-token", "x-y-space-mcp-context"]);
const trackedGeminiLaunchCleanups = new Set<() => boolean>();
let geminiExitCleanupRegistered = false;

/**
 * Build one Gemini system-settings snapshot without ever projecting a launch
 * bearer through the shared plugin settings file. Each caller gets a private
 * directory so concurrent task launches cannot overwrite or clean up a
 * sibling's MCP authorization.
 */
export function createGeminiLaunchSettingsFile(
  ctx: AgentEnvContext | undefined,
  servers: readonly ResolvedMcpServer[],
): { settingsPath: string; cleanup: () => void } | undefined {
  const paths = getGeminiPluginPaths(ctx);
  if (!paths.settingsPath) {
    if (servers.length > 0) {
      throw new Error("Failed to resolve a private Gemini MCP launch settings path.");
    }
    return undefined;
  }
  const sharedWritePath = resolveSettingsWritePath(ctx, paths.settingsPath);
  const sharedSettings = readAndScrubSharedGeminiSettings(sharedWritePath);
  if (!sharedSettings && servers.length === 0) return undefined;

  const launchMcpServers = buildGeminiMcpServers(servers);
  const settings: GeminiSettingsDocument = { ...(sharedSettings ?? {}) };
  const inheritedMcpServers = isRecord(settings.mcpServers) ? settings.mcpServers : {};
  const mergedMcpServers = { ...inheritedMcpServers, ...launchMcpServers };
  if (Object.keys(mergedMcpServers).length > 0) settings.mcpServers = mergedMcpServers;
  else delete settings.mcpServers;

  const launchDirName = `.poracode-launch-${randomUUID()}`;
  const launchDir = isWslPluginContext(ctx)
    ? `${paths.pluginDir.replace(/\/$/u, "")}/${launchDirName}`
    : join(paths.pluginDir, launchDirName);
  const settingsPath = isWslPluginContext(ctx)
    ? `${launchDir}/settings.json`
    : join(launchDir, "settings.json");
  const writeDir = resolveSettingsWritePath(ctx, launchDir);
  const writePath = resolveSettingsWritePath(ctx, settingsPath);
  try {
    const serialized = `${JSON.stringify(settings, null, 2)}\n`;
    if (isWslPluginContext(ctx)) {
      writePrivateGeminiLaunchSettingsInWsl(ctx.wslDistro, launchDir, settingsPath, serialized);
    } else {
      mkdirSync(dirname(writeDir), { recursive: true });
      mkdirSync(writeDir, { mode: 0o700 });
      chmodSync(writeDir, 0o700);
      writeFileSync(writePath, serialized, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      chmodSync(writePath, 0o600);
    }
  } catch (error) {
    try {
      if (isWslPluginContext(ctx)) removePrivateGeminiLaunchDirInWsl(ctx.wslDistro, launchDir);
      else rmSync(writeDir, { recursive: true, force: true });
    } catch {
      // Best-effort rollback must not hide the private-settings failure.
    }
    if (servers.length > 0) {
      throw new Error("Failed to create private Gemini MCP launch settings.", { cause: error });
    }
    return undefined;
  }
  const cleanup = trackGeminiLaunchCleanup(() => {
    if (isWslPluginContext(ctx)) removePrivateGeminiLaunchDirInWsl(ctx.wslDistro, launchDir);
    else rmSync(writeDir, { recursive: true, force: true });
  });
  return { settingsPath, cleanup };
}

export function trackGeminiLaunchCleanup(cleanup: () => void): () => void {
  let active = true;
  const attempt = (): boolean => {
    if (!active) return true;
    try {
      cleanup();
    } catch {
      return false;
    }
    active = false;
    trackedGeminiLaunchCleanups.delete(attempt);
    return true;
  };
  trackedGeminiLaunchCleanups.add(attempt);
  if (!geminiExitCleanupRegistered) {
    geminiExitCleanupRegistered = true;
    process.once("exit", cleanupTrackedGeminiLaunchSettingsForExit);
  }
  return () => {
    void attempt();
  };
}

export function cleanupTrackedGeminiLaunchSettingsForExit(): void {
  for (const attempt of [...trackedGeminiLaunchCleanups]) {
    void attempt();
  }
}

export function buildGeminiWslPrivateSettingsWriteSpec(
  distro: string,
  launchDir: string,
  settingsPath: string,
): { command: string; args: string[] } {
  const script = [
    "set -eu",
    "umask 077",
    'mkdir -p -- "$(dirname -- "$1")"',
    'mkdir -- "$1"',
    'chmod 700 -- "$1"',
    'cat > "$2"',
    'chmod 600 -- "$2"',
    '[ "$(stat -c %a -- "$1")" = 700 ]',
    '[ "$(stat -c %a -- "$2")" = 600 ]',
  ].join("; ");
  return {
    command: getWslCommand(),
    args: ["-d", distro, "--exec", "sh", "-c", script, "sh", launchDir, settingsPath],
  };
}

function writePrivateGeminiLaunchSettingsInWsl(
  distro: string,
  launchDir: string,
  settingsPath: string,
  serialized: string,
): void {
  const spec = buildGeminiWslPrivateSettingsWriteSpec(distro, launchDir, settingsPath);
  const result = spawnSync(spec.command, spec.args, {
    input: serialized,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error("Failed to write private Gemini MCP launch settings inside WSL.", {
      cause: result.error,
    });
  }
}

function removePrivateGeminiLaunchDirInWsl(distro: string, launchDir: string): void {
  if (!/\/\.poracode-launch-[0-9a-f-]+$/u.test(launchDir)) {
    throw new Error("Refusing to remove an invalid Gemini launch settings directory.");
  }
  const result = spawnSync(
    getWslCommand(),
    ["-d", distro, "--exec", "sh", "-c", 'set -eu; rm -rf -- "$1"', "sh", launchDir],
    { encoding: "utf8", shell: false, windowsHide: true, timeout: 10_000 },
  );
  if (result.error || result.status !== 0) {
    throw new Error("Failed to remove private Gemini MCP launch settings inside WSL.", {
      cause: result.error,
    });
  }
}

function readAndScrubSharedGeminiSettings(
  settingsPath: string,
): GeminiSettingsDocument | undefined {
  if (!existsSync(settingsPath)) return undefined;
  let settings: GeminiSettingsDocument;
  let mustRewrite = false;
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as unknown;
    if (isRecord(parsed)) settings = parsed as unknown as GeminiSettingsDocument;
    else {
      settings = {};
      mustRewrite = true;
    }
  } catch {
    // Invalid settings cannot safely be copied into a secret-bearing launch
    // snapshot. Replace the unusable shared payload rather than leave a
    // possible legacy bearer at rest.
    settings = {};
    mustRewrite = true;
  }
  mustRewrite = scrubLegacyGeminiLaunchSecrets(settings) || mustRewrite;
  if (mustRewrite) writePrivateGeminiSettings(settingsPath, settings);
  return settings;
}

function scrubLegacyGeminiLaunchSecrets(settings: GeminiSettingsDocument): boolean {
  if (settings.mcpServers === undefined) return false;
  if (!isRecord(settings.mcpServers)) {
    delete settings.mcpServers;
    return true;
  }
  let changed = false;
  for (const [name, value] of Object.entries(settings.mcpServers)) {
    const normalizedName = name.trim().toLowerCase();
    if (
      LEGACY_MANAGED_MCP_NAMES.has(normalizedName) ||
      LEGACY_PIPEDREAM_MCP_NAME_RE.test(normalizedName)
    ) {
      delete settings.mcpServers[name];
      changed = true;
      continue;
    }
    if (!isRecord(value)) continue;
    const isLoopback = isLoopbackGeminiMcpServer(value);
    if (value.headers === undefined) continue;
    if (!isRecord(value.headers)) {
      if (isLoopback) {
        delete value.headers;
        changed = true;
      }
      continue;
    }
    for (const [headerName, headerValue] of Object.entries(value.headers)) {
      const normalizedHeaderName = headerName.trim().toLowerCase();
      const bearerAuthorization =
        isLoopback &&
        normalizedHeaderName === "authorization" &&
        typeof headerValue === "string" &&
        /^\s*bearer(?:\s|$)/iu.test(headerValue);
      if (bearerAuthorization || LEGACY_APP_ROUTING_SECRET_HEADERS.has(normalizedHeaderName)) {
        delete value.headers[headerName];
        changed = true;
      }
    }
    if (Object.keys(value.headers).length === 0) delete value.headers;
  }
  if (Object.keys(settings.mcpServers).length === 0) delete settings.mcpServers;
  return changed;
}

function isLoopbackGeminiMcpServer(value: Record<string, unknown>): boolean {
  const rawUrl =
    typeof value.httpUrl === "string"
      ? value.httpUrl
      : typeof value.url === "string"
        ? value.url
        : undefined;
  if (!rawUrl) return false;
  try {
    const hostname = new URL(rawUrl).hostname
      .toLowerCase()
      .replace(/^\[|\]$/gu, "")
      .replace(/\.$/u, "");
    if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
    if (hostname === "::" || hostname === "::1" || hostname === "0:0:0:0:0:0:0:1") return true;
    const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u);
    return ipv4 !== null && (Number(ipv4[1]) === 127 || hostname === "0.0.0.0");
  } catch {
    return false;
  }
}

function writePrivateGeminiSettings(settingsPath: string, settings: unknown): void {
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(settingsPath, 0o600);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface InstallGeminiPluginOptions {
  /**
   * Absolute path to the Node binary the staged hook command should use.
   *
   * - **WSL contexts:** required. Comes from `resolveNodeForDistro`.
   * - **Native contexts:** optional. When provided (preferred), the wrapper
   *   exec's the bare Node binary directly; otherwise it falls back to
   *   `ELECTRON_RUN_AS_NODE=1` against the bundled Electron binary.
   */
  resolvedNodePath?: string | undefined;
}

export function installGeminiPlugin(
  ctx?: AgentEnvContext,
  options?: InstallGeminiPluginOptions,
): { ok: true; paths: GeminiPluginPaths; version: string } | { ok: false; reason: string } {
  let sourceDir: string;
  try {
    sourceDir = resolveSourceDir();
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  let manifest: PluginManifest;
  try {
    manifest = readPluginManifest(sourceDir);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  if (isWslPluginContext(ctx)) {
    if (!options?.resolvedNodePath) {
      return {
        ok: false,
        reason:
          "WSL Gemini plugin install requires a resolved node path; the adapter must call resolveNodeForDistro before installing.",
      };
    }
    return installGeminiPluginWsl(ctx.wslDistro, sourceDir, manifest, options.resolvedNodePath);
  }

  const pluginDir = getNativePluginBaseDir("gemini", ctx?.baseDir);
  const settingsPath = join(pluginDir, "settings.json");
  mkdirSync(pluginDir, { recursive: true });
  copyPluginAssetsIfStale(sourceDir, pluginDir);
  copyForwardRuntimeFile(pluginDir);
  const wrapperPath = writeNativeHookWrapper(pluginDir, {
    ...(options?.resolvedNodePath ? { nodePath: options.resolvedNodePath } : {}),
  });

  const nativeCommands = buildNativeHookCommandHeads(wrapperPath);
  const settings = {
    ...(readAndScrubSharedGeminiSettings(settingsPath) ?? {}),
    ...renderGeminiSettings({ headExpression: nativeCommands.command }),
  };
  writePrivateGeminiSettings(settingsPath, settings);

  console.log(
    `[supervisor] Gemini hook plugin staged v${manifest.version} at ${pluginDir} (forward.mjs, ${getNativeHookWrapperFilename()}, settings.json)`,
  );

  return {
    ok: true,
    version: manifest.version,
    paths: { pluginDir, settingsPath, version: manifest.version },
  };
}

function installGeminiPluginWsl(
  distro: string,
  sourceDir: string,
  manifest: PluginManifest,
  resolvedNodePath: string,
): { ok: true; paths: GeminiPluginPaths; version: string } | { ok: false; reason: string } {
  const staged = stagePluginAssetsToWsl(distro, sourceDir, "gemini", {
    includeForwardRuntime: true,
  });
  if (!staged.ok) return staged;

  const linuxPluginDir = staged.linuxPluginDir;
  const linuxSettingsPath = `${linuxPluginDir}/settings.json`;
  const linuxForwardPath = `${linuxPluginDir}/forward.mjs`;
  const uncSettingsPath = toWslUncPath(distro, linuxSettingsPath);
  const headExpression = buildWslHookCommandHead(resolvedNodePath, linuxForwardPath);

  try {
    mkdirSync(dirname(uncSettingsPath), { recursive: true });
    const settings = {
      ...(readAndScrubSharedGeminiSettings(uncSettingsPath) ?? {}),
      ...renderGeminiSettings({ headExpression }),
    };
    writePrivateGeminiSettings(uncSettingsPath, settings);
  } catch (error) {
    return {
      ok: false,
      reason: `failed to write Gemini settings.json in wsl distro ${distro}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  console.log(
    `[supervisor] Gemini hook plugin staged v${manifest.version} in WSL distro ${distro} at ${linuxPluginDir} (forward.mjs, settings.json)`,
  );

  return {
    ok: true,
    version: manifest.version,
    paths: {
      pluginDir: linuxPluginDir,
      settingsPath: linuxSettingsPath,
      version: manifest.version,
    },
  };
}

export function isGeminiPluginInstalled(ctx?: AgentEnvContext): {
  installed: boolean;
  version?: string;
} {
  if (isWslPluginContext(ctx)) {
    const wsl = getWslPluginBaseDirs(ctx.wslDistro, "gemini");
    if (!wsl) return { installed: false };
    return verifyGeminiInstallAt(wsl.uncBase, "wsl");
  }
  return verifyGeminiInstallAt(getNativePluginBaseDir("gemini", ctx?.baseDir), "native");
}

export function uninstallGeminiPlugin(ctx?: AgentEnvContext): void {
  removeStagedPluginDir("gemini", ctx);
}

function verifyGeminiInstallAt(
  readableDir: string,
  target: "native" | "wsl",
): { installed: boolean; version?: string } {
  if (!existsSync(join(readableDir, "plugin.json"))) return { installed: false };
  if (!existsSync(join(readableDir, "forward.mjs"))) return { installed: false };
  if (!existsSync(join(readableDir, FORWARD_RUNTIME_FILE))) return { installed: false };
  if (!existsSync(join(readableDir, "settings.json"))) return { installed: false };
  if (!hasNativeHookWrapper(readableDir, target)) return { installed: false };
  try {
    const settings = JSON.parse(readFileSync(join(readableDir, "settings.json"), "utf8")) as {
      hooks?: Record<string, unknown>;
    };
    if (!hasGeminiHooks(settings.hooks)) return { installed: false };
    const version = readPluginManifest(readableDir).version;
    return { installed: true, version };
  } catch {
    return { installed: false };
  }
}

/**
 * Match either the WSL command shape (`forward.mjs` invoked via absolute
 * node path) or the native shape (`poracode-hook.{sh,cmd,ps1}` wrapper).
 */
const PORACODE_GEMINI_HOOK_RE =
  /agent-plugins(?:[/\\]+)gemini(?:[/\\]+)(?:forward\.mjs|poracode-hook\.(?:sh|cmd|ps1))/;

function hasGeminiHooks(hooks: Record<string, unknown> | undefined): boolean {
  if (!hooks) return false;
  for (const spec of GEMINI_HOOK_SPECS) {
    const groups = hooks[spec.event];
    if (!Array.isArray(groups) || groups.length === 0) return false;
    const found = groups.some((group) => {
      if (!group || typeof group !== "object") return false;
      const hookEntries = (group as { hooks?: unknown }).hooks;
      if (!Array.isArray(hookEntries)) return false;
      return hookEntries.some((hook) => {
        if (!hook || typeof hook !== "object") return false;
        const command = (hook as { command?: unknown }).command;
        return typeof command === "string" && PORACODE_GEMINI_HOOK_RE.test(command);
      });
    });
    if (!found) return false;
  }
  return true;
}

export interface RenderGeminiSettingsOptions {
  headExpression: string;
  mcpServers?: GeminiSettings["mcpServers"];
}

export function renderGeminiSettings(opts: RenderGeminiSettingsOptions): GeminiSettings {
  const hooks: Record<string, GeminiHookEntry[]> = {};
  for (const spec of GEMINI_HOOK_SPECS) {
    const entry: GeminiHookEntry = {
      hooks: [
        {
          name: `poracode-status-${spec.event}`,
          type: "command",
          command: `${opts.headExpression} ${spec.event}`,
          timeout: 5000,
        },
      ],
    };
    if (spec.matcher !== undefined) entry.matcher = spec.matcher;
    hooks[spec.event] = [entry];
  }
  const settings: GeminiSettings = { hooksConfig: { notifications: false }, hooks };
  if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0) {
    settings.mcpServers = opts.mcpServers;
  }
  return settings;
}
