import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createMcpLaunchContextToken, verifyMcpLaunchContextToken } from "./mcpLaunchContext";

describe("MCP launch contexts", () => {
  const rootToken = "a".repeat(64);

  it("binds a thread identity and disabled-tool policy to a signed bearer", () => {
    const token = createMcpLaunchContextToken(rootToken, "browser", {
      threadId: "thread-1",
      launchId: "launch-1",
      title: "Trusted task",
      disabledTools: ["close_tab"],
    });

    expect(verifyMcpLaunchContextToken(rootToken, "browser", token)).toEqual({
      routing: "thread",
      identity: {
        threadId: "thread-1",
        launchId: "launch-1",
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

  it("rejects a correctly signed legacy provider-binding credential", () => {
    const encoded = Buffer.from(
      JSON.stringify({
        v: 1,
        audience: "app-controls",
        routing: "provider-session",
        providerBindingId: "opencode-gui:shared-directory",
      }),
      "utf8",
    ).toString("base64url");
    const signature = createHmac("sha256", rootToken).update(encoded).digest("base64url");
    const token = `yspace-mcp-v1.${encoded}.${signature}`;

    expect(verifyMcpLaunchContextToken(rootToken, "app-controls", token)).toBeUndefined();
  });

  it("refuses to mint a capability without a concrete thread", () => {
    expect(() => createMcpLaunchContextToken(rootToken, "browser", {})).toThrow(/thread identity/i);
  });
});
