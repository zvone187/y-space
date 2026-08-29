import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import path, { posix as posixPath } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ProjectLocation } from "@/shared/contracts";
import {
  isCompetingBrowserSkillIdentity,
  isCompetingBrowserMcpServer,
} from "@/shared/browserExclusivePolicy";
import {
  getPrimedPosixEnv,
  getProjectShellEnv,
  getWslCommand,
  getWslProjectShellEnv,
  resolveWslHomeDirectory,
} from "../base";
import type { ClaudeMcpLaunchConfig, ClaudeMcpServerConfig } from "../userMcp";

export const CLAUDE_EFFECTIVE_MCP_UNAVAILABLE_MESSAGE =
  "Claude MCP settings could not be safely resolved for this Y Space Browser session. Fix or remove the malformed Claude MCP configuration and try again.";

const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_AGENT_FILES = 512;
const MAX_AGENT_DIRECTORY_DEPTH = 16;
const WSL_MISSING_FILE_STATUS = 44;

type JsonRecord = Record<string, unknown>;
type PathApi = typeof path | typeof posixPath;
type ClaudeMcpToolPolicy = {
  name: string;
  permission_policy?: "always_allow" | "always_ask" | "always_deny";
  org_max_permission?: "allow" | "ask" | "blocked";
};

type ClaudeProfileMcpServerConfig =
  | {
      type: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
      timeout?: number;
      alwaysLoad?: boolean;
    }
  | {
      type: "http" | "sse" | "ws";
      url: string;
      headers?: Record<string, string>;
      timeout?: number;
      alwaysLoad?: boolean;
      tools?: ClaudeMcpToolPolicy[];
    };

export type ClaudeEffectiveMcpServerConfig = ClaudeMcpServerConfig | ClaudeProfileMcpServerConfig;

export interface ClaudeEffectiveAgentDefinition extends JsonRecord {
  description: string;
  prompt: string;
  mcpServers: Array<Record<string, ClaudeEffectiveMcpServerConfig>>;
}

export interface ClaudeBrowserExclusiveMcpConfig {
  mcpServers: Record<string, ClaudeEffectiveMcpServerConfig>;
  env: Record<string, string>;
  agents: Record<string, ClaudeEffectiveAgentDefinition>;
}

interface ResolveClaudeBrowserExclusiveMcpConfigInput {
  projectLocation: ProjectLocation;
  configDir?: string;
  launchEnv?: Record<string, string>;
  appLaunch: ClaudeMcpLaunchConfig;
}

interface SourceReader {
  readOptional(sourcePath: string): string | undefined;
  listAgentFiles(directoryPath: string): string[];
}

interface ProjectionContext {
  env: Record<string, string>;
  expansionEnv: Record<string, string>;
}

interface ParsedAgent {
  name: string;
  definition: ClaudeEffectiveAgentDefinition;
}

interface InstalledPluginEntry extends JsonRecord {
  installPath: string;
  scope?: string;
  projectPath?: string;
}

function nullRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown): JsonRecord {
  if (!isRecord(value)) throw new Error("Expected an object.");
  return value;
}

function requireString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Expected a non-empty string.");
  }
  return value;
}

function requireStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("Expected a string array.");
  }
  return [...value];
}

function optionalStringArray(record: JsonRecord, key: string): string[] {
  const value = record[key];
  return value === undefined ? [] : requireStringArray(value);
}

function parseJsonDocument(source: string): JsonRecord {
  return requireRecord(JSON.parse(source) as unknown);
}

function readJsonOptional(reader: SourceReader, sourcePath: string): JsonRecord | undefined {
  const source = reader.readOptional(sourcePath);
  return source === undefined ? undefined : parseJsonDocument(source);
}

function nativeReader(): SourceReader {
  const readOptional = (sourcePath: string): string | undefined => {
    try {
      const size = statSync(sourcePath).size;
      if (size > MAX_SOURCE_BYTES) throw new Error("Claude configuration source is too large.");
      const source = readFileSync(sourcePath, "utf8");
      if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
        throw new Error("Claude configuration source is too large.");
      }
      return source;
    } catch (error) {
      if (isMissingFsError(error)) return undefined;
      throw error;
    }
  };

  return {
    readOptional,
    listAgentFiles(directoryPath) {
      try {
        if (!lstatSync(directoryPath).isDirectory()) {
          throw new Error("Claude agent source is not a directory.");
        }
      } catch (error) {
        if (isMissingFsError(error)) return [];
        throw error;
      }

      const files: string[] = [];
      const visit = (currentPath: string, depth: number): void => {
        if (depth > MAX_AGENT_DIRECTORY_DEPTH) {
          throw new Error("Claude agent directory nesting is too deep.");
        }
        const entries = readdirSync(currentPath, { withFileTypes: true }).sort((left, right) =>
          left.name.localeCompare(right.name),
        );
        for (const entry of entries) {
          const entryPath = path.join(currentPath, entry.name);
          if (entry.isDirectory()) {
            visit(entryPath, depth + 1);
          } else if (isReadableMarkdownEntry(entry)) {
            files.push(entryPath);
            if (files.length > MAX_AGENT_FILES) {
              throw new Error("Too many Claude agent sources.");
            }
          }
        }
      };
      visit(directoryPath, 0);
      return files;
    },
  };
}

function isReadableMarkdownEntry(entry: Dirent): boolean {
  return entry.name.toLowerCase().endsWith(".md") && (entry.isFile() || entry.isSymbolicLink());
}

function isMissingFsError(error: unknown): boolean {
  return isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function wslReader(distro: string): SourceReader {
  const run = (script: string, sourcePath: string): string | undefined => {
    const result = spawnSync(
      getWslCommand(),
      ["-d", distro, "--exec", "sh", "-c", script, "sh", sourcePath],
      {
        encoding: "utf8",
        maxBuffer: MAX_SOURCE_BYTES,
        shell: false,
        timeout: 5_000,
        windowsHide: true,
      },
    );
    if (result.status === WSL_MISSING_FILE_STATUS) return undefined;
    if (result.error || result.status !== 0) throw new Error("Could not read WSL source.");
    return `${result.stdout ?? ""}`;
  };

  return {
    readOptional(sourcePath) {
      return run(
        'if [ ! -e "$1" ]; then exit 44; fi; [ -f "$1" ] || exit 45; size=$(wc -c < "$1") || exit 46; [ "$size" -le 8388608 ] || exit 47; cat "$1"',
        sourcePath,
      );
    },
    listAgentFiles(directoryPath) {
      const output = run(
        'if [ ! -e "$1" ]; then exit 44; fi; [ -d "$1" ] || exit 45; find "$1" -maxdepth 17 \\( -type f -o -type l \\) -name "*.md" -print0',
        directoryPath,
      );
      if (output === undefined || output.length === 0) return [];
      const files = output.split("\0").filter(Boolean).sort();
      if (files.length > MAX_AGENT_FILES) throw new Error("Too many Claude agent sources.");
      return files;
    },
  };
}

function stringEnvironment(
  source: NodeJS.ProcessEnv | Record<string, string> | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(source ?? {})) {
    if (typeof value === "string") result[name] = value;
  }
  return result;
}

function projectDirectory(location: ProjectLocation): string {
  return location.kind === "wsl" ? location.linuxPath : location.path;
}

function resolveSourcePaths(input: ResolveClaudeBrowserExclusiveMcpConfigInput): {
  configRoot: string;
  statePath: string;
  projectDir: string;
  pathApi: PathApi;
  reader: SourceReader;
  effectiveEnv: Record<string, string>;
} {
  const location = input.projectLocation;
  const projectDir = projectDirectory(location);
  const pathApi = location.kind === "wsl" ? posixPath : path;
  const reader = location.kind === "wsl" ? wslReader(location.distro) : nativeReader();
  const home = location.kind === "wsl" ? resolveWslHomeDirectory(location.distro) : homedir();
  if (!home) throw new Error("Claude home directory is unavailable.");

  const cachedShellEnv =
    location.kind === "wsl"
      ? getWslProjectShellEnv(location.distro, projectDir)
      : (getProjectShellEnv(projectDir) ?? getPrimedPosixEnv());

  // Match the actual provider spawn environment. In WSL, CLAUDE_CONFIG_DIR
  // commonly exists only in the cached login-shell environment and must be
  // resolved before selecting the sources to sanitize.
  const configuredRoot =
    input.configDir ?? input.launchEnv?.CLAUDE_CONFIG_DIR ?? cachedShellEnv?.CLAUDE_CONFIG_DIR;
  const rawRoot = configuredRoot?.trim() || pathApi.join(home, ".claude");
  const tildeExpandedRoot =
    rawRoot === "~"
      ? home
      : rawRoot.startsWith("~/")
        ? pathApi.join(home, rawRoot.slice(2))
        : rawRoot;
  const configRoot = pathApi.isAbsolute(tildeExpandedRoot)
    ? pathApi.normalize(tildeExpandedRoot)
    : pathApi.resolve(projectDir, tildeExpandedRoot);
  const statePath = configuredRoot?.trim()
    ? pathApi.join(configRoot, ".claude.json")
    : pathApi.join(home, ".claude.json");

  const effectiveEnv = {
    ...(location.kind === "wsl" ? {} : stringEnvironment(process.env)),
    ...stringEnvironment(cachedShellEnv),
    HOME: home,
    CLAUDE_PROJECT_DIR: projectDir,
    ...stringEnvironment(input.launchEnv),
  };

  return { configRoot, statePath, projectDir, pathApi, reader, effectiveEnv };
}

function expandClaudeEnvironment(value: string, env: Record<string, string>): string {
  const expanded = value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-(.*?))?\}/gu,
    (_match, name: string, fallback: string | undefined) => {
      const resolved = env[name];
      if (resolved !== undefined && resolved.length > 0) return resolved;
      if (fallback !== undefined) return fallback;
      throw new Error("Claude MCP environment variable is unavailable.");
    },
  );
  if (/\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}/u.test(expanded)) {
    throw new Error("Claude MCP environment expansion is incomplete.");
  }
  return expanded;
}

function profileEnvName(identity: string, field: string): string {
  const digest = createHash("sha256")
    .update(identity)
    .update("\0")
    .update(field)
    .digest("hex")
    .slice(0, 24)
    .toUpperCase();
  return `PORACODE_MCP_CLAUDE_PROFILE_${digest}`;
}

function protectValue(
  value: string,
  identity: string,
  field: string,
  context: ProjectionContext,
): string {
  const name = profileEnvName(identity, field);
  const existing = context.env[name];
  if (existing !== undefined && existing !== value) {
    throw new Error("Claude MCP projection identity collision.");
  }
  context.env[name] = value;
  return `\${${name}}`;
}

function resolvedStringRecord(value: unknown, env: Record<string, string>): Record<string, string> {
  const record = requireRecord(value);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== "string") throw new Error("Expected string configuration values.");
    result[key] = expandClaudeEnvironment(entry, env);
  }
  return result;
}

function optionalTimeout(record: JsonRecord): number | undefined {
  const value = record.timeout;
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("Invalid Claude MCP timeout.");
  }
  return value;
}

function optionalAlwaysLoad(record: JsonRecord): boolean | undefined {
  const value = record.alwaysLoad;
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error("Invalid Claude MCP alwaysLoad value.");
  return value;
}

function optionalToolPolicies(record: JsonRecord): ClaudeMcpToolPolicy[] | undefined {
  const value = record.tools;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("Invalid Claude MCP tool policy.");
  return value.map((rawPolicy) => {
    const policy = requireRecord(rawPolicy);
    const name = requireString(policy.name);
    const permissionPolicy = policy.permission_policy;
    if (
      permissionPolicy !== undefined &&
      permissionPolicy !== "always_allow" &&
      permissionPolicy !== "always_ask" &&
      permissionPolicy !== "always_deny"
    ) {
      throw new Error("Invalid Claude MCP permission policy.");
    }
    const orgMaxPermission = policy.org_max_permission;
    if (
      orgMaxPermission !== undefined &&
      orgMaxPermission !== "allow" &&
      orgMaxPermission !== "ask" &&
      orgMaxPermission !== "blocked"
    ) {
      throw new Error("Invalid Claude MCP organization policy.");
    }
    return {
      name,
      ...(permissionPolicy !== undefined ? { permission_policy: permissionPolicy } : {}),
      ...(orgMaxPermission !== undefined ? { org_max_permission: orgMaxPermission } : {}),
    };
  });
}

function rawMcpCandidate(
  identity: string,
  name: string,
  rawValue: unknown,
): Parameters<typeof isCompetingBrowserMcpServer>[0] {
  const record = isRecord(rawValue) ? rawValue : {};
  const command = typeof record.command === "string" ? record.command : "";
  const args = Array.isArray(record.args)
    ? record.args.filter((entry): entry is string => typeof entry === "string")
    : [];
  const url = typeof record.url === "string" ? record.url : "";
  const description = typeof record.description === "string" ? record.description : undefined;
  const tools = Array.isArray(record.tools)
    ? record.tools.flatMap((entry) => {
        if (!isRecord(entry) || typeof entry.name !== "string") return [];
        return [
          {
            name: entry.name,
            ...(typeof entry.description === "string" ? { description: entry.description } : {}),
          },
        ];
      })
    : undefined;
  return {
    id: identity,
    name,
    transport: url ? { type: "http", url, headers: {} } : { type: "stdio", command, args, env: {} },
    ...(description ? { description } : {}),
    ...(tools?.length ? { tools } : {}),
  };
}

function resolvedMcpCandidate(
  identity: string,
  name: string,
  config: ClaudeProfileMcpServerConfig,
): Parameters<typeof isCompetingBrowserMcpServer>[0] {
  return {
    id: identity,
    name,
    transport:
      config.type === "stdio"
        ? {
            type: "stdio",
            command: config.command,
            args: config.args ?? [],
            env: config.env ?? {},
            ...(config.cwd ? { cwd: config.cwd } : {}),
          }
        : {
            type: config.type === "ws" ? "http" : config.type,
            url: config.url,
            headers: config.headers ?? {},
          },
    ...(config.type !== "stdio" && config.tools ? { tools: config.tools } : {}),
  };
}

function resolveMcpServerConfig(
  rawValue: unknown,
  env: Record<string, string>,
): ClaudeProfileMcpServerConfig {
  const record = requireRecord(rawValue);
  const rawType = record.type;
  if (rawType !== undefined && typeof rawType !== "string") {
    throw new Error("Invalid Claude MCP transport type.");
  }
  const hasCommand = record.command !== undefined;
  const hasUrl = record.url !== undefined;
  if (hasCommand === hasUrl) throw new Error("Invalid Claude MCP transport configuration.");

  const timeout = optionalTimeout(record);
  const alwaysLoad = optionalAlwaysLoad(record);
  if (hasCommand) {
    if (rawType !== undefined && rawType !== "stdio") {
      throw new Error("Invalid Claude MCP stdio transport type.");
    }
    const command = expandClaudeEnvironment(requireString(record.command), env);
    const args =
      record.args === undefined
        ? undefined
        : requireStringArray(record.args).map((entry) => expandClaudeEnvironment(entry, env));
    const serverEnv = record.env === undefined ? undefined : resolvedStringRecord(record.env, env);
    const cwd =
      record.cwd === undefined
        ? undefined
        : expandClaudeEnvironment(requireString(record.cwd), env);
    return {
      type: "stdio",
      command,
      ...(args ? { args } : {}),
      ...(serverEnv ? { env: serverEnv } : {}),
      ...(cwd ? { cwd } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
      ...(alwaysLoad !== undefined ? { alwaysLoad } : {}),
    };
  }

  const normalizedType = rawType === "streamable-http" ? "http" : rawType;
  if (normalizedType !== "http" && normalizedType !== "sse" && normalizedType !== "ws") {
    throw new Error("Unsupported Claude MCP remote transport type.");
  }
  const url = expandClaudeEnvironment(requireString(record.url), env);
  const headers =
    record.headers === undefined ? undefined : resolvedStringRecord(record.headers, env);
  const tools = optionalToolPolicies(record);
  return {
    type: normalizedType,
    url,
    ...(headers ? { headers } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    ...(alwaysLoad !== undefined ? { alwaysLoad } : {}),
    ...(tools ? { tools } : {}),
  };
}

function protectMcpServerConfig(
  config: ClaudeProfileMcpServerConfig,
  identity: string,
  context: ProjectionContext,
): ClaudeProfileMcpServerConfig {
  if (config.type === "stdio") {
    return {
      type: "stdio",
      command: protectValue(config.command, identity, "command", context),
      ...(config.args
        ? {
            args: config.args.map((entry, index) =>
              protectValue(entry, identity, `args.${index}`, context),
            ),
          }
        : {}),
      ...(config.env
        ? {
            env: Object.fromEntries(
              Object.entries(config.env).map(([key, value]) => [
                key,
                protectValue(value, identity, `env.${key}`, context),
              ]),
            ),
          }
        : {}),
      ...(config.cwd ? { cwd: protectValue(config.cwd, identity, "cwd", context) } : {}),
      ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
      ...(config.alwaysLoad !== undefined ? { alwaysLoad: config.alwaysLoad } : {}),
    };
  }
  return {
    type: config.type,
    url: protectValue(config.url, identity, "url", context),
    ...(config.headers
      ? {
          headers: Object.fromEntries(
            Object.entries(config.headers).map(([key, value]) => [
              key,
              protectValue(value, identity, `headers.${key}`, context),
            ]),
          ),
        }
      : {}),
    ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
    ...(config.alwaysLoad !== undefined ? { alwaysLoad: config.alwaysLoad } : {}),
    ...(config.tools ? { tools: config.tools } : {}),
  };
}

function projectProfileServer(
  rawValue: unknown,
  identity: string,
  outputName: string,
  context: ProjectionContext,
): ClaudeProfileMcpServerConfig | undefined {
  if (isCompetingBrowserMcpServer(rawMcpCandidate(identity, outputName, rawValue))) {
    return undefined;
  }
  const resolved = resolveMcpServerConfig(rawValue, context.expansionEnv);
  if (isCompetingBrowserMcpServer(resolvedMcpCandidate(identity, outputName, resolved))) {
    return undefined;
  }
  return protectMcpServerConfig(resolved, identity, context);
}

function requireMcpServerMap(value: unknown): JsonRecord {
  return requireRecord(value);
}

function optionalMcpServerMap(record: JsonRecord, key = "mcpServers"): JsonRecord {
  const value = record[key];
  return value === undefined ? {} : requireMcpServerMap(value);
}

function mergeProfileServers(
  target: Record<string, ClaudeEffectiveMcpServerConfig>,
  rawServers: JsonRecord,
  sourceIdentity: string,
  context: ProjectionContext,
  outputNameFor: (rawName: string) => string = (rawName) => rawName,
): void {
  for (const [rawName, rawValue] of Object.entries(rawServers).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (rawName.length === 0 || isUnsafeRecordKey(rawName)) {
      throw new Error("Invalid Claude MCP server name.");
    }
    const outputName = outputNameFor(rawName);
    const config = projectProfileServer(
      rawValue,
      `${sourceIdentity}:${rawName}`,
      outputName,
      context,
    );
    if (config) target[outputName] = config;
  }
}

function isUnsafeRecordKey(name: string): boolean {
  return name === "__proto__" || name === "constructor" || name === "prototype";
}

function settingsPluginStates(settings: JsonRecord | undefined): Record<string, boolean> {
  if (!settings || settings.enabledPlugins === undefined) return {};
  const enabledPlugins = requireRecord(settings.enabledPlugins);
  const result: Record<string, boolean> = {};
  for (const [pluginId, enabled] of Object.entries(enabledPlugins)) {
    if (typeof enabled !== "boolean") throw new Error("Invalid Claude plugin setting.");
    result[pluginId] = enabled;
  }
  return result;
}

function resolveEnabledPlugins(
  reader: SourceReader,
  pathApi: PathApi,
  configRoot: string,
  projectDir: string,
  projectTrusted: boolean,
): string[] {
  const states: Record<string, boolean> = {};
  Object.assign(
    states,
    settingsPluginStates(readJsonOptional(reader, pathApi.join(configRoot, "settings.json"))),
  );
  if (projectTrusted) {
    Object.assign(
      states,
      settingsPluginStates(
        readJsonOptional(reader, pathApi.join(projectDir, ".claude", "settings.json")),
      ),
      settingsPluginStates(
        readJsonOptional(reader, pathApi.join(projectDir, ".claude", "settings.local.json")),
      ),
    );
  }
  return Object.entries(states)
    .filter(([, enabled]) => enabled)
    .map(([pluginId]) => pluginId)
    .sort();
}

function parseInstalledPluginEntry(value: unknown): InstalledPluginEntry {
  const record = requireRecord(value);
  const installPath = requireString(record.installPath);
  const scope = record.scope;
  const projectPath = record.projectPath;
  if (scope !== undefined && typeof scope !== "string") {
    throw new Error("Invalid Claude plugin scope.");
  }
  if (projectPath !== undefined && typeof projectPath !== "string") {
    throw new Error("Invalid Claude plugin project path.");
  }
  return {
    ...record,
    installPath,
    ...(scope ? { scope } : {}),
    ...(projectPath ? { projectPath } : {}),
  };
}

function installedPluginForProject(
  rawEntry: unknown,
  projectDir: string,
): InstalledPluginEntry | undefined {
  const entries = (Array.isArray(rawEntry) ? rawEntry : [rawEntry]).map(parseInstalledPluginEntry);
  const candidates = entries.filter((entry) => {
    if (entry.scope === "project" || entry.scope === "local") {
      return entry.projectPath === projectDir;
    }
    return entry.scope === undefined || entry.scope === "user";
  });
  const rank = (scope: string | undefined): number => {
    if (scope === "local") return 3;
    if (scope === "project") return 2;
    return 1;
  };
  return candidates.sort((left, right) => rank(left.scope) - rank(right.scope)).at(-1);
}

function pluginDataDirectory(pathApi: PathApi, configRoot: string, pluginId: string): string {
  return pathApi.join(configRoot, "plugins", "data", pluginId.replace(/[^A-Za-z0-9_-]/gu, "-"));
}

function pluginServerDocuments(
  reader: SourceReader,
  pathApi: PathApi,
  installPath: string,
): JsonRecord[] {
  const manifest = readJsonOptional(
    reader,
    pathApi.join(installPath, ".claude-plugin", "plugin.json"),
  );
  const declared = manifest?.mcpServers;
  if (declared === undefined) {
    const defaultDocument = readJsonOptional(reader, pathApi.join(installPath, ".mcp.json"));
    return defaultDocument ? [extractPluginServerMap(defaultDocument)] : [];
  }

  const documents: JsonRecord[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      const configPath = pathApi.isAbsolute(value) ? value : pathApi.join(installPath, value);
      const document = readJsonOptional(reader, configPath);
      if (!document) throw new Error("Declared Claude plugin MCP source is missing.");
      documents.push(extractPluginServerMap(document));
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    documents.push(extractPluginServerMap(requireRecord(value)));
  };
  visit(declared);
  return documents;
}

function extractPluginServerMap(document: JsonRecord): JsonRecord {
  return document.mcpServers === undefined ? document : requireMcpServerMap(document.mcpServers);
}

function mergePluginServers(
  target: Record<string, ClaudeEffectiveMcpServerConfig>,
  reader: SourceReader,
  pathApi: PathApi,
  configRoot: string,
  projectDir: string,
  enabledPluginIds: string[],
  context: ProjectionContext,
): void {
  if (enabledPluginIds.length === 0) return;
  const registry = readJsonOptional(
    reader,
    pathApi.join(configRoot, "plugins", "installed_plugins.json"),
  );
  if (!registry) return;
  const installed = requireRecord(registry.plugins);

  for (const pluginId of enabledPluginIds) {
    const rawEntry = installed[pluginId];
    if (rawEntry === undefined) continue;
    const entry = installedPluginForProject(rawEntry, projectDir);
    if (!entry) continue;
    const installPath = pathApi.isAbsolute(entry.installPath)
      ? pathApi.normalize(entry.installPath)
      : pathApi.resolve(configRoot, entry.installPath);
    const pluginName = pluginId.split("@")[0];
    if (!pluginName || isUnsafeRecordKey(pluginName)) {
      throw new Error("Invalid Claude plugin identity.");
    }
    const pluginContext: ProjectionContext = {
      env: context.env,
      expansionEnv: {
        ...context.expansionEnv,
        CLAUDE_PLUGIN_ROOT: installPath,
        CLAUDE_PLUGIN_DATA: pluginDataDirectory(pathApi, configRoot, pluginId),
        CLAUDE_PROJECT_DIR: projectDir,
      },
    };
    pluginServerDocuments(reader, pathApi, installPath).forEach((document, documentIndex) => {
      mergeProfileServers(
        target,
        document,
        `plugin:${pluginId}:${documentIndex}`,
        pluginContext,
        (rawName) => `plugin:${pluginName}:${rawName}`,
      );
    });
  }
}

const SAFE_AGENT_STRING_FIELDS = [
  "model",
  "criticalSystemReminder_EXPERIMENTAL",
  "initialPrompt",
  "memory",
  "permissionMode",
  "observer",
  "observerMessage",
] as const;
const SAFE_AGENT_STRING_ARRAY_FIELDS = ["tools", "disallowedTools", "skills"] as const;
function safeAgentMetadata(frontmatter: JsonRecord): JsonRecord {
  const metadata: JsonRecord = {};
  for (const key of SAFE_AGENT_STRING_FIELDS) {
    const value = frontmatter[key];
    if (value === undefined) continue;
    if (typeof value !== "string") throw new Error("Invalid Claude agent string metadata.");
    metadata[key] = value;
  }
  for (const key of SAFE_AGENT_STRING_ARRAY_FIELDS) {
    const value = frontmatter[key];
    if (value === undefined) continue;
    const entries = requireStringArray(value);
    const filtered =
      key === "skills"
        ? entries.filter((entry) => !isCompetingBrowserSkillIdentity(entry))
        : entries;
    if (filtered.length > 0) metadata[key] = filtered;
  }
  const maxTurns = frontmatter.maxTurns;
  if (maxTurns !== undefined) {
    if (typeof maxTurns !== "number" || !Number.isInteger(maxTurns) || maxTurns <= 0) {
      throw new Error("Invalid Claude agent maxTurns metadata.");
    }
    metadata.maxTurns = maxTurns;
  }
  const background = frontmatter.background;
  if (background !== undefined) {
    if (typeof background !== "boolean") {
      throw new Error("Invalid Claude agent background metadata.");
    }
    metadata.background = background;
  }
  const effort = frontmatter.effort;
  if (effort !== undefined) {
    if (typeof effort !== "string" && typeof effort !== "number") {
      throw new Error("Invalid Claude agent effort metadata.");
    }
    metadata.effort = effort;
  }
  return metadata;
}

function splitAgentFrontmatter(
  source: string,
): { frontmatter: JsonRecord; prompt: string } | undefined {
  const normalized = source.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) return undefined;
  const closingIndex = normalized.indexOf("\n---\n", 4);
  if (closingIndex < 0) throw new Error("Unterminated Claude agent frontmatter.");
  const frontmatter = requireRecord(parseYaml(normalized.slice(4, closingIndex)) as unknown);
  return {
    frontmatter,
    prompt: normalized.slice(closingIndex + 5).trim(),
  };
}

function parseAgent(
  source: string,
  sourceIdentity: string,
  availableMainServers: Readonly<Record<string, ClaudeEffectiveMcpServerConfig>>,
  context: ProjectionContext,
): ParsedAgent | undefined {
  const split = splitAgentFrontmatter(source);
  if (!split) return undefined;
  const rawName = split.frontmatter.name;
  if (rawName === undefined) return undefined;
  const name = requireString(rawName);
  if (isUnsafeRecordKey(name)) throw new Error("Invalid Claude agent name.");
  const description = requireString(split.frontmatter.description);
  if (split.prompt.length === 0) throw new Error("Claude agent prompt is empty.");
  const metadata = safeAgentMetadata(split.frontmatter);
  const rawMcpServers = split.frontmatter.mcpServers;
  if (rawMcpServers !== undefined && !Array.isArray(rawMcpServers)) {
    throw new Error("Invalid Claude agent MCP configuration.");
  }

  const mcpServers: Array<Record<string, ClaudeEffectiveMcpServerConfig>> = [];
  const seenServerNames = new Set<string>();
  const addServer = (serverName: string, config: ClaudeEffectiveMcpServerConfig): void => {
    if (seenServerNames.has(serverName)) return;
    seenServerNames.add(serverName);
    mcpServers.push({ [serverName]: config });
  };
  const embeddedBrowser = availableMainServers.browser;
  if (embeddedBrowser) addServer("browser", embeddedBrowser);

  (rawMcpServers ?? []).forEach((rawEntry, index) => {
    if (typeof rawEntry === "string") {
      const referencedConfig = availableMainServers[rawEntry];
      if (referencedConfig) addServer(rawEntry, referencedConfig);
      return;
    }
    const wrapped = requireRecord(rawEntry);
    const entries = Object.entries(wrapped);
    if (entries.length !== 1) throw new Error("Invalid inline Claude agent MCP configuration.");
    const [serverName, rawConfig] = entries[0] ?? [];
    if (!serverName || isUnsafeRecordKey(serverName)) {
      throw new Error("Invalid inline Claude agent MCP name.");
    }
    const config = projectProfileServer(
      rawConfig,
      `${sourceIdentity}:${name}:mcp:${index}:${serverName}`,
      serverName,
      context,
    );
    // Inline filesystem-agent MCPs are provider-profile transports too. They
    // cannot be routed through Y Space's advertised-tool proxy, so validate
    // and sanitize the source but suppress it fail-closed for this launch.
    void config;
  });

  return {
    name,
    definition: {
      ...metadata,
      description,
      prompt: split.prompt,
      mcpServers,
    },
  };
}

function mergeAgentsFromDirectory(
  agents: Record<string, ClaudeEffectiveAgentDefinition>,
  reader: SourceReader,
  directoryPath: string,
  sourceScope: string,
  availableMainServers: Readonly<Record<string, ClaudeEffectiveMcpServerConfig>>,
  context: ProjectionContext,
): void {
  const files = reader.listAgentFiles(directoryPath);
  files.forEach((agentPath, index) => {
    const source = reader.readOptional(agentPath);
    if (source === undefined) throw new Error("Claude agent source disappeared.");
    const parsed = parseAgent(
      source,
      `${sourceScope}:agent:${index}`,
      availableMainServers,
      context,
    );
    if (!parsed) return;
    agents[parsed.name] = parsed.definition;
  });
}

function mergeAppServers(
  target: Record<string, ClaudeEffectiveMcpServerConfig>,
  appLaunch: ClaudeMcpLaunchConfig,
): void {
  for (const [name, config] of Object.entries(appLaunch.mcpServers)) {
    const candidate =
      config.type === "stdio"
        ? {
            id: name,
            name,
            transport: {
              type: "stdio" as const,
              command: config.command,
              args: config.args,
              env: config.env,
            },
          }
        : {
            id: name,
            name,
            transport: {
              type: config.type,
              url: config.url,
              headers: config.headers,
            },
          };
    if (!isCompetingBrowserMcpServer(candidate)) target[name] = config;
  }
}

function referencedLaunchEnvironment(
  allEnv: Record<string, string>,
  mcpServers: Record<string, ClaudeEffectiveMcpServerConfig>,
  agents: Record<string, ClaudeEffectiveAgentDefinition>,
): Record<string, string> {
  const referencedNames = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u.exec(value);
      if (match?.[1]) referencedNames.add(match[1]);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (isRecord(value)) Object.values(value).forEach(visit);
  };
  visit(mcpServers);
  for (const agent of Object.values(agents)) visit(agent.mcpServers);
  return Object.fromEntries(Object.entries(allEnv).filter(([name]) => referencedNames.has(name)));
}

function resolveInternal(
  input: ResolveClaudeBrowserExclusiveMcpConfigInput,
): ClaudeBrowserExclusiveMcpConfig {
  const { configRoot, statePath, projectDir, pathApi, reader, effectiveEnv } =
    resolveSourcePaths(input);
  const state = readJsonOptional(reader, statePath) ?? {};
  const projects = state.projects === undefined ? {} : requireRecord(state.projects);
  const rawProjectState = projects[projectDir];
  const projectState = rawProjectState === undefined ? undefined : requireRecord(rawProjectState);
  const projectTrusted = projectState?.hasTrustDialogAccepted === true;
  const enabledProjectServers = new Set(
    projectState ? optionalStringArray(projectState, "enabledMcpjsonServers") : [],
  );
  const disabledProjectServers = new Set(
    projectState ? optionalStringArray(projectState, "disabledMcpjsonServers") : [],
  );
  const projectionEnv: Record<string, string> = {};
  const context: ProjectionContext = { env: projectionEnv, expansionEnv: effectiveEnv };
  const profileMcpServers = nullRecord<ClaudeEffectiveMcpServerConfig>();

  const enabledPlugins = resolveEnabledPlugins(
    reader,
    pathApi,
    configRoot,
    projectDir,
    projectTrusted,
  );
  mergePluginServers(
    profileMcpServers,
    reader,
    pathApi,
    configRoot,
    projectDir,
    enabledPlugins,
    context,
  );
  mergeProfileServers(profileMcpServers, optionalMcpServerMap(state), "user", context);

  if (projectTrusted) {
    const projectMcpDocument = readJsonOptional(reader, pathApi.join(projectDir, ".mcp.json"));
    if (projectMcpDocument) {
      const declaredServers = optionalMcpServerMap(projectMcpDocument);
      const approvedServers: JsonRecord = {};
      for (const [name, config] of Object.entries(declaredServers)) {
        if (enabledProjectServers.has(name) && !disabledProjectServers.has(name)) {
          approvedServers[name] = config;
        }
      }
      mergeProfileServers(profileMcpServers, approvedServers, "project", context);
    }
    if (projectState) {
      mergeProfileServers(profileMcpServers, optionalMcpServerMap(projectState), "local", context);
    }
  }

  const mcpServers = nullRecord<ClaudeEffectiveMcpServerConfig>();
  mergeAppServers(mcpServers, input.appLaunch);
  if (Object.keys(profileMcpServers).length > 0) {
    console.info(
      `[claude] Browser-exclusive launch suppressed ${Object.keys(profileMcpServers).length} unmanaged provider-profile MCP server(s); app-managed MCPs remain available.`,
    );
  }
  const agents = nullRecord<ClaudeEffectiveAgentDefinition>();
  mergeAgentsFromDirectory(
    agents,
    reader,
    pathApi.join(configRoot, "agents"),
    "user",
    mcpServers,
    context,
  );
  // The SDK loads filesystem agents from configured setting sources even when
  // their project MCP configuration is not trusted. Always provide a
  // same-name, sanitized programmatic definition so a filtered agent cannot
  // fall back to its original browser MCP. Untrusted project MCPs remain
  // absent from `mcpServers`; every projected agent still receives the
  // app-owned embedded Browser connection.
  mergeAgentsFromDirectory(
    agents,
    reader,
    pathApi.join(projectDir, ".claude", "agents"),
    "project",
    mcpServers,
    context,
  );

  const allProjectionEnv = { ...projectionEnv, ...input.appLaunch.env };
  return {
    mcpServers,
    env: referencedLaunchEnvironment(allProjectionEnv, mcpServers, agents),
    agents,
  };
}

/**
 * Recreate Claude's effective MCP sources as one launch-scoped projection for
 * Browser-exclusive sessions. Provider files remain read-only. Any source we
 * cannot inspect safely aborts the launch with a stable, redacted error rather
 * than allowing `--strict-mcp-config` to silently erase unrelated integrations
 * or accidentally re-enable an unclassified browser route.
 */
export function resolveClaudeBrowserExclusiveMcpConfig(
  input: ResolveClaudeBrowserExclusiveMcpConfigInput,
): ClaudeBrowserExclusiveMcpConfig {
  try {
    return resolveInternal(input);
  } catch {
    throw new Error(CLAUDE_EFFECTIVE_MCP_UNAVAILABLE_MESSAGE);
  }
}
