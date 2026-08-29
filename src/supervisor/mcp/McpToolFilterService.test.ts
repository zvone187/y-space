import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { McpServer } from "@/shared/contracts";
import { buildCodexMcp } from "@/supervisor/agents/userMcp";
import { prepareMcpToolFilters } from "./McpToolFilterService";

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
});
