export type ProcessRuntimeShutdownPhase = "supervisor" | "job-object" | "database";

export interface ProcessRuntimeShutdownOptions {
  readonly disposeSupervisor: () => void;
  readonly disposeJobObject: () => void;
  readonly closeDatabase: () => void;
  readonly reportError: (error: unknown, phase: ProcessRuntimeShutdownPhase) => void;
}

/** Runs final process-owned cleanup once without allowing one failed phase to skip another. */
export function createProcessRuntimeShutdown(options: ProcessRuntimeShutdownOptions): () => void {
  let finalized = false;
  return () => {
    if (finalized) return;
    finalized = true;

    runCleanupPhase(options.disposeSupervisor, "supervisor", options.reportError);
    runCleanupPhase(options.disposeJobObject, "job-object", options.reportError);
    runCleanupPhase(options.closeDatabase, "database", options.reportError);
  };
}

function runCleanupPhase(
  cleanup: () => void,
  phase: ProcessRuntimeShutdownPhase,
  reportError: ProcessRuntimeShutdownOptions["reportError"],
): void {
  try {
    cleanup();
  } catch (error) {
    try {
      reportError(error, phase);
    } catch {
      // Shutdown must remain reachable even when diagnostics are unavailable.
    }
  }
}
