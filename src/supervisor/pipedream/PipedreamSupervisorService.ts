import { join } from "node:path";
import type {
  PipedreamAccountSummary,
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
import {
  PipedreamApiClient,
  type PipedreamConnectRedirects,
  type PipedreamRemoteAccountSummary,
} from "./PipedreamApiClient";
import {
  PipedreamConnectionStore,
  type PipedreamConnectionStoreOptions,
  type PipedreamGrantedRelayAccount,
} from "./PipedreamConnectionStore";
import {
  PipedreamLoopbackRelay,
  type PipedreamLoopbackRelayOptions,
  type PipedreamRelayBindingInfo,
  type RegisterPipedreamRelayBindingInput,
} from "./PipedreamLoopbackRelay";
import { PipedreamTokenBroker } from "./PipedreamTokenBroker";

export interface PipedreamSupervisorServiceOptions {
  readonly baseDir: string;
  readonly readPersonalMcpStatus: () => {
    readonly enabled: boolean;
    readonly authenticated: boolean;
  };
  readonly fetch?: typeof globalThis.fetch;
  readonly wslHostAccess?: WslHostAccessResolver;
  readonly createRelay?: (options: PipedreamLoopbackRelayOptions) => PipedreamRelay;
  readonly writeConnectionsFile?: PipedreamConnectionStoreOptions["writeFile"];
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

interface ProviderResolutionCapability {
  readonly threadId: string;
  readonly providerBindingId: string;
  readonly scopeKey: string;
  readonly threadEpoch: number;
  readonly providerEpoch: number;
  readonly serviceGeneration: number;
  readonly ready: ReadyRuntime;
}

/** Owns Pipedream's secret-bearing server-side clients and projects only safe data outward. */
export class PipedreamSupervisorService {
  readonly #options: PipedreamSupervisorServiceOptions;
  readonly #store: PipedreamConnectionStore;
  readonly #sharedBindings = new Map<string, SharedRelayBinding>();
  readonly #pendingBindings = new Map<string, PendingRelayBinding>();
  readonly #bindingKeysByThread = new Map<string, Set<string>>();
  readonly #accountIdByBindingKey = new Map<string, string>();
  readonly #threadResolutionEpochs = new Map<string, number>();
  readonly #providerBindingEpochs = new Map<string, number>();
  readonly #pendingThreadResolutions = new Map<string, number>();
  readonly #pendingProviderResolutions = new Map<string, number>();
  readonly #relayDisposals = new Set<Promise<void>>();
  readonly #revokedAccounts = new Map<string, PipedreamAccountSummary>();
  readonly #nonDurableRevocationAccountIds = new Set<string>();
  readonly #pendingDisconnectAccountIds = new Set<string>();
  #bootstrap: PipedreamPrivilegedBootstrapPayload["bootstrap"] = { state: "absent" };
  #ready: ReadyRuntime | undefined;
  #accountsRefresh: Promise<void> | undefined;
  #projectName = "Pipedream Connect";
  #configurationError: "configuration-invalid" | undefined;
  #authorizationRevision = 0;
  #accountMutationRevision = 0;
  #serviceGeneration = 0;

  constructor(options: PipedreamSupervisorServiceOptions) {
    this.#options = options;
    this.#store = new PipedreamConnectionStore({
      filePath: join(options.baseDir, "pipedream-connections.json"),
      ...(options.writeConnectionsFile ? { writeFile: options.writeConnectionsFile } : {}),
    });
  }

  configure(payload: PipedreamPrivilegedBootstrapPayload): void {
    this.#serviceGeneration += 1;
    this.#authorizationRevision += 1;
    this.#accountMutationRevision += 1;
    const previousRelay = this.#ready?.relay;
    this.#ready = undefined;
    this.#sharedBindings.clear();
    this.#pendingBindings.clear();
    this.#bindingKeysByThread.clear();
    this.#accountIdByBindingKey.clear();
    this.#threadResolutionEpochs.clear();
    this.#providerBindingEpochs.clear();
    this.#pendingThreadResolutions.clear();
    this.#pendingProviderResolutions.clear();
    this.#revokedAccounts.clear();
    this.#nonDurableRevocationAccountIds.clear();
    this.#pendingDisconnectAccountIds.clear();
    this.#accountsRefresh = undefined;
    this.#projectName = "Pipedream Connect";
    if (previousRelay) void this.#trackRelayDisposal(previousRelay);
    this.#bootstrap = payload.bootstrap;
    this.#configurationError = undefined;
    if (payload.bootstrap.state !== "ready") return;

    let nextRelay: PipedreamRelay | undefined;
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
      nextRelay =
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
        relay: nextRelay,
      };
    } catch {
      if (nextRelay) void this.#trackRelayDisposal(nextRelay);
      this.#configurationError = "configuration-invalid";
    }
  }

  getSnapshot(): PipedreamSnapshot {
    const personal = this.#options.readPersonalMcpStatus();
    const personalMcp = {
      enabled: personal.enabled,
      authenticated: personal.authenticated,
      serverName: "pd" as const,
    };
    if (this.#configurationError) {
      return pipedreamSnapshotSchema.parse({
        personalMcp,
        connect: { state: "error", code: this.#configurationError },
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
        accounts: this.#accountsForSnapshot(),
      },
    });
  }

  /**
   * Supervisor-internal revision of the effective agent grant set. IPC reload
   * orchestration uses this to distinguish a quarantined disconnect failure
   * from validation errors that never touched live authorization.
   */
  getAgentAuthorizationRevision(): number {
    return this.#authorizationRevision;
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
    redirects: PipedreamConnectRedirects,
  ): Promise<PipedreamPrivilegedConnectLinkResult> {
    const { appSlug } = pipedreamBeginConnectPayloadSchema.parse(payload);
    const result = await this.#withReadyRequest((ready) => ready.api.createConnectToken(redirects));
    const connectLink = new URL(result.connectLinkUrl);
    connectLink.searchParams.set("app", appSlug);
    return { connectLinkUrl: connectLink.toString(), expiresAt: result.expiresAt };
  }

  async disconnectAccount(payload: PipedreamDisconnectAccountPayload): Promise<PipedreamSnapshot> {
    const { accountId } = pipedreamDisconnectAccountPayloadSchema.parse(payload);
    this.#requireReady();
    if (this.#pendingDisconnectAccountIds.has(accountId)) {
      throw new Error("Pipedream account disconnect is already in progress.");
    }
    const persistedAccount = this.#store.getScopedAccount(accountId);
    const account = persistedAccount ?? this.#revokedAccounts.get(accountId);
    if (!account) {
      throw new Error("Pipedream account is not connected.");
    }
    // Local authorization is the security boundary. Revoke it before the
    // upstream request so a slow or failed disconnect can never leave an
    // already-running agent route usable.
    this.#authorizationRevision += 1;
    this.#accountMutationRevision += 1;
    this.#pendingDisconnectAccountIds.add(accountId);
    this.#revokedAccounts.set(accountId, { ...account, agentAccess: false });
    this.#releaseBindingsUsingAccount(accountId);
    try {
      if (persistedAccount) {
        // Phase one is a durable deny. If a later cleanup write, remote request,
        // process exit, or restart interrupts the disconnect, this row remains
        // access-off and cannot silently become an agent grant again.
        this.#store.beginDisconnect(accountId);
      }
      // A retained in-memory revoked row with no persisted counterpart can only
      // follow a successful durable removal. That absence is already the
      // strongest durable deny, so a retry must continue to the upstream DELETE
      // instead of trying to tombstone a row that no longer exists.
      this.#nonDurableRevocationAccountIds.delete(accountId);
    } catch {
      // The in-process quarantine still blocks every relay, but the persisted
      // grant remains on. Keep that distinction visible so the UI never claims
      // a restart-safe revocation that did not reach disk.
      this.#nonDurableRevocationAccountIds.add(accountId);
      this.#finishPendingDisconnect(accountId, false);
      throw new Error("Pipedream request failed.");
    }
    try {
      this.#store.remove(accountId);
    } catch {
      // The durable access-off tombstone remains. Keep the account quarantined
      // and do not issue the upstream DELETE until local cleanup can advance.
      this.#finishPendingDisconnect(accountId, false);
      throw new Error("Pipedream request failed.");
    }

    let deleteError: unknown;
    try {
      await this.#withReadyRequest((ready) => ready.api.disconnectAccount(accountId));
    } catch (error) {
      deleteError = error;
    }

    if (deleteError === undefined) {
      // A refresh can legitimately observe the upstream row while DELETE is
      // still pending and restore it locally with access forced off. Invalidate
      // every older refresh before removing that stale projection a final time.
      this.#accountMutationRevision += 1;
      try {
        this.#store.remove(accountId);
      } catch {
        this.#finishPendingDisconnect(accountId, false);
        throw new Error("Pipedream request failed.");
      }
      this.#finishPendingDisconnect(accountId, true);
      return this.getSnapshot();
    }

    const disconnectError =
      deleteError instanceof Error ? deleteError : new Error("Pipedream request failed.");
    if (!this.#pendingDisconnectAccountIds.has(accountId)) throw disconnectError;
    try {
      // DELETE failed or its result was ambiguous. Reconcile before returning
      // the failure so the renderer can immediately show the still-remote
      // account as retryable without ever restoring its agent authorization.
      try {
        await this.#refreshAllAccounts();
        // A failed response can be ambiguous after Pipedream already applied
        // the DELETE. If a follow-up read proves the account is gone, report
        // the verified end state as success instead of showing a false retry.
        if (!this.#store.hasScopedAccount(accountId)) {
          this.#finishPendingDisconnect(accountId, true);
          return this.getSnapshot();
        }
      } catch {
        // If the follow-up read is also unavailable, preserve a renderer-safe
        // retry row locally. Its provider alias rotates and access remains off.
        try {
          this.#store.restoreRevokedAccount(account);
        } catch {
          // Keep the in-memory quarantine and safe retry projection. The
          // original sanitized disconnect failure remains the public result.
        }
      }
      const keepQuarantined = !this.#store.hasScopedAccount(accountId);
      this.#finishPendingDisconnect(accountId, !keepQuarantined);
      throw disconnectError;
    } catch (error) {
      if (this.#pendingDisconnectAccountIds.has(accountId)) {
        this.#finishPendingDisconnect(accountId, false);
      }
      throw error instanceof Error ? error : new Error("Pipedream request failed.");
    }
  }

  setAccountAgentAccess(payload: PipedreamSetAccountAgentAccessPayload): PipedreamSnapshot {
    const { accountId, enabled } = pipedreamSetAccountAgentAccessPayloadSchema.parse(payload);
    this.#requireReady();
    if (this.#pendingDisconnectAccountIds.has(accountId)) {
      if (enabled) throw new Error("Pipedream account disconnect is in progress.");
      return this.getSnapshot();
    }
    const previousGrantSignature = this.#grantedRelaySignature();
    this.#store.setAgentAccess(accountId, enabled);
    this.#revokedAccounts.delete(accountId);
    this.#nonDurableRevocationAccountIds.delete(accountId);
    const nextGrantSignature = this.#grantedRelaySignature();
    if (previousGrantSignature !== nextGrantSignature) {
      this.#authorizationRevision += 1;
      if (!enabled) this.#releaseBindingsUsingAccount(accountId);
    }
    return this.getSnapshot();
  }

  async resolveMcpServersForLaunch(input: {
    readonly threadId: string;
    readonly providerBindingId?: string;
    readonly projectLocation: ProjectLocation;
  }): Promise<ResolvedMcpServer[]> {
    const ready = this.#ready;
    if (!ready) return [];
    const providerBindingId = input.providerBindingId?.trim() || `thread:${input.threadId}`;
    const resolution = this.#beginProviderResolution(input.threadId, providerBindingId, ready);
    try {
      try {
        // The remote account set is an authorization input, so every launch
        // reconciles it. #refreshAllAccounts shares one in-flight read across
        // concurrent launches without allowing a completed read to stay cached.
        await this.#refreshAllAccounts();
      } catch {
        if (this.#isProviderResolutionCurrent(resolution)) {
          this.releaseMcpProviderBindings(input.threadId, providerBindingId);
        }
        return [];
      }

      if (!this.#isProviderResolutionCurrent(resolution)) return [];
      const reachability = await this.#resolveReachability(input.projectLocation);
      if (!this.#isProviderResolutionCurrent(resolution)) return [];
      if (!reachability) {
        this.releaseMcpProviderBindings(input.threadId, providerBindingId);
        return [];
      }

      const accounts = this.#grantedAccountsForRelay();
      const authorizationRevision = this.#authorizationRevision;
      const desiredKeys = new Set(
        accounts.map(({ localAccountId }) =>
          sharedBindingKey(providerBindingId, localAccountId, reachability.key),
        ),
      );
      if (!this.#isProviderResolutionCurrent(resolution)) return [];
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
        accounts.map(
          async ({ account, localAccountId }): Promise<ResolvedMcpServer | undefined> => {
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
              ...(reachability.advertisedHost
                ? { advertisedHost: reachability.advertisedHost }
                : {}),
            });
            if (
              !shared ||
              !this.#isProviderResolutionCurrent(resolution) ||
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
              name: `pd-${opaqueNameSuffix(localAccountId)}`,
              timeoutMs: 30_000,
              transport: {
                type: "http",
                url: shared.info.url,
                headers: { ...shared.info.headers },
              },
            };
          },
        ),
      );
      if (!this.#isProviderResolutionCurrent(resolution)) return [];
      return resolved.filter((server): server is ResolvedMcpServer => server !== undefined);
    } finally {
      this.#finishProviderResolution(resolution);
    }
  }

  releaseMcpBindings(threadId: string): void {
    this.#threadResolutionEpochs.set(
      threadId,
      (this.#threadResolutionEpochs.get(threadId) ?? 0) + 1,
    );
    for (const [scopeKey, epoch] of this.#providerBindingEpochs) {
      const scope = parseProviderResolutionScopeKey(scopeKey);
      if (scope?.threadId !== threadId) continue;
      this.#providerBindingEpochs.set(scopeKey, epoch + 1);
    }
    const keys = this.#bindingKeysByThread.get(threadId);
    if (keys) {
      for (const key of [...keys]) this.#releaseThreadBinding(threadId, key);
    }
    this.#pruneProviderResolutionState(threadId);
  }

  releaseMcpProviderBindings(threadId: string, providerBindingId: string): void {
    const normalizedProviderBindingId = providerBindingId.trim();
    if (!normalizedProviderBindingId) return;
    const scopeKey = providerResolutionScopeKey(threadId, normalizedProviderBindingId);
    this.#providerBindingEpochs.set(scopeKey, (this.#providerBindingEpochs.get(scopeKey) ?? 0) + 1);
    const keys = this.#bindingKeysByThread.get(threadId);
    if (keys) {
      for (const key of [...keys]) {
        if (providerBindingIdFromSharedBindingKey(key) === normalizedProviderBindingId) {
          this.#releaseThreadBinding(threadId, key);
        }
      }
    }
    this.#pruneProviderResolutionState(threadId, normalizedProviderBindingId);
  }

  #beginProviderResolution(
    threadId: string,
    providerBindingId: string,
    ready: ReadyRuntime,
  ): ProviderResolutionCapability {
    const scopeKey = providerResolutionScopeKey(threadId, providerBindingId);
    const threadEpoch = (this.#threadResolutionEpochs.get(threadId) ?? 0) + 1;
    const providerEpoch = this.#providerBindingEpochs.get(scopeKey) ?? 0;
    this.#threadResolutionEpochs.set(threadId, threadEpoch);
    this.#providerBindingEpochs.set(scopeKey, providerEpoch);
    this.#pendingThreadResolutions.set(
      threadId,
      (this.#pendingThreadResolutions.get(threadId) ?? 0) + 1,
    );
    this.#pendingProviderResolutions.set(
      scopeKey,
      (this.#pendingProviderResolutions.get(scopeKey) ?? 0) + 1,
    );
    return {
      threadId,
      providerBindingId,
      scopeKey,
      threadEpoch,
      providerEpoch,
      serviceGeneration: this.#serviceGeneration,
      ready,
    };
  }

  #isProviderResolutionCurrent(capability: ProviderResolutionCapability): boolean {
    return (
      this.#serviceGeneration === capability.serviceGeneration &&
      this.#ready === capability.ready &&
      this.#threadResolutionEpochs.get(capability.threadId) === capability.threadEpoch &&
      this.#providerBindingEpochs.get(capability.scopeKey) === capability.providerEpoch
    );
  }

  #finishProviderResolution(capability: ProviderResolutionCapability): void {
    if (
      this.#serviceGeneration !== capability.serviceGeneration ||
      this.#ready !== capability.ready
    ) {
      return;
    }
    const threadPending = (this.#pendingThreadResolutions.get(capability.threadId) ?? 1) - 1;
    if (threadPending <= 0) this.#pendingThreadResolutions.delete(capability.threadId);
    else this.#pendingThreadResolutions.set(capability.threadId, threadPending);
    const providerPending = (this.#pendingProviderResolutions.get(capability.scopeKey) ?? 1) - 1;
    if (providerPending <= 0) this.#pendingProviderResolutions.delete(capability.scopeKey);
    else this.#pendingProviderResolutions.set(capability.scopeKey, providerPending);
    this.#pruneProviderResolutionState(capability.threadId, capability.providerBindingId);
  }

  #pruneProviderResolutionState(threadId: string, providerBindingId?: string): void {
    const threadKeys = this.#bindingKeysByThread.get(threadId);
    if ((this.#pendingThreadResolutions.get(threadId) ?? 0) === 0 && !threadKeys?.size) {
      this.#threadResolutionEpochs.delete(threadId);
    }
    const providerBindingIds = providerBindingId
      ? [providerBindingId]
      : [...this.#providerBindingEpochs.keys()]
          .map(parseProviderResolutionScopeKey)
          .filter((scope) => scope?.threadId === threadId)
          .map((scope) => scope!.providerBindingId);
    for (const candidate of providerBindingIds) {
      const scopeKey = providerResolutionScopeKey(threadId, candidate);
      const hasBinding = [...(threadKeys ?? [])].some(
        (key) => providerBindingIdFromSharedBindingKey(key) === candidate,
      );
      if ((this.#pendingProviderResolutions.get(scopeKey) ?? 0) === 0 && !hasBinding) {
        this.#providerBindingEpochs.delete(scopeKey);
      }
    }
  }

  async dispose(): Promise<void> {
    this.#serviceGeneration += 1;
    this.#bindingKeysByThread.clear();
    this.#sharedBindings.clear();
    this.#pendingBindings.clear();
    this.#accountIdByBindingKey.clear();
    this.#threadResolutionEpochs.clear();
    this.#providerBindingEpochs.clear();
    this.#pendingThreadResolutions.clear();
    this.#pendingProviderResolutions.clear();
    this.#revokedAccounts.clear();
    this.#nonDurableRevocationAccountIds.clear();
    this.#pendingDisconnectAccountIds.clear();
    this.#accountsRefresh = undefined;
    this.#authorizationRevision += 1;
    this.#accountMutationRevision += 1;
    const relay = this.#ready?.relay;
    this.#ready = undefined;
    if (relay) void this.#trackRelayDisposal(relay);
    await Promise.all([...this.#relayDisposals]);
  }

  #trackRelayDisposal(relay: PipedreamRelay): Promise<void> {
    let disposal: Promise<void>;
    try {
      disposal = relay.dispose();
    } catch {
      return Promise.resolve();
    }
    let tracked!: Promise<void>;
    tracked = disposal.catch(() => undefined).finally(() => this.#relayDisposals.delete(tracked));
    this.#relayDisposals.add(tracked);
    return tracked;
  }

  async #refreshAllAccounts(): Promise<void> {
    if (this.#accountsRefresh) return this.#accountsRefresh;
    const readyAtStart = this.#ready;
    const mutationRevisionAtStart = this.#accountMutationRevision;
    let refresh!: Promise<void>;
    refresh = this.#loadAllAccounts(readyAtStart, mutationRevisionAtStart).finally(() => {
      if (this.#accountsRefresh === refresh) this.#accountsRefresh = undefined;
    });
    this.#accountsRefresh = refresh;
    return refresh;
  }

  async #loadAllAccounts(
    readyAtStart: ReadyRuntime | undefined,
    mutationRevisionAtStart: number,
  ): Promise<void> {
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
    if (
      !readyAtStart ||
      this.#ready !== readyAtStart ||
      this.#accountMutationRevision !== mutationRevisionAtStart
    ) {
      throw new Error("Pipedream request failed.");
    }
    const previousGrantSignature = this.#grantedRelaySignature();
    const revokedAccountIds = new Set(this.#revokedAccounts.keys());
    this.#store.replaceRemoteAccounts(accounts, revokedAccountIds);
    const nextGrantSignature = this.#grantedRelaySignature();
    if (previousGrantSignature !== nextGrantSignature) {
      this.#authorizationRevision += 1;
      this.#revokeBindingsNoLongerGranted();
    }
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
      if (this.#ready !== ready) throw new Error("Pipedream configuration changed.");
      return result;
    } catch {
      // Deliberately do not preserve the upstream error as `cause`: it may
      // contain provider response details that must not cross public IPC.
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
      this.#grantedAccountsForRelay().map(({ account }) => account.id),
    );
    for (const binding of [...this.#sharedBindings.values()]) {
      if (!grantedAccountIds.has(binding.upstreamAccountId)) this.#revokeSharedBinding(binding);
    }
    for (const [key, accountId] of this.#accountIdByBindingKey) {
      if (!grantedAccountIds.has(accountId)) this.#removeBindingKeyFromAllThreads(key);
    }
  }

  #isGrantCurrent(accountId: string, localAccountId: string, appSlug: string): boolean {
    return this.#grantedAccountsForRelay().some(
      (candidate) =>
        candidate.account.id === accountId &&
        candidate.localAccountId === localAccountId &&
        candidate.account.app.slug === appSlug,
    );
  }

  /**
   * The authorization revision protects pending relay creation from a grant
   * changing underneath it. Account refreshes also update display metadata,
   * so only the effective healthy, agent-enabled relay grant set belongs in
   * that revision. Otherwise a harmless poll can invalidate a concurrent
   * launch and make the agent start without its integration.
   */
  #grantedRelaySignature(): string {
    const grants = this.#grantedAccountsForRelay()
      .map(({ account, localAccountId }) => [account.id, localAccountId, account.app.slug] as const)
      .sort((left, right) => {
        const leftKey = JSON.stringify(left);
        const rightKey = JSON.stringify(right);
        return leftKey.localeCompare(rightKey);
      });
    return JSON.stringify(grants);
  }

  #grantedAccountsForRelay(): PipedreamGrantedRelayAccount[] {
    return this.#store
      .listGrantedForRelay()
      .filter(({ account }) => !this.#revokedAccounts.has(account.id));
  }

  #finishPendingDisconnect(accountId: string, clearQuarantine: boolean): void {
    this.#accountMutationRevision += 1;
    this.#pendingDisconnectAccountIds.delete(accountId);
    if (clearQuarantine) {
      this.#revokedAccounts.delete(accountId);
      this.#nonDurableRevocationAccountIds.delete(accountId);
    }
  }

  #accountsForSnapshot(): PipedreamAccountSummary[] {
    const accounts = this.#store.list();
    const indexById = new Map(accounts.map((account, index) => [account.id, index]));
    for (const revoked of this.#revokedAccounts.values()) {
      if (this.#nonDurableRevocationAccountIds.has(revoked.id)) continue;
      const safe = { ...revoked, agentAccess: false, app: { ...revoked.app } };
      const index = indexById.get(revoked.id);
      if (index === undefined) {
        indexById.set(revoked.id, accounts.length);
        accounts.push(safe);
      } else {
        accounts[index] = { ...accounts[index]!, agentAccess: false };
      }
    }
    return accounts;
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

function providerResolutionScopeKey(threadId: string, providerBindingId: string): string {
  return JSON.stringify([threadId, providerBindingId]);
}

function parseProviderResolutionScopeKey(
  scopeKey: string,
): { threadId: string; providerBindingId: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(scopeKey);
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "string" ||
      typeof parsed[1] !== "string"
    ) {
      return undefined;
    }
    return { threadId: parsed[0], providerBindingId: parsed[1] };
  } catch {
    return undefined;
  }
}

function providerBindingIdFromSharedBindingKey(key: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(key);
    return Array.isArray(parsed) && typeof parsed[0] === "string" ? parsed[0] : undefined;
  } catch {
    return undefined;
  }
}

function opaqueNameSuffix(localAccountId: string): string {
  return localAccountId.replaceAll("-", "").slice(0, 12).toLowerCase();
}
