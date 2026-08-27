import { join } from "node:path";
import type {
  PipedreamBeginConnectPayload,
  PipedreamDisconnectAccountPayload,
  PipedreamListAppsPayload,
  PipedreamListAppsResult,
  PipedreamSetAccountAgentAccessPayload,
  PipedreamSnapshot,
  ProjectLocation,
  ResolvedMcpServer,
} from "@/shared/contracts";
import {
  pipedreamBeginConnectPayloadSchema,
  pipedreamDisconnectAccountPayloadSchema,
  pipedreamListAppsPayloadSchema,
  pipedreamSetAccountAgentAccessPayloadSchema,
  pipedreamSnapshotSchema,
} from "@/shared/contracts";
import type {
  PipedreamPrivilegedBootstrapPayload,
  PipedreamPrivilegedConnectLinkResult,
} from "@/shared/pipedreamPrivilegedIpc";
import type { WslHostAccessResolver } from "@/supervisor/wsl/hostAccess";
import { PipedreamApiClient, type PipedreamRemoteAccountSummary } from "./PipedreamApiClient";
import { PipedreamConnectionStore } from "./PipedreamConnectionStore";
import {
  PipedreamLoopbackRelay,
  type PipedreamLoopbackRelayOptions,
  type PipedreamRelayBindingInfo,
  type RegisterPipedreamRelayBindingInput,
} from "./PipedreamLoopbackRelay";
import { PipedreamTokenBroker } from "./PipedreamTokenBroker";

export const PIPEDREAM_PERSONAL_MCP_URL = "https://mcp.pipedream.net/v2";

export interface PipedreamSupervisorServiceOptions {
  readonly baseDir: string;
  readonly readPersonalMcpStatus: () => {
    readonly enabled: boolean;
    readonly authenticated: boolean;
  };
  readonly fetch?: typeof globalThis.fetch;
  readonly wslHostAccess?: WslHostAccessResolver;
  readonly createRelay?: (options: PipedreamLoopbackRelayOptions) => PipedreamRelay;
}

export interface PipedreamRelay {
  registerBinding(input: RegisterPipedreamRelayBindingInput): Promise<PipedreamRelayBindingInfo>;
  unregisterBinding(bindingId: string): void;
  dispose(): Promise<void>;
}

interface ReadyRuntime {
  readonly projectId: string;
  readonly environment: "development" | "production";
  readonly api: PipedreamApiClient;
  readonly relay: PipedreamRelay;
}

interface SharedRelayBinding {
  readonly key: string;
  readonly bindingId: string;
  readonly providerBindingId: string;
  readonly upstreamAccountId: string;
  readonly localAccountId: string;
  readonly appSlug: string;
  readonly info: PipedreamRelayBindingInfo;
  readonly memberThreadIds: Set<string>;
}

interface RelayReachability {
  readonly key: string;
  readonly advertisedHost?: string;
}

interface PendingRelayBinding {
  readonly authorizationRevision: number;
  readonly promise: Promise<SharedRelayBinding | undefined>;
}

/** Owns Pipedream's secret-bearing server-side clients and projects only safe data outward. */
export class PipedreamSupervisorService {
  readonly #options: PipedreamSupervisorServiceOptions;
  readonly #store: PipedreamConnectionStore;
  readonly #sharedBindings = new Map<string, SharedRelayBinding>();
  readonly #pendingBindings = new Map<string, PendingRelayBinding>();
  readonly #bindingKeysByThread = new Map<string, Set<string>>();
  readonly #accountIdByBindingKey = new Map<string, string>();
  #bootstrap: PipedreamPrivilegedBootstrapPayload["bootstrap"] = { state: "absent" };
  #ready: ReadyRuntime | undefined;
  #accountsReconciled = false;
  #accountsRefresh: Promise<void> | undefined;
  #projectName = "Pipedream Connect";
  #errorCode: "authentication-failed" | "configuration-invalid" | "request-failed" | undefined;
  #authorizationRevision = 0;

  constructor(options: PipedreamSupervisorServiceOptions) {
    this.#options = options;
    this.#store = new PipedreamConnectionStore({
      filePath: join(options.baseDir, "pipedream-connections.json"),
    });
  }

  configure(payload: PipedreamPrivilegedBootstrapPayload): void {
    this.#authorizationRevision += 1;
    const previousRelay = this.#ready?.relay;
    this.#ready = undefined;
    this.#sharedBindings.clear();
    this.#pendingBindings.clear();
    this.#bindingKeysByThread.clear();
    this.#accountIdByBindingKey.clear();
    this.#accountsReconciled = false;
    this.#accountsRefresh = undefined;
    this.#projectName = "Pipedream Connect";
    if (previousRelay) void previousRelay.dispose();
    this.#bootstrap = payload.bootstrap;
    this.#errorCode = undefined;
    if (payload.bootstrap.state !== "ready") return;

    try {
      const { credentials } = payload.bootstrap;
      const broker = new PipedreamTokenBroker({
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
      });
      const api = new PipedreamApiClient({
        projectId: credentials.projectId,
        environment: credentials.environment,
        externalUserId: payload.externalUserId,
        getAccessToken: () => broker.getAccessToken(),
        invalidateAccessToken: () => broker.invalidate(),
        ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
      });
      const relayOptions: PipedreamLoopbackRelayOptions = {
        projectId: credentials.projectId,
        environment: credentials.environment,
        externalUserId: payload.externalUserId,
        getAccessToken: () => broker.getAccessToken(),
        invalidateAccessToken: () => broker.invalidate(),
        ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
      };
      const relay =
        this.#options.createRelay?.(relayOptions) ?? new PipedreamLoopbackRelay(relayOptions);
      this.#store.configureScope(
        [credentials.projectId, credentials.environment, payload.externalUserId.trim()].join(
          "\u0000",
        ),
      );
      this.#ready = {
        projectId: credentials.projectId,
        environment: credentials.environment,
        api,
        relay,
      };
    } catch {
      this.#errorCode = "configuration-invalid";
    }
  }

  getSnapshot(): PipedreamSnapshot {
    const personal = this.#options.readPersonalMcpStatus();
    const personalMcp = {
      enabled: personal.enabled,
      authenticated: personal.authenticated,
      serverName: "pd" as const,
    };
    if (this.#errorCode) {
      return pipedreamSnapshotSchema.parse({
        personalMcp,
        connect: { state: "error", code: this.#errorCode },
      });
    }
    if (this.#bootstrap.state === "absent") {
      return pipedreamSnapshotSchema.parse({ personalMcp, connect: { state: "absent" } });
    }
    if (this.#bootstrap.state === "partial") {
      return pipedreamSnapshotSchema.parse({
        personalMcp,
        connect: { state: "partial", missingKeys: [...this.#bootstrap.missingKeys] },
      });
    }
    if (!this.#ready) {
      return pipedreamSnapshotSchema.parse({
        personalMcp,
        connect: { state: "error", code: "configuration-invalid" },
      });
    }
    return pipedreamSnapshotSchema.parse({
      personalMcp,
      connect: {
        state: "ready",
        credentialSource: this.#bootstrap.source,
        environment: this.#ready.environment,
        projectIdHint: projectIdHint(this.#ready.projectId),
        projectName: this.#projectName,
        accounts: this.#store.list(),
      },
    });
  }

  async listApps(payload: PipedreamListAppsPayload): Promise<PipedreamListAppsResult> {
    const input = pipedreamListAppsPayloadSchema.parse(payload);
    const result = await this.#withReadyRequest((ready) =>
      ready.api.listApps({
        ...(input.query !== undefined ? { query: input.query } : {}),
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      }),
    );
    return {
      apps: [...result.apps],
      totalCount: result.totalCount,
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    };
  }

  async refreshAccounts(): Promise<PipedreamSnapshot> {
    await this.#refreshAllAccounts();
    return this.getSnapshot();
  }

  async createConnectLink(
    payload: PipedreamBeginConnectPayload,
  ): Promise<PipedreamPrivilegedConnectLinkResult> {
    const { appSlug } = pipedreamBeginConnectPayloadSchema.parse(payload);
    const result = await this.#withReadyRequest((ready) => ready.api.createConnectToken());
    const connectLink = new URL(result.connectLinkUrl);
    connectLink.searchParams.set("app", appSlug);
    return { connectLinkUrl: connectLink.toString(), expiresAt: result.expiresAt };
  }

  async disconnectAccount(payload: PipedreamDisconnectAccountPayload): Promise<PipedreamSnapshot> {
    const { accountId } = pipedreamDisconnectAccountPayloadSchema.parse(payload);
    this.#requireReady();
    // Local authorization is the security boundary. Revoke it before the
    // upstream request so a slow or failed disconnect can never leave an
    // already-running agent route usable.
    this.#authorizationRevision += 1;
    this.#store.remove(accountId);
    this.#releaseBindingsUsingAccount(accountId);
    await this.#withReadyRequest((ready) => ready.api.disconnectAccount(accountId));
    return this.getSnapshot();
  }

  setAccountAgentAccess(payload: PipedreamSetAccountAgentAccessPayload): PipedreamSnapshot {
    const { accountId, enabled } = pipedreamSetAccountAgentAccessPayloadSchema.parse(payload);
    this.#requireReady();
    this.#authorizationRevision += 1;
    this.#store.setAgentAccess(accountId, enabled);
    if (!enabled) this.#releaseBindingsUsingAccount(accountId);
    return this.getSnapshot();
  }

  async resolveMcpServersForLaunch(input: {
    readonly threadId: string;
    readonly providerBindingId?: string;
    readonly projectLocation: ProjectLocation;
  }): Promise<ResolvedMcpServer[]> {
    const ready = this.#ready;
    if (!ready) return [];
    if (!this.#accountsReconciled) {
      try {
        await this.#refreshAllAccounts();
      } catch {
        this.releaseMcpBindings(input.threadId);
        return [];
      }
    }

    const reachability = await this.#resolveReachability(input.projectLocation);
    if (!reachability) {
      this.releaseMcpBindings(input.threadId);
      return [];
    }

    const accounts = this.#store.listGrantedForRelay();
    const authorizationRevision = this.#authorizationRevision;
    const providerBindingId = input.providerBindingId?.trim() || `thread:${input.threadId}`;
    const desiredKeys = new Set(
      accounts.map(({ localAccountId }) =>
        sharedBindingKey(providerBindingId, localAccountId, reachability.key),
      ),
    );
    this.#releaseObsoleteThreadBindings(input.threadId, desiredKeys);
    if (desiredKeys.size > 0) {
      const threadKeys = this.#bindingKeysByThread.get(input.threadId) ?? new Set<string>();
      for (const key of desiredKeys) threadKeys.add(key);
      this.#bindingKeysByThread.set(input.threadId, threadKeys);
      for (const { account, localAccountId } of accounts) {
        this.#accountIdByBindingKey.set(
          sharedBindingKey(providerBindingId, localAccountId, reachability.key),
          account.id,
        );
      }
    }
    if (accounts.length === 0) return [];

    const resolved = await Promise.all(
      accounts.map(async ({ account, localAccountId }): Promise<ResolvedMcpServer | undefined> => {
        const key = sharedBindingKey(providerBindingId, localAccountId, reachability.key);
        const shared = await this.#getOrCreateSharedBinding({
          ready,
          key,
          threadId: input.threadId,
          providerBindingId,
          upstreamAccountId: account.id,
          localAccountId,
          appSlug: account.app.slug,
          authorizationRevision,
          ...(reachability.advertisedHost ? { advertisedHost: reachability.advertisedHost } : {}),
        });
        if (
          !shared ||
          this.#authorizationRevision !== authorizationRevision ||
          this.#sharedBindings.get(key) !== shared ||
          !this.#bindingKeysByThread.get(input.threadId)?.has(key) ||
          !this.#isGrantCurrent(account.id, localAccountId, account.app.slug)
        ) {
          return undefined;
        }
        shared.memberThreadIds.add(input.threadId);
        return {
          id: `pipedream:${localAccountId}`,
          name: `pipedream-${account.app.slug}-${opaqueNameSuffix(localAccountId)}`,
          timeoutMs: 30_000,
          transport: { type: "http", url: shared.info.url, headers: { ...shared.info.headers } },
        };
      }),
    );
    return resolved.filter((server): server is ResolvedMcpServer => server !== undefined);
  }

  releaseMcpBindings(threadId: string): void {
    const keys = this.#bindingKeysByThread.get(threadId);
    if (!keys) return;
    for (const key of [...keys]) this.#releaseThreadBinding(threadId, key);
  }

  async dispose(): Promise<void> {
    this.#bindingKeysByThread.clear();
    this.#sharedBindings.clear();
    this.#pendingBindings.clear();
    this.#accountIdByBindingKey.clear();
    this.#accountsRefresh = undefined;
    this.#authorizationRevision += 1;
    const relay = this.#ready?.relay;
    this.#ready = undefined;
    await relay?.dispose();
  }

  async #refreshAllAccounts(): Promise<void> {
    if (this.#accountsRefresh) return this.#accountsRefresh;
    const readyAtStart = this.#ready;
    let refresh!: Promise<void>;
    refresh = this.#loadAllAccounts(readyAtStart).finally(() => {
      if (this.#accountsRefresh === refresh) this.#accountsRefresh = undefined;
    });
    this.#accountsRefresh = refresh;
    return refresh;
  }

  async #loadAllAccounts(readyAtStart: ReadyRuntime | undefined): Promise<void> {
    const accounts = await this.#withReadyRequest(async (ready) => {
      const byId = new Map<string, PipedreamRemoteAccountSummary>();
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      while (byId.size < 1_000) {
        const page = await ready.api.listAccounts({
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        for (const account of page.accounts) {
          if (byId.size >= 1_000 && !byId.has(account.id)) break;
          byId.set(account.id, account);
        }
        const next = page.nextCursor;
        if (!next || byId.size >= 1_000) break;
        if (seenCursors.has(next)) throw new Error("Pipedream pagination did not advance.");
        seenCursors.add(next);
        cursor = next;
      }
      return [...byId.values()];
    });
    if (!readyAtStart || this.#ready !== readyAtStart) {
      throw new Error("Pipedream configuration changed while refreshing accounts.");
    }
    this.#store.replaceRemoteAccounts(accounts);
    this.#authorizationRevision += 1;
    this.#revokeBindingsNoLongerGranted();
    this.#accountsReconciled = true;
    const project = await readyAtStart.api.getProject().catch(() => undefined);
    if (project && this.#ready === readyAtStart) this.#projectName = project.name;
  }

  async #resolveReachability(
    projectLocation: ProjectLocation,
  ): Promise<RelayReachability | undefined> {
    if (projectLocation.kind !== "wsl") return { key: "loopback" };
    const access = await this.#options.wslHostAccess?.resolveHostAccess(projectLocation.distro);
    if (!access) return undefined;
    if (access.kind === "loopback") return { key: "loopback" };
    return { key: `gateway:${access.ip}`, advertisedHost: access.ip };
  }

  #releaseObsoleteThreadBindings(threadId: string, desiredKeys: ReadonlySet<string>): void {
    const current = this.#bindingKeysByThread.get(threadId);
    if (!current) return;
    for (const key of [...current]) {
      if (!desiredKeys.has(key)) this.#releaseThreadBinding(threadId, key);
    }
  }

  async #getOrCreateSharedBinding(input: {
    ready: ReadyRuntime;
    key: string;
    threadId: string;
    providerBindingId: string;
    upstreamAccountId: string;
    localAccountId: string;
    appSlug: string;
    authorizationRevision: number;
    advertisedHost?: string;
  }): Promise<SharedRelayBinding | undefined> {
    const existing = this.#sharedBindings.get(input.key);
    if (existing) return existing;
    const pending = this.#pendingBindings.get(input.key);
    if (pending?.authorizationRevision === input.authorizationRevision) return pending.promise;

    let creation!: Promise<SharedRelayBinding | undefined>;
    creation = input.ready.relay
      .registerBinding({
        threadId: input.threadId,
        providerBindingId: input.providerBindingId,
        appSlug: input.appSlug,
        accountId: input.upstreamAccountId,
        ...(input.advertisedHost ? { advertisedHost: input.advertisedHost } : {}),
      })
      .then((info) => {
        if (
          this.#ready !== input.ready ||
          this.#authorizationRevision !== input.authorizationRevision ||
          !this.#isGrantCurrent(input.upstreamAccountId, input.localAccountId, input.appSlug) ||
          !this.#isBindingDesired(input.key)
        ) {
          input.ready.relay.unregisterBinding(info.bindingId);
          return undefined;
        }
        const raced = this.#sharedBindings.get(input.key);
        if (raced) {
          input.ready.relay.unregisterBinding(info.bindingId);
          return raced;
        }
        const shared: SharedRelayBinding = {
          key: input.key,
          bindingId: info.bindingId,
          providerBindingId: input.providerBindingId,
          upstreamAccountId: input.upstreamAccountId,
          localAccountId: input.localAccountId,
          appSlug: input.appSlug,
          info,
          memberThreadIds: new Set(),
        };
        this.#sharedBindings.set(input.key, shared);
        return shared;
      })
      .finally(() => {
        if (this.#pendingBindings.get(input.key)?.promise === creation) {
          this.#pendingBindings.delete(input.key);
        }
        this.#cleanupBindingKeyMetadata(input.key);
      });
    this.#pendingBindings.set(input.key, {
      authorizationRevision: input.authorizationRevision,
      promise: creation,
    });
    return creation;
  }

  #releaseThreadBinding(threadId: string, key: string): void {
    const threadKeys = this.#bindingKeysByThread.get(threadId);
    threadKeys?.delete(key);
    if (threadKeys?.size === 0) this.#bindingKeysByThread.delete(threadId);

    const shared = this.#sharedBindings.get(key);
    if (!shared) {
      this.#cleanupBindingKeyMetadata(key);
      return;
    }
    shared.memberThreadIds.delete(threadId);
    if (shared.memberThreadIds.size > 0) return;
    this.#ready?.relay.unregisterBinding(shared.bindingId);
    this.#sharedBindings.delete(key);
    this.#cleanupBindingKeyMetadata(key);
  }

  #revokeSharedBinding(binding: SharedRelayBinding): void {
    this.#ready?.relay.unregisterBinding(binding.bindingId);
    this.#sharedBindings.delete(binding.key);
    for (const threadId of binding.memberThreadIds) {
      const keys = this.#bindingKeysByThread.get(threadId);
      keys?.delete(binding.key);
      if (keys?.size === 0) this.#bindingKeysByThread.delete(threadId);
    }
    this.#cleanupBindingKeyMetadata(binding.key);
  }

  async #withReadyRequest<T>(run: (ready: ReadyRuntime) => Promise<T>): Promise<T> {
    const ready = this.#requireReady();
    try {
      const result = await run(ready);
      this.#errorCode = undefined;
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      this.#errorCode = /authentication/i.test(message)
        ? "authentication-failed"
        : "request-failed";
      // Deliberately do not preserve the upstream error as `cause`: it may
      // contain provider response details that must not cross public IPC.
      // oxlint-disable-next-line eslint/preserve-caught-error
      throw new Error("Pipedream request failed.");
    }
  }

  #requireReady(): ReadyRuntime {
    if (!this.#ready) throw new Error("Pipedream Connect is not configured.");
    return this.#ready;
  }

  #releaseBindingsUsingAccount(accountId: string): void {
    const keys = [...this.#accountIdByBindingKey.entries()]
      .filter(([, candidateAccountId]) => candidateAccountId === accountId)
      .map(([key]) => key);
    for (const key of keys) this.#removeBindingKeyFromAllThreads(key);
    const matching = [...this.#sharedBindings.values()].filter(
      (binding) => binding.upstreamAccountId === accountId,
    );
    for (const binding of matching) this.#revokeSharedBinding(binding);
  }

  #revokeBindingsNoLongerGranted(): void {
    const grantedAccountIds = new Set(
      this.#store.listGrantedForRelay().map(({ account }) => account.id),
    );
    for (const binding of [...this.#sharedBindings.values()]) {
      if (!grantedAccountIds.has(binding.upstreamAccountId)) this.#revokeSharedBinding(binding);
    }
    for (const [key, accountId] of this.#accountIdByBindingKey) {
      if (!grantedAccountIds.has(accountId)) this.#removeBindingKeyFromAllThreads(key);
    }
  }

  #isGrantCurrent(accountId: string, localAccountId: string, appSlug: string): boolean {
    return this.#store
      .listGrantedForRelay()
      .some(
        (candidate) =>
          candidate.account.id === accountId &&
          candidate.localAccountId === localAccountId &&
          candidate.account.app.slug === appSlug,
      );
  }

  #isBindingDesired(key: string): boolean {
    for (const keys of this.#bindingKeysByThread.values()) {
      if (keys.has(key)) return true;
    }
    return false;
  }

  #removeBindingKeyFromAllThreads(key: string): void {
    for (const [threadId, keys] of this.#bindingKeysByThread) {
      if (!keys.delete(key)) continue;
      if (keys.size === 0) this.#bindingKeysByThread.delete(threadId);
    }
    const shared = this.#sharedBindings.get(key);
    if (shared) this.#revokeSharedBinding(shared);
    this.#cleanupBindingKeyMetadata(key);
  }

  #cleanupBindingKeyMetadata(key: string): void {
    if (
      !this.#sharedBindings.has(key) &&
      !this.#pendingBindings.has(key) &&
      !this.#isBindingDesired(key)
    ) {
      this.#accountIdByBindingKey.delete(key);
    }
  }
}

function projectIdHint(projectId: string): string {
  const suffix = projectId.slice(-4);
  return `proj_…${suffix}`;
}

function sharedBindingKey(
  providerBindingId: string,
  localAccountId: string,
  reachabilityKey: string,
): string {
  return JSON.stringify([providerBindingId, localAccountId, reachabilityKey]);
}

function opaqueNameSuffix(localAccountId: string): string {
  return localAccountId.replaceAll("-", "").slice(0, 12).toLowerCase();
}
