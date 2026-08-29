import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedMcpServer } from "@/shared/contracts";
import type { CreateStructuredSessionInput } from "../base";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn<(...args: unknown[]) => unknown>(),
  terminateChildProcessTree:
    vi.fn<(child: unknown, options?: { ownedProcessGroup?: boolean }) => void>(),
  buildCodexAppServerCommand: vi.fn<(...args: unknown[]) => unknown>(),
  installCodexPlugin: vi.fn<(...args: unknown[]) => unknown>(),
  commandCleanup: vi.fn<() => void>(),
  probeCodexCliSemver: vi.fn<() => [number, number, number] | null>(),
  parseCodexVersionLine: vi.fn<(line: string) => [number, number, number] | null>(),
  batchWslCommandsAsync: vi.fn<() => Promise<Array<{ ok: boolean; stdout: string }>>>(),
  resolveNodeForDistro: vi.fn<() => Promise<{ nodePath: string }>>(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));
vi.mock("@/shared/processTree", () => ({
  terminateChildProcessTree: mocks.terminateChildProcessTree,
}));
vi.mock("../base", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../base")>()),
  batchWslCommandsAsync: mocks.batchWslCommandsAsync,
}));
vi.mock("../../wsl/runtime", () => ({
  resolveNodeForDistro: mocks.resolveNodeForDistro,
}));
vi.mock("./argv", () => ({
  buildCodexAppServerCommand: mocks.buildCodexAppServerCommand,
}));
vi.mock("./mcpSkillConflicts", () => ({
  buildCodexMcpSkillConflictArgs: () => [],
}));
vi.mock("./plugin/install", () => ({
  codexHooksFeatureFlagForSemver: () => "hooks",
  installCodexPlugin: mocks.installCodexPlugin,
  isCodexSemverSupportedForHooks: (version: [number, number, number] | null) =>
    Boolean(
      version && (version[0] > 0 || version[1] > 122 || (version[1] === 122 && version[2] >= 0)),
    ),
  parseCodexVersionLine: mocks.parseCodexVersionLine,
  probeCodexCliSemver: mocks.probeCodexCliSemver,
}));

import {
  acquireCodexAppServer,
  codexAppServerPoolKey,
  shutdownSpawnedCodexAppServers,
} from "./serverPool";

function fakeChildProcess() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    killed: false,
  });
}

function browserServer(
  threadId: string,
  baseUrl = "http://127.0.0.1:9000",
  token = "yspace-mcp-v1.shared.signature",
): ResolvedMcpServer {
  return {
    id: "browser",
    name: "browser",
    timeoutMs: 30_000,
    transport: {
      type: "http",
      url: `${baseUrl}/mcp?thread=${threadId}&title=task`,
      headers: { Authorization: `Bearer ${token}` },
    },
  };
}

function httpServer(id: string, url: string, token = "shared-token"): ResolvedMcpServer {
  return {
    id,
    name: id,
    timeoutMs: 30_000,
    transport: {
      type: "http",
      url,
      headers: { Authorization: `Bearer ${token}` },
    },
  };
}

function input(threadId: string, server: ResolvedMcpServer): CreateStructuredSessionInput {
  return {
    threadId,
    projectLocation: { kind: "windows", path: "C:\\repo" },
    config: { model: "gpt-5.6" },
    mcpServers: [server],
    presentationMode: "gui",
  };
}

describe("Codex app-server pool", () => {
  beforeEach(() => {
    mocks.spawn.mockReset();
    mocks.terminateChildProcessTree.mockReset();
    mocks.buildCodexAppServerCommand.mockReset();
    mocks.installCodexPlugin.mockReset();
    mocks.commandCleanup.mockReset();
    mocks.probeCodexCliSemver.mockReset().mockReturnValue([0, 130, 0]);
    mocks.parseCodexVersionLine.mockReset().mockImplementation((line) => {
      const match = /codex-cli\s+(\d+)\.(\d+)\.(\d+)/u.exec(line);
      return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
    });
    mocks.batchWslCommandsAsync
      .mockReset()
      .mockResolvedValue([{ ok: true, stdout: "codex-cli 0.130.0" }]);
    mocks.resolveNodeForDistro.mockReset().mockResolvedValue({ nodePath: "/usr/bin/node" });
    mocks.spawn.mockImplementation(() => fakeChildProcess());
    mocks.installCodexPlugin.mockResolvedValue({
      ok: true,
      paths: {
        codexHomeDir: "/private/y-space/codex/home",
        sqliteHomeDir: "/home/demo/.codex",
      },
      version: "test",
    });
    mocks.buildCodexAppServerCommand.mockImplementation((_location, rawOptions) => {
      const options = rawOptions as {
        browserExclusiveHook?: {
          codexHomeDir: string;
          sqliteHomeDir: string;
          featureFlag: string;
        };
      };
      return {
        command: process.execPath,
        args: [
          ...(options.browserExclusiveHook
            ? [
                "--dangerously-bypass-hook-trust",
                "--enable",
                options.browserExclusiveHook.featureFlag,
              ]
            : []),
          "app-server",
        ],
        ...(options.browserExclusiveHook
          ? {
              env: {
                CODEX_HOME: options.browserExclusiveHook.codexHomeDir,
                CODEX_SQLITE_HOME: options.browserExclusiveHook.sqliteHomeDir,
              },
            }
          : {}),
        cleanup: mocks.commandCleanup,
      };
    });
  });

  afterEach(() => {
    shutdownSpawnedCodexAppServers();
  });

  it("does not inherit privileged Browser or App Controls ingress roots", async () => {
    const previousBrowser = process.env.PORACODE_BROWSER_MCP_TOKEN;
    const previousControls = process.env.PORACODE_APP_CONTROLS_MCP_TOKEN;
    process.env.PORACODE_BROWSER_MCP_TOKEN = "browser-root";
    process.env.PORACODE_APP_CONTROLS_MCP_TOKEN = "controls-root";
    try {
      const acquired = await acquireCodexAppServer(input("local-a", browserServer("local-a")));
      const options = mocks.spawn.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
      expect(options?.env).not.toHaveProperty("PORACODE_BROWSER_MCP_TOKEN");
      expect(options?.env).not.toHaveProperty("PORACODE_APP_CONTROLS_MCP_TOKEN");
      acquired.dispose();
    } finally {
      if (previousBrowser === undefined) delete process.env.PORACODE_BROWSER_MCP_TOKEN;
      else process.env.PORACODE_BROWSER_MCP_TOKEN = previousBrowser;
      if (previousControls === undefined) delete process.env.PORACODE_APP_CONTROLS_MCP_TOKEN;
      else process.env.PORACODE_APP_CONTROLS_MCP_TOKEN = previousControls;
    }
  });

  it("stages and trusts the app-owned deny hook for a Browser-connected app-server", async () => {
    const acquired = await acquireCodexAppServer(input("local-a", browserServer("local-a")));

    expect(mocks.installCodexPlugin).toHaveBeenCalledOnce();
    expect(mocks.buildCodexAppServerCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        browserExclusiveHook: {
          codexHomeDir: "/private/y-space/codex/home",
          sqliteHomeDir: "/home/demo/.codex",
          featureFlag: "hooks",
        },
      }),
    );
    expect(mocks.spawn.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(["--dangerously-bypass-hook-trust", "--enable", "hooks"]),
    );
    const spawnOptions = mocks.spawn.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
    expect(spawnOptions?.env?.CODEX_HOME).toBe("/private/y-space/codex/home");
    expect(spawnOptions?.env?.CODEX_SQLITE_HOME).toBe("/home/demo/.codex");

    acquired.dispose();
  });

  it.each([
    ["older than hook support", [0, 121, 99] as [number, number, number]],
    ["unparseable", null],
  ])("rejects a native Browser app-server when Codex is %s", async (_label, version) => {
    mocks.probeCodexCliSemver.mockReturnValue(version);

    await expect(
      acquireCodexAppServer(input("unsupported-native", browserServer("unsupported-native"))),
    ).rejects.toThrow("requires codex-cli >= 0.122.0");

    expect(mocks.installCodexPlugin).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it.each(["codex-cli 0.121.99", "unexpected version output"])(
    "rejects a WSL Browser app-server when Codex reports %s",
    async (versionOutput) => {
      mocks.batchWslCommandsAsync.mockResolvedValue([{ ok: true, stdout: versionOutput }]);
      const launch = {
        ...input("unsupported-wsl", browserServer("unsupported-wsl")),
        projectLocation: {
          kind: "wsl" as const,
          distro: "Ubuntu",
          linuxPath: "/repo",
          uncPath: "\\\\wsl$\\Ubuntu\\repo",
        },
      };

      await expect(acquireCodexAppServer(launch, "/usr/bin/codex")).rejects.toThrow(
        "requires codex-cli >= 0.122.0",
      );

      expect(mocks.installCodexPlugin).not.toHaveBeenCalled();
      expect(mocks.spawn).not.toHaveBeenCalled();
    },
  );

  it("does not stage or trust the deny hook without managed Browser", async () => {
    const acquired = await acquireCodexAppServer(
      input("local-a", httpServer("slack", "http://127.0.0.1:9000/mcp")),
    );

    expect(mocks.installCodexPlugin).not.toHaveBeenCalled();
    expect(mocks.buildCodexAppServerCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ browserExclusiveHook: expect.anything() }),
    );
    expect(mocks.spawn.mock.calls[0]?.[1]).not.toContain("--dangerously-bypass-hook-trust");

    acquired.dispose();
  });

  it("reuses one process when only thread-scoped MCP query values differ and credentials match", async () => {
    const first = await acquireCodexAppServer(input("local-a", browserServer("local-a")));
    const secondInput = {
      ...input("local-b", browserServer("local-b")),
      projectLocation: { kind: "windows" as const, path: "D:\\other-repo" },
    };
    const second = await acquireCodexAppServer(secondInput);

    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(second.connection).toBe(first.connection);

    first.dispose();
    expect(mocks.terminateChildProcessTree).not.toHaveBeenCalled();
    second.dispose();
    expect(mocks.terminateChildProcessTree).toHaveBeenCalledOnce();
  });

  it("does not reuse a process when signed launch credentials differ", async () => {
    const first = await acquireCodexAppServer(
      input("local-a", browserServer("local-a", undefined, "yspace-mcp-v1.thread-a.signature")),
    );
    const second = await acquireCodexAppServer(
      input("local-b", browserServer("local-b", undefined, "yspace-mcp-v1.thread-b.signature")),
    );

    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(second.connection).not.toBe(first.connection);

    first.dispose();
    second.dispose();
  });

  it("reuses one process when thread context windows differ", async () => {
    const first = await acquireCodexAppServer({
      ...input("local-a", browserServer("local-a")),
      config: { model: "gpt-5.6-sol", contextSize: "400k" },
    });
    const second = await acquireCodexAppServer({
      ...input("local-b", browserServer("local-b")),
      config: { model: "gpt-5.6-sol", contextSize: "272k" },
    });

    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(second.connection).toBe(first.connection);

    first.dispose();
    second.dispose();
  });

  it("keeps the shared process alive while two of three thread leases remain", async () => {
    const first = await acquireCodexAppServer(input("local-a", browserServer("local-a")));
    const second = await acquireCodexAppServer(input("local-b", browserServer("local-b")));
    const third = await acquireCodexAppServer(input("local-c", browserServer("local-c")));

    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(second.connection).toBe(first.connection);
    expect(third.connection).toBe(first.connection);

    first.dispose();
    expect(mocks.terminateChildProcessTree).not.toHaveBeenCalled();
    second.dispose();
    expect(mocks.terminateChildProcessTree).not.toHaveBeenCalled();
    third.dispose();
    expect(mocks.terminateChildProcessTree).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      ownedProcessGroup: process.platform !== "win32",
    });
  });

  it("launches the app-server in an owned POSIX process group", async () => {
    const acquired = await acquireCodexAppServer(input("local-a", browserServer("local-a")));

    expect(mocks.spawn).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ detached: process.platform !== "win32" }),
    );

    acquired.dispose();
  });

  it("reaps an app-server tree exactly once when dispose races its exit callback", async () => {
    const child = fakeChildProcess();
    mocks.spawn.mockReturnValueOnce(child);
    const acquired = await acquireCodexAppServer(input("local-a", browserServer("local-a")));

    acquired.dispose();
    child.emit("exit", null, "SIGKILL");

    expect(mocks.terminateChildProcessTree).toHaveBeenCalledExactlyOnceWith(child, {
      ownedProcessGroup: process.platform !== "win32",
    });
  });

  it("terminates owned app-server process groups during supervisor shutdown", async () => {
    await acquireCodexAppServer(input("local-a", browserServer("local-a")));
    const child = mocks.spawn.mock.results[0]?.value;

    shutdownSpawnedCodexAppServers();

    expect(mocks.terminateChildProcessTree).toHaveBeenCalledWith(child, {
      ownedProcessGroup: process.platform !== "win32",
    });
  });

  it("keeps the shared process alive when its final established lease overlaps an acquisition", async () => {
    const launch = input("local-a", browserServer("local-a"));
    const established = await acquireCodexAppServer(launch);
    const acquiring = acquireCodexAppServer(input("local-b", browserServer("local-b")));

    established.dispose();
    const replacement = await acquiring;

    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(mocks.terminateChildProcessTree).not.toHaveBeenCalled();

    replacement.dispose();
    expect(mocks.terminateChildProcessTree).toHaveBeenCalledOnce();
  });

  it("survives repeated waves of concurrent thread acquisition and removal", async () => {
    let established = await acquireCodexAppServer(input("seed", browserServer("seed")));

    for (let wave = 0; wave < 100; wave += 1) {
      const acquiring = Array.from({ length: 10 }, (_, index) => {
        const threadId = `wave-${wave}-thread-${index}`;
        return acquireCodexAppServer(input(threadId, browserServer(threadId)));
      });

      established.dispose();
      const acquired = await Promise.all(acquiring);
      for (const lease of acquired.slice(0, -1)) lease.dispose();
      established = acquired.at(-1)!;

      expect(mocks.spawn).toHaveBeenCalledOnce();
      expect(mocks.terminateChildProcessTree).not.toHaveBeenCalled();
    }

    established.dispose();
    expect(mocks.terminateChildProcessTree).toHaveBeenCalledOnce();
  });

  it("starts a fresh process after the final lease is released", async () => {
    const launch = input("local-a", browserServer("local-a"));
    const first = await acquireCodexAppServer(launch);

    first.dispose();
    await acquireCodexAppServer(launch);

    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a process across different MCP endpoints", async () => {
    await acquireCodexAppServer(input("local-a", browserServer("local-a")));
    await acquireCodexAppServer(
      input("local-b", browserServer("local-b", "http://127.0.0.1:9100")),
    );

    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });

  it("keeps incompatible execution runtimes in separate pools", () => {
    const server = browserServer("local-a");
    const windows = codexAppServerPoolKey({ kind: "windows", path: "C:\\repo" }, [server]);
    const posix = codexAppServerPoolKey({ kind: "posix", path: "/repo" }, [server]);
    const ubuntu = codexAppServerPoolKey(
      { kind: "wsl", distro: "Ubuntu", linuxPath: "/repo", uncPath: "\\\\wsl$\\Ubuntu\\repo" },
      [server],
    );
    const debian = codexAppServerPoolKey(
      { kind: "wsl", distro: "Debian", linuxPath: "/repo", uncPath: "\\\\wsl$\\Debian\\repo" },
      [server],
    );

    expect(new Set([windows, posix, ubuntu, debian])).toHaveLength(4);
  });

  it("reuses a pool across project roots within the same execution runtime", () => {
    expect(
      codexAppServerPoolKey({ kind: "windows", path: "C:\\repo-a" }, [browserServer("local-a")]),
    ).toBe(
      codexAppServerPoolKey({ kind: "windows", path: "D:\\repo-b" }, [browserServer("local-b")]),
    );
    expect(
      codexAppServerPoolKey({ kind: "posix", path: "/repo-a" }, [browserServer("local-a")]),
    ).toBe(codexAppServerPoolKey({ kind: "posix", path: "/repo-b" }, [browserServer("local-b")]));
    expect(
      codexAppServerPoolKey(
        {
          kind: "wsl",
          distro: "Ubuntu",
          linuxPath: "/repo-a",
          uncPath: "\\\\wsl$\\Ubuntu\\repo-a",
        },
        [browserServer("local-a")],
        "C:\\Windows\\System32\\wsl.exe",
        "/usr/bin/node",
      ),
    ).toBe(
      codexAppServerPoolKey(
        {
          kind: "wsl",
          distro: "Ubuntu",
          linuxPath: "/repo-b",
          uncPath: "\\\\wsl$\\Ubuntu\\repo-b",
        },
        [browserServer("local-b")],
        "C:\\Windows\\System32\\wsl.exe",
        "/usr/bin/node",
      ),
    );
  });

  it("keeps different WSL launch runtimes in separate pools", () => {
    const location = {
      kind: "wsl" as const,
      distro: "Ubuntu",
      linuxPath: "/repo",
      uncPath: "\\\\wsl$\\Ubuntu\\repo",
    };
    const server = browserServer("local-a");
    const baseline = codexAppServerPoolKey(location, [server], "wsl.exe", "/usr/bin/node");

    expect(codexAppServerPoolKey(location, [server], "other-wsl.exe", "/usr/bin/node")).not.toBe(
      baseline,
    );
    expect(codexAppServerPoolKey(location, [server], "wsl.exe", "/opt/node/bin/node")).not.toBe(
      baseline,
    );
  });

  it.each(["app-controls", "browser", "computer-use"])(
    "normalizes thread-scoped query values for %s",
    (id) => {
      const first = httpServer(
        id,
        `http://127.0.0.1:9000/mcp?thread=local-a&title=first&disable=one&stable=yes`,
      );
      const second = httpServer(
        id,
        `http://127.0.0.1:9000/mcp?thread=local-b&title=second&disable=two&stable=yes`,
      );

      expect(codexAppServerPoolKey({ kind: "windows", path: "C:\\repo" }, [first])).toBe(
        codexAppServerPoolKey({ kind: "windows", path: "C:\\repo" }, [second]),
      );
    },
  );

  it.each(["app-controls", "browser", "computer-use"])(
    "includes signed launch credentials in the pool identity for %s",
    (id) => {
      const first = httpServer(
        id,
        "http://127.0.0.1:9000/mcp?thread=local-a",
        "yspace-mcp-v1.thread-a.signature",
      );
      const second = httpServer(
        id,
        "http://127.0.0.1:9000/mcp?thread=local-b",
        "yspace-mcp-v1.thread-b.signature",
      );

      expect(codexAppServerPoolKey({ kind: "windows", path: "C:\\repo" }, [first])).not.toBe(
        codexAppServerPoolKey({ kind: "windows", path: "C:\\repo" }, [second]),
      );
    },
  );

  it("includes the WSL launch-context header in the pool identity", () => {
    const first = httpServer("browser", "http://127.0.0.1:9000/mcp?thread=local-a");
    const second = httpServer("browser", "http://127.0.0.1:9000/mcp?thread=local-b");
    if (first.transport.type === "stdio" || second.transport.type === "stdio") {
      throw new Error("Expected HTTP MCP fixtures.");
    }
    first.transport.headers["x-y-space-mcp-context"] = "yspace-mcp-v1.thread-a.signature";
    second.transport.headers["x-y-space-mcp-context"] = "yspace-mcp-v1.thread-b.signature";

    expect(codexAppServerPoolKey({ kind: "windows", path: "C:\\repo" }, [first])).not.toBe(
      codexAppServerPoolKey({ kind: "windows", path: "C:\\repo" }, [second]),
    );
  });

  it("does not normalize custom MCP query values", () => {
    const first = httpServer("custom", "http://127.0.0.1:9000/mcp?thread=local-a");
    const second = httpServer("custom", "http://127.0.0.1:9000/mcp?thread=local-b");

    expect(codexAppServerPoolKey({ kind: "windows", path: "C:\\repo" }, [first])).not.toBe(
      codexAppServerPoolKey({ kind: "windows", path: "C:\\repo" }, [second]),
    );
  });

  it("does not reuse a pool when MCP credentials differ", () => {
    const first = httpServer("browser", "http://127.0.0.1:9000/mcp?thread=local-a", "token-a");
    const second = httpServer("browser", "http://127.0.0.1:9000/mcp?thread=local-b", "token-b");

    expect(codexAppServerPoolKey({ kind: "windows", path: "C:\\repo" }, [first])).not.toBe(
      codexAppServerPoolKey({ kind: "windows", path: "C:\\repo" }, [second]),
    );
  });

  it("evicts an exited process before the next acquisition", async () => {
    const firstChild = fakeChildProcess();
    mocks.spawn.mockImplementationOnce(() => firstChild);
    const launch = input("local-a", browserServer("local-a"));

    await acquireCodexAppServer(launch);
    firstChild.emit("exit", 1);
    expect(mocks.commandCleanup).toHaveBeenCalledOnce();
    await acquireCodexAppServer(launch);

    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });

  it("evicts a failed spawn so the next acquisition can retry", async () => {
    mocks.spawn.mockImplementationOnce(() => {
      const child = fakeChildProcess();
      queueMicrotask(() => child.emit("error", new Error("spawn failed")));
      return child;
    });

    const launch = input("local-a", browserServer("local-a"));
    await expect(acquireCodexAppServer(launch)).rejects.toThrow(
      "Codex app-server failed to spawn: spawn failed",
    );
    expect(mocks.commandCleanup).toHaveBeenCalledOnce();
    await acquireCodexAppServer(launch);

    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });

  it("cleans launch artifacts when spawn throws synchronously", async () => {
    mocks.spawn.mockImplementationOnce(() => {
      throw new Error("synchronous spawn failure");
    });

    await expect(acquireCodexAppServer(input("local-a", browserServer("local-a")))).rejects.toThrow(
      "synchronous spawn failure",
    );
    expect(mocks.commandCleanup).toHaveBeenCalledOnce();
  });
});
