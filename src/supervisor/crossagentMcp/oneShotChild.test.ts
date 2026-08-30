import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ProjectLocation } from "@/shared/contracts";
import { terminateProcessTree } from "@/shared/processTree";
import type { AgentAdapter, OneShotChildCommand } from "@/supervisor/agents/base";

// Pass the built command through unchanged so the driver spawns exactly what the
// provider's `buildSubagentOneShotCommand` returns (no shell/WSL wrapping). The
// WSL-aware wrapping itself lives in — and is tested by — `oneShotSpawn`.
vi.mock("@/supervisor/oneShotSpawn", () => ({
  buildOneShotSpec: (
    _location: ProjectLocation,
    command: string,
    args: string[],
    options?: { env?: Record<string, string> },
  ) => ({ command, args, ...(options?.env ? { env: options.env } : {}) }),
}));

const { runOneShotChild } = await import("./oneShotChild");

const PROJECT: ProjectLocation = { kind: "posix", path: "/tmp/project" };

/** Adapter whose one-shot command runs a node snippet with deterministic IO. */
function nodeAdapter(build: () => OneShotChildCommand | undefined): AgentAdapter {
  return {
    label: "Fake",
    buildSubagentOneShotCommand: build,
  } as unknown as AgentAdapter;
}

function run(adapter: AgentAdapter): Promise<{
  output: string;
  status: "completed" | "failed";
  errorMessage?: string;
}> {
  return new Promise((resolve) => {
    let output = "";
    runOneShotChild({
      adapter,
      projectLocation: PROJECT,
      model: "m",
      effort: undefined,
      prompt: "hi",
      onTextDelta: (delta) => {
        output += delta;
      },
      onSettle: ({ status, errorMessage }) =>
        resolve({ output, status, ...(errorMessage ? { errorMessage } : {}) }),
    });
  });
}

describe("runOneShotChild", () => {
  it("streams stdout and settles completed on exit 0", async () => {
    const adapter = nodeAdapter(() => ({
      command: process.execPath,
      args: ["-e", "process.stdout.write('hello '); process.stdout.write('world')"],
      stdin: "",
    }));
    const result = await run(adapter);
    expect(result.status).toBe("completed");
    expect(result.output).toBe("hello world");
  });

  it("settles failed with the stderr tail on a non-zero exit", async () => {
    const adapter = nodeAdapter(() => ({
      command: process.execPath,
      args: ["-e", "process.stderr.write('boom'); process.exit(3)"],
      stdin: "",
    }));
    const result = await run(adapter);
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("boom");
  });

  it("settles failed immediately when the provider returns no command", async () => {
    const adapter = nodeAdapter(() => undefined);
    const result = await run(adapter);
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("cannot be spawned");
  });

  it("cancel() terminates a long-running child", async () => {
    const adapter = nodeAdapter(() => ({
      command: process.execPath,
      // Sleep ~30s; cancel should kill it well before then.
      args: ["-e", "setTimeout(() => {}, 30000)"],
      stdin: "",
    }));
    const settled = new Promise<"completed" | "failed">((resolve) => {
      const handle = runOneShotChild({
        adapter,
        projectLocation: PROJECT,
        model: "m",
        effort: undefined,
        prompt: "hi",
        onTextDelta: () => {},
        onSettle: ({ status }) => resolve(status),
      });
      setTimeout(() => handle.cancel(), 50);
    });
    // A killed process never exits 0 → the driver reports a non-completed settle.
    expect(await settled).toBe("failed");
  });

  it("force-kills a child that ignores SIGTERM before dispose settles", async () => {
    const adapter = nodeAdapter(() => ({
      command: process.execPath,
      args: [
        "-e",
        [
          "process.on('SIGTERM', () => {})",
          "process.stdout.write('ready')",
          // Bound the fail-first case so a broken force-kill path cannot
          // leave a child behind after the test finishes.
          "setTimeout(() => process.exit(0), 6500)",
        ].join(";"),
      ],
      stdin: "",
    }));
    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    let terminalStatus: "completed" | "failed" | undefined;
    const handle = runOneShotChild({
      adapter,
      projectLocation: PROJECT,
      model: "m",
      effort: undefined,
      prompt: "hi",
      onTextDelta: (delta) => {
        if (delta.includes("ready")) markReady();
      },
      onSettle: ({ status }) => {
        terminalStatus = status;
      },
    });
    await ready;

    const startedAt = Date.now();
    await handle.dispose();

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(terminalStatus).toBe("failed");
  }, 10_000);

  it("stops a one-shot leader and its heartbeat descendant before dispose settles", async () => {
    const directory = mkdtempSync(join(tmpdir(), "y-space-one-shot-tree-"));
    const heartbeatPath = join(directory, "heartbeat.txt");
    let descendantPid: number | undefined;
    try {
      const descendantSource = [
        "const { writeFileSync } = require('node:fs')",
        "const heartbeatPath = process.argv[1]",
        "let heartbeat = 0",
        "const pulse = () => writeFileSync(heartbeatPath, String(++heartbeat))",
        // The leader accepts SIGTERM, but this descendant deliberately does
        // not: leader exit must trigger exact-group reaping before dispose ends.
        "process.on('SIGTERM', () => {})",
        "pulse()",
        "process.stdout.write('ready')",
        "setInterval(pulse, 20)",
        // Keep a fail-first run bounded even if cleanup itself regresses.
        "setTimeout(() => process.exit(0), 10000)",
      ].join(";");
      const leaderSource = [
        "const { spawn } = require('node:child_process')",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}, ${JSON.stringify(heartbeatPath)}], { stdio: ['ignore', 'pipe', 'ignore'] })`,
        "child.stdout.once('data', () => process.stdout.write('ready:' + child.pid))",
        "setInterval(() => {}, 1000)",
      ].join(";");
      const adapter = nodeAdapter(() => ({
        command: process.execPath,
        args: ["-e", leaderSource],
        stdin: "",
      }));
      let output = "";
      let markReady!: (pid: number) => void;
      const ready = new Promise<number>((resolve) => {
        markReady = resolve;
      });
      const handle = runOneShotChild({
        adapter,
        projectLocation: PROJECT,
        model: "m",
        effort: undefined,
        prompt: "hi",
        onTextDelta: (delta) => {
          output += delta;
          const match = /ready:(\d+)/u.exec(output);
          if (match?.[1]) markReady(Number(match[1]));
        },
        onSettle: () => {},
      });
      descendantPid = await ready;

      await handle.dispose();
      const heartbeatAfterDispose = readFileSync(heartbeatPath, "utf8");
      await new Promise((resolve) => setTimeout(resolve, 125));

      expect(readFileSync(heartbeatPath, "utf8")).toBe(heartbeatAfterDispose);
    } finally {
      if (descendantPid) terminateProcessTree(descendantPid, { signal: "SIGKILL" });
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
