import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isPipedreamPersonalMcpUrl,
  PIPEDREAM_PERSONAL_MCP_URL,
  type McpServer,
  type ResolvedMcpServer,
} from "@/shared/contracts";
import { encryptSecret } from "@/shared/secretStorage";
import {
  createFileDurability,
  type FileDurability,
  type FileDurabilityOperations,
} from "@/shared/fileDurability";
import {
  buildClaudeMcpLaunchConfig,
  buildCodexMcp,
  buildOpenCodeMcpLaunchConfig,
} from "@/supervisor/agents/userMcp/translate";
import { McpOAuthCredentialStoreUnavailableError, McpOAuthService } from "./McpOAuthService";
import type {
  PersonalMcpLoopbackRelay,
  PersonalMcpRelayBindingInfo,
} from "./PersonalMcpLoopbackRelay";

interface FakeAuthServer {
  url: string;
  tokenRequests: URLSearchParams[];
  readonly registrationRequests: number;
  releaseNextRegistrationResponse: () => void;
  releaseNextTokenResponse: () => void;
  releaseAllTokenResponses: () => void;
  close: () => void;
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/**
 * Minimal OAuth 2.1 authorization server + MCP resource on one origin:
 * metadata discovery, dynamic client registration, and a token endpoint that
 * grants `at-1` for authorization codes and `at-2` for refresh tokens.
 */
async function startFakeAuthServer(options: {
  expiresIn: number;
  deferFirstRegistration?: boolean;
  deferAuthorizationCode?: boolean;
  deferRefresh?: boolean;
}): Promise<FakeAuthServer> {
  const tokenRequests: URLSearchParams[] = [];
  const pendingRegistrationResponses: Array<() => void> = [];
  const pendingTokenResponses: Array<() => void> = [];
  let registrationRequests = 0;
  let server!: Server;
  let origin = "";

  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", origin);
    if (req.method === "GET" && url.pathname.includes("oauth-protected-resource")) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === "GET" && url.pathname.includes("oauth-authorization-server")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        }),
      );
      return;
    }
    if (req.method === "GET" && url.pathname.includes("openid-configuration")) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/register") {
      registrationRequests += 1;
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      req.on("end", () => {
        const metadata = JSON.parse(body) as Record<string, unknown>;
        const respond = () => {
          res.writeHead(201, { "content-type": "application/json" });
          res.end(JSON.stringify({ ...metadata, client_id: "fake-client" }));
        };
        if (options.deferFirstRegistration && registrationRequests === 1) {
          pendingRegistrationResponses.push(respond);
        } else {
          respond();
        }
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/token") {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      req.on("end", () => {
        const params = new URLSearchParams(body);
        tokenRequests.push(params);
        const respond = () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              access_token: params.get("grant_type") === "refresh_token" ? "at-2" : "at-1",
              token_type: "Bearer",
              refresh_token: "rt-1",
              expires_in: options.expiresIn,
            }),
          );
        };
        const grantType = params.get("grant_type");
        if (
          (grantType === "authorization_code" && options.deferAuthorizationCode) ||
          (grantType === "refresh_token" && options.deferRefresh)
        ) {
          pendingTokenResponses.push(respond);
        } else {
          respond();
        }
      });
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  origin = `http://127.0.0.1:${address.port}`;
  const fake: FakeAuthServer = {
    url: origin,
    tokenRequests,
    get registrationRequests() {
      return registrationRequests;
    },
    releaseNextRegistrationResponse: () => {
      const respond = pendingRegistrationResponses.shift();
      if (!respond) throw new Error("No deferred registration response is pending.");
      respond();
    },
    releaseNextTokenResponse: () => {
      const respond = pendingTokenResponses.shift();
      if (!respond) throw new Error("No deferred token response is pending.");
      respond();
    },
    releaseAllTokenResponses: () => {
      for (const respond of pendingTokenResponses.splice(0)) respond();
    },
    close: () => server.close(),
  };
  cleanups.push(fake.close);
  return fake;
}

function makeService(): McpOAuthService {
  const dir = mkdtempSync(join(tmpdir(), "poracode-mcp-oauth-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const service = new McpOAuthService({ baseDir: dir });
  cleanups.push(() => service.dispose());
  return service;
}

function httpServer(url: string): McpServer {
  return {
    id: "server-1",
    name: "vercel",
    description: "",
    enabled: true,
    timeoutMs: 30_000,
    transport: { type: "http", url: `${url}/mcp`, headers: {} },
  };
}

async function completeBrowserLeg(authorizationUrl: string): Promise<void> {
  const url = new URL(authorizationUrl);
  const redirectUri = url.searchParams.get("redirect_uri");
  const state = url.searchParams.get("state");
  expect(url.searchParams.get("code_challenge")).toBeTruthy();
  expect(redirectUri).toBeTruthy();
  const callback = new URL(redirectUri as string);
  callback.searchParams.set("code", "fake-code");
  callback.searchParams.set("state", state ?? "");
  const response = await fetch(callback);
  expect(response.status).toBe(200);
}

async function flushNetworkContinuation(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("McpOAuthService", () => {
  it("starts with a missing Windows store and keeps new credentials session-only", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "poracode-mcp-oauth-windows-session-"));
    const storePath = join(baseDir, "mcp-oauth.json");
    cleanups.push(() => rmSync(baseDir, { recursive: true, force: true }));
    const operations: FileDurabilityOperations = {
      open: vi.fn<(path: string, flags: "r" | "r+") => number>(),
      sync: vi.fn<(descriptor: number) => void>(),
      close: vi.fn<(descriptor: number) => void>(),
    };
    const service = new McpOAuthService({
      baseDir,
      storePath,
      durability: createFileDurability("win32", operations),
    });
    cleanups.push(() => service.dispose());
    const url = "https://session-only.example.test/mcp";
    const internals = service as unknown as {
      updateEntry(
        serverUrl: string,
        update: (entry: Record<string, unknown>) => Record<string, unknown>,
      ): void;
    };

    expect(service.status().authenticatedUrls).toEqual([]);
    internals.updateEntry(url, (entry) => ({
      ...entry,
      tokens: encryptSecret(
        baseDir,
        JSON.stringify({ access_token: "session-token", token_type: "Bearer" }),
      ),
    }));

    expect(service.status().authenticatedUrls).toEqual([url]);
    expect(() => readFileSync(storePath, "utf8")).toThrow(/ENOENT|no such file/i);
    expect(operations.open).not.toHaveBeenCalled();
    expect(operations.sync).not.toHaveBeenCalled();
    expect(operations.close).not.toHaveBeenCalled();

    const restarted = new McpOAuthService({
      baseDir,
      storePath,
      durability: createFileDurability("win32", operations),
    });
    cleanups.push(() => restarted.dispose());
    expect(restarted.status().authenticatedUrls).toEqual([]);
  });

  it("starts from a valid generic-only Windows store without rewriting its namespace", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "poracode-mcp-oauth-windows-existing-"));
    const storePath = join(baseDir, "mcp-oauth.json");
    cleanups.push(() => rmSync(baseDir, { recursive: true, force: true }));
    const genericUrl = "https://existing.example.test/mcp";
    const sealed = (accessToken: string) =>
      encryptSecret(baseDir, JSON.stringify({ access_token: accessToken, token_type: "Bearer" }));
    const serialized = JSON.stringify({
      servers: {
        [genericUrl]: { tokens: sealed("generic-token") },
      },
    });
    writeFileSync(storePath, serialized, { mode: 0o600 });
    const operations: FileDurabilityOperations = {
      open: vi.fn<(path: string, flags: "r" | "r+") => number>(),
      sync: vi.fn<(descriptor: number) => void>(),
      close: vi.fn<(descriptor: number) => void>(),
    };

    const service = new McpOAuthService({
      baseDir,
      storePath,
      durability: createFileDurability("win32", operations),
      persistCredentialsForServer: (url) => !isPipedreamPersonalMcpUrl(url),
      persistPersonalCredentials: false,
      failClosedOnStoreLoadError: true,
    });
    cleanups.push(() => service.dispose());

    expect(service.status().authenticatedUrls).toEqual([genericUrl]);
    expect(readFileSync(storePath, "utf8")).toBe(serialized);
    expect(operations.open).not.toHaveBeenCalled();
    expect(operations.sync).not.toHaveBeenCalled();
    expect(operations.close).not.toHaveBeenCalled();
  });

  it("signs out a session-only Personal account on Windows when the store is absent", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "poracode-personal-mcp-windows-clear-missing-"));
    const storePath = join(baseDir, "mcp-oauth.json");
    cleanups.push(() => rmSync(baseDir, { recursive: true, force: true }));
    const operations: FileDurabilityOperations = {
      open: vi.fn<(path: string, flags: "r" | "r+") => number>(),
      sync: vi.fn<(descriptor: number) => void>(),
      close: vi.fn<(descriptor: number) => void>(),
    };
    const service = new McpOAuthService({
      baseDir,
      storePath,
      durability: createFileDurability("win32", operations),
      persistCredentialsForServer: (url) => !isPipedreamPersonalMcpUrl(url),
      persistPersonalCredentials: false,
      failClosedOnStoreLoadError: true,
    });
    cleanups.push(() => service.dispose());
    const internals = service as unknown as {
      updateEntry(
        serverUrl: string,
        update: (entry: Record<string, unknown>) => Record<string, unknown>,
      ): void;
    };
    internals.updateEntry(PIPEDREAM_PERSONAL_MCP_URL, (entry) => ({
      ...entry,
      tokens: encryptSecret(
        baseDir,
        JSON.stringify({ access_token: "session-personal-token", token_type: "Bearer" }),
      ),
    }));
    expect(service.status().authenticatedUrls).toEqual([PIPEDREAM_PERSONAL_MCP_URL]);

    expect(() => service.clearPersonalCredentials({ strictPersistence: true })).not.toThrow();

    expect(service.status().authenticatedUrls).toEqual([]);
    expect(() => readFileSync(storePath, "utf8")).toThrow(/ENOENT|no such file/i);
    expect(operations.open).not.toHaveBeenCalled();
    expect(operations.sync).not.toHaveBeenCalled();
    expect(operations.close).not.toHaveBeenCalled();
  });

  it("signs out a session-only Personal account without rewriting a valid generic Windows store", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "poracode-personal-mcp-windows-clear-generic-"));
    const storePath = join(baseDir, "mcp-oauth.json");
    cleanups.push(() => rmSync(baseDir, { recursive: true, force: true }));
    const genericUrl = "https://existing.example.test/mcp";
    const serialized = JSON.stringify({
      servers: {
        [genericUrl]: {
          tokens: encryptSecret(
            baseDir,
            JSON.stringify({ access_token: "generic-token", token_type: "Bearer" }),
          ),
        },
      },
    });
    writeFileSync(storePath, serialized, { mode: 0o600 });
    const operations: FileDurabilityOperations = {
      open: vi.fn<(path: string, flags: "r" | "r+") => number>(),
      sync: vi.fn<(descriptor: number) => void>(),
      close: vi.fn<(descriptor: number) => void>(),
    };
    const service = new McpOAuthService({
      baseDir,
      storePath,
      durability: createFileDurability("win32", operations),
      persistCredentialsForServer: (url) => !isPipedreamPersonalMcpUrl(url),
      persistPersonalCredentials: false,
      failClosedOnStoreLoadError: true,
    });
    cleanups.push(() => service.dispose());
    const internals = service as unknown as {
      updateEntry(
        serverUrl: string,
        update: (entry: Record<string, unknown>) => Record<string, unknown>,
      ): void;
    };
    internals.updateEntry(PIPEDREAM_PERSONAL_MCP_URL, (entry) => ({
      ...entry,
      tokens: encryptSecret(
        baseDir,
        JSON.stringify({ access_token: "session-personal-token", token_type: "Bearer" }),
      ),
    }));
    expect(service.status().authenticatedUrls.sort()).toEqual(
      [genericUrl, PIPEDREAM_PERSONAL_MCP_URL].sort(),
    );

    expect(() => service.clearPersonalCredentials({ strictPersistence: true })).not.toThrow();

    expect(service.status().authenticatedUrls).toEqual([genericUrl]);
    expect(readFileSync(storePath, "utf8")).toBe(serialized);
    expect(operations.open).not.toHaveBeenCalled();
    expect(operations.sync).not.toHaveBeenCalled();
    expect(operations.close).not.toHaveBeenCalled();
  });

  it("signs out Personal on Windows while retaining an unrelated dirty generic projection", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "poracode-personal-mcp-windows-dirty-generic-"));
    const storePath = join(baseDir, "mcp-oauth.json");
    cleanups.push(() => rmSync(baseDir, { recursive: true, force: true }));
    const genericUrl = "https://existing.example.test/mcp";
    const sealed = (accessToken: string) =>
      encryptSecret(baseDir, JSON.stringify({ access_token: accessToken, token_type: "Bearer" }));
    const serialized = JSON.stringify({
      servers: { [genericUrl]: { tokens: sealed("generic-token-on-disk") } },
    });
    writeFileSync(storePath, serialized, { mode: 0o600 });
    const operations: FileDurabilityOperations = {
      open: vi.fn<(path: string, flags: "r" | "r+") => number>(),
      sync: vi.fn<(descriptor: number) => void>(),
      close: vi.fn<(descriptor: number) => void>(),
    };
    const service = new McpOAuthService({
      baseDir,
      storePath,
      durability: createFileDurability("win32", operations),
      persistCredentialsForServer: (url) => !isPipedreamPersonalMcpUrl(url),
      persistPersonalCredentials: false,
      failClosedOnStoreLoadError: true,
    });
    cleanups.push(() => service.dispose());
    const internals = service as unknown as {
      updateEntry(
        serverUrl: string,
        update: (entry: Record<string, unknown>) => Record<string, unknown>,
      ): void;
    };
    internals.updateEntry(genericUrl, (entry) => ({
      ...entry,
      tokens: sealed("new-session-generic-token"),
    }));
    internals.updateEntry(PIPEDREAM_PERSONAL_MCP_URL, (entry) => ({
      ...entry,
      tokens: sealed("session-personal-token"),
    }));

    expect(() => service.clearPersonalCredentials({ strictPersistence: true })).not.toThrow();

    expect(service.status().authenticatedUrls).toEqual([genericUrl]);
    expect(readFileSync(storePath, "utf8")).toBe(serialized);
    expect(() => service.clear({ url: genericUrl }, { strictPersistence: true })).toThrow(
      "Could not persist the OAuth credential change.",
    );
    expect(readFileSync(storePath, "utf8")).toBe(serialized);
  });

  it("rewrites Personal credentials after a persistence-enabled post-rename fsync failure", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "poracode-personal-mcp-post-rename-clear-"));
    const storePath = join(baseDir, "mcp-oauth.json");
    cleanups.push(() => rmSync(baseDir, { recursive: true, force: true }));
    const genericUrl = "https://existing.example.test/mcp";
    const sealed = (accessToken: string) =>
      encryptSecret(baseDir, JSON.stringify({ access_token: accessToken, token_type: "Bearer" }));
    writeFileSync(
      storePath,
      JSON.stringify({ servers: { [genericUrl]: { tokens: sealed("generic-token") } } }),
      { mode: 0o600 },
    );
    let fileFlushes = 0;
    let directoryFlushes = 0;
    const durability: FileDurability = {
      syncFile: () => {
        fileFlushes += 1;
      },
      syncDirectory: () => {
        directoryFlushes += 1;
        if (directoryFlushes === 2) {
          throw new Error("simulated post-rename directory fsync failure");
        }
      },
    };
    const service = new McpOAuthService({
      baseDir,
      storePath,
      durability,
      failClosedOnStoreLoadError: true,
    });
    cleanups.push(() => service.dispose());
    const internals = service as unknown as {
      updateEntry(
        serverUrl: string,
        update: (entry: Record<string, unknown>) => Record<string, unknown>,
      ): void;
    };
    internals.updateEntry(PIPEDREAM_PERSONAL_MCP_URL, (entry) => ({
      ...entry,
      tokens: sealed("personal-token-after-rename"),
    }));
    const afterFailedCommit = JSON.parse(readFileSync(storePath, "utf8")) as {
      servers: Record<string, unknown>;
    };
    expect(afterFailedCommit.servers).toHaveProperty(PIPEDREAM_PERSONAL_MCP_URL);

    expect(() => service.clearPersonalCredentials({ strictPersistence: true })).not.toThrow();

    const afterClear = JSON.parse(readFileSync(storePath, "utf8")) as {
      servers: Record<string, unknown>;
    };
    expect(afterClear.servers).not.toHaveProperty(PIPEDREAM_PERSONAL_MCP_URL);
    expect(afterClear.servers).toHaveProperty(genericUrl);
    expect(fileFlushes).toBe(2);
  });

  it("blocks startup when a Windows store still contains legacy Personal Pipedream credentials", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "poracode-mcp-oauth-windows-legacy-personal-"));
    const storePath = join(baseDir, "mcp-oauth.json");
    cleanups.push(() => rmSync(baseDir, { recursive: true, force: true }));
    const genericUrl = "https://existing.example.test/mcp";
    const sealed = (accessToken: string) =>
      encryptSecret(baseDir, JSON.stringify({ access_token: accessToken, token_type: "Bearer" }));
    const serialized = JSON.stringify({
      servers: {
        [genericUrl]: { tokens: sealed("generic-token") },
        [PIPEDREAM_PERSONAL_MCP_URL]: { tokens: sealed("legacy-personal-token") },
      },
    });
    writeFileSync(storePath, serialized, { mode: 0o600 });
    const operations: FileDurabilityOperations = {
      open: vi.fn<(path: string, flags: "r" | "r+") => number>(),
      sync: vi.fn<(descriptor: number) => void>(),
      close: vi.fn<(descriptor: number) => void>(),
    };

    expect(
      () =>
        new McpOAuthService({
          baseDir,
          storePath,
          durability: createFileDurability("win32", operations),
          persistCredentialsForServer: (url) => !isPipedreamPersonalMcpUrl(url),
          failClosedOnStoreLoadError: true,
        }),
    ).toThrow(McpOAuthCredentialStoreUnavailableError);

    expect(readFileSync(storePath, "utf8")).toBe(serialized);
    expect(operations.open).not.toHaveBeenCalled();
    expect(operations.sync).not.toHaveBeenCalled();
    expect(operations.close).not.toHaveBeenCalled();
  });

  it("completes the DCR + PKCE authorization flow through the loopback callback", async () => {
    const fake = await startFakeAuthServer({ expiresIn: 3600 });
    const service = makeService();
    const server = httpServer(fake.url);

    const begin = await service.begin({ server });
    expect(begin.status).toBe("redirect");
    if (begin.status !== "redirect") return;
    expect(begin.authorizationUrl).toContain(`${fake.url}/authorize`);

    const waitPromise = service.wait({ flowId: begin.flowId });
    await completeBrowserLeg(begin.authorizationUrl);
    expect(await waitPromise).toEqual({ status: "authorized" });

    expect(fake.tokenRequests[0]?.get("grant_type")).toBe("authorization_code");
    expect(fake.tokenRequests[0]?.get("code")).toBe("fake-code");
    expect(service.status().authenticatedUrls).toEqual([`${fake.url}/mcp`]);

    const authorized = await service.applyAuthorizationToServer(server);
    expect(
      authorized.transport.type === "http" ? authorized.transport.headers.Authorization : "",
    ).toBe("Bearer at-1");
  });

  it("refreshes expired tokens when applying authorization", async () => {
    const fake = await startFakeAuthServer({ expiresIn: 1 });
    const service = makeService();
    const server = httpServer(fake.url);

    const begin = await service.begin({ server });
    expect(begin.status).toBe("redirect");
    if (begin.status !== "redirect") return;
    const waitPromise = service.wait({ flowId: begin.flowId });
    await completeBrowserLeg(begin.authorizationUrl);
    expect(await waitPromise).toEqual({ status: "authorized" });

    const authorized = await service.applyAuthorizationToServer(server);
    expect(
      authorized.transport.type === "http" ? authorized.transport.headers.Authorization : "",
    ).toBe("Bearer at-2");
    expect(fake.tokenRequests.at(-1)?.get("grant_type")).toBe("refresh_token");
    expect(fake.tokenRequests.at(-1)?.get("refresh_token")).toBe("rt-1");
  });

  it("coalesces concurrent refreshes for one server and credential epoch", async () => {
    const fake = await startFakeAuthServer({ expiresIn: 1, deferRefresh: true });
    const service = makeService();
    const server = httpServer(fake.url);

    const begin = await service.begin({ server });
    if (begin.status !== "redirect") throw new Error("expected redirect");
    const wait = service.wait({ flowId: begin.flowId });
    await completeBrowserLeg(begin.authorizationUrl);
    await expect(wait).resolves.toEqual({ status: "authorized" });

    const first = service.applyAuthorizationToServer(server);
    const second = service.applyAuthorizationToServer(server);
    await vi.waitFor(() => expect(fake.tokenRequests.length).toBeGreaterThanOrEqual(2));
    await flushNetworkContinuation();
    const refreshRequests = fake.tokenRequests.filter(
      (request) => request.get("grant_type") === "refresh_token",
    ).length;
    fake.releaseAllTokenResponses();
    await Promise.all([first, second]);

    expect(refreshRequests).toBe(1);
  });

  it("keeps the managed Personal bearer behind a launch-scoped loopback capability", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "poracode-personal-mcp-relay-"));
    const storePath = join(baseDir, "mcp-oauth.json");
    const upstreamBearer = "personal-upstream-bearer-must-stay-supervisor-only";
    writeFileSync(
      storePath,
      JSON.stringify({
        servers: {
          [PIPEDREAM_PERSONAL_MCP_URL]: {
            tokens: encryptSecret(
              baseDir,
              JSON.stringify({ access_token: upstreamBearer, token_type: "Bearer" }),
            ),
            tokensSavedAt: Date.now(),
          },
        },
      }),
      { mode: 0o600 },
    );
    cleanups.push(() => rmSync(baseDir, { recursive: true, force: true }));
    let upstreamAuthorization: string | null = null;
    let upstreamSignal: AbortSignal | undefined;
    let releaseUpstream!: () => void;
    const upstreamPending = new Promise<Response>((resolve) => {
      releaseUpstream = () =>
        resolve(
          new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), {
            headers: { "content-type": "application/json" },
          }),
        );
    });
    const service = new McpOAuthService({
      baseDir,
      storePath,
      fetch: vi.fn<typeof fetch>(async (_input, init) => {
        upstreamAuthorization = new Headers(init?.headers).get("authorization");
        upstreamSignal = init?.signal ?? undefined;
        return upstreamPending;
      }),
    });
    cleanups.push(() => service.dispose());
    const personal: McpServer = {
      id: "pipedream-personal-mcp",
      name: "pd",
      description: "Personal Pipedream tools",
      enabled: true,
      timeoutMs: 30_000,
      transport: {
        type: "http",
        url: `${PIPEDREAM_PERSONAL_MCP_URL}/?legacy=1`,
        headers: { Authorization: `Bearer ${upstreamBearer}` },
      },
    };

    const launchInput = await service.applyAuthorization([personal]);
    expect(JSON.stringify(launchInput)).not.toContain(upstreamBearer);
    const [relayServer] = await service.resolvePersonalMcpServersForLaunch({
      servers: launchInput,
      threadId: "thread-personal-relay",
      providerBindingId: "thread:thread-personal-relay:launch:launch-a",
    });
    expect(relayServer).toBeDefined();
    const serializedProviders = JSON.stringify({
      codex: buildCodexMcp([relayServer as ResolvedMcpServer]),
      claude: buildClaudeMcpLaunchConfig([relayServer as ResolvedMcpServer]),
      opencode: buildOpenCodeMcpLaunchConfig([relayServer as ResolvedMcpServer]),
    });
    expect(serializedProviders).not.toContain(upstreamBearer);
    expect(serializedProviders).toContain("127.0.0.1");

    if (relayServer?.transport.type !== "http") throw new Error("expected HTTP relay");
    const relayRequest = fetch(relayServer.transport.url, {
      method: "POST",
      headers: {
        ...relayServer.transport.headers,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    await vi.waitFor(() => expect(upstreamAuthorization).toBe(`Bearer ${upstreamBearer}`));

    service.clearPersonalCredentials({ strictPersistence: true });
    expect(upstreamSignal?.aborted).toBe(true);
    releaseUpstream();
    await expect(relayRequest).resolves.toMatchObject({ status: 404 });
    await expect(
      fetch(relayServer.transport.url, { headers: relayServer.transport.headers }),
    ).resolves.toMatchObject({ status: 404 });
  });

  it("revokes an obsolete live-reload binding without disturbing a sibling provider binding", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "poracode-personal-mcp-live-reload-"));
    const storePath = join(baseDir, "mcp-oauth.json");
    writeFileSync(
      storePath,
      JSON.stringify({
        servers: {
          [PIPEDREAM_PERSONAL_MCP_URL]: {
            tokens: encryptSecret(
              baseDir,
              JSON.stringify({ access_token: "personal-token", token_type: "Bearer" }),
            ),
            tokensSavedAt: Date.now(),
          },
        },
      }),
      { mode: 0o600 },
    );
    cleanups.push(() => rmSync(baseDir, { recursive: true, force: true }));
    const service = new McpOAuthService({
      baseDir,
      storePath,
      fetch: vi.fn<typeof fetch>(async () =>
        Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [] } }),
      ),
    });
    cleanups.push(() => service.dispose());
    const personal: McpServer = {
      id: "pipedream-personal-mcp",
      name: "pd",
      description: "Personal Pipedream tools",
      enabled: true,
      timeoutMs: 30_000,
      transport: { type: "http", url: PIPEDREAM_PERSONAL_MCP_URL, headers: {} },
    };
    const threadId = "thread-personal-live-reload";
    const removedProviderBindingId = `thread:${threadId}:launch:removed`;
    const siblingProviderBindingId = `thread:${threadId}:launch:sibling`;
    const [removed] = await service.resolvePersonalMcpServersForLaunch({
      servers: [personal],
      threadId,
      providerBindingId: removedProviderBindingId,
    });
    const [sibling] = await service.resolvePersonalMcpServersForLaunch({
      servers: [personal],
      threadId,
      providerBindingId: siblingProviderBindingId,
    });
    if (removed?.transport.type !== "http" || sibling?.transport.type !== "http") {
      throw new Error("expected HTTP relays");
    }
    const requestRelay = (transport: Extract<ResolvedMcpServer["transport"], { type: "http" }>) =>
      fetch(transport.url, {
        method: "POST",
        headers: { ...transport.headers, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });

    await expect(requestRelay(removed.transport)).resolves.toMatchObject({ status: 200 });
    await service.resolvePersonalMcpServersForLaunch({
      servers: [],
      threadId,
      providerBindingId: removedProviderBindingId,
    });

    await expect(requestRelay(removed.transport)).resolves.toMatchObject({ status: 404 });
    await expect(requestRelay(sibling.transport)).resolves.toMatchObject({ status: 200 });
  });

  it("revokes a removed binding even when its live-reload replacement cannot register", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "poracode-personal-mcp-failed-replacement-"));
    const storePath = join(baseDir, "mcp-oauth.json");
    writeFileSync(
      storePath,
      JSON.stringify({
        servers: {
          [PIPEDREAM_PERSONAL_MCP_URL]: {
            tokens: encryptSecret(
              baseDir,
              JSON.stringify({ access_token: "personal-token", token_type: "Bearer" }),
            ),
            tokensSavedAt: Date.now(),
          },
        },
      }),
      { mode: 0o600 },
    );
    cleanups.push(() => rmSync(baseDir, { recursive: true, force: true }));
    const service = new McpOAuthService({
      baseDir,
      storePath,
      fetch: vi.fn<typeof fetch>(async () =>
        Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [] } }),
      ),
    });
    cleanups.push(() => service.dispose());
    const threadId = "thread-personal-failed-replacement";
    const providerBindingId = `thread:${threadId}:launch:live`;
    const removed: McpServer = {
      id: "pipedream-personal-removed",
      name: "removed",
      description: "Removed Personal Pipedream tools",
      enabled: true,
      timeoutMs: 30_000,
      transport: { type: "http", url: PIPEDREAM_PERSONAL_MCP_URL, headers: {} },
    };
    const replacement: McpServer = {
      ...removed,
      id: "pipedream-personal-replacement",
      name: "replacement",
      description: "Replacement Personal Pipedream tools",
    };
    const [oldRelay] = await service.resolvePersonalMcpServersForLaunch({
      servers: [removed],
      threadId,
      providerBindingId,
    });
    if (oldRelay?.transport.type !== "http") throw new Error("expected HTTP relay");
    const relay = Reflect.get(service, "personalRelay") as PersonalMcpLoopbackRelay;
    vi.spyOn(relay, "registerBinding").mockRejectedValueOnce(
      new Error("replacement relay could not bind"),
    );

    await expect(
      service.resolvePersonalMcpServersForLaunch({
        servers: [replacement],
        threadId,
        providerBindingId,
      }),
    ).rejects.toThrow("replacement relay could not bind");

    await expect(
      fetch(oldRelay.transport.url, {
        method: "POST",
        headers: { ...oldRelay.transport.headers, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
    ).resolves.toMatchObject({ status: 404 });
  });

  it("replaces a live binding when its advertised WSL gateway changes", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "poracode-personal-mcp-gateway-change-"));
    const storePath = join(baseDir, "mcp-oauth.json");
    writeFileSync(
      storePath,
      JSON.stringify({
        servers: {
          [PIPEDREAM_PERSONAL_MCP_URL]: {
            tokens: encryptSecret(
              baseDir,
              JSON.stringify({ access_token: "personal-token", token_type: "Bearer" }),
            ),
            tokensSavedAt: Date.now(),
          },
        },
      }),
      { mode: 0o600 },
    );
    cleanups.push(() => rmSync(baseDir, { recursive: true, force: true }));
    const service = new McpOAuthService({
      baseDir,
      storePath,
      fetch: vi.fn<typeof fetch>(async () =>
        Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [] } }),
      ),
    });
    cleanups.push(() => service.dispose());
    const personal: McpServer = {
      id: "pipedream-personal-mcp",
      name: "pd",
      description: "Personal Pipedream tools",
      enabled: true,
      timeoutMs: 30_000,
      transport: { type: "http", url: PIPEDREAM_PERSONAL_MCP_URL, headers: {} },
    };
    const input = {
      servers: [personal],
      threadId: "thread-personal-gateway-change",
      providerBindingId: "thread:thread-personal-gateway-change:launch:live",
    } as const;
    const [oldRelay] = await service.resolvePersonalMcpServersForLaunch({
      ...input,
      advertisedHost: "192.0.2.10",
    });
    const [newRelay] = await service.resolvePersonalMcpServersForLaunch({
      ...input,
      advertisedHost: "192.0.2.11",
    });
    if (oldRelay?.transport.type !== "http" || newRelay?.transport.type !== "http") {
      throw new Error("expected HTTP relays");
    }

    expect(new URL(oldRelay.transport.url).hostname).toBe("192.0.2.10");
    expect(new URL(newRelay.transport.url).hostname).toBe("192.0.2.11");
    const revokedLoopbackUrl = new URL(oldRelay.transport.url);
    revokedLoopbackUrl.hostname = "127.0.0.1";
    await expect(
      fetch(revokedLoopbackUrl, {
        method: "POST",
        headers: { ...oldRelay.transport.headers, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
    ).resolves.toMatchObject({ status: 404 });
  });

  it("revokes every raced registration when identical live reloads overlap", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "poracode-personal-mcp-overlap-"));
    const storePath = join(baseDir, "mcp-oauth.json");
    writeFileSync(
      storePath,
      JSON.stringify({
        servers: {
          [PIPEDREAM_PERSONAL_MCP_URL]: {
            tokens: encryptSecret(
              baseDir,
              JSON.stringify({ access_token: "personal-token", token_type: "Bearer" }),
            ),
            tokensSavedAt: Date.now(),
          },
        },
      }),
      { mode: 0o600 },
    );
    cleanups.push(() => rmSync(baseDir, { recursive: true, force: true }));
    const service = new McpOAuthService({
      baseDir,
      storePath,
      fetch: vi.fn<typeof fetch>(async () =>
        Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [] } }),
      ),
    });
    cleanups.push(() => service.dispose());
    const relay = Reflect.get(service, "personalRelay") as PersonalMcpLoopbackRelay;
    const originalRegisterBinding = relay.registerBinding.bind(relay);
    const registrations: PersonalMcpRelayBindingInfo[] = [];
    let releaseFirstRegistration!: () => void;
    const firstRegistrationGate = new Promise<void>((resolve) => {
      releaseFirstRegistration = resolve;
    });
    let reportFirstRegistration!: () => void;
    const firstRegistration = new Promise<void>((resolve) => {
      reportFirstRegistration = resolve;
    });
    vi.spyOn(relay, "registerBinding").mockImplementation(async (input) => {
      const info = await originalRegisterBinding(input);
      registrations.push(info);
      if (registrations.length === 1) {
        reportFirstRegistration();
        await firstRegistrationGate;
      }
      return info;
    });
    const personal: McpServer = {
      id: "pipedream-personal-mcp",
      name: "pd",
      description: "Personal Pipedream tools",
      enabled: true,
      timeoutMs: 30_000,
      transport: { type: "http", url: PIPEDREAM_PERSONAL_MCP_URL, headers: {} },
    };
    const input = {
      servers: [personal],
      threadId: "thread-personal-overlap",
      providerBindingId: "thread:thread-personal-overlap:launch:live",
    } as const;

    const staleResolve = service.resolvePersonalMcpServersForLaunch(input);
    await firstRegistration;
    const currentResolve = service.resolvePersonalMcpServersForLaunch(input);
    await expect(currentResolve).resolves.toHaveLength(1);
    releaseFirstRegistration();
    await expect(staleResolve).resolves.toEqual([]);
    expect(registrations).toHaveLength(2);

    await expect(
      service.resolvePersonalMcpServersForLaunch({
        ...input,
        servers: [personal, { ...personal }],
      }),
    ).resolves.toHaveLength(1);
    expect(registrations).toHaveLength(2);

    await service.resolvePersonalMcpServersForLaunch({ ...input, servers: [] });
    for (const registration of registrations) {
      await expect(
        fetch(registration.url, {
          method: "POST",
          headers: { ...registration.headers, "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        }),
      ).resolves.toMatchObject({ status: 404 });
    }
    expect(
      (Reflect.get(service, "personalProviderBindingResolutionEpochs") as Map<string, number>).size,
    ).toBe(0);
    expect(
      (Reflect.get(service, "pendingPersonalProviderBindingResolutions") as Map<string, number>)
        .size,
    ).toBe(0);
  });

  it("retains a thread revocation tombstone only until an overlapping relay resolve settles", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "poracode-personal-mcp-release-race-"));
    const storePath = join(baseDir, "mcp-oauth.json");
    writeFileSync(
      storePath,
      JSON.stringify({
        servers: {
          [PIPEDREAM_PERSONAL_MCP_URL]: {
            tokens: encryptSecret(
              baseDir,
              JSON.stringify({ access_token: "personal-token", token_type: "Bearer" }),
            ),
            tokensSavedAt: Date.now(),
          },
        },
      }),
      { mode: 0o600 },
    );
    cleanups.push(() => rmSync(baseDir, { recursive: true, force: true }));
    const service = new McpOAuthService({ baseDir, storePath });
    cleanups.push(() => service.dispose());
    const personal: McpServer = {
      id: "pipedream-personal-mcp",
      name: "pd",
      description: "Personal Pipedream tools",
      enabled: true,
      timeoutMs: 30_000,
      transport: { type: "http", url: PIPEDREAM_PERSONAL_MCP_URL, headers: {} },
    };

    const staleResolve = service.resolvePersonalMcpServersForLaunch({
      servers: [personal],
      threadId: "thread-release-race",
      providerBindingId: "thread:thread-release-race:launch:stale",
    });
    service.releasePersonalMcpBindings("thread-release-race");

    await expect(staleResolve).resolves.toEqual([]);
    const threadEpochs = Reflect.get(service, "personalThreadBindingEpochs") as Map<string, number>;
    expect(threadEpochs.size).toBe(0);

    const replacement = await service.resolvePersonalMcpServersForLaunch({
      servers: [personal],
      threadId: "thread-release-race",
      providerBindingId: "thread:thread-release-race:launch:replacement",
    });
    expect(replacement).toHaveLength(1);
    service.releasePersonalMcpBindings("thread-release-race");
    expect(threadEpochs.size).toBe(0);
  });

  it("revokes only one launch-scoped Personal relay without touching its replacement", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "poracode-personal-mcp-scoped-release-"));
    const storePath = join(baseDir, "mcp-oauth.json");
    writeFileSync(
      storePath,
      JSON.stringify({
        servers: {
          [PIPEDREAM_PERSONAL_MCP_URL]: {
            tokens: encryptSecret(
              baseDir,
              JSON.stringify({ access_token: "personal-token", token_type: "Bearer" }),
            ),
            tokensSavedAt: Date.now(),
          },
        },
      }),
      { mode: 0o600 },
    );
    cleanups.push(() => rmSync(baseDir, { recursive: true, force: true }));
    const service = new McpOAuthService({ baseDir, storePath });
    cleanups.push(() => service.dispose());
    const personal: McpServer = {
      id: "pipedream-personal-mcp",
      name: "pd",
      description: "Personal Pipedream tools",
      enabled: true,
      timeoutMs: 30_000,
      transport: { type: "http", url: PIPEDREAM_PERSONAL_MCP_URL, headers: {} },
    };
    const threadId = "thread-scoped-personal-release";
    const staleProviderBindingId = `thread:${threadId}:launch:stale`;
    const replacementProviderBindingId = `thread:${threadId}:launch:replacement`;
    const [stale] = await service.resolvePersonalMcpServersForLaunch({
      servers: [personal],
      threadId,
      providerBindingId: staleProviderBindingId,
    });
    const [replacement] = await service.resolvePersonalMcpServersForLaunch({
      servers: [personal],
      threadId,
      providerBindingId: replacementProviderBindingId,
    });

    service.releasePersonalMcpProviderBindings(threadId, staleProviderBindingId);

    const post = async (server: ResolvedMcpServer | undefined) =>
      fetch(server?.transport.type === "http" ? server.transport.url : "", {
        method: "POST",
        headers:
          server?.transport.type === "http"
            ? { ...server.transport.headers, "content-type": "application/json" }
            : {},
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
    await expect(post(stale)).resolves.toMatchObject({ status: 404 });
    await expect(post(replacement)).resolves.not.toMatchObject({ status: 404 });
  });

  it("atomically clears every canonical Personal URL variant", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "poracode-personal-mcp-alias-clear-"));
    const storePath = join(baseDir, "mcp-oauth.json");
    const personalUrls = [
      PIPEDREAM_PERSONAL_MCP_URL,
      `${PIPEDREAM_PERSONAL_MCP_URL}/`,
      `${PIPEDREAM_PERSONAL_MCP_URL}?legacy=1`,
      `${PIPEDREAM_PERSONAL_MCP_URL}#legacy`,
    ];
    const sealedTokens = Object.fromEntries(
      personalUrls.map((url, index) => [
        url,
        {
          tokens: encryptSecret(
            baseDir,
            JSON.stringify({
              access_token: `legacy-personal-token-${index}`,
              token_type: "Bearer",
            }),
          ),
        },
      ]),
    );
    writeFileSync(
      storePath,
      JSON.stringify({
        servers: {
          ...sealedTokens,
          "https://generic.example.test/mcp": {
            tokens: encryptSecret(
              baseDir,
              JSON.stringify({ access_token: "generic-token", token_type: "Bearer" }),
            ),
          },
        },
      }),
      { mode: 0o600 },
    );
    cleanups.push(() => rmSync(baseDir, { recursive: true, force: true }));
    const service = new McpOAuthService({ baseDir, storePath });
    cleanups.push(() => service.dispose());

    service.clearPersonalCredentials({ strictPersistence: true });

    expect(service.status().authenticatedUrls).toEqual(["https://generic.example.test/mcp"]);
    const persisted = JSON.parse(readFileSync(storePath, "utf8")) as {
      servers: Record<string, unknown>;
    };
    expect(Object.keys(persisted.servers)).toEqual(["https://generic.example.test/mcp"]);
  });

  it("keeps Personal Pipedream OAuth session-only when durable persistence is not trusted", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "poracode-personal-mcp-session-only-"));
    const storePath = join(baseDir, "mcp-oauth.json");
    const genericUrl = "https://generic.example.test/mcp";
    const sealed = (accessToken: string) =>
      encryptSecret(baseDir, JSON.stringify({ access_token: accessToken, token_type: "Bearer" }));
    writeFileSync(
      storePath,
      JSON.stringify({
        servers: {
          [PIPEDREAM_PERSONAL_MCP_URL]: { tokens: sealed("legacy-personal-token") },
          [genericUrl]: { tokens: sealed("generic-token") },
        },
      }),
      { mode: 0o600 },
    );
    cleanups.push(() => rmSync(baseDir, { recursive: true, force: true }));
    const persistCredentialsForServer = (url: string) => !isPipedreamPersonalMcpUrl(url);
    const service = new McpOAuthService({
      baseDir,
      storePath,
      persistCredentialsForServer,
    });
    cleanups.push(() => service.dispose());

    expect(service.status().authenticatedUrls).toEqual([genericUrl]);
    const internals = service as unknown as {
      updateEntry(
        serverUrl: string,
        update: (entry: Record<string, unknown>) => Record<string, unknown>,
      ): void;
    };
    internals.updateEntry(PIPEDREAM_PERSONAL_MCP_URL, (entry) => ({
      ...entry,
      tokens: sealed("session-personal-token"),
      tokensSavedAt: Date.now(),
    }));

    expect(service.status().authenticatedUrls.sort()).toEqual(
      [genericUrl, PIPEDREAM_PERSONAL_MCP_URL].sort(),
    );
    const persisted = JSON.parse(readFileSync(storePath, "utf8")) as {
      servers: Record<string, unknown>;
    };
    expect(Object.keys(persisted.servers)).toEqual([genericUrl]);

    const restarted = new McpOAuthService({
      baseDir,
      storePath,
      persistCredentialsForServer,
    });
    cleanups.push(() => restarted.dispose());
    expect(restarted.status().authenticatedUrls).toEqual([genericUrl]);
  });

  it("invalidates a Personal URL alias while its sign-in listener is still opening", async () => {
    const service = makeService();
    const personalAlias = "https://legacy-user@mcp.pipedream.net./v2/?pending=1";
    const server: McpServer = {
      id: "personal-pending-alias",
      name: "pd-pending-alias",
      description: "",
      enabled: true,
      timeoutMs: 30_000,
      transport: { type: "http", url: personalAlias, headers: {} },
    };
    let openListener!: (listener: Server) => void;
    const listenerOpening = new Promise<Server>((resolve) => {
      openListener = resolve;
    });
    const internals = service as unknown as {
      credentialEpochs: Map<string, number>;
      openLoopbackListener(): Promise<Server>;
    };
    vi.spyOn(internals, "openLoopbackListener").mockReturnValue(listenerOpening);

    const pendingBegin = service.begin({ server });
    expect(internals.credentialEpochs.get(personalAlias)).toBe(1);

    service.clearPersonalCredentials({ strictPersistence: true });

    expect(internals.credentialEpochs.get(personalAlias)).toBe(2);
    openListener({ close: vi.fn<() => void>() } as unknown as Server);
    await expect(pendingBegin).resolves.toEqual({
      status: "error",
      message: "The sign-in flow is no longer active.",
    });
  });

  it("rejects stdio servers and leaves user-provided Authorization headers alone", async () => {
    const service = makeService();
    const stdio: McpServer = {
      id: "stdio-1",
      name: "local",
      description: "",
      enabled: true,
      timeoutMs: 30_000,
      transport: { type: "stdio", command: "node", args: [], env: {} },
    };
    expect(await service.begin({ server: stdio })).toEqual({
      status: "error",
      message: "Only HTTP MCP servers support sign-in.",
    });

    const manual: McpServer = {
      ...httpServer("http://127.0.0.1:9"),
      transport: {
        type: "http",
        url: "http://127.0.0.1:9/mcp",
        headers: { authorization: "Bearer manual" },
      },
    };
    expect(await service.applyAuthorizationToServer(manual)).toBe(manual);
  });

  it("clears stored credentials and stops reporting the URL as authenticated", async () => {
    const fake = await startFakeAuthServer({ expiresIn: 3600 });
    const service = makeService();
    const server = httpServer(fake.url);

    const begin = await service.begin({ server });
    if (begin.status !== "redirect") throw new Error("expected redirect");
    const waitPromise = service.wait({ flowId: begin.flowId });
    await completeBrowserLeg(begin.authorizationUrl);
    await waitPromise;

    service.clear({ url: `${fake.url}/mcp` });
    expect(service.status().authenticatedUrls).toEqual([]);
    const untouched = await service.applyAuthorizationToServer(server);
    expect(untouched).toBe(server);
  });

  it("cancels one exact interactive flow and releases its callback listener", async () => {
    const fake = await startFakeAuthServer({ expiresIn: 3600 });
    const service = makeService();
    const server = httpServer(fake.url);

    const pending = await service.begin({ server });
    if (pending.status !== "redirect") throw new Error("expected redirect");
    const wait = service.wait({ flowId: pending.flowId });
    service.cancel({ flowId: pending.flowId });

    await expect(wait).resolves.toEqual({
      status: "error",
      message: "The sign-in flow was canceled.",
    });
    expect(service.status().authenticatedUrls).toEqual([]);
    await expect(
      fetch(new URL(pending.authorizationUrl).searchParams.get("redirect_uri")!),
    ).rejects.toThrow(/fetch failed|connect/i);
  });

  it("does not persist a token when an exact flow is canceled during code exchange", async () => {
    const fake = await startFakeAuthServer({ expiresIn: 3600, deferAuthorizationCode: true });
    const service = makeService();
    const server = httpServer(fake.url);

    const pending = await service.begin({ server });
    if (pending.status !== "redirect") throw new Error("expected redirect");
    const wait = service.wait({ flowId: pending.flowId });
    await completeBrowserLeg(pending.authorizationUrl);
    await vi.waitFor(() => expect(fake.tokenRequests).toHaveLength(1));

    service.cancel({ flowId: pending.flowId });
    fake.releaseNextTokenResponse();

    await expect(wait).resolves.toEqual({
      status: "error",
      message: "The sign-in flow was canceled.",
    });
    await flushNetworkContinuation();
    expect(service.status().authenticatedUrls).toEqual([]);
    await expect(service.applyAuthorizationToServer(server)).resolves.toBe(server);
  });

  it("aborts a pending client registration before it can save or return a stale flow", async () => {
    const fake = await startFakeAuthServer({ expiresIn: 3600, deferFirstRegistration: true });
    const service = makeService();
    const server = httpServer(fake.url);

    const pendingBegin = service.begin({ server });
    await vi.waitFor(() => expect(fake.registrationRequests).toBe(1));
    service.clear({ url: `${fake.url}/mcp` });
    fake.releaseNextRegistrationResponse();

    await expect(pendingBegin).resolves.toMatchObject({ status: "error" });
    expect(service.status().authenticatedUrls).toEqual([]);

    const replacement = await service.begin({ server });
    expect(fake.registrationRequests).toBe(2);
    if (replacement.status === "redirect") service.cancel({ flowId: replacement.flowId });
  });

  it("cannot restore or return a bearer from a refresh that completes after clear", async () => {
    const fake = await startFakeAuthServer({ expiresIn: 1, deferRefresh: true });
    const service = makeService();
    const server = httpServer(fake.url);

    const begin = await service.begin({ server });
    if (begin.status !== "redirect") throw new Error("expected redirect");
    const wait = service.wait({ flowId: begin.flowId });
    await completeBrowserLeg(begin.authorizationUrl);
    await expect(wait).resolves.toEqual({ status: "authorized" });

    const authorization = service.applyAuthorizationToServer(server);
    await vi.waitFor(() => expect(fake.tokenRequests).toHaveLength(2));
    service.clear({ url: `${fake.url}/mcp` });
    fake.releaseNextTokenResponse();

    await expect(authorization).resolves.toBe(server);
    expect(service.status().authenticatedUrls).toEqual([]);
  });

  it("surfaces strict atomic persistence failure while keeping credentials revoked in memory", async () => {
    const fake = await startFakeAuthServer({ expiresIn: 3600 });
    const baseDir = mkdtempSync(join(tmpdir(), "poracode-mcp-oauth-strict-"));
    const storePath = join(baseDir, "mcp-oauth.json");
    cleanups.push(() => rmSync(baseDir, { recursive: true, force: true }));
    const service = new McpOAuthService({ baseDir, storePath });
    cleanups.push(() => service.dispose());
    const server = httpServer(fake.url);

    const begin = await service.begin({ server });
    if (begin.status !== "redirect") throw new Error("expected redirect");
    const wait = service.wait({ flowId: begin.flowId });
    await completeBrowserLeg(begin.authorizationUrl);
    await expect(wait).resolves.toEqual({ status: "authorized" });

    rmSync(storePath);
    mkdirSync(storePath);

    expect(() => service.clear({ url: `${fake.url}/mcp` }, { strictPersistence: true })).toThrow(
      /persist|credential/i,
    );
    expect(service.status().authenticatedUrls).toEqual([]);
    expect(readdirSync(baseDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("retries a pending strict Personal clear until the durable store matches", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "poracode-mcp-oauth-strict-retry-"));
    const storePath = join(baseDir, "mcp-oauth.json");
    const persistedCredentialStore = `${JSON.stringify({
      servers: {
        [PIPEDREAM_PERSONAL_MCP_URL]: {
          tokens: encryptSecret(
            baseDir,
            JSON.stringify({ access_token: "personal-token", token_type: "Bearer" }),
          ),
          tokensSavedAt: Date.now(),
        },
      },
    })}\n`;
    writeFileSync(storePath, persistedCredentialStore, { mode: 0o600 });
    cleanups.push(() => rmSync(baseDir, { recursive: true, force: true }));
    const service = new McpOAuthService({ baseDir, storePath });
    cleanups.push(() => service.dispose());
    expect(service.status().authenticatedUrls).toContain(PIPEDREAM_PERSONAL_MCP_URL);

    rmSync(storePath);
    mkdirSync(storePath);
    expect(() => service.clearPersonalCredentials({ strictPersistence: true })).toThrow(
      /persist|credential/i,
    );
    expect(service.status().authenticatedUrls).toEqual([]);
    expect(() => service.clearPersonalCredentials({ strictPersistence: true })).toThrow(
      /persist|credential/i,
    );

    rmSync(storePath, { recursive: true });
    writeFileSync(storePath, persistedCredentialStore, { mode: 0o600 });
    expect(() => service.clearPersonalCredentials({ strictPersistence: true })).not.toThrow();
    const durableStore = JSON.parse(readFileSync(storePath, "utf8")) as {
      servers: Record<string, unknown>;
    };
    expect(durableStore.servers[PIPEDREAM_PERSONAL_MCP_URL]).toBeUndefined();
  });

  it("does not report strict clear success when the durable store cannot be read", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "poracode-mcp-oauth-unreadable-"));
    const storePath = join(baseDir, "mcp-oauth.json");
    const malformedStore = "{not-valid-json";
    writeFileSync(storePath, malformedStore, { mode: 0o600 });
    cleanups.push(() => rmSync(baseDir, { recursive: true, force: true }));
    const service = new McpOAuthService({ baseDir, storePath });
    cleanups.push(() => service.dispose());

    expect(() =>
      service.clear({ url: "https://mcp.pipedream.net/v2" }, { strictPersistence: true }),
    ).toThrow(/persist|credential/i);
    expect(readFileSync(storePath, "utf8")).toBe(malformedStore);
  });

  it("fails closed without modifying a malformed store under a restrictive policy", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "poracode-mcp-oauth-fail-closed-"));
    const storePath = join(baseDir, "mcp-oauth.json");
    const malformedStore = `{"servers":{"${PIPEDREAM_PERSONAL_MCP_URL}":{"tokens":"sentinel"}}`;
    writeFileSync(storePath, malformedStore, { mode: 0o600 });
    cleanups.push(() => rmSync(baseDir, { recursive: true, force: true }));

    expect(
      () =>
        new McpOAuthService({
          baseDir,
          storePath,
          persistCredentialsForServer: (url) => !isPipedreamPersonalMcpUrl(url),
          failClosedOnStoreLoadError: true,
        }),
    ).toThrow("The OAuth credential store could not be verified safely.");
    expect(readFileSync(storePath, "utf8")).toBe(malformedStore);
  });

  it.each([
    "null",
    "[]",
    "{}",
    '{"servers":null}',
    '{"servers":[]}',
    `{"servers":{"${PIPEDREAM_PERSONAL_MCP_URL}":{"tokens":"sentinel","unexpected":"legacy-material"}}}`,
  ])("fails closed without rewriting valid JSON with a noncanonical shape: %s", (store) => {
    const baseDir = mkdtempSync(join(tmpdir(), "poracode-mcp-oauth-shape-"));
    const storePath = join(baseDir, "mcp-oauth.json");
    writeFileSync(storePath, store, { mode: 0o600 });
    cleanups.push(() => rmSync(baseDir, { recursive: true, force: true }));

    expect(
      () =>
        new McpOAuthService({
          baseDir,
          storePath,
          persistCredentialsForServer: (url) => !isPipedreamPersonalMcpUrl(url),
          failClosedOnStoreLoadError: true,
        }),
    ).toThrow("The OAuth credential store could not be verified safely.");
    expect(readFileSync(storePath, "utf8")).toBe(store);
  });

  it.each(["file flush", "rename", "directory flush"] as const)(
    "refuses restrictive startup when durable legacy cleanup fails during %s",
    (failurePoint) => {
      const baseDir = mkdtempSync(join(tmpdir(), "poracode-mcp-oauth-durable-cleanup-"));
      const storePath = join(baseDir, "mcp-oauth.json");
      const sealed = encryptSecret(
        baseDir,
        JSON.stringify({ access_token: "legacy-personal-token", token_type: "Bearer" }),
      );
      writeFileSync(
        storePath,
        JSON.stringify({
          servers: { [PIPEDREAM_PERSONAL_MCP_URL]: { tokens: sealed } },
        }),
        { mode: 0o600 },
      );
      cleanups.push(() => rmSync(baseDir, { recursive: true, force: true }));
      const durability: FileDurability = {
        syncFile: () => {
          if (failurePoint === "file flush") throw new Error("simulated file flush failure");
          if (failurePoint === "rename") {
            rmSync(storePath);
            mkdirSync(storePath);
          }
        },
        syncDirectory: () => {
          if (failurePoint === "directory flush") {
            throw new Error("simulated directory flush failure");
          }
        },
      };

      expect(
        () =>
          new McpOAuthService({
            baseDir,
            storePath,
            persistCredentialsForServer: (url) => !isPipedreamPersonalMcpUrl(url),
            failClosedOnStoreLoadError: true,
            durability,
          }),
      ).toThrow("The OAuth credential store could not be verified safely.");
    },
  );

  it("repairs a prior post-rename directory flush before trusting the cleared store on relaunch", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "poracode-mcp-oauth-relaunch-repair-"));
    const storePath = join(baseDir, "mcp-oauth.json");
    const url = "https://mcp.example.com";
    writeFileSync(
      storePath,
      JSON.stringify({
        servers: {
          [url]: {
            tokens: encryptSecret(
              baseDir,
              JSON.stringify({ access_token: "old-token", token_type: "Bearer" }),
            ),
          },
        },
      }),
      { mode: 0o600 },
    );
    cleanups.push(() => rmSync(baseDir, { recursive: true, force: true }));
    let directoryFlushes = 0;
    const firstDurability: FileDurability = {
      syncFile: () => undefined,
      syncDirectory: () => {
        directoryFlushes += 1;
        if (directoryFlushes === 2) {
          throw new Error("simulated post-rename directory flush failure");
        }
      },
    };
    const first = new McpOAuthService({
      baseDir,
      storePath,
      failClosedOnStoreLoadError: true,
      durability: firstDurability,
    });
    cleanups.push(() => first.dispose());

    expect(() => first.clear({ url }, { strictPersistence: true })).toThrow(
      "Could not persist the OAuth credential change.",
    );

    const repairedDirectories: string[] = [];
    const second = new McpOAuthService({
      baseDir,
      storePath,
      failClosedOnStoreLoadError: true,
      durability: {
        syncFile: () => undefined,
        syncDirectory: (path) => repairedDirectories.push(path),
      },
    });
    cleanups.push(() => second.dispose());
    expect(second.status().authenticatedUrls).toEqual([]);
    expect(repairedDirectories).toEqual([baseDir]);
  });

  it("does not report credentials encrypted with an unavailable key as authenticated", () => {
    const dir = mkdtempSync(join(tmpdir(), "poracode-mcp-oauth-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const url = "https://mcp.vercel.com";
    const sealed = encryptSecret(dir, JSON.stringify({ access_token: "old" }));
    const ciphertextStart = sealed.lastIndexOf(":") + 1;
    const invalidSealed = `${sealed.slice(0, ciphertextStart)}${sealed[ciphertextStart] === "A" ? "B" : "A"}${sealed.slice(ciphertextStart + 1)}`;
    writeFileSync(
      join(dir, "mcp-oauth.json"),
      JSON.stringify({
        servers: {
          [url]: { tokens: invalidSealed },
        },
      }),
    );
    const service = new McpOAuthService({ baseDir: dir });
    cleanups.push(() => service.dispose());

    expect(service.status().authenticatedUrls).toEqual([]);
  });

  it("ignores callbacks with a mismatched state parameter", async () => {
    const fake = await startFakeAuthServer({ expiresIn: 3600 });
    const service = makeService();

    const begin = await service.begin({ server: httpServer(fake.url) });
    if (begin.status !== "redirect") throw new Error("expected redirect");
    const url = new URL(begin.authorizationUrl);
    const callback = new URL(url.searchParams.get("redirect_uri") as string);
    callback.searchParams.set("code", "attacker-code");
    callback.searchParams.set("state", "wrong-state");
    const response = await fetch(callback);
    expect(response.status).toBe(400);
    expect(fake.tokenRequests).toHaveLength(0);
    expect(service.status().authenticatedUrls).toEqual([]);
  });
});
