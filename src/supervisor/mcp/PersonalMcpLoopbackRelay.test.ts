import { afterEach, describe, expect, it, vi } from "vitest";
import { PIPEDREAM_PERSONAL_MCP_URL } from "@/shared/contracts";
import { PersonalMcpLoopbackRelay } from "./PersonalMcpLoopbackRelay";

const relays: PersonalMcpLoopbackRelay[] = [];

afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.dispose()));
});

describe("PersonalMcpLoopbackRelay", () => {
  it("requires the opaque launch bearer and injects the upstream token only inside supervisor fetch", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer upstream-private");
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), {
        headers: { "content-type": "application/json" },
      });
    });
    const relay = new PersonalMcpLoopbackRelay({
      getAccessToken: async () => "upstream-private",
      fetch: fetchMock,
    });
    relays.push(relay);
    const binding = await relay.registerBinding({
      threadId: "thread-a",
      providerBindingId: "thread:thread-a:launch:launch-a",
      credentialUrl: PIPEDREAM_PERSONAL_MCP_URL,
      upstreamUrl: PIPEDREAM_PERSONAL_MCP_URL,
    });

    await expect(
      fetch(binding.url, {
        method: "POST",
        headers: { authorization: "Bearer wrong", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    ).resolves.toMatchObject({ status: 401 });
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(
      fetch(binding.url, {
        method: "POST",
        headers: { ...binding.headers, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    ).resolves.toMatchObject({ status: 200 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("revokes one thread without disturbing a sibling launch and accepts its trusted WSL gateway host", async () => {
    const relay = new PersonalMcpLoopbackRelay({
      getAccessToken: async () => "upstream-private",
      fetch: vi.fn<typeof fetch>(async () => new Response("ok")),
    });
    relays.push(relay);
    const first = await relay.registerBinding({
      threadId: "thread-a",
      providerBindingId: "thread:thread-a:launch:launch-a",
      credentialUrl: PIPEDREAM_PERSONAL_MCP_URL,
      upstreamUrl: PIPEDREAM_PERSONAL_MCP_URL,
      advertisedHost: "172.24.32.1",
    });
    const second = await relay.registerBinding({
      threadId: "thread-b",
      providerBindingId: "thread:thread-b:launch:launch-b",
      credentialUrl: PIPEDREAM_PERSONAL_MCP_URL,
      upstreamUrl: PIPEDREAM_PERSONAL_MCP_URL,
    });
    expect(new URL(first.url).hostname).toBe("172.24.32.1");
    const firstFromHost = new URL(first.url);
    firstFromHost.hostname = "127.0.0.1";

    relay.unregisterThread("thread-a");

    await expect(fetch(firstFromHost, { headers: first.headers })).resolves.toMatchObject({
      status: 404,
    });
    await expect(fetch(second.url, { headers: second.headers })).resolves.toMatchObject({
      status: 200,
    });
  });
});
