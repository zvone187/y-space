import { session as electronSession } from "electron";

/**
 * Electron session cleanup is best-effort internally and can wait forever on
 * a wedged NetworkService. Keep app shutdown and the sensitive partition pool
 * live by placing one hard deadline around the complete cleanup sequence.
 */
export const SENSITIVE_SESSION_CLEANUP_TIMEOUT_MS = 5_000;

/**
 * Settle an exact sensitive-session cleanup attempt within its hard cap.
 *
 * The fulfillment and rejection handlers stay attached to `cleanup` after a
 * timeout. Electron cannot cancel these operations, so retaining the handlers
 * is important: a later rejection is observed instead of surfacing as an
 * unhandled process rejection. Callers must treat a timeout as failure and
 * permanently quarantine the corresponding pool slot.
 */
export function withSensitiveSessionCleanupTimeout(
  cleanup: Promise<void>,
  timeoutMs = SENSITIVE_SESSION_CLEANUP_TIMEOUT_MS,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("Sensitive integration session cleanup timed out"));
    }, timeoutMs);

    void cleanup.then(
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

/**
 * Erase every state surface used by an ephemeral OAuth BrowserContext. The
 * caller quarantines the fixed pool slot if any operation rejects, so this
 * function must never turn partial cleanup into success.
 */
export async function cleanupSensitiveSessionPartition(partition: string): Promise<void> {
  const sensitiveSession = electronSession.fromPartition(partition);
  const cleanup = (async (): Promise<void> => {
    const failures: unknown[] = [];
    const attempt = async (operation: () => Promise<void>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    };
    const clearState = async (): Promise<void> => {
      await Promise.all([
        attempt(() => sensitiveSession.clearStorageData()),
        attempt(() => sensitiveSession.clearCache()),
        attempt(() => sensitiveSession.clearAuthCache()),
      ]);
    };

    // Stop in-flight responses before clearing, then repeat both barriers so a
    // request racing the first teardown cannot repopulate cookies or auth state
    // immediately before this fixed partition is returned to the pool.
    await attempt(() => sensitiveSession.closeAllConnections());
    await clearState();
    await attempt(() => sensitiveSession.closeAllConnections());
    await clearState();
    if (failures.length > 0) {
      throw new AggregateError(failures, "Sensitive integration session cleanup failed");
    }
  })();

  await withSensitiveSessionCleanupTimeout(cleanup);
}
