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
  isPipedreamPersonalMcpUrl,
  mcpOauthBeginPayloadSchema,
  PIPEDREAM_PERSONAL_MCP_URL,
  type McpOauthBeginPayload,
  type McpOauthBeginResult,
  type McpOauthClearPayload,
  type McpOauthStatusResult,
  type McpOauthWaitResult,
  type McpServer,
  type ResolvedMcpServer,
} from "@/shared/contracts";
import { decryptSecret, encryptSecret } from "@/shared/secretStorage";
import {
  PersonalMcpLoopbackRelay,
  type PersonalMcpRelayBindingInfo,
} from "./PersonalMcpLoopbackRelay";

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

export interface ClearCredentialsOptions {
  readonly strictPersistence?: boolean;
}

interface RefreshOperation {
  readonly epoch: number;
  readonly promise: Promise<string | undefined>;
}

interface PersonalRelayBindingRecord {
  readonly bindingId: string;
  readonly threadId: string;
  readonly providerBindingId: string;
  readonly serverId: string;
  readonly credentialUrl: string;
  readonly credentialEpoch: number;
  readonly relayGeneration: number;
  readonly threadBindingEpoch: number;
  readonly info: PersonalMcpRelayBindingInfo;
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

function stripAuthorizationHeader(server: McpServer): McpServer {
  if (!isOauthCapableTransport(server)) return server;
  const headers = Object.fromEntries(
    Object.entries(server.transport.headers).filter(
      ([name]) => name.toLowerCase() !== "authorization",
    ),
  );
  if (Object.keys(headers).length === Object.keys(server.transport.headers).length) return server;
  return { ...server, transport: { ...server.transport, headers } };
}

function personalRelayBindingKey(
  threadId: string,
  providerBindingId: string,
  serverId: string,
  credentialUrl: string,
  upstreamUrl: string,
  advertisedHost: string | undefined,
): string {
  return JSON.stringify([
    threadId,
    providerBindingId,
    serverId,
    credentialUrl,
    upstreamUrl,
    advertisedHost?.trim() || "127.0.0.1",
  ]);
}

function personalRelayProviderScopeKey(threadId: string, providerBindingId: string): string {
  return JSON.stringify([threadId, providerBindingId]);
}

function personalRelayServer(
  server: McpServer | ResolvedMcpServer,
  info: PersonalMcpRelayBindingInfo,
): ResolvedMcpServer {
  return {
    id: server.id,
    name: server.name,
    timeoutMs: server.timeoutMs,
    ...(server.disabledTools ? { disabledTools: [...server.disabledTools] } : {}),
    ...("approvalMode" in server && server.approvalMode
      ? { approvalMode: server.approvalMode }
      : {}),
    transport: { type: "http", url: info.url, headers: { ...info.headers } },
  };
}

export interface McpOAuthServiceOptions {
  baseDir: string;
  /** Test seam: overrides where the sealed credential store is written. */
  storePath?: string;
  /** Test seam for Personal Pipedream's supervisor-owned upstream hop. */
  fetch?: typeof globalThis.fetch;
  /** Test/deployment override. Windows defaults to all interfaces for WSL. */
  personalRelayBindHost?: "127.0.0.1" | "0.0.0.0";
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
  private readonly refreshOperations = new Map<string, RefreshOperation>();
  private readonly personalRelay: PersonalMcpLoopbackRelay;
  private readonly personalRelayBindings = new Map<string, PersonalRelayBindingRecord>();
  private readonly personalThreadBindingEpochs = new Map<string, number>();
  private readonly pendingPersonalRelayResolutions = new Map<string, number>();
  private readonly personalProviderBindingResolutionEpochs = new Map<string, number>();
  private readonly pendingPersonalProviderBindingResolutions = new Map<string, number>();
  private personalRelayGeneration = 0;
  private storeCache: StoreFile | undefined;
  private storeLoadError: unknown;
  private storePersistencePending = false;

  constructor(options: McpOAuthServiceOptions) {
    this.baseDir = options.baseDir;
    this.storePath = options.storePath ?? join(options.baseDir, STORE_FILE_NAME);
    this.personalRelay = new PersonalMcpLoopbackRelay({
      getAccessToken: async (serverUrl) => (await this.accessToken(serverUrl))?.accessToken,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.personalRelayBindHost ? { bindHost: options.personalRelayBindHost } : {}),
    });
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
    if (isPipedreamPersonalMcpUrl(payload.url)) {
      this.clearPersonalCredentials(options);
      return;
    }
    this.invalidateCredentialOperations(payload.url);
    this.cancelFlowForServer(payload.url);
    const current = this.readStore();
    if (options.strictPersistence && this.storeLoadError) {
      throw new Error("Could not persist the OAuth credential change.", {
        cause: this.storeLoadError,
      });
    }
    if (current.servers[payload.url] === undefined) {
      if (this.storePersistencePending) this.writeStore(current, options);
      return;
    }
    const store: StoreFile = { servers: { ...current.servers } };
    delete store.servers[payload.url];
    this.writeStore(store, options);
  }

  /**
   * Privileged Personal sign-out. All equivalent persisted URL keys are one
   * credential identity and are invalidated before one atomic store rewrite.
   */
  clearPersonalCredentials(options: ClearCredentialsOptions = {}): void {
    const current = this.readStore();
    const personalUrls = new Set<string>([PIPEDREAM_PERSONAL_MCP_URL]);
    for (const url of Object.keys(current.servers)) {
      if (isPipedreamPersonalMcpUrl(url)) personalUrls.add(url);
    }
    for (const url of this.flowsByServer.keys()) {
      if (isPipedreamPersonalMcpUrl(url)) personalUrls.add(url);
    }
    // A begin can be blocked opening its loopback listener before it reaches
    // flowsByServer. Credential epochs are installed before that first await,
    // so include them to keep every equivalent Personal identity fail-closed.
    for (const url of this.credentialEpochs.keys()) {
      if (isPipedreamPersonalMcpUrl(url)) personalUrls.add(url);
    }
    // Refreshes currently also own a credential epoch, but retain their exact
    // keys here so a future refresh implementation cannot reopen this gap.
    for (const url of this.refreshOperations.keys()) {
      if (isPipedreamPersonalMcpUrl(url)) personalUrls.add(url);
    }
    for (const url of personalUrls) {
      this.invalidateCredentialOperations(url);
      this.cancelFlowForServer(url);
    }
    this.revokeAllPersonalRelayBindings();
    if (options.strictPersistence && this.storeLoadError) {
      throw new Error("Could not persist the OAuth credential change.", {
        cause: this.storeLoadError,
      });
    }
    const store: StoreFile = { servers: { ...current.servers } };
    let changed = false;
    for (const url of Object.keys(store.servers)) {
      if (!isPipedreamPersonalMcpUrl(url)) continue;
      delete store.servers[url];
      changed = true;
    }
    if (changed || this.storePersistencePending) this.writeStore(store, options);
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
    if (isPipedreamPersonalMcpUrl(server.transport.url)) {
      return stripAuthorizationHeader(server);
    }
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

  async resolvePersonalMcpServersForLaunch(input: {
    readonly servers: readonly (McpServer | ResolvedMcpServer)[];
    readonly threadId: string;
    readonly providerBindingId: string;
    readonly advertisedHost?: string;
  }): Promise<ResolvedMcpServer[]> {
    const providerScopeKey = personalRelayProviderScopeKey(input.threadId, input.providerBindingId);
    this.pendingPersonalRelayResolutions.set(
      input.threadId,
      (this.pendingPersonalRelayResolutions.get(input.threadId) ?? 0) + 1,
    );
    this.pendingPersonalProviderBindingResolutions.set(
      providerScopeKey,
      (this.pendingPersonalProviderBindingResolutions.get(providerScopeKey) ?? 0) + 1,
    );
    const providerBindingResolutionEpoch =
      (this.personalProviderBindingResolutionEpochs.get(providerScopeKey) ?? 0) + 1;
    this.personalProviderBindingResolutionEpochs.set(
      providerScopeKey,
      providerBindingResolutionEpoch,
    );
    const relayGeneration = this.personalRelayGeneration;
    const threadBindingEpoch = this.currentPersonalThreadBindingEpoch(input.threadId);
    const isCurrentResolution = (): boolean =>
      relayGeneration === this.personalRelayGeneration &&
      threadBindingEpoch === this.currentPersonalThreadBindingEpoch(input.threadId) &&
      providerBindingResolutionEpoch ===
        this.personalProviderBindingResolutionEpochs.get(providerScopeKey);
    try {
      const configuredBindingKeys = new Set<string>();
      for (const server of input.servers) {
        const transport = server.transport;
        if (
          (transport.type !== "http" && transport.type !== "sse") ||
          !isPipedreamPersonalMcpUrl(transport.url)
        ) {
          continue;
        }
        const credentialUrl = this.personalCredentialUrlFor(transport.url);
        if (!credentialUrl) continue;
        configuredBindingKeys.add(
          personalRelayBindingKey(
            input.threadId,
            input.providerBindingId,
            server.id,
            credentialUrl,
            transport.url,
            input.advertisedHost,
          ),
        );
      }
      if (!isCurrentResolution()) return [];
      this.releaseObsoletePersonalRelayBindings(
        input.threadId,
        input.providerBindingId,
        configuredBindingKeys,
      );

      const resolved: ResolvedMcpServer[] = [];
      const desiredBindingKeys = new Set<string>();
      for (const server of input.servers) {
        const transport = server.transport;
        if (
          (transport.type !== "http" && transport.type !== "sse") ||
          !isPipedreamPersonalMcpUrl(transport.url)
        ) {
          continue;
        }
        const credentialUrl = this.personalCredentialUrlFor(transport.url);
        if (!credentialUrl) continue;
        const credential = await this.accessToken(credentialUrl);
        if (
          !credential ||
          !isCurrentResolution() ||
          !this.isCredentialCapabilityCurrent(credential.capability)
        ) {
          continue;
        }
        const bindingKey = personalRelayBindingKey(
          input.threadId,
          input.providerBindingId,
          server.id,
          credentialUrl,
          transport.url,
          input.advertisedHost,
        );
        if (desiredBindingKeys.has(bindingKey)) continue;
        desiredBindingKeys.add(bindingKey);
        const existing = this.personalRelayBindings.get(bindingKey);
        if (
          existing?.relayGeneration === relayGeneration &&
          existing.threadBindingEpoch === threadBindingEpoch &&
          existing.credentialEpoch === credential.capability.epoch
        ) {
          resolved.push(personalRelayServer(server, existing.info));
          continue;
        }
        if (existing) {
          this.personalRelay.unregisterBinding(existing.bindingId);
          this.personalRelayBindings.delete(bindingKey);
        }
        const info = await this.personalRelay.registerBinding({
          threadId: input.threadId,
          providerBindingId: input.providerBindingId,
          upstreamUrl: transport.url,
          credentialUrl,
          ...(input.advertisedHost ? { advertisedHost: input.advertisedHost } : {}),
        });
        if (!isCurrentResolution() || !this.isCredentialCapabilityCurrent(credential.capability)) {
          this.personalRelay.unregisterBinding(info.bindingId);
          continue;
        }
        this.personalRelayBindings.set(bindingKey, {
          bindingId: info.bindingId,
          threadId: input.threadId,
          providerBindingId: input.providerBindingId,
          serverId: server.id,
          credentialUrl,
          credentialEpoch: credential.capability.epoch,
          relayGeneration,
          threadBindingEpoch,
          info,
        });
        resolved.push(personalRelayServer(server, info));
      }
      if (!isCurrentResolution()) return [];
      this.releaseObsoletePersonalRelayBindings(
        input.threadId,
        input.providerBindingId,
        desiredBindingKeys,
      );
      return resolved;
    } finally {
      const pending = (this.pendingPersonalRelayResolutions.get(input.threadId) ?? 1) - 1;
      if (pending <= 0) this.pendingPersonalRelayResolutions.delete(input.threadId);
      else this.pendingPersonalRelayResolutions.set(input.threadId, pending);
      const pendingProviderResolutions =
        (this.pendingPersonalProviderBindingResolutions.get(providerScopeKey) ?? 1) - 1;
      if (pendingProviderResolutions <= 0) {
        this.pendingPersonalProviderBindingResolutions.delete(providerScopeKey);
        this.personalProviderBindingResolutionEpochs.delete(providerScopeKey);
      } else {
        this.pendingPersonalProviderBindingResolutions.set(
          providerScopeKey,
          pendingProviderResolutions,
        );
      }
      this.prunePersonalThreadBindingEpoch(input.threadId);
    }
  }

  releasePersonalMcpBindings(threadId: string): void {
    this.personalThreadBindingEpochs.set(
      threadId,
      this.currentPersonalThreadBindingEpoch(threadId) + 1,
    );
    this.personalRelay.unregisterThread(threadId);
    for (const [key, binding] of this.personalRelayBindings) {
      if (binding.threadId === threadId) this.personalRelayBindings.delete(key);
    }
    this.prunePersonalThreadBindingEpoch(threadId);
  }

  releasePersonalMcpProviderBindings(threadId: string, providerBindingId: string): void {
    const providerScopeKey = personalRelayProviderScopeKey(threadId, providerBindingId);
    this.personalProviderBindingResolutionEpochs.set(
      providerScopeKey,
      (this.personalProviderBindingResolutionEpochs.get(providerScopeKey) ?? 0) + 1,
    );
    for (const [key, binding] of this.personalRelayBindings) {
      if (binding.threadId !== threadId || binding.providerBindingId !== providerBindingId)
        continue;
      this.personalRelay.unregisterBinding(binding.bindingId);
      this.personalRelayBindings.delete(key);
    }
    if ((this.pendingPersonalProviderBindingResolutions.get(providerScopeKey) ?? 0) === 0) {
      this.personalProviderBindingResolutionEpochs.delete(providerScopeKey);
    }
    this.prunePersonalThreadBindingEpoch(threadId);
  }

  dispose(): void {
    for (const serverUrl of this.credentialEpochs.keys()) {
      this.invalidateCredentialOperations(serverUrl);
    }
    for (const flow of [...this.flows.values()]) {
      this.settleFlow(flow, { status: "error", message: "The sign-in flow was canceled." });
    }
    this.revokeAllPersonalRelayBindings();
    void this.personalRelay.dispose();
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
    let operation = this.refreshOperations.get(serverUrl);
    if (!operation || operation.epoch !== capability.epoch) {
      let promise!: Promise<string | undefined>;
      promise = this.refreshAccessToken(capability).finally(() => {
        if (this.refreshOperations.get(serverUrl)?.promise === promise) {
          this.refreshOperations.delete(serverUrl);
        }
      });
      operation = { epoch: capability.epoch, promise };
      this.refreshOperations.set(serverUrl, operation);
    }
    const accessToken = await operation.promise;
    if (!accessToken || !this.isCredentialCapabilityCurrent(capability)) return undefined;
    return { accessToken, capability };
  }

  private async refreshAccessToken(capability: CredentialCapability): Promise<string | undefined> {
    try {
      const provider = this.createProvider(capability);
      const result = await auth(provider, { serverUrl: capability.serverUrl });
      if (result !== "AUTHORIZED" || !this.isCredentialCapabilityCurrent(capability)) {
        return undefined;
      }
      return this.readTokensForCapability(capability)?.access_token;
    } catch {
      return undefined;
    }
  }

  private currentPersonalThreadBindingEpoch(threadId: string): number {
    return this.personalThreadBindingEpochs.get(threadId) ?? 0;
  }

  private prunePersonalThreadBindingEpoch(threadId: string): void {
    if ((this.pendingPersonalRelayResolutions.get(threadId) ?? 0) > 0) return;
    for (const binding of this.personalRelayBindings.values()) {
      if (binding.threadId === threadId) return;
    }
    this.personalThreadBindingEpochs.delete(threadId);
  }

  private personalCredentialUrlFor(serverUrl: string): string | undefined {
    if (!isPipedreamPersonalMcpUrl(serverUrl)) return undefined;
    if (this.readTokens(serverUrl)) return serverUrl;
    if (serverUrl !== PIPEDREAM_PERSONAL_MCP_URL && this.readTokens(PIPEDREAM_PERSONAL_MCP_URL)) {
      return PIPEDREAM_PERSONAL_MCP_URL;
    }
    return Object.keys(this.readStore().servers).find(
      (candidate) => isPipedreamPersonalMcpUrl(candidate) && this.readTokens(candidate),
    );
  }

  private releaseObsoletePersonalRelayBindings(
    threadId: string,
    providerBindingId: string,
    desiredBindingKeys: ReadonlySet<string>,
  ): void {
    for (const [key, binding] of this.personalRelayBindings) {
      if (
        binding.threadId !== threadId ||
        binding.providerBindingId !== providerBindingId ||
        desiredBindingKeys.has(key)
      ) {
        continue;
      }
      this.personalRelay.unregisterBinding(binding.bindingId);
      this.personalRelayBindings.delete(key);
    }
  }

  private revokeAllPersonalRelayBindings(): void {
    this.personalRelayGeneration += 1;
    this.personalRelayBindings.clear();
    this.personalThreadBindingEpochs.clear();
    this.personalProviderBindingResolutionEpochs.clear();
    this.personalRelay.revokeAllBindings();
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
      this.storePersistencePending = false;
    } catch (error) {
      const missing =
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT";
      this.storeLoadError = missing ? undefined : error;
      this.storeCache = { servers: {} };
      this.storePersistencePending = false;
    }
    return this.storeCache;
  }

  private writeStore(store: StoreFile, options: ClearCredentialsOptions = {}): void {
    this.storeCache = store;
    this.storePersistencePending = true;
    const temporaryPath = `${this.storePath}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(this.storePath), { recursive: true });
      writeFileSync(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      renameSync(temporaryPath, this.storePath);
      this.storeLoadError = undefined;
      this.storePersistencePending = false;
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
