import { describe, expect, it } from "vitest";
import { createMcpLaunchContextToken, verifyMcpLaunchContextToken } from "./mcpLaunchContext";

describe("MCP launch contexts", () => {
  const rootToken = "a".repeat(64);

  it("binds a thread identity and disabled-tool policy to a signed bearer", () => {
    const token = createMcpLaunchContextToken(rootToken, "browser", {
      threadId: "thread-1",
      title: "Trusted task",
      disabledTools: ["close_tab"],
    });

    expect(verifyMcpLaunchContextToken(rootToken, "browser", token)).toEqual({
      routing: "thread",
      identity: {
        threadId: "thread-1",
        title: "Trusted task",
        disabledTools: ["close_tab"],
      },
    });
  });

  it("rejects tampering, the wrong root secret, and cross-server replay", () => {
    const token = createMcpLaunchContextToken(rootToken, "browser", {
      threadId: "thread-1",
      disabledTools: ["close_tab"],
    });
    const parts = token.split(".");
    const tampered = `${parts[0]}.${parts[1]}x.${parts[2]}`;

    expect(verifyMcpLaunchContextToken(rootToken, "browser", tampered)).toBeUndefined();
    expect(verifyMcpLaunchContextToken("b".repeat(64), "browser", token)).toBeUndefined();
    expect(verifyMcpLaunchContextToken(rootToken, "app-controls", token)).toBeUndefined();
  });

  it("mints a provider-session context when the provider owns thread routing", () => {
    const token = createMcpLaunchContextToken(rootToken, "app-controls");
    expect(verifyMcpLaunchContextToken(rootToken, "app-controls", token)).toEqual({
      routing: "provider-session",
      identity: {},
    });
  });
});
