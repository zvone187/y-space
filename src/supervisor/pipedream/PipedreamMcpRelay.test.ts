import { describe, expect, it } from "vitest";
import {
  PIPEDREAM_MCP_V3_URL,
  PipedreamMcpSessionRegistry,
  buildPipedreamMcpUpstreamHeaders,
  shouldRetryAfterPipedreamUnauthorized,
} from "./PipedreamMcpRelay";

describe("PipedreamMcpRelay security", () => {
  it("pins the v3 endpoint and replaces every caller-controlled auth or routing header", () => {
    const headers = buildPipedreamMcpUpstreamHeaders({
      incoming: new Headers({
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
        "mcp-session-id": "session-a",
        "last-event-id": "event-3",
        authorization: "Bearer attacker",
        "x-pd-project-id": "proj_Attacker",
        "x-pd-environment": "production",
        "x-pd-external-user-id": "someone-else",
        "x-pd-app-slug": "gmail",
        "x-pd-account-id": "apn_Attacker",
        "x-pd-registry": "private",
        cookie: "session=attacker",
        origin: "https://attacker.invalid",
        host: "attacker.invalid",
        "x-forwarded-for": "203.0.113.10",
      }),
      accessToken: "developer-token-private",
      projectId: "proj_Test123",
      environment: "development",
      externalUserId: "y-space-install-private-id",
      appSlug: "slack",
      accountId: "apn_Account123",
    });

    expect(PIPEDREAM_MCP_V3_URL).toBe("https://remote.mcp.pipedream.net/v3");
    expect(headers.get("authorization")).toBe("Bearer developer-token-private");
    expect(headers.get("x-pd-project-id")).toBe("proj_Test123");
    expect(headers.get("x-pd-environment")).toBe("development");
    expect(headers.get("x-pd-external-user-id")).toBe("y-space-install-private-id");
    expect(headers.get("x-pd-app-slug")).toBe("slack");
    expect(headers.get("x-pd-account-id")).toBe("apn_Account123");

    expect(headers.get("accept")).toBe("application/json, text/event-stream");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("mcp-protocol-version")).toBe("2025-06-18");
    expect(headers.get("mcp-session-id")).toBe("session-a");
    expect(headers.get("last-event-id")).toBe("event-3");

    for (const stripped of ["cookie", "origin", "host", "x-forwarded-for", "x-pd-registry"]) {
      expect(headers.has(stripped)).toBe(false);
    }
  });

  it("binds upstream MCP session ids to exactly one local relay binding", () => {
    const sessions = new PipedreamMcpSessionRegistry();

    sessions.bind({ bindingId: "binding-a", sessionId: "session-a" });
    expect(sessions.owns({ bindingId: "binding-a", sessionId: "session-a" })).toBe(true);
    expect(sessions.owns({ bindingId: "binding-b", sessionId: "session-a" })).toBe(false);
    expect(() => sessions.bind({ bindingId: "binding-b", sessionId: "session-a" })).toThrow(
      /session/i,
    );

    sessions.clearBinding("binding-a");
    expect(sessions.owns({ bindingId: "binding-a", sessionId: "session-a" })).toBe(false);
  });

  it("retries a 401 only for handshake and read RPCs, never for tools/call", () => {
    for (const jsonRpcMethod of [
      "initialize",
      "ping",
      "tools/list",
      "resources/list",
      "resources/read",
      "prompts/list",
      "prompts/get",
    ]) {
      expect(shouldRetryAfterPipedreamUnauthorized({ status: 401, jsonRpcMethod })).toBe(true);
    }

    expect(
      shouldRetryAfterPipedreamUnauthorized({ status: 401, jsonRpcMethod: "tools/call" }),
    ).toBe(false);
    expect(
      shouldRetryAfterPipedreamUnauthorized({ status: 500, jsonRpcMethod: "tools/list" }),
    ).toBe(false);
    expect(shouldRetryAfterPipedreamUnauthorized({ status: 401, jsonRpcMethod: undefined })).toBe(
      false,
    );
  });
});
