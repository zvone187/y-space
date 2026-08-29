import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, posix as posixPath, resolve } from "node:path";
import JSON5 from "json5";
import type { ProjectLocation } from "@/shared/contracts";
import { getProjectFsPath, toWslUncPath } from "@/shared/wsl";
import { buildWslLoginShellCommand, quotePosixShellArg, resolveWslHomeDirectory } from "../base";

type OpenCodeMcpConfig = {
  enabled?: boolean;
  command?: readonly unknown[];
  url?: unknown;
};

function configProfileMcpNames(configPath: string): string[] {
  if (!existsSync(configPath)) return [];
  try {
    const parsed = JSON5.parse(readFileSync(configPath, "utf8")) as { mcp?: unknown };
    if (!parsed.mcp || typeof parsed.mcp !== "object" || Array.isArray(parsed.mcp)) return [];
    return Object.entries(parsed.mcp as Record<string, unknown>).flatMap(([name, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const config = value as OpenCodeMcpConfig;
      if (config.enabled === false) return [];
      return [name];
    });
  } catch {
    // Never include raw parser errors: JSON5 diagnostics may echo a line that
    // contains a credential from the user's provider config.
    console.warn(`[opencode] unable to inspect MCP config from ${configPath}.`);
    return [];
  }
}

export function resolveOpenCodeProfileMcpNamesForPaths(configPaths: readonly string[]): string[] {
  return [...new Set(configPaths.flatMap(configProfileMcpNames))];
}

function nativeConfigRoot(env: NodeJS.ProcessEnv): string {
  const configured = env.OPENCODE_CONFIG_DIR?.trim();
  if (configured) return isAbsolute(configured) ? configured : resolve(homedir(), configured);
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return xdg
    ? join(isAbsolute(xdg) ? xdg : resolve(homedir(), xdg), "opencode")
    : join(homedir(), ".config", "opencode");
}

const WSL_PROFILE_ENV_MARKER = "__Y_SPACE_OPENCODE_PROFILE_ENV_V1__";

function resolveWslProfileEnvironment(location: Extract<ProjectLocation, { kind: "wsl" }>): {
  HOME?: string;
  OPENCODE_CONFIG?: string;
  OPENCODE_CONFIG_DIR?: string;
  XDG_CONFIG_HOME?: string;
} {
  const script = [
    "printf '%s\\0%s\\0%s\\0%s\\0%s\\0'",
    quotePosixShellArg(WSL_PROFILE_ENV_MARKER),
    '"$HOME"',
    '"${OPENCODE_CONFIG-}"',
    '"${OPENCODE_CONFIG_DIR-}"',
    '"${XDG_CONFIG_HOME-}"',
  ].join(" ");
  const command = buildWslLoginShellCommand(location.distro, location.linuxPath, script);
  try {
    const result = spawnSync(command.command, command.args, {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      timeout: 5_000,
    });
    if (result.error || result.status !== 0) return {};
    const stdout = `${result.stdout ?? ""}`;
    const marker = `${WSL_PROFILE_ENV_MARKER}\0`;
    const markerIndex = stdout.lastIndexOf(marker);
    if (markerIndex < 0) return {};
    const [HOME, OPENCODE_CONFIG, OPENCODE_CONFIG_DIR, XDG_CONFIG_HOME] = stdout
      .slice(markerIndex + marker.length)
      .split("\0");
    return {
      ...(HOME?.trim() ? { HOME: HOME.trim() } : {}),
      ...(OPENCODE_CONFIG?.trim() ? { OPENCODE_CONFIG: OPENCODE_CONFIG.trim() } : {}),
      ...(OPENCODE_CONFIG_DIR?.trim() ? { OPENCODE_CONFIG_DIR: OPENCODE_CONFIG_DIR.trim() } : {}),
      ...(XDG_CONFIG_HOME?.trim() ? { XDG_CONFIG_HOME: XDG_CONFIG_HOME.trim() } : {}),
    };
  } catch {
    return {};
  }
}

function wslAbsolutePath(value: string, base: string): string {
  return posixPath.isAbsolute(value) ? posixPath.normalize(value) : posixPath.resolve(base, value);
}

/** Exact user/project config paths OpenCode merges for this provider launch. */
export function resolveOpenCodeConfigPaths(
  location: ProjectLocation,
  profileEnv: NodeJS.ProcessEnv = process.env,
): string[] {
  if (location.kind !== "wsl") {
    const globalRoot = nativeConfigRoot(profileEnv);
    const projectRoot = getProjectFsPath(location);
    const explicit = profileEnv.OPENCODE_CONFIG?.trim();
    return [
      join(globalRoot, "opencode.jsonc"),
      join(globalRoot, "opencode.json"),
      join(projectRoot, "opencode.jsonc"),
      join(projectRoot, "opencode.json"),
      ...(explicit ? [isAbsolute(explicit) ? explicit : resolve(projectRoot, explicit)] : []),
    ];
  }

  const home = profileEnv.HOME?.trim() || resolveWslHomeDirectory(location.distro);
  if (!home) {
    return [
      toWslUncPath(location.distro, posixPath.join(location.linuxPath, "opencode.jsonc")),
      toWslUncPath(location.distro, posixPath.join(location.linuxPath, "opencode.json")),
    ];
  }
  const configuredRoot = profileEnv.OPENCODE_CONFIG_DIR?.trim();
  const xdgRoot = profileEnv.XDG_CONFIG_HOME?.trim();
  const globalRoot = configuredRoot
    ? wslAbsolutePath(configuredRoot, home)
    : xdgRoot
      ? posixPath.join(wslAbsolutePath(xdgRoot, home), "opencode")
      : posixPath.join(home, ".config", "opencode");
  const explicit = profileEnv.OPENCODE_CONFIG?.trim();
  const linuxPaths = [
    posixPath.join(globalRoot, "opencode.jsonc"),
    posixPath.join(globalRoot, "opencode.json"),
    posixPath.join(location.linuxPath, "opencode.jsonc"),
    posixPath.join(location.linuxPath, "opencode.json"),
    ...(explicit ? [wslAbsolutePath(explicit, location.linuxPath)] : []),
  ];
  return linuxPaths.map((path) => toWslUncPath(location.distro, path));
}

/** Read, but never mutate, the OpenCode user/project configs this launch merges. */
export function resolveOpenCodeProfileMcpNames(
  location: ProjectLocation,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const profileEnv = location.kind === "wsl" ? resolveWslProfileEnvironment(location) : env;
  const paths = resolveOpenCodeConfigPaths(location, profileEnv);
  const names = resolveOpenCodeProfileMcpNamesForPaths(paths);
  if (names.length > 0) {
    console.info(
      `[opencode] Browser-exclusive launch suppressed ${names.length} unmanaged provider-profile MCP server(s); app-managed MCPs remain available.`,
    );
  }
  return names;
}
