import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPosixExportPrefix, quotePosixShellArg } from "./shellBasics";

const WSL_LAUNCH_ENV_PREFIX = "y-space-wsl-env-";
const trackedLaunchDirectories = new Set<string>();
let processExitCleanupRegistered = false;

export interface PartitionedWslLaunchEnvironment {
  inline: Record<string, string>;
  protected: Record<string, string>;
}

export interface WslLaunchEnvironmentFile {
  /** Host-side path retained for tests and best-effort lifecycle cleanup. */
  hostPath: string;
  /** Shell prefix that sources and immediately unlinks the file without embedding values. */
  sourcePrefix: string;
  cleanup(): void;
}

export interface DirectWslEnvironmentCommandArgs {
  args: string[];
  cleanup?: () => void;
}

/**
 * Environment records can mix ordinary settings with credentials whose names
 * are provider-defined (API keys, server passwords, hook secrets, and values
 * captured from the user's WSL shell). Name-based secret detection is therefore
 * unsafe: keep the entire explicit launch environment out of host-visible argv.
 */
export function partitionWslLaunchEnvironment(
  env: Readonly<Record<string, string>>,
): PartitionedWslLaunchEnvironment {
  return { inline: {}, protected: { ...env } };
}

/** Synchronously remove every launch artifact still owned by this process. */
export function cleanupTrackedWslLaunchEnvironmentFiles(): void {
  for (const directory of trackedLaunchDirectories) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Process shutdown cleanup is best effort and must remain synchronous.
    }
  }
  trackedLaunchDirectories.clear();
}

function trackLaunchDirectory(directory: string): void {
  trackedLaunchDirectories.add(directory);
  if (processExitCleanupRegistered) return;
  processExitCleanupRegistered = true;
  process.once("exit", cleanupTrackedWslLaunchEnvironmentFiles);
}

/**
 * Store launch-only values outside argv. The host temp directory inherits the
 * signed-in user's ACL; explicit POSIX modes additionally protect it on hosts
 * that implement them. WSL resolves the host path with `wslpath`, sources it,
 * and unlinks the file before the provider process starts.
 */
export function createWslLaunchEnvironmentFile(
  env: Readonly<Record<string, string>>,
): WslLaunchEnvironmentFile | undefined {
  const body = buildPosixExportPrefix({ ...env });
  if (!body) return undefined;

  const directory = mkdtempSync(join(tmpdir(), WSL_LAUNCH_ENV_PREFIX));
  const hostPath = join(directory, "environment.sh");
  try {
    chmodSync(directory, 0o700);
    writeFileSync(hostPath, `${body}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    chmodSync(hostPath, 0o600);
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  trackLaunchDirectory(directory);

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    try {
      rmSync(directory, { recursive: true, force: true });
      cleaned = true;
      trackedLaunchDirectories.delete(directory);
    } catch {
      // Keep the directory registered so synchronous process-exit cleanup can retry.
    }
  };
  const resolveFile =
    process.platform === "win32"
      ? `$(wslpath -a -u -- ${quotePosixShellArg(hostPath)})`
      : quotePosixShellArg(hostPath);
  const sourcePrefix = [
    `__y_space_launch_env_file=${resolveFile};`,
    'if [ ! -r "$__y_space_launch_env_file" ]; then',
    "printf '%s\\n' 'Y Space launch environment is unavailable.' >&2;",
    "exit 1;",
    "fi;",
    "__y_space_launch_env_dir=${__y_space_launch_env_file%/*};",
    'set -- "$__y_space_launch_env_file" "$__y_space_launch_env_dir" "$@";',
    "unset __y_space_launch_env_dir;",
    "unset __y_space_launch_env_file;",
    'if ! . "$1"; then',
    '/bin/rm -f -- "$1" 2>/dev/null || true;',
    '/bin/rmdir -- "$2" 2>/dev/null || true;',
    "printf '%s\\n' 'Y Space launch environment could not be loaded.' >&2;",
    "exit 1;",
    "fi;",
    'if ! /bin/rm -f -- "$1" 2>/dev/null; then',
    "printf '%s\\n' 'Y Space launch environment could not be removed.' >&2;",
    "exit 1;",
    "fi;",
    'if ! /bin/rmdir -- "$2" 2>/dev/null; then',
    "printf '%s\\n' 'Y Space launch environment directory could not be removed.' >&2;",
    "exit 1;",
    "fi;",
    "shift 2;",
    "",
  ].join(" ");

  return { hostPath, sourcePrefix, cleanup };
}

/**
 * Build the argv following `wsl.exe ... --` for a direct, non-login provider
 * process. Every explicit environment value is sourced from the protected
 * launch file; only the provider command and its arguments remain in argv.
 */
export function buildDirectWslEnvironmentCommandArgs(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): DirectWslEnvironmentCommandArgs {
  const partitioned = partitionWslLaunchEnvironment(env);
  const environmentArgs = Object.entries(partitioned.inline).map(
    ([key, value]) => `${key}=${value}`,
  );
  const launchEnvironment = createWslLaunchEnvironmentFile(partitioned.protected);
  if (!launchEnvironment) {
    return { args: ["/usr/bin/env", ...environmentArgs, command, ...args] };
  }
  return {
    args: [
      "/bin/sh",
      "-c",
      `${launchEnvironment.sourcePrefix}exec /usr/bin/env "$@"`,
      "y-space-wsl-launch",
      ...environmentArgs,
      command,
      ...args,
    ],
    cleanup: launchEnvironment.cleanup,
  };
}

export function composeLaunchCleanups(
  first: (() => void) | undefined,
  second: (() => void) | undefined,
): (() => void) | undefined {
  if (!first) return second;
  if (!second) return first;
  return () => {
    try {
      first();
    } finally {
      second();
    }
  };
}
