import { access } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILT_IN_MCP_SERVER_IDS, isValidMcpServerName, threadConfigSchema } from "./contracts";

describe("external browser control retirement", () => {
  it("exposes only the embedded browser as a built-in browser MCP", () => {
    expect(BUILT_IN_MCP_SERVER_IDS).toEqual([
      "browser",
      "crossagents",
      "computer-use",
      "app-controls",
    ]);
    expect(isValidMcpServerName("chrome")).toBe(true);
  });

  it("drops the retired chromeMcp launch flag from persisted legacy input", () => {
    expect(threadConfigSchema.parse({ model: "test", chromeMcp: true })).toEqual({
      model: "test",
    });
  });

  it.each([
    ["external browser implementation", "src/main/browser/external"],
    ["external browser launch adapter", "src/supervisor/agents/chromeMcp"],
    ["external browser plugin", "resources/plugins/chrome-tools"],
  ])("does not ship the %s", async (_label, relativePath) => {
    await expect(access(join(process.cwd(), relativePath))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
