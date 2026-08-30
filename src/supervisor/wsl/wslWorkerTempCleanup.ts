import { rmSync } from "node:fs";
import { posix } from "node:path";

const MCP_FILTER_TEMP_BASE_RE =
  /^poracode-mcp-filter-[1-9][0-9]*-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type RemoveDeployment = (linuxBaseDir: string) => void;

const removeDeployment: RemoveDeployment = (linuxBaseDir) => {
  rmSync(linuxBaseDir, { recursive: true, force: true });
};

/**
 * Build an idempotent exit cleanup only when the supplied UUID directory owns
 * the exact MCP filter worker being executed. Keeping this validation beside
 * the worker avoids turning a command-line argument into an arbitrary `rm`.
 */
export function createOwnedWslTempDeploymentCleanup(
  linuxBaseDir: string,
  workerScriptPath: string,
  remove: RemoveDeployment = removeDeployment,
): (() => void) | undefined {
  if (
    !posix.isAbsolute(linuxBaseDir) ||
    posix.normalize(linuxBaseDir) !== linuxBaseDir ||
    posix.dirname(linuxBaseDir) !== "/tmp" ||
    !MCP_FILTER_TEMP_BASE_RE.test(posix.basename(linuxBaseDir))
  ) {
    return undefined;
  }
  const expectedWorkerPath = posix.join(linuxBaseDir, "mcp-filter", "mcp-filter.mjs");
  if (posix.normalize(workerScriptPath) !== expectedWorkerPath) return undefined;

  let cleaned = false;
  return () => {
    if (cleaned) return;
    try {
      remove(linuxBaseDir);
      cleaned = true;
    } catch {
      // Process-exit cleanup is best effort.
    }
  };
}
