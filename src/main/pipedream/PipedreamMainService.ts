import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { isAbsolute } from "node:path";
import {
  pipedreamBeginConnectPayloadSchema,
  pipedreamBeginConnectResultSchema,
  pipedreamConnectFlowPayloadSchema,
  pipedreamConnectFlowStatusSchema,
  pipedreamEnvFileImportResultSchema,
  pipedreamPersonalMcpOauthBeginResultSchema,
  pipedreamPersonalMcpOauthFlowPayloadSchema,
  pipedreamPersonalMcpOauthFlowStatusSchema,
  type McpOauthBeginResult,
  type McpOauthWaitResult,
  type PipedreamBeginConnectPayload,
  type PipedreamBeginConnectResult,
  type PipedreamConnectFlowPayload,
  type PipedreamConnectFlowStatus,
  type PipedreamEnvFileImportResult,
  type PipedreamPersonalMcpOauthBeginResult,
  type PipedreamPersonalMcpOauthFlowPayload,
  type PipedreamPersonalMcpOauthFlowStatus,
  type PipedreamSnapshot,
} from "@/shared/contracts";
import {
  capturePipedreamBootstrapEnvText,
  PIPEDREAM_ENV_FILE_MAX_BYTES,
  type PipedreamBootstrap,
} from "@/shared/pipedreamBootstrap";
import type { PipedreamPrivilegedConnectLinkResult } from "@/shared/pipedreamPrivilegedIpc";
import {
  allocateSensitiveSessionPartition,
  releaseUnusedSensitiveSessionPartition,
  type SensitiveSessionPartitionPoolLease,
} from "../browser/sensitiveSessionPartitionPool";

export interface PipedreamMainServiceOptions {
  readonly createConnectLink: (
    appSlug: string,
    redirects: PipedreamConnectRedirects,
  ) => Promise<PipedreamPrivilegedConnectLinkResult>;
  readonly openConnectUrl: (
    url: string,
    ownership: PipedreamConnectTabOwnership,
  ) => Promise<{ tabId: string }>;
  readonly closeConnectTab: (tabId: string) => Promise<void>;
  readonly isConnectTabOpen: (tabId: string) => Promise<boolean>;
  readonly beginPersonalMcpOauth?: () => Promise<McpOauthBeginResult>;
  readonly waitPersonalMcpOauth?: (flowId: string) => Promise<McpOauthWaitResult>;
  readonly cancelPersonalMcpOauth?: (flowId: string) => Promise<void>;
  readonly clearPersonalMcpOauth?: () => Promise<void>;
  readonly persistEnvFilePath: (filePath: string) => void;
  readonly clearEnvFilePath: () => void;
  readonly fallbackBootstrap: () => PipedreamBootstrap;
  readonly configureBootstrap: (bootstrap: PipedreamBootstrap) => Promise<PipedreamSnapshot>;
}

export interface PipedreamConnectRedirects {
  readonly successRedirectUrl: string;
  readonly errorRedirectUrl: string;
}

/** Main-only capability inherited by every sensitive popup in one Connect flow. */
export interface PipedreamConnectTabOwnership {
  readonly sessionPartition: string;
  readonly nativeSessionPartitionLease?: SensitiveSessionPartitionPoolLease;
  canOpenTab(): boolean;
  onTabOpened(tabId: string): void;
  onTabClosed(tabId: string): void;
}

interface ActiveConnectFlow {
  readonly flowId: string;
  readonly sessionPartition: string;
  readonly nativeSessionPartitionLease: SensitiveSessionPartitionPoolLease;
  readonly expiresAtMs: number;
  readonly tabIds: Set<string>;
  readonly redirectReceiver: PipedreamConnectRedirectReceiver;
  openingRequestGeneration: number | null;
  acceptingTabs: boolean;
  expiryTimer: ReturnType<typeof setTimeout> | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  cleanupPromise: Promise<void> | null;
  releaseAfterCleanup: boolean;
  state: PipedreamConnectFlowState;
}

interface ActivePersonalMcpOauthFlow {
  readonly flowId: string;
  readonly supervisorFlowId: string;
  readonly nativeSessionPartitionLease: SensitiveSessionPartitionPoolLease;
  readonly tabIds: Set<string>;
  openingTab: boolean;
  acceptingTabs: boolean;
  state: PipedreamPersonalMcpOauthFlowStatus["state"];
  expiryTimer: ReturnType<typeof setTimeout> | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  cleanupPromise: Promise<PersonalMcpOauthCleanupResult> | null;
  cleanupComplete: boolean;
  readonly cleanupWaiters: Set<() => void>;
  releaseAfterCleanup: boolean;
  retentionTimer: ReturnType<typeof setTimeout> | null;
}

const MAX_CONNECT_FLOW_LIFETIME_MS = 5 * 60_000;
const CONNECT_CLEANUP_RETRY_MS = 250;
const PERSONAL_MCP_OAUTH_TERMINAL_RETENTION_MS = 30_000;
const CONNECT_REDIRECT_RESPONSE = "You may return to Y Space.";

type PipedreamConnectFlowState = PipedreamConnectFlowStatus["state"];
type PipedreamConnectTerminalState = Exclude<PipedreamConnectFlowState, "open">;
type PersonalMcpOauthCleanupResult = "complete" | "pending";

interface PipedreamConnectRedirectReceiver extends PipedreamConnectRedirects {
  dispose(): Promise<void>;
}

/** Main-only Connect-link coordinator; renderer receives only a safe acknowledgement. */
export class PipedreamMainService {
  readonly #options: PipedreamMainServiceOptions;
  #activeConnectFlow: ActiveConnectFlow | null = null;
  #activePersonalMcpOauthFlow: ActivePersonalMcpOauthFlow | null = null;
  #connectLifecycleQueue: Promise<void> = Promise.resolve();
  #personalMcpOauthLifecycleQueue: Promise<void> = Promise.resolve();
  #connectRequestGeneration = 0;
  #personalMcpOauthRevocationGeneration = 0;
  readonly #pendingRedirectReceivers = new Map<number, PipedreamConnectRedirectReceiver>();
  #configurationMutationInProgress = false;
  #disposed = false;

  constructor(options: PipedreamMainServiceOptions) {
    this.#options = options;
  }

  beginPersonalMcpOauth(): Promise<PipedreamPersonalMcpOauthBeginResult> {
    const revocationGeneration = this.#personalMcpOauthRevocationGeneration;
    return this.#withPersonalMcpOauthLifecycleLock(() =>
      this.#beginPersonalMcpOauth(revocationGeneration),
    );
  }

  async #beginPersonalMcpOauth(
    revocationGeneration: number,
  ): Promise<PipedreamPersonalMcpOauthBeginResult> {
    if (this.#disposed || revocationGeneration !== this.#personalMcpOauthRevocationGeneration) {
      throw new Error("Pipedream Connect request was superseded.");
    }
    const beginOauth = this.#options.beginPersonalMcpOauth;
    const waitOauth = this.#options.waitPersonalMcpOauth;
    if (!beginOauth || !waitOauth) return { state: "error" };

    const previous = this.#activePersonalMcpOauthFlow;
    if (previous) await this.#retirePersonalMcpOauthFlowForReplacement(previous);
    if (this.#disposed || revocationGeneration !== this.#personalMcpOauthRevocationGeneration) {
      throw new Error("Pipedream Connect request was superseded.");
    }

    let begin: McpOauthBeginResult;
    try {
      begin = await beginOauth();
    } catch {
      return { state: "error" };
    }
    if (this.#disposed || revocationGeneration !== this.#personalMcpOauthRevocationGeneration) {
      if (begin.status === "redirect") {
        await this.#options.cancelPersonalMcpOauth?.(begin.flowId).catch(() => undefined);
      }
      throw new Error("Pipedream Connect request was superseded.");
    }
    if (begin.status === "authorized") return { state: "authorized" };
    if (begin.status !== "redirect") return { state: "error" };

    let authorizationUrl: string;
    try {
      authorizationUrl = requireSecurePersonalMcpOauthUrl(begin.authorizationUrl);
    } catch {
      await this.#options.cancelPersonalMcpOauth?.(begin.flowId).catch(() => undefined);
      return { state: "error" };
    }

    const nativeSessionPartitionLease = allocateSensitiveSessionPartition();
    const flow: ActivePersonalMcpOauthFlow = {
      flowId: randomUUID(),
      supervisorFlowId: begin.flowId,
      nativeSessionPartitionLease,
      tabIds: new Set<string>(),
      openingTab: true,
      acceptingTabs: true,
      state: "open",
      expiryTimer: null,
      cleanupTimer: null,
      cleanupPromise: null,
      cleanupComplete: false,
      cleanupWaiters: new Set(),
      releaseAfterCleanup: false,
      retentionTimer: null,
    };
    this.#activePersonalMcpOauthFlow = flow;
    const ownership = this.#createPersonalMcpOauthTabOwnership(flow);
    try {
      const opened = await this.#options.openConnectUrl(authorizationUrl, ownership);
      ownership.onTabOpened(requireMainOwnedSensitiveTabId(opened.tabId));
    } catch {
      flow.openingTab = false;
      await this.#closePersonalMcpOauthFlow(flow, true, true);
      return { state: "error" };
    }
    flow.openingTab = false;
    if (
      revocationGeneration !== this.#personalMcpOauthRevocationGeneration ||
      !ownership.canOpenTab()
    ) {
      await this.#closePersonalMcpOauthFlow(flow, true, true);
      throw new Error("Pipedream Connect request was superseded.");
    }

    flow.expiryTimer = setTimeout(() => {
      void this.#withPersonalMcpOauthLifecycleLock(() =>
        this.#closePersonalMcpOauthFlow(flow, true, false),
      );
    }, MAX_CONNECT_FLOW_LIFETIME_MS);
    flow.expiryTimer.unref?.();
    void waitOauth(flow.supervisorFlowId).then(
      (result) =>
        this.#settlePersonalMcpOauthFlow(
          flow,
          result.status === "authorized" ? "authorized" : "error",
        ),
      () => this.#settlePersonalMcpOauthFlow(flow, "error"),
    );

    return pipedreamPersonalMcpOauthBeginResultSchema.parse({
      state: "open",
      flowId: flow.flowId,
    });
  }

  async getPersonalMcpOauthFlowStatus(
    payload: PipedreamPersonalMcpOauthFlowPayload,
  ): Promise<PipedreamPersonalMcpOauthFlowStatus> {
    return this.#withPersonalMcpOauthLifecycleLock(async () => {
      const { flowId } = pipedreamPersonalMcpOauthFlowPayloadSchema.parse(payload);
      const flow = this.#activePersonalMcpOauthFlow;
      if (!flow || flow.flowId !== flowId) return { state: "closed" };
      if (flow.state === "open") {
        let hasOpenTab = false;
        for (const tabId of [...flow.tabIds]) {
          if (await this.#options.isConnectTabOpen(tabId)) hasOpenTab = true;
          else flow.tabIds.delete(tabId);
        }
        if (!hasOpenTab) await this.#closePersonalMcpOauthFlow(flow, true, false);
      }
      return pipedreamPersonalMcpOauthFlowStatusSchema.parse({ state: flow.state });
    });
  }

  async cancelPersonalMcpOauth(payload: PipedreamPersonalMcpOauthFlowPayload): Promise<void> {
    const { flowId } = pipedreamPersonalMcpOauthFlowPayloadSchema.parse(payload);
    const flow = this.#activePersonalMcpOauthFlow;
    if (!flow || flow.flowId !== flowId) return;
    this.#personalMcpOauthRevocationGeneration += 1;
    await this.#closePersonalMcpOauthFlow(flow, true, false);
    // Revocation superseded the old flow and its supervisor mutation has
    // settled. Detach from a stale status-read tail so reconnect can proceed;
    // the retired flow keeps its own exact-tab cleanup quarantine.
    this.#personalMcpOauthLifecycleQueue = Promise.resolve();
  }

  async clearPersonalMcpOauth(): Promise<void> {
    this.#personalMcpOauthRevocationGeneration += 1;
    let clearOperation: Promise<void>;
    try {
      clearOperation = this.#options.clearPersonalMcpOauth?.() ?? Promise.resolve();
    } catch (error) {
      clearOperation = Promise.reject(error);
    }

    const flow = this.#activePersonalMcpOauthFlow;
    if (flow) void this.#closePersonalMcpOauthFlow(flow, true, false);

    // Replace, rather than append to, the lifecycle tail. Revocation already
    // superseded every older flow, so a stuck tab-status read must not prevent
    // a later reconnect; the new tail still orders that reconnect after the
    // privileged credential mutation settles.
    this.#personalMcpOauthLifecycleQueue = clearOperation.then(
      () => undefined,
      () => undefined,
    );
    await clearOperation;
  }

  async beginConnect(payload: PipedreamBeginConnectPayload): Promise<PipedreamBeginConnectResult> {
    if (this.#disposed) throw new Error("Pipedream Connect service is disposed.");
    if (this.#configurationMutationInProgress) {
      throw new Error("Pipedream configuration is changing.");
    }
    const { appSlug } = pipedreamBeginConnectPayloadSchema.parse(payload);
    const requestGeneration = ++this.#connectRequestGeneration;
    this.#disposeSupersededRedirectReceivers(requestGeneration);
    await this.#supersedeActiveConnectFlowForRequest();

    let ownedFlow: ActiveConnectFlow | null = null;
    let pendingTerminalState: PipedreamConnectTerminalState | null = null;
    const redirectReceiver = await createPipedreamConnectRedirectReceiver((state) => {
      if (ownedFlow) this.#settleConnectFlow(ownedFlow, state);
      else pendingTerminalState ??= state;
    });
    try {
      this.#assertCurrentConnectRequest(requestGeneration);
      this.#pendingRedirectReceivers.set(requestGeneration, redirectReceiver);

      // Remote link creation can stall indefinitely. Keep it outside the local
      // lifecycle queue so expiry and terminal redirect cleanup remain independent.
      const result = await this.#options.createConnectLink(appSlug, redirectReceiver);
      const url = requireTrustedPipedreamConnectUrl(result.connectLinkUrl);
      const safeResult = pipedreamBeginConnectResultSchema.parse({
        opened: true,
        expiresAt: result.expiresAt,
        flowId: randomUUID(),
      });

      return await this.#withConnectLifecycleLock(async () => {
        this.#assertCurrentConnectRequest(requestGeneration);
        const upstreamExpiresAtMs = Date.parse(safeResult.expiresAt);
        const now = Date.now();
        if (!Number.isFinite(upstreamExpiresAtMs) || upstreamExpiresAtMs <= now) {
          throw new Error("Pipedream Connect Link has expired.");
        }
        const expiresAtMs = Math.min(upstreamExpiresAtMs, now + MAX_CONNECT_FLOW_LIFETIME_MS);

        const previousFlow = this.#activeConnectFlow;
        if (previousFlow) {
          previousFlow.releaseAfterCleanup = true;
          this.#settleConnectFlow(previousFlow, "closed");
          await previousFlow.redirectReceiver.dispose();
          await this.#attemptConnectCleanup(previousFlow);
          this.#releaseConnectFlow(previousFlow);
        }
        this.#assertCurrentConnectRequest(requestGeneration);

        const nativeSessionPartitionLease = allocateSensitiveSessionPartition();
        const flow: ActiveConnectFlow = {
          flowId: safeResult.flowId,
          sessionPartition: nativeSessionPartitionLease.partition,
          nativeSessionPartitionLease,
          expiresAtMs,
          tabIds: new Set<string>(),
          redirectReceiver,
          openingRequestGeneration: requestGeneration,
          acceptingTabs: true,
          expiryTimer: null,
          cleanupTimer: null,
          cleanupPromise: null,
          releaseAfterCleanup: false,
          state: "open",
        };
        ownedFlow = flow;
        this.#pendingRedirectReceivers.delete(requestGeneration);
        const ownership = this.#createTabOwnership(flow);
        this.#activeConnectFlow = flow;
        this.#scheduleConnectExpiry(flow);

        let opened: { tabId: string };
        try {
          opened = await this.#options.openConnectUrl(url, ownership);
          ownership.onTabOpened(requireMainOwnedSensitiveTabId(opened.tabId));
        } catch {
          this.#assertCurrentConnectRequest(requestGeneration);
          if (pendingTerminalState) this.#settleConnectFlow(flow, pendingTerminalState);
          flow.openingRequestGeneration = null;
          if (flow.state !== "open") return safeResult;

          flow.releaseAfterCleanup = true;
          this.#settleConnectFlow(flow, "closed");
          await flow.redirectReceiver.dispose();
          await this.#attemptConnectCleanup(flow).catch(() => undefined);
          this.#releaseConnectFlow(flow);
          throw new Error("Unable to open Pipedream Connect.");
        }
        this.#assertCurrentConnectRequest(requestGeneration);
        flow.openingRequestGeneration = null;
        if (pendingTerminalState) this.#settleConnectFlow(flow, pendingTerminalState);
        if (flow.state === "open" && !ownership.canOpenTab()) {
          flow.releaseAfterCleanup = true;
          this.#settleConnectFlow(flow, "closed");
          await flow.redirectReceiver.dispose();
          await this.#attemptConnectCleanup(flow);
          this.#releaseConnectFlow(flow);
          throw new Error("Pipedream Connect Link has expired.");
        }
        return safeResult;
      });
    } catch (error) {
      const failedFlow = ownedFlow as ActiveConnectFlow | null;
      if (failedFlow && this.#activeConnectFlow === failedFlow) {
        failedFlow.releaseAfterCleanup = true;
        this.#settleConnectFlow(failedFlow, "closed");
        await Promise.all([
          failedFlow.redirectReceiver.dispose().catch(() => undefined),
          this.#attemptConnectCleanup(failedFlow).catch(() => undefined),
        ]);
        this.#releaseConnectFlow(failedFlow);
      }
      throw error;
    } finally {
      this.#pendingRedirectReceivers.delete(requestGeneration);
      if (!ownedFlow) await redirectReceiver.dispose();
    }
  }

  async getConnectFlowStatus(
    payload: PipedreamConnectFlowPayload,
  ): Promise<PipedreamConnectFlowStatus> {
    return this.#withConnectLifecycleLock(async () => {
      const { flowId } = pipedreamConnectFlowPayloadSchema.parse(payload);
      const activeFlow = this.#activeConnectFlow;
      if (!activeFlow || activeFlow.flowId !== flowId) {
        return pipedreamConnectFlowStatusSchema.parse({ state: "closed" });
      }
      if (activeFlow.state !== "open") {
        return pipedreamConnectFlowStatusSchema.parse({ state: activeFlow.state });
      }
      if (Date.now() >= activeFlow.expiresAtMs) {
        this.#settleConnectFlow(activeFlow, "expired");
        return pipedreamConnectFlowStatusSchema.parse({ state: "expired" });
      }

      let hasOpenTab = false;
      for (const tabId of [...activeFlow.tabIds]) {
        let isOpen: boolean;
        try {
          isOpen = await this.#options.isConnectTabOpen(tabId);
        } catch {
          throw new Error("Unable to inspect Pipedream Connect.");
        }
        if (isOpen) {
          hasOpenTab = true;
        } else {
          activeFlow.tabIds.delete(tabId);
        }
      }
      if (!hasOpenTab) {
        this.#settleConnectFlow(activeFlow, "closed");
      }
      return pipedreamConnectFlowStatusSchema.parse({ state: activeFlow.state });
    });
  }

  async finishConnect(payload: PipedreamConnectFlowPayload): Promise<void> {
    await this.#closeConnectFlow(payload);
  }

  async cancelConnect(payload: PipedreamConnectFlowPayload): Promise<void> {
    await this.#closeConnectFlow(payload);
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#connectRequestGeneration += 1;
    this.#personalMcpOauthRevocationGeneration += 1;
    const pendingReceivers = [...this.#pendingRedirectReceivers.values()];
    this.#pendingRedirectReceivers.clear();
    const activeFlow = this.#activeConnectFlow;
    if (activeFlow) {
      activeFlow.releaseAfterCleanup = true;
      this.#settleConnectFlow(activeFlow, "closed");
      // Disposal revoked the exact flow synchronously. Do not wait behind an
      // openConnectUrl call that may never return before finishing cleanup.
      this.#connectLifecycleQueue = Promise.resolve();
    }
    const personalOauthFlow = this.#activePersonalMcpOauthFlow;
    const personalOauthClose = personalOauthFlow
      ? this.#closePersonalMcpOauthFlow(personalOauthFlow, true, false)
      : Promise.resolve();
    await Promise.all([
      personalOauthClose,
      ...pendingReceivers.map((receiver) => receiver.dispose()),
      ...(activeFlow ? [activeFlow.redirectReceiver.dispose()] : []),
    ]);
    await this.#withConnectLifecycleLock(async () => {
      if (!activeFlow) return;
      await this.#attemptConnectCleanup(activeFlow);
      this.#releaseConnectFlow(activeFlow);
    });
  }

  async importEnvironmentFile(filePath: string): Promise<PipedreamEnvFileImportResult> {
    if (!isAbsolute(filePath) || filePath.length > 4_096) {
      return { status: "invalid", reason: "unreadable" };
    }

    let serialized: string;
    try {
      const metadata = statSync(filePath);
      if (!metadata.isFile()) return { status: "invalid", reason: "unreadable" };
      if (metadata.size > PIPEDREAM_ENV_FILE_MAX_BYTES) {
        return { status: "invalid", reason: "too-large" };
      }
      serialized = readFileSync(filePath, "utf8");
      if (Buffer.byteLength(serialized, "utf8") > PIPEDREAM_ENV_FILE_MAX_BYTES) {
        return { status: "invalid", reason: "too-large" };
      }
    } catch {
      return { status: "invalid", reason: "unreadable" };
    }

    const bootstrap = capturePipedreamBootstrapEnvText(serialized, {});
    if (bootstrap.state === "absent") {
      return { status: "invalid", reason: "no-supported-values" };
    }

    return this.#withConfigurationMutation(async () => {
      const snapshot = await this.#options.configureBootstrap(bootstrap);
      this.#options.persistEnvFilePath(filePath);
      return pipedreamEnvFileImportResultSchema.parse({ status: "configured", snapshot });
    });
  }

  async clearEnvironmentFile(): Promise<PipedreamSnapshot> {
    return this.#withConfigurationMutation(async () => {
      const snapshot = await this.#options.configureBootstrap(this.#options.fallbackBootstrap());
      this.#options.clearEnvFilePath();
      return snapshot;
    });
  }

  async #closeConnectFlow(payload: PipedreamConnectFlowPayload): Promise<void> {
    await this.#withConnectLifecycleLock(async () => {
      const { flowId } = pipedreamConnectFlowPayloadSchema.parse(payload);
      const activeFlow = this.#activeConnectFlow;
      if (!activeFlow || activeFlow.flowId !== flowId) return;

      activeFlow.releaseAfterCleanup = true;
      this.#settleConnectFlow(activeFlow, "closed");
      const cleanup = this.#attemptConnectCleanup(activeFlow);
      await Promise.all([activeFlow.redirectReceiver.dispose(), cleanup]);
      this.#releaseConnectFlow(activeFlow);
    });
  }

  #createTabOwnership(flow: ActiveConnectFlow): PipedreamConnectTabOwnership {
    return Object.freeze({
      sessionPartition: flow.sessionPartition,
      nativeSessionPartitionLease: flow.nativeSessionPartitionLease,
      canOpenTab: () => this.#canOpenConnectTab(flow),
      onTabOpened: (value: string) => {
        const tabId = requireMainOwnedSensitiveTabId(value);
        if (this.#canOpenConnectTab(flow)) {
          flow.tabIds.add(tabId);
          return;
        }
        flow.tabIds.add(tabId);
        this.#settleConnectFlow(flow, "closed");
        void this.#attemptConnectCleanup(flow).catch(() => undefined);
      },
      onTabClosed: (value: string) => {
        if (typeof value !== "string") return;
        flow.tabIds.delete(value);
        if (
          flow.state === "open" &&
          flow.openingRequestGeneration === null &&
          flow.tabIds.size === 0
        ) {
          this.#settleConnectFlow(flow, "closed");
        }
      },
    });
  }

  #createPersonalMcpOauthTabOwnership(
    flow: ActivePersonalMcpOauthFlow,
  ): PipedreamConnectTabOwnership {
    return Object.freeze({
      sessionPartition: flow.nativeSessionPartitionLease.partition,
      nativeSessionPartitionLease: flow.nativeSessionPartitionLease,
      canOpenTab: () =>
        !this.#disposed &&
        this.#activePersonalMcpOauthFlow === flow &&
        flow.acceptingTabs &&
        flow.state === "open",
      onTabOpened: (value: string) => {
        const tabId = requireMainOwnedSensitiveTabId(value);
        flow.tabIds.add(tabId);
        if (!flow.acceptingTabs) void this.#attemptPersonalMcpOauthCleanup(flow);
      },
      onTabClosed: (value: string) => {
        flow.tabIds.delete(value);
        if (!flow.acceptingTabs && !flow.cleanupComplete) {
          void this.#attemptPersonalMcpOauthCleanup(flow);
        }
      },
    });
  }

  #settlePersonalMcpOauthFlow(
    flow: ActivePersonalMcpOauthFlow,
    state: "authorized" | "error",
  ): void {
    if (flow.state !== "open") return;
    flow.state = state;
    flow.acceptingTabs = false;
    if (flow.expiryTimer) {
      clearTimeout(flow.expiryTimer);
      flow.expiryTimer = null;
    }
    void this.#attemptPersonalMcpOauthCleanup(flow);
  }

  async #closePersonalMcpOauthFlow(
    flow: ActivePersonalMcpOauthFlow,
    cancelSupervisor: boolean,
    waitForCleanup: boolean,
  ): Promise<void> {
    const shouldCancelSupervisor = cancelSupervisor && flow.state === "open";
    flow.releaseAfterCleanup = true;
    flow.acceptingTabs = false;
    if (flow.state === "open") flow.state = "closed";
    if (flow.expiryTimer) {
      clearTimeout(flow.expiryTimer);
      flow.expiryTimer = null;
    }
    if (flow.retentionTimer) {
      clearTimeout(flow.retentionTimer);
      flow.retentionTimer = null;
    }
    const cancel = shouldCancelSupervisor
      ? (this.#options.cancelPersonalMcpOauth?.(flow.supervisorFlowId).catch(() => undefined) ??
        Promise.resolve())
      : Promise.resolve();
    const cleanup = this.#attemptPersonalMcpOauthCleanup(flow);
    await cancel;
    if (!waitForCleanup) return;
    if ((await cleanup) === "pending") await this.#waitForPersonalMcpOauthCleanup(flow);
    this.#releasePersonalMcpOauthFlow(flow);
  }

  async #retirePersonalMcpOauthFlowForReplacement(flow: ActivePersonalMcpOauthFlow): Promise<void> {
    if (!flow.openingTab || flow.acceptingTabs) {
      await this.#closePersonalMcpOauthFlow(flow, true, true);
      return;
    }

    // Clear/cancel already revoked this flow, but its Browser open may never
    // settle. Quarantine that exact ownership object and detach it from the
    // active slot so a reconnect can use a fresh partition. A late tab is
    // still registered on `flow` and closed by its existing cleanup path.
    await this.#closePersonalMcpOauthFlow(flow, true, false);
    if (flow.cleanupTimer) {
      clearTimeout(flow.cleanupTimer);
      flow.cleanupTimer = null;
    }
    if (this.#activePersonalMcpOauthFlow === flow) {
      this.#activePersonalMcpOauthFlow = null;
    }
  }

  #schedulePersonalMcpOauthRetirement(flow: ActivePersonalMcpOauthFlow): void {
    if (
      flow.retentionTimer ||
      !flow.cleanupComplete ||
      flow.releaseAfterCleanup ||
      flow.state === "open" ||
      this.#activePersonalMcpOauthFlow !== flow
    ) {
      return;
    }
    flow.retentionTimer = setTimeout(() => {
      flow.retentionTimer = null;
      this.#releasePersonalMcpOauthFlow(flow);
    }, PERSONAL_MCP_OAUTH_TERMINAL_RETENTION_MS);
    flow.retentionTimer.unref?.();
  }

  #attemptPersonalMcpOauthCleanup(
    flow: ActivePersonalMcpOauthFlow,
  ): Promise<PersonalMcpOauthCleanupResult> {
    if (flow.cleanupComplete) return Promise.resolve("complete");
    if (flow.cleanupPromise) return flow.cleanupPromise;
    if (flow.cleanupTimer) {
      clearTimeout(flow.cleanupTimer);
      flow.cleanupTimer = null;
    }
    if (!flow.openingTab && flow.tabIds.size === 0) {
      this.#completePersonalMcpOauthCleanup(flow);
      return Promise.resolve("complete");
    }
    if (flow.openingTab && flow.tabIds.size === 0) {
      this.#schedulePersonalMcpOauthCleanupRetry(flow);
      return Promise.resolve("pending");
    }
    const cleanup = this.#closePersonalMcpOauthTabs(flow).then((result) => {
      if (result === "complete") this.#completePersonalMcpOauthCleanup(flow);
      else this.#schedulePersonalMcpOauthCleanupRetry(flow);
      return result;
    });
    flow.cleanupPromise = cleanup;
    void cleanup.finally(() => {
      if (flow.cleanupPromise === cleanup) flow.cleanupPromise = null;
    });
    return cleanup;
  }

  async #closePersonalMcpOauthTabs(
    flow: ActivePersonalMcpOauthFlow,
  ): Promise<PersonalMcpOauthCleanupResult> {
    for (const tabId of [...flow.tabIds].reverse()) {
      try {
        await this.#options.closeConnectTab(tabId);
        flow.tabIds.delete(tabId);
      } catch {
        if (!flow.tabIds.has(tabId)) continue;
        let isOpen = true;
        try {
          isOpen = await this.#options.isConnectTabOpen(tabId);
        } catch {
          // Inspection failure cannot prove destruction. Retain exact ownership
          // and retry instead of allowing a replacement sensitive tab tree.
        }
        if (!isOpen) flow.tabIds.delete(tabId);
      }
    }
    return flow.tabIds.size === 0 ? "complete" : "pending";
  }

  #schedulePersonalMcpOauthCleanupRetry(flow: ActivePersonalMcpOauthFlow): void {
    if (flow.cleanupComplete || flow.cleanupTimer) return;
    flow.cleanupTimer = setTimeout(() => {
      flow.cleanupTimer = null;
      void this.#attemptPersonalMcpOauthCleanup(flow);
    }, CONNECT_CLEANUP_RETRY_MS);
    flow.cleanupTimer.unref?.();
  }

  #completePersonalMcpOauthCleanup(flow: ActivePersonalMcpOauthFlow): void {
    if (flow.cleanupComplete || flow.openingTab || flow.tabIds.size > 0) return;
    flow.cleanupComplete = true;
    if (flow.cleanupTimer) {
      clearTimeout(flow.cleanupTimer);
      flow.cleanupTimer = null;
    }
    releaseUnusedSensitiveSessionPartition(flow.nativeSessionPartitionLease);
    for (const resolve of flow.cleanupWaiters) resolve();
    flow.cleanupWaiters.clear();
    if (flow.releaseAfterCleanup) this.#releasePersonalMcpOauthFlow(flow);
    else this.#schedulePersonalMcpOauthRetirement(flow);
  }

  #waitForPersonalMcpOauthCleanup(flow: ActivePersonalMcpOauthFlow): Promise<void> {
    if (flow.cleanupComplete) return Promise.resolve();
    return new Promise<void>((resolve) => flow.cleanupWaiters.add(resolve));
  }

  #releasePersonalMcpOauthFlow(flow: ActivePersonalMcpOauthFlow): void {
    if (!flow.cleanupComplete || this.#activePersonalMcpOauthFlow !== flow) return;
    if (flow.retentionTimer) {
      clearTimeout(flow.retentionTimer);
      flow.retentionTimer = null;
    }
    this.#activePersonalMcpOauthFlow = null;
  }

  #canOpenConnectTab(flow: ActiveConnectFlow): boolean {
    return (
      !this.#disposed &&
      this.#activeConnectFlow === flow &&
      flow.acceptingTabs &&
      flow.state === "open" &&
      (flow.openingRequestGeneration === null ||
        flow.openingRequestGeneration === this.#connectRequestGeneration) &&
      Date.now() < flow.expiresAtMs
    );
  }

  #assertCurrentConnectRequest(requestGeneration: number): void {
    if (this.#disposed) throw new Error("Pipedream Connect service is disposed.");
    if (requestGeneration !== this.#connectRequestGeneration) {
      throw new Error("Pipedream Connect request was superseded.");
    }
  }

  #scheduleConnectExpiry(flow: ActiveConnectFlow): void {
    if (!this.#canOpenConnectTab(flow)) return;
    const remainingMs = flow.expiresAtMs - Date.now();
    const delayMs = Math.max(0, remainingMs);
    flow.expiryTimer = setTimeout(() => {
      flow.expiryTimer = null;
      if (this.#disposed || this.#activeConnectFlow !== flow || !flow.acceptingTabs) return;
      if (Date.now() < flow.expiresAtMs) {
        this.#scheduleConnectExpiry(flow);
        return;
      }
      this.#settleConnectFlow(flow, "expired");
    }, delayMs);
    flow.expiryTimer.unref?.();
  }

  #settleConnectFlow(flow: ActiveConnectFlow, state: PipedreamConnectTerminalState): boolean {
    if (flow.state !== "open") return false;
    flow.state = state;
    flow.acceptingTabs = false;
    if (flow.expiryTimer) {
      clearTimeout(flow.expiryTimer);
      flow.expiryTimer = null;
    }
    void flow.redirectReceiver.dispose();
    void this.#attemptConnectCleanup(flow).catch(() => undefined);
    return true;
  }

  #releaseConnectFlow(flow: ActiveConnectFlow): void {
    if (!flow.releaseAfterCleanup || flow.tabIds.size > 0 || flow.cleanupPromise) return;
    if (flow.cleanupTimer) {
      clearTimeout(flow.cleanupTimer);
      flow.cleanupTimer = null;
    }
    // Unit-test/failure paths can reserve a slot without ever reaching the
    // BrowserPanelManager. A claimed BrowserContext ignores this call and is
    // returned only by the manager's destruction + cleanup path.
    releaseUnusedSensitiveSessionPartition(flow.nativeSessionPartitionLease);
    if (this.#activeConnectFlow === flow) this.#activeConnectFlow = null;
  }

  #disposeSupersededRedirectReceivers(currentGeneration: number): void {
    for (const [generation, receiver] of this.#pendingRedirectReceivers) {
      if (generation >= currentGeneration) continue;
      this.#pendingRedirectReceivers.delete(generation);
      void receiver.dispose();
    }
  }

  /**
   * A newer request owns cancellation immediately, before remote link
   * creation or URL validation. The older request may still be stuck inside
   * openConnectUrl while holding the lifecycle queue, so teardown cannot wait
   * for that queue. Revoke tab ownership, close known tabs, and dispose the
   * exact loopback receiver now; late tabs are quarantined by the settled
   * ownership object and cleaned by the same retry path.
   */
  async #supersedeActiveConnectFlowForRequest(): Promise<void> {
    const activeFlow = this.#activeConnectFlow;
    if (!activeFlow) return;
    activeFlow.releaseAfterCleanup = true;
    this.#settleConnectFlow(activeFlow, "closed");
    // The prior request may be indefinitely suspended inside openConnectUrl
    // while owning the serialized tail. Its generation and exact flow
    // authority are already revoked, so detach that poisoned tail and let the
    // replacement establish its own independently ordered lifecycle.
    this.#connectLifecycleQueue = Promise.resolve();
    const receiverDisposal = activeFlow.redirectReceiver.dispose().catch(() => undefined);
    void this.#attemptConnectCleanup(activeFlow).catch(() => undefined);
    await receiverDisposal;
  }

  async #withConfigurationMutation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#disposed) throw new Error("Pipedream Connect service is disposed.");
    if (this.#configurationMutationInProgress) {
      throw new Error("Pipedream configuration is already changing.");
    }
    this.#configurationMutationInProgress = true;
    try {
      await this.#supersedeConnectFlowsForConfiguration();
      return await operation();
    } finally {
      this.#configurationMutationInProgress = false;
    }
  }

  async #supersedeConnectFlowsForConfiguration(): Promise<void> {
    this.#connectRequestGeneration += 1;
    const pendingReceivers = [...this.#pendingRedirectReceivers.values()];
    this.#pendingRedirectReceivers.clear();
    const activeFlow = this.#activeConnectFlow;
    if (activeFlow) {
      activeFlow.releaseAfterCleanup = true;
      this.#settleConnectFlow(activeFlow, "closed");
      // Configuration replacement already invalidated the active generation;
      // detach a stale tab-opening tail so the privileged mutation can finish.
      this.#connectLifecycleQueue = Promise.resolve();
    }
    await Promise.all([
      ...pendingReceivers.map((receiver) => receiver.dispose()),
      ...(activeFlow ? [activeFlow.redirectReceiver.dispose()] : []),
    ]);
    await this.#withConnectLifecycleLock(async () => {
      const currentFlow = this.#activeConnectFlow;
      if (!currentFlow) return;
      currentFlow.releaseAfterCleanup = true;
      this.#settleConnectFlow(currentFlow, "closed");
      const cleanup = this.#attemptConnectCleanup(currentFlow);
      await Promise.all([currentFlow.redirectReceiver.dispose(), cleanup]);
      this.#releaseConnectFlow(currentFlow);
    });
  }

  #attemptConnectCleanup(flow: ActiveConnectFlow): Promise<void> {
    if (flow.cleanupPromise) return flow.cleanupPromise;
    if (flow.cleanupTimer) {
      clearTimeout(flow.cleanupTimer);
      flow.cleanupTimer = null;
    }
    if (flow.tabIds.size === 0) {
      this.#releaseConnectFlow(flow);
      return Promise.resolve();
    }

    const cleanup = this.#closeConnectTabs(flow).then(
      () => undefined,
      (error: unknown) => {
        this.#scheduleConnectCleanupRetry(flow);
        throw error;
      },
    );
    flow.cleanupPromise = cleanup;
    void cleanup
      .finally(() => {
        if (flow.cleanupPromise === cleanup) flow.cleanupPromise = null;
        this.#releaseConnectFlow(flow);
      })
      .catch(() => undefined);
    return cleanup;
  }

  #scheduleConnectCleanupRetry(flow: ActiveConnectFlow): void {
    if (flow.cleanupTimer || flow.tabIds.size === 0) return;
    flow.cleanupTimer = setTimeout(() => {
      flow.cleanupTimer = null;
      void this.#attemptConnectCleanup(flow).catch(() => undefined);
    }, CONNECT_CLEANUP_RETRY_MS);
    flow.cleanupTimer.unref?.();
  }

  async #closeConnectTabs(flow: ActiveConnectFlow): Promise<void> {
    let failed = false;
    for (const tabId of [...flow.tabIds].reverse()) {
      try {
        await this.#options.closeConnectTab(tabId);
        flow.tabIds.delete(tabId);
      } catch {
        failed = true;
      }
    }
    if (failed) {
      throw new Error("Unable to close Pipedream Connect.");
    }
  }

  #withConnectLifecycleLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#connectLifecycleQueue.then(operation, operation);
    this.#connectLifecycleQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #withPersonalMcpOauthLifecycleLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#personalMcpOauthLifecycleQueue.then(operation, operation);
    this.#personalMcpOauthLifecycleQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

async function createPipedreamConnectRedirectReceiver(
  onTerminal: (state: "succeeded" | "failed") => void,
): Promise<PipedreamConnectRedirectReceiver> {
  const successPath = `/success/${randomBytes(32).toString("hex")}`;
  const errorPath = `/error/${randomBytes(32).toString("hex")}`;
  let terminalState: "succeeded" | "failed" | null = null;
  let disposePromise: Promise<void> | null = null;
  const sockets = new Set<Socket>();
  const responseSockets = new Set<Socket>();

  const server: Server = createServer((request, response) => {
    const socket = request.socket;
    responseSockets.add(socket);
    const releaseResponseSocket = (): void => {
      responseSockets.delete(socket);
      if (disposePromise && !socket.destroyed) socket.destroy();
    };
    response.once("finish", releaseResponseSocket);
    response.once("close", releaseResponseSocket);
    response.setHeader("cache-control", "no-store");
    response.setHeader("connection", "close");
    response.setHeader("content-type", "text/plain; charset=utf-8");
    response.setHeader("x-content-type-options", "nosniff");

    const address = server.address();
    const expectedHost =
      address && typeof address !== "string" ? `127.0.0.1:${address.port}` : undefined;
    const hasTrustedHost = expectedHost !== undefined && request.headers.host === expectedHost;
    // The current Connect redirect has no correlated account identity. Match
    // only the unguessable path capability and deliberately ignore all query
    // values so none can be projected as authorization for a refreshed account.
    const pathname = request.url?.split("?", 1)[0] ?? "";
    const matchedState =
      pathname === successPath ? "succeeded" : pathname === errorPath ? "failed" : null;
    if (!hasTrustedHost) response.statusCode = 404;
    else if (request.method !== "GET") response.statusCode = 405;
    else if (!matchedState) response.statusCode = 404;
    else response.statusCode = 200;
    response.end(CONNECT_REDIRECT_RESPONSE);

    if (hasTrustedHost && request.method === "GET" && matchedState && !terminalState) {
      terminalState = matchedState;
      void dispose();
      onTerminal(matchedState);
    }
  });

  const dispose = (): Promise<void> => {
    if (disposePromise) return disposePromise;
    disposePromise = new Promise<void>((resolve) => {
      if (!server.listening) {
        for (const socket of sockets) socket.destroy();
        resolve();
        return;
      }
      try {
        server.close(() => resolve());
        for (const socket of sockets) {
          if (!responseSockets.has(socket)) socket.destroy();
        }
      } catch {
        for (const socket of sockets) socket.destroy();
        resolve();
      }
    });
    return disposePromise;
  };

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  }).catch(async () => {
    await dispose();
    throw new Error("Unable to start Pipedream Connect.");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
      responseSockets.delete(socket);
    });
  });
  server.on("error", () => undefined);
  server.unref();

  const address = server.address();
  if (!address || typeof address === "string") {
    await dispose();
    throw new Error("Unable to start Pipedream Connect.");
  }
  const { port } = address as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    successRedirectUrl: `${origin}${successPath}`,
    errorRedirectUrl: `${origin}${errorPath}`,
    dispose,
  };
}

function requireMainOwnedSensitiveTabId(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new Error("Unable to open Pipedream Connect.");
  }
  return value;
}

function requireTrustedPipedreamConnectUrl(value: string): string {
  try {
    const url = new URL(value);
    const trustedHost = url.hostname === "pipedream.com" || url.hostname.endsWith(".pipedream.com");
    if (url.protocol !== "https:" || !trustedHost || !url.searchParams.has("app"))
      throw new Error();
    return url.toString();
  } catch {
    throw new Error("Pipedream returned an invalid Connect Link.");
  }
}

function requireSecurePersonalMcpOauthUrl(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.hostname === ""
    ) {
      throw new Error();
    }
    return url.toString();
  } catch {
    throw new Error("Pipedream returned an invalid authorization URL.");
  }
}
