import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@/shared/contracts";
import { encryptSecret } from "@/shared/secretStorage";
import { McpOAuthService } from "./McpOAuthService";

interface FakeAuthServer {
  url: string;
  tokenRequests: URLSearchParams[];
  readonly registrationRequests: number;
  releaseNextRegistrationResponse: () => void;
  releaseNextTokenResponse: () => void;
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
