import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  mcpOauthBeginPayloadSchema,
  type McpOauthBeginPayload,
  type McpOauthBeginResult,
  type McpOauthClearPayload,
  type McpOauthStatusResult,
  type McpOauthWaitResult,
  type McpServer,
} from "@/shared/contracts";
import { decryptSecret, encryptSecret } from "@/shared/secretStorage";

const FLOW_TIMEOUT_MS = 5 * 60 * 1000;
const TOKEN_EXPIRY_SLACK_MS = 60 * 1000;
const STORE_FILE_NAME = "mcp-oauth.json";
const CALLBACK_PATH = "/callback";

const CALLBACK_SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Y Space</title></head>
<body style="font-family: system-ui, sans-serif; display: flex; justify-content: center; margin-top: 4rem;">
<p>Sign-in complete. You can close this window and return to Y Space.</p></body></html>`;
const CALLBACK_FAILURE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Y Space</title></head>
<body style="font-family: system-ui, sans-serif; display: flex; justify-content: center; margin-top: 4rem;">
<p>Sign-in failed. You can close this window and retry from Y Space.</p></body></html>`;

/** Sealed-at-rest per-server credential entry. Values are `encryptSecret` strings. */
interface StoredEntry {
  clientInformation?: string;
  tokens?: string;
  /** Epoch ms when `tokens` was saved; used with `expires_in` for expiry. */
  tokensSavedAt?: number;
}

interface StoreFile {
  servers: Record<string, StoredEntry>;
}

interface ActiveFlow {
  id: string;
  serverUrl: string;
  credentialEpoch: number;
  state: string;
  codeVerifier?: string;
  authorizationUrl?: string;
  listener?: Server | undefined;
  port?: number;
  timeout?: NodeJS.Timeout;
  settled: boolean;
  result: Promise<McpOauthWaitResult>;
  settle: (result: McpOauthWaitResult) => void;
}

interface CredentialCapability {
  readonly serverUrl: string;
  readonly epoch: number;
  readonly flow?: ActiveFlow;
}

interface ClearCredentialsOptions {
  readonly strictPersistence?: boolean;
}

function sanitizeMessage(value: unknown, fallback: string): string {
  const raw =
    typeof value === "string" ? value : value instanceof Error ? value.message : undefined;
  if (!raw) return fallback;
  const sanitized = Array.from(raw, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127 ? " " : character;
  })
    .join("")
    .trim()
    .slice(0, 200);
  return sanitized || fallback;
}

function isOauthCapableTransport(server: McpServer): server is McpServer & {
  transport: { type: "http" | "sse"; url: string; headers: Record<string, string> };
} {
  return server.transport.type === "http" || server.transport.type === "sse";
}

function hasAuthorizationHeader(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === "authorization");
}

export interface McpOAuthServiceOptions {
  baseDir: string;
  /** Test seam: overrides where the sealed credential store is written. */
  storePath?: string;
}

/**
 * OAuth 2.1 client for user-configured HTTP/SSE MCP servers: RFC 9728 resource
 * discovery, dynamic client registration, authorization-code + PKCE via a
 * loopback redirect listener, and refresh — all delegated to the MCP SDK's
 * `auth()`. Credentials are sealed with the shared secret-storage key before
 * touching disk and never leave the supervisor process.
 */
export class McpOAuthService {
  private readonly baseDir: string;
  private readonly storePath: string;
  private readonly flows = new Map<string, ActiveFlow>();
  private readonly flowsByServer = new Map<string, ActiveFlow>();
  private readonly credentialEpochs = new Map<string, number>();
  private storeCache: StoreFile | undefined;
  private storeLoadError: unknown;

  constructor(options: McpOAuthServiceOptions) {
    this.baseDir = options.baseDir;
    this.storePath = options.storePath ?? join(options.baseDir, STORE_FILE_NAME);
  }

  async begin(input: McpOauthBeginPayload): Promise<McpOauthBeginResult> {
    const payload = mcpOauthBeginPayloadSchema.parse(input);
    const server = payload.server;
    if (!isOauthCapableTransport(server)) {
      return { status: "error", message: "Only HTTP MCP servers support sign-in." };
    }
    const serverUrl = server.transport.url;
    this.invalidateCredentialOperations(serverUrl);
    this.cancelFlowForServer(serverUrl);

    const flow = this.createFlow(serverUrl);
    try {
      flow.listener = await this.openLoopbackListener(flow);
      if (flow.credentialEpoch !== this.currentCredentialEpoch(serverUrl)) {
        throw new Error("The sign-in flow is no longer active.");
      }
      this.flows.set(flow.id, flow);
      this.flowsByServer.set(serverUrl, flow);
      const capability = this.createCredentialCapability(serverUrl, flow);
      const provider = this.createProvider(capability);
      const result = await auth(provider, { serverUrl });
      if (!this.isCredentialCapabilityCurrent(capability)) {
        throw new Error("The sign-in flow is no longer active.");
      }
      if (result === "AUTHORIZED") {
        this.disposeFlow(flow);
        return { status: "authorized" };
      }
      if (!flow.authorizationUrl) {
        this.disposeFlow(flow);
        return { status: "error", message: "The server did not provide an authorization URL." };
      }
      flow.timeout = setTimeout(() => {
        this.settleFlow(flow, { status: "error", message: "Sign-in timed out." });
      }, FLOW_TIMEOUT_MS);
      flow.timeout.unref?.();
      return { status: "redirect", flowId: flow.id, authorizationUrl: flow.authorizationUrl };
    } catch (error) {
      this.disposeFlow(flow);
      return {
        status: "error",
        message: sanitizeMessage(error, "Could not start the sign-in flow."),
      };
    }
  }

  async wait(payload: { flowId: string }): Promise<McpOauthWaitResult> {
    const flow = this.flows.get(payload.flowId);
    if (!flow) return { status: "error", message: "The sign-in flow is no longer active." };
    return flow.result;
  }

  cancel(payload: { flowId: string }): void {
    const flow = this.flows.get(payload.flowId);
    if (!flow) return;
    this.invalidateCredentialOperations(flow.serverUrl);
    this.settleFlow(flow, { status: "error", message: "The sign-in flow was canceled." });
  }

  clear(payload: McpOauthClearPayload, options: ClearCredentialsOptions = {}): void {
    this.invalidateCredentialOperations(payload.url);
    this.cancelFlowForServer(payload.url);
    const current = this.readStore();
    if (options.strictPersistence && this.storeLoadError) {
      throw new Error("Could not persist the OAuth credential change.", {
        cause: this.storeLoadError,
      });
    }
    if (current.servers[payload.url] === undefined) return;
    const store: StoreFile = { servers: { ...current.servers } };
    delete store.servers[payload.url];
    this.writeStore(store, options);
  }

  status(): McpOauthStatusResult {
    const store = this.readStore();
    return {
      authenticatedUrls: Object.keys(store.servers).filter((url) => this.readTokens(url)),
    };
  }

  /**
   * Injects a fresh `Authorization` header into HTTP/SSE servers that have
   * stored credentials and no user-provided Authorization header. Silent on
   * failure: the server is passed through unchanged and the agent/probe
   * surfaces the resulting 401 as auth-required.
   */
  async applyAuthorization(servers: McpServer[]): Promise<McpServer[]> {
    return Promise.all(servers.map((server) => this.applyAuthorizationToServer(server)));
  }

  async applyAuthorizationToServer(server: McpServer): Promise<McpServer> {
    if (!isOauthCapableTransport(server)) return server;
    if (hasAuthorizationHeader(server.transport.headers)) return server;
    const credential = await this.accessToken(server.transport.url);
    if (!credential || !this.isCredentialCapabilityCurrent(credential.capability)) return server;
    return {
      ...server,
      transport: {
        ...server.transport,
        headers: {
          ...server.transport.headers,
          Authorization: `Bearer ${credential.accessToken}`,
        },
      },
    };
  }

  dispose(): void {
    for (const serverUrl of this.credentialEpochs.keys()) {
      this.invalidateCredentialOperations(serverUrl);
    }
    for (const flow of [...this.flows.values()]) {
      this.settleFlow(flow, { status: "error", message: "The sign-in flow was canceled." });
    }
  }

  private async accessToken(serverUrl: string): Promise<
    | {
        accessToken: string;
        capability: CredentialCapability;
      }
    | undefined
  > {
    const capability = this.createCredentialCapability(serverUrl);
    const tokens = this.readTokensForCapability(capability);
    if (!tokens) return undefined;
    if (!this.tokensExpired(capability, tokens)) {
      return { accessToken: tokens.access_token, capability };
    }
    if (!tokens.refresh_token) return undefined;
    try {
      const provider = this.createProvider(capability);
      const result = await auth(provider, { serverUrl });
      if (result !== "AUTHORIZED" || !this.isCredentialCapabilityCurrent(capability)) {
        return undefined;
      }
      const refreshed = this.readTokensForCapability(capability);
      return refreshed ? { accessToken: refreshed.access_token, capability } : undefined;
    } catch {
      return undefined;
    }
  }

  private tokensExpired(capability: CredentialCapability, tokens: OAuthTokens): boolean {
    this.assertCredentialCapabilityCurrent(capability);
    if (tokens.expires_in === undefined) return false;
    const savedAt = this.readStore().servers[capability.serverUrl]?.tokensSavedAt;
    if (savedAt === undefined) return true;
    return savedAt + tokens.expires_in * 1000 - TOKEN_EXPIRY_SLACK_MS <= Date.now();
  }

  private createFlow(serverUrl: string): ActiveFlow {
    let settle!: (result: McpOauthWaitResult) => void;
    const result = new Promise<McpOauthWaitResult>((resolve) => {
      settle = resolve;
    });
    const flow: ActiveFlow = {
      id: randomUUID(),
      serverUrl,
      credentialEpoch: this.currentCredentialEpoch(serverUrl),
      state: randomBytes(24).toString("base64url"),
      settled: false,
      result,
      settle,
    };
    return flow;
  }

  /**
   * Interactive when `flow` is given (captures the authorization redirect and
   * uses the loopback listener); non-interactive otherwise (refresh only —
   * a required redirect aborts the flow instead of opening a browser).
   */
  private createProvider(capability: CredentialCapability): OAuthClientProvider {
    const service = this;
    const { serverUrl, flow } = capability;
    const redirectUrl = flow?.port
      ? `http://127.0.0.1:${flow.port}${CALLBACK_PATH}`
      : "http://127.0.0.1/unused-callback";
    return {
      get redirectUrl() {
        return redirectUrl;
      },
      get clientMetadata(): OAuthClientMetadata {
        return {
          client_name: "Y Space",
          redirect_uris: [redirectUrl],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        };
      },
      state: () => {
        service.assertCredentialCapabilityCurrent(capability);
        if (!flow) throw new Error("Interactive sign-in is required.");
        return flow.state;
      },
      clientInformation: () => {
        service.assertCredentialCapabilityCurrent(capability);
        return service.readClientInformation(serverUrl);
      },
      saveClientInformation: (clientInformation) => {
        service.assertCredentialCapabilityCurrent(capability);
        service.updateEntry(serverUrl, (entry) => ({
          ...entry,
          clientInformation: encryptSecret(service.baseDir, JSON.stringify(clientInformation)),
        }));
      },
      tokens: () => service.readTokensForCapability(capability),
      saveTokens: (tokens) => {
        service.assertCredentialCapabilityCurrent(capability);
        service.updateEntry(serverUrl, (entry) => ({
          ...entry,
          tokens: encryptSecret(service.baseDir, JSON.stringify(tokens)),
          tokensSavedAt: Date.now(),
        }));
      },
      redirectToAuthorization: (authorizationUrl: URL) => {
        service.assertCredentialCapabilityCurrent(capability);
        if (!flow) throw new Error("Interactive sign-in is required.");
        flow.authorizationUrl = authorizationUrl.toString();
      },
      saveCodeVerifier: (codeVerifier) => {
        service.assertCredentialCapabilityCurrent(capability);
        if (!flow) throw new Error("Interactive sign-in is required.");
        flow.codeVerifier = codeVerifier;
      },
      codeVerifier: () => {
        service.assertCredentialCapabilityCurrent(capability);
        if (!flow?.codeVerifier) throw new Error("Missing PKCE code verifier.");
        return flow.codeVerifier;
      },
      invalidateCredentials: (scope) => {
        service.assertCredentialCapabilityCurrent(capability);
        service.updateEntry(serverUrl, (entry) => {
          if (scope === "all") return {};
          const next = { ...entry };
          if (scope === "client") delete next.clientInformation;
          if (scope === "tokens") {
            delete next.tokens;
            delete next.tokensSavedAt;
          }
          return next;
        });
      },
    };
  }

  private openLoopbackListener(flow: ActiveFlow): Promise<Server> {
    return new Promise((resolve, reject) => {
      const listener = createServer((req, res) => this.handleCallback(flow, req, res));
      listener.on("error", reject);
      listener.listen(0, "127.0.0.1", () => {
        const address = listener.address();
        if (address === null || typeof address === "string") {
          listener.close();
          reject(new Error("Could not open the sign-in callback listener."));
          return;
        }
        flow.port = address.port;
        listener.removeListener("error", reject);
        resolve(listener);
      });
    });
  }

  private handleCallback(flow: ActiveFlow, req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${flow.port}`);
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404).end();
      return;
    }
    // An attacker on another local account cannot know the state value; a
    // mismatched callback is ignored without consuming the pending flow.
    if (url.searchParams.get("state") !== flow.state || flow.settled) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end(CALLBACK_FAILURE_HTML);
      return;
    }

    const oauthError = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    if (oauthError !== null || !code) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(CALLBACK_FAILURE_HTML);
      this.settleFlow(flow, {
        status: "error",
        message: sanitizeMessage(
          url.searchParams.get("error_description") ?? oauthError,
          "Sign-in was denied.",
        ),
      });
      return;
    }

    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(CALLBACK_SUCCESS_HTML);
    void this.exchangeAuthorizationCode(flow, code);
  }

  private async exchangeAuthorizationCode(flow: ActiveFlow, code: string): Promise<void> {
    try {
      const provider = this.createProvider(this.createCredentialCapability(flow.serverUrl, flow));
      const result = await auth(provider, {
        serverUrl: flow.serverUrl,
        authorizationCode: code,
      });
      this.settleFlow(
        flow,
        result === "AUTHORIZED"
          ? { status: "authorized" }
          : { status: "error", message: "The authorization could not be completed." },
      );
    } catch (error) {
      this.settleFlow(flow, {
        status: "error",
        message: sanitizeMessage(error, "The authorization could not be completed."),
      });
    }
  }

  private cancelFlowForServer(serverUrl: string): void {
    const flow = this.flowsByServer.get(serverUrl);
    if (flow) {
      this.settleFlow(flow, { status: "error", message: "The sign-in flow was restarted." });
    }
  }

  private currentCredentialEpoch(serverUrl: string): number {
    return this.credentialEpochs.get(serverUrl) ?? 0;
  }

  private invalidateCredentialOperations(serverUrl: string): void {
    this.credentialEpochs.set(serverUrl, this.currentCredentialEpoch(serverUrl) + 1);
  }

  private createCredentialCapability(serverUrl: string, flow?: ActiveFlow): CredentialCapability {
    const epoch = flow?.credentialEpoch ?? this.currentCredentialEpoch(serverUrl);
    this.credentialEpochs.set(serverUrl, this.currentCredentialEpoch(serverUrl));
    return Object.freeze({ serverUrl, epoch, ...(flow ? { flow } : {}) });
  }

  private isCredentialCapabilityCurrent(capability: CredentialCapability): boolean {
    if (capability.epoch !== this.currentCredentialEpoch(capability.serverUrl)) return false;
    const flow = capability.flow;
    if (!flow) return true;
    return (
      !flow.settled &&
      this.flows.get(flow.id) === flow &&
      this.flowsByServer.get(capability.serverUrl) === flow
    );
  }

  private assertCredentialCapabilityCurrent(capability: CredentialCapability): void {
    if (!this.isCredentialCapabilityCurrent(capability)) {
      throw new Error("The OAuth credential operation is no longer active.");
    }
  }

  private settleFlow(flow: ActiveFlow, result: McpOauthWaitResult): void {
    if (!flow.settled) {
      flow.settled = true;
      flow.settle(result);
    }
    this.disposeFlow(flow);
  }

  private disposeFlow(flow: ActiveFlow): void {
    if (flow.timeout) clearTimeout(flow.timeout);
    flow.listener?.close();
    flow.listener = undefined;
    this.flows.delete(flow.id);
    if (this.flowsByServer.get(flow.serverUrl) === flow) {
      this.flowsByServer.delete(flow.serverUrl);
    }
  }

  private readClientInformation(serverUrl: string): OAuthClientInformationMixed | undefined {
    const sealed = this.readStore().servers[serverUrl]?.clientInformation;
    if (!sealed) return undefined;
    try {
      return JSON.parse(decryptSecret(this.baseDir, sealed)) as OAuthClientInformationMixed;
    } catch {
      return undefined;
    }
  }

  private readTokens(serverUrl: string): OAuthTokens | undefined {
    const sealed = this.readStore().servers[serverUrl]?.tokens;
    if (!sealed) return undefined;
    try {
      return JSON.parse(decryptSecret(this.baseDir, sealed)) as OAuthTokens;
    } catch {
      return undefined;
    }
  }

  private readTokensForCapability(capability: CredentialCapability): OAuthTokens | undefined {
    this.assertCredentialCapabilityCurrent(capability);
    return this.readTokens(capability.serverUrl);
  }

  private updateEntry(serverUrl: string, update: (entry: StoredEntry) => StoredEntry): void {
    const current = this.readStore();
    const store: StoreFile = { servers: { ...current.servers } };
    const next = update({ ...(current.servers[serverUrl] ?? {}) });
    if (Object.keys(next).length === 0) delete store.servers[serverUrl];
    else store.servers[serverUrl] = next;
    this.writeStore(store);
  }

  private readStore(): StoreFile {
    if (this.storeCache) return this.storeCache;
    try {
      const parsed = JSON.parse(readFileSync(this.storePath, "utf8")) as unknown;
      const servers =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? ((parsed as { servers?: unknown }).servers ?? {})
          : {};
      this.storeCache = {
        servers:
          servers && typeof servers === "object" && !Array.isArray(servers)
            ? (servers as Record<string, StoredEntry>)
            : {},
      };
      this.storeLoadError = undefined;
    } catch (error) {
      const missing =
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT";
      this.storeLoadError = missing ? undefined : error;
      this.storeCache = { servers: {} };
    }
    return this.storeCache;
  }

  private writeStore(store: StoreFile, options: ClearCredentialsOptions = {}): void {
    this.storeCache = store;
    const temporaryPath = `${this.storePath}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(this.storePath), { recursive: true });
      writeFileSync(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      renameSync(temporaryPath, this.storePath);
      this.storeLoadError = undefined;
    } catch (cause) {
      try {
        rmSync(temporaryPath, { force: true });
      } catch {
        // Preserve the sanitized persistence error below.
      }
      if (options.strictPersistence) {
        throw new Error("Could not persist the OAuth credential change.", { cause });
      }
      // Persisting is best-effort; in-memory credentials still work for the session.
    }
  }
}
