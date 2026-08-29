import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toWslUncPath } from "@/shared/wsl";
import type { AgentEnvContext } from "../../base";
import { buildAgentCommand, execInWsl, getPrimedPosixEnv, quotePosixShellArg } from "../../base";
import { resolveAgentBinaryPath } from "../../binaryResolver";
import {
  FORWARD_RUNTIME_FILE,
  buildNativeHookCommandHeads,
  copyForwardRuntimeFile,
  copyPluginAssetsIfStale,
  createPluginSourceResolver,
  ctxCacheKey,
  ensureNativeStateLink,
  getNativePluginBaseDir,
  getWslPluginBaseDirs,
  hasNativeHookWrapper,
  isWslPluginContext,
  memoByCtx,
  parseExistingHooksJson,
  readBundledPluginVersion,
  readPluginManifest,
  removeStagedPluginDir,
  stagePluginAssetsToWsl,
  writeHooksJsonFile,
  writeNativeHookWrapper,
  type PluginManifest,
} from "../../plugin/installerBase";
import { resolveCodexNativeExecutableForWindows } from "../windowsExecutable";

export interface CodexPluginPaths {
  pluginDir: string;
  /** Private CODEX_HOME used only for Codex processes spawned by Poracode. */
  codexHomeDir: string;
  /** Effective profile SQLite home shared with the user's regular Codex runtime. */
  sqliteHomeDir: string;
  /** Path to hooks.json inside the private CODEX_HOME. */
  codexHooksPath: string;
  version: string;
}

const CODEX_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "Stop",
] as const;

/**
 * Match any Poracode-staged Codex hook command in hooks.json. Covers both
 * the WSL shape (where `forward.mjs` is invoked directly via an absolute
 * node path) and the native shape (where `poracode-hook.{sh,cmd,ps1}` is the
 * entry point).
 */
const PORACODE_FORWARD_RE =
  /agent-plugins(?:[/\\]+)codex(?:[/\\]+)(?:forward\.mjs|poracode-hook\.(?:sh|cmd|ps1))/;
const MANAGED_FORWARD_RE =
  /agent-plugins(?:[/\\]+)codex(?:[/\\]+)(?:forward\.mjs|(?:poracode|lightcode)-hook\.(?:sh|cmd|ps1))/;

const callerDir =
  typeof __dirname !== "undefined"
    ? __dirname
    : dirname(fileURLToPath(import.meta.url ?? "file://"));

const resolveSourceDir = createPluginSourceResolver({
  kind: "codex",
  sourceEnvVar: "PORACODE_CODEX_PLUGIN_SOURCE",
  callerDir,
});

export function readBundledCodexPluginVersion(): string {
  return readBundledPluginVersion(resolveSourceDir);
}

function computeCodexPluginPaths(ctx?: AgentEnvContext): CodexPluginPaths {
  if (isWslPluginContext(ctx)) {
    const wsl = getWslPluginBaseDirs(ctx.wslDistro, "codex");
    if (!wsl) {
      return {
        pluginDir: "",
        codexHomeDir: "",
        sqliteHomeDir: "",
        codexHooksPath: "",
        version: "0.0.0",
      };
    }
    const linuxCodexHome = `${wsl.linuxBase}/home`;
    let version = "0.0.0";
    try {
      version = readPluginManifest(wsl.uncBase).version;
    } catch {
      // ignore
    }
    return {
      pluginDir: wsl.linuxBase,
      codexHomeDir: linuxCodexHome,
      sqliteHomeDir: `${wsl.home}/.codex`,
      codexHooksPath: `${linuxCodexHome}/hooks.json`,
      version,
    };
  }
  const pluginDir = getNativePluginBaseDir("codex", ctx?.baseDir);
  const codexHomeDir = join(pluginDir, "home");
  let version = "0.0.0";
  try {
    version = readPluginManifest(pluginDir).version;
  } catch {
    // ignore
  }
  return {
    pluginDir,
    codexHomeDir,
    sqliteHomeDir: resolveNativeCodexSqliteHome(),
    codexHooksPath: join(codexHomeDir, "hooks.json"),
    version,
  };
}

const codexPluginPathsMemo = memoByCtx(computeCodexPluginPaths, ctxCacheKey);

export function getCodexPluginPaths(ctx?: AgentEnvContext): CodexPluginPaths {
  return codexPluginPathsMemo.call(ctx);
}

function prunePoracodeGroups(groups: unknown): unknown[] {
  if (!Array.isArray(groups)) return [];
  return groups.filter((g) => {
    if (!g || typeof g !== "object") return true;
    const rec = g as { hooks?: unknown };
    const hooks = rec.hooks;
    if (!Array.isArray(hooks)) return true;
    return !hooks.some((h) => {
      if (!h || typeof h !== "object") return false;
      const cmd = (h as { type?: string; command?: string }).command;
      return typeof cmd === "string" && MANAGED_FORWARD_RE.test(cmd);
    });
  });
}

function commandForEvent(commandHead: string, event: string): string {
  return `${commandHead} ${event}`;
}

function buildPoracodeGroup(event: string, commandHead: string): Record<string, unknown> {
  const command = commandForEvent(commandHead, event);
  const hook = { type: "command", command };
  if (event === "SessionStart" || event === "PreToolUse" || event === "PostToolUse") {
    return { matcher: "*", hooks: [hook] };
  }
  return { hooks: [hook] };
}

/**
 * Merge Poracode Codex hook matcher groups into a parsed `hooks.json`
 * document. `commandHead` is the entire pre-event portion of each hook
 * command — for WSL it's `"<absolute-node-path>" "<forward.mjs-path>"`;
 * for native it's just `"<wrapper-path>"`. Exported for unit tests.
 */
export function mergeCodexHooksDocument(
  existingParsed: unknown,
  commandHead: string,
): { hooks: Record<string, unknown[]> } {
  let hooksRoot: Record<string, unknown> = {};
  if (
    existingParsed &&
    typeof existingParsed === "object" &&
    "hooks" in existingParsed &&
    (existingParsed as { hooks: unknown }).hooks &&
    typeof (existingParsed as { hooks: unknown }).hooks === "object"
  ) {
    hooksRoot = { ...(existingParsed as { hooks: Record<string, unknown> }).hooks };
  }

  for (const event of CODEX_HOOK_EVENTS) {
    const prev = hooksRoot[event];
    const pruned = prunePoracodeGroups(prev);
    pruned.push(buildPoracodeGroup(event, commandHead));
    hooksRoot[event] = pruned;
  }

  return { hooks: hooksRoot as Record<string, unknown[]> };
}

const CODEX_LINK_TARGETS = [
  { name: "sessions", kind: "dir" as const },
  { name: "session_index.jsonl", kind: "file" as const },
  { name: "auth.json", kind: "file" as const },
  // CODEX_HOME changes where Codex discovers these roots. Link the complete
  // global trees so unrelated user capabilities remain available; launch-time
  // policy disables only browser-classified skills/plugins.
  { name: "skills", kind: "dir" as const },
  { name: "plugins", kind: "dir" as const },
];
const CODEX_CONFIG_SOURCE_BASELINE = ".y-space-config-source.toml";

export function seedNativeCodexHome(
  codexHomeDir: string,
  globalCodexHome = resolveNativeCodexProfileHome(),
): void {
  if (resolve(codexHomeDir) === resolve(globalCodexHome)) {
    throw new Error("private Codex home cannot also be the effective profile home");
  }
  mkdirSync(codexHomeDir, { recursive: true });

  for (const { name, kind } of CODEX_LINK_TARGETS) {
    const source = join(globalCodexHome, name);
    const target = join(codexHomeDir, name);
    if (!pathExistsOrSymlink(source)) continue;
    assertNativeCodexProfileEntry(source, kind);
    if (isNativeCodexStateMirror(source, target, kind)) continue;
    if (pathExistsOrSymlink(target)) preserveNativeCodexState(target);
    ensureNativeStateLink(source, target, kind);
    if (!isNativeCodexStateMirror(source, target, kind)) {
      throw new Error(`failed to link private Codex ${name} to the effective profile`);
    }
  }

  reconcileNativeCodexConfig(
    join(globalCodexHome, "config.toml"),
    join(codexHomeDir, "config.toml"),
    join(codexHomeDir, CODEX_CONFIG_SOURCE_BASELINE),
  );
}

export function resolveNativeCodexProfileHome(): string {
  const configured = getPrimedPosixEnv()?.CODEX_HOME?.trim() || process.env.CODEX_HOME?.trim();
  return configured ? resolve(configured) : join(homedir(), ".codex");
}

export function resolveNativeCodexSqliteHome(): string {
  const configured =
    getPrimedPosixEnv()?.CODEX_SQLITE_HOME?.trim() || process.env.CODEX_SQLITE_HOME?.trim();
  return configured ? resolve(configured) : resolveNativeCodexProfileHome();
}

function pathExistsOrSymlink(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function sameNativeLinkTarget(target: string, source: string): boolean {
  try {
    return resolve(dirname(target), readlinkSync(target)) === resolve(source);
  } catch {
    return false;
  }
}

function assertNativeCodexProfileEntry(source: string, kind: "dir" | "file"): void {
  const sourceStat = statSync(source);
  if ((kind === "dir" && sourceStat.isDirectory()) || (kind === "file" && sourceStat.isFile())) {
    return;
  }
  throw new Error(`effective Codex profile ${source} is not a ${kind}`);
}

function uniqueNativePreservationPath(path: string): string {
  let candidate = `${path}.y-space-private`;
  let index = 1;
  while (pathExistsOrSymlink(candidate)) {
    candidate = `${path}.y-space-private-${index}`;
    index += 1;
  }
  return candidate;
}

function preserveNativeCodexState(target: string): void {
  renameSync(target, uniqueNativePreservationPath(target));
}

function nativeFilesShareInode(left: string, right: string): boolean {
  try {
    const leftStat = statSync(left);
    const rightStat = statSync(right);
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch {
    return false;
  }
}

function nativeFilesHaveEqualContents(left: string, right: string): boolean {
  try {
    const leftStat = statSync(left);
    const rightStat = statSync(right);
    return (
      leftStat.isFile() &&
      rightStat.isFile() &&
      leftStat.size === rightStat.size &&
      readFileSync(left).equals(readFileSync(right))
    );
  } catch {
    return false;
  }
}

function copyNativeFileAtomically(source: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.y-space-copy-${randomUUID()}`;
  try {
    copyFileSync(source, temporary);
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function isTrustedNativeConfigBaseline(source: string, target: string, baseline: string): boolean {
  try {
    return (
      !lstatSync(baseline).isSymbolicLink() &&
      statSync(baseline).isFile() &&
      !nativeFilesShareInode(source, baseline) &&
      !nativeFilesShareInode(target, baseline)
    );
  } catch {
    return false;
  }
}

function isTrustedNativeConfigRemoval(target: string, baseline: string): boolean {
  try {
    const targetEntry = lstatSync(target);
    const baselineEntry = lstatSync(baseline);
    return (
      targetEntry.isFile() &&
      !targetEntry.isSymbolicLink() &&
      baselineEntry.isFile() &&
      !baselineEntry.isSymbolicLink() &&
      !nativeFilesShareInode(target, baseline) &&
      nativeFilesHaveEqualContents(target, baseline)
    );
  } catch {
    return false;
  }
}

function assertIndependentNativeConfig(source: string, target: string): void {
  if (
    lstatSync(target).isSymbolicLink() ||
    !statSync(target).isFile() ||
    nativeFilesShareInode(source, target)
  ) {
    throw new Error("private Codex config.toml is not an independent regular file");
  }
}

function reconcileNativeCodexConfig(source: string, target: string, baseline: string): void {
  if (!pathExistsOrSymlink(source)) {
    if (pathExistsOrSymlink(target) && lstatSync(target).isSymbolicLink()) {
      if (!statSync(target).isFile()) {
        throw new Error("private Codex config.toml symlink cannot be safely materialized");
      }
      copyNativeFileAtomically(target, target);
      return;
    }
    if (isTrustedNativeConfigRemoval(target, baseline)) {
      rmSync(target);
      rmSync(baseline);
    }
    return;
  }

  assertNativeCodexProfileEntry(source, "file");
  if (!pathExistsOrSymlink(target)) {
    copyNativeFileAtomically(source, target);
    copyNativeFileAtomically(source, baseline);
    assertIndependentNativeConfig(source, target);
    return;
  }

  let targetIsFile = false;
  try {
    targetIsFile = statSync(target).isFile();
  } catch {
    // A dangling legacy symlink cannot be copied without losing its target.
    throw new Error("private Codex config.toml cannot be safely materialized");
  }
  if (!targetIsFile) {
    preserveNativeCodexState(target);
    copyNativeFileAtomically(source, target);
    copyNativeFileAtomically(source, baseline);
    assertIndependentNativeConfig(source, target);
    return;
  }

  if (lstatSync(target).isSymbolicLink() || nativeFilesShareInode(source, target)) {
    const matchesSource = nativeFilesHaveEqualContents(source, target);
    // Copy through a sibling temporary before replacement. Opening `target`
    // for writes here would follow a symlink or shared inode into the user's
    // effective profile.
    copyNativeFileAtomically(target, target);
    if (matchesSource) copyNativeFileAtomically(source, baseline);
    assertIndependentNativeConfig(source, target);
    return;
  }

  if (isTrustedNativeConfigBaseline(source, target, baseline)) {
    if (nativeFilesHaveEqualContents(target, baseline)) {
      if (!nativeFilesHaveEqualContents(source, target)) {
        copyNativeFileAtomically(source, target);
      }
      copyNativeFileAtomically(source, baseline);
    }
  } else if (nativeFilesHaveEqualContents(source, target)) {
    // Upgrade a pre-baseline independent copy without changing it. Future
    // profile refreshes are safe only while this private copy matches the
    // app-owned baseline.
    copyNativeFileAtomically(source, baseline);
  }

  assertIndependentNativeConfig(source, target);
}

function isNativeCodexStateMirror(source: string, target: string, kind: "dir" | "file"): boolean {
  if (!existsSync(source) || !existsSync(target)) return false;
  try {
    if (lstatSync(target).isSymbolicLink()) {
      return sameNativeLinkTarget(target, source) || realpathSync(target) === realpathSync(source);
    }
    if (kind !== "file") return false;
    const sourceStat = statSync(source);
    const targetStat = statSync(target);
    if (!sourceStat.isFile() || !targetStat.isFile()) return false;
    return (
      (sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino) ||
      (sourceStat.size === targetStat.size && readFileSync(source).equals(readFileSync(target)))
    );
  } catch {
    return false;
  }
}

export function buildWslCodexHomeSeedScript(
  home: string,
  linuxCodexHome: string,
  globalCodexHome = `${home}/.codex`,
): string {
  const reconcileLine = (name: string, kind: "dir" | "file") =>
    `__y_space_reconcile ${quotePosixShellArg(`${globalCodexHome}/${name}`)} ${quotePosixShellArg(`${linuxCodexHome}/${name}`)} ${quotePosixShellArg(kind)}`;
  const profileConfig = `${globalCodexHome}/config.toml`;
  const privateConfig = `${linuxCodexHome}/config.toml`;
  const configBaseline = `${linuxCodexHome}/${CODEX_CONFIG_SOURCE_BASELINE}`;
  return [
    "set -eu",
    '__y_space_same() ( __y_space_source=$1; __y_space_target=$2; __y_space_kind=$3; [ -e "$__y_space_source" ] && [ -e "$__y_space_target" ] || exit 1; if [ -L "$__y_space_target" ]; then [ "$(readlink "$__y_space_target" 2>/dev/null || true)" = "$__y_space_source" ]; exit; fi; [ "$__y_space_kind" = file ] && [ -f "$__y_space_source" ] && [ -f "$__y_space_target" ] || exit 1; [ "$__y_space_source" -ef "$__y_space_target" ] 2>/dev/null || cmp -s -- "$__y_space_source" "$__y_space_target"; )',
    '__y_space_preserve() ( __y_space_target=$1; __y_space_backup=$__y_space_target.y-space-private; __y_space_index=1; while [ -e "$__y_space_backup" ] || [ -L "$__y_space_backup" ]; do __y_space_backup=$__y_space_target.y-space-private-$__y_space_index; __y_space_index=$((__y_space_index + 1)); done; mv -- "$__y_space_target" "$__y_space_backup"; )',
    '__y_space_reconcile() ( __y_space_source=$1; __y_space_target=$2; __y_space_kind=$3; [ -e "$__y_space_source" ] || [ -L "$__y_space_source" ] || exit 0; if [ "$__y_space_kind" = dir ]; then [ -d "$__y_space_source" ] || exit 1; else [ -f "$__y_space_source" ] || exit 1; fi; __y_space_same "$__y_space_source" "$__y_space_target" "$__y_space_kind" && exit 0; if [ -e "$__y_space_target" ] || [ -L "$__y_space_target" ]; then __y_space_preserve "$__y_space_target"; fi; ln -s -- "$__y_space_source" "$__y_space_target" 2>/dev/null || { [ "$__y_space_kind" = file ] && { ln -- "$__y_space_source" "$__y_space_target" 2>/dev/null || cp -p -- "$__y_space_source" "$__y_space_target"; }; }; __y_space_same "$__y_space_source" "$__y_space_target" "$__y_space_kind"; )',
    '__y_space_atomic_copy() ( __y_space_copy_source=$1; __y_space_copy_target=$2; __y_space_copy_tmp=$(mktemp "$__y_space_copy_target.y-space-copy.XXXXXX"); trap \'rm -f -- "$__y_space_copy_tmp"\' 0 1 2 15; cp -p -- "$__y_space_copy_source" "$__y_space_copy_tmp"; mv -f -- "$__y_space_copy_tmp" "$__y_space_copy_target"; )',
    '__y_space_config_baseline_is_trusted() ( __y_space_source=$1; __y_space_target=$2; __y_space_baseline=$3; [ -f "$__y_space_baseline" ] && [ ! -L "$__y_space_baseline" ] || exit 1; [ "$__y_space_source" -ef "$__y_space_baseline" ] 2>/dev/null && exit 1; [ "$__y_space_target" -ef "$__y_space_baseline" ] 2>/dev/null && exit 1; exit 0; )',
    '__y_space_config_removal_is_trusted() ( __y_space_target=$1; __y_space_baseline=$2; [ -f "$__y_space_target" ] && [ ! -L "$__y_space_target" ] || exit 1; [ -f "$__y_space_baseline" ] && [ ! -L "$__y_space_baseline" ] || exit 1; [ "$__y_space_target" -ef "$__y_space_baseline" ] 2>/dev/null && exit 1; cmp -s -- "$__y_space_target" "$__y_space_baseline"; )',
    '__y_space_config_is_independent() ( __y_space_source=$1; __y_space_target=$2; [ -f "$__y_space_target" ] && [ ! -L "$__y_space_target" ] || exit 1; [ "$__y_space_source" -ef "$__y_space_target" ] 2>/dev/null && exit 1; exit 0; )',
    '__y_space_reconcile_config() ( __y_space_source=$1; __y_space_target=$2; __y_space_baseline=$3; if [ ! -e "$__y_space_source" ] && [ ! -L "$__y_space_source" ]; then if [ -L "$__y_space_target" ]; then [ -f "$__y_space_target" ] || exit 1; __y_space_atomic_copy "$__y_space_target" "$__y_space_target"; exit; fi; if __y_space_config_removal_is_trusted "$__y_space_target" "$__y_space_baseline"; then rm -f -- "$__y_space_target" "$__y_space_baseline"; fi; exit 0; fi; [ -f "$__y_space_source" ] || exit 1; if [ ! -e "$__y_space_target" ] && [ ! -L "$__y_space_target" ]; then __y_space_atomic_copy "$__y_space_source" "$__y_space_target"; __y_space_atomic_copy "$__y_space_source" "$__y_space_baseline"; __y_space_config_is_independent "$__y_space_source" "$__y_space_target"; exit; fi; if [ ! -f "$__y_space_target" ]; then __y_space_preserve "$__y_space_target"; __y_space_atomic_copy "$__y_space_source" "$__y_space_target"; __y_space_atomic_copy "$__y_space_source" "$__y_space_baseline"; __y_space_config_is_independent "$__y_space_source" "$__y_space_target"; exit; fi; if [ -L "$__y_space_target" ] || [ "$__y_space_source" -ef "$__y_space_target" ]; then __y_space_matches_source=false; if cmp -s -- "$__y_space_source" "$__y_space_target"; then __y_space_matches_source=true; fi; __y_space_atomic_copy "$__y_space_target" "$__y_space_target"; if [ "$__y_space_matches_source" = true ]; then __y_space_atomic_copy "$__y_space_source" "$__y_space_baseline"; fi; __y_space_config_is_independent "$__y_space_source" "$__y_space_target"; exit; fi; if __y_space_config_baseline_is_trusted "$__y_space_source" "$__y_space_target" "$__y_space_baseline"; then if cmp -s -- "$__y_space_target" "$__y_space_baseline"; then if ! cmp -s -- "$__y_space_source" "$__y_space_target"; then __y_space_atomic_copy "$__y_space_source" "$__y_space_target"; fi; __y_space_atomic_copy "$__y_space_source" "$__y_space_baseline"; fi; elif cmp -s -- "$__y_space_source" "$__y_space_target"; then __y_space_atomic_copy "$__y_space_source" "$__y_space_baseline"; fi; __y_space_config_is_independent "$__y_space_source" "$__y_space_target"; )',
    `mkdir -p ${quotePosixShellArg(linuxCodexHome)}`,
    ...CODEX_LINK_TARGETS.map(({ name, kind }) => reconcileLine(name, kind)),
    `__y_space_reconcile_config ${quotePosixShellArg(profileConfig)} ${quotePosixShellArg(privateConfig)} ${quotePosixShellArg(configBaseline)}`,
  ].join("\n");
}

interface WslCodexRuntimeHomes {
  profileHome: string;
  sqliteHome: string;
}

async function resolveWslCodexRuntimeHomes(
  distro: string,
  home: string,
): Promise<WslCodexRuntimeHomes> {
  const configuredHomes = await execInWsl(
    distro,
    "/",
    "sh",
    ["-lc", 'printf "%s\\0%s" "${CODEX_HOME:-}" "${CODEX_SQLITE_HOME:-}"'],
    { timeout: 15_000 },
  );
  const [configuredProfileHome = "", configuredSqliteHome = ""] = configuredHomes.split("\0");
  const profileHome = configuredProfileHome.trim() || `${home}/.codex`;
  const sqliteHome = configuredSqliteHome.trim() || profileHome;
  if (!profileHome.startsWith("/")) {
    throw new Error(`WSL Codex profile home must be absolute in distro ${distro}`);
  }
  if (!sqliteHome.startsWith("/")) {
    throw new Error(`WSL Codex SQLite home must be absolute in distro ${distro}`);
  }
  return { profileHome, sqliteHome };
}

export async function resolveCodexSqliteHome(ctx?: AgentEnvContext): Promise<string> {
  if (isWslPluginContext(ctx)) {
    const wsl = getWslPluginBaseDirs(ctx.wslDistro, "codex");
    if (!wsl)
      throw new Error(`unable to resolve Codex runtime home in wsl distro ${ctx.wslDistro}`);
    return (await resolveWslCodexRuntimeHomes(ctx.wslDistro, wsl.home)).sqliteHome;
  }
  return resolveNativeCodexSqliteHome();
}

export async function seedWslCodexHome(
  distro: string,
  home: string,
  linuxCodexHome: string,
): Promise<WslCodexRuntimeHomes> {
  const runtimeHomes = await resolveWslCodexRuntimeHomes(distro, home);
  const globalCodexHome = runtimeHomes.profileHome;
  if (globalCodexHome.replace(/\/+$/u, "") === linuxCodexHome.replace(/\/+$/u, "")) {
    throw new Error("private WSL Codex home cannot also be the effective profile home");
  }
  const script = buildWslCodexHomeSeedScript(home, linuxCodexHome, globalCodexHome);
  await execInWsl(distro, "/", "sh", ["-lc", script], { timeout: 15_000 });
  return runtimeHomes;
}

const MIN_CODEX_SEMVER = [0, 122, 0] as const;
const CODEX_HOOKS_FEATURE_RENAME_SEMVER = [0, 130, 0] as const;
const CODEX_GOALS_FEATURE_SEMVER = [0, 130, 0] as const;

export function parseCodexVersionLine(line: string): [number, number, number] | null {
  const m = /codex-cli\s+(\d+)\.(\d+)\.(\d+)/i.exec(line.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function semverGte(a: [number, number, number], b: readonly [number, number, number]): boolean {
  if (a[0] !== b[0]) return a[0] > b[0];
  if (a[1] !== b[1]) return a[1] > b[1];
  return a[2] >= b[2];
}

/**
 * Probe `codex --version` on PATH. Returns null if unavailable or unparsable.
 *
 * On Windows the shared launch builder bypasses npm `.cmd` shims so probe
 * grandchildren do not create visible console windows.
 */
export function probeCodexCliSemver(): [number, number, number] | null {
  try {
    const windowsLocation = { kind: "windows" as const, path: homedir() };
    const resolvedCodexPath =
      process.platform === "win32" ? resolveAgentBinaryPath(windowsLocation, "codex") : undefined;
    const nativeCodexPath = resolveCodexNativeExecutableForWindows(resolvedCodexPath);
    const spec =
      process.platform === "win32"
        ? buildAgentCommand(
            windowsLocation,
            nativeCodexPath ?? resolvedCodexPath ?? "codex",
            ["--version"],
            nativeCodexPath ?? resolvedCodexPath,
          )
        : { command: "codex", args: ["--version"] };
    const out = execFileSync(spec.command, spec.args, {
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true,
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
      ...(spec.env ? { env: spec.env } : {}),
    });
    return parseCodexVersionLine(out);
  } catch {
    return null;
  }
}

export function isCodexSemverSupportedForHooks(v: [number, number, number] | null): boolean {
  if (!v) return false;
  return semverGte(v, MIN_CODEX_SEMVER);
}

export function isCodexSemverSupportedForGoals(v: [number, number, number] | null): boolean {
  if (!v) return false;
  return semverGte(v, CODEX_GOALS_FEATURE_SEMVER);
}

export function isCodexVersionSupportedForHooks(): boolean {
  return isCodexSemverSupportedForHooks(probeCodexCliSemver());
}

export function codexHooksFeatureFlagForSemver(v: [number, number, number] | null): string {
  return v && semverGte(v, CODEX_HOOKS_FEATURE_RENAME_SEMVER) ? "hooks" : "codex_hooks";
}

export interface InstallCodexPluginOptions {
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

export async function installCodexPlugin(
  ctx?: AgentEnvContext,
  options?: InstallCodexPluginOptions,
): Promise<{ ok: true; paths: CodexPluginPaths; version: string } | { ok: false; reason: string }> {
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
          "WSL Codex plugin install requires a resolved node path; the adapter must call resolveNodeForDistro before installing.",
      };
    }
    return installCodexPluginWsl(ctx.wslDistro, sourceDir, manifest, options.resolvedNodePath);
  }

  const pluginDir = getNativePluginBaseDir("codex", ctx?.baseDir);
  const codexHomeDir = join(pluginDir, "home");
  mkdirSync(pluginDir, { recursive: true });
  try {
    seedNativeCodexHome(codexHomeDir);
  } catch (error) {
    return {
      ok: false,
      reason: `failed to seed private Codex home from the effective profile: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  copyPluginAssetsIfStale(sourceDir, pluginDir);
  copyForwardRuntimeFile(pluginDir);
  const wrapperPath = writeNativeHookWrapper(pluginDir, {
    ...(options?.resolvedNodePath ? { nodePath: options.resolvedNodePath } : {}),
  });

  const hooksPath = join(codexHomeDir, "hooks.json");
  const existing = parseExistingHooksJson(hooksPath);
  if (existing === null && existsSync(hooksPath)) {
    return { ok: false, reason: "malformed private Codex hooks.json (invalid JSON)" };
  }

  // Native command shape: `<wrapper-command-head> <event>`. The wrapper sets
  // ELECTRON_RUN_AS_NODE=1 and execs the bundled Electron Node on
  // forward.mjs (which lives next to the wrapper).
  const commandHead = buildNativeHookCommandHeads(wrapperPath).command;

  try {
    const merged = mergeCodexHooksDocument(existing, commandHead);
    writeHooksJsonFile(hooksPath, merged);
  } catch (error) {
    return {
      ok: false,
      reason: `failed to write private Codex hooks.json: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  console.log(
    [
      `[supervisor] Codex hook plugin staged v${manifest.version}`,
      `  pluginDir: ${pluginDir}`,
      `  CODEX_HOME: ${codexHomeDir}`,
    ].join("\n"),
  );

  return {
    ok: true,
    version: manifest.version,
    paths: {
      pluginDir,
      codexHomeDir,
      sqliteHomeDir: resolveNativeCodexSqliteHome(),
      codexHooksPath: hooksPath,
      version: manifest.version,
    },
  };
}

async function installCodexPluginWsl(
  distro: string,
  sourceDir: string,
  manifest: PluginManifest,
  resolvedNodePath: string,
): Promise<{ ok: true; paths: CodexPluginPaths; version: string } | { ok: false; reason: string }> {
  const staged = stagePluginAssetsToWsl(distro, sourceDir, "codex", {
    includeForwardRuntime: true,
  });
  if (!staged.ok) return staged;

  const linuxForward = `${staged.linuxPluginDir}/forward.mjs`;
  const linuxCodexHome = `${staged.linuxPluginDir}/home`;
  let runtimeHomes: WslCodexRuntimeHomes;
  try {
    runtimeHomes = await seedWslCodexHome(distro, staged.deploy.home, linuxCodexHome);
  } catch (error) {
    return {
      ok: false,
      reason: `failed to seed private Codex home in wsl distro ${distro}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  const linuxHooksPath = `${linuxCodexHome}/hooks.json`;
  const uncHooks = toWslUncPath(distro, linuxHooksPath);

  const existing = parseExistingHooksJson(uncHooks);
  if (existing === null && existsSync(uncHooks)) {
    return {
      ok: false,
      reason: `malformed private Codex hooks.json in wsl distro ${distro}`,
    };
  }

  // WSL command shape: `"<absolute-node-path>" "<forward.mjs-path>" <event>`.
  // /bin/sh -c never has to resolve `node` from PATH because both are
  // absolute paths.
  const commandHead = `${JSON.stringify(resolvedNodePath)} ${JSON.stringify(linuxForward)}`;

  try {
    const merged = mergeCodexHooksDocument(existing, commandHead);
    writeHooksJsonFile(uncHooks, merged);
  } catch (error) {
    return {
      ok: false,
      reason: `failed to write hooks.json in wsl distro ${distro}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  console.log(
    [
      `[supervisor] Codex hook plugin staged v${manifest.version} (wsl:${distro})`,
      `  pluginDir: ${staged.linuxPluginDir}`,
      `  CODEX_HOME: ${linuxCodexHome}`,
    ].join("\n"),
  );

  return {
    ok: true,
    version: manifest.version,
    paths: {
      pluginDir: staged.linuxPluginDir,
      codexHomeDir: linuxCodexHome,
      sqliteHomeDir: runtimeHomes.sqliteHome,
      codexHooksPath: linuxHooksPath,
      version: manifest.version,
    },
  };
}

export function isCodexPluginInstalled(
  ctx?: AgentEnvContext,
): Promise<{ installed: boolean; version?: string }> {
  if (isWslPluginContext(ctx)) {
    const wsl = getWslPluginBaseDirs(ctx.wslDistro, "codex");
    if (!wsl) return Promise.resolve({ installed: false });
    const status = verifyCodexInstallAt(wsl.uncBase, "wsl");
    if (!status.installed) return Promise.resolve(status);
    return seedWslCodexHome(ctx.wslDistro, wsl.home, `${wsl.linuxBase}/home`).then(
      () => status,
      () => ({ installed: false }),
    );
  }
  const pluginDir = getNativePluginBaseDir("codex", ctx?.baseDir);
  const status = verifyCodexInstallAt(pluginDir, "native");
  if (!status.installed) return Promise.resolve(status);
  try {
    seedNativeCodexHome(join(pluginDir, "home"));
    return Promise.resolve(status);
  } catch {
    return Promise.resolve({ installed: false });
  }
}

export function uninstallCodexPlugin(ctx?: AgentEnvContext): void {
  removeStagedPluginDir("codex", ctx);
}

function verifyCodexInstallAt(
  readableDir: string,
  target: "native" | "wsl",
): { installed: boolean; version?: string } {
  const hooksPath = join(readableDir, "home", "hooks.json");
  if (!existsSync(join(readableDir, "plugin.json"))) return { installed: false };
  if (!existsSync(join(readableDir, "forward.mjs"))) return { installed: false };
  if (!existsSync(join(readableDir, FORWARD_RUNTIME_FILE))) return { installed: false };
  if (!hasNativeHookWrapper(readableDir, target)) return { installed: false };
  if (!existsSync(hooksPath)) return { installed: false };
  try {
    const raw = readFileSync(hooksPath, "utf8");
    const doc = JSON.parse(raw) as { hooks?: Record<string, unknown> };
    if (!doc.hooks) return { installed: false };
    let found = false;
    for (const event of CODEX_HOOK_EVENTS) {
      const groups = doc.hooks[event];
      if (!Array.isArray(groups)) continue;
      for (const g of groups) {
        if (!g || typeof g !== "object") continue;
        const hooks = (g as { hooks?: unknown }).hooks;
        if (!Array.isArray(hooks)) continue;
        for (const h of hooks) {
          if (!h || typeof h !== "object") continue;
          const cmd = (h as { command?: string }).command;
          if (typeof cmd === "string" && PORACODE_FORWARD_RE.test(cmd)) {
            found = true;
            break;
          }
        }
      }
    }
    if (!found) return { installed: false };
    const version = readPluginManifest(readableDir).version;
    return { installed: true, version };
  } catch {
    return { installed: false };
  }
}
