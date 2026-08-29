import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import type { ProjectLocation, ResolvedMcpServer } from "@/shared/contracts";
import { hasYSpaceBrowserMcp } from "@/shared/browserExclusivePolicy";
import { terminateChildProcessTree } from "@/shared/processTree";
import { resolveNodeForDistro } from "../../wsl/runtime";
import {
  batchWslCommandsAsync,
  quotePosixShellArg,
  type AgentEnvContext,
  type CreateStructuredSessionInput,
} from "../base";
import { buildCodexMcp } from "../userMcp";
import { buildCodexAppServerCommand } from "./argv";
import { CodexAppServerConnection } from "./appServerRpc";
import { buildCodexMcpSkillConflictArgs } from "./mcpSkillConflicts";
import {
  codexHooksFeatureFlagForSemver,
  installCodexPlugin,
  isCodexSemverSupportedForHooks,
  parseCodexVersionLine,
  probeCodexCliSemver,
} from "./plugin/install";
import { CodexStdioTransport } from "./stdioTransport";
import { sanitizeChildProcessEnv } from "@/supervisor/runtime/threadSession/spawnDiagnostics";

interface ServerSnapshot {
  appServer: ChildProcess;
  connection: CodexAppServerConnection;
  transport: CodexStdioTransport;
}

interface PoolEntry {
  ready: Promise<ServerSnapshot>;
  leases: number;
}

export interface AcquiredCodexAppServer {
  connection: CodexAppServerConnection;
  dispose(): void;
}

const THREAD_SCOPED_MCP_SERVER_IDS = new Set(["app-controls", "browser", "computer-use"]);
const pool = new Map<string, PoolEntry>();
const spawnedAppServers = new Set<ChildProcess>();
const spawnedConnections = new Set<CodexAppServerConnection>();
const reapedAppServers = new WeakSet<ChildProcess>();
const ownsPosixAppServerProcessGroup = process.platform !== "win32";

interface BrowserExclusiveHookLaunch {
  codexHomeDir: string;
  sqliteHomeDir: string;
  featureFlag: string;
}

function executionRuntimeKey(location: ProjectLocation): string {
  switch (location.kind) {
    case "windows":
      return "windows";
    case "wsl":
      return `wsl:${location.distro}`;
    case "posix":
      return "posix";
  }
}

function normalizedMcpServer(server: ResolvedMcpServer): ResolvedMcpServer {
  if (!THREAD_SCOPED_MCP_SERVER_IDS.has(server.id) || server.transport.type === "stdio") {
    return server;
  }
  const url = new URL(server.transport.url);
  url.searchParams.delete("thread");
  url.searchParams.delete("title");
  url.searchParams.delete("disable");
  // Keep headers in the fingerprint. Codex resolves MCP header env vars from
  // the app-server process environment, so a process cannot safely serve a
  // second thread whose signed launch credentials differ.
  return {
    ...server,
    transport: {
      ...server.transport,
      url: url.toString(),
    },
  };
}

function poolFingerprint(
  location: ProjectLocation,
  mcpServers: readonly ResolvedMcpServer[],
): string {
  const normalizedServers = mcpServers.map(normalizedMcpServer);
  const mcp = buildCodexMcp(normalizedServers);
  return createHash("sha256")
    .update(
      JSON.stringify({
        servers: normalizedServers,
        env: mcp.env,
        skillConflictArgs: buildCodexMcpSkillConflictArgs(location, normalizedServers),
      }),
    )
    .digest("hex");
}

export function codexAppServerPoolKey(
  location: ProjectLocation,
  mcpServers: readonly ResolvedMcpServer[],
  wslExecPath?: string,
  wslNodePath?: string,
): string {
  return [
    executionRuntimeKey(location),
    wslExecPath ?? "",
    wslNodePath ?? "",
    poolFingerprint(location, mcpServers),
  ].join("|");
}

function spawnAppServer(command: ReturnType<typeof buildCodexAppServerCommand>): ChildProcess {
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    command.cleanup?.();
  };
  try {
    const child = spawn(command.command, command.args, {
      cwd: command.cwd ?? process.cwd(),
      env: {
        ...sanitizeChildProcessEnv({ ...process.env, ...command.env }),
        TERM: "xterm-256color",
      },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      // Codex can leave tool and shell descendants alive after the app-server
      // exits. A dedicated POSIX process group lets every teardown path reap
      // the complete tree without touching the supervisor's own group.
      detached: ownsPosixAppServerProcessGroup,
    });
    child.once("error", cleanup);
    child.once("exit", cleanup);
    return child;
  } catch (error) {
    cleanup();
    throw error;
  }
}

function terminateAppServerProcessTree(appServer: ChildProcess): void {
  // dispose(), supervisor shutdown, and the child's exit callback can race.
  // One final tree reap is sufficient, and on POSIX it avoids signalling a
  // recycled process-group id after the first reap has already completed.
  if (reapedAppServers.has(appServer)) return;
  reapedAppServers.add(appServer);
  terminateChildProcessTree(appServer, {
    ownedProcessGroup: ownsPosixAppServerProcessGroup,
  });
}

function codexPluginEnvContext(location: ProjectLocation): AgentEnvContext {
  const baseDir = process.env.PORACODE_DATA_DIR?.trim();
  return location.kind === "wsl"
    ? {
        envKind: "wsl",
        wslDistro: location.distro,
        ...(baseDir ? { baseDir } : {}),
      }
    : {
        envKind: location.kind,
        ...(baseDir ? { baseDir } : {}),
      };
}

async function codexHooksFeatureFlag(
  location: ProjectLocation,
  executablePath: string | undefined,
): Promise<string> {
  let version: [number, number, number] | null;
  if (location.kind !== "wsl") {
    version = probeCodexCliSemver();
  } else {
    const command = `${quotePosixShellArg(executablePath ?? "codex")} --version`;
    const [result] = await batchWslCommandsAsync(location.distro, [command]);
    const versionLine = result?.ok
      ? result.stdout
          .split("\n")
          .map((line) => line.trim())
          .find(Boolean)
      : undefined;
    version = versionLine ? parseCodexVersionLine(versionLine) : null;
  }
  if (!isCodexSemverSupportedForHooks(version)) {
    throw new Error("Codex Browser policy hook requires codex-cli >= 0.122.0.");
  }
  return codexHooksFeatureFlagForSemver(version);
}

async function prepareBrowserExclusiveHook(
  input: CreateStructuredSessionInput,
  wslExecPath: string | undefined,
  wslNodePath: string | undefined,
): Promise<BrowserExclusiveHookLaunch | undefined> {
  if (!hasYSpaceBrowserMcp(input.mcpServers ?? [])) return undefined;
  const featureFlag = await codexHooksFeatureFlag(input.projectLocation, wslExecPath);
  const ctx = codexPluginEnvContext(input.projectLocation);
  const installed = await installCodexPlugin(ctx, {
    ...(wslNodePath ? { resolvedNodePath: wslNodePath } : {}),
  });
  if (!installed.ok) {
    throw new Error(`Codex Browser policy hook could not be staged: ${installed.reason}`);
  }
  return {
    codexHomeDir: installed.paths.codexHomeDir,
    sqliteHomeDir: installed.paths.sqliteHomeDir,
    featureFlag,
  };
}

async function spawnAndWire(
  input: CreateStructuredSessionInput,
  wslExecPath: string | undefined,
  wslNodePath: string | undefined,
  onExit: (appServer: ChildProcess, connection: CodexAppServerConnection) => void,
): Promise<ServerSnapshot> {
  const browserExclusiveHook = await prepareBrowserExclusiveHook(input, wslExecPath, wslNodePath);
  const appServer = spawnAppServer(
    buildCodexAppServerCommand(input.projectLocation, {
      ...(wslExecPath !== undefined ? { wslExecPath } : {}),
      ...(wslNodePath !== undefined ? { wslNodePath } : {}),
      ...(input.mcpServers !== undefined ? { mcpServers: input.mcpServers } : {}),
      ...(browserExclusiveHook ? { browserExclusiveHook } : {}),
      includeMcpConfig: false,
    }),
  );
  spawnedAppServers.add(appServer);
  const transport = new CodexStdioTransport(appServer);
  const connection = new CodexAppServerConnection(transport);
  spawnedConnections.add(connection);
  appServer.prependOnceListener("exit", () => {
    // The group can outlive its leader. Reap it while the original process
    // group id is still known, even when Codex itself exits unexpectedly.
    terminateAppServerProcessTree(appServer);
    onExit(appServer, connection);
  });

  const spawnError = await new Promise<Error | undefined>((resolve) => {
    appServer.once("error", (error) => resolve(error));
    setImmediate(() => resolve(undefined));
  });
  if (spawnError) {
    spawnedAppServers.delete(appServer);
    spawnedConnections.delete(connection);
    throw new Error(`Codex app-server failed to spawn: ${spawnError.message}`);
  }
  if (appServer.exitCode !== null) {
    spawnedAppServers.delete(appServer);
    spawnedConnections.delete(connection);
    throw new Error(`Codex app-server exited early.${transport.formatOutput()}`);
  }

  return { appServer, connection, transport };
}

export async function acquireCodexAppServer(
  input: CreateStructuredSessionInput,
  wslExecPath?: string,
): Promise<AcquiredCodexAppServer> {
  const wslNodePath =
    input.projectLocation.kind === "wsl"
      ? (await resolveNodeForDistro(input.projectLocation.distro)).nodePath
      : undefined;
  const mcpServers = input.mcpServers ?? [];
  const key = codexAppServerPoolKey(input.projectLocation, mcpServers, wslExecPath, wslNodePath);
  let entry = pool.get(key);
  if (!entry) {
    const ready = spawnAndWire(input, wslExecPath, wslNodePath, (appServer, connection) => {
      spawnedAppServers.delete(appServer);
      spawnedConnections.delete(connection);
      if (pool.get(key) === entry) pool.delete(key);
    });
    entry = { ready, leases: 0 };
    pool.set(key, entry);
    ready.catch(() => {
      if (pool.get(key) === entry) pool.delete(key);
    });
  }

  entry.leases += 1;
  let snapshot: ServerSnapshot;
  try {
    snapshot = await entry.ready;
  } catch (error) {
    entry.leases -= 1;
    throw error;
  }
  let released = false;
  return {
    connection: snapshot.connection,
    dispose: () => {
      if (released) return;
      released = true;
      entry.leases -= 1;
      if (entry.leases > 0) return;

      if (pool.get(key) === entry) pool.delete(key);
      spawnedConnections.delete(snapshot.connection);
      spawnedAppServers.delete(snapshot.appServer);
      snapshot.connection.dispose(new Error("Last Codex app-server pool lease released."));
      terminateAppServerProcessTree(snapshot.appServer);
    },
  };
}

export function shutdownSpawnedCodexAppServers(): void {
  pool.clear();
  const error = new Error("Codex app-server pool disposed.");
  for (const connection of spawnedConnections) {
    connection.dispose(error);
  }
  spawnedConnections.clear();
  for (const appServer of spawnedAppServers) {
    terminateAppServerProcessTree(appServer);
  }
  spawnedAppServers.clear();
}
