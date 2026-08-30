import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer, ProjectLocation } from "@/shared/contracts";
import { resolveNodeForDistro } from "../wsl/runtime";
import {
  buildVerifiedWslEsmArgv,
  deployFilesToWslTempBase,
  type WslBaseDeployResult,
  type WslDeployFile,
} from "../wsl/wslDeploy";

const CONFIG_ENV_PREFIX = "PORACODE_MCP_FILTER_CONFIG_";
const MCP_TOOL_FILTER_CLEANUP = Symbol("poracode.mcpToolFilterCleanup");

type McpToolFilterCleanupCarrier = {
  [MCP_TOOL_FILTER_CLEANUP]?: () => void;
};

/** Combine temporary-deployment cleanup into one idempotent, best-effort lease. */
export function combineMcpToolFilterCleanups(
  ...cleanups: Array<(() => void) | undefined>
): (() => void) | undefined {
  const pending = [...new Set(cleanups.filter((cleanup) => cleanup !== undefined))];
  if (pending.length === 0) return undefined;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const cleanup of pending) {
      try {
        cleanup();
      } catch {
        // A failed best-effort removal must not strand the remaining deployments.
      }
    }
  };
}

/** Attach an ownership lease without exposing it to provider serialization. */
export function attachMcpToolFilterCleanup<T extends readonly unknown[]>(
  servers: T,
  cleanup: (() => void) | undefined,
): T {
  const combined = combineMcpToolFilterCleanups(getMcpToolFilterCleanup(servers), cleanup);
  if (!combined) return servers;
  Object.defineProperty(servers, MCP_TOOL_FILTER_CLEANUP, {
    configurable: true,
    value: combined,
  });
  return servers;
}

/** Read the lease carried by a prepared/resolved server collection. */
export function getMcpToolFilterCleanup(servers: readonly unknown[]): (() => void) | undefined {
  return (servers as McpToolFilterCleanupCarrier)[MCP_TOOL_FILTER_CLEANUP];
}

export interface McpToolFilterDependencies {
  resolveNode?: typeof resolveNodeForDistro;
  deploy?: (
    distro: string,
    baseName: string,
    files: readonly WslDeployFile[],
  ) => WslBaseDeployResult | null;
}

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
  dependencies: McpToolFilterDependencies = {},
): Promise<McpServer[]> {
  if (servers.length === 0) return [];
  if (!browserExclusive && !servers.some((server) => (server.disabledTools?.length ?? 0) > 0)) {
    return [...servers];
  }

  const workerSource = bundledWorkerPath();
  if (!existsSync(workerSource)) {
    throw new Error("Y Space MCP tool filter is unavailable.");
  }

  const baseEnv = process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {};
  let wslWorker: { nodePath: string; content: Buffer } | undefined;
  if (location.kind === "wsl") {
    const resolveNode = dependencies.resolveNode ?? resolveNodeForDistro;
    const node = await resolveNode(location.distro);
    let workerContent: Buffer;
    try {
      workerContent = readFileSync(workerSource);
    } catch {
      throw new Error("Y Space MCP tool filter is unavailable.");
    }
    wslWorker = { nodePath: node.nodePath, content: workerContent };
  }

  const unlaunchedCleanups: Array<() => void> = [];
  try {
    const prepared = servers.map((server) => {
      if (!browserExclusive && (server.disabledTools?.length ?? 0) === 0) return server;
      const encodedConfig = filterConfig(server, browserExclusive);
      const configEnvName = filterConfigEnvName(encodedConfig);
      let command = process.execPath;
      let args = [workerSource, configEnvName];
      if (location.kind === "wsl" && wslWorker) {
        const deploy = dependencies.deploy ?? deployFilesToWslTempBase;
        const deployed = deploy(location.distro, `poracode-mcp-filter-${process.pid}`, [
          { content: wslWorker.content, relDest: "mcp-filter/mcp-filter.mjs" },
        ]);
        if (!deployed) throw new Error("Y Space MCP tool filter could not be deployed to WSL.");
        unlaunchedCleanups.push(deployed.cleanup);
        command = wslWorker.nodePath;
        const workerPath = `${deployed.linuxBaseDir}/mcp-filter/mcp-filter.mjs`;
        args = buildVerifiedWslEsmArgv(workerPath, wslWorker.content, [
          configEnvName,
          deployed.linuxBaseDir,
        ]);
      }
      return {
        ...server,
        transport: {
          type: "stdio" as const,
          command,
          args,
          env: { ...baseEnv, [configEnvName]: encodedConfig },
          ...(location.kind === "wsl" ? { cwd: location.linuxPath } : { cwd: location.path }),
        },
      };
    });
    return attachMcpToolFilterCleanup(
      prepared,
      combineMcpToolFilterCleanups(...unlaunchedCleanups),
    );
  } catch (error) {
    combineMcpToolFilterCleanups(...unlaunchedCleanups)?.();
    throw error;
  }
}

function moduleDirectory(): string {
  return typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
}

function bundledWorkerPath(): string {
  const adjacent = join(moduleDirectory(), "mcpToolFilterWorker.mjs");
  if (existsSync(adjacent) || process.versions.electron) return adjacent;
  // Source-mode tests and the headless development command run after the
  // electron bundle has been built into the repository's dist directory.
  return join(process.cwd(), "dist", "main", "mcpToolFilterWorker.mjs");
}
