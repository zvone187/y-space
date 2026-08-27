import { afterEach, describe, expect, it } from "vitest";
import { MCP_LAUNCH_CONTEXT_HEADER, verifyMcpLaunchContextToken } from "@/shared/mcpLaunchContext";
import {
  BROWSER_MCP_TOKEN_ENV,
  BROWSER_MCP_URL_ENV,
  resolveBrowserMcpHttpConfigForLaunch,
} from ".";

const savedUrl = process.env[BROWSER_MCP_URL_ENV];
const savedToken = process.env[BROWSER_MCP_TOKEN_ENV];

afterEach(() => {
  if (savedUrl === undefined) delete process.env[BROWSER_MCP_URL_ENV];
  else process.env[BROWSER_MCP_URL_ENV] = savedUrl;
  if (savedToken === undefined) delete process.env[BROWSER_MCP_TOKEN_ENV];
  else process.env[BROWSER_MCP_TOKEN_ENV] = savedToken;
});

describe("Browser MCP launch capability", () => {
  it("does not expose the root credential and binds native thread policy", async () => {
    process.env[BROWSER_MCP_URL_ENV] = "http://127.0.0.1:43210";
    process.env[BROWSER_MCP_TOKEN_ENV] = "root-browser-token";

    const config = await resolveBrowserMcpHttpConfigForLaunch({ kind: "posix" }, true, undefined, {
      threadId: "thread-1",
      title: "Task",
      disabledTools: ["close_tab"],
    });

    expect(config?.token).not.toBe("root-browser-token");
    expect(config?.url).toBe("http://127.0.0.1:43210/mcp");
    expect(
      verifyMcpLaunchContextToken("root-browser-token", "browser", config?.token ?? ""),
    ).toEqual({
      routing: "thread",
      identity: { threadId: "thread-1", title: "Task", disabledTools: ["close_tab"] },
    });
  });

  it("forwards a signed context through the WSL bridge without exposing the root", async () => {
    process.env[BROWSER_MCP_URL_ENV] = "http://127.0.0.1:43210";
    process.env[BROWSER_MCP_TOKEN_ENV] = "root-browser-token";

    const config = await resolveBrowserMcpHttpConfigForLaunch(
      { kind: "wsl", distro: "Ubuntu" },
      true,
      { ensureBridge: async () => ({ baseUrl: "http://127.0.0.1:45000", secret: "bridge" }) },
      { threadId: "thread-wsl", disabledTools: ["close_tab"] },
    );

    expect(config).toMatchObject({
      url: "http://127.0.0.1:45000/mcp",
      token: "bridge",
      headers: { Authorization: "Bearer bridge" },
    });
    expect(
      verifyMcpLaunchContextToken(
        "root-browser-token",
        "browser",
        config?.headers[MCP_LAUNCH_CONTEXT_HEADER] ?? "",
      ),
    ).toEqual({
      routing: "thread",
      identity: { threadId: "thread-wsl", disabledTools: ["close_tab"] },
    });
  });

  it("returns no credential for an explicit Browser opt-out", async () => {
    process.env[BROWSER_MCP_URL_ENV] = "http://127.0.0.1:43210";
    process.env[BROWSER_MCP_TOKEN_ENV] = "root-browser-token";

    await expect(
      resolveBrowserMcpHttpConfigForLaunch({ kind: "posix" }, false, undefined, {
        threadId: "thread-disabled",
      }),
    ).resolves.toBeUndefined();
  });
});
