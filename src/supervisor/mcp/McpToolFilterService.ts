import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { McpServer, ProjectLocation } from "@/shared/contracts";
import { resolveNodeForDistro } from "../wsl/runtime";
import { deployFilesToWslTempBase, resolveWslHelpersDir } from "../wsl/wslDeploy";

const CONFIG_ENV_PREFIX = "PORACODE_MCP_FILTER_CONFIG_";

function filterConfig(server: McpServer, browserExclusive: boolean): string {
  return Buffer.from(
    JSON.stringify({ server, disabledTools: server.disabledTools ?? [], browserExclusive }),
    "utf8",
  ).toString("base64url");
}

function filterConfigEnvName(encodedConfig: string): string {
  return `${CONFIG_ENV_PREFIX}${createHash("sha256").update(encodedConfig).digest("hex").slice(0, 24).toUpperCase()}`;
}

export async function prepareMcpToolFilters(
  servers: readonly McpServer[],
  location: ProjectLocation,
  browserExclusive = false,
): Promise<McpServer[]> {
  if (servers.length === 0) return [];
  if (!browserExclusive && !servers.some((server) => (server.disabledTools?.length ?? 0) > 0)) {
    return [...servers];
  }

  const helpersDir = resolveWslHelpersDir();
  const workerSource = helpersDir ? join(helpersDir, "mcp-filter.mjs") : "";
  if (!workerSource || !existsSync(workerSource)) {
    throw new Error("Y Space MCP tool filter is unavailable.");
  }

  let command = process.execPath;
  let workerPath = workerSource;
  const baseEnv = process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {};
  if (location.kind === "wsl") {
    const node = await resolveNodeForDistro(location.distro);
    const deployed = deployFilesToWslTempBase(
      location.distro,
      `poracode-mcp-filter-${process.pid}`,
      [{ src: workerSource, relDest: "mcp-filter/mcp-filter.mjs" }],
    );
    if (!deployed) throw new Error("Y Space MCP tool filter could not be deployed to WSL.");
    command = node.nodePath;
    workerPath = `${deployed.linuxBaseDir}/mcp-filter/mcp-filter.mjs`;
  }

  return servers.map((server) => {
    if (!browserExclusive && (server.disabledTools?.length ?? 0) === 0) return server;
    const encodedConfig = filterConfig(server, browserExclusive);
    const configEnvName = filterConfigEnvName(encodedConfig);
    return {
      ...server,
      transport: {
        type: "stdio",
        command,
        args: [workerPath, configEnvName],
        env: { ...baseEnv, [configEnvName]: encodedConfig },
        ...(location.kind === "wsl" ? { cwd: location.linuxPath } : { cwd: location.path }),
      },
    };
  });
}
