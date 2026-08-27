import { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpThreadIdentity } from "@/shared/browserMcpThread";
import { createMcpLaunchContextToken } from "@/shared/mcpLaunchContext";
import {
  StreamableHttpMcpIngress,
  type StreamableHttpMcpIngressInfo,
  type StreamableHttpMcpIngressOptions,
} from "./StreamableHttpMcpIngress";

let ingress: StreamableHttpMcpIngress<{ ok: true }> | null = null;

function makeIngress(): StreamableHttpMcpIngress<{ ok: true }> {
  return new StreamableHttpMcpIngress<{ ok: true }>({
    // Match the computer-use consumer: loopback-only bind.
    bindHost: "127.0.0.1",
    serverInfo: { name: "test", version: "0.0.0" },
    instructions: "test",
    tools: [{ name: "noop", description: "noop", inputSchema: { type: "object" } }],
    isKnownToolName: (name) => name === "noop",
    buildContext: () => ({ ok: true }),
    dispatchTool: () => Promise.resolve({}),
    formatToolResult: () => ({ content: [{ type: "text", text: "ok" }] }),
  });
}

function makeScopedIngress(): StreamableHttpMcpIngress<RoutedContext> {
  return new StreamableHttpMcpIngress<RoutedContext>({
    bindHost: "127.0.0.1",
    launchContextAudience: "browser",
    serverInfo: { name: "scoped", version: "0.0.0" },
    instructions: "scoped",
    tools: [{ name: "noop", description: "noop", inputSchema: { type: "object" } }],
    isKnownToolName: (name) => name === "noop",
    buildContext: (identity) => ({ identity }),
    dispatchTool: (_name, _args, ctx) => Promise.resolve(ctx.identity),
    formatToolResult: (_name, result) => ({
      content: [{ type: "text", text: JSON.stringify(result) }],
    }),
  });
}

const PROVIDER_SESSION_ID_ARG = "__poracode_provider_session_id";

interface RoutedContext {
  identity: McpThreadIdentity;
}

function makeProviderSessionIngress(
  resolveProviderSessionIdentity: (
    providerSessionId: string,
  ) => Promise<McpThreadIdentity | undefined>,
) {
  const dispatchTool = vi.fn<
    (
      name: string,
      args: Record<string, unknown>,
      ctx: RoutedContext,
    ) => Promise<{ args: Record<string, unknown>; identity: McpThreadIdentity }>
  >(async (_name: string, args: Record<string, unknown>, ctx: RoutedContext) => ({
    args,
    identity: ctx.identity,
  }));
  const options: StreamableHttpMcpIngressOptions<RoutedContext> & {
    resolveProviderSessionIdentity(
      providerSessionId: string,
    ): Promise<McpThreadIdentity | undefined>;
  } = {
    bindHost: "127.0.0.1",
    launchContextAudience: "app-controls",
    serverInfo: { name: "routed", version: "0.0.0" },
    instructions: "routed",
    tools: [{ name: "noop", description: "noop", inputSchema: { type: "object" } }],
    isKnownToolName: (name) => name === "noop",
    resolveProviderSessionIdentity,
    buildContext: (identity) => ({ identity }),
    dispatchTool,
    formatToolResult: (_name, result) => ({
      content: [{ type: "text", text: JSON.stringify(result) }],
    }),
  };
  return {
    ingress: new StreamableHttpMcpIngress<RoutedContext>(options),
    dispatchTool,
  };
}

async function callWithProviderSession(
  info: StreamableHttpMcpIngressInfo,
  providerSessionId: string,
  query = "",
) {
  const launchToken = createMcpLaunchContextToken(info.token, "app-controls");
  const response = await fetch(`${info.url}/mcp${query}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${launchToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "noop",
        arguments: { [PROVIDER_SESSION_ID_ARG]: providerSessionId, value: "kept" },
      },
    }),
  });
  return (await response.json()) as {
    result: { isError?: boolean; content: Array<{ type: "text"; text: string }> };
  };
}

/**
 * `fetch` treats `Host` as a forbidden header and silently overrides it, so a
 * DNS-rebinding test needs a raw request that actually sends the forged host.
 */
function rawRequest(port: number, headers: Record<string, string>): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/mcp", method: "POST", headers },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  });
}

afterEach(() => {
  ingress?.dispose();
  ingress = null;
});

describe("StreamableHttpMcpIngress auth + host guards", () => {
  it("binds identity and disabled tools to a signed launch credential", async () => {
    ingress = makeScopedIngress() as unknown as StreamableHttpMcpIngress<{ ok: true }>;
    const info = await ingress.start();
    const launchToken = createMcpLaunchContextToken(info.token, "browser", {
      threadId: "trusted-thread",
      title: "Trusted task",
      disabledTools: ["noop"],
    });
    const headers = {
      authorization: `Bearer ${launchToken}`,
      "content-type": "application/json",
    };
    const list = await fetch(`${info.url}/mcp?thread=spoofed-thread&title=Spoofed&disable=`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect((await list.json()).result.tools).toEqual([]);

    const call = await fetch(`${info.url}/mcp?thread=spoofed-thread`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "noop", arguments: {} },
      }),
    });
    expect((await call.json()).result).toMatchObject({ isError: true });

    const rootCredential = await fetch(`${info.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${info.token}`,
        "x-y-space-mcp-context": launchToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
    });
    expect(rootCredential.status).toBe(401);
  });

  it("accepts a valid bearer token and rejects a wrong one", async () => {
    ingress = makeIngress();
    const info = await ingress.start();

    const ok = await rawRequest(info.port, {
      Host: `127.0.0.1:${info.port}`,
      Authorization: `Bearer ${info.token}`,
      "Content-Type": "application/json",
    });
    expect(ok.status).toBe(200);

    const wrong = await rawRequest(info.port, {
      Host: `127.0.0.1:${info.port}`,
      Authorization: "Bearer not-the-token",
      "Content-Type": "application/json",
    });
    expect(wrong.status).toBe(401);

    // A same-length but wrong token must also fail (constant-time compare path).
    const sameLength = "0".repeat(info.token.length);
    const wrongSameLength = await rawRequest(info.port, {
      Host: `127.0.0.1:${info.port}`,
      Authorization: `Bearer ${sameLength}`,
      "Content-Type": "application/json",
    });
    expect(wrongSameLength.status).toBe(401);
  });

  it("rejects a foreign DNS Host but allows loopback and IP-literal hosts", async () => {
    ingress = makeIngress();
    const info = await ingress.start();

    const base = { Authorization: `Bearer ${info.token}`, "Content-Type": "application/json" };

    // DNS-rebinding: a real hostname is refused even with a valid token.
    const rebinding = await rawRequest(info.port, { ...base, Host: "evil.example.com" });
    expect(rebinding.status).toBe(403);

    // Loopback by name and by IP literal are accepted (WSL reaches the browser
    // ingress via the host-gateway IP literal, which must keep working).
    const loopbackName = await rawRequest(info.port, { ...base, Host: `localhost:${info.port}` });
    expect(loopbackName.status).toBe(200);

    const loopbackIp = await rawRequest(info.port, { ...base, Host: `127.0.0.1:${info.port}` });
    expect(loopbackIp.status).toBe(200);
  });
});

describe("StreamableHttpMcpIngress trusted provider-session identity", () => {
  it("resolves identity and strips the private routing argument before dispatch", async () => {
    const resolver = vi.fn<(providerSessionId: string) => Promise<McpThreadIdentity | undefined>>(
      async (providerSessionId) =>
        providerSessionId === "session-trusted"
          ? { threadId: "thread-1", title: "Trusted caller" }
          : undefined,
    );
    const routed = makeProviderSessionIngress(resolver);
    try {
      const info = await routed.ingress.start();
      const body = await callWithProviderSession(info, "session-trusted");

      expect(body.result.isError).toBeUndefined();
      expect(resolver).toHaveBeenCalledWith("session-trusted");
      expect(routed.dispatchTool).toHaveBeenCalledWith(
        "noop",
        { value: "kept" },
        { identity: { threadId: "thread-1", title: "Trusted caller" } },
      );
    } finally {
      routed.ingress.dispose();
    }
  });

  it("fails closed when the provider session is stale", async () => {
    const resolver = vi.fn<() => Promise<McpThreadIdentity | undefined>>(async () => undefined);
    const routed = makeProviderSessionIngress(resolver);
    try {
      const info = await routed.ingress.start();
      const body = await callWithProviderSession(info, "session-stale");

      expect(body.result.isError).toBe(true);
      expect(resolver).toHaveBeenCalledWith("session-stale");
      expect(routed.dispatchTool).not.toHaveBeenCalled();
    } finally {
      routed.ingress.dispose();
    }
  });

  it("fails closed when a provider-routed tool call omits its private session id", async () => {
    const resolver = vi.fn<() => Promise<McpThreadIdentity | undefined>>(async () => ({
      threadId: "thread-1",
    }));
    const routed = makeProviderSessionIngress(resolver);
    try {
      const info = await routed.ingress.start();
      const launchToken = createMcpLaunchContextToken(info.token, "app-controls");
      const response = await fetch(`${info.url}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${launchToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "noop", arguments: {} },
        }),
      });
      const body = (await response.json()) as { result: { isError?: boolean } };

      expect(body.result.isError).toBe(true);
      expect(resolver).not.toHaveBeenCalled();
      expect(routed.dispatchTool).not.toHaveBeenCalled();
    } finally {
      routed.ingress.dispose();
    }
  });

  it("enforces disabled tools returned by trusted provider-session resolution", async () => {
    const resolver = vi.fn<() => Promise<McpThreadIdentity | undefined>>(async () => ({
      threadId: "thread-1",
      disabledTools: ["noop"],
    }));
    const routed = makeProviderSessionIngress(resolver);
    try {
      const info = await routed.ingress.start();
      const body = await callWithProviderSession(info, "session-disabled");

      expect(body.result.isError).toBe(true);
      expect(routed.dispatchTool).not.toHaveBeenCalled();
    } finally {
      routed.ingress.dispose();
    }
  });

  it("keeps the signed launch identity authoritative over spoofed URL metadata", async () => {
    const resolver = vi.fn<() => Promise<McpThreadIdentity | undefined>>(async () => ({
      threadId: "provider-thread",
      title: "Provider caller",
    }));
    const routed = makeProviderSessionIngress(resolver);
    try {
      const info = await routed.ingress.start();
      const launchToken = createMcpLaunchContextToken(info.token, "app-controls", {
        threadId: "trusted-thread",
        title: "Trusted caller",
      });
      const response = await fetch(`${info.url}/mcp?thread=spoofed-thread&title=Spoofed%20caller`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${launchToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "noop",
            arguments: {
              [PROVIDER_SESSION_ID_ARG]: "session-forged",
              value: "kept",
            },
          },
        }),
      });
      const body = (await response.json()) as {
        result: { isError?: boolean; content: Array<{ type: "text"; text: string }> };
      };

      expect(body.result.isError).toBeUndefined();
      expect(resolver).not.toHaveBeenCalled();
      expect(routed.dispatchTool).toHaveBeenCalledWith(
        "noop",
        { value: "kept" },
        { identity: { threadId: "trusted-thread", title: "Trusted caller" } },
      );
    } finally {
      routed.ingress.dispose();
    }
  });
});
