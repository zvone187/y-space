import { createHash } from "node:crypto";
import type { ResolvedMcpServer } from "@/shared/contracts";
import {
  COMPETING_BROWSER_COMMAND_GLOBS,
  COMPETING_BROWSER_SKILL_NAMES,
  hasYSpaceBrowserMcp,
} from "@/shared/browserExclusivePolicy";

export type ClaudeMcpServerConfig =
  | {
      type: "stdio";
      command: string;
      args: string[];
      env: Record<string, string>;
      timeout: number;
    }
  | {
      type: "http" | "sse";
      url: string;
      headers: Record<string, string>;
      timeout: number;
    };

export function buildClaudeMcpServers(
  servers: readonly ResolvedMcpServer[],
): Record<string, ClaudeMcpServerConfig> {
  return Object.fromEntries(
    servers.map((server) => {
      const transport = server.transport;
      if (transport.type === "stdio") {
        return [
          server.name,
          {
            type: "stdio" as const,
            command: transport.command,
            args: transport.args,
            env: transport.env,
            timeout: server.timeoutMs,
          },
        ];
      }
      return [
        server.name,
        {
          type: transport.type,
          url: transport.url,
          headers: transport.headers,
          timeout: server.timeoutMs,
        },
      ];
    }),
  );
}

export interface ClaudeMcpLaunchConfig {
  mcpServers: Record<string, ClaudeMcpServerConfig>;
  env: Record<string, string>;
}

function claudeMcpEnvVar(
  server: Pick<ResolvedMcpServer, "id" | "name">,
  kind: "ENV" | "HEADER",
  key: string,
): string {
  return `PORACODE_MCP_CLAUDE_${envLabel(server.name, "SERVER")}_${envIdentityHash(server.name, server.id)}_${kind}_${envLabel(key, "VALUE")}_${envIdentityHash(kind, key)}`;
}

/**
 * Build Claude's launch-scoped MCP projection without placing credentials in
 * `--mcp-config` (or the SDK-spawned equivalent). Claude expands `${VAR}` in
 * MCP env and header values from the child environment.
 */
export function buildClaudeMcpLaunchConfig(
  servers: readonly ResolvedMcpServer[],
): ClaudeMcpLaunchConfig {
  const mcpServers = buildClaudeMcpServers(servers);
  const env: Record<string, string> = {};

  for (const server of servers) {
    const transport = server.transport;
    const config = mcpServers[server.name];
    if (!config) continue;

    if (transport.type === "stdio" && config.type === "stdio") {
      config.env = Object.fromEntries(
        Object.entries(transport.env).map(([key, value]) => {
          const envVar = claudeMcpEnvVar(server, "ENV", key);
          env[envVar] = value;
          return [key, `\${${envVar}}`];
        }),
      );
      continue;
    }

    if (transport.type !== "stdio" && config.type !== "stdio") {
      config.headers = Object.fromEntries(
        Object.entries(transport.headers).map(([key, value]) => {
          const envVar = claudeMcpEnvVar(server, "HEADER", key);
          env[envVar] = value;
          return [key, `\${${envVar}}`];
        }),
      );
    }
  }

  return { mcpServers, env };
}

export type CursorSdkMcpServerConfig =
  | {
      type: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
    }
  | {
      type: "http" | "sse";
      url: string;
      headers?: Record<string, string>;
    };

/**
 * Project Poracode's provider-neutral MCP descriptors into the public
 * `@cursor/sdk` shape. Cursor has no per-server timeout field, so timeoutMs is
 * intentionally not forwarded. OAuth client configuration is likewise absent
 * here: Poracode resolves remote authorization before the provider boundary
 * and supplies the resulting headers.
 */
export function buildCursorSdkMcpServers(
  servers: readonly ResolvedMcpServer[],
): Record<string, CursorSdkMcpServerConfig> {
  return Object.fromEntries(
    servers.map((server) => {
      const transport = server.transport;
      if (transport.type === "stdio") {
        return [
          server.name,
          {
            type: "stdio" as const,
            command: transport.command,
            ...(transport.args.length > 0 ? { args: transport.args } : {}),
            ...(Object.keys(transport.env).length > 0 ? { env: transport.env } : {}),
            ...(transport.cwd ? { cwd: transport.cwd } : {}),
          },
        ];
      }
      return [
        server.name,
        {
          type: transport.type,
          url: transport.url,
          ...(Object.keys(transport.headers).length > 0 ? { headers: transport.headers } : {}),
        },
      ];
    }),
  );
}

export interface GeminiMcpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  httpUrl?: string;
  url?: string;
  headers?: Record<string, string>;
  timeout: number;
}

export function buildGeminiMcpServers(
  servers: readonly ResolvedMcpServer[],
): Record<string, GeminiMcpServerConfig> {
  const result: Record<string, GeminiMcpServerConfig> = {};
  for (const server of servers) {
    const transport = server.transport;
    if (transport.type === "stdio") {
      result[server.name] = {
        command: transport.command,
        args: transport.args,
        env: transport.env,
        ...(transport.cwd ? { cwd: transport.cwd } : {}),
        timeout: server.timeoutMs,
      };
    } else if (transport.type === "http") {
      result[server.name] = {
        httpUrl: transport.url,
        headers: transport.headers,
        timeout: server.timeoutMs,
      };
    } else {
      result[server.name] = {
        url: transport.url,
        headers: transport.headers,
        timeout: server.timeoutMs,
      };
    }
  }
  return result;
}

export type OpenCodeMcpServerConfig =
  | {
      type: "local";
      command: string[];
      cwd?: string;
      environment?: Record<string, string>;
      enabled: true;
      timeout: number;
    }
  | {
      type: "remote";
      url: string;
      headers?: Record<string, string>;
      enabled: true;
      timeout: number;
    };

export function buildOpenCodeMcp(
  servers: readonly ResolvedMcpServer[],
): Record<string, OpenCodeMcpServerConfig> {
  const result: Record<string, OpenCodeMcpServerConfig> = {};
  for (const server of servers) {
    const transport = server.transport;
    result[server.name] =
      transport.type === "stdio"
        ? {
            type: "local",
            command: [transport.command, ...transport.args],
            ...(transport.cwd ? { cwd: transport.cwd } : {}),
            ...(Object.keys(transport.env).length > 0 ? { environment: transport.env } : {}),
            enabled: true,
            timeout: server.timeoutMs,
          }
        : {
            type: "remote",
            url: transport.url,
            ...(Object.keys(transport.headers).length > 0 ? { headers: transport.headers } : {}),
            enabled: true,
            timeout: server.timeoutMs,
          };
  }
  return result;
}

export interface OpenCodeMcpLaunchConfig {
  configContent: string;
  env: Record<string, string>;
}

const OPEN_CODE_EXTERNAL_BROWSER_MCPS = [
  "playwright",
  "chrome",
  "chromium",
  "chrome-devtools",
  "chrome_devtools",
  "puppeteer",
  "selenium",
  "gstack",
  "stagehand",
  "browserbase",
  "browserstack",
  "browserless",
  "firefox",
  "webkit",
  "webdriver",
  "node_repl",
  "browser-use",
  "browser_use",
] as const;

export function buildOpenCodeBrowserExclusiveConfig(): Record<string, unknown> {
  return {
    tools: { webfetch: false, websearch: false },
    permission: {
      skill: Object.fromEntries(COMPETING_BROWSER_SKILL_NAMES.map((name) => [name, "deny"])),
      bash: Object.fromEntries(COMPETING_BROWSER_COMMAND_GLOBS.map((pattern) => [pattern, "deny"])),
    },
    mcp: Object.fromEntries(
      OPEN_CODE_EXTERNAL_BROWSER_MCPS.map((name) => [name, { enabled: false }]),
    ),
  };
}

function openCodeMcpEnvVar(
  server: Pick<ResolvedMcpServer, "id" | "name">,
  kind: "ENV" | "HEADER",
  key: string,
): string {
  return `PORACODE_MCP_OPENCODE_${envLabel(server.name, "SERVER")}_${envIdentityHash(server.name, server.id)}_${kind}_${envLabel(key, "VALUE")}_${envIdentityHash(kind, key)}`;
}

/**
 * Build OpenCode's per-process config overlay. Credential-bearing values stay
 * out of OPENCODE_CONFIG_CONTENT and are resolved by OpenCode from the child
 * process environment at launch time.
 */
export function buildOpenCodeMcpLaunchConfig(
  servers: readonly ResolvedMcpServer[],
  resolvedBrowserMcpNames: readonly string[] = [],
): OpenCodeMcpLaunchConfig {
  const mcp = buildOpenCodeMcp(servers);
  const env: Record<string, string> = {};

  for (const server of servers) {
    const transport = server.transport;
    const config = mcp[server.name];
    if (!config) continue;

    if (transport.type === "stdio" && config.type === "local") {
      if (Object.keys(transport.env).length === 0) continue;
      config.environment = Object.fromEntries(
        Object.entries(transport.env).map(([key, value]) => {
          const envVar = openCodeMcpEnvVar(server, "ENV", key);
          env[envVar] = value;
          return [key, `{env:${envVar}}`];
        }),
      );
      continue;
    }

    if (transport.type !== "stdio" && config.type === "remote") {
      if (Object.keys(transport.headers).length === 0) continue;
      config.headers = Object.fromEntries(
        Object.entries(transport.headers).map(([key, value]) => {
          const envVar = openCodeMcpEnvVar(server, "HEADER", key);
          env[envVar] = value;
          return [key, `{env:${envVar}}`];
        }),
      );
    }
  }

  const browserExclusive = hasYSpaceBrowserMcp(servers);
  const browserPolicy = browserExclusive ? buildOpenCodeBrowserExclusiveConfig() : undefined;
  return {
    configContent: JSON.stringify({
      ...(browserPolicy ?? {}),
      mcp: {
        ...mcp,
        ...((browserPolicy?.mcp as Record<string, unknown> | undefined) ?? {}),
        ...(browserExclusive
          ? Object.fromEntries(resolvedBrowserMcpNames.map((name) => [name, { enabled: false }]))
          : {}),
      },
    }),
    env,
  };
}

export interface AcpNamedValue {
  name: string;
  value: string;
}

export type AcpMcpServerConfig =
  | { name: string; command: string; args: string[]; env: AcpNamedValue[] }
  | { type: "http" | "sse"; name: string; url: string; headers: AcpNamedValue[] };

export interface AcpMcpCapabilities {
  http?: boolean;
  sse?: boolean;
}

/**
 * Effective MCP transport support for an ACP agent.
 *
 * `advertised` is what the agent returned in `initialize`. `assumed` is what
 * the adapter knows the agent actually supports; it only applies when the
 * agent advertises no `mcpCapabilities` at all, so an agent that explicitly
 * states its transports is always taken at its word.
 */
export function resolveAcpMcpCapabilities(
  advertised: AcpMcpCapabilities | undefined,
  assumed: AcpMcpCapabilities | undefined,
): AcpMcpCapabilities | undefined {
  return advertised ?? assumed;
}

export function gateAcpMcpServers<T extends object>(
  servers: T[],
  capabilities: AcpMcpCapabilities | undefined,
): T[] {
  return servers.filter((server) => {
    if (!("type" in server)) return true;
    if (server.type === "http") return capabilities?.http === true;
    if (server.type === "sse") return capabilities?.sse === true;
    return true;
  });
}

function toNamedValues(record: Record<string, string>): AcpNamedValue[] {
  return Object.entries(record).map(([name, value]) => ({ name, value }));
}

export function buildAcpMcpServers(servers: readonly ResolvedMcpServer[]): AcpMcpServerConfig[] {
  return servers.map((server) => {
    const transport = server.transport;
    if (transport.type === "stdio") {
      return {
        name: server.name,
        command: transport.command,
        args: transport.args,
        env: toNamedValues(transport.env),
      };
    }
    return {
      type: transport.type,
      name: server.name,
      url: transport.url,
      headers: toNamedValues(transport.headers),
    };
  });
}

function envTokenSegment(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

function envIdentityHash(...values: string[]): string {
  return createHash("sha256")
    .update(JSON.stringify(values))
    .digest("hex")
    .slice(0, 16)
    .toUpperCase();
}

function envLabel(value: string, fallback: string): string {
  return (envTokenSegment(value) || fallback).slice(0, 32);
}

function codexMcpEnvPrefix(server: Pick<ResolvedMcpServer, "id" | "name">): string {
  return `PORACODE_MCP_${envLabel(server.name, "SERVER")}_${envIdentityHash(server.name, server.id)}`;
}

export function codexMcpTokenEnvVar(server: Pick<ResolvedMcpServer, "id" | "name">): string {
  return `${codexMcpEnvPrefix(server)}_TOKEN`;
}

function codexMcpHeaderEnvVar(
  server: Pick<ResolvedMcpServer, "id" | "name">,
  headerName: string,
): string {
  return `${codexMcpEnvPrefix(server)}_HEADER_${envLabel(headerName, "VALUE")}_${envIdentityHash(headerName)}`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlKeySegment(value: string): string {
  return /^[A-Za-z0-9_-]+$/u.test(value) ? value : tomlString(value);
}

/**
 * Codex app-server config overrides do not accept quoted/dotted MCP table
 * segments even though the CLI TOML parser does. Keep the provider-visible
 * namespace readable and add a stable suffix only when normalization is needed.
 */
export function codexMcpServerName(server: Pick<ResolvedMcpServer, "id" | "name">): string {
  const normalized = server.name.replace(/[^A-Za-z0-9_-]/gu, "_").replace(/^_+|_+$/gu, "");
  if (normalized === server.name) return normalized;
  return `${normalized || "server"}_${envIdentityHash(server.name, server.id).slice(0, 8).toLowerCase()}`;
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function tomlInlineTable(record: Record<string, string>): string {
  return `{ ${Object.entries(record)
    .map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`)
    .join(", ")} }`;
}

function bearerToken(headers: Record<string, string>): string | undefined {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "authorization") continue;
    return /^Bearer\s+(.+)$/iu.exec(value.trim())?.[1];
  }
  return undefined;
}

export interface CodexMcp {
  args: string[];
  env: Record<string, string>;
  config: Record<string, unknown>;
}

export function buildCodexMcp(servers: readonly ResolvedMcpServer[]): CodexMcp {
  const args: string[] = [];
  const env: Record<string, string> = {};
  const config: Record<string, unknown> = {};

  for (const server of servers) {
    const transport = server.transport;
    const key = `mcp_servers.${tomlKeySegment(codexMcpServerName(server))}`;
    const serverConfig: Record<string, unknown> = {};
    if (transport.type === "stdio") {
      args.push("-c", `${key}.command=${tomlString(transport.command)}`);
      serverConfig.command = transport.command;
      if (transport.args.length > 0) {
        args.push("-c", `${key}.args=${tomlStringArray(transport.args)}`);
        serverConfig.args = transport.args;
      }
      if (Object.keys(transport.env).length > 0) {
        const envVars = Object.keys(transport.env);
        for (const [envName, envValue] of Object.entries(transport.env)) {
          const existingValue = env[envName];
          if (existingValue !== undefined && existingValue !== envValue) {
            throw new Error(
              `Codex MCP servers require different values for environment variable ${envName}; refusing to expose either value through launch arguments.`,
            );
          }
          env[envName] = envValue;
        }
        // Codex's stdio `env_vars` setting forwards named variables from the
        // provider process to this MCP child. Values remain launch-scoped in
        // the provider environment instead of being serialized into `-c`
        // arguments or structured thread config.
        args.push("-c", `${key}.env_vars=${tomlStringArray(envVars)}`);
        serverConfig.env_vars = envVars;
      }
      if (transport.cwd) {
        args.push("-c", `${key}.cwd=${tomlString(transport.cwd)}`);
        serverConfig.cwd = transport.cwd;
      }
    } else {
      args.push("-c", `${key}.url=${tomlString(transport.url)}`);
      serverConfig.url = transport.url;
      const token = bearerToken(transport.headers);
      const envHeaders: Record<string, string> = {};
      for (const [headerName, headerValue] of Object.entries(transport.headers)) {
        if (headerName.toLowerCase() === "authorization" && token) continue;
        const envVar = codexMcpHeaderEnvVar(server, headerName);
        envHeaders[headerName] = envVar;
        env[envVar] = headerValue;
      }
      if (Object.keys(envHeaders).length > 0) {
        args.push("-c", `${key}.env_http_headers=${tomlInlineTable(envHeaders)}`);
        serverConfig.env_http_headers = envHeaders;
      }
      if (token) {
        const envVar = codexMcpTokenEnvVar(server);
        args.push("-c", `${key}.bearer_token_env_var=${tomlString(envVar)}`);
        serverConfig.bearer_token_env_var = envVar;
        env[envVar] = token;
      }
    }
    args.push("-c", `${key}.enabled=true`);
    serverConfig.enabled = true;
    if (server.id === "browser") {
      // Codex 0.150+ defers MCP tools whenever the model advertises tool
      // search. Some Responses Lite models (notably gpt-5.6-sol) can then omit
      // tool_search itself, leaving a successfully initialized Browser MCP
      // unreachable to the model. The embedded Browser is Y Space's required,
      // default browser route, so fail the launch if it cannot initialize and
      // keep its tools on the model's initial/direct surface.
      args.push("-c", `${key}.required=true`);
      serverConfig.required = true;
      args.push("-c", `${key}.omit_tools_from=${tomlStringArray(["deferred"])}`);
      serverConfig.omit_tools_from = ["deferred"];
    }
    args.push("-c", `${key}.tool_timeout_sec=${Math.ceil(server.timeoutMs / 1000)}`);
    serverConfig.tool_timeout_sec = Math.ceil(server.timeoutMs / 1000);
    if (server.approvalMode) {
      args.push("-c", `${key}.default_tools_approval_mode=${tomlString(server.approvalMode)}`);
      serverConfig.default_tools_approval_mode = server.approvalMode;
    }
    config[key] = serverConfig;
  }

  return { args, env, config };
}
