import { afterEach, describe, expect, it } from "vitest";
import { verifyMcpLaunchContextToken } from "@/shared/mcpLaunchContext";
import {
  COMPUTER_USE_MCP_TOKEN_ENV,
  COMPUTER_USE_MCP_URL_ENV,
  resolveComputerUseMcpHttpConfigForLaunch,
} from ".";

const savedUrl = process.env[COMPUTER_USE_MCP_URL_ENV];
const savedToken = process.env[COMPUTER_USE_MCP_TOKEN_ENV];

afterEach(() => {
  if (savedUrl === undefined) delete process.env[COMPUTER_USE_MCP_URL_ENV];
  else process.env[COMPUTER_USE_MCP_URL_ENV] = savedUrl;
  if (savedToken === undefined) delete process.env[COMPUTER_USE_MCP_TOKEN_ENV];
  else process.env[COMPUTER_USE_MCP_TOKEN_ENV] = savedToken;
});

describe("Computer Use MCP launch capability", () => {
  it("never hands the ingress root or unsigned URL policy to the agent", () => {
    process.env[COMPUTER_USE_MCP_URL_ENV] = "http://127.0.0.1:43212";
    process.env[COMPUTER_USE_MCP_TOKEN_ENV] = "root-computer-token";

    const config = resolveComputerUseMcpHttpConfigForLaunch({ kind: "posix" }, true, {
      threadId: "thread-1",
      disabledTools: ["click"],
    });

    expect(config?.token).not.toBe("root-computer-token");
    expect(config?.url).toBe("http://127.0.0.1:43212/mcp");
    expect(config?.url).not.toContain("thread=");
    expect(
      verifyMcpLaunchContextToken("root-computer-token", "computer-use", config?.token ?? ""),
    ).toEqual({
      routing: "thread",
      identity: { threadId: "thread-1", disabledTools: ["click"] },
    });
  });
});
