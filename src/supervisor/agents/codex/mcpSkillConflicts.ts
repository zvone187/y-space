import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, posix as posixPath, win32 as win32Path } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  COMPETING_BROWSER_SKILL_NAMES,
  hasYSpaceBrowserMcp,
} from "@/shared/browserExclusivePolicy";
import type { ProjectLocation, ResolvedMcpServer } from "@/shared/contracts";
import { getProjectFsPath, toWslUncPath } from "@/shared/wsl";
import {
  buildWslLoginShellCommand,
  getWslProjectShellEnv,
  quotePosixShellArg,
  resolveWslHomeDirectory,
} from "../base";
import { resolveNativeCodexProfileHome } from "./plugin/install";

interface SkillConfigEntry {
  path: string;
  enabled: boolean;
}

interface CodexBrowserConflictConfig {
  skillEntries: SkillConfigEntry[];
  profileMcpServerNames: string[];
}

const BROWSER_PLUGIN_SKILL = {
  marketplace: "openai-bundled",
  plugin: "browser",
  pathSegments: ["skills", "control-in-app-browser", "SKILL.md"],
} as const;

function readSkillConfigEntries(configPath: string): SkillConfigEntry[] | undefined {
  if (!existsSync(configPath)) return [];
  try {
    const parsed = parseToml(readFileSync(configPath, "utf8")) as {
      skills?: { config?: unknown };
    };
    if (!Array.isArray(parsed.skills?.config)) return [];
    return parsed.skills.config.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const record = entry as Record<string, unknown>;
      if (typeof record.path !== "string" || typeof record.enabled !== "boolean") return [];
      return [{ path: record.path, enabled: record.enabled }];
    });
  } catch {
    console.warn(`[codex] unable to preserve skill config from ${configPath}.`);
    return undefined;
  }
}

function readProfileMcpServerNames(configPath: string): string[] | undefined {
  if (!existsSync(configPath)) return [];
  try {
    const parsed = parseToml(readFileSync(configPath, "utf8")) as {
      mcp_servers?: unknown;
    };
    if (!parsed.mcp_servers || typeof parsed.mcp_servers !== "object") return [];
    return Object.entries(parsed.mcp_servers as Record<string, unknown>).flatMap(
      ([name, config]) => {
        if (config && typeof config === "object") {
          const enabled = (config as Record<string, unknown>).enabled;
          if (enabled === false) return [];
        }
        return [name];
      },
    );
  } catch {
    console.warn(`[codex] unable to inspect MCP config from ${configPath}.`);
    return undefined;
  }
}

function quoteTomlString(value: string): string {
  // JSON strings use the same quoted/backslash escapes needed by TOML basic strings.
  return JSON.stringify(value);
}

export function serializeSkillConfigOverride(entries: readonly SkillConfigEntry[]): string {
  return `[${entries
    .map(
      (entry) =>
        `{ path = ${quoteTomlString(entry.path)}, enabled = ${entry.enabled ? "true" : "false"} }`,
    )
    .join(", ")}]`;
}

function installedBrowserSkillPaths(hostCodexHome: string, providerCodexHome: string): string[] {
  const hostPluginRoot = join(
    hostCodexHome,
    "plugins",
    "cache",
    BROWSER_PLUGIN_SKILL.marketplace,
    BROWSER_PLUGIN_SKILL.plugin,
  );
  if (!existsSync(hostPluginRoot)) return [];
  const providerJoin = providerCodexHome.startsWith("/") ? posixPath.join : join;
  try {
    return readdirSync(hostPluginRoot, { withFileTypes: true }).flatMap((entry) => {
      if (!entry.isDirectory()) return [];
      const hostPath = join(hostPluginRoot, entry.name, ...BROWSER_PLUGIN_SKILL.pathSegments);
      if (!existsSync(hostPath)) return [];
      return [
        providerJoin(
          providerCodexHome,
          "plugins",
          "cache",
          BROWSER_PLUGIN_SKILL.marketplace,
          BROWSER_PLUGIN_SKILL.plugin,
          entry.name,
          ...BROWSER_PLUGIN_SKILL.pathSegments,
        ),
      ];
    });
  } catch {
    return [];
  }
}

const KNOWN_BROWSER_SKILL_NAMES = new Set<string>(COMPETING_BROWSER_SKILL_NAMES);

function isKnownBrowserSkillPath(path: string): boolean {
  const normalized = path.replace(/\\/gu, "/").toLowerCase();
  const segments = normalized.split("/");
  const skillName = segments.at(-2) ?? "";
  if (KNOWN_BROWSER_SKILL_NAMES.has(skillName)) return true;
  return skillName === "qa" && segments.includes("gstack");
}

function scanKnownBrowserSkills(
  hostRoot: string,
  providerRoot: string,
  providerJoin: typeof join | typeof posixPath.join,
  maxDepth = 2,
): string[] {
  const found: string[] = [];
  const visit = (hostPath: string, providerPath: string, depth: number): void => {
    const skillPath = join(hostPath, "SKILL.md");
    const providerSkillPath = providerJoin(providerPath, "SKILL.md");
    if (existsSync(skillPath) && isKnownBrowserSkillPath(providerSkillPath)) {
      found.push(providerSkillPath);
    }
    if (depth >= maxDepth || !existsSync(hostPath)) return;
    try {
      for (const entry of readdirSync(hostPath, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        visit(join(hostPath, entry.name), providerJoin(providerPath, entry.name), depth + 1);
      }
    } catch {
      // A disappearing or unreadable optional skill root is equivalent to no matches.
    }
  };
  visit(hostRoot, providerRoot, 0);
  return found;
}

function installedKnownBrowserSkillPaths(
  hostCodexHome: string,
  providerCodexHome: string,
  projectSkillRoots: readonly { host: string; provider: string }[] = [],
): string[] {
  const providerJoin = providerCodexHome.startsWith("/") ? posixPath.join : join;
  const roots = [
    {
      host: join(hostCodexHome, "skills"),
      provider: providerJoin(providerCodexHome, "skills"),
    },
    {
      host: join(hostCodexHome, "..", ".agents", "skills"),
      provider: providerJoin(providerCodexHome, "..", ".agents", "skills"),
    },
    ...projectSkillRoots,
  ];
  return [
    ...installedBrowserSkillPaths(hostCodexHome, providerCodexHome),
    ...roots.flatMap((root) => scanKnownBrowserSkills(root.host, root.provider, providerJoin)),
  ];
}

function projectAndAncestorSkillRoots(
  location: ProjectLocation,
): Array<{ host: string; provider: string }> {
  const hostPathApi = location.kind === "posix" ? posixPath : win32Path;
  const providerPathApi = location.kind === "wsl" ? posixPath : hostPathApi;
  let host = getProjectFsPath(location);
  let provider = location.kind === "wsl" ? location.linuxPath : host;
  const roots: Array<{ host: string; provider: string }> = [];

  // Codex discovers `.agents/skills` from cwd through its ancestors. Mirror
  // that discovery for launch-scoped suppression, with a hard bound for
  // malformed/virtual paths that do not converge on a filesystem root.
  for (let depth = 0; depth < 64; depth += 1) {
    roots.push({
      host: hostPathApi.join(host, ".agents", "skills"),
      provider: providerPathApi.join(provider, ".agents", "skills"),
    });
    const hostParent = hostPathApi.dirname(host);
    const providerParent = providerPathApi.dirname(provider);
    if (hostParent === host || providerParent === provider) break;
    host = hostParent;
    provider = providerParent;
  }
  return roots;
}

function tomlKeySegment(value: string): string {
  return /^[A-Za-z0-9_-]+$/u.test(value) ? value : quoteTomlString(value);
}

interface CodexProfileEnvironment {
  HOME?: string;
  CODEX_HOME?: string;
}

const WSL_PROFILE_ENV_MARKER = "__Y_SPACE_CODEX_PROFILE_ENV_V1__";

function resolveWslCodexProfileEnvironment(
  location: Extract<ProjectLocation, { kind: "wsl" }>,
): CodexProfileEnvironment {
  const cached = getWslProjectShellEnv(location.distro, location.linuxPath);
  if (cached) return cached;

  const script = [
    "printf '%s\\0%s\\0%s\\0'",
    quotePosixShellArg(WSL_PROFILE_ENV_MARKER),
    '"$HOME"',
    '"${CODEX_HOME-}"',
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
    const [HOME, CODEX_HOME] = stdout.slice(markerIndex + marker.length).split("\0");
    return {
      ...(HOME?.trim() ? { HOME: HOME.trim() } : {}),
      ...(CODEX_HOME?.trim() ? { CODEX_HOME: CODEX_HOME.trim() } : {}),
    };
  } catch {
    return {};
  }
}

export function resolveCodexProfileHomePaths(
  location: ProjectLocation,
  wslProfileEnv?: CodexProfileEnvironment,
): { hostPath: string; providerPath: string } | undefined {
  if (location.kind !== "wsl") {
    const path = resolveNativeCodexProfileHome();
    return { hostPath: path, providerPath: path };
  }
  const profileEnv = wslProfileEnv ?? resolveWslCodexProfileEnvironment(location);
  const home = profileEnv.HOME?.trim() || resolveWslHomeDirectory(location.distro);
  if (!home) return undefined;
  const configuredHome = profileEnv.CODEX_HOME?.trim();
  const providerPath = configuredHome || `${home.replace(/\/$/, "")}/.codex`;
  if (!posixPath.isAbsolute(providerPath)) return undefined;
  return {
    hostPath: toWslUncPath(location.distro, providerPath),
    providerPath,
  };
}

/**
 * Disable browser-backed Codex MCPs and skills only in the Y Space launch.
 * Existing skill enablement is preserved verbatim except for known browser
 * routes, and configured MCPs are disabled by name only after their complete
 * transport has been loaded from the normal user/project config stack.
 */
export function buildCodexMcpSkillConflictArgs(
  location: ProjectLocation,
  mcpServers: readonly ResolvedMcpServer[],
): string[] {
  if (!hasYSpaceBrowserMcp(mcpServers)) return [];

  const codexHome = resolveCodexProfileHomePaths(location);
  if (!codexHome) return [];
  const configPaths = [
    join(codexHome.hostPath, "config.toml"),
    join(getProjectFsPath(location), ".codex", "config.toml"),
  ];
  return buildCodexMcpSkillConflictArgsForPaths(
    mcpServers,
    codexHome.hostPath,
    codexHome.providerPath,
    configPaths,
    projectAndAncestorSkillRoots(location),
  );
}

export function buildCodexMcpSkillConflictArgsForPaths(
  mcpServers: readonly ResolvedMcpServer[],
  hostCodexHome: string,
  providerCodexHome: string,
  configPaths: readonly string[],
  projectSkillRoots: readonly { host: string; provider: string }[] = [],
): string[] {
  if (!hasYSpaceBrowserMcp(mcpServers)) return [];
  const resolved = resolveCodexBrowserConflictConfigForPaths(configPaths);
  if (!resolved) return [];

  const knownSkillPaths = new Set([
    ...installedKnownBrowserSkillPaths(hostCodexHome, providerCodexHome, projectSkillRoots),
    ...resolved.skillEntries
      .filter((entry) => isKnownBrowserSkillPath(entry.path))
      .map((entry) => entry.path),
  ]);
  const args: string[] = [];
  if (knownSkillPaths.size > 0) {
    const merged = new Map(resolved.skillEntries.map((entry) => [entry.path, entry]));
    for (const path of knownSkillPaths) {
      merged.set(path, { path, enabled: false });
    }
    args.push("-c", `skills.config=${serializeSkillConfigOverride([...merged.values()])}`);
  }
  if (resolved.profileMcpServerNames.length > 0) {
    console.info(
      `[codex] Browser-exclusive launch suppressed ${resolved.profileMcpServerNames.length} unmanaged provider-profile MCP server(s); app-managed MCPs remain available.`,
    );
  }
  for (const name of resolved.profileMcpServerNames) {
    args.push("-c", `mcp_servers.${tomlKeySegment(name)}.enabled=false`);
  }
  return args;
}

function resolveCodexBrowserConflictConfigForPaths(
  configPaths: readonly string[],
): CodexBrowserConflictConfig | undefined {
  const skillEntries: SkillConfigEntry[] = [];
  const profileMcpServerNames = new Set<string>();
  for (const configPath of configPaths) {
    const entries = readSkillConfigEntries(configPath);
    const mcpServerNames = readProfileMcpServerNames(configPath);
    // Do not replace an unreadable user config with a partial skills array.
    if (!entries || !mcpServerNames) return undefined;
    skillEntries.push(...entries);
    for (const name of mcpServerNames) profileMcpServerNames.add(name);
  }
  return { skillEntries, profileMcpServerNames: [...profileMcpServerNames] };
}

export function buildCodexBrowserConflictConfig(
  location: ProjectLocation,
  mcpServers: readonly ResolvedMcpServer[],
): Record<string, { enabled: false }> {
  if (!hasYSpaceBrowserMcp(mcpServers)) return {};
  const codexHome = resolveCodexProfileHomePaths(location);
  if (!codexHome) return {};
  const configPaths = [
    join(codexHome.hostPath, "config.toml"),
    join(getProjectFsPath(location), ".codex", "config.toml"),
  ];
  const resolved = resolveCodexBrowserConflictConfigForPaths(configPaths);
  if (!resolved) return {};
  return Object.fromEntries(
    resolved.profileMcpServerNames.map((name) => [
      `mcp_servers.${tomlKeySegment(name)}`,
      { enabled: false },
    ]),
  );
}
