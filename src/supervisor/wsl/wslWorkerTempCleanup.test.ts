import { describe, expect, it, vi } from "vitest";
import { createOwnedWslTempDeploymentCleanup } from "./wslWorkerTempCleanup";

describe("createOwnedWslTempDeploymentCleanup", () => {
  it("removes only the UUID deployment that owns the running filter worker", () => {
    const remove = vi.fn<(path: string) => void>();
    const linuxBaseDir = "/tmp/poracode-mcp-filter-123-12345678-1234-4234-9234-123456789abc";
    const cleanup = createOwnedWslTempDeploymentCleanup(
      linuxBaseDir,
      `${linuxBaseDir}/mcp-filter/mcp-filter.mjs`,
      remove,
    );

    expect(cleanup).toEqual(expect.any(Function));
    cleanup?.();
    cleanup?.();
    expect(remove).toHaveBeenCalledExactlyOnceWith(linuxBaseDir);
  });

  it("refuses a cleanup path that does not own the running worker", () => {
    const remove = vi.fn<(path: string) => void>();
    expect(
      createOwnedWslTempDeploymentCleanup(
        "/tmp/poracode-mcp-filter-123-12345678-1234-4234-9234-123456789abc",
        "/tmp/different/mcp-filter/mcp-filter.mjs",
        remove,
      ),
    ).toBeUndefined();
    expect(remove).not.toHaveBeenCalled();
  });
});
