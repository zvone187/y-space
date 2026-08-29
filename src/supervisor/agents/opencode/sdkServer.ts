import { spawn, type ChildProcess } from "node:child_process";
import { terminateChildProcessTree } from "@/shared/processTree";
import { ExpectedStructuredRuntimeError, type CommandSpec } from "../base";
import { classifyOpenCodeError } from "./opencodeErrors";
import { sanitizeChildProcessEnv } from "@/supervisor/runtime/threadSession/spawnDiagnostics";

const URL_LINE_PREFIX = "opencode server listening";
const URL_REGEX = /on\s+(https?:\/\/[^\s]+)/;
const READY_TIMEOUT_MS = 15_000;
const POSIX_TERM_GRACE_MS = 1_000;

/** Environmental/provider readiness failure, distinct from runtime defects. */
export class OpenCodeReadinessTimeoutError extends ExpectedStructuredRuntimeError {
  override readonly name = "OpenCodeReadinessTimeoutError";
}

const activeServerChildren = new Set<ChildProcess>();
const reapedServerChildren = new WeakSet<ChildProcess>();
let processExitCleanupRegistered = false;

export interface OpenCodeServerHandle {
  readonly child: ChildProcess;
  readonly baseUrl: Promise<string>;
  /** Captured stdout/stderr buffer for error diagnostics. */
  readonly formatOutput: () => string;
  dispose(): Promise<void>;
}

interface PendingResolve {
  resolve(url: string): void;
  reject(err: Error): void;
}

function reapOpenCodeServerProcessGroupOnce(
  child: ChildProcess,
  options: { fallbackToLeader?: boolean } = {},
): void {
  if (process.platform === "win32" || typeof child.pid !== "number") return;
  if (reapedServerChildren.has(child)) return;
  reapedServerChildren.add(child);
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    if (!options.fallbackToLeader) return;
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

function terminateOpenCodeServerChildNow(child: ChildProcess): void {
  if (process.platform === "win32") {
    if (child.exitCode !== null || child.killed) return;
    terminateChildProcessTree(child);
    return;
  }

  // The leader may already be gone while descendants still retain its pgid.
  reapOpenCodeServerProcessGroupOnce(child, { fallbackToLeader: true });
}

/**
 * A detached POSIX process group can outlive its `opencode serve` leader. Reap
 * that group from the leader's exit callback while its original pgid is still
 * authoritative; a later dispose cannot safely recover descendants by pid.
 */
function reapExitedOpenCodeServerProcessGroup(child: ChildProcess): void {
  reapOpenCodeServerProcessGroupOnce(child);
}

/** Terminate only `opencode serve` children spawned through {@link spawnOpenCodeServer}. */
export function disposeSpawnedOpenCodeServerHandles(): void {
  for (const child of activeServerChildren) {
    terminateOpenCodeServerChildNow(child);
  }
  activeServerChildren.clear();
}

function registerProcessExitCleanup(): void {
  if (processExitCleanupRegistered) return;
  processExitCleanupRegistered = true;
  process.once("exit", disposeSpawnedOpenCodeServerHandles);
}

export function spawnOpenCodeServer(commandSpec: CommandSpec): OpenCodeServerHandle {
  registerProcessExitCleanup();
  const isWin = process.platform === "win32";
  let launchCleanupCalled = false;
  const cleanupLaunch = (): void => {
    if (launchCleanupCalled) return;
    launchCleanupCalled = true;
    commandSpec.cleanup?.();
  };
  let child: ChildProcess;
  try {
    child = spawn(commandSpec.command, commandSpec.args, {
      cwd: commandSpec.cwd,
      env: sanitizeChildProcessEnv({ ...process.env, ...commandSpec.env }),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      // POSIX: own process group so dispose() can `kill(-pid, ...)` to take
      // the whole tree down (opencode forks subprocesses for tools).
      // Windows has no process groups; taskkill /T handles the tree.
      detached: !isWin,
    });
  } catch (error) {
    cleanupLaunch();
    throw error;
  }
  activeServerChildren.add(child);

  let stdoutBuf = "";
  let stderrBuf = "";
  let baseUrl: string | undefined;
  let pending: PendingResolve | undefined;

  const baseUrlPromise = new Promise<string>((resolve, reject) => {
    pending = { resolve, reject };
  });

  // Spawn-error and early-exit guards (mirrors Codex acp.ts:327-336).
  child.once("error", (err) => {
    cleanupLaunch();
    activeServerChildren.delete(child);
    pending?.reject(
      new Error(classifyOpenCodeError({ cause: err, operation: "spawn opencode serve" })),
    );
  });
  child.once("exit", (code, signal) => {
    reapExitedOpenCodeServerProcessGroup(child);
    cleanupLaunch();
    activeServerChildren.delete(child);
    if (!baseUrl) {
      const detail = formatOutput();
      const exitMessage = `opencode serve exited before ready (code=${code} signal=${signal}).${detail}`;
      // Run the captured stdout/stderr through the classifier too — a binary
      // that bails out on macOS quarantine, ENOENT, or a missing libc usually
      // prints something useful before exit, and we want the user-facing
      // message to reflect that instead of a bare exit code.
      pending?.reject(
        new Error(
          classifyOpenCodeError({
            cause: new Error(`${exitMessage}\n${detail}`),
            operation: "opencode serve",
          }),
        ),
      );
    }
  });

  const readyTimeout = setTimeout(() => {
    if (!baseUrl) {
      pending?.reject(
        new OpenCodeReadinessTimeoutError(
          classifyOpenCodeError({
            cause: new Error(`opencode serve did not emit ready URL within ${READY_TIMEOUT_MS}ms`),
            operation: "opencode serve",
          }),
        ),
      );
    }
  }, READY_TIMEOUT_MS);
  // Don't keep the event loop alive on this timer.
  if (typeof readyTimeout.unref === "function") readyTimeout.unref();

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdoutBuf += chunk;
    if (baseUrl) return;
    // Scan complete lines for the ready marker.
    const lines = stdoutBuf.split("\n");
    for (const raw of lines) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (!line.startsWith(URL_LINE_PREFIX)) continue;
      const m = line.match(URL_REGEX);
      if (m && m[1]) {
        baseUrl = m[1];
        clearTimeout(readyTimeout);
        pending?.resolve(baseUrl);
        return;
      }
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    // OpenCode emits structured `INFO ...` lines on stderr when run with
    // --print-logs; treat as diagnostic output, not errors.
    stderrBuf += chunk;
    // Keep the buffer bounded to avoid unbounded growth.
    if (stderrBuf.length > 64_000) {
      stderrBuf = stderrBuf.slice(-32_000);
    }
  });

  function formatOutput(): string {
    const out = stdoutBuf.trim();
    const err = stderrBuf.trim();
    const parts: string[] = [];
    if (out) parts.push(`\n--- opencode stdout ---\n${out}`);
    if (err) parts.push(`\n--- opencode stderr ---\n${err}`);
    return parts.join("");
  }

  let disposed = false;
  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    clearTimeout(readyTimeout);
    if (child.exitCode !== null || child.killed) return;

    if (isWin) {
      // taskkill /T /F walks the descendant tree. Cleanest available signal
      // on Windows; no graceful equivalent exists for our use case.
      terminateChildProcessTree(child);
      return;
    }

    // POSIX: SIGTERM the process group, wait briefly, then SIGKILL.
    const pid = child.pid;
    if (typeof pid !== "number") return;
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // Group may be gone; fall back to single-process kill.
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        return;
      }
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, POSIX_TERM_GRACE_MS);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (child.exitCode !== null) return;
    reapOpenCodeServerProcessGroupOnce(child, { fallbackToLeader: true });
  }

  return {
    child,
    baseUrl: baseUrlPromise,
    formatOutput,
    dispose,
  };
}
