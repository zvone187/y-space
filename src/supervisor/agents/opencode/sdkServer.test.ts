import { EventEmitter, once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { spawnOpenCodeServer } from "./sdkServer";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn<typeof import("node:child_process").spawn>(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: mocks.spawn };
});

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    pid: 42,
    exitCode: null,
    killed: false,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  return child;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("spawnOpenCodeServer launch cleanup", () => {
  beforeEach(() => {
    mocks.spawn.mockReset();
  });

  it("cleans launch-scoped environment files on process exit", async () => {
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);
    const cleanup = vi.fn<() => void>();
    const handle = spawnOpenCodeServer({ command: "wsl.exe", args: [], cleanup });
    void handle.baseUrl.catch(() => undefined);

    child.emit("exit", 1, null);

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("cleans launch-scoped environment files when spawn throws", () => {
    mocks.spawn.mockImplementation(() => {
      throw new Error("spawn failed");
    });
    const cleanup = vi.fn<() => void>();

    expect(() => spawnOpenCodeServer({ command: "wsl.exe", args: [], cleanup })).toThrow(
      "spawn failed",
    );
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it.skipIf(process.platform === "win32")(
    "reaps the process group exactly once when timeout SIGKILL races the exit callback",
    async () => {
      vi.useFakeTimers();
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
      const child = fakeChild();
      mocks.spawn.mockReturnValue(child);
      const handle = spawnOpenCodeServer({ command: "opencode", args: [] });
      void handle.baseUrl.catch(() => undefined);

      try {
        const disposal = handle.dispose();
        await vi.advanceTimersByTimeAsync(1_000);
        await disposal;
        child.emit("exit", null, "SIGKILL");

        expect(
          killSpy.mock.calls.filter(([pid, signal]) => pid === -42 && signal === "SIGTERM"),
        ).toHaveLength(1);
        expect(
          killSpy.mock.calls.filter(([pid, signal]) => pid === -42 && signal === "SIGKILL"),
        ).toHaveLength(1);
      } finally {
        killSpy.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "reaps the detached process group when the OpenCode leader exits unexpectedly",
    async () => {
      const actualChildProcess =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      mocks.spawn.mockImplementation(actualChildProcess.spawn);
      const root = mkdtempSync(join(tmpdir(), "y-space-opencode-exit-group-"));
      const descendantPidPath = join(root, "descendant.pid");
      let descendantPid: number | undefined;
      let leaderPid: number | undefined;
      const killSpy = vi.spyOn(process, "kill");
      try {
        const script = [
          'const { spawn } = require("node:child_process");',
          'const { writeFileSync } = require("node:fs");',
          'const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
          "writeFileSync(process.argv[1], String(descendant.pid));",
          'process.stdout.write("opencode server listening on http://127.0.0.1:43210\\n");',
          "setTimeout(() => process.exit(23), 50);",
        ].join("\n");
        const handle = spawnOpenCodeServer({
          command: process.execPath,
          args: ["-e", script, descendantPidPath],
        });
        leaderPid = handle.child.pid;

        await expect(handle.baseUrl).resolves.toBe("http://127.0.0.1:43210");
        descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
        expect(Number.isInteger(descendantPid) && descendantPid > 0).toBe(true);
        expect(isProcessAlive(descendantPid)).toBe(true);
        if (handle.child.exitCode === null) await once(handle.child, "exit");

        await waitForProcessExit(descendantPid);
        expect(isProcessAlive(descendantPid)).toBe(false);
        await handle.dispose();
        expect(
          killSpy.mock.calls.filter(
            ([pid, signal]) => pid === -(leaderPid ?? 0) && signal === "SIGKILL",
          ),
        ).toHaveLength(1);
      } finally {
        killSpy.mockRestore();
        if (leaderPid && leaderPid > 0) {
          try {
            process.kill(-leaderPid, "SIGKILL");
          } catch {
            // The owned group was already reaped.
          }
        }
        if (descendantPid && descendantPid > 0 && isProcessAlive(descendantPid)) {
          try {
            process.kill(descendantPid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
        rmSync(root, { recursive: true, force: true });
      }
    },
    10_000,
  );
});
