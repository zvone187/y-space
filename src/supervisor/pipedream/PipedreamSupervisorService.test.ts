import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedMcpServer } from "@/shared/contracts";
import {
  buildClaudeMcpServers,
  buildCodexMcp,
  buildOpenCodeMcpLaunchConfig,
} from "@/supervisor/agents/userMcp";
import { PipedreamSupervisorService } from "./PipedreamSupervisorService";

describe("PipedreamSupervisorService", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function makeService(fetchMock: typeof fetch) {
    const baseDir = await mkdtemp(join(tmpdir(), "y-space-pipedream-service-"));
    roots.push(baseDir);
    return new PipedreamSupervisorService({
      baseDir,
      fetch: fetchMock,
      readPersonalMcpStatus: () => ({ enabled: true, authenticated: true }),
    });
  }

  it("reports partial setup without retaining or exposing partial credentials", async () => {
    const service = await makeService(vi.fn<typeof fetch>());
    service.configure({
      bootstrap: { state: "partial", missingKeys: ["PIPEDREAM_CLIENT_SECRET"] },
      externalUserId: "y-space-private-install-id",
    });

    const snapshot = service.getSnapshot();
    expect(snapshot.connect).toEqual({
      state: "partial",
      missingKeys: ["PIPEDREAM_CLIENT_SECRET"],
    });
    expect(JSON.stringify(snapshot)).not.toContain("y-space-private-install-id");
  });

  it("paginates account reconciliation and uses the verified project display name", async () => {
    const accountRequests: URL[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/oauth/token")) {
        return new Response(
          JSON.stringify({
            access_token: "developer-token",
            token_type: "Bearer",
            expires_in: 600,
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url.pathname.endsWith("/connect/projects/proj_Test123")) {
        return new Response(JSON.stringify({ id: "proj_Test123", name: "Y Space Project" }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname.endsWith("/accounts")) {
        accountRequests.push(url);
        const secondPage = url.searchParams.get("after") === "page-two";
        const suffix = secondPage ? "Github456" : "Account123";
        const slug = secondPage ? "github" : "slack";
        return new Response(
          JSON.stringify({
            data: [
              {
                id: `apn_${suffix}`,
                name: secondPage ? "GitHub" : "Slack",
                healthy: true,
                dead: false,
                created_at: "2026-08-27T12:00:00.000Z",
                app: {
                  id: `app_${suffix}`,
                  name_slug: slug,
                  name: secondPage ? "GitHub" : "Slack",
                },
              },
            ],
            page_info: {
              total_count: 2,
              ...(secondPage ? {} : { end_cursor: "page-two" }),
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected endpoint: ${url.pathname}`);
    });
    const service = await makeService(fetchMock);
    service.configure(readyBootstrap());

    const snapshot = await service.refreshAccounts();

    expect(accountRequests).toHaveLength(2);
    expect(accountRequests[1]?.searchParams.get("after")).toBe("page-two");
    expect(snapshot.connect).toMatchObject({
      state: "ready",
      projectName: "Y Space Project",
      accounts: [
        expect.objectContaining({ id: "apn_Account123" }),
        expect.objectContaining({ id: "apn_Github456" }),
      ],
    });
    await service.dispose();
  });

  it("reconciles persisted grants before launch and drops accounts removed while Y Space was closed", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "y-space-pipedream-restart-"));
    roots.push(baseDir);
    let connected = true;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/oauth/token")) {
        return new Response(
          JSON.stringify({
            access_token: "developer-token",
            token_type: "Bearer",
            expires_in: 600,
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url.pathname.endsWith("/accounts")) {
        return new Response(
          JSON.stringify({
            data: connected
              ? [
                  {
                    id: "apn_Account123",
                    name: "Slack",
                    healthy: true,
                    dead: false,
                    created_at: "2026-08-27T12:00:00.000Z",
                    app: { id: "app_Slack123", name_slug: "slack", name: "Slack" },
                  },
                ]
              : [],
            page_info: { total_count: connected ? 1 : 0 },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      throw new Error("Optional project-name probe unavailable");
    });
    const options = {
      baseDir,
      fetch: fetchMock,
      readPersonalMcpStatus: () => ({ enabled: true, authenticated: true }),
    } as const;
    const first = new PipedreamSupervisorService(options);
    first.configure(readyBootstrap());
    await first.refreshAccounts();
    first.setAccountAgentAccess({ accountId: "apn_Account123", enabled: true });
    await first.dispose();

    connected = false;
    const reopened = new PipedreamSupervisorService(options);
    reopened.configure(readyBootstrap());
    await expect(
      reopened.resolveMcpServersForLaunch({
        threadId: "thread-after-restart",
        projectLocation: { kind: "posix", path: "/workspace" },
      }),
    ).resolves.toEqual([]);
    expect(reopened.getSnapshot().connect).toMatchObject({ state: "ready", accounts: [] });
    await reopened.dispose();
  });

  it("refreshes safe accounts and issues per-launch local MCP descriptors only for granted accounts", async () => {
    let accountConnected = true;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/oauth/token")) {
        return new Response(
          JSON.stringify({
            access_token: "developer-token",
            token_type: "Bearer",
            expires_in: 600,
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/accounts")) {
        return new Response(
          JSON.stringify({
            data: accountConnected
              ? [
                  {
                    id: "apn_Account123",
                    name: "Y Space Slack",
                    healthy: true,
                    dead: false,
                    created_at: "2026-08-27T12:00:00.000Z",
                    credentials: { access_token: "must-not-persist" },
                    app: { id: "app_Slack123", name_slug: "slack", name: "Slack" },
                  },
                ]
              : [],
            page_info: { total_count: accountConnected ? 1 : 0 },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected endpoint: ${new URL(url).pathname}`);
    });
    const service = await makeService(fetchMock);
    service.configure({
      bootstrap: {
        state: "ready",
        source: "environment",
        credentials: {
          clientId: "client-id-private",
          clientSecret: "client-secret-private",
          projectId: "proj_Test123",
          environment: "development",
        },
      },
      externalUserId: "y-space-private-install-id",
    });

    await service.refreshAccounts();
    expect(
      await service.resolveMcpServersForLaunch({
        threadId: "thread-a",
        projectLocation: { kind: "posix", path: "/workspace" },
      }),
    ).toEqual([]);
    service.setAccountAgentAccess({ accountId: "apn_Account123", enabled: true });
    const servers = await service.resolveMcpServersForLaunch({
      threadId: "thread-a",
      providerBindingId: "provider-session-a",
      projectLocation: { kind: "posix", path: "/workspace" },
    });
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({
      name: expect.stringMatching(/^pipedream-slack-[0-9a-f]{12}$/u),
      transport: { type: "http" },
    });
    const serialized = JSON.stringify({ snapshot: service.getSnapshot(), servers });
    expect(serialized).not.toMatch(/client-secret-private|developer-token|must-not-persist/);

    accountConnected = false;
    await service.refreshAccounts();
    const revoked = await fetch(httpUrl(servers[0]), {
      method: "POST",
      headers:
        servers[0]?.transport.type === "http"
          ? { ...servers[0].transport.headers, "content-type": "application/json" }
          : {},
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(revoked.status).toBe(404);
    await service.dispose();
  });

  it("uses opaque provider descriptors and preserves only the loopback bearer through all three provider translations", async () => {
    const service = await readyServiceWithGrantedSlack();
    const [server] = await service.resolveMcpServersForLaunch({
      threadId: "thread-a",
      providerBindingId: "provider-a",
      projectLocation: { kind: "posix", path: "/workspace" },
    });
    expect(server).toBeDefined();

    const translations = {
      codex: buildCodexMcp([server as ResolvedMcpServer]),
      claude: buildClaudeMcpServers([server as ResolvedMcpServer]),
      opencode: buildOpenCodeMcpLaunchConfig([server as ResolvedMcpServer]),
    };
    const serialized = JSON.stringify({ server, translations });
    expect(serialized).not.toMatch(/apn_Account123|proj_Test123|y-space-private-install-id/u);
    expect(serialized).toContain("127.0.0.1");
    expect(serialized).toContain("pipedream-slack-");
    expect(Object.values(translations)).toHaveLength(3);
    await service.dispose();
  });

  it("shares and reference-counts one stable relay binding for pooled provider sessions", async () => {
    const service = await readyServiceWithGrantedSlack();
    const [first, second] = await Promise.all([
      service.resolveMcpServersForLaunch({
        threadId: "thread-a",
        providerBindingId: "opencode:/workspace",
        projectLocation: { kind: "posix", path: "/workspace" },
      }),
      service.resolveMcpServersForLaunch({
        threadId: "thread-b",
        providerBindingId: "opencode:/workspace",
        projectLocation: { kind: "posix", path: "/workspace" },
      }),
    ]);
    expect(second).toEqual(first);

    service.releaseMcpBindings("thread-a");
    const stillLive = await fetch(
      first[0]!.transport.type === "http" ? first[0]!.transport.url : "",
      {
        method: "POST",
        headers:
          first[0]!.transport.type === "http"
            ? { ...first[0]!.transport.headers, "content-type": "application/json" }
            : {},
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      },
    );
    expect(stillLive.status).not.toBe(404);

    service.releaseMcpBindings("thread-b");
    const revoked = await fetch(
      first[0]!.transport.type === "http" ? first[0]!.transport.url : "",
      {
        method: "POST",
        headers:
          first[0]!.transport.type === "http"
            ? { ...first[0]!.transport.headers, "content-type": "application/json" }
            : {},
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      },
    );
    expect(revoked.status).toBe(404);
    await service.dispose();
  });

  it("rewrites loopback relay URLs for WSL NAT and preserves them for mirrored networking", async () => {
    const nat = await readyServiceWithGrantedSlack({ kind: "gateway", ip: "172.22.80.1" });
    const mirrored = await readyServiceWithGrantedSlack({ kind: "loopback" });
    const natServers = await nat.resolveMcpServersForLaunch({
      threadId: "thread-nat",
      projectLocation: {
        kind: "wsl",
        distro: "Ubuntu",
        linuxPath: "/workspace",
        uncPath: "\\\\wsl.localhost\\Ubuntu\\workspace",
      },
    });
    const mirroredServers = await mirrored.resolveMcpServersForLaunch({
      threadId: "thread-mirrored",
      projectLocation: {
        kind: "wsl",
        distro: "Ubuntu",
        linuxPath: "/workspace",
        uncPath: "\\\\wsl.localhost\\Ubuntu\\workspace",
      },
    });
    expect(httpUrl(natServers[0])).toContain("172.22.80.1");
    expect(httpUrl(mirroredServers[0])).toContain("127.0.0.1");
    await nat.dispose();
    await mirrored.dispose();
  });

  async function readyServiceWithGrantedSlack(
    hostAccess: { kind: "gateway"; ip: string } | { kind: "loopback" } = { kind: "loopback" },
  ) {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/oauth/token")) {
        return new Response(
          JSON.stringify({
            access_token: "developer-token",
            token_type: "Bearer",
            expires_in: 600,
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/accounts")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "apn_Account123",
                name: "Y Space Slack",
                healthy: true,
                dead: false,
                created_at: "2026-08-27T12:00:00.000Z",
                app: { id: "app_Slack123", name_slug: "slack", name: "Slack" },
              },
            ],
            page_info: { total_count: 1 },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url === "https://remote.mcp.pipedream.net/v3") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), {
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected endpoint: ${url}`);
    });
    const baseDir = await mkdtemp(join(tmpdir(), "y-space-pipedream-service-"));
    roots.push(baseDir);
    const service = new PipedreamSupervisorService({
      baseDir,
      fetch: fetchMock,
      readPersonalMcpStatus: () => ({ enabled: true, authenticated: true }),
      wslHostAccess: { resolveHostAccess: async () => hostAccess },
    });
    service.configure({
      bootstrap: {
        state: "ready",
        source: "environment",
        credentials: {
          clientId: "client-id-private",
          clientSecret: "client-secret-private",
          projectId: "proj_Test123",
          environment: "development",
        },
      },
      externalUserId: "y-space-private-install-id",
    });
    await service.refreshAccounts();
    service.setAccountAgentAccess({ accountId: "apn_Account123", enabled: true });
    return service;
  }

  function httpUrl(server: ResolvedMcpServer | undefined): string {
    return server?.transport.type === "http" ? server.transport.url : "";
  }

  function readyBootstrap() {
    return {
      bootstrap: {
        state: "ready" as const,
        source: "environment" as const,
        credentials: {
          clientId: "client-id-private",
          clientSecret: "client-secret-private",
          projectId: "proj_Test123",
          environment: "development" as const,
        },
      },
      externalUserId: "y-space-private-install-id",
    };
  }
});
