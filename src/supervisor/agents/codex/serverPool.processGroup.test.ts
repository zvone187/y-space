import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { terminateProcessTree } from "@/shared/processTree";
import type { CreateStructuredSessionInput } from "../base";

const mocks = vi.hoisted(() => ({
  buildCodexAppServerCommand: vi.fn<(...args: unknown[]) => unknown>(),
}));

vi.mock("./argv", () => ({
  buildCodexAppServerCommand: mocks.buildCodexAppServerCommand,
}));

import { acquireCodexAppServer, shutdownSpawnedCodexAppServers } from "./serverPool";

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
    });
    if (result.error) return true;
    return result.status === 0 && !result.stdout.trim().startsWith("Z");
  } catch {
    return false;
  }
}

function posixInput(): CreateStructuredSessionInput {
  return {
    threadId: "codex-process-group-test",
    projectLocation: { kind: "posix", path: process.cwd() },
    config: { model: "gpt-5.6-sol" },
    mcpServers: [],
    presentationMode: "gui",
  };
}

describe("Codex app-server POSIX process-group cleanup", () => {
  afterEach(() => {
    shutdownSpawnedCodexAppServers();
  });

  it("kills an app-server tool descendant when the last lease is released", async () => {
    if (process.platform === "win32") return;

    const tempDir = await mkdtemp(join(tmpdir(), "y-space-codex-process-group-"));
    const leaderPidPath = join(tempDir, "leader.pid");
    const descendantPidPath = join(tempDir, "descendant.pid");
    const launchCleanup = vi.fn<() => void>();
    const killSpy = vi.spyOn(process, "kill");
    let leaderPid = 0;
    let descendantPid = 0;
    const appServerScript = [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      "writeFileSync(process.argv[1], String(process.pid));",
      'const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      "descendant.unref();",
      "writeFileSync(process.argv[2], String(descendant.pid));",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    mocks.buildCodexAppServerCommand.mockReturnValue({
      command: process.execPath,
      args: ["-e", appServerScript, leaderPidPath, descendantPidPath],
      cleanup: launchCleanup,
    });

    try {
      const acquired = await acquireCodexAppServer(posixInput());
      await expect
        .poll(
          async () => {
            try {
              leaderPid = Number(await readFile(leaderPidPath, "utf8"));
              descendantPid = Number(await readFile(descendantPidPath, "utf8"));
              return isProcessRunning(leaderPid) && isProcessRunning(descendantPid);
            } catch {
              return false;
            }
          },
          { timeout: 3_000 },
        )
        .toBe(true);

      acquired.dispose();

      await expect.poll(() => isProcessRunning(descendantPid), { timeout: 3_000 }).toBe(false);
      await expect.poll(() => launchCleanup.mock.calls.length, { timeout: 3_000 }).toBe(1);
      expect(
        killSpy.mock.calls.filter(([pid, signal]) => pid === -leaderPid && signal === "SIGKILL"),
      ).toHaveLength(1);
    } finally {
      killSpy.mockRestore();
      if (isProcessRunning(leaderPid)) terminateProcessTree(leaderPid, { ownedProcessGroup: true });
      if (isProcessRunning(descendantPid)) terminateProcessTree(descendantPid);
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 10_000);
});
