import { spawn } from "node:child_process";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import type { ProjectLocation } from "@/shared/contracts";
import {
  buildAgentCommand,
  composeLaunchCleanups,
  createWslLaunchEnvironmentFile,
  definedEnv,
  getWslCommand,
  getWslProjectShellEnv,
  partitionWslLaunchEnvironment,
  quotePosixShellArg,
} from "../base";
import { resolveAgentBinaryPath } from "../binaryResolver";
import { sanitizeChildProcessEnv } from "@/supervisor/runtime/threadSession/spawnDiagnostics";
import {
  isPrivilegedChildEnvKey,
  posixPrivilegedEnvironmentUnsetPrefix,
} from "@/supervisor/privilegedChildEnvironment";

type NativeProjectLocation = Exclude<ProjectLocation, { kind: "wsl" }>;

export function projectCwd(location: ProjectLocation): string {
  switch (location.kind) {
    case "wsl":
      return location.linuxPath;
    case "windows":
    case "posix":
      return location.path;
  }
}

// SDK-provided env is layered on top of the WSL login-shell env we primed,
// so these Windows-host vars must be dropped — otherwise they overwrite the
// Linux PATH (and friends) inside the distro.
const WINDOWS_HOST_ENV_KEYS = new Set([
  "path",
  "pathext",
  "systemroot",
  "windir",
  "comspec",
  "appdata",
  "localappdata",
  "userprofile",
  "homedrive",
  "homepath",
  "programdata",
  "programfiles",
  "programfiles(x86)",
  "commonprogramfiles",
  "commonprogramfiles(x86)",
]);
export const POSIX_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function filteredEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (WINDOWS_HOST_ENV_KEYS.has(key.toLowerCase())) continue;
    if (isPrivilegedChildEnvKey(key)) continue;
    out[key] = value;
  }
  return out;
}

function buildDirectWslEnvCommandArgs(
  command: string,
  args: string[],
  env: Record<string, string>,
  protectedEnvPrefix = "",
): string[] {
  const exports = Object.entries(env)
    .filter(([key]) => POSIX_ENV_NAME_RE.test(key))
    .map(([key, value]) => `export ${key}=${quotePosixShellArg(value)}`)
    .join("; ");
  const exec = `exec ${[command, ...args].map(quotePosixShellArg).join(" ")}`;
  const script = `${posixPrivilegedEnvironmentUnsetPrefix()}${exports ? `${exports}; ` : ""}${protectedEnvPrefix}${exec}`;
  return ["/bin/sh", "-c", script];
}

export function spawnClaudeInWsl(location: ProjectLocation, options: SpawnOptions): SpawnedProcess {
  if (location.kind !== "wsl") {
    throw new Error("spawnClaudeInWsl called for a non-WSL project.");
  }
  const command = options.command || resolveAgentBinaryPath(location, "claude") || "claude";
  const cwd = options.cwd ?? location.linuxPath;
  const capturedEnv =
    getWslProjectShellEnv(location.distro, cwd) ??
    getWslProjectShellEnv(location.distro, location.linuxPath);
  const env = capturedEnv
    ? { ...capturedEnv, ...filteredEnv(options.env) }
    : filteredEnv(options.env);
  const partitioned = partitionWslLaunchEnvironment(env);
  const launchEnvironment = createWslLaunchEnvironmentFile(partitioned.protected);
  const args = [
    "-d",
    location.distro,
    "--cd",
    cwd,
    "--",
    ...buildDirectWslEnvCommandArgs(
      command,
      options.args,
      partitioned.inline,
      launchEnvironment?.sourcePrefix,
    ),
  ];
  try {
    const child = spawn(getWslCommand(), args, {
      env: sanitizeChildProcessEnv(process.env),
      signal: options.signal,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    if (launchEnvironment) {
      const cleanup = composeLaunchCleanups(undefined, launchEnvironment.cleanup)!;
      child.once("exit", cleanup);
      child.once("error", cleanup);
    }
    return child as unknown as SpawnedProcess;
  } catch (error) {
    launchEnvironment?.cleanup();
    throw error;
  }
}

export function spawnClaudeNative(
  location: NativeProjectLocation,
  options: SpawnOptions,
): SpawnedProcess {
  const command = options.command || resolveAgentBinaryPath(location, "claude") || "claude";
  const cwd = options.cwd ?? location.path;
  if (process.platform === "win32") {
    const env = definedEnv(options.env);
    const spec = buildAgentCommand(
      { ...location, path: cwd },
      command,
      options.args,
      undefined,
      env,
    );
    return spawn(spec.command, spec.args, {
      ...(spec.env
        ? { env: sanitizeChildProcessEnv(spec.env) }
        : Object.keys(env).length > 0
          ? { env: sanitizeChildProcessEnv(env) }
          : {}),
      signal: options.signal,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      cwd: spec.cwd,
    }) as unknown as SpawnedProcess;
  }
  return spawn(command, options.args, {
    env: sanitizeChildProcessEnv(options.env),
    signal: options.signal,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    // Own a POSIX process group so task/session teardown can reap Claude's
    // shell and tool descendants even if the SDK's immediate CLI child exits
    // first. Windows keeps its prior spawn behavior and uses taskkill /T.
    detached: location.kind === "posix",
    cwd,
  }) as unknown as SpawnedProcess;
}
