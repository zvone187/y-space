import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFileAtomic } from "@/shared/atomicFile";
import type { ResolvedMcpServer } from "@/shared/contracts";
import {
  buildClaudeMcpServers,
  buildCodexMcp,
  buildOpenCodeMcpLaunchConfig,
} from "@/supervisor/agents/userMcp";
import { PipedreamConnectionStore } from "./PipedreamConnectionStore";
import type { PipedreamRelayBindingInfo } from "./PipedreamLoopbackRelay";
import { PipedreamSupervisorService, type PipedreamRelay } from "./PipedreamSupervisorService";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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

  it("rejects a ready request that completes after the service is reconfigured", async () => {
    const connectTokenResponse = deferred<Response>();
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
      if (url.includes("/tokens")) return connectTokenResponse.promise;
      throw new Error(`Unexpected endpoint: ${url}`);
    });
    const service = await makeService(fetchMock);
    service.configure(readyBootstrap());
    const staleRequest = service.createConnectLink(
      { appSlug: "gmail" },
      {
        successRedirectUrl: "http://127.0.0.1:43123/success/private-capability",
        errorRedirectUrl: "http://127.0.0.1:43123/error/private-capability",
      },
    );
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/tokens"))).toBe(true),
    );

    service.configure({
      bootstrap: {
        state: "ready",
        source: "environment",
        credentials: {
          clientId: "replacement-client-id-private",
          clientSecret: "replacement-client-secret-private",
          projectId: "proj_Replacement456",
          environment: "development",
        },
      },
      externalUserId: "y-space-private-install-id",
    });
    connectTokenResponse.resolve(
      new Response(
        JSON.stringify({
          connect_link_url: "https://pipedream.com/connect?token=stale-private",
          expires_at: "2026-08-27T12:10:00.000Z",
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );

    await expect(staleRequest).rejects.toThrow("Pipedream request failed");
    expect(service.getSnapshot().connect).toMatchObject({
      state: "ready",
      projectIdHint: "proj_…t456",
    });
    await service.dispose();
  });

  it("awaits relay disposal already started by configure before final disposal completes", async () => {
    const firstDisposal = deferred<void>();
    const secondDisposal = deferred<void>();
    const firstRelay: PipedreamRelay = {
      registerBinding: vi.fn<PipedreamRelay["registerBinding"]>(),
      unregisterBinding: vi.fn<PipedreamRelay["unregisterBinding"]>(),
      dispose: vi.fn<PipedreamRelay["dispose"]>(() => firstDisposal.promise),
    };
    const secondRelay: PipedreamRelay = {
      registerBinding: vi.fn<PipedreamRelay["registerBinding"]>(),
      unregisterBinding: vi.fn<PipedreamRelay["unregisterBinding"]>(),
      dispose: vi.fn<PipedreamRelay["dispose"]>(() => secondDisposal.promise),
    };
    const relays = [firstRelay, secondRelay];
    let relayIndex = 0;
    const baseDir = await mkdtemp(join(tmpdir(), "y-space-pipedream-service-"));
    roots.push(baseDir);
    const service = new PipedreamSupervisorService({
      baseDir,
      readPersonalMcpStatus: () => ({ enabled: true, authenticated: true }),
      createRelay: () => relays[relayIndex++]!,
    });
    service.configure(readyBootstrap());
    service.configure(readyBootstrap());
    expect(firstRelay.dispose).toHaveBeenCalledOnce();

    let disposalSettled = false;
    const disposal = service.dispose().then(() => {
      disposalSettled = true;
    });
    expect(secondRelay.dispose).toHaveBeenCalledOnce();
    secondDisposal.resolve();
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(disposalSettled).toBe(false);
    } finally {
      firstDisposal.resolve();
      await disposal;
    }
  });

  it("contains asynchronous and synchronous relay disposal failures", async () => {
    const firstRelay: PipedreamRelay = {
      registerBinding: vi.fn<PipedreamRelay["registerBinding"]>(),
      unregisterBinding: vi.fn<PipedreamRelay["unregisterBinding"]>(),
      dispose: vi.fn<PipedreamRelay["dispose"]>(() =>
        Promise.reject(new Error("simulated asynchronous close failure")),
      ),
    };
    const secondRelay: PipedreamRelay = {
      registerBinding: vi.fn<PipedreamRelay["registerBinding"]>(),
      unregisterBinding: vi.fn<PipedreamRelay["unregisterBinding"]>(),
      dispose: vi.fn<PipedreamRelay["dispose"]>(() => {
        throw new Error("simulated synchronous close failure");
      }),
    };
    const relays = [firstRelay, secondRelay];
    let relayIndex = 0;
    const baseDir = await mkdtemp(join(tmpdir(), "y-space-pipedream-service-"));
    roots.push(baseDir);
    const service = new PipedreamSupervisorService({
      baseDir,
      readPersonalMcpStatus: () => ({ enabled: true, authenticated: true }),
      createRelay: () => relays[relayIndex++]!,
    });
    service.configure(readyBootstrap());
    service.configure(readyBootstrap());

    await expect(service.dispose()).resolves.toBeUndefined();
    expect(firstRelay.dispose).toHaveBeenCalledOnce();
    expect(secondRelay.dispose).toHaveBeenCalledOnce();
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

  it("reopens a healthy persisted grant and produces a reconciled relay on the first launch", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "y-space-pipedream-positive-restart-"));
    roots.push(baseDir);
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
      if (url.pathname.endsWith("/accounts")) return accountPageResponse();
      throw new Error("Optional project-name probe unavailable");
    });
    const firstRelay: PipedreamRelay = {
      registerBinding: vi.fn<PipedreamRelay["registerBinding"]>(),
      unregisterBinding: vi.fn<PipedreamRelay["unregisterBinding"]>(),
      dispose: vi.fn<PipedreamRelay["dispose"]>(async () => undefined),
    };
    const reopenedRelay: PipedreamRelay = {
      registerBinding: vi.fn<PipedreamRelay["registerBinding"]>(async () => ({
        bindingId: "binding-after-restart",
        url: "http://127.0.0.1:43125/mcp/binding-after-restart",
        headers: { authorization: "Bearer local-after-restart" },
      })),
      unregisterBinding: vi.fn<PipedreamRelay["unregisterBinding"]>(),
      dispose: vi.fn<PipedreamRelay["dispose"]>(async () => undefined),
    };
    const relays = [firstRelay, reopenedRelay];
    const options = {
      baseDir,
      fetch: fetchMock,
      readPersonalMcpStatus: () => ({ enabled: true, authenticated: true }),
      createRelay: () => relays.shift()!,
    } as const;
    const first = new PipedreamSupervisorService(options);
    first.configure(readyBootstrap());
    await first.refreshAccounts();
    first.setAccountAgentAccess({ accountId: "apn_Account123", enabled: true });
    await first.dispose();

    const reopened = new PipedreamSupervisorService(options);
    reopened.configure(readyBootstrap());
    expect(reopened.getSnapshot().connect).toMatchObject({
      state: "ready",
      accounts: [
        expect.objectContaining({
          id: "apn_Account123",
          healthy: true,
          agentAccess: true,
        }),
      ],
    });

    await expect(
      reopened.resolveMcpServersForLaunch({
        threadId: "thread-positive-restart",
        projectLocation: { kind: "posix", path: "/workspace" },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^pipedream:/u),
        transport: expect.objectContaining({
          type: "http",
          url: "http://127.0.0.1:43125/mcp/binding-after-restart",
        }),
      }),
    ]);
    expect(reopenedRelay.registerBinding).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        threadId: "thread-positive-restart",
        accountId: "apn_Account123",
        appSlug: "slack",
      }),
    );
    await reopened.dispose();
  });

  it("reconciles remote removal, health, and newly connected accounts before every launch", async () => {
    let remoteAccounts = [
      {
        id: "apn_Account123",
        name: "Y Space Slack",
        healthy: true,
        dead: false,
        created_at: "2026-08-27T12:00:00.000Z",
        app: { id: "app_Slack123", name_slug: "slack", name: "Slack" },
      },
    ];
    let accountRequests = 0;
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
        accountRequests += 1;
        return new Response(
          JSON.stringify({
            data: remoteAccounts,
            page_info: { total_count: remoteAccounts.length },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      throw new Error("Optional project-name probe unavailable");
    });
    const relay: PipedreamRelay = {
      registerBinding: vi.fn<PipedreamRelay["registerBinding"]>(async ({ threadId }) => ({
        bindingId: `binding-${threadId}`,
        url: `http://127.0.0.1:43125/mcp/binding-${threadId}`,
        headers: { authorization: `Bearer ${threadId}` },
      })),
      unregisterBinding: vi.fn<PipedreamRelay["unregisterBinding"]>(),
      dispose: vi.fn<PipedreamRelay["dispose"]>(async () => undefined),
    };
    const baseDir = await mkdtemp(join(tmpdir(), "y-space-pipedream-launch-refresh-"));
    roots.push(baseDir);
    const service = new PipedreamSupervisorService({
      baseDir,
      fetch: fetchMock,
      readPersonalMcpStatus: () => ({ enabled: true, authenticated: true }),
      createRelay: () => relay,
    });
    service.configure(readyBootstrap());
    await service.refreshAccounts();
    service.setAccountAgentAccess({ accountId: "apn_Account123", enabled: true });

    await expect(
      service.resolveMcpServersForLaunch({
        threadId: "thread-before-external-change",
        projectLocation: { kind: "posix", path: "/workspace" },
      }),
    ).resolves.toHaveLength(1);
    expect(accountRequests).toBe(2);

    remoteAccounts = [
      { ...remoteAccounts[0]!, healthy: false },
      {
        id: "apn_Gmail456",
        name: "New Gmail",
        healthy: true,
        dead: false,
        created_at: "2026-08-29T12:00:00.000Z",
        app: { id: "app_Gmail456", name_slug: "gmail", name: "Gmail" },
      },
    ];
    await expect(
      service.resolveMcpServersForLaunch({
        threadId: "thread-after-health-change",
        projectLocation: { kind: "posix", path: "/workspace" },
      }),
    ).resolves.toEqual([]);
    expect(service.getSnapshot().connect).toMatchObject({
      state: "ready",
      accounts: [
        expect.objectContaining({ id: "apn_Account123", healthy: false, agentAccess: true }),
        expect.objectContaining({ id: "apn_Gmail456", healthy: true, agentAccess: false }),
      ],
    });

    remoteAccounts = [];
    await expect(
      service.resolveMcpServersForLaunch({
        threadId: "thread-after-removal",
        projectLocation: { kind: "posix", path: "/workspace" },
      }),
    ).resolves.toEqual([]);
    expect(service.getSnapshot().connect).toMatchObject({ state: "ready", accounts: [] });
    expect(accountRequests).toBe(4);
    await service.dispose();
  });

  it("deduplicates one remote account refresh across concurrent agent launches", async () => {
    const launchRefresh = deferred<Response>();
    let accountRequests = 0;
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
        accountRequests += 1;
        if (accountRequests > 1) return launchRefresh.promise;
        return accountPageResponse();
      }
      throw new Error("Optional project-name probe unavailable");
    });
    const relay: PipedreamRelay = {
      registerBinding: vi.fn<PipedreamRelay["registerBinding"]>(async ({ threadId }) => ({
        bindingId: `binding-${threadId}`,
        url: `http://127.0.0.1:43125/mcp/binding-${threadId}`,
        headers: { authorization: `Bearer ${threadId}` },
      })),
      unregisterBinding: vi.fn<PipedreamRelay["unregisterBinding"]>(),
      dispose: vi.fn<PipedreamRelay["dispose"]>(async () => undefined),
    };
    const baseDir = await mkdtemp(join(tmpdir(), "y-space-pipedream-launch-dedupe-"));
    roots.push(baseDir);
    const service = new PipedreamSupervisorService({
      baseDir,
      fetch: fetchMock,
      readPersonalMcpStatus: () => ({ enabled: true, authenticated: true }),
      createRelay: () => relay,
    });
    service.configure(readyBootstrap());
    await service.refreshAccounts();
    service.setAccountAgentAccess({ accountId: "apn_Account123", enabled: true });

    const first = service.resolveMcpServersForLaunch({
      threadId: "thread-concurrent-a",
      projectLocation: { kind: "posix", path: "/workspace" },
    });
    const second = service.resolveMcpServersForLaunch({
      threadId: "thread-concurrent-b",
      projectLocation: { kind: "posix", path: "/workspace" },
    });
    await vi.waitFor(() => expect(accountRequests).toBe(2));
    launchRefresh.resolve(accountPageResponse());

    await expect(Promise.all([first, second])).resolves.toEqual([
      [expect.objectContaining({ name: expect.stringMatching(/^pipedream-slack-/u) })],
      [expect.objectContaining({ name: expect.stringMatching(/^pipedream-slack-/u) })],
    ]);
    expect(accountRequests).toBe(2);
    await service.dispose();
  });

  it("keeps a configured runtime Ready after a transient account refresh failure and retries", async () => {
    let accountRequests = 0;
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
        accountRequests += 1;
        if (accountRequests === 1) return new Response("offline", { status: 503 });
        return accountPageResponse();
      }
      throw new Error("Optional project-name probe unavailable");
    });
    const service = await makeService(fetchMock);
    service.configure(readyBootstrap());

    await expect(service.refreshAccounts()).rejects.toThrow("Pipedream request failed");
    expect(service.getSnapshot().connect).toMatchObject({ state: "ready", accounts: [] });
    await expect(service.refreshAccounts()).resolves.toMatchObject({
      connect: {
        state: "ready",
        accounts: [expect.objectContaining({ id: "apn_Account123" })],
      },
    });
    expect(accountRequests).toBe(2);
    await service.dispose();
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

  it("isolates and independently revokes concurrent task relay bearers", async () => {
    const service = await readyServiceWithGrantedSlack();
    const [first, second] = await Promise.all([
      service.resolveMcpServersForLaunch({
        threadId: "thread-a",
        providerBindingId: "thread:thread-a:launch:launch-a",
        projectLocation: { kind: "posix", path: "/workspace" },
      }),
      service.resolveMcpServersForLaunch({
        threadId: "thread-b",
        providerBindingId: "thread:thread-b:launch:launch-b",
        projectLocation: { kind: "posix", path: "/workspace" },
      }),
    ]);
    expect(first[0]?.transport).toMatchObject({ type: "http" });
    expect(second[0]?.transport).toMatchObject({ type: "http" });
    expect(httpUrl(second[0])).not.toBe(httpUrl(first[0]));
    expect(httpHeaders(second[0])).not.toEqual(httpHeaders(first[0]));

    service.releaseMcpBindings("thread-a");
    const revokedFirst = await fetch(
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
    const stillLiveSecond = await fetch(
      second[0]!.transport.type === "http" ? second[0]!.transport.url : "",
      {
        method: "POST",
        headers:
          second[0]!.transport.type === "http"
            ? { ...second[0]!.transport.headers, "content-type": "application/json" }
            : {},
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      },
    );
    expect(revokedFirst.status).toBe(404);
    expect(stillLiveSecond.status).not.toBe(404);

    service.releaseMcpBindings("thread-b");
    const revokedSecond = await fetch(
      second[0]!.transport.type === "http" ? second[0]!.transport.url : "",
      {
        method: "POST",
        headers:
          second[0]!.transport.type === "http"
            ? { ...second[0]!.transport.headers, "content-type": "application/json" }
            : {},
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
      },
    );
    expect(revokedSecond.status).toBe(404);
    await service.dispose();
  });

  it("keeps a replacement launch alive when an older same-thread WSL resolve resumes", async () => {
    const staleReachability = deferred<{ kind: "loopback" }>();
    let reachabilityCall = 0;
    const resolveHostAccess = vi.fn<(distro: string) => Promise<{ kind: "loopback" }>>(async () => {
      reachabilityCall += 1;
      return reachabilityCall === 1 ? staleReachability.promise : { kind: "loopback" as const };
    });
    const relay: PipedreamRelay = {
      registerBinding: vi.fn<PipedreamRelay["registerBinding"]>(async (input) => {
        const suffix = input.providerBindingId.endsWith(":replacement") ? "replacement" : "stale";
        return {
          bindingId: `binding-${suffix}`,
          url: `http://127.0.0.1:43124/mcp/binding-${suffix}`,
          headers: { authorization: `Bearer ${suffix}` },
        };
      }),
      unregisterBinding: vi.fn<PipedreamRelay["unregisterBinding"]>(),
      dispose: vi.fn<PipedreamRelay["dispose"]>(async () => undefined),
    };
    const service = await readyServiceWithGrantedSlack(resolveHostAccess, () => relay);
    const stale = service.resolveMcpServersForLaunch({
      threadId: "thread-same-replacement",
      providerBindingId: "thread:thread-same-replacement:launch:stale",
      projectLocation: {
        kind: "wsl",
        distro: "Ubuntu",
        linuxPath: "/workspace",
        uncPath: "\\\\wsl.localhost\\Ubuntu\\workspace",
      },
    });
    await vi.waitFor(() => expect(resolveHostAccess).toHaveBeenCalledOnce());

    const replacement = service.resolveMcpServersForLaunch({
      threadId: "thread-same-replacement",
      providerBindingId: "thread:thread-same-replacement:launch:replacement",
      projectLocation: {
        kind: "wsl",
        distro: "Ubuntu",
        linuxPath: "/workspace",
        uncPath: "\\\\wsl.localhost\\Ubuntu\\workspace",
      },
    });
    await expect(replacement).resolves.toEqual([
      expect.objectContaining({
        transport: expect.objectContaining({
          type: "http",
          url: "http://127.0.0.1:43124/mcp/binding-replacement",
        }),
      }),
    ]);

    staleReachability.resolve({ kind: "loopback" });
    await expect(stale).resolves.toEqual([]);
    expect(relay.unregisterBinding).not.toHaveBeenCalledWith("binding-replacement");
    await service.dispose();
  });

  it("rejects an old resolver after reconfigure without corrupting the replacement scope", async () => {
    const staleReachability = deferred<{ kind: "loopback" }>();
    let reachabilityCall = 0;
    const resolveHostAccess = vi.fn<(distro: string) => Promise<{ kind: "loopback" }>>(async () => {
      reachabilityCall += 1;
      return reachabilityCall === 1 ? staleReachability.promise : { kind: "loopback" as const };
    });
    const makeRelay = (generation: string): PipedreamRelay => ({
      registerBinding: vi.fn<PipedreamRelay["registerBinding"]>(async () => ({
        bindingId: `binding-${generation}`,
        url: `http://127.0.0.1:43124/mcp/binding-${generation}`,
        headers: { authorization: `Bearer ${generation}` },
      })),
      unregisterBinding: vi.fn<PipedreamRelay["unregisterBinding"]>(),
      dispose: vi.fn<PipedreamRelay["dispose"]>(async () => undefined),
    });
    const staleRelay = makeRelay("stale-generation");
    const replacementRelay = makeRelay("replacement-generation");
    const relays = [staleRelay, replacementRelay];
    let relayIndex = 0;
    const service = await readyServiceWithGrantedSlack(
      resolveHostAccess,
      () => relays[relayIndex++]!,
    );
    const input = {
      threadId: "thread-reconfigured-resolver",
      providerBindingId: "thread:thread-reconfigured-resolver:launch:same",
      projectLocation: {
        kind: "wsl" as const,
        distro: "Ubuntu",
        linuxPath: "/workspace",
        uncPath: "\\\\wsl.localhost\\Ubuntu\\workspace",
      },
    };
    const stale = service.resolveMcpServersForLaunch(input);
    await vi.waitFor(() => expect(resolveHostAccess).toHaveBeenCalledOnce());

    service.configure(readyBootstrap());
    const replacement = service.resolveMcpServersForLaunch(input);
    await expect(replacement).resolves.toEqual([
      expect.objectContaining({
        transport: expect.objectContaining({
          type: "http",
          url: "http://127.0.0.1:43124/mcp/binding-replacement-generation",
        }),
      }),
    ]);

    staleReachability.resolve({ kind: "loopback" });
    await expect(stale).resolves.toEqual([]);
    expect(replacementRelay.unregisterBinding).not.toHaveBeenCalledWith(
      "binding-replacement-generation",
    );
    await service.dispose();
  });

  it("does not let a stale refresh failure revoke a reconfigured replacement binding", async () => {
    const staleAccounts = deferred<Response>();
    let accountRequests = 0;
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
        accountRequests += 1;
        return accountRequests === 2 ? staleAccounts.promise : accountPageResponse();
      }
      throw new Error("Optional project-name probe unavailable");
    });
    const makeRelay = (generation: string): PipedreamRelay => ({
      registerBinding: vi.fn<PipedreamRelay["registerBinding"]>(async () => ({
        bindingId: `binding-${generation}`,
        url: `http://127.0.0.1:43124/mcp/binding-${generation}`,
        headers: { authorization: `Bearer ${generation}` },
      })),
      unregisterBinding: vi.fn<PipedreamRelay["unregisterBinding"]>(),
      dispose: vi.fn<PipedreamRelay["dispose"]>(async () => undefined),
    });
    const staleRelay = makeRelay("stale-refresh-generation");
    const replacementRelay = makeRelay("replacement-refresh-generation");
    const relays = [staleRelay, replacementRelay];
    let relayIndex = 0;
    const baseDir = await mkdtemp(join(tmpdir(), "y-space-pipedream-service-"));
    roots.push(baseDir);
    const service = new PipedreamSupervisorService({
      baseDir,
      fetch: fetchMock,
      readPersonalMcpStatus: () => ({ enabled: true, authenticated: true }),
      createRelay: () => relays[relayIndex++]!,
    });
    service.configure(readyBootstrap());
    await service.refreshAccounts();
    service.setAccountAgentAccess({ accountId: "apn_Account123", enabled: true });
    const input = {
      threadId: "thread-stale-refresh-reconfigure",
      providerBindingId: "thread:thread-stale-refresh-reconfigure:launch:same",
      projectLocation: { kind: "posix" as const, path: "/workspace" },
    };
    const stale = service.resolveMcpServersForLaunch(input);
    await vi.waitFor(() => expect(accountRequests).toBe(2));

    service.configure(readyBootstrap());
    const replacement = service.resolveMcpServersForLaunch(input);
    await expect(replacement).resolves.toEqual([
      expect.objectContaining({
        transport: expect.objectContaining({
          type: "http",
          url: "http://127.0.0.1:43124/mcp/binding-replacement-refresh-generation",
        }),
      }),
    ]);

    staleAccounts.reject(new Error("stale account refresh failed"));
    await expect(stale).resolves.toEqual([]);
    expect(replacementRelay.unregisterBinding).not.toHaveBeenCalledWith(
      "binding-replacement-refresh-generation",
    );
    await service.dispose();
  });

  it("isolates a new launch from a stale pending relay after revoke and re-enable", async () => {
    const staleRegistration = deferred<PipedreamRelayBindingInfo>();
    const currentRegistration = deferred<PipedreamRelayBindingInfo>();
    const relay: PipedreamRelay = {
      registerBinding: vi
        .fn<PipedreamRelay["registerBinding"]>()
        .mockReturnValueOnce(staleRegistration.promise)
        .mockReturnValueOnce(currentRegistration.promise),
      unregisterBinding: vi.fn<PipedreamRelay["unregisterBinding"]>(),
      dispose: vi.fn<PipedreamRelay["dispose"]>(async () => undefined),
    };
    const service = await readyServiceWithGrantedSlack({ kind: "loopback" }, () => relay);
    const pendingLaunch = service.resolveMcpServersForLaunch({
      threadId: "thread-racing-grant",
      providerBindingId: "opencode:/workspace",
      projectLocation: { kind: "posix", path: "/workspace" },
    });
    await vi.waitFor(() => expect(relay.registerBinding).toHaveBeenCalledOnce());

    service.setAccountAgentAccess({ accountId: "apn_Account123", enabled: false });
    service.setAccountAgentAccess({ accountId: "apn_Account123", enabled: true });
    const currentLaunch = service.resolveMcpServersForLaunch({
      threadId: "thread-current-grant",
      providerBindingId: "opencode:/workspace",
      projectLocation: { kind: "posix", path: "/workspace" },
    });
    await vi.waitFor(() => expect(relay.registerBinding).toHaveBeenCalledTimes(2));

    currentRegistration.resolve({
      bindingId: "binding-current",
      url: "http://127.0.0.1:43124/mcp/binding-current",
      headers: { authorization: "Bearer current" },
    });
    await expect(currentLaunch).resolves.toEqual([
      expect.objectContaining({
        transport: expect.objectContaining({
          type: "http",
          url: "http://127.0.0.1:43124/mcp/binding-current",
        }),
      }),
    ]);

    staleRegistration.resolve({
      bindingId: "binding-stale",
      url: "http://127.0.0.1:43123/mcp/binding-stale",
      headers: { authorization: "Bearer stale" },
    });

    await expect(pendingLaunch).resolves.toEqual([]);
    expect(relay.unregisterBinding).toHaveBeenCalledWith("binding-stale");
    expect(relay.unregisterBinding).not.toHaveBeenCalledWith("binding-current");
    await service.dispose();
  });

  it("keeps a pending relay launch valid across an unchanged account refresh", async () => {
    const registration = deferred<PipedreamRelayBindingInfo>();
    const relay: PipedreamRelay = {
      registerBinding: vi.fn<PipedreamRelay["registerBinding"]>(() => registration.promise),
      unregisterBinding: vi.fn<PipedreamRelay["unregisterBinding"]>(),
      dispose: vi.fn<PipedreamRelay["dispose"]>(async () => undefined),
    };
    const service = await readyServiceWithGrantedSlack({ kind: "loopback" }, () => relay);
    const pendingLaunch = service.resolveMcpServersForLaunch({
      threadId: "thread-refresh-race",
      providerBindingId: "opencode:/workspace",
      projectLocation: { kind: "posix", path: "/workspace" },
    });
    await vi.waitFor(() => expect(relay.registerBinding).toHaveBeenCalledOnce());

    await service.refreshAccounts();
    registration.resolve({
      bindingId: "binding-survives-refresh",
      url: "http://127.0.0.1:43126/mcp/binding-survives-refresh",
      headers: { authorization: "Bearer survives-refresh" },
    });

    await expect(pendingLaunch).resolves.toEqual([
      expect.objectContaining({
        transport: expect.objectContaining({
          type: "http",
          url: "http://127.0.0.1:43126/mcp/binding-survives-refresh",
        }),
      }),
    ]);
    expect(relay.unregisterBinding).not.toHaveBeenCalledWith("binding-survives-refresh");
    await service.dispose();
  });

  it("keeps a pending relay launch valid when the existing grant value is re-applied", async () => {
    const registration = deferred<PipedreamRelayBindingInfo>();
    const relay: PipedreamRelay = {
      registerBinding: vi.fn<PipedreamRelay["registerBinding"]>(() => registration.promise),
      unregisterBinding: vi.fn<PipedreamRelay["unregisterBinding"]>(),
      dispose: vi.fn<PipedreamRelay["dispose"]>(async () => undefined),
    };
    const service = await readyServiceWithGrantedSlack({ kind: "loopback" }, () => relay);
    const pendingLaunch = service.resolveMcpServersForLaunch({
      threadId: "thread-noop-grant-race",
      providerBindingId: "opencode:/workspace",
      projectLocation: { kind: "posix", path: "/workspace" },
    });
    await vi.waitFor(() => expect(relay.registerBinding).toHaveBeenCalledOnce());

    service.setAccountAgentAccess({ accountId: "apn_Account123", enabled: true });
    registration.resolve({
      bindingId: "binding-survives-noop-grant",
      url: "http://127.0.0.1:43127/mcp/binding-survives-noop-grant",
      headers: { authorization: "Bearer survives-noop-grant" },
    });

    await expect(pendingLaunch).resolves.toEqual([
      expect.objectContaining({
        transport: expect.objectContaining({
          type: "http",
          url: "http://127.0.0.1:43127/mcp/binding-survives-noop-grant",
        }),
      }),
    ]);
    expect(relay.unregisterBinding).not.toHaveBeenCalledWith("binding-survives-noop-grant");
    await service.dispose();
  });

  it("keeps a pending disconnect quarantined across refresh and rejects access restoration", async () => {
    const deleteResponse = deferred<Response>();
    const refreshDuringDelete = deferred<Response>();
    let accountRequests = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
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
      if (init?.method === "DELETE") return deleteResponse.promise;
      if (url.includes("/accounts")) {
        accountRequests += 1;
        if (accountRequests === 3) return refreshDuringDelete.promise;
        return accountRequests < 5 ? accountPageResponse() : emptyAccountPageResponse();
      }
      throw new Error("Optional project-name probe unavailable");
    });
    const relay: PipedreamRelay = {
      registerBinding: vi.fn<PipedreamRelay["registerBinding"]>(async () => ({
        bindingId: "binding-pending-disconnect",
        url: "http://127.0.0.1:43128/mcp/binding-pending-disconnect",
        headers: { authorization: "Bearer pending-disconnect" },
      })),
      unregisterBinding: vi.fn<PipedreamRelay["unregisterBinding"]>(),
      dispose: vi.fn<PipedreamRelay["dispose"]>(async () => undefined),
    };
    const baseDir = await mkdtemp(join(tmpdir(), "y-space-pipedream-disconnect-race-"));
    roots.push(baseDir);
    const service = new PipedreamSupervisorService({
      baseDir,
      fetch: fetchMock,
      readPersonalMcpStatus: () => ({ enabled: true, authenticated: true }),
      createRelay: () => relay,
    });
    service.configure(readyBootstrap());
    await service.refreshAccounts();
    service.setAccountAgentAccess({ accountId: "apn_Account123", enabled: true });
    await expect(
      service.resolveMcpServersForLaunch({
        threadId: "thread-before-pending-disconnect",
        projectLocation: { kind: "posix", path: "/workspace" },
      }),
    ).resolves.toHaveLength(1);

    const disconnect = service.disconnectAccount({ accountId: "apn_Account123" });
    const concurrentRefresh = service.refreshAccounts();
    await vi.waitFor(() => expect(accountRequests).toBe(3));
    refreshDuringDelete.resolve(accountPageResponse());
    await concurrentRefresh;

    expect(service.getSnapshot().connect).toMatchObject({
      state: "ready",
      accounts: [expect.objectContaining({ id: "apn_Account123", agentAccess: false })],
    });
    expect(() =>
      service.setAccountAgentAccess({ accountId: "apn_Account123", enabled: true }),
    ).toThrow(/disconnect.*progress/i);
    await expect(
      service.resolveMcpServersForLaunch({
        threadId: "thread-during-pending-disconnect",
        projectLocation: { kind: "posix", path: "/workspace" },
      }),
    ).resolves.toEqual([]);
    expect(relay.unregisterBinding).toHaveBeenCalledExactlyOnceWith("binding-pending-disconnect");
    expect(relay.registerBinding).toHaveBeenCalledOnce();

    deleteResponse.resolve(new Response(null, { status: 204 }));
    await expect(disconnect).resolves.toMatchObject({
      connect: { state: "ready", accounts: [] },
    });
    await expect(
      service.resolveMcpServersForLaunch({
        threadId: "thread-after-successful-disconnect",
        projectLocation: { kind: "posix", path: "/workspace" },
      }),
    ).resolves.toEqual([]);
    expect(relay.registerBinding).toHaveBeenCalledOnce();
    await service.dispose();
  });

  it("discards a stale account refresh that settles after a successful disconnect", async () => {
    const staleRefreshResponse = deferred<Response>();
    let accountRequests = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
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
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (url.includes("/accounts")) {
        accountRequests += 1;
        return accountRequests === 1 ? accountPageResponse() : staleRefreshResponse.promise;
      }
      throw new Error("Optional project-name probe unavailable");
    });
    const service = await makeService(fetchMock);
    service.configure(readyBootstrap());
    await service.refreshAccounts();
    service.setAccountAgentAccess({ accountId: "apn_Account123", enabled: true });

    const staleRefresh = service.refreshAccounts();
    await vi.waitFor(() => expect(accountRequests).toBe(2));
    await expect(service.disconnectAccount({ accountId: "apn_Account123" })).resolves.toMatchObject(
      { connect: { state: "ready", accounts: [] } },
    );
    staleRefreshResponse.resolve(accountPageResponse());

    await expect(staleRefresh).rejects.toThrow("Pipedream request failed");
    expect(service.getSnapshot().connect).toMatchObject({ state: "ready", accounts: [] });
    await service.dispose();
  });

  it("revokes a live local route before a failing upstream disconnect settles", async () => {
    const relay: PipedreamRelay = {
      registerBinding: vi.fn<PipedreamRelay["registerBinding"]>(async () => ({
        bindingId: "binding-live",
        url: "http://127.0.0.1:43125/mcp/binding-live",
        headers: { authorization: "Bearer live" },
      })),
      unregisterBinding: vi.fn<PipedreamRelay["unregisterBinding"]>(),
      dispose: vi.fn<PipedreamRelay["dispose"]>(async () => undefined),
    };
    const service = await readyServiceWithGrantedSlack({ kind: "loopback" }, () => relay);
    await expect(
      service.resolveMcpServersForLaunch({
        threadId: "thread-live-disconnect",
        projectLocation: { kind: "posix", path: "/workspace" },
      }),
    ).resolves.toHaveLength(1);

    const disconnect = service.disconnectAccount({ accountId: "apn_Account123" });
    expect(relay.unregisterBinding).toHaveBeenCalledWith("binding-live");
    expect(service.getSnapshot().connect).toMatchObject({
      state: "ready",
      accounts: [expect.objectContaining({ id: "apn_Account123", agentAccess: false })],
    });
    await expect(disconnect).rejects.toThrow("Pipedream request failed");
    expect(relay.unregisterBinding).toHaveBeenCalledTimes(1);
    expect(service.getSnapshot().connect).toMatchObject({
      state: "ready",
      accounts: [
        expect.objectContaining({ id: "apn_Account123", healthy: true, agentAccess: false }),
      ],
    });
    await expect(
      service.resolveMcpServersForLaunch({
        threadId: "thread-after-failed-disconnect",
        projectLocation: { kind: "posix", path: "/workspace" },
      }),
    ).resolves.toEqual([]);
    await expect(service.disconnectAccount({ accountId: "apn_Account123" })).rejects.toThrow(
      "Pipedream request failed",
    );
    await service.dispose();
  });

  it("reports failed denial persistence truthfully and tombstones durably before DELETE", async () => {
    let writesBeforeFailure: number | undefined;
    let deleteRequests = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
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
      if (init?.method === "DELETE") {
        deleteRequests += 1;
        return new Response(null, { status: 204 });
      }
      if (url.includes("/accounts")) return accountPageResponse();
      throw new Error("Optional project-name probe unavailable");
    });
    const relay: PipedreamRelay = {
      registerBinding: vi.fn<PipedreamRelay["registerBinding"]>(async () => ({
        bindingId: "binding-durable-revoke",
        url: "http://127.0.0.1:43125/mcp/binding-durable-revoke",
        headers: { authorization: "Bearer durable-revoke" },
      })),
      unregisterBinding: vi.fn<PipedreamRelay["unregisterBinding"]>(),
      dispose: vi.fn<PipedreamRelay["dispose"]>(async () => undefined),
    };
    const baseDir = await mkdtemp(join(tmpdir(), "y-space-pipedream-durable-revoke-"));
    roots.push(baseDir);
    const service = new PipedreamSupervisorService({
      baseDir,
      fetch: fetchMock,
      readPersonalMcpStatus: () => ({ enabled: true, authenticated: true }),
      createRelay: () => relay,
      writeConnectionsFile: (...args) => {
        if (writesBeforeFailure !== undefined) {
          if (writesBeforeFailure === 0) {
            writesBeforeFailure = undefined;
            throw new Error("simulated atomic write failure");
          }
          writesBeforeFailure -= 1;
        }
        writeFileAtomic(...args);
      },
    });
    service.configure(readyBootstrap());
    await service.refreshAccounts();
    service.setAccountAgentAccess({ accountId: "apn_Account123", enabled: true });
    await expect(
      service.resolveMcpServersForLaunch({
        threadId: "thread-durable-revoke",
        projectLocation: { kind: "posix", path: "/workspace" },
      }),
    ).resolves.toHaveLength(1);

    writesBeforeFailure = 0;
    const failedDenial = service.disconnectAccount({ accountId: "apn_Account123" });
    expect(relay.unregisterBinding).toHaveBeenCalledWith("binding-durable-revoke");
    await expect(failedDenial).rejects.toThrow("Pipedream request failed");
    expect(deleteRequests).toBe(0);
    expect(service.getSnapshot().connect).toMatchObject({
      state: "ready",
      accounts: [expect.objectContaining({ id: "apn_Account123", agentAccess: true })],
    });

    // The durable denial succeeds, then removal of the tombstoned row fails.
    // No upstream DELETE may run, but a restart must still observe access off.
    writesBeforeFailure = 1;
    await expect(service.disconnectAccount({ accountId: "apn_Account123" })).rejects.toThrow(
      "Pipedream request failed",
    );
    expect(deleteRequests).toBe(0);
    expect(service.getSnapshot().connect).toMatchObject({
      state: "ready",
      accounts: [expect.objectContaining({ id: "apn_Account123", agentAccess: false })],
    });
    const reopened = new PipedreamConnectionStore({
      filePath: join(baseDir, "pipedream-connections.json"),
    });
    expect(reopened.list()).toEqual([
      expect.objectContaining({ id: "apn_Account123", agentAccess: false }),
    ]);
    expect(reopened.listGrantedForRelay()).toEqual([]);
    await expect(
      service.resolveMcpServersForLaunch({
        threadId: "thread-after-durable-revoke-failure",
        projectLocation: { kind: "posix", path: "/workspace" },
      }),
    ).resolves.toEqual([]);
    expect(relay.registerBinding).toHaveBeenCalledTimes(1);

    await expect(service.disconnectAccount({ accountId: "apn_Account123" })).resolves.toMatchObject(
      { connect: { state: "ready", accounts: [] } },
    );
    expect(deleteRequests).toBe(1);
    await service.dispose();
  });

  it("keeps a revoked disconnect retry row when both DELETE and reconciliation are offline", async () => {
    let offline = false;
    let deleteRequests = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
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
      if (init?.method === "DELETE") {
        deleteRequests += 1;
        throw new Error("simulated offline DELETE");
      }
      if (url.includes("/accounts")) {
        if (offline) throw new Error("simulated offline reconciliation");
        return accountPageResponse();
      }
      throw new Error("Optional project-name probe unavailable");
    });
    const service = await makeService(fetchMock);
    service.configure(readyBootstrap());
    await service.refreshAccounts();
    service.setAccountAgentAccess({ accountId: "apn_Account123", enabled: true });
    offline = true;

    await expect(service.disconnectAccount({ accountId: "apn_Account123" })).rejects.toThrow(
      "Pipedream request failed",
    );
    expect(service.getSnapshot().connect).toMatchObject({
      state: "ready",
      accounts: [expect.objectContaining({ id: "apn_Account123", agentAccess: false })],
    });

    await expect(service.disconnectAccount({ accountId: "apn_Account123" })).rejects.toThrow(
      "Pipedream request failed",
    );
    expect(deleteRequests).toBe(2);
    expect(service.getSnapshot().connect).toMatchObject({
      state: "ready",
      accounts: [expect.objectContaining({ id: "apn_Account123", agentAccess: false })],
    });
    await service.dispose();
  });

  it("rejects disconnecting an account outside the scoped account store without issuing DELETE", async () => {
    let deleteRequests = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
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
      if (url.includes("/accounts") && init?.method === "GET") {
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
      if (init?.method === "DELETE") {
        deleteRequests += 1;
        return new Response(null, { status: 204 });
      }
      throw new Error("Optional project-name probe unavailable");
    });
    const service = await makeService(fetchMock);
    service.configure(readyBootstrap());
    await service.refreshAccounts();

    let rejected = false;
    try {
      await service.disconnectAccount({ accountId: "apn_OtherUser999" });
    } catch {
      rejected = true;
    }

    expect.soft(rejected).toBe(true);
    expect(deleteRequests).toBe(0);
    expect(service.getSnapshot().connect).toMatchObject({
      state: "ready",
      accounts: [expect.objectContaining({ id: "apn_Account123" })],
    });
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
    hostAccess:
      | { kind: "gateway"; ip: string }
      | { kind: "loopback" }
      | ((distro: string) => Promise<{ kind: "gateway"; ip: string } | { kind: "loopback" }>) = {
      kind: "loopback",
    },
    createRelay?: ConstructorParameters<typeof PipedreamSupervisorService>[0]["createRelay"],
  ) {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (init?.method === "DELETE") throw new Error("simulated upstream disconnect failure");
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
      wslHostAccess: {
        resolveHostAccess: async (distro) =>
          typeof hostAccess === "function" ? hostAccess(distro) : hostAccess,
      },
      ...(createRelay ? { createRelay } : {}),
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

  function httpHeaders(
    server: ResolvedMcpServer | undefined,
  ): Readonly<Record<string, string>> | undefined {
    return server?.transport.type === "http" ? server.transport.headers : undefined;
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

  function accountPageResponse(): Response {
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

  function emptyAccountPageResponse(): Response {
    return new Response(JSON.stringify({ data: [], page_info: { total_count: 0 } }), {
      headers: { "content-type": "application/json" },
    });
  }
});
