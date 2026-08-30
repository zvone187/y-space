import { SENSITIVE_SESSION_CLEANUP_TIMEOUT_MS } from "../browser/cleanupSensitiveSessionPartition";

/** Personal MCP OAuth and Connect can each own one independently cleaned
 * sensitive partition. Allow both inner cleanup caps plus a small coordination
 * margin, then favor process liveness: final process exit retires every
 * non-persistent BrowserContext even if Chromium never reports guest teardown. */
export const ORDERLY_PIPEDREAM_DISPOSE_TIMEOUT_MS =
  SENSITIVE_SESSION_CLEANUP_TIMEOUT_MS * 2 + 2_000;

export interface OrderlyPipedreamShutdownOptions {
  readonly beginShutdown: () => void;
  readonly disposePipedream: () => Promise<void>;
  readonly disposeBrowserManager: () => void;
  readonly reportPipedreamDisposeError: () => void;
  readonly requestFinalQuit: () => void;
}

export interface PreventableQuitEvent {
  preventDefault(): void;
}

type PipedreamDisposeResult = "fulfilled" | "rejected" | "timed-out";

function settlePipedreamDisposeBeforeDeadline(
  disposal: Promise<void>,
): Promise<PipedreamDisposeResult> {
  return new Promise<PipedreamDisposeResult>((resolve) => {
    let settled = false;
    const finish = (result: PipedreamDisposeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => finish("timed-out"), ORDERLY_PIPEDREAM_DISPOSE_TIMEOUT_MS);

    // Keep both observers attached after the deadline. Chromium guest teardown
    // and supervisor cancellation are not cancellable; a later rejection must
    // remain handled after final quit has already been requested.
    void disposal.then(
      () => finish("fulfilled"),
      () => finish("rejected"),
    );
  });
}

/** Coordinates Electron's cancelable first quit with secret-flow cleanup. */
export function createOrderlyPipedreamShutdown(options: OrderlyPipedreamShutdownOptions) {
  let shutdownStarted = false;
  let finalQuitRequested = false;

  return (event: PreventableQuitEvent): void => {
    if (finalQuitRequested) return;
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;

    try {
      options.beginShutdown();
    } catch {
      // Continue into the security-sensitive asynchronous cleanup even if an
      // unrelated synchronous shutdown hook fails.
    }

    void (async () => {
      let disposal: Promise<void>;
      try {
        disposal = options.disposePipedream();
      } catch (error) {
        disposal = Promise.reject(error);
      }
      const disposalResult = await settlePipedreamDisposeBeforeDeadline(disposal);
      if (disposalResult !== "fulfilled") {
        try {
          options.reportPipedreamDisposeError();
        } catch {
          // Reporting cannot be allowed to strand the application mid-quit.
        }
      }

      try {
        options.disposeBrowserManager();
      } catch {
        // Final quit must remain reachable after best-effort browser disposal.
      }
      finalQuitRequested = true;
      try {
        options.requestFinalQuit();
      } catch {
        // Electron owns final quit delivery; never create an unhandled rejection.
      }
    })();
  };
}
