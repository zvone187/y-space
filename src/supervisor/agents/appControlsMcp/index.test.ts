import { afterEach, describe, expect, it } from "vitest";
import { verifyMcpLaunchContextToken } from "@/shared/mcpLaunchContext";
import {
  APP_CONTROLS_MCP_TOKEN_ENV,
  APP_CONTROLS_MCP_URL_ENV,
  resolveAppControlsMcpHttpConfigForLaunch,
} from ".";

const savedUrl = process.env[APP_CONTROLS_MCP_URL_ENV];
const savedToken = process.env[APP_CONTROLS_MCP_TOKEN_ENV];

afterEach(() => {
  if (savedUrl === undefined) delete process.env[APP_CONTROLS_MCP_URL_ENV];
  else process.env[APP_CONTROLS_MCP_URL_ENV] = savedUrl;
  if (savedToken === undefined) delete process.env[APP_CONTROLS_MCP_TOKEN_ENV];
  else process.env[APP_CONTROLS_MCP_TOKEN_ENV] = savedToken;
});

describe("App Controls MCP launch capability", () => {
  it("binds thread identity and tool policy without exposing the root credential", async () => {
    process.env[APP_CONTROLS_MCP_URL_ENV] = "http://127.0.0.1:43211";
    process.env[APP_CONTROLS_MCP_TOKEN_ENV] = "root-controls-token";

    const config = await resolveAppControlsMcpHttpConfigForLaunch({ kind: "posix" }, undefined, {
      threadId: "thread-1",
      disabledTools: ["delete_thread"],
    });

    expect(config?.token).not.toBe("root-controls-token");
    expect(config?.url).toBe("http://127.0.0.1:43211/mcp");
    expect(
      verifyMcpLaunchContextToken("root-controls-token", "app-controls", config?.token ?? ""),
    ).toEqual({
      routing: "thread",
      identity: { threadId: "thread-1", disabledTools: ["delete_thread"] },
    });
  });
});
