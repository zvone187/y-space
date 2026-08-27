import { afterEach, describe, expect, it, vi } from "vitest";
import { PipedreamLoopbackRelay } from "./PipedreamLoopbackRelay";

function requestBody(method: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} });
}

describe("PipedreamLoopbackRelay", () => {
  const relays: PipedreamLoopbackRelay[] = [];

  afterEach(async () => {
    await Promise.all(relays.splice(0).map((relay) => relay.dispose()));
  });

  function makeRelay(upstreamFetch: typeof fetch) {
    const invalidateAccessToken = vi.fn<() => void>();
    const relay = new PipedreamLoopbackRelay({
      projectId: "proj_Test123",
      environment: "development",
      externalUserId: "y-space-install-private-id",
      getAccessToken: async () => "developer-token-private",
      invalidateAccessToken,
      fetch: upstreamFetch,
    });
    relays.push(relay);
    return { relay, invalidateAccessToken };
  }

  it("requires a per-launch bearer and pins all upstream routing headers", async () => {
    const upstreamFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), {
          headers: { "content-type": "application/json" },
        }),
    );
    const { relay } = makeRelay(upstreamFetch);
    const binding = await relay.registerBinding({
      threadId: "thread-a",
      providerBindingId: "provider-session-a",
      appSlug: "slack",
      accountId: "apn_Account123",
    });

    await expect(
      fetch(binding.url, { method: "POST", body: requestBody("tools/list") }),
    ).resolves.toMatchObject({ status: 401 });
    const response = await fetch(binding.url, {
      method: "POST",
      headers: {
        ...binding.headers,
        "content-type": "application/json",
        authorization: binding.headers.authorization,
        "x-pd-project-id": "proj_Attacker",
        "x-pd-account-id": "apn_Attacker",
        cookie: "attacker=true",
      },
      body: requestBody("tools/list"),
    });
    expect(response.status).toBe(200);

    const [input, init] = upstreamFetch.mock.calls[0]!;
    expect(String(input)).toBe("https://remote.mcp.pipedream.net/v3");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer developer-token-private");
    expect(headers.get("x-pd-project-id")).toBe("proj_Test123");
    expect(headers.get("x-pd-external-user-id")).toBe("y-space-install-private-id");
    expect(headers.get("x-pd-app-slug")).toBe("slack");
    expect(headers.get("x-pd-account-id")).toBe("apn_Account123");
    expect(headers.has("cookie")).toBe(false);
  });

  it("binds upstream MCP sessions to one current launch binding", async () => {
    const upstreamFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
          headers: { "content-type": "application/json", "mcp-session-id": "upstream-session" },
        }),
    );
    const { relay } = makeRelay(upstreamFetch);
    const a = await relay.registerBinding({
      threadId: "thread-a",
      providerBindingId: "provider-a",
      appSlug: "slack",
      accountId: "apn_Account123",
    });
    const b = await relay.registerBinding({
      threadId: "thread-b",
      providerBindingId: "provider-b",
      appSlug: "slack",
      accountId: "apn_Account123",
    });

    const initialized = await fetch(a.url, {
      method: "POST",
      headers: { ...a.headers, "content-type": "application/json" },
      body: requestBody("initialize"),
    });
    expect(initialized.headers.get("mcp-session-id")).toBe("upstream-session");
    const replay = await fetch(b.url, {
      method: "POST",
      headers: {
        ...b.headers,
        "content-type": "application/json",
        "mcp-session-id": "upstream-session",
      },
      body: requestBody("tools/list"),
    });
    expect(replay.status).toBe(403);
    expect(upstreamFetch).toHaveBeenCalledOnce();
  });

  it("refreshes and retries reads once after 401 but never replays tools/call", async () => {
    const upstreamFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), {
          headers: { "content-type": "application/json" },
        }),
      );
    const { relay, invalidateAccessToken } = makeRelay(upstreamFetch);
    const binding = await relay.registerBinding({
      threadId: "thread-a",
      providerBindingId: "provider-a",
      appSlug: "slack",
      accountId: "apn_Account123",
    });

    expect(
      (
        await fetch(binding.url, {
          method: "POST",
          headers: { ...binding.headers, "content-type": "application/json" },
          body: requestBody("tools/list"),
        })
      ).status,
    ).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledTimes(2);
    expect(invalidateAccessToken).toHaveBeenCalledOnce();

    upstreamFetch.mockReset();
    upstreamFetch.mockResolvedValue(new Response(null, { status: 401 }));
    invalidateAccessToken.mockClear();
    expect(
      (
        await fetch(binding.url, {
          method: "POST",
          headers: { ...binding.headers, "content-type": "application/json" },
          body: requestBody("tools/call"),
        })
      ).status,
    ).toBe(401);
    expect(upstreamFetch).toHaveBeenCalledOnce();
    expect(invalidateAccessToken).toHaveBeenCalledOnce();
  });
});
