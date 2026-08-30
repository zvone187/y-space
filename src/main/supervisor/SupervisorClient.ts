import { fork, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import type { PoracodeDiagnosticTags } from "@/shared/diagnostics/sentryPrivacy";
import { terminateChildProcessTree } from "@/shared/processTree";
import {
  pipedreamSnapshotSchema,
  type PipedreamSnapshot,
  type StartThreadPayload,
} from "@/shared/contracts";
import type {
  IpcProcedurePayload,
  IpcProcedureResult,
  SupervisorEvent,
  SupervisorProcedureName,
  SupervisorReply,
  SupervisorRequest,
} from "@/shared/ipc";
import { PIPEDREAM_DEPRECATED_EXEC_ENV_KEYS } from "@/shared/pipedreamBootstrap";
import { sanitizePrivilegedChildEnvironment } from "@/supervisor/privilegedChildEnvironment";
import type {
  PipedreamPrivilegedBootstrapPayload,
  PipedreamPrivilegedConnectLinkResult,
  PipedreamPrivilegedReply,
} from "@/shared/pipedreamPrivilegedIpc";
import {
  isPipedreamPrivilegedBootstrapMessage,
  isPipedreamPrivilegedConnectLinkRequest,
} from "@/shared/pipedreamPrivilegedIpc";
import {
  isSupervisorSecretBootstrapFailure,
  isSupervisorSecretBootstrapAck,
  isSupervisorSecretBootstrapMessage,
  SUPERVISOR_BOOTSTRAP_FAILURE_CODE,
  SUPERVISOR_SECRET_BOOTSTRAP_PROTOCOL_VERSION,
  type SupervisorBootstrapFailureCode,
  type SupervisorSecretBootstrapReply,
} from "@/shared/supervisorSecretBootstrap";

function isSupervisorReply(
  message: unknown,
): message is SupervisorReply | PipedreamPrivilegedReply | SupervisorSecretBootstrapReply {
  return (
    typeof message === "object" &&
    message !== null &&
    "replyTo" in message &&
    "ok" in message &&
    typeof message.ok === "boolean"
  );
}

/**
 * Backstop timeout for a single request/reply RPC. This is intentionally
 * generous — some procedures legitimately run for minutes (downloading or
 * installing agent binaries on a slow connection, large `git` operations).
 * It exists only to guarantee that a request can never hang *forever* if the
 * supervisor is alive but its handler deadlocks or never sends a reply; the
 * common connection-loss case is already handled by the `exit`/EPIPE paths.
 */
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const STARTUP_TIMEOUT_MS = 30_000;

interface ChildReadiness {
  readonly child: ChildProcess;
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

function createChildReadiness(child: ChildProcess): ChildReadiness {
  let settled = false;
  let resolvePromise!: () => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  // A startup failure can happen before any caller awaits readiness. Keep the
  // original promise rejectable for callers while preventing an unhandled
  // rejection in the no-caller case.
  void promise.catch(() => undefined);
  return {
    child,
    promise,
    resolve: () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    },
    reject: (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    },
  };
}

/**
 * Electron / Windows: a forked supervisor with stdio "inherit" often does
 * not surface `console.log` in the same dev terminal as the main process.
 * Pipe stdout/stderr and write through the parent's stdio so hook-debug and
 * other supervisor logs are visible next to `[db]` / main-process lines.
 */
function pipeSupervisorStreamsToParent(child: ChildProcess): void {
  const pipeTo = (stream: Readable | null | undefined, out: NodeJS.WriteStream): void => {
    if (!stream) return;
    stream.on("data", (chunk: string | Buffer) => {
      out.write(chunk);
    });
  };
  pipeTo(child.stdout, process.stdout);
  pipeTo(child.stderr, process.stderr);
}

export interface SupervisorClientOptions {
  appVersion: string;
  isDev: boolean;
  supervisorPath: string;
  /**
   * Directory containing the in-WSL helpers shipped with the app
   * (`bridge.mjs`). Forwarded to the supervisor via
   * `PORACODE_WSL_HELPERS_DIR` so the bridge server can stage assets
   * into running distros.
   */
  wslHelpersDir: string;
  /**
   * Directory containing the read-only skills shipped with the app
   * (`y-space-skill-creator`, …). Forwarded to the supervisor via
   * `PORACODE_BUNDLED_SKILLS_DIR` so the skills service can surface them.
   */
  bundledSkillsDir?: string;
  /**
   * Directory containing the Agent Plugins packages shipped with the app.
   * Forwarded as `PORACODE_BUNDLED_PLUGINS_DIR` so the plugin registry can
   * discover them.
   */
  bundledPluginsDir?: string;
  secretStorageKey: string;
  /** True only for the verified signed macOS release identity and real Keychain. */
  allowPipedreamOauthPersistence: boolean;
  /**
   * Optional resolver invoked at every supervisor spawn, returning extra env
   * vars to merge into the child env. Used by the in-app browser MCP wiring
   * to inject `PORACODE_BROWSER_MCP_*` per-launch.
   */
  resolveExtraEnv?: () => Record<string, string>;
  /** Secret-bearing bootstrap delivered over parent/child IPC, never child env or public bridge. */
  resolvePipedreamPrivilegedBootstrap?: () => PipedreamPrivilegedBootstrapPayload;
  /** Apply main-process launch invariants before any start reaches the supervisor. */
  prepareStartThread?(payload: StartThreadPayload): StartThreadPayload;
  assignPid?(pid: number): Promise<void>;
  reportError?(error: unknown, tags?: PoracodeDiagnosticTags): void;
  onEvent(event: SupervisorEvent): void;
  onReset(): void;
  /**
   * Native, user-confirmed recovery for a typed startup failure. Ordinary
   * crashes never enter this path, and the client remains blocked until the
   * callback explicitly returns `retry`.
   */
  recoverStartupFailure?(failureCode: SupervisorBootstrapFailureCode): Promise<"retry" | "stop">;
  /**
   * Invoked after every (re)spawn of the supervisor process — including
   * crash-restarts — once requests can be sent. Used to push state the
   * supervisor cannot recover on its own (e.g. persisted orchestrator
   * child-thread rows).
   */
  onStarted?(): void;
}

export class SupervisorClient {
  private child: ChildProcess | null = null;
  private baseDir: string | null = null;
  private disposed = false;
  private childReadiness: ChildReadiness | null = null;
  private startupBlocked = false;
  private readonly startedGate: Promise<void>;
  private resolveStartedGate!: () => void;
  private readonly pendingRequests = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason?: unknown) => void;
    }
  >();

  constructor(private readonly options: SupervisorClientOptions) {
    this.startedGate = new Promise<void>((resolve) => {
      this.resolveStartedGate = resolve;
    });
  }

  private rejectPendingRequests(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
  }

  private reset(error: Error): void {
    this.rejectPendingRequests(error);
    this.options.onReset();
  }

  start(baseDir: string): void {
    if (this.disposed || this.startupBlocked) return;
    this.baseDir = baseDir;
    this.resolveStartedGate();
    this.stop(new Error("Supervisor restarting"));

    const extraEnv = this.options.resolveExtraEnv?.() ?? {};
    const childEnv: NodeJS.ProcessEnv = {
      // Never inherit stale control-plane credentials. The main process adds
      // only its current, canonical MCP endpoints below.
      ...sanitizePrivilegedChildEnvironment(process.env),
      PORACODE_APP_VERSION: this.options.appVersion,
      PORACODE_IS_DEV: this.options.isDev ? "1" : "0",
      PORACODE_DATA_DIR: baseDir,
      PORACODE_WSL_HELPERS_DIR: this.options.wslHelpersDir,
      // Back-compat for one release; older supervisor builds still read
      // the legacy var. Safe to drop once min supported supervisor knows
      // about PORACODE_WSL_HELPERS_DIR.
      PORACODE_WSL_WATCHER_DIR: this.options.wslHelpersDir,
      ...(this.options.bundledSkillsDir
        ? { PORACODE_BUNDLED_SKILLS_DIR: this.options.bundledSkillsDir }
        : {}),
      ...(this.options.bundledPluginsDir
        ? { PORACODE_BUNDLED_PLUGINS_DIR: this.options.bundledPluginsDir }
        : {}),
      ...extraEnv,
    };
    const supervisorExecDeniedKeys = new Set(
      ["PORACODE_SECRET_STORAGE_KEY", ...PIPEDREAM_DEPRECATED_EXEC_ENV_KEYS].map((key) =>
        key.toUpperCase(),
      ),
    );
    for (const key of Object.keys(childEnv)) {
      if (supervisorExecDeniedKeys.has(key.toUpperCase())) delete childEnv[key];
    }
    const child = fork(this.options.supervisorPath, [], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: childEnv,
    });

    pipeSupervisorStreamsToParent(child);

    this.child = child;
    const readiness = createChildReadiness(child);
    this.childReadiness = readiness;
    if (typeof child.pid === "number") {
      void this.options.assignPid?.(child.pid).catch((error) => {
        console.error(
          "[poracode] failed to assign supervisor to Windows Job Object:",
          error instanceof Error ? error.message : String(error),
        );
        this.options.reportError?.(error, { "poracode.feature_area": "supervisor" });
      });
    }

    child.on("message", (message: unknown) => {
      if (isSupervisorReply(message)) {
        const pending = this.pendingRequests.get(message.replyTo);
        if (!pending) {
          return;
        }
        this.pendingRequests.delete(message.replyTo);
        if (message.ok) {
          pending.resolve(message.data);
        } else {
          pending.reject(
            isSupervisorSecretBootstrapFailure(message)
              ? new SupervisorBootstrapFailureError(message.failureCode)
              : new Error(message.error),
          );
        }
        return;
      }

      this.options.onEvent(message as SupervisorEvent);
    });

    child.on("exit", (code) => {
      if (this.child !== child) {
        return;
      }
      const error = new Error("Supervisor exited");
      readiness.reject(error);
      if (this.childReadiness === readiness) this.childReadiness = null;
      this.child = null;
      this.reset(error);
      if (!this.disposed && code !== 0 && this.baseDir) {
        const exitError = new Error(`Supervisor exited with code ${code ?? "unknown"}`);
        console.error(`[poracode] ${exitError.message}, restarting…`);
        this.options.reportError?.(exitError, { "poracode.feature_area": "supervisor" });
        this.scheduleRestart();
      }
    });

    void this.initializeChild(child, readiness);
  }

  stop(error: Error): void {
    const child = this.child;
    const readiness = this.childReadiness;
    readiness?.reject(error);
    this.childReadiness = null;
    if (!child) {
      return;
    }
    this.child = null;
    this.reset(error);
    terminateChildProcessTree(child);
  }

  dispose(): void {
    this.disposed = true;
    this.resolveStartedGate();
    this.stop(new Error("Supervisor exited"));
  }

  async call<Name extends SupervisorProcedureName>(
    type: Name,
    payload: IpcProcedurePayload<Name>,
  ): Promise<IpcProcedureResult<Name>> {
    const child = await this.requireReadyChild();

    const id = randomUUID();
    const requestPayload =
      type === "startThread" && this.options.prepareStartThread
        ? this.options.prepareStartThread(payload as StartThreadPayload)
        : payload;
    const request: SupervisorRequest = {
      id,
      type,
      payload: requestPayload,
    } as SupervisorRequest;

    return new Promise<IpcProcedureResult<Name>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pendingRequests.delete(id)) {
          reject(new Error(`Supervisor request "${type}" timed out.`));
        }
      }, REQUEST_TIMEOUT_MS);
      // Avoid keeping the event loop (and the app) alive solely for this timer.
      timeout.unref?.();

      const settle = (settleFn: (value: unknown) => void, value: unknown): void => {
        clearTimeout(timeout);
        settleFn(value);
      };

      this.pendingRequests.set(id, {
        resolve: (value) => settle((v) => resolve(v as IpcProcedureResult<Name>), value),
        reject: (reason) => settle(reject as (value: unknown) => void, reason),
      });

      // On `child.send` failure the request will never get a reply, so we must
      // reject here — including the EPIPE case. The pending entry is already
      // removed from the map at that point, so the `exit` handler's
      // `rejectPendingRequests` can no longer reach it; returning silently
      // would orphan the caller's promise forever.
      const failSend = (error: unknown): void => {
        const pending = this.pendingRequests.get(id);
        if (!pending) {
          return;
        }
        this.pendingRequests.delete(id);
        pending.reject(error);
      };

      try {
        child.send(request, (error) => {
          if (error) {
            failSend(error);
          }
        });
      } catch (error) {
        failSend(error);
      }
    });
  }

  /** Internal-only RPC whose one-use Connect URL must never enter the public procedure map. */
  async createPipedreamConnectLink(
    appSlug: string,
    redirects: { readonly successRedirectUrl: string; readonly errorRedirectUrl: string },
  ): Promise<PipedreamPrivilegedConnectLinkResult> {
    const child = await this.requireReadyChild();
    const id = randomUUID();
    const message = {
      kind: "pipedream-privileged-request" as const,
      id,
      request: {
        type: "create-connect-link" as const,
        appSlug,
        successRedirectUrl: redirects.successRedirectUrl,
        errorRedirectUrl: redirects.errorRedirectUrl,
      },
    };
    if (!isPipedreamPrivilegedConnectLinkRequest(message)) {
      throw new Error("Pipedream Connect request is invalid.");
    }
    return new Promise<PipedreamPrivilegedConnectLinkResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pendingRequests.delete(id)) reject(new Error("Pipedream request timed out."));
      }, REQUEST_TIMEOUT_MS);
      timeout.unref?.();
      this.pendingRequests.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value as PipedreamPrivilegedConnectLinkResult);
        },
        reject: (reason) => {
          clearTimeout(timeout);
          reject(reason);
        },
      });
      const fail = (error: unknown): void => {
        const pending = this.pendingRequests.get(id);
        if (!pending) return;
        this.pendingRequests.delete(id);
        pending.reject(error);
      };
      try {
        child.send(message, (error) => {
          if (error) fail(error);
        });
      } catch (error) {
        fail(error);
      }
    });
  }

  /** Reconfigure the live supervisor without routing credentials through public procedure IPC. */
  async configurePipedream(
    payload: PipedreamPrivilegedBootstrapPayload,
  ): Promise<PipedreamSnapshot> {
    const child = await this.requireReadyChild();
    return this.requestPipedreamConfiguration(child, payload);
  }

  /** Resolve only after the current supervisor has completed its private bootstrap. */
  async waitUntilReady(): Promise<void> {
    await this.requireReadyChild();
  }

  private async requireReadyChild(): Promise<ChildProcess> {
    await this.startedGate;
    const readiness = this.childReadiness;
    if (!readiness) throw new Error("Supervisor is not running.");
    await readiness.promise;
    if (
      this.child !== readiness.child ||
      this.childReadiness !== readiness ||
      !readiness.child.connected
    ) {
      throw new Error("Supervisor is not running.");
    }
    return readiness.child;
  }

  private async initializeChild(child: ChildProcess, readiness: ChildReadiness): Promise<void> {
    try {
      await this.requestSupervisorSecretBootstrap(child);
      if (this.child !== child || this.childReadiness !== readiness || !child.connected) return;

      // Preserve ordering: the key handshake is always the first private IPC
      // request, then Pipedream configuration is enqueued, and only then are
      // ordinary supervisor calls released.
      const privilegedBootstrap = this.options.resolvePipedreamPrivilegedBootstrap?.();
      if (privilegedBootstrap) {
        await this.requestPipedreamConfiguration(child, privilegedBootstrap);
        if (this.child !== child || this.childReadiness !== readiness || !child.connected) return;
      }
      readiness.resolve();
      try {
        this.options.onStarted?.();
      } catch (error) {
        console.error("[poracode] supervisor started callback failed");
        this.options.reportError?.(error, { "poracode.feature_area": "supervisor" });
      }
    } catch (error) {
      this.failChildStartup(child, readiness, error);
    }
  }

  private failChildStartup(child: ChildProcess, readiness: ChildReadiness, cause: unknown): void {
    if (this.child !== child || this.childReadiness !== readiness) return;
    const error = new Error("Supervisor security bootstrap failed.");
    readiness.reject(error);
    this.childReadiness = null;
    this.child = null;
    this.reset(error);
    terminateChildProcessTree(child);
    if (
      cause instanceof SupervisorBootstrapFailureError &&
      cause.failureCode === SUPERVISOR_BOOTSTRAP_FAILURE_CODE.MCP_OAUTH_STORE_UNAVAILABLE
    ) {
      this.startupBlocked = true;
      void this.recoverBlockedStartup(cause.failureCode);
      return;
    }
    console.error("[poracode] supervisor security bootstrap failed, restarting…");
    this.options.reportError?.(error, { "poracode.feature_area": "supervisor" });
    this.scheduleRestart();
  }

  private async recoverBlockedStartup(failureCode: SupervisorBootstrapFailureCode): Promise<void> {
    let outcome: "retry" | "stop" = "stop";
    try {
      outcome = (await this.options.recoverStartupFailure?.(failureCode)) ?? "stop";
    } catch (error) {
      this.options.reportError?.(error, { "poracode.feature_area": "supervisor" });
    }
    if (outcome !== "retry" || this.disposed || this.child || !this.baseDir) return;
    this.startupBlocked = false;
    this.start(this.baseDir);
  }

  private scheduleRestart(): void {
    setTimeout(() => {
      if (!this.disposed && !this.child && this.baseDir) {
        this.start(this.baseDir);
      }
    }, 1000);
  }

  private requestSupervisorSecretBootstrap(child: ChildProcess): Promise<void> {
    if (!child.connected) return Promise.reject(new Error("Supervisor is not running."));
    const id = randomUUID();
    const message = {
      kind: "supervisor-secret-bootstrap" as const,
      version: SUPERVISOR_SECRET_BOOTSTRAP_PROTOCOL_VERSION,
      id,
      secretStorageKey: this.options.secretStorageKey,
      allowPipedreamOauthPersistence: this.options.allowPipedreamOauthPersistence,
    };
    if (!isSupervisorSecretBootstrapMessage(message)) {
      return Promise.reject(new Error("Supervisor security bootstrap is invalid."));
    }

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pendingRequests.delete(id)) {
          reject(new Error("Supervisor security bootstrap timed out."));
        }
      }, STARTUP_TIMEOUT_MS);
      timeout.unref?.();
      this.pendingRequests.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (reason) => {
          clearTimeout(timeout);
          reject(reason);
        },
      });

      const fail = (error: unknown): void => {
        const pending = this.pendingRequests.get(id);
        if (!pending) return;
        this.pendingRequests.delete(id);
        pending.reject(error);
      };
      try {
        child.send(message, (error) => {
          if (error) fail(error);
        });
      } catch (error) {
        fail(error);
      }
    }).then((value) => {
      if (!isSupervisorSecretBootstrapAck(value)) {
        throw new Error("Supervisor security bootstrap acknowledgement is invalid.");
      }
    });
  }

  private requestPipedreamConfiguration(
    child: ChildProcess,
    payload: PipedreamPrivilegedBootstrapPayload,
  ): Promise<PipedreamSnapshot> {
    if (!child.connected) return Promise.reject(new Error("Supervisor is not running."));
    const id = randomUUID();
    const message = { kind: "pipedream-privileged-bootstrap" as const, id, payload };
    if (!isPipedreamPrivilegedBootstrapMessage(message)) {
      return Promise.reject(new Error("Pipedream configuration is invalid."));
    }
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pendingRequests.delete(id)) {
          reject(new Error("Pipedream configuration timed out."));
        }
      }, REQUEST_TIMEOUT_MS);
      timeout.unref?.();

      this.pendingRequests.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (reason) => {
          clearTimeout(timeout);
          reject(reason);
        },
      });

      const fail = (error: unknown): void => {
        const pending = this.pendingRequests.get(id);
        if (!pending) return;
        this.pendingRequests.delete(id);
        pending.reject(error);
      };
      try {
        child.send(message, (error) => {
          if (error) fail(error);
        });
      } catch (error) {
        fail(error);
      }
    }).then((value) => pipedreamSnapshotSchema.parse(value));
  }
}

class SupervisorBootstrapFailureError extends Error {
  constructor(readonly failureCode: SupervisorBootstrapFailureCode) {
    super("Supervisor security bootstrap failed.");
    this.name = "SupervisorBootstrapFailureError";
  }
}
