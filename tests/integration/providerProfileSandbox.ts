import { createHash } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { AgentAdapter } from "@/supervisor/agents/base";
import { resolveExecutablePathAsync } from "@/supervisor/agents/base/processRuntime";

const PROFILE_ENV_KEYS = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME"] as const;
type ProfileEnvKey = (typeof PROFILE_ENV_KEYS)[number];
type SavedProfileEnv = Record<ProfileEnvKey, string | undefined>;
export type LiveProviderProfileEnvironment = Readonly<{
  HOME: string;
  USERPROFILE: string;
  CLAUDE_CONFIG_DIR: string;
  CODEX_HOME: string;
}>;

interface FileFingerprint {
  exists: boolean;
  linkDevice?: number;
  linkInode?: number;
  targetDevice?: number;
  targetInode?: number;
  byteLength?: number;
  sha256?: string;
}

export interface LiveProviderProfileSandboxOptions {
  /** Override only for hermetic helper tests. Production integration tests use the real home. */
  sourceHome?: string;
  /** Effective Claude config root whose auth is copied and settings are guarded. */
  sourceClaudeConfigDir?: string;
  /** Effective Claude state file to sanitize. Defaults to the normal CLI resolution rule. */
  sourceClaudeStatePath?: string;
  /** Effective Codex profile root whose auth is copied and config is guarded. */
  sourceCodexHome?: string;
  /** Project roots the isolated Claude CLI may trust without copying project settings. */
  trustedClaudeProjectPaths?: readonly string[];
  /** Parent for the temporary sandbox. */
  tempParent?: string;
}

export interface LiveProviderProfileSandbox {
  readonly paths: {
    root: string;
    home: string;
    claudeConfigDir: string;
    codexHome: string;
  };
  readonly environment: LiveProviderProfileEnvironment;
  activate(): void;
  deactivate(): void;
  withIsolatedProfiles<T>(operation: () => Promise<T> | T): Promise<T>;
  assertSourceProfilesUnchanged(): void;
  dispose(): void;
}

/**
 * Force both terminal launch lanes onto the disposable profile and omit the
 * CLI hook slice. This avoids hook installers that mirror a mutable native
 * profile into an app-owned home, which would defeat integration isolation.
 */
function isolateTerminalAdapterProfile(
  adapter: AgentAdapter,
  environment: Readonly<Record<string, string>>,
): AgentAdapter {
  const { installPlugin, isPluginInstalled, pluginId, pluginVersion, ...withoutHookPlugin } =
    adapter;
  void installPlugin;
  void isPluginInstalled;
  void pluginId;
  void pluginVersion;
  return {
    ...withoutHookPlugin,
    buildLaunchArgv(...args) {
      const argv = adapter.buildLaunchArgv(...args);
      return { ...argv, env: { ...(argv.env ?? {}), ...environment } };
    },
    buildResumeArgv(...args) {
      const argv = adapter.buildResumeArgv(...args);
      return { ...argv, env: { ...(argv.env ?? {}), ...environment } };
    },
  };
}

/**
 * Codex detection normally starts app-server/capability probes, which may use
 * a shell-primed HOME captured before the test sandbox was activated. For this
 * live lifecycle test, resolve only the binary and the copied auth snapshot;
 * the actual launch remains the authentication/readiness proof under test.
 */
export function isolateCodexAdapterProfile(
  adapter: AgentAdapter,
  environment: LiveProviderProfileEnvironment,
  resolveExecutable: () => Promise<string | undefined> = () => resolveExecutablePathAsync("codex"),
): AgentAdapter {
  const isolated = isolateTerminalAdapterProfile(adapter, environment);
  return {
    ...isolated,
    async detectInstall(ctx) {
      ctx?.signal?.throwIfAborted();
      const executablePath = await resolveExecutable();
      ctx?.signal?.throwIfAborted();
      return {
        kind: isolated.kind,
        label: isolated.label,
        installed: executablePath !== undefined,
        ...(executablePath ? { executablePath } : {}),
        authState: executablePath
          ? existsSync(join(environment.CODEX_HOME, "auth.json"))
            ? "authenticated"
            : "unknown"
          : "missing",
        capabilities: isolated.capabilities,
      };
    },
  };
}

export function isolatedLiveProviderRuntimeSettings(disableCliHookPlugin: boolean): {
  disableCliHookPlugin: boolean;
  disabledBuiltInMcpServers: { browser: true };
} {
  return {
    disableCliHookPlugin,
    // `browserMcp: false` is intentionally not enough: production defaults the
    // canonical Browser back on. This global hard-disable lets the lifecycle
    // test omit the managed hook plugin without triggering Browser fail-closed.
    disabledBuiltInMcpServers: { browser: true },
  };
}

function captureProfileEnv(): SavedProfileEnv {
  return Object.fromEntries(
    PROFILE_ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as SavedProfileEnv;
}

function restoreProfileEnv(saved: SavedProfileEnv): void {
  for (const key of PROFILE_ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function expandProfilePath(value: string | undefined, sourceHome: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed === "~") return sourceHome;
  if (trimmed.startsWith("~/")) return resolve(sourceHome, trimmed.slice(2));
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(sourceHome, trimmed);
}

function fingerprint(path: string): FileFingerprint {
  let linkStat;
  try {
    linkStat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
    throw error;
  }
  const targetStat = statSync(path);
  const contents = readFileSync(path);
  return {
    exists: true,
    linkDevice: linkStat.dev,
    linkInode: linkStat.ino,
    targetDevice: targetStat.dev,
    targetInode: targetStat.ino,
    byteLength: contents.byteLength,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

function sameFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
  return (
    left.exists === right.exists &&
    left.linkDevice === right.linkDevice &&
    left.linkInode === right.linkInode &&
    left.targetDevice === right.targetDevice &&
    left.targetInode === right.targetInode &&
    left.byteLength === right.byteLength &&
    left.sha256 === right.sha256
  );
}

function copyIndependentFile(source: string, target: string): void {
  let sourceStat;
  try {
    sourceStat = statSync(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!sourceStat.isFile()) {
    throw new Error(`live integration profile input is not a regular file: ${source}`);
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  copyFileSync(source, target, constants.COPYFILE_EXCL);
  chmodSync(target, 0o600);
  const copied = lstatSync(target);
  const copiedTarget = statSync(target);
  if (
    copied.isSymbolicLink() ||
    !copied.isFile() ||
    (sourceStat.ino !== 0 &&
      copiedTarget.ino !== 0 &&
      sourceStat.dev === copiedTarget.dev &&
      sourceStat.ino === copiedTarget.ino)
  ) {
    throw new Error(`live integration profile snapshot is not independent: ${target}`);
  }
}

function writeIndependentFile(target: string, contents: string): void {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
  chmodSync(target, 0o600);
  const written = lstatSync(target);
  if (written.isSymbolicLink() || !written.isFile()) {
    throw new Error(`live integration profile snapshot is not a regular file: ${target}`);
  }
}

function readJsonObjectOptional(path: string): Record<string, unknown> | undefined {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed: unknown = JSON.parse(contents);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`live integration profile input is not a JSON object: ${path}`);
  }
  return parsed as Record<string, unknown>;
}

function sanitizedClaudeState(
  sourcePath: string,
  trustedProjectPaths: readonly string[],
): Record<string, unknown> {
  const source = readJsonObjectOptional(sourcePath);
  const snapshot: Record<string, unknown> = { hasCompletedOnboarding: true };
  if (typeof source?.lastOnboardingVersion === "string") {
    snapshot.lastOnboardingVersion = source.lastOnboardingVersion;
  }
  if (typeof source?.userID === "string") snapshot.userID = source.userID;
  if (source?.oauthAccount && typeof source.oauthAccount === "object") {
    snapshot.oauthAccount = source.oauthAccount;
  }
  if (trustedProjectPaths.length > 0) {
    snapshot.projects = Object.fromEntries(
      trustedProjectPaths.map((projectPath) => [
        resolve(projectPath),
        { hasTrustDialogAccepted: true },
      ]),
    );
  }
  return snapshot;
}

export function createLiveProviderProfileSandbox(
  options: LiveProviderProfileSandboxOptions = {},
): LiveProviderProfileSandbox {
  const savedEnv = captureProfileEnv();
  const sourceHome = resolve(options.sourceHome ?? homedir());
  const configuredClaudeDir = expandProfilePath(savedEnv.CLAUDE_CONFIG_DIR, sourceHome);
  const sourceClaudeConfigDir = resolve(
    options.sourceClaudeConfigDir ?? configuredClaudeDir ?? join(sourceHome, ".claude"),
  );
  const sourceClaudeStatePath = resolve(
    options.sourceClaudeStatePath ??
      (configuredClaudeDir
        ? join(sourceClaudeConfigDir, ".claude.json")
        : join(sourceHome, ".claude.json")),
  );
  const sourceCodexHome = resolve(
    options.sourceCodexHome ??
      expandProfilePath(savedEnv.CODEX_HOME, sourceHome) ??
      join(sourceHome, ".codex"),
  );
  const trustedClaudeProjectPaths = options.trustedClaudeProjectPaths ?? [];

  const sourceFiles = {
    claudeState: sourceClaudeStatePath,
    claudeSettings: join(sourceClaudeConfigDir, "settings.json"),
    claudeCredentials: join(sourceClaudeConfigDir, ".credentials.json"),
    codexConfig: join(sourceCodexHome, "config.toml"),
    codexAuth: join(sourceCodexHome, "auth.json"),
  } as const;
  const protectedPaths = [
    // Always guard the canonical files named in the safety contract, even when
    // the current shell points a provider at a custom profile root.
    join(sourceHome, ".claude.json"),
    join(sourceHome, ".claude", "settings.json"),
    join(sourceHome, ".claude", ".credentials.json"),
    join(sourceHome, ".codex", "config.toml"),
    join(sourceHome, ".codex", "auth.json"),
    ...Object.values(sourceFiles),
  ].map((path) => resolve(path));
  const sourceFingerprints = new Map(
    [...new Set(protectedPaths)].map((path) => [path, fingerprint(path)] as const),
  );

  const tempParent = resolve(options.tempParent ?? tmpdir());
  mkdirSync(tempParent, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(tempParent, "y-space-live-profiles-"));
  chmodSync(root, 0o700);
  const home = join(root, "home");
  // Keep explicit provider overrides aligned with their normal paths under the
  // disposable HOME. Some session-discovery helpers still key off homedir(),
  // so using two different temp roots would hide sessions needed for resume.
  const claudeConfigDir = join(home, ".claude");
  const codexHome = join(home, ".codex");
  for (const dir of [home, claudeConfigDir, codexHome]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  try {
    // Copy only authentication files verbatim. Provider state/config can contain
    // executable hooks, MCP servers, plugins, notification commands, or custom
    // endpoints, so live integration gets minimal independent snapshots instead.
    writeIndependentFile(
      join(claudeConfigDir, ".claude.json"),
      `${JSON.stringify(
        sanitizedClaudeState(sourceFiles.claudeState, trustedClaudeProjectPaths),
      )}\n`,
    );
    writeIndependentFile(join(claudeConfigDir, "settings.json"), "{}\n");
    copyIndependentFile(sourceFiles.claudeCredentials, join(claudeConfigDir, ".credentials.json"));
    writeIndependentFile(join(codexHome, "config.toml"), "");
    copyIndependentFile(sourceFiles.codexAuth, join(codexHome, "auth.json"));
    for (const [path, before] of sourceFingerprints) {
      if (!sameFingerprint(before, fingerprint(path))) {
        throw new Error(
          `provider profile changed while creating live integration sandbox: ${path}`,
        );
      }
    }
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }

  let active = false;
  let disposed = false;
  const paths = { root, home, claudeConfigDir, codexHome } as const;
  const environment = {
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    CODEX_HOME: codexHome,
  } as const;

  const assertSourceProfilesUnchanged = (): void => {
    for (const [path, before] of sourceFingerprints) {
      if (!sameFingerprint(before, fingerprint(path))) {
        throw new Error(`provider profile changed during live integration test: ${path}`);
      }
    }
  };

  const deactivate = (): void => {
    if (!active) return;
    active = false;
    restoreProfileEnv(savedEnv);
    assertSourceProfilesUnchanged();
  };

  return {
    paths,
    environment,
    activate() {
      if (disposed) throw new Error("live provider profile sandbox is disposed");
      if (active) throw new Error("live provider profile sandbox is already active");
      for (const [key, value] of Object.entries(environment)) process.env[key] = value;
      active = true;
    },
    deactivate,
    async withIsolatedProfiles<T>(operation: () => Promise<T> | T): Promise<T> {
      this.activate();
      try {
        return await operation();
      } finally {
        deactivate();
      }
    },
    assertSourceProfilesUnchanged,
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        if (active) {
          active = false;
          restoreProfileEnv(savedEnv);
        }
        assertSourceProfilesUnchanged();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}
