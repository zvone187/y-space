import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  copyFileSync: vi.fn<typeof import("node:fs").copyFileSync>(),
  mkdirSync: vi.fn<typeof import("node:fs").mkdirSync>(),
  rmSync: vi.fn<typeof import("node:fs").rmSync>(),
  writeFileSync: vi.fn<typeof import("node:fs").writeFileSync>(),
}));

vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return {
    ...actual,
    randomUUID: () => "12345678-1234-4234-9234-123456789abc",
  };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    copyFileSync: fsMocks.copyFileSync,
    mkdirSync: fsMocks.mkdirSync,
    rmSync: fsMocks.rmSync,
    writeFileSync: fsMocks.writeFileSync,
  };
});

vi.mock("../agents/base", () => ({
  getCachedWslHomeDirectory: vi.fn<() => undefined>(),
  resolveWslHomeDirectory: vi.fn<() => undefined>(),
}));

import { deployFilesToWslTempBase } from "./wslDeploy";

describe("temporary WSL deployment cleanup", () => {
  beforeEach(() => {
    fsMocks.copyFileSync.mockReset();
    fsMocks.mkdirSync.mockReset();
    fsMocks.rmSync.mockReset();
    fsMocks.writeFileSync.mockReset();
  });

  it("returns an idempotent cleanup capability for the exact UUID deployment", () => {
    const deployed = deployFilesToWslTempBase("Ubuntu", "poracode-worker", [
      { content: "worker", relDest: "worker/worker.mjs" },
    ]);

    expect(deployed?.linuxBaseDir).toBe(
      "/tmp/poracode-worker-12345678-1234-4234-9234-123456789abc",
    );
    expect(deployed?.cleanup).toEqual(expect.any(Function));
    expect(fsMocks.rmSync).not.toHaveBeenCalled();

    deployed?.cleanup();
    deployed?.cleanup();

    expect(fsMocks.rmSync).toHaveBeenCalledExactlyOnceWith(
      "\\\\wsl.localhost\\Ubuntu\\tmp\\poracode-worker-12345678-1234-4234-9234-123456789abc",
      { recursive: true, force: true },
    );
  });

  it("removes a private base immediately when staging fails", () => {
    fsMocks.writeFileSync.mockImplementationOnce(() => {
      throw new Error("copy failed");
    });

    expect(
      deployFilesToWslTempBase("Ubuntu", "poracode-worker", [
        { content: "worker", relDest: "worker/worker.mjs" },
      ]),
    ).toBeNull();
    expect(fsMocks.rmSync).toHaveBeenCalledExactlyOnceWith(
      "\\\\wsl.localhost\\Ubuntu\\tmp\\poracode-worker-12345678-1234-4234-9234-123456789abc",
      { recursive: true, force: true },
    );
  });
});
