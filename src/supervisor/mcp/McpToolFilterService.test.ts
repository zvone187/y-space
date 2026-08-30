import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@/shared/contracts";
import { buildCodexMcp } from "@/supervisor/agents/userMcp";
import {
  getMcpToolFilterCleanup,
  prepareMcpToolFilters,
  type McpToolFilterDependencies,
} from "./McpToolFilterService";

const originalHelpersDir = process.env.PORACODE_WSL_HELPERS_DIR;

afterEach(() => {
  if (originalHelpersDir === undefined) delete process.env.PORACODE_WSL_HELPERS_DIR;
  else process.env.PORACODE_WSL_HELPERS_DIR = originalHelpersDir;
});

function server(disabledTools?: string[]): McpServer {
  return {
    id: "neutral-tools",
    name: "utilities",
    description: "General utilities",
    enabled: true,
    timeoutMs: 30_000,
    ...(disabledTools ? { disabledTools } : {}),
    transport: {
      type: "http",
      url: "https://tools.example.test/mcp",
      headers: { Authorization: "Bearer secret" },
    },
  };
}

function decodeFilterConfig(filtered: McpServer): Record<string, unknown> {
  expect(filtered.transport.type).toBe("stdio");
  if (filtered.transport.type !== "stdio") throw new Error("Expected filter transport");
  const configEnvName = filtered.transport.args[1];
  expect(configEnvName).toMatch(/^PORACODE_MCP_FILTER_CONFIG_[A-F0-9]{24}$/u);
  const encoded = configEnvName ? filtered.transport.env[configEnvName] : undefined;
  expect(encoded).toBeTruthy();
  return JSON.parse(Buffer.from(encoded!, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("prepareMcpToolFilters", () => {
  it("does not require a worker when there are no MCP servers to wrap", async () => {
    delete process.env.PORACODE_WSL_HELPERS_DIR;

    await expect(
      prepareMcpToolFilters([], { kind: "posix", path: process.cwd() }, true),
    ).resolves.toEqual([]);
  });

  it("leaves unrestricted servers direct outside Browser-exclusive sessions", async () => {
    const original = server();
    await expect(
      prepareMcpToolFilters([original], { kind: "posix", path: process.cwd() }),
    ).resolves.toEqual([original]);
  });

  it("wraps every neutral server for advertised-tool filtering in Browser-exclusive sessions", async () => {
    process.env.PORACODE_WSL_HELPERS_DIR = resolve(process.cwd(), "resources/wsl-helpers");
    const [filtered] = await prepareMcpToolFilters(
      [server()],
      { kind: "posix", path: process.cwd() },
      true,
    );

    expect(filtered).toBeDefined();
    const config = decodeFilterConfig(filtered!);
    expect(config.browserExclusive).toBe(true);
    expect(config.server).toMatchObject({
      id: "neutral-tools",
      name: "utilities",
      transport: { type: "http", url: "https://tools.example.test/mcp" },
    });
  });

  it("retains explicit disabled-tool filtering outside Browser-exclusive sessions", async () => {
    process.env.PORACODE_WSL_HELPERS_DIR = resolve(process.cwd(), "resources/wsl-helpers");
    const [filtered] = await prepareMcpToolFilters(
      [server(["delete_record"])],
      { kind: "posix", path: process.cwd() },
      false,
    );

    const config = decodeFilterConfig(filtered!);
    expect(config.browserExclusive).toBe(false);
    expect(config.disabledTools).toEqual(["delete_record"]);
  });

  it("gives each wrapper a unique config variable so Codex can launch multiple filtered MCPs", async () => {
    process.env.PORACODE_WSL_HELPERS_DIR = resolve(process.cwd(), "resources/wsl-helpers");
    const first = server();
    const second = {
      ...server(),
      id: "second-tools",
      name: "second-utilities",
      transport: {
        type: "http" as const,
        url: "https://second.example.test/mcp",
        headers: { Authorization: "Bearer second-secret" },
      },
    };

    const filtered = await prepareMcpToolFilters(
      [first, second],
      { kind: "posix", path: process.cwd() },
      true,
    );
    const configNames = filtered.map((entry) => {
      if (entry.transport.type !== "stdio") throw new Error("Expected filter transport");
      return entry.transport.args[1];
    });

    expect(new Set(configNames).size).toBe(2);
    expect(() => buildCodexMcp(filtered)).not.toThrow();
  });

  it("gives each long-lived WSL filter worker its own deferred cleanup path", async () => {
    const cleanupFirst = vi.fn<() => void>();
    const cleanupSecond = vi.fn<() => void>();
    const deploy = vi
      .fn<NonNullable<McpToolFilterDependencies["deploy"]>>()
      .mockReturnValueOnce({
        linuxBaseDir: "/tmp/poracode-mcp-filter-1-first",
        cleanup: cleanupFirst,
      })
      .mockReturnValueOnce({
        linuxBaseDir: "/tmp/poracode-mcp-filter-1-second",
        cleanup: cleanupSecond,
      });
    const dependencies: McpToolFilterDependencies = {
      resolveNode: async () => ({
        nodePath: "/usr/bin/node",
        nodeVersion: "24.10.0",
        source: "user-installed",
      }),
      deploy,
    };

    const filtered = await prepareMcpToolFilters(
      [server(), { ...server(), id: "second", name: "second" }],
      {
        kind: "wsl",
        distro: "Ubuntu",
        linuxPath: "/home/demo/workspace",
        uncPath: "\\\\wsl.localhost\\Ubuntu\\home\\demo\\workspace",
      },
      true,
      dependencies,
    );

    expect(deploy).toHaveBeenCalledTimes(2);
    expect(cleanupFirst).not.toHaveBeenCalled();
    expect(cleanupSecond).not.toHaveBeenCalled();
    expect(
      filtered.map((entry) => entry.transport.type === "stdio" && entry.transport.args.at(-1)),
    ).toEqual(["/tmp/poracode-mcp-filter-1-first", "/tmp/poracode-mcp-filter-1-second"]);

    const release = getMcpToolFilterCleanup(filtered);
    expect(release).toBeTypeOf("function");
    release?.();
    release?.();
    expect(cleanupFirst).toHaveBeenCalledOnce();
    expect(cleanupSecond).toHaveBeenCalledOnce();
  });

  it("cleans already-staged filter workers if a later deployment fails", async () => {
    const cleanup = vi.fn<() => void>();
    const deploy = vi
      .fn<NonNullable<McpToolFilterDependencies["deploy"]>>()
      .mockReturnValueOnce({ linuxBaseDir: "/tmp/first", cleanup })
      .mockReturnValueOnce(null);

    await expect(
      prepareMcpToolFilters(
        [server(), { ...server(), id: "second", name: "second" }],
        {
          kind: "wsl",
          distro: "Ubuntu",
          linuxPath: "/home/demo/workspace",
          uncPath: "\\\\wsl.localhost\\Ubuntu\\home\\demo\\workspace",
        },
        true,
        {
          resolveNode: async () => ({
            nodePath: "/usr/bin/node",
            nodeVersion: "24.10.0",
            source: "user-installed",
          }),
          deploy,
        },
      ),
    ).rejects.toThrow("could not be deployed");
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
