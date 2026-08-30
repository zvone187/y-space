import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  mcpProbePayloadSchema,
  mcpProbeResultSchema,
  type McpProbeEnvironment,
  type McpProbePayload,
  type McpProbeResult,
  type McpServer,
  type ProjectLocation,
} from "@/shared/contracts";
import { terminateChildProcessTree } from "@/shared/processTree";
import { getWslCommand } from "../agents/base";
import { resolveNodeForDistro } from "../wsl/runtime";
import {
  buildVerifiedWslEsmArgv,
  deployFilesToWslTempBase,
  type WslBaseDeployResult,
  type WslDeployFile,
} from "../wsl/wslDeploy";
import { probeMcpServer, unavailableMcpProbeResult } from "./probeMcpServer";

const WORKER_OUTPUT_MAX_BYTES = 64 * 1024;

type WslLocation = Extract<ProjectLocation, { kind: "wsl" }>;
type HostProbe = (
  server: McpServer,
  environment: McpProbeEnvironment,
  signal: AbortSignal,
) => Promise<McpProbeResult>;
type WslProbe = (
  server: McpServer,
  location: WslLocation,
  environment: McpProbeEnvironment,
  signal: AbortSignal,
) => Promise<McpProbeResult>;

export interface WslProbeWorkerDependencies {
  workerSource?: string;
  resolveNode?: typeof resolveNodeForDistro;
  deploy?: (
    distro: string,
    baseName: string,
    files: readonly WslDeployFile[],
  ) => WslBaseDeployResult | null;
  spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  terminateChild?: (child: ChildProcess) => void;
  getWslCommand?: () => string;
}

export interface McpProbeServiceOptions {
  probeHost?: HostProbe;
  probeWsl?: WslProbe;
  /**
   * Optional: attaches a stored OAuth `Authorization` header to HTTP/SSE
   * servers before probing, so an authenticated server probes as available.
   */
  applyAuthorization?: (server: McpServer) => Promise<McpServer>;
}

function applyProjectCwd(server: McpServer, location: ProjectLocation | undefined): McpServer {
  if (!location || server.transport.type !== "stdio" || server.transport.cwd) return server;
  const cwd = location.kind === "wsl" ? location.linuxPath : location.path;
  return { ...server, transport: { ...server.transport, cwd } };
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

export async function runWslProbeWorker(
  server: McpServer,
  location: WslLocation,
  environment: McpProbeEnvironment,
  signal: AbortSignal,
  dependencies: WslProbeWorkerDependencies = {},
): Promise<McpProbeResult> {
  const workerSource = dependencies.workerSource ?? bundledWorkerPath();
  if (!existsSync(workerSource)) {
    return unavailableMcpProbeResult("probe-unavailable", environment);
  }
  let workerContent: Buffer;
  try {
    // Read through Electron's ASAR layer before crossing the WSL trust boundary.
    workerContent = readFileSync(workerSource);
  } catch {
    return unavailableMcpProbeResult("probe-unavailable", environment);
  }

  const resolvedNode = await Promise.race([
    (dependencies.resolveNode ?? resolveNodeForDistro)(location.distro),
    abortPromise(signal),
  ]);
  if (signal.aborted) throw signal.reason;

  const deploy = dependencies.deploy ?? deployFilesToWslTempBase;
  const deployed = deploy(location.distro, `poracode-mcp-probe-${process.pid}`, [
    { content: workerContent, relDest: "mcp-probe/mcp-probe.mjs" },
  ]);
  if (!deployed) return unavailableMcpProbeResult("probe-unavailable", environment);
  if (signal.aborted) {
    deployed.cleanup();
    throw signal.reason;
  }
  const workerPath = `${deployed.linuxBaseDir}/mcp-probe/mcp-probe.mjs`;

  return new Promise<McpProbeResult>((resolve) => {
    let child: ChildProcess | undefined;
    let output = "";
    let settled = false;
    let deploymentCleaned = false;
    const cleanupDeployment = (): void => {
      if (deploymentCleaned) return;
      deploymentCleaned = true;
      try {
        deployed.cleanup();
      } catch {
        // Deployment cleanup is best effort and must not mask probe results.
      }
    };
    const finish = (result: McpProbeResult): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = (): void => {
      if (child) (dependencies.terminateChild ?? terminateChildProcessTree)(child);
      else cleanupDeployment();
      finish(unavailableMcpProbeResult("timeout", environment, "Connection timed out."));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      const spawnProcess = dependencies.spawn ?? spawn;
      child = spawnProcess(
        (dependencies.getWslCommand ?? getWslCommand)(),
        [
          "-d",
          location.distro,
          "--cd",
          location.linuxPath,
          "--",
          resolvedNode.nodePath,
          ...buildVerifiedWslEsmArgv(workerPath, workerContent),
        ],
        {
          stdio: ["pipe", "pipe", "ignore"],
          windowsHide: true,
        },
      );
    } catch {
      cleanupDeployment();
      finish(unavailableMcpProbeResult("probe-unavailable", environment));
      return;
    }

    // `close` runs only after the process and its stdio are finished. Keep the
    // authenticated helper in place until then, including timeout/kill paths.
    child.once("close", cleanupDeployment);
    child.on("error", () => finish(unavailableMcpProbeResult("probe-unavailable", environment)));
    child.stdin?.on("error", () => {
      if (child) (dependencies.terminateChild ?? terminateChildProcessTree)(child);
      finish(unavailableMcpProbeResult("probe-unavailable", environment));
    });
    child.stdout?.on("error", () => {
      if (child) (dependencies.terminateChild ?? terminateChildProcessTree)(child);
      finish(unavailableMcpProbeResult("probe-unavailable", environment));
    });
    child.stdout?.on("data", (chunk: Buffer | string) => {
      output += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (Buffer.byteLength(output, "utf8") > WORKER_OUTPUT_MAX_BYTES && child) {
        (dependencies.terminateChild ?? terminateChildProcessTree)(child);
        finish(unavailableMcpProbeResult("protocol-error", environment));
      }
    });
    child.on("close", () => {
      if (settled) return;
      try {
        const result = mcpProbeResultSchema.parse(JSON.parse(output));
        finish({ ...result, environment });
      } catch {
        finish(unavailableMcpProbeResult("probe-unavailable", environment));
      }
    });

    child.stdin?.end(JSON.stringify({ server, environment }));
  });
}

function moduleDirectory(): string {
  return typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
}

function bundledWorkerPath(): string {
  return join(moduleDirectory(), "mcpProbeWorker.mjs");
}

export class McpProbeService {
  private readonly probeHost: HostProbe;
  private readonly probeWsl: WslProbe;
  private readonly applyAuthorization: ((server: McpServer) => Promise<McpServer>) | undefined;
  private readonly active = new Set<AbortController>();

  constructor(options: McpProbeServiceOptions = {}) {
    this.probeHost = options.probeHost ?? probeMcpServer;
    this.probeWsl = options.probeWsl ?? runWslProbeWorker;
    this.applyAuthorization = options.applyAuthorization;
  }

  async probe(input: McpProbePayload): Promise<McpProbeResult> {
    const payload = mcpProbePayloadSchema.parse(input);
    const environment: McpProbeEnvironment = {
      runtime: payload.projectLocation?.kind === "wsl" ? "wsl" : "host",
      projectScoped: payload.projectLocation !== undefined,
    };
    let server = applyProjectCwd(payload.server, payload.projectLocation);
    if (this.applyAuthorization) {
      server = await this.applyAuthorization(server).catch(() => server);
    }
    const controller = new AbortController();
    this.active.add(controller);
    const timeout =
      payload.projectLocation?.kind === "wsl"
        ? setTimeout(
            () => controller.abort(new DOMException("The operation timed out", "TimeoutError")),
            server.timeoutMs,
          )
        : undefined;
    timeout?.unref?.();

    try {
      if (payload.projectLocation?.kind === "wsl") {
        return await this.probeWsl(server, payload.projectLocation, environment, controller.signal);
      }
      return await this.probeHost(server, environment, controller.signal);
    } catch {
      return controller.signal.aborted
        ? unavailableMcpProbeResult("timeout", environment, "Connection timed out.")
        : unavailableMcpProbeResult("probe-unavailable", environment);
    } finally {
      if (timeout) clearTimeout(timeout);
      this.active.delete(controller);
    }
  }

  dispose(): void {
    for (const controller of this.active) controller.abort();
    this.active.clear();
  }
}
