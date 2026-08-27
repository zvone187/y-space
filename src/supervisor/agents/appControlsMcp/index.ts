import type { ProjectLocation } from "@/shared/contracts";
import type { McpThreadIdentity } from "@/shared/browserMcpThread";
import { createMcpLaunchContextToken } from "@/shared/mcpLaunchContext";
import { readPrivilegedMcpEnvironment } from "@/supervisor/privilegedMcpEnvironment";
import type { WslHostAccessResolver } from "@/supervisor/wsl/hostAccess";

export type AppControlsMcpLocation =
  | ProjectLocation
  | { kind: "windows" }
  | { kind: "posix" }
  | { kind: "wsl"; distro: string };

export interface AppControlsMcpHttpConfig {
  url: string;
  token: string;
  headers: Record<string, string>;
}

export const APP_CONTROLS_MCP_URL_ENV = "PORACODE_APP_CONTROLS_MCP_URL";
export const APP_CONTROLS_MCP_TOKEN_ENV = "PORACODE_APP_CONTROLS_MCP_TOKEN";

export function resolveAppControlsMcpHttpConfig(
  location: AppControlsMcpLocation,
  identity: McpThreadIdentity,
): AppControlsMcpHttpConfig | null {
  const env = readPrivilegedMcpEnvironment("app-controls");
  if (!env || location.kind === "wsl") return null;
  return createConfig(
    `${env.url.replace(/\/$/u, "")}/mcp`,
    createMcpLaunchContextToken(env.token, "app-controls", identity),
  );
}

export async function resolveAppControlsMcpHttpConfigForLaunch(
  location: AppControlsMcpLocation,
  hostAccess: WslHostAccessResolver | undefined,
  identity?: McpThreadIdentity,
): Promise<AppControlsMcpHttpConfig | undefined> {
  if (!identity?.threadId) return undefined;
  if (location.kind !== "wsl") {
    return resolveAppControlsMcpHttpConfig(location, identity) ?? undefined;
  }
  const env = readPrivilegedMcpEnvironment("app-controls");
  if (!env || !hostAccess) return undefined;
  const access = await hostAccess.resolveHostAccess(location.distro);
  if (!access) return undefined;
  const nativeUrl = `${env.url.replace(/\/$/u, "")}/mcp`;
  const launchToken = createMcpLaunchContextToken(env.token, "app-controls", identity);
  if (access.kind === "loopback") return createConfig(nativeUrl, launchToken);
  const parsed = new URL(nativeUrl);
  parsed.hostname = access.ip;
  return createConfig(parsed.toString(), launchToken);
}

function createConfig(url: string, token: string): AppControlsMcpHttpConfig {
  return { url, token, headers: { Authorization: `Bearer ${token}` } };
}
