import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { spawn } from "node-pty";
import type { McpThreadIdentity } from "@/shared/browserMcpThread";
import {
  MAX_BROWSER_EVIDENCE_ACTIONS_PER_TURN,
  MAX_BROWSER_EVIDENCE_THREADS,
  Y_SPACE_BROWSER_EVIDENCE_SOURCE,
  browserEvidenceActionKind,
  type BrowserMcpToolCallReport,
} from "@/shared/browserMcpEvidence";
import {
  type ClearPendingSteerPayload,
  type ControlThreadGoalPayload,
  type AgentEventEnvelope,
  type AgentKind,
  type CloseThreadPayload,
  type PromptSegment,
  type ProjectLocation,
  type ResizeTerminalPayload,
  type ReloadAgentMcpServersPayload,
  type ResolveThreadServerRequestPayload,
  type RollbackThreadConversationPayload,
  type SendThreadInputPayload,
  type SetPendingSteerPayload,
  type StageThreadInputPayload,
  type StartShellPayload,
  type StartThreadPayload,
  type StartThreadResult,
  type TerminalSize,
  type TerminalShellSnapshot,
  type ThreadConfig,
  type ThreadRuntimeSnapshot,
  type WriteTerminalPayload,
  type RuntimeEvent,
  type ToolCallPayload,
  type McpLaunchSnapshot,
  type PipedreamAgentReloadOutcome,
  type ResolvedMcpServer,
  disabledBuiltInMcpServerIds,
  mergeMcpServers,
  resolveEnabledMcpServers,
} from "@/shared/contracts";
import type { ResolveMcpCallerIdentityPayload } from "@/shared/ipc/procedures/thread";
import { applyHomeScopePermissions } from "@/shared/agents/unrestrictedPermissions";
import { TranscriptBuffer } from "@/shared/transcriptBuffer";
import {
  type AgentAdapter,
  type AgentNativePlugin,
  type StructuredSessionHandle,
  createKnownSessionRef,
  defaultFormatPromptSegments,
  getRefreshedWindowsPath,
  primeProjectShellEnv,
  resolveLaunchSpec,
} from "../agents/base";
import { ensureNodePtySpawnHelperExecutable } from "../nodePty";
import { BufferedLogWriter } from "./bufferedLogWriter";
import type { QueuedStructuredTurn, SessionRuntime, ShellSessionRuntime } from "./sessionTypes";
import { ThreadOutputPipeline, resolveThreadStatusSource } from "./threadOutputPipeline";
import { rewriteSegmentsForWorkspace, rewriteSegmentsForWsl } from "./threadAttachments";

import {
  isInterruptibleBusyStatus,
  isUserInterruptKeystroke,
  USER_INTERRUPT_RECOVERY_GRACE_MS,
} from "./threadSession/userInterrupt";
import { writeSubmittedPrompt } from "./threadSession/promptWrite";
import { resolveTerminalColorEnv } from "./threadSession/terminalEnv";
import { requireSessionPty, shouldPrimeNativeProjectShellEnv } from "./threadSession/helpers";
import { RuntimeEventRouter } from "./threadSession/runtimeEventRouter";
import { SessionRuntimeLifecycle } from "./threadSession/sessionRuntimeLifecycle";
import type { ThreadSessionManagerOptions } from "./threadSession/managerOptions";
import { PtyLifecycle } from "./threadSession/ptyLifecycle";
import { describeSpawnFailure, sanitizedProcessEnv } from "./threadSession/spawnDiagnostics";
import { CliHookSessionCoordinator } from "./threadSession/cliHookPlugin";
import { InvalidSessionRecoveryCoordinator } from "./threadSession/invalidSessionRecovery";
import { StructuredInterruptWatchdog } from "./threadSession/structuredInterruptWatchdog";
import { SteerCoordinator, clearPendingSteerSlot } from "./threadSession/steerCoordinator";
import { buildShellCommand } from "./threadSession/shellCommand";
import {
  type McpLaunchAuthorization,
  type McpLaunchIdentity,
  McpLaunchConfigurationChangedError,
  SpawnPipeline,
  isPersonalPipedreamMcpServer,
  stripResolvedAuthorizationHeader,
  workspaceLaunchConfig,
  type SpawnThreadInput,
} from "./threadSession/spawnPipeline";
import { StructuredTurnQueue } from "./threadSession/structuredTurnQueue";
import { StructuredFailureReporter } from "./threadSession/structuredFailureReporter";
import { readSupervisorSharedSettings } from "./supervisorSharedSettings";

export { isUserInterruptKeystroke, USER_INTERRUPT_RECOVERY_GRACE_MS, writeSubmittedPrompt };
export type { ThreadSessionManagerOptions };

/** Renderer-safe aggregate for applying a changed Pipedream grant to live agents. */
export type PipedreamMcpReloadOutcome = PipedreamAgentReloadOutcome;

interface PipedreamMcpReloadOptions {
  /** Personal OAuth clear is a revocation, so copied launch bearers cannot wait for turn end. */
  revokePersonalOauth?: boolean;
  /** Internal generation captured when the reload request is accepted. */
  personalMcpCredentialEpoch?: number;
  /** Supersedes detached or timed-out reload work, including non-Personal grants. */
  reloadEpoch?: number;
  /** Global launch-config revision captured for an accepted turn's restart. */
  mcpLaunchConfigurationEpoch?: number;
}

function mergePipedreamMcpReloadOutcome(
  current: PipedreamMcpReloadOutcome,
  incoming: PipedreamMcpReloadOutcome,
): PipedreamMcpReloadOutcome {
  if (current.state === "failed-pending" || incoming.state === "failed-pending") {
    return { state: "failed-pending" };
  }
  if (current.state === "restart-required" || incoming.state === "restart-required") {
    return { state: "restart-required" };
  }
  return { state: "applied" };
}

const RECENTLY_REMOVED_THREAD_LIMIT = 256;
const PERSONAL_MCP_REVOCATION_TEARDOWN_TIMEOUT_MS = 250;
const PERSONAL_MCP_REVOCATION_RELOAD_TIMEOUT_MS = 250;
const MCP_LIVE_UPDATE_TIMEOUT_MS = 250;
const MCP_RELOAD_OPERATION_TIMEOUT_MS = 30_000;

type RootMcpLaunchAuthority =
  | { phase: "pending"; authorization: McpLaunchAuthorization }
  | {
      phase: "active";
      authorization: McpLaunchAuthorization;
      sessionInstanceId: string;
    };

interface SubagentMcpLaunchAuthority {
  parentThreadId: string;
  parentSessionInstanceId: string;
  authorization: McpLaunchAuthorization;
}

interface SubagentMcpResolutionRequest {
  readonly token: symbol;
  readonly parentThreadId: string;
  readonly parentSessionInstanceId: string;
}

interface BrowserEvidenceTurnLedger {
  launchId: string;
  turnId: string;
  /** Canonical item ids, capped so a runaway page loop cannot grow this ledger. */
  actionItemIds: string[];
  /** First canonical negative marker, retained even when successes filled the cap. */
  failureItemId?: string;
}

interface PendingStartMcpSettings {
  agentKind: AgentKind;
  usesAgentSettings: boolean;
  snapshot: McpLaunchSnapshot;
}

interface McpReloadSessionOwnership {
  readonly token: symbol;
  readonly structuredSession: StructuredSessionHandle | undefined;
}

type AcceptedTurnReloadOutcome = "handled" | "superseded";

export class ThreadSessionManager {
  readonly sessions = new Map<string, SessionRuntime>();
  readonly shellSessions = new Map<string, ShellSessionRuntime>();
  /** Reverse index: agent-native session id → SessionRuntime, for CLI hook routing fallback. */
  readonly sessionsBySessionId = new Map<string, SessionRuntime>();
  private readonly startLocks = new Map<string, Promise<void>>();
  /** Launch inputs captured before async preparation reaches MCP authority registration. */
  private readonly pendingStartMcpSettings = new Map<string, PendingStartMcpSettings>();
  /** Settings-removal cancellation that must also gate pre-authority launch work. */
  private readonly removedPersonalPendingStarts = new Set<string>();
  /** Exact threads whose latest desired user/project settings include Personal Pipedream. */
  private readonly agentSettingsPersonalMcpThreads = new Set<string>();
  /** Provider settings revision; older async resolutions must never publish after a newer save. */
  private readonly agentMcpSettingsReloadEpochs = new Map<AgentKind, number>();
  private readonly pendingStartInterrupts = new Set<string>();
  private readonly pendingStartAborts = new Set<string>();
  private readonly ptyLifecycle = new PtyLifecycle();
  private readonly logWriter = new BufferedLogWriter();
  private readonly outputPipeline: ThreadOutputPipeline;
  private readonly runtimeEventRouter: RuntimeEventRouter;
  private readonly steerCoordinator: SteerCoordinator;
  private readonly structuredInterruptWatchdog: StructuredInterruptWatchdog;
  private readonly cliHookPlugin: CliHookSessionCoordinator;
  private readonly spawnPipeline: SpawnPipeline;
  private readonly invalidSessionRecovery: InvalidSessionRecoveryCoordinator;
  private readonly structuredTurnQueue: StructuredTurnQueue;
  private readonly structuredFailureReporter = new StructuredFailureReporter();
  private readonly recentlyRemovedThreadIds = new Set<string>();
  /** Canonical authority for root provider launches, including startup. */
  private readonly rootMcpLaunchAuthorities = new Map<string, RootMcpLaunchAuthority>();
  /** Ephemeral structured-child authority, tied to the exact live parent. */
  private readonly subagentMcpLaunchAuthorities = new Map<string, SubagentMcpLaunchAuthority>();
  /** Latest same-id child resolution, retained across an epoch-safe retry rebuild. */
  private readonly subagentMcpResolutionRequests = new Map<string, SubagentMcpResolutionRequest>();
  /** App-owned proof for only the latest accepted user turn of each live task. */
  private readonly browserEvidenceTurns = new Map<string, BrowserEvidenceTurnLedger>();
  /** Orders all live MCP mutations so an older resolution can never apply last. */
  private mcpReloadQueue: Promise<void> = Promise.resolve();
  /** Invalidates launch work that captured Personal credentials before clear. */
  private personalMcpCredentialEpoch = 0;
  /** Invalidates any detached Pipedream reload after a queue timeout or newer request. */
  private pipedreamMcpReloadEpoch = 0;
  /** Invalidates provider creation whenever any launch-visible MCP source changes. */
  private mcpLaunchConfigurationEpoch = 0;
  /** Deduplicates immediate security teardown with the queued replacement. */
  private readonly personalOauthRevocationStops = new WeakMap<SessionRuntime, Promise<void>>();
  /** One provider restart at a time for each GUI session without live MCP updates. */
  private readonly pipedreamMcpRestarts = new WeakMap<
    SessionRuntime,
    Promise<PipedreamMcpReloadOutcome>
  >();
  /** Provider handles currently mutating MCP state; clear retires these before queue detachment. */
  private readonly liveMcpUpdateSessions = new Set<SessionRuntime>();
  /** Latest cross-source reload operation that owns each exact provider handle. */
  private readonly mcpReloadSessionOwners = new WeakMap<
    SessionRuntime,
    McpReloadSessionOwnership
  >();
  private disposed = false;

  constructor(private readonly options: ThreadSessionManagerOptions) {
    this.runtimeEventRouter = new RuntimeEventRouter(options.emit);
    this.outputPipeline = new ThreadOutputPipeline({
      emit: options.emit,
      isDev: options.isDev,
      logWriter: this.logWriter,
      resolveLogPath: (threadId) => this.resolveLogPath(threadId),
      resolveHintLogPath: (threadId) => this.resolveHintLogPath(threadId),
      readDisableCliHookPlugin: this.options.readDisableCliHookPlugin,
      onRecoverInvalidSessionRef: (session) => this.recoverInvalidSessionRef(session),
      onStartQueuedLaunchPrompt: (session) =>
        this.structuredTurnQueue.startQueuedLaunchPrompt(session),
      onStartSessionRefDiscovery: (session) => this.pollSessionRefDiscovery(session),
    });
    // Construct the watchdog first: it drains the pending-steer slot via the
    // free `clearPendingSteerSlot` (no back-reference to SteerCoordinator), so
    // SteerCoordinator can then take the concrete watchdog instance without a
    // mutual lazy dependency or construction-order fragility.
    this.structuredInterruptWatchdog = new StructuredInterruptWatchdog({
      sessions: this.sessions,
      isDisposed: () => this.disposed,
      completeForcedInterrupt: (session) => this.completeForcedStructuredInterrupt(session),
    });
    this.structuredTurnQueue = new StructuredTurnQueue({
      emit: options.emit,
      sessions: this.sessions,
      beginFailureEpisode: (session) => this.structuredFailureReporter.beginEpisode(session),
      failStructuredSession: (session, error) => this.failStructuredSession(session, error),
    });
    this.steerCoordinator = new SteerCoordinator({
      emit: options.emit,
      sessions: this.sessions,
      interruptStructuredTurn: (session) =>
        this.structuredInterruptWatchdog.interruptStructuredTurn(session),
      beginBrowserEvidenceTurn: (session) => this.beginBrowserEvidenceTurnForSession(session),
      startStructuredTurn: (session, turn) => this.startStructuredTurn(session, turn),
      failStructuredSession: (session, error) => this.failStructuredSession(session, error),
      resolveSkillTurnInjection: (session, segments) =>
        this.resolveSkillTurnInjection(session, segments),
    });
    this.cliHookPlugin = new CliHookSessionCoordinator({
      sessions: this.sessions,
      sessionsBySessionId: this.sessionsBySessionId,
      options: this.options,
      outputPipeline: this.outputPipeline,
      indexSessionRef: (session, prevId) => this.indexSessionRef(session, prevId),
    });
    const sessionRuntimeLifecycle = new SessionRuntimeLifecycle({
      sessions: this.sessions,
      sessionsBySessionId: this.sessionsBySessionId,
      ptyLifecycle: this.ptyLifecycle,
      outputPipeline: this.outputPipeline,
      runtimeEventRouter: this.runtimeEventRouter,
      steerCoordinator: this.steerCoordinator,
      structuredInterruptWatchdog: this.structuredInterruptWatchdog,
      emit: this.options.emit,
      isCurrentSession: (session) => this.isCurrentSession(session),
      failStructuredSession: (session, error) => this.failStructuredSession(session, error),
      indexSessionRef: (session, prevId) => this.indexSessionRef(session, prevId),
      pollSessionRefDiscovery: (session) => this.pollSessionRefDiscovery(session),
      releaseExitedMcpLaunch: (session) => this.releaseExitedMcpLaunch(session),
    });
    this.spawnPipeline = new SpawnPipeline({
      options: this.options,
      sessions: this.sessions,
      pendingStartInterrupts: this.pendingStartInterrupts,
      pendingStartAborts: this.pendingStartAborts,
      ptyLifecycle: this.ptyLifecycle,
      outputPipeline: this.outputPipeline,
      runtimeEventRouter: this.runtimeEventRouter,
      sessionRuntimeLifecycle,
      cliHookPlugin: this.cliHookPlugin,
      closeThread: (payload) => this.closeThread(payload),
      failStructuredSession: (session, error) => this.failStructuredSession(session, error),
      isCurrentSession: (session) => this.isCurrentSession(session),
      resolveAgentSettings: (adapter) => this.resolveAgentSettings(adapter),
      beginMcpLaunchAuthorization: (authorization) =>
        this.beginMcpLaunchAuthorization(authorization),
      activateMcpLaunchAuthorization: (session) => this.activateMcpLaunchAuthorization(session),
      assertMcpLaunchAuthorizationCurrent: (identity) =>
        this.assertMcpLaunchAuthorizationCurrent(identity),
      getPersonalMcpCredentialEpoch: () => this.personalMcpCredentialEpoch,
      getMcpLaunchConfigurationEpoch: () => this.mcpLaunchConfigurationEpoch,
      refreshPendingMcpLaunchSnapshot: (input) => this.refreshPendingMcpLaunchSnapshot(input),
      revokeMcpLaunchAuthorization: (identity) => this.revokeMcpLaunchAuthorization(identity),
      emitOptimisticUserMessage: (threadId, prompt, segments, requestedItemId) =>
        this.structuredTurnQueue.emitOptimisticUserMessage(
          threadId,
          prompt,
          segments,
          requestedItemId,
        ),
    });
    this.invalidSessionRecovery = new InvalidSessionRecoveryCoordinator({
      spawnPipeline: this.spawnPipeline,
      cliHookPlugin: this.cliHookPlugin,
      outputPipeline: this.outputPipeline,
      ptyLifecycle: this.ptyLifecycle,
      isCurrentSession: (session) => this.isCurrentSession(session),
      failStructuredSession: (session, error) => this.failStructuredSession(session, error),
      beginMcpLaunchAuthorization: (authorization) =>
        this.beginMcpLaunchAuthorization(authorization),
      revokeMcpLaunchAuthorization: (identity) => this.revokeMcpLaunchAuthorization(identity),
      getPersonalMcpCredentialEpoch: () => this.personalMcpCredentialEpoch,
      getMcpLaunchConfigurationEpoch: () => this.mcpLaunchConfigurationEpoch,
      settleAfterStructuredDispose: () => sleep(150),
      primeProjectShellEnv,
      resolveLaunchSpec,
    });
  }

  /**
   * Resolve a provider-native root or child session to its live Poracode
   * thread. Root ids use the reverse index; provider-owned child sessions can
   * opt into the fallback through `ownsProviderSession`.
   */
  getThreadIdByProviderSessionId(providerSessionId: string): string | undefined {
    return this.getMcpIdentityByProviderSessionId(providerSessionId)?.threadId;
  }

  /**
   * Resolve a trusted provider-native session id to the identity of its live
   * Poracode thread. Stale reverse-index entries fail closed rather than
   * preserving access after their runtime has been replaced or removed.
   */
  getMcpIdentityByProviderSessionId(
    providerSessionId: string,
    serverId?: "browser" | "computer-use" | "app-controls",
  ): McpThreadIdentity | undefined {
    const session = this.getSessionByProviderSessionId(providerSessionId);
    return session ? this.identityForBuiltInServer(session, serverId) : undefined;
  }

  /**
   * Revalidate an ingress launch capability against live session state. Signed
   * token metadata selects a thread/binding, but this method is authoritative
   * for liveness, current global/provider opt-outs, and disabled-tool policy.
   */
  resolveMcpCallerIdentity(
    payload: ResolveMcpCallerIdentityPayload,
  ): McpThreadIdentity | undefined {
    const rootAuthority = this.rootMcpLaunchAuthorities.get(payload.threadId);
    if (rootAuthority) {
      if (!this.isExactMcpLaunch(rootAuthority.authorization.identity, payload.launchId)) {
        return undefined;
      }
      if (rootAuthority.phase === "active") {
        const session = this.sessions.get(payload.threadId);
        if (
          !session ||
          !this.isCurrentSession(session) ||
          session.instanceId !== rootAuthority.sessionInstanceId
        ) {
          return undefined;
        }
      }
      return this.liveIdentityForMcpAuthorization(rootAuthority.authorization, payload.serverId);
    }

    const childAuthority = this.subagentMcpLaunchAuthorities.get(payload.threadId);
    if (
      !childAuthority ||
      !this.isExactMcpLaunch(childAuthority.authorization.identity, payload.launchId)
    ) {
      return undefined;
    }
    const pendingChildResolution = this.subagentMcpResolutionRequests.get(payload.threadId);
    if (
      pendingChildResolution?.parentThreadId === childAuthority.parentThreadId &&
      pendingChildResolution.parentSessionInstanceId === childAuthority.parentSessionInstanceId
    ) {
      // No child provider exists until resolution returns. This also makes a
      // security-revoked attempt unusable while its exact record is retained
      // solely to arbitrate one current-state retry.
      return undefined;
    }
    const parent = this.sessions.get(childAuthority.parentThreadId);
    if (
      !parent ||
      !this.isCurrentSession(parent) ||
      parent.instanceId !== childAuthority.parentSessionInstanceId ||
      parent.ignoreExit === true
    ) {
      return undefined;
    }
    return this.liveIdentityForMcpAuthorization(childAuthority.authorization, payload.serverId);
  }

  /**
   * Accept one private main-process Browser outcome only when its signed launch
   * and supervisor-issued turn nonce are both still current. Substantive
   * failures become privacy-bounded negative evidence; delayed callbacks,
   * closed tasks, and prior launches produce no canonical row.
   */
  recordBrowserMcpToolCall(payload: BrowserMcpToolCallReport): boolean {
    // Connection/control and tab-directory calls prove only that the MCP is
    // reachable. Require a real page navigation, inspection, or interaction
    // before minting an outcome used by the final-response badge.
    if (!browserEvidenceActionKind(payload.toolName)) return false;
    const liveIdentity = this.resolveMcpCallerIdentity({
      routing: "thread",
      threadId: payload.threadId,
      launchId: payload.launchId,
      serverId: "browser",
    });
    if (!liveIdentity || liveIdentity.browserEvidenceTurnId !== payload.turnId) return false;

    const childAuthority = this.subagentMcpLaunchAuthorities.get(payload.threadId);
    const ownerThreadId = childAuthority?.parentThreadId ?? payload.threadId;
    const ledger = this.browserEvidenceTurns.get(ownerThreadId);
    if (!ledger || ledger.turnId !== payload.turnId) return false;
    if (!childAuthority && ledger.launchId !== payload.launchId) return false;
    if (ledger.actionItemIds.length >= MAX_BROWSER_EVIDENCE_ACTIONS_PER_TURN) {
      // Reserve at most one extra bounded row so a late failure can never be
      // hidden by a turn that already filled the successful evidence cap.
      if (payload.success || ledger.failureItemId) return false;
    }

    const itemId = `browser-evidence-${randomUUID()}`;
    const browserEvidence: NonNullable<ToolCallPayload["browserEvidence"]> = {
      source: Y_SPACE_BROWSER_EVIDENCE_SOURCE,
      occurredAt: payload.occurredAt,
      // A failed/ambiguous result proves only that an authenticated Browser
      // action failed. Never persist result-derived tab or page metadata on it.
      ...(payload.success && payload.tabId ? { tabId: payload.tabId } : {}),
      ...(payload.success && payload.url ? { url: payload.url } : {}),
      ...(payload.success && payload.title ? { title: payload.title } : {}),
    };
    const toolPayload: ToolCallPayload = {
      name: payload.toolName,
      serverId: "browser",
      status: payload.success ? "success" : "error",
      browserEvidence,
    };
    ledger.actionItemIds.push(itemId);
    if (!payload.success) ledger.failureItemId ??= itemId;
    this.enqueueRuntimeEvent(ownerThreadId, {
      type: "item.started",
      threadId: ownerThreadId,
      itemId,
      itemType: "mcp_tool_call",
      payload: toolPayload,
    });
    this.enqueueRuntimeEvent(ownerThreadId, {
      type: "item.completed",
      threadId: ownerThreadId,
      itemId,
      payload: toolPayload,
    });
    // Make the canonical proof observable before the private IPC reply lets
    // the Browser MCP response return to the agent.
    this.runtimeEventRouter.flush();
    return true;
  }

  private isExactMcpLaunch(identity: McpThreadIdentity, launchId: string | undefined): boolean {
    return identity.launchId !== undefined && identity.launchId === launchId;
  }

  private beginMcpLaunchAuthorization(authorization: McpLaunchAuthorization): void {
    if (this.removedPersonalPendingStarts.has(authorization.identity.threadId)) {
      throw new Error("MCP launch authorization was revoked after agent settings changed.");
    }
    const credentialEpoch =
      authorization.personalMcpCredentialEpoch ?? this.personalMcpCredentialEpoch;
    if (credentialEpoch !== this.personalMcpCredentialEpoch) {
      throw new Error("MCP launch authorization was revoked before launch.");
    }
    const configurationEpoch =
      authorization.mcpLaunchConfigurationEpoch ?? this.mcpLaunchConfigurationEpoch;
    if (configurationEpoch !== this.mcpLaunchConfigurationEpoch) {
      throw new McpLaunchConfigurationChangedError();
    }
    const currentAuthorization: McpLaunchAuthorization = {
      ...authorization,
      personalMcpCredentialEpoch: credentialEpoch,
      mcpLaunchConfigurationEpoch: configurationEpoch,
    };
    // Pipedream relays carry their own launch bearer, so rotate those alongside
    // the built-in capability nonce before a restart/recovery can begin.
    this.options.releasePipedreamMcpBindings?.(currentAuthorization.identity.threadId);
    this.revokeSubagentMcpAccessForParent(currentAuthorization.identity.threadId);
    const turnId = currentAuthorization.identity.browserEvidenceTurnId ?? randomUUID();
    currentAuthorization.identity.browserEvidenceTurnId = turnId;
    this.setBrowserEvidenceTurn(
      currentAuthorization.identity.threadId,
      currentAuthorization.identity.launchId,
      turnId,
    );
    this.rootMcpLaunchAuthorities.set(currentAuthorization.identity.threadId, {
      phase: "pending",
      authorization: currentAuthorization,
    });
  }

  private assertMcpLaunchAuthorizationCurrent(identity: McpLaunchIdentity): void {
    const current = this.rootMcpLaunchAuthorities.get(identity.threadId);
    if (
      current?.phase === "pending" &&
      current.authorization.identity.launchId === identity.launchId &&
      current.authorization.personalMcpCredentialEpoch === this.personalMcpCredentialEpoch
    ) {
      if (current.authorization.mcpLaunchConfigurationEpoch !== this.mcpLaunchConfigurationEpoch) {
        throw new McpLaunchConfigurationChangedError();
      }
      return;
    }
    throw new Error("MCP launch authorization was revoked before process creation.");
  }

  private activateMcpLaunchAuthorization(session: SessionRuntime): void {
    const identity = session.mcpIdentity;
    if (!identity?.threadId || !identity.launchId) return;
    const current = this.rootMcpLaunchAuthorities.get(identity.threadId);
    if (
      current?.phase === "pending" &&
      current.authorization.identity.launchId === identity.launchId &&
      current.authorization.personalMcpCredentialEpoch === this.personalMcpCredentialEpoch &&
      current.authorization.mcpLaunchConfigurationEpoch !== this.mcpLaunchConfigurationEpoch
    ) {
      throw new McpLaunchConfigurationChangedError();
    }
    if (
      !current ||
      current.phase !== "pending" ||
      current.authorization.identity.launchId !== identity.launchId ||
      current.authorization.personalMcpCredentialEpoch !== this.personalMcpCredentialEpoch ||
      current.authorization.mcpLaunchConfigurationEpoch !== this.mcpLaunchConfigurationEpoch
    ) {
      throw new Error("MCP launch authorization was revoked before runtime publication.");
    }
    this.rootMcpLaunchAuthorities.set(identity.threadId, {
      phase: "active",
      authorization: {
        ...current.authorization,
        identity: identity as McpLaunchIdentity,
        config: session.config,
        launchConfig: session.launchConfig ?? current.authorization.launchConfig,
        mcpLaunchSnapshot: session.mcpLaunchSnapshot,
        mcpLaunchConfigurationEpoch: this.mcpLaunchConfigurationEpoch,
      },
      sessionInstanceId: session.instanceId,
    });
  }

  private refreshActiveMcpLaunchAuthorization(session: SessionRuntime): void {
    const identity = session.mcpIdentity;
    if (!identity?.threadId || !identity.launchId) return;
    const current = this.rootMcpLaunchAuthorities.get(identity.threadId);
    if (
      !current ||
      current.phase !== "active" ||
      current.sessionInstanceId !== session.instanceId ||
      current.authorization.identity.launchId !== identity.launchId
    ) {
      return;
    }
    this.rootMcpLaunchAuthorities.set(identity.threadId, {
      ...current,
      authorization: {
        ...current.authorization,
        identity: identity as McpLaunchIdentity,
        config: session.config,
        launchConfig: session.launchConfig ?? current.authorization.launchConfig,
        mcpLaunchSnapshot: session.mcpLaunchSnapshot,
        mcpLaunchConfigurationEpoch: this.mcpLaunchConfigurationEpoch,
      },
    });
  }

  private restoreActiveMcpLaunchAuthorization(
    session: SessionRuntime,
    personalMcpCredentialEpoch: number,
  ): void {
    const identity = session.mcpIdentity;
    if (
      !identity?.threadId ||
      !identity.launchId ||
      !this.isCurrentSession(session) ||
      session.ignoreExit === true ||
      personalMcpCredentialEpoch !== this.personalMcpCredentialEpoch
    ) {
      return;
    }
    this.rootMcpLaunchAuthorities.set(identity.threadId, {
      phase: "active",
      authorization: {
        identity: identity as McpLaunchIdentity,
        adapter: session.adapter,
        config: session.config,
        launchConfig: session.launchConfig ?? session.config,
        mcpLaunchSnapshot: session.mcpLaunchSnapshot,
        personalMcpCredentialEpoch,
        mcpLaunchConfigurationEpoch: this.mcpLaunchConfigurationEpoch,
      },
      sessionInstanceId: session.instanceId,
    });
  }

  private revokeMcpLaunchAuthorization(identity: McpLaunchIdentity): void {
    const current = this.rootMcpLaunchAuthorities.get(identity.threadId);
    if (
      current?.phase === "pending" &&
      current.authorization.identity.launchId === identity.launchId
    ) {
      this.rootMcpLaunchAuthorities.delete(identity.threadId);
      this.clearBrowserEvidenceTurn(identity.threadId, identity.launchId);
      this.releasePipedreamMcpIdentityBindingsBestEffort(identity);
      return;
    }
    if (
      current?.phase === "active" &&
      current.authorization.identity.launchId === identity.launchId
    ) {
      return;
    }
    // Always revoke the exact launch scope. A newer same-thread authority may
    // already be current, so stale unwind must never fall back to deleting it.
    this.releasePipedreamMcpIdentityBindingsBestEffort(identity);
  }

  private revokeMcpAccessForThread(threadId: string): void {
    this.rootMcpLaunchAuthorities.delete(threadId);
    this.browserEvidenceTurns.delete(threadId);
    this.revokeSubagentMcpAccessForParent(threadId);
  }

  /** Revoke relay authority only when the exact active runtime has ended. */
  private releaseExitedMcpLaunch(session: SessionRuntime): void {
    const identity = session.mcpIdentity;
    if (!identity?.launchId) return;
    const current = this.rootMcpLaunchAuthorities.get(session.threadId);
    if (
      current?.phase !== "active" ||
      current.sessionInstanceId !== session.instanceId ||
      current.authorization.identity.launchId !== identity.launchId
    ) {
      this.releasePipedreamMcpIdentityBindingsBestEffort(identity);
      return;
    }
    this.options.releasePipedreamMcpBindings?.(session.threadId);
    this.revokeMcpAccessForThread(session.threadId);
  }

  private revokeSubagentMcpAccessForParent(parentThreadId: string): void {
    for (const [childThreadId, authority] of this.subagentMcpLaunchAuthorities) {
      if (authority.parentThreadId === parentThreadId) {
        this.subagentMcpLaunchAuthorities.delete(childThreadId);
        this.options.releasePipedreamMcpBindings?.(childThreadId);
      }
    }
    for (const [childThreadId, request] of this.subagentMcpResolutionRequests) {
      if (request.parentThreadId === parentThreadId) {
        this.subagentMcpResolutionRequests.delete(childThreadId);
      }
    }
  }

  private beginBrowserEvidenceTurnForSession(session: SessionRuntime): string | undefined {
    const identity = session.mcpIdentity;
    if (!identity?.launchId) return undefined;
    const turnId = randomUUID();
    identity.browserEvidenceTurnId = turnId;
    const authority = this.rootMcpLaunchAuthorities.get(session.threadId);
    if (authority && authority.authorization.identity.launchId === identity.launchId) {
      authority.authorization.identity.browserEvidenceTurnId = turnId;
    }
    // Native non-interrupting steers intentionally preserve structured
    // subagents. Rotate those live child authorities with the parent so their
    // Browser actions remain attributable to the newly accepted user turn;
    // children from a replaced parent instance stay stale and fail closed.
    for (const childAuthority of this.subagentMcpLaunchAuthorities.values()) {
      if (
        childAuthority.parentThreadId === session.threadId &&
        childAuthority.parentSessionInstanceId === session.instanceId
      ) {
        childAuthority.authorization.identity.browserEvidenceTurnId = turnId;
      }
    }
    this.setBrowserEvidenceTurn(session.threadId, identity.launchId, turnId);
    return turnId;
  }

  private setBrowserEvidenceTurn(threadId: string, launchId: string, turnId: string): void {
    this.browserEvidenceTurns.delete(threadId);
    while (this.browserEvidenceTurns.size >= MAX_BROWSER_EVIDENCE_THREADS) {
      const oldestThreadId = this.browserEvidenceTurns.keys().next().value;
      if (typeof oldestThreadId !== "string") break;
      this.browserEvidenceTurns.delete(oldestThreadId);
    }
    this.browserEvidenceTurns.set(threadId, { launchId, turnId, actionItemIds: [] });
  }

  private clearBrowserEvidenceTurn(threadId: string, launchId?: string): void {
    const ledger = this.browserEvidenceTurns.get(threadId);
    if (!ledger || (launchId && ledger.launchId !== launchId)) return;
    this.browserEvidenceTurns.delete(threadId);
  }

  private getSessionByProviderSessionId(providerSessionId: string): SessionRuntime | undefined {
    const indexed = this.sessionsBySessionId.get(providerSessionId);
    if (indexed) {
      if (
        this.isCurrentSession(indexed) &&
        indexed.adapter.capabilities.crossagentMcpRouting === "provider-session"
      ) {
        return indexed;
      }
      this.sessionsBySessionId.delete(providerSessionId);
    }

    for (const session of this.sessions.values()) {
      if (session.adapter.capabilities.crossagentMcpRouting !== "provider-session") continue;
      if (session.sessionRef?.providerSessionId === providerSessionId) {
        this.sessionsBySessionId.set(providerSessionId, session);
        return session;
      }
      if (session.structuredSession?.ownsProviderSession?.(providerSessionId)) {
        return session;
      }
    }
    return undefined;
  }

  private identityForBuiltInServer(
    session: SessionRuntime,
    serverId: "browser" | "computer-use" | "app-controls" | undefined,
  ): McpThreadIdentity {
    const identity = session.mcpIdentity ?? { threadId: session.threadId };
    if (!serverId) return identity;
    const disabledTools = session.mcpLaunchSnapshot.disabledBuiltInMcpTools?.[serverId] ?? [];
    if (disabledTools.length === 0) return identity;
    return {
      ...identity,
      disabledTools: [...new Set([...(identity.disabledTools ?? []), ...disabledTools])],
    };
  }

  private liveIdentityForMcpAuthorization(
    authorization: McpLaunchAuthorization,
    serverId: "browser" | "computer-use" | "app-controls",
  ): McpThreadIdentity | undefined {
    const settings = readSupervisorSharedSettings(this.options.settingsPath);
    const globallyDisabled = disabledBuiltInMcpServerIds(settings.disabledBuiltInMcpServers);
    if (
      globallyDisabled.includes(serverId) ||
      authorization.mcpLaunchSnapshot.disabledBuiltInMcpServerIds.includes(serverId)
    ) {
      return undefined;
    }
    const launchConfig =
      authorization.adapter.capabilities.mcpConfigSource === "agentSettings"
        ? this.spawnPipeline.resolveMcpLaunchConfig(
            authorization.config,
            {
              ...authorization.mcpLaunchSnapshot,
              disabledBuiltInMcpServerIds: globallyDisabled,
            },
            authorization.adapter,
            authorization.identity.threadId,
          )
        : authorization.launchConfig;
    // Match launch-time authorization exactly. An omitted Browser flag means
    // this session did not receive Browser, so a bearer minted for an earlier
    // incarnation of the same thread id must not become valid again.
    if (serverId === "browser" && launchConfig.browserMcp !== true) return undefined;
    if (serverId === "computer-use" && launchConfig.computerUse !== true) return undefined;

    const identity = authorization.identity;
    const disabledTools = [
      ...new Set([
        ...(identity.disabledTools ?? []),
        ...(authorization.mcpLaunchSnapshot.disabledBuiltInMcpTools?.[serverId] ?? []),
        ...(settings.disabledBuiltInMcpTools[serverId] ?? []),
      ]),
    ];
    return {
      ...identity,
      ...(serverId === "computer-use" &&
      launchConfig.browserMcp === true &&
      !globallyDisabled.includes("browser") &&
      !authorization.mcpLaunchSnapshot.disabledBuiltInMcpServerIds.includes("browser")
        ? { managedBrowserConnected: true }
        : {}),
      ...(disabledTools.length > 0 ? { disabledTools } : {}),
    };
  }

  getThreadSnapshots(): ThreadRuntimeSnapshot[] {
    return [...this.sessions.values()].map((session) => ({
      threadId: session.threadId,
      status: session.status,
      attention: session.attention,
      config: session.config,
      ...(session.launchConfig ? { launchConfig: session.launchConfig } : {}),
      ...(session.sessionRef ? { sessionRef: session.sessionRef } : {}),
      ...(session.slashCommands ? { slashCommands: session.slashCommands } : {}),
      canResumeWithConfig: session.canResumeWithConfig,
      threadStatusSource: resolveThreadStatusSource(
        session,
        this.options.readDisableCliHookPlugin(),
      ),
    }));
  }

  getTerminalShellSnapshots(): TerminalShellSnapshot[] {
    return [...this.shellSessions.values()].map((session) => ({
      terminalId: session.shellId,
      projectLocation: session.projectLocation,
      ...(session.worktreePath ? { worktreePath: session.worktreePath } : {}),
      outputLength: session.outputLength,
    }));
  }

  /**
   * Surface a structured-session failure on both axes: status (so the icon
   * goes red) and a runtime `error` event (so `ThreadErrorDock` and the chat
   * stream actually render the message). The supervisor stores `errorMessage`
   * on the thread state, but no renderer surface reads `thread.errorMessage`
   * — only the runtime error item drives `ThreadErrorDock` — so without the
   * event the user sees a red icon and nothing else.
   */
  private failStructuredSession(session: SessionRuntime, error: unknown): void {
    this.structuredFailureReporter.capture(session, error);
    const message = error instanceof Error ? error.message : String(error);
    this.outputPipeline.updateState(session, "error", "error", message);
    this.enqueueRuntimeEvent(session.threadId, {
      type: "error",
      threadId: session.threadId,
      message,
    });
  }

  private completeForcedStructuredInterrupt(session: SessionRuntime): void {
    this.runtimeEventRouter.flush();
    this.outputPipeline.updateState(session, "idle", "none", undefined, {
      forceCloseActiveTurn: true,
    });

    // A force-stopped explicit Stop stays idle until the user's next submit.
    // A force-stopped steer is different: the submitted message is still an
    // accepted user action and must survive the dead provider process. Paint
    // it before clearing the strip, then resume the session and send it with
    // the same item id so the replacement session cannot duplicate it.
    const pending = session.pendingSteer;
    if (!pending) return;
    const userMessageItemId = this.structuredTurnQueue.emitOptimisticUserMessage(
      session.threadId,
      pending.prompt,
      pending.segments,
      pending.userMessageItemId,
    );
    const turn: QueuedStructuredTurn = { ...pending, userMessageItemId };
    clearPendingSteerSlot(session, this.options.emit);
    void this.spawnPipeline.restartThread(session, turn).catch((error) => {
      if (!this.isCurrentSession(session)) return;
      this.failStructuredSession(session, error);
    });
  }

  private enqueueRuntimeEvent(threadId: string, event: RuntimeEvent): void {
    this.runtimeEventRouter.append(threadId, event);
  }

  /**
   * Subagent host hook: resolve a live parent thread's project location + config
   * so a spawned child can inherit them. Returns undefined once the thread is
   * gone. Consumed by {@link SubagentRunManager}.
   */
  getSubagentParentContext(threadId: string):
    | {
        projectLocation: ProjectLocation;
        config: ThreadConfig;
        mcpLaunchSnapshot: McpLaunchSnapshot;
      }
    | undefined {
    const session = this.sessions.get(threadId);
    if (!session || !this.isCurrentSession(session) || session.ignoreExit === true)
      return undefined;
    // Children inherit the effective launch config with built-in disables applied.
    const disabledIds = session.mcpLaunchSnapshot.disabledBuiltInMcpServerIds;
    const effectiveConfig = workspaceLaunchConfig(
      session.projectLocation,
      session.config,
      session.adapter,
      disabledIds,
      session.mcpLaunchSnapshot.pluginBuiltInMcpServerIds,
    );
    return {
      projectLocation: session.projectLocation,
      config: effectiveConfig,
      mcpLaunchSnapshot: session.mcpLaunchSnapshot,
    };
  }

  /** Resolve the parent's enabled MCP access for an ephemeral structured child. */
  async resolveSubagentParentMcpAccess(
    threadId: string,
    identity: McpThreadIdentity,
    targetAgentKind: AgentKind,
    childConfig: ThreadConfig,
  ): Promise<{ mcpServers?: ResolvedMcpServer[] }> {
    const targetAdapter = this.options.adapters.get(targetAgentKind);
    if (!targetAdapter || !identity.threadId) return {};
    const initialSession = this.sessions.get(threadId);
    if (
      !initialSession ||
      !this.isCurrentSession(initialSession) ||
      initialSession.ignoreExit === true
    ) {
      return {};
    }

    const childThreadId = identity.threadId;
    const resolutionRequest: SubagentMcpResolutionRequest = {
      token: Symbol("subagent-mcp-resolution"),
      parentThreadId: threadId,
      parentSessionInstanceId: initialSession.instanceId,
    };
    // Publish same-id ordering before the first await. A later request owns the
    // id immediately, including while this one is rebuilding after an epoch.
    this.subagentMcpResolutionRequests.set(childThreadId, resolutionRequest);

    const isRequestCurrent = (): boolean =>
      this.subagentMcpResolutionRequests.get(childThreadId)?.token === resolutionRequest.token;
    const finishRequest = (): void => {
      if (isRequestCurrent()) this.subagentMcpResolutionRequests.delete(childThreadId);
    };
    const readOriginalLiveParent = (): SessionRuntime | undefined => {
      const current = this.sessions.get(threadId);
      if (
        !current ||
        current.instanceId !== resolutionRequest.parentSessionInstanceId ||
        !this.isCurrentSession(current) ||
        current.ignoreExit === true
      ) {
        return undefined;
      }
      return current;
    };
    const beginAttempt = (
      session: SessionRuntime,
      mcpLaunchSnapshot: McpLaunchSnapshot,
      personalMcpCredentialEpoch: number,
      mcpLaunchConfigurationEpoch: number,
    ) => {
      const launchConfig = this.spawnPipeline.resolveMcpLaunchConfig(
        workspaceLaunchConfig(
          session.projectLocation,
          childConfig,
          targetAdapter,
          mcpLaunchSnapshot.disabledBuiltInMcpServerIds,
          mcpLaunchSnapshot.pluginBuiltInMcpServerIds,
        ),
        mcpLaunchSnapshot,
        targetAdapter,
        childThreadId,
      );
      const childIdentity: McpLaunchIdentity = {
        ...identity,
        threadId: childThreadId,
        launchId: randomUUID(),
        ...(this.browserEvidenceTurns.get(threadId)?.turnId
          ? { browserEvidenceTurnId: this.browserEvidenceTurns.get(threadId)!.turnId }
          : {}),
      };
      const authorization: McpLaunchAuthorization = {
        identity: childIdentity,
        adapter: targetAdapter,
        config: childConfig,
        launchConfig,
        mcpLaunchSnapshot,
        personalMcpCredentialEpoch,
        mcpLaunchConfigurationEpoch,
      };
      const previousChildAuthority = this.subagentMcpLaunchAuthorities.get(childThreadId);
      if (previousChildAuthority) {
        this.releasePipedreamMcpIdentityBindingsBestEffort(
          previousChildAuthority.authorization.identity,
        );
      }
      this.subagentMcpLaunchAuthorities.set(childThreadId, {
        parentThreadId: threadId,
        parentSessionInstanceId: session.instanceId,
        authorization,
      });
      return {
        session,
        mcpLaunchSnapshot,
        launchConfig,
        childIdentity,
        personalMcpCredentialEpoch,
        mcpLaunchConfigurationEpoch,
      };
    };

    let attempt: ReturnType<typeof beginAttempt>;
    try {
      attempt = beginAttempt(
        initialSession,
        initialSession.mcpLaunchSnapshot,
        this.personalMcpCredentialEpoch,
        this.mcpLaunchConfigurationEpoch,
      );
    } catch (error) {
      finishRequest();
      throw error;
    }
    for (let attemptIndex = 0; attemptIndex < 2; attemptIndex += 1) {
      let resolution:
        | { status: "resolved"; mcpServers: ResolvedMcpServer[] }
        | { status: "rejected"; error: unknown };
      try {
        resolution = {
          status: "resolved",
          mcpServers: await this.spawnPipeline.resolveMcpServersForLaunch({
            location: attempt.session.projectLocation,
            config: attempt.launchConfig,
            mcpLaunchSnapshot: attempt.mcpLaunchSnapshot,
            identity: attempt.childIdentity,
            adapter: targetAdapter,
            presentationMode: "gui",
          }),
        };
      } catch (error) {
        resolution = { status: "rejected", error };
      }

      const currentChildAuthority = this.subagentMcpLaunchAuthorities.get(childThreadId);
      const exactAuthorityIsCurrent =
        currentChildAuthority?.parentThreadId === threadId &&
        currentChildAuthority.parentSessionInstanceId === attempt.session.instanceId &&
        currentChildAuthority.authorization.identity.launchId === attempt.childIdentity.launchId;
      const epochCrossed =
        attempt.personalMcpCredentialEpoch !== this.personalMcpCredentialEpoch ||
        attempt.mcpLaunchConfigurationEpoch !== this.mcpLaunchConfigurationEpoch;
      const liveParent = readOriginalLiveParent();
      if (!liveParent || !isRequestCurrent()) {
        this.revokeExactSubagentMcpAccess(threadId, attempt.childIdentity);
        finishRequest();
        return {};
      }
      if (!epochCrossed) {
        if (!exactAuthorityIsCurrent) {
          this.revokeExactSubagentMcpAccess(threadId, attempt.childIdentity);
          finishRequest();
          return {};
        }
        if (resolution.status === "rejected") {
          this.revokeExactSubagentMcpAccess(threadId, attempt.childIdentity);
          finishRequest();
          throw resolution.error;
        }
        finishRequest();
        return resolution.mcpServers.length > 0 ||
          targetAdapter.capabilities.mcpConfigSource === "agentSettings"
          ? { mcpServers: resolution.mcpServers }
          : {};
      }

      // Attempt A may have minted a localhost relay from stale settings. Revoke
      // only that launch before rebuilding; a same-id B remains authoritative.
      this.revokeExactSubagentMcpAccess(threadId, attempt.childIdentity);
      if (!exactAuthorityIsCurrent) {
        finishRequest();
        return {};
      }
      if (attemptIndex === 1) {
        finishRequest();
        throw new McpLaunchConfigurationChangedError();
      }

      const retryPersonalMcpCredentialEpoch = this.personalMcpCredentialEpoch;
      const retryMcpLaunchConfigurationEpoch = this.mcpLaunchConfigurationEpoch;
      let refreshed: Awaited<ReturnType<ThreadSessionManager["resolveCurrentMcpLaunchSnapshot"]>>;
      try {
        refreshed = await this.resolveCurrentMcpLaunchSnapshot(liveParent);
      } catch (error) {
        if (!readOriginalLiveParent() || !isRequestCurrent()) {
          finishRequest();
          return {};
        }
        if (
          retryPersonalMcpCredentialEpoch !== this.personalMcpCredentialEpoch ||
          retryMcpLaunchConfigurationEpoch !== this.mcpLaunchConfigurationEpoch
        ) {
          finishRequest();
          throw new McpLaunchConfigurationChangedError();
        }
        finishRequest();
        throw error;
      }
      const retrySession = readOriginalLiveParent();
      if (!retrySession || !isRequestCurrent()) {
        finishRequest();
        return {};
      }
      if (
        retryPersonalMcpCredentialEpoch !== this.personalMcpCredentialEpoch ||
        retryMcpLaunchConfigurationEpoch !== this.mcpLaunchConfigurationEpoch
      ) {
        finishRequest();
        throw new McpLaunchConfigurationChangedError();
      }
      try {
        attempt = beginAttempt(
          retrySession,
          refreshed.snapshot,
          retryPersonalMcpCredentialEpoch,
          retryMcpLaunchConfigurationEpoch,
        );
      } catch (error) {
        finishRequest();
        throw error;
      }
    }

    finishRequest();
    return {};
  }

  releaseSubagentParentMcpAccess(parentThreadId: string, childThreadId: string): void {
    const authority = this.subagentMcpLaunchAuthorities.get(childThreadId);
    if (authority && authority.parentThreadId !== parentThreadId) return;
    const request = this.subagentMcpResolutionRequests.get(childThreadId);
    if (!authority && request && request.parentThreadId !== parentThreadId) return;
    this.subagentMcpLaunchAuthorities.delete(childThreadId);
    if (request?.parentThreadId === parentThreadId) {
      this.subagentMcpResolutionRequests.delete(childThreadId);
    }
    this.options.releasePipedreamMcpBindings?.(childThreadId);
  }

  private revokeExactSubagentMcpAccess(parentThreadId: string, identity: McpLaunchIdentity): void {
    const current = this.subagentMcpLaunchAuthorities.get(identity.threadId);
    if (
      current?.parentThreadId === parentThreadId &&
      current.authorization.identity.launchId === identity.launchId
    ) {
      this.subagentMcpLaunchAuthorities.delete(identity.threadId);
    }
    this.releasePipedreamMcpIdentityBindingsBestEffort(identity);
  }

  private invalidateSubagentMcpAuthorityForEpochChange(
    childThreadId: string,
    authority: SubagentMcpLaunchAuthority,
  ): void {
    const pendingRequest = this.subagentMcpResolutionRequests.get(childThreadId);
    if (
      pendingRequest?.parentThreadId !== authority.parentThreadId ||
      pendingRequest.parentSessionInstanceId !== authority.parentSessionInstanceId
    ) {
      this.subagentMcpLaunchAuthorities.delete(childThreadId);
    }
    // Pending attempts retain only their exact ordering record. The route is
    // synchronously gone, and resolveMcpCallerIdentity denies the record until
    // a current-state attempt completes and clears its request token.
    this.releasePipedreamMcpBindingsBestEffort(childThreadId);
  }

  /**
   * Apply a provider-level MCP settings change (the provider settings page's
   * Save) to the provider's live sessions. Only meaningful for adapters that
   * declare `mcpConfigSource: "agentSettings"` — their MCP set is re-resolved
   * from the freshly saved settings and each structured session that exposes
   * `updateMcpServers` applies the new set to its directory instance. Terminal
   * threads and sessions without the hook pick ordinary changes up on next
   * launch. Removing Personal Pipedream is stricter: pending launches are
   * cancelled and live launch-bound processes are stopped before the queued
   * refresh, so a stale localhost capability cannot survive the settings save.
   * Per-session failures are logged, never fatal: one broken directory update
   * must not strand the remaining sessions on the old set.
   */
  async reloadAgentMcpServers(payload: ReloadAgentMcpServersPayload): Promise<void> {
    this.mcpLaunchConfigurationEpoch += 1;
    const agentMcpSettingsReloadEpoch =
      (this.agentMcpSettingsReloadEpochs.get(payload.agentKind) ?? 0) + 1;
    this.agentMcpSettingsReloadEpochs.set(payload.agentKind, agentMcpSettingsReloadEpoch);
    const personalRevocations = this.beginRemovedPersonalAgentMcpRevocation(payload);
    const personalMcpCredentialEpoch = this.personalMcpCredentialEpoch;
    const timeoutParticipants = new Map<SessionRuntime, McpReloadSessionOwnership>();
    try {
      await this.enqueueMcpReload(
        () =>
          this.applyAgentMcpReload(
            payload,
            personalMcpCredentialEpoch,
            agentMcpSettingsReloadEpoch,
            timeoutParticipants,
          ),
        {
          onTimeout: () => {
            if (
              this.isAgentMcpSettingsReloadCurrent(payload.agentKind, agentMcpSettingsReloadEpoch)
            ) {
              this.agentMcpSettingsReloadEpochs.set(
                payload.agentKind,
                agentMcpSettingsReloadEpoch + 1,
              );
            }
            this.retireTimedOutMcpReloadSessions((session) => {
              const ownership = timeoutParticipants.get(session);
              return Boolean(
                ownership && this.isCurrentMcpReloadSessionOperation(session, ownership),
              );
            });
          },
        },
      );
    } catch {
      console.warn(`[supervisor] timed out reloading ${payload.agentKind} MCP settings.`);
    }
    await Promise.allSettled(personalRevocations);
  }

  /**
   * Agent-settings reloads are normally eventual for providers without a live
   * MCP update hook. A removed Personal descriptor cannot be eventual because
   * the already-translated provider config contains an opaque relay bearer.
   * Revoke that exact authority synchronously, then let bounded process cleanup
   * settle independently of the serialized settings refresh.
   */
  private beginRemovedPersonalAgentMcpRevocation(
    payload: ReloadAgentMcpServersPayload,
  ): Promise<void>[] {
    const currentGlobalMcpServers = readSupervisorSharedSettings(
      this.options.settingsPath,
    ).mcpServers;
    const currentPersonalByThread = new Map<string, boolean>();
    const personalWasRemoved = (threadId: string, snapshot: McpLaunchSnapshot): boolean => {
      let currentHasPersonal = currentPersonalByThread.get(threadId);
      if (currentHasPersonal === undefined) {
        const currentMcpServers = resolveEnabledMcpServers(
          mergeMcpServers(currentGlobalMcpServers, snapshot.projectMcpServers ?? []),
        );
        currentHasPersonal = currentMcpServers.some(isPersonalPipedreamMcpServer);
        currentPersonalByThread.set(threadId, currentHasPersonal);
      }
      return this.agentSettingsPersonalMcpThreads.has(threadId) && !currentHasPersonal;
    };

    const affectedParentThreadIds = new Set<string>();
    for (const [threadId, pending] of this.pendingStartMcpSettings) {
      if (pending.agentKind !== payload.agentKind || !pending.usesAgentSettings) continue;
      if (!personalWasRemoved(threadId, pending.snapshot)) continue;
      this.pendingStartAborts.add(threadId);
      this.removedPersonalPendingStarts.add(threadId);
      affectedParentThreadIds.add(threadId);
    }

    for (const [threadId, authority] of this.rootMcpLaunchAuthorities) {
      if (authority.phase !== "pending") continue;
      if (authority.authorization.adapter.kind !== payload.agentKind) continue;
      if (authority.authorization.adapter.capabilities.mcpConfigSource !== "agentSettings") {
        continue;
      }
      if (!personalWasRemoved(threadId, authority.authorization.mcpLaunchSnapshot)) continue;

      // The relay may already have been minted, but publication still passes
      // through the pending-start abort and exact launch-authority checks.
      if (this.startLocks.has(threadId)) this.pendingStartAborts.add(threadId);
      this.rootMcpLaunchAuthorities.delete(threadId);
      this.clearBrowserEvidenceTurn(threadId, authority.authorization.identity.launchId);
      affectedParentThreadIds.add(threadId);
    }

    const sessionsToStop: SessionRuntime[] = [];
    const teardowns: Promise<void>[] = [];
    for (const session of this.sessions.values()) {
      if (session.agentKind !== payload.agentKind) continue;
      if (session.adapter.capabilities.mcpConfigSource !== "agentSettings") continue;
      if (!personalWasRemoved(session.threadId, session.mcpLaunchSnapshot)) continue;

      affectedParentThreadIds.add(session.threadId);
      session.mcpLaunchSnapshot = {
        ...session.mcpLaunchSnapshot,
        mcpServers: session.mcpLaunchSnapshot.mcpServers.filter(
          (server) => !isPersonalPipedreamMcpServer(server),
        ),
      };
      this.refreshActiveMcpLaunchAuthorization(session);
      if (session.structuredSession?.updateMcpServers) continue;

      const presentation =
        session.presentationMode ?? session.adapter.capabilities.presentationMode;
      if (presentation === "gui") session.pendingPipedreamMcpReload = true;
      sessionsToStop.push(session);
    }

    const childTeardowns: Promise<unknown>[] = [];
    for (const [threadId, currentHasPersonal] of currentPersonalByThread) {
      if (currentHasPersonal) this.agentSettingsPersonalMcpThreads.add(threadId);
      else this.agentSettingsPersonalMcpThreads.delete(threadId);
    }
    for (const parentThreadId of affectedParentThreadIds) {
      // Release every already-minted root route before this method reaches its
      // first await. The queued provider update may be blocked indefinitely.
      this.releasePipedreamMcpBindingsBestEffort(parentThreadId);
      for (const [childThreadId, childAuthority] of this.subagentMcpLaunchAuthorities) {
        if (childAuthority.parentThreadId !== parentThreadId) continue;
        this.invalidateSubagentMcpAuthorityForEpochChange(childThreadId, childAuthority);
      }
      try {
        const childTeardown = this.options.crossagentMcp?.cancelAll(parentThreadId);
        if (childTeardown) childTeardowns.push(Promise.resolve(childTeardown));
      } catch {
        // Relay and supervisor authority are already gone; process cleanup is best effort.
      }
    }
    if (childTeardowns.length > 0) {
      teardowns.push(this.settleBestEffortWithin(childTeardowns));
    }
    for (const session of sessionsToStop) {
      teardowns.push(this.stopSessionProcessForPersonalOauthRevocation(session));
    }
    return teardowns;
  }

  private isAgentMcpSettingsReloadCurrent(agentKind: AgentKind, epoch: number): boolean {
    return (this.agentMcpSettingsReloadEpochs.get(agentKind) ?? 0) === epoch;
  }

  private installRefreshedMcpLaunchSnapshot(
    session: SessionRuntime,
    refreshed: {
      snapshot: McpLaunchSnapshot;
      agentSettingsHasPersonalPipedream: boolean;
    },
  ): void {
    session.mcpLaunchSnapshot = refreshed.snapshot;
    if (refreshed.agentSettingsHasPersonalPipedream) {
      this.agentSettingsPersonalMcpThreads.add(session.threadId);
    } else {
      this.agentSettingsPersonalMcpThreads.delete(session.threadId);
    }
  }

  private isCurrentStructuredMcpHandle(
    session: SessionRuntime,
    structuredSession: NonNullable<SessionRuntime["structuredSession"]>,
  ): boolean {
    return (
      this.isCurrentSession(session) &&
      session.ignoreExit !== true &&
      session.structuredSession === structuredSession
    );
  }

  private async applyAgentMcpReload(
    payload: ReloadAgentMcpServersPayload,
    personalMcpCredentialEpoch: number,
    agentMcpSettingsReloadEpoch: number,
    timeoutParticipants: Map<SessionRuntime, McpReloadSessionOwnership>,
  ): Promise<void> {
    if (
      personalMcpCredentialEpoch !== this.personalMcpCredentialEpoch ||
      !this.isAgentMcpSettingsReloadCurrent(payload.agentKind, agentMcpSettingsReloadEpoch)
    ) {
      return;
    }
    const reloads: Promise<void>[] = [];
    for (const session of this.sessions.values()) {
      if (session.agentKind !== payload.agentKind) continue;
      if (session.adapter.capabilities.mcpConfigSource !== "agentSettings") continue;
      const structuredSession = session.structuredSession;
      const update = structuredSession?.updateMcpServers?.bind(structuredSession);
      if (!structuredSession || !update) continue;
      reloads.push(
        this.runMcpReloadSessionOperation(session, timeoutParticipants, async () => {
          try {
            const refreshed = await this.resolveCurrentMcpLaunchSnapshot(session);
            if (!this.isCurrentStructuredMcpHandle(session, structuredSession)) {
              this.releasePipedreamMcpLaunchBindingsBestEffort(session);
              return;
            }
            if (
              personalMcpCredentialEpoch !== this.personalMcpCredentialEpoch ||
              !this.isAgentMcpSettingsReloadCurrent(payload.agentKind, agentMcpSettingsReloadEpoch)
            ) {
              return;
            }
            const launchConfig = this.spawnPipeline.resolveMcpLaunchConfig(
              workspaceLaunchConfig(
                session.projectLocation,
                session.config,
                session.adapter,
                refreshed.snapshot.disabledBuiltInMcpServerIds,
                refreshed.snapshot.pluginBuiltInMcpServerIds,
              ),
              refreshed.snapshot,
              session.adapter,
              session.threadId,
            );
            const mcpServers = await this.spawnPipeline.resolveMcpServersForLaunch({
              location: session.projectLocation,
              config: launchConfig,
              mcpLaunchSnapshot: refreshed.snapshot,
              identity: session.mcpIdentity ?? { threadId: session.threadId },
              crossagentThreadId: session.threadId,
              adapter: session.adapter,
              ...(session.presentationMode ? { presentationMode: session.presentationMode } : {}),
            });
            if (!this.isCurrentStructuredMcpHandle(session, structuredSession)) {
              this.releasePipedreamMcpLaunchBindingsBestEffort(session);
              return;
            }
            if (
              personalMcpCredentialEpoch !== this.personalMcpCredentialEpoch ||
              !this.isAgentMcpSettingsReloadCurrent(payload.agentKind, agentMcpSettingsReloadEpoch)
            ) {
              return;
            }
            const updateResult = await this.settleProviderMcpUpdateWithin(
              session,
              update(mcpServers),
            );
            if (updateResult === "failed") throw new Error("Provider MCP update failed.");
            if (updateResult === "timed-out") {
              if (!this.isCurrentStructuredMcpHandle(session, structuredSession)) {
                this.releasePipedreamMcpLaunchBindingsBestEffort(session);
                return;
              }
              session.pendingPipedreamMcpReload = true;
              this.releasePipedreamMcpBindingsBestEffort(session.threadId);
              await this.stopSessionProcessForPersonalOauthRevocation(session);
              return;
            }
            if (!this.isCurrentStructuredMcpHandle(session, structuredSession)) {
              this.releasePipedreamMcpLaunchBindingsBestEffort(session);
              return;
            }
            if (
              personalMcpCredentialEpoch !== this.personalMcpCredentialEpoch ||
              !this.isAgentMcpSettingsReloadCurrent(payload.agentKind, agentMcpSettingsReloadEpoch)
            ) {
              return;
            }
            this.installRefreshedMcpLaunchSnapshot(session, refreshed);
            session.nativePlugins = refreshed.nativePlugins;
            session.launchConfig = launchConfig;
            this.refreshActiveMcpLaunchAuthorization(session);
            this.outputPipeline.emitState(session);
          } catch (error) {
            if (!this.isCurrentStructuredMcpHandle(session, structuredSession)) {
              this.releasePipedreamMcpLaunchBindingsBestEffort(session);
              return;
            }
            console.warn(
              `[supervisor] failed to reload MCP servers for thread ${session.threadId}:`,
              error,
            );
          }
        }),
      );
    }
    await Promise.all(reloads);
  }

  /** Re-resolve Pipedream relays for every live GUI agent session. */
  async reloadPipedreamMcpServers(
    options: PipedreamMcpReloadOptions = {},
  ): Promise<PipedreamMcpReloadOutcome> {
    this.mcpLaunchConfigurationEpoch += 1;
    this.noteDesiredPersonalMcpFromCurrentAgentSettings();
    // OAuth begin/wait intentionally returns an authorized result without
    // awaiting provider reconfiguration. Gate every live GUI handle before
    // the first queue await so an immediate submit cannot use the old grants
    // while this reload is waiting behind unrelated MCP work.
    for (const session of this.sessions.values()) {
      const presentation =
        session.presentationMode ?? session.adapter.capabilities.presentationMode;
      if (presentation === "gui") session.pendingPipedreamMcpReload = true;
    }
    let childTermination: Promise<void> | undefined;
    const personalMcpCredentialEpoch = options.revokePersonalOauth
      ? ++this.personalMcpCredentialEpoch
      : this.personalMcpCredentialEpoch;
    if (options.revokePersonalOauth) {
      childTermination = this.beginPersonalOauthRevocation();
      // Clear already invalidated every older credential capability. Detach a
      // poisoned queue so revocation and the next reconnect can still advance.
      this.mcpReloadQueue = Promise.resolve();
    }
    const timeoutParticipants = new Map<SessionRuntime, McpReloadSessionOwnership>();
    const reloadEpoch = ++this.pipedreamMcpReloadEpoch;
    const reloadOptions = { ...options, personalMcpCredentialEpoch, reloadEpoch };
    const queuedOutcome = this.enqueueMcpReload(
      () => this.applyPipedreamMcpReload(reloadOptions, timeoutParticipants),
      {
        timeoutMs: options.revokePersonalOauth
          ? PERSONAL_MCP_REVOCATION_RELOAD_TIMEOUT_MS
          : MCP_RELOAD_OPERATION_TIMEOUT_MS,
        onTimeout: () => {
          if (this.pipedreamMcpReloadEpoch === reloadEpoch) {
            this.pipedreamMcpReloadEpoch += 1;
          }
          this.retireTimedOutMcpReloadSessions((session) => {
            const ownership = timeoutParticipants.get(session);
            return Boolean(
              ownership &&
              this.isCurrentMcpReloadSessionOperation(session, ownership) &&
              session.pendingPipedreamMcpReload === true,
            );
          });
        },
      },
    );
    const outcome = await queuedOutcome.catch(
      (): PipedreamMcpReloadOutcome => ({ state: "failed-pending" }),
    );
    await childTermination;
    return outcome;
  }

  /**
   * OAuth completion can start a Pipedream reload immediately after the
   * canonical descriptor is saved. Record that desired source before any
   * asynchronous relay resolution so a concurrent settings removal can revoke
   * a partially minted route even before the provider update completes.
   */
  private noteDesiredPersonalMcpFromCurrentAgentSettings(): void {
    const globalMcpServers = readSupervisorSharedSettings(this.options.settingsPath).mcpServers;
    for (const session of this.sessions.values()) {
      if (session.adapter.capabilities.mcpConfigSource !== "agentSettings") continue;
      const currentMcpServers = resolveEnabledMcpServers(
        mergeMcpServers(globalMcpServers, session.mcpLaunchSnapshot.projectMcpServers ?? []),
      );
      if (currentMcpServers.some(isPersonalPipedreamMcpServer)) {
        this.agentSettingsPersonalMcpThreads.add(session.threadId);
      }
    }
  }

  /**
   * Clear is a security boundary, not merely a queued settings refresh. Revoke
   * launch/child authority and begin termination synchronously so an older
   * reload or a hung provider dispose cannot extend the cleared credential.
   */
  private beginPersonalOauthRevocation(): Promise<void> {
    const parentThreadIds = new Set<string>(this.sessions.keys());
    for (const threadId of this.startLocks.keys()) this.pendingStartAborts.add(threadId);

    for (const [threadId, authority] of this.rootMcpLaunchAuthorities) {
      parentThreadIds.add(threadId);
      if (authority.phase === "pending") {
        this.pendingStartAborts.add(threadId);
        this.clearBrowserEvidenceTurn(threadId, authority.authorization.identity.launchId);
      }
      this.rootMcpLaunchAuthorities.delete(threadId);
      this.releasePipedreamMcpBindingsBestEffort(threadId);
    }
    for (const [childThreadId, authority] of this.subagentMcpLaunchAuthorities) {
      parentThreadIds.add(authority.parentThreadId);
      this.invalidateSubagentMcpAuthorityForEpochChange(childThreadId, authority);
    }

    // A queue reset may detach an update that has already crossed into the
    // provider. Retire that exact handle before any replacement can reuse the
    // thread; a late completion then has no authority over the new session.
    for (const session of [...this.liveMcpUpdateSessions]) {
      void this.stopSessionProcessForPersonalOauthRevocation(session).catch(() => {});
    }

    const childTeardowns: Promise<unknown>[] = [];
    for (const parentThreadId of parentThreadIds) {
      try {
        const teardown = this.options.crossagentMcp?.cancelAll(parentThreadId);
        if (teardown) childTeardowns.push(Promise.resolve(teardown));
      } catch {
        // Authority is already gone; child process cleanup remains best effort.
      }
    }

    // Providers without live MCP replacement retain the revoked localhost
    // capability in their process. Start replacing those processes now,
    // outside the reload queue; the queued phase resumes them without it.
    for (const session of this.sessions.values()) {
      if ((session.presentationMode ?? session.adapter.capabilities.presentationMode) === "gui") {
        session.pendingPipedreamMcpReload = true;
      }
      if (!session.structuredSession?.updateMcpServers) {
        void this.stopSessionProcessForPersonalOauthRevocation(session).catch(() => {});
      }
    }
    return this.settleBestEffortWithin(childTeardowns);
  }

  private isMcpReloadEpochCurrent(options: PipedreamMcpReloadOptions): boolean {
    return (
      (options.personalMcpCredentialEpoch === undefined ||
        options.personalMcpCredentialEpoch === this.personalMcpCredentialEpoch) &&
      (options.reloadEpoch === undefined || options.reloadEpoch === this.pipedreamMcpReloadEpoch)
    );
  }

  private enqueueMcpReload<T>(
    reload: () => Promise<T>,
    options: { timeoutMs?: number; onTimeout?: () => void } = {},
  ): Promise<T> {
    let expired = false;
    const operation = this.mcpReloadQueue.then(() => {
      if (expired) throw new Error("MCP reload operation timed out before it started.");
      return reload();
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<T>((_resolve, reject) => {
      timeout = setTimeout(() => {
        expired = true;
        try {
          options.onTimeout?.();
        } catch {
          // Timeout must still advance the queue even if best-effort retirement fails.
        } finally {
          reject(new Error("MCP reload operation timed out."));
        }
      }, options.timeoutMs ?? MCP_RELOAD_OPERATION_TIMEOUT_MS);
      timeout.unref?.();
    });
    const queued = Promise.race([operation, deadline]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
    this.mcpReloadQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  private beginMcpReloadSessionOperation(
    session: SessionRuntime,
    participants: Map<SessionRuntime, McpReloadSessionOwnership>,
  ): McpReloadSessionOwnership {
    const ownership: McpReloadSessionOwnership = {
      token: Symbol("mcp-reload-session"),
      structuredSession: session.structuredSession,
    };
    this.mcpReloadSessionOwners.set(session, ownership);
    participants.set(session, ownership);
    return ownership;
  }

  private isCurrentMcpReloadSessionOperation(
    session: SessionRuntime,
    ownership: McpReloadSessionOwnership,
  ): boolean {
    return (
      this.mcpReloadSessionOwners.get(session)?.token === ownership.token &&
      session.structuredSession === ownership.structuredSession
    );
  }

  private finishMcpReloadSessionOperation(
    session: SessionRuntime,
    ownership: McpReloadSessionOwnership,
    participants: Map<SessionRuntime, McpReloadSessionOwnership>,
  ): void {
    // Keep the latest-start marker after the work settles. A queue reset can
    // let a newer reload start and finish while an older accepted-turn reload
    // is still queued behind a detached promise. The persistent token is the
    // only evidence that the older timeout must not fail the repaired session.
    if (participants.get(session)?.token === ownership.token) participants.delete(session);
  }

  private invalidateMcpReloadSessionOperation(
    session: SessionRuntime,
    ownership: McpReloadSessionOwnership,
  ): boolean {
    if (!this.isCurrentMcpReloadSessionOperation(session, ownership)) return false;
    this.mcpReloadSessionOwners.set(session, {
      token: Symbol("mcp-reload-session-invalidated"),
      structuredSession: session.structuredSession,
    });
    return true;
  }

  private async runMcpReloadSessionOperation<T>(
    session: SessionRuntime,
    participants: Map<SessionRuntime, McpReloadSessionOwnership>,
    operation: (ownership: McpReloadSessionOwnership) => Promise<T>,
  ): Promise<T> {
    const ownership = this.beginMcpReloadSessionOperation(session, participants);
    try {
      return await operation(ownership);
    } finally {
      this.finishMcpReloadSessionOperation(session, ownership, participants);
    }
  }

  private retireTimedOutMcpReloadSessions(predicate: (session: SessionRuntime) => boolean): void {
    for (const session of this.sessions.values()) {
      if (!predicate(session) || !this.isCurrentSession(session)) continue;
      const presentation =
        session.presentationMode ?? session.adapter.capabilities.presentationMode;
      if (presentation === "gui") session.pendingPipedreamMcpReload = true;
      this.pipedreamMcpRestarts.delete(session);
      void this.stopSessionProcessForPersonalOauthRevocation(session).catch(() => {});
    }
  }

  private async applyPipedreamMcpReload(
    options: PipedreamMcpReloadOptions,
    timeoutParticipants: Map<SessionRuntime, McpReloadSessionOwnership>,
  ): Promise<PipedreamMcpReloadOutcome> {
    if (!this.isMcpReloadEpochCurrent(options)) return { state: "applied" };
    const reloads: Promise<PipedreamMcpReloadOutcome>[] = [];
    let outcome: PipedreamMcpReloadOutcome = { state: "applied" };
    for (const session of this.sessions.values()) {
      const structuredSession = session.structuredSession;
      const identity = session.mcpIdentity;
      const presentation =
        session.presentationMode ?? session.adapter.capabilities.presentationMode;
      if (!structuredSession || !identity) {
        if (presentation === "gui") session.pendingPipedreamMcpReload = true;
        if (options.revokePersonalOauth) {
          if (presentation === "gui" && session.sessionRef) {
            reloads.push(
              this.runMcpReloadSessionOperation(session, timeoutParticipants, () =>
                this.restartSessionForPipedreamMcpReload(
                  session,
                  { prompt: "", config: session.config },
                  options,
                ),
              ),
            );
          } else {
            reloads.push(
              this.runMcpReloadSessionOperation(session, timeoutParticipants, () =>
                this.stopUnresumableSessionForPersonalOauthRevocation(session),
              ),
            );
          }
          continue;
        }
        outcome = mergePipedreamMcpReloadOutcome(outcome, { state: "restart-required" });
        continue;
      }
      const update = structuredSession.updateMcpServers?.bind(structuredSession);
      if (!update) {
        if (presentation !== "gui") {
          outcome = mergePipedreamMcpReloadOutcome(outcome, { state: "restart-required" });
          continue;
        }
        session.pendingPipedreamMcpReload = true;
        if (!session.sessionRef) {
          if (options.revokePersonalOauth) {
            reloads.push(
              this.runMcpReloadSessionOperation(session, timeoutParticipants, () =>
                this.stopUnresumableSessionForPersonalOauthRevocation(session),
              ),
            );
            continue;
          }
          outcome = mergePipedreamMcpReloadOutcome(outcome, { state: "restart-required" });
          continue;
        }
        if (session.status !== "idle" && !options.revokePersonalOauth) {
          outcome = mergePipedreamMcpReloadOutcome(outcome, { state: "restart-required" });
          continue;
        }
        reloads.push(
          this.runMcpReloadSessionOperation(session, timeoutParticipants, () =>
            this.restartSessionForPipedreamMcpReload(
              session,
              {
                prompt: "",
                config: session.config,
              },
              options,
            ),
          ),
        );
        continue;
      }
      session.pendingPipedreamMcpReload = true;
      reloads.push(
        this.runMcpReloadSessionOperation(session, timeoutParticipants, () =>
          this.updatePipedreamMcpServersForSession(session, options),
        ),
      );
    }
    for (const reloadOutcome of await Promise.all(reloads)) {
      outcome = mergePipedreamMcpReloadOutcome(outcome, reloadOutcome);
    }
    return outcome;
  }

  /**
   * Restart one GUI provider that binds MCPs at launch. Pending access is
   * cleared only after the replacement succeeds; failures remain retryable.
   */
  private restartSessionForPipedreamMcpReload(
    session: SessionRuntime,
    turn: QueuedStructuredTurn,
    options: PipedreamMcpReloadOptions = {},
  ): Promise<PipedreamMcpReloadOutcome> {
    const inFlight = this.pipedreamMcpRestarts.get(session);
    if (inFlight) return inFlight;

    const agentMcpSettingsReloadEpoch =
      this.agentMcpSettingsReloadEpochs.get(session.agentKind) ?? 0;
    const mcpLaunchConfigurationEpoch = this.mcpLaunchConfigurationEpoch;
    let restart!: Promise<PipedreamMcpReloadOutcome>;
    restart = Promise.resolve()
      .then(async (): Promise<boolean> => {
        if (!this.isMcpReloadEpochCurrent(options)) return false;
        if (options.revokePersonalOauth) {
          await this.stopSessionProcessForPersonalOauthRevocation(session);
          if (!this.isCurrentSession(session) || !this.isMcpReloadEpochCurrent(options)) {
            return false;
          }
        }
        const refreshed = await this.resolveCurrentMcpLaunchSnapshot(session);
        if (!this.isCurrentSession(session)) return false;
        if (
          !this.isMcpReloadEpochCurrent(options) ||
          !this.isAgentMcpSettingsReloadCurrent(session.agentKind, agentMcpSettingsReloadEpoch)
        ) {
          this.releasePipedreamMcpBindingsBestEffort(session.threadId);
          return false;
        }
        // Restart from current shared settings and current OAuth storage. The
        // launch-time snapshot may still contain a bearer that was just
        // cleared, so it must not cross into the replacement authority.
        this.installRefreshedMcpLaunchSnapshot(session, refreshed);
        session.nativePlugins = refreshed.nativePlugins;
        await this.spawnPipeline.restartThread(session, turn);
        if (!this.isAgentMcpSettingsReloadCurrent(session.agentKind, agentMcpSettingsReloadEpoch)) {
          this.releasePipedreamMcpBindingsBestEffort(session.threadId);
          return false;
        }
        return true;
      })
      .then(
        (applied): PipedreamMcpReloadOutcome => {
          const currentSession = this.sessions.get(session.threadId);
          if (applied && currentSession && this.isMcpReloadEpochCurrent(options)) {
            currentSession.pendingPipedreamMcpReload = undefined;
          }
          return { state: applied ? "applied" : "failed-pending" };
        },
        (error): PipedreamMcpReloadOutcome => {
          if (this.isCurrentSession(session)) {
            session.pendingPipedreamMcpReload = true;
            const launchConfigurationWasSuperseded =
              error instanceof McpLaunchConfigurationChangedError &&
              mcpLaunchConfigurationEpoch !== this.mcpLaunchConfigurationEpoch;
            if (!launchConfigurationWasSuperseded) {
              this.failStructuredSession(session, error);
            }
            return { state: "failed-pending" };
          }
          return { state: "applied" };
        },
      )
      .finally(() => {
        if (this.pipedreamMcpRestarts.get(session) === restart) {
          this.pipedreamMcpRestarts.delete(session);
        }
      });
    this.pipedreamMcpRestarts.set(session, restart);
    return restart;
  }

  /**
   * A launch-bound provider process owns an opaque localhost capability. The
   * OAuth service revokes it synchronously; providers without live MCP update
   * still need replacement so their stale route is removed before another turn.
   */
  private async stopSessionProcessForPersonalOauthRevocation(
    session: SessionRuntime,
  ): Promise<void> {
    const existing = this.personalOauthRevocationStops.get(session);
    if (existing) return existing;
    if (!this.isCurrentSession(session)) return;
    const structuredSession = session.structuredSession;
    session.ignoreExit = true;
    session.structuredSession = undefined;
    try {
      structuredSession?.forceCompleteTurn?.();
    } catch {
      // Revocation continues even if provider bookkeeping is already broken.
    }
    this.outputPipeline.clearSessionTimers(session);
    this.rootMcpLaunchAuthorities.delete(session.threadId);
    this.browserEvidenceTurns.delete(session.threadId);
    for (const [childThreadId, authority] of this.subagentMcpLaunchAuthorities) {
      if (authority.parentThreadId !== session.threadId) continue;
      this.subagentMcpLaunchAuthorities.delete(childThreadId);
      this.releasePipedreamMcpBindingsBestEffort(childThreadId);
    }
    this.releasePipedreamMcpBindingsBestEffort(session.threadId);
    try {
      this.ptyLifecycle.kill(session);
    } catch {
      // Provider interruption/disposal below remains an independent kill path.
    }

    const teardowns: Promise<unknown>[] = [];
    if (structuredSession?.interruptTurn) {
      try {
        teardowns.push(Promise.resolve(structuredSession.interruptTurn()));
      } catch {
        // Best-effort interruption cannot delay bearer revocation.
      }
    }
    if (structuredSession) {
      try {
        teardowns.push(Promise.resolve(structuredSession.dispose()));
      } catch {
        // Process authority is already gone and the PTY is already killed.
      }
    }
    const stop = this.settleBestEffortWithin(teardowns).finally(() => {
      if (this.personalOauthRevocationStops.get(session) === stop) {
        this.personalOauthRevocationStops.delete(session);
      }
    });
    this.personalOauthRevocationStops.set(session, stop);
    return stop;
  }

  private releasePipedreamMcpBindingsBestEffort(threadId: string): void {
    try {
      this.options.releasePipedreamMcpBindings?.(threadId);
    } catch {
      // Local authority is already revoked; relay teardown cannot block clear.
    }
  }

  private releasePipedreamMcpIdentityBindingsBestEffort(identity: McpThreadIdentity): void {
    if (identity.threadId && identity.launchId && this.options.releasePipedreamMcpLaunchBindings) {
      try {
        this.options.releasePipedreamMcpLaunchBindings({
          threadId: identity.threadId,
          launchId: identity.launchId,
        });
        return;
      } catch {
        // Fall through to thread-wide fail-closed cleanup when scoped teardown fails.
      }
    }
    if (!identity.threadId) return;
    const liveLaunchId =
      this.rootMcpLaunchAuthorities.get(identity.threadId)?.authorization.identity.launchId ??
      this.subagentMcpLaunchAuthorities.get(identity.threadId)?.authorization.identity.launchId;
    // A thread-wide fallback would revoke a newer replacement. It is safe only
    // when this launch is still the sole authority (or no authority remains).
    if (liveLaunchId && liveLaunchId !== identity.launchId) return;
    this.releasePipedreamMcpBindingsBestEffort(identity.threadId);
  }

  private releasePipedreamMcpLaunchBindingsBestEffort(session: SessionRuntime): void {
    const identity = session.mcpIdentity;
    if (identity) this.releasePipedreamMcpIdentityBindingsBestEffort(identity);
    else this.releasePipedreamMcpBindingsBestEffort(session.threadId);
  }

  private settleBestEffortWithin(tasks: readonly Promise<unknown>[]): Promise<void> {
    if (tasks.length === 0) return Promise.resolve();
    const settled = Promise.allSettled(tasks).then(() => undefined);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, PERSONAL_MCP_REVOCATION_TEARDOWN_TIMEOUT_MS);
      timeout.unref?.();
    });
    return Promise.race([settled, deadline]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
  }

  private async settleProviderMcpUpdateWithin(
    session: SessionRuntime,
    update: Promise<void>,
  ): Promise<"applied" | "failed" | "timed-out"> {
    this.liveMcpUpdateSessions.add(session);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const settled = update.then(
      () => "applied" as const,
      () => "failed" as const,
    );
    const deadline = new Promise<"timed-out">((resolve) => {
      timeout = setTimeout(() => resolve("timed-out"), MCP_LIVE_UPDATE_TIMEOUT_MS);
      timeout.unref?.();
    });
    try {
      return await Promise.race([settled, deadline]);
    } finally {
      if (timeout) clearTimeout(timeout);
      this.liveMcpUpdateSessions.delete(session);
    }
  }

  private async stopUnresumableSessionForPersonalOauthRevocation(
    session: SessionRuntime,
  ): Promise<PipedreamMcpReloadOutcome> {
    try {
      await this.stopSessionProcessForPersonalOauthRevocation(session);
      if (this.isCurrentSession(session)) {
        this.failStructuredSession(
          session,
          new Error("Personal Pipedream was signed out and this agent session must be restarted."),
        );
      }
    } catch (error) {
      if (this.isCurrentSession(session)) this.failStructuredSession(session, error);
    }
    return { state: "failed-pending" };
  }

  /**
   * Update one provider that supports live MCP replacement. A failed refresh
   * deliberately leaves the pending bit set so the next user turn cannot run
   * against a stale integration grant.
   */
  private async updatePipedreamMcpServersForSession(
    session: SessionRuntime,
    options: PipedreamMcpReloadOptions = {},
  ): Promise<PipedreamMcpReloadOutcome> {
    const structuredSession = session.structuredSession;
    const identity = session.mcpIdentity;
    const update = structuredSession?.updateMcpServers?.bind(structuredSession);
    if (!structuredSession || !identity || !update) return { state: "applied" };
    const agentMcpSettingsReloadEpoch =
      this.agentMcpSettingsReloadEpochs.get(session.agentKind) ?? 0;
    try {
      if (
        !this.isCurrentStructuredMcpHandle(session, structuredSession) ||
        !this.isMcpReloadEpochCurrent(options)
      ) {
        return { state: "applied" };
      }
      const refreshed = await this.resolveCurrentMcpLaunchSnapshot(session);
      if (!this.isCurrentStructuredMcpHandle(session, structuredSession)) {
        this.releasePipedreamMcpLaunchBindingsBestEffort(session);
        return { state: "applied" };
      }
      if (
        !this.isMcpReloadEpochCurrent(options) ||
        !this.isAgentMcpSettingsReloadCurrent(session.agentKind, agentMcpSettingsReloadEpoch)
      ) {
        return { state: "applied" };
      }
      const launchConfig = this.spawnPipeline.resolveMcpLaunchConfig(
        workspaceLaunchConfig(
          session.projectLocation,
          session.config,
          session.adapter,
          refreshed.snapshot.disabledBuiltInMcpServerIds,
          refreshed.snapshot.pluginBuiltInMcpServerIds,
        ),
        refreshed.snapshot,
        session.adapter,
        session.threadId,
      );
      const mcpServers = await this.spawnPipeline.resolveMcpServersForLaunch({
        location: session.projectLocation,
        config: launchConfig,
        mcpLaunchSnapshot: refreshed.snapshot,
        identity,
        crossagentThreadId: session.threadId,
        adapter: session.adapter,
        ...(session.presentationMode ? { presentationMode: session.presentationMode } : {}),
      });
      if (!this.isCurrentStructuredMcpHandle(session, structuredSession)) {
        this.releasePipedreamMcpLaunchBindingsBestEffort(session);
        return { state: "applied" };
      }
      if (
        !this.isMcpReloadEpochCurrent(options) ||
        !this.isAgentMcpSettingsReloadCurrent(session.agentKind, agentMcpSettingsReloadEpoch)
      ) {
        return { state: "applied" };
      }
      const updateResult = await this.settleProviderMcpUpdateWithin(session, update(mcpServers));
      if (updateResult === "failed") throw new Error("Provider MCP update failed.");
      if (updateResult === "timed-out") {
        if (!this.isCurrentStructuredMcpHandle(session, structuredSession)) {
          this.releasePipedreamMcpLaunchBindingsBestEffort(session);
          return { state: "applied" };
        }
        this.releasePipedreamMcpBindingsBestEffort(session.threadId);
        session.pendingPipedreamMcpReload = true;
        await this.stopSessionProcessForPersonalOauthRevocation(session);
        return { state: "failed-pending" };
      }
      if (!this.isCurrentStructuredMcpHandle(session, structuredSession)) {
        this.releasePipedreamMcpLaunchBindingsBestEffort(session);
        return { state: "applied" };
      }
      if (
        !this.isMcpReloadEpochCurrent(options) ||
        !this.isAgentMcpSettingsReloadCurrent(session.agentKind, agentMcpSettingsReloadEpoch)
      ) {
        return { state: "applied" };
      }
      this.installRefreshedMcpLaunchSnapshot(session, refreshed);
      session.nativePlugins = refreshed.nativePlugins;
      session.launchConfig = launchConfig;
      if (options.revokePersonalOauth) {
        this.restoreActiveMcpLaunchAuthorization(
          session,
          options.personalMcpCredentialEpoch ?? this.personalMcpCredentialEpoch,
        );
      } else {
        this.refreshActiveMcpLaunchAuthorization(session);
      }
      session.pendingPipedreamMcpReload = undefined;
      this.outputPipeline.emitState(session);
      return { state: "applied" };
    } catch {
      if (!this.isCurrentStructuredMcpHandle(session, structuredSession)) {
        this.releasePipedreamMcpLaunchBindingsBestEffort(session);
        return { state: "applied" };
      }
      if (!this.isMcpReloadEpochCurrent(options)) {
        return { state: "applied" };
      }
      console.warn(
        `[supervisor] failed to reload Pipedream MCP servers for thread ${session.threadId}.`,
      );
      if (options.revokePersonalOauth) {
        if (!session.sessionRef) {
          return this.stopUnresumableSessionForPersonalOauthRevocation(session);
        }
        return this.restartSessionForPipedreamMcpReload(
          session,
          { prompt: "", config: session.config },
          options,
        );
      }
      return { state: "failed-pending" };
    }
  }

  /**
   * Providers such as Codex and Claude bind MCP configuration when their GUI
   * session starts. If a grant changed while a turn was running, resume the
   * same provider thread with fresh MCPs before executing the next turn.
   */
  private startStructuredTurn(session: SessionRuntime, turn: QueuedStructuredTurn): void {
    const presentation = session.presentationMode ?? session.adapter.capabilities.presentationMode;
    if (session.pendingPipedreamMcpReload === true && presentation === "gui") {
      const reloadEpoch = this.pipedreamMcpReloadEpoch;
      const agentMcpSettingsReloadEpoch =
        this.agentMcpSettingsReloadEpochs.get(session.agentKind) ?? 0;
      const mcpLaunchConfigurationEpoch = this.mcpLaunchConfigurationEpoch;
      const timeoutParticipants = new Map<SessionRuntime, McpReloadSessionOwnership>();
      const latestOwnerAtEnqueue = this.mcpReloadSessionOwners.get(session);
      const structuredSessionAtEnqueue = session.structuredSession;
      const timedOutOwnedParticipants = new Set<SessionRuntime>();
      let startedOwnership: McpReloadSessionOwnership | undefined;
      let operationStarted = false;
      let turnRerouted = false;
      const rerouteAcceptedTurn = (): void => {
        if (turnRerouted) return;
        const current = this.sessions.get(session.threadId);
        if (!current) return;
        turnRerouted = true;
        this.startStructuredTurn(current, turn);
      };
      void this.enqueueMcpReload(
        () => {
          operationStarted = true;
          const current = this.sessions.get(session.threadId);
          if (!current) return Promise.resolve<AcceptedTurnReloadOutcome>("handled");
          return this.runMcpReloadSessionOperation(current, timeoutParticipants, (ownership) => {
            startedOwnership = ownership;
            return this.startStructuredTurnAfterPipedreamReload(
              current,
              turn,
              reloadEpoch,
              agentMcpSettingsReloadEpoch,
              mcpLaunchConfigurationEpoch,
              ownership,
            );
          });
        },
        {
          onTimeout: () => {
            if (this.pipedreamMcpReloadEpoch === reloadEpoch) {
              this.pipedreamMcpReloadEpoch += 1;
            }
            for (const [participant, ownership] of timeoutParticipants) {
              if (!this.isCurrentSession(participant)) continue;
              if (!this.invalidateMcpReloadSessionOperation(participant, ownership)) continue;
              timedOutOwnedParticipants.add(participant);
            }
            this.retireTimedOutMcpReloadSessions((candidate) =>
              timedOutOwnedParticipants.has(candidate),
            );
          },
        },
      )
        .then((outcome) => {
          if (outcome === "superseded") rerouteAcceptedTurn();
        })
        .catch((error) => {
          let failedParticipant = false;
          for (const participant of timedOutOwnedParticipants) {
            if (this.isCurrentSession(participant)) {
              this.failStructuredSession(participant, error);
              failedParticipant = true;
            }
          }
          if (failedParticipant) return;

          const current = this.sessions.get(session.threadId);
          if (!current) return;
          const latestOwner = this.mcpReloadSessionOwners.get(current);
          const wasSupersededAfterStart = Boolean(
            operationStarted &&
            startedOwnership &&
            (current !== session ||
              latestOwner?.token !== startedOwnership.token ||
              current.structuredSession !== startedOwnership.structuredSession),
          );
          if (wasSupersededAfterStart || current !== session) {
            // A newer cross-source reload superseded the detached operation.
            // Route the already-accepted turn through current state exactly once;
            // the old callback is fenced by its invalid ownership token.
            rerouteAcceptedTurn();
            return;
          }

          if (operationStarted) {
            this.failStructuredSession(current, error);
            return;
          }

          if (
            latestOwner?.token !== latestOwnerAtEnqueue?.token ||
            current.structuredSession !== structuredSessionAtEnqueue
          ) {
            rerouteAcceptedTurn();
            return;
          }
          this.failStructuredSession(current, error);
        });
      return;
    }
    this.structuredTurnQueue.start(session, turn);
  }

  private async startStructuredTurnAfterPipedreamReload(
    session: SessionRuntime,
    turn: QueuedStructuredTurn,
    reloadEpoch: number,
    agentMcpSettingsReloadEpoch: number,
    mcpLaunchConfigurationEpoch: number,
    ownership: McpReloadSessionOwnership,
  ): Promise<AcceptedTurnReloadOutcome> {
    const isOwned = (): boolean =>
      this.isCurrentSession(session) && this.isCurrentMcpReloadSessionOperation(session, ownership);
    const agentSettingsAreCurrent = (): boolean =>
      this.isAgentMcpSettingsReloadCurrent(session.agentKind, agentMcpSettingsReloadEpoch);
    if (!isOwned() || !agentSettingsAreCurrent()) return "superseded";
    const presentation = session.presentationMode ?? session.adapter.capabilities.presentationMode;
    if (session.pendingPipedreamMcpReload !== true || presentation !== "gui") {
      this.structuredTurnQueue.start(session, turn);
      return "handled";
    }
    const reloadOptions: PipedreamMcpReloadOptions = {
      personalMcpCredentialEpoch: this.personalMcpCredentialEpoch,
      reloadEpoch,
      mcpLaunchConfigurationEpoch,
    };

    if (session.structuredSession?.updateMcpServers) {
      await this.updatePipedreamMcpServersForSession(session, reloadOptions);
      if (
        !isOwned() ||
        !this.isMcpReloadEpochCurrent(reloadOptions) ||
        !agentSettingsAreCurrent()
      ) {
        return "superseded";
      }
      if (session.pendingPipedreamMcpReload === true) {
        this.failStructuredSession(
          session,
          new Error("Could not refresh integration access before starting the turn."),
        );
        return "handled";
      }
      this.structuredTurnQueue.start(session, turn);
      return "handled";
    }

    if (!session.sessionRef) {
      this.failStructuredSession(
        session,
        new Error(
          "Could not refresh integration access before starting the turn because this provider session is not resumable yet.",
        ),
      );
      return "handled";
    }
    if (!isOwned()) return "superseded";
    const restartOutcome = await this.restartSessionForPipedreamMcpReload(
      session,
      turn,
      reloadOptions,
    );
    if (
      restartOutcome.state !== "applied" &&
      (!isOwned() ||
        !this.isMcpReloadEpochCurrent(reloadOptions) ||
        !agentSettingsAreCurrent() ||
        reloadOptions.mcpLaunchConfigurationEpoch !== this.mcpLaunchConfigurationEpoch)
    ) {
      // A newer ordinary, same-agent, or global launch-config reload can
      // advance its epoch while remaining queued behind this exact per-session
      // owner. The stale restart then reports failed-pending without losing
      // ownership; reroute the accepted turn after the queued repair finishes.
      return "superseded";
    }
    return "handled";
  }

  /** Re-read provider-level custom MCPs instead of replaying launch-time settings. */
  private async resolveCurrentMcpLaunchSnapshot(session: SessionRuntime): Promise<{
    snapshot: McpLaunchSnapshot;
    nativePlugins: readonly AgentNativePlugin[];
    agentSettingsHasPersonalPipedream: boolean;
  }> {
    return this.resolveCurrentMcpLaunchSnapshotFor({
      threadId: session.threadId,
      agentKind: session.agentKind,
      adapter: session.adapter,
      projectLocation: session.projectLocation,
      config: session.config,
      mcpLaunchSnapshot: session.mcpLaunchSnapshot,
    });
  }

  private async refreshPendingMcpLaunchSnapshot(input: {
    threadId: string;
    agentKind: AgentKind;
    adapter: AgentAdapter;
    projectLocation: ProjectLocation;
    config: ThreadConfig;
    mcpLaunchSnapshot: McpLaunchSnapshot;
  }): Promise<{
    mcpLaunchSnapshot: McpLaunchSnapshot;
    nativePlugins: readonly AgentNativePlugin[];
  }> {
    const refreshed = await this.resolveCurrentMcpLaunchSnapshotFor(input);
    const pending = this.pendingStartMcpSettings.get(input.threadId);
    if (pending) pending.snapshot = refreshed.snapshot;
    if (refreshed.agentSettingsHasPersonalPipedream) {
      this.agentSettingsPersonalMcpThreads.add(input.threadId);
    } else {
      this.agentSettingsPersonalMcpThreads.delete(input.threadId);
    }
    return {
      mcpLaunchSnapshot: refreshed.snapshot,
      nativePlugins: refreshed.nativePlugins,
    };
  }

  private async resolveCurrentMcpLaunchSnapshotFor(input: {
    threadId: string;
    agentKind: AgentKind;
    adapter: AgentAdapter;
    projectLocation: ProjectLocation;
    config: ThreadConfig;
    mcpLaunchSnapshot: McpLaunchSnapshot;
  }): Promise<{
    snapshot: McpLaunchSnapshot;
    nativePlugins: readonly AgentNativePlugin[];
    agentSettingsHasPersonalPipedream: boolean;
  }> {
    const settings = readSupervisorSharedSettings(this.options.settingsPath);
    const pluginContributions = (await this.options.resolvePluginLaunchContributions?.(
      input.projectLocation,
      input.agentKind,
    )) ?? { mcpServers: [], builtInMcpServerIds: [], nativePlugins: [] };

    const userMcpServers = mergeMcpServers(
      settings.mcpServers,
      input.mcpLaunchSnapshot.projectMcpServers ?? [],
    );
    const agentSettingsHasPersonalPipedream = resolveEnabledMcpServers(userMcpServers).some(
      isPersonalPipedreamMcpServer,
    );
    const userMcpServerNames = new Set(userMcpServers.map((server) => server.name));
    const pluginMcpServers = pluginContributions.mcpServers.filter(
      (server) => !userMcpServerNames.has(server.name),
    );
    let mcpServers = resolveEnabledMcpServers([...userMcpServers, ...pluginMcpServers]);
    if (this.options.applyMcpServerAuthorization) {
      mcpServers = await this.options.applyMcpServerAuthorization(mcpServers);
    }
    if (this.options.prepareMcpToolFilters) {
      const candidateSnapshot: McpLaunchSnapshot = {
        ...input.mcpLaunchSnapshot,
        mcpServers,
        pluginBuiltInMcpServerIds: pluginContributions.builtInMcpServerIds,
      };
      const effectiveConfig = this.spawnPipeline.resolveMcpLaunchConfig(
        workspaceLaunchConfig(
          input.projectLocation,
          input.config,
          input.adapter,
          candidateSnapshot.disabledBuiltInMcpServerIds,
          candidateSnapshot.pluginBuiltInMcpServerIds,
        ),
        candidateSnapshot,
        input.adapter,
        input.threadId,
      );
      // Keep Personal Pipedream recognizable until the privileged resolver
      // replaces it with a launch-scoped localhost capability. The initial
      // launch follows the same ordering; live/restart reloads must not wrap
      // the upstream URL (or bearer) in a generic stdio filter first.
      const personalMcpServers = mcpServers
        .filter(isPersonalPipedreamMcpServer)
        .map(stripResolvedAuthorizationHeader);
      const filterableServers = mcpServers.filter(
        (server) => !isPersonalPipedreamMcpServer(server),
      );
      const filteredServers = await this.options.prepareMcpToolFilters(
        filterableServers,
        input.projectLocation,
        effectiveConfig.browserMcp === true,
      );
      mcpServers = [...filteredServers, ...personalMcpServers];
    }

    return {
      snapshot: {
        ...input.mcpLaunchSnapshot,
        mcpServers,
        pluginBuiltInMcpServerIds: pluginContributions.builtInMcpServerIds,
      },
      nativePlugins: pluginContributions.nativePlugins,
      agentSettingsHasPersonalPipedream,
    };
  }

  /**
   * Subagent host hook: append a (already re-tagged) child runtime event into a
   * parent thread's event stream. Dropped if the parent thread is no longer
   * live. Consumed by {@link SubagentRunManager}.
   */
  appendSubagentRuntimeEvent(parentThreadId: string, event: RuntimeEvent): void {
    if (!this.sessions.has(parentThreadId)) return;
    this.runtimeEventRouter.append(parentThreadId, event);
  }

  /**
   * Renderer-facing: subscribe a sub-agent overlay. Buffered child history is
   * replayed onto the normal runtime event stream (persisted + broadcast to WS
   * clients); subsequent child events continue on that same stream. The RPC
   * returns `history: []` — the field remains for backward compatibility with
   * older clients/hosts that still deliver drained buffer events in the body.
   */
  subagentSubscribe(payload: { threadId: string; parentItemId: string }): {
    history: RuntimeEvent[];
  } {
    return {
      history: this.runtimeEventRouter.subscribe(payload.threadId, payload.parentItemId),
    };
  }

  /**
   * Renderer-facing: unsubscribe a sub-agent overlay. Subsequent child events
   * are buffered again until the parent completes, at which point the buffer
   * is flushed to the renderer so the overlay can replay every turn even if
   * it was closed while the sub-agent ran.
   */
  subagentUnsubscribe(payload: { threadId: string; parentItemId: string }): void {
    this.runtimeEventRouter.unsubscribe(payload.threadId, payload.parentItemId);
  }

  /**
   * Look up the live `SessionRuntime` for a CLI hook plugin envelope. Routing
   * precedence is `threadId` (PTY env, primary) → `sessionId`
   * (`providerSessionId` discovered after spawn, fallback for nested shells).
   */
  findSessionForCliHookPlugin(input: {
    threadId?: string;
    sessionId?: string;
  }): SessionRuntime | undefined {
    return this.cliHookPlugin.findSessionForCliHookPlugin(input);
  }

  /** Apply a CLI hook plugin state change resolved by the dispatcher. */
  applyCliHookPluginState(
    session: SessionRuntime,
    change: {
      status: import("@/shared/contracts").ThreadStatus;
      attention: import("@/shared/contracts").ThreadAttention;
    },
  ): void {
    this.cliHookPlugin.applyCliHookPluginState(session, change);
  }

  /** Mark hook ownership for routed bookkeeping events that do not carry state. */
  noteCliHookPluginActivity(session: SessionRuntime, envelope?: AgentEventEnvelope): void {
    this.cliHookPlugin.noteCliHookPluginActivity(session, envelope);
  }

  /**
   * Update the `sessionsBySessionId` index when a session's `sessionRef`
   * changes. Idempotent — clears any stale id mapping before writing the new
   * one. Call from anywhere that mutates `session.sessionRef`.
   */
  private indexSessionRef(session: SessionRuntime, prevId: string | undefined): void {
    if (prevId && this.sessionsBySessionId.get(prevId) === session) {
      this.sessionsBySessionId.delete(prevId);
    }
    const nextId = session.sessionRef?.providerSessionId;
    if (nextId) {
      this.sessionsBySessionId.set(nextId, session);
    }
  }

  async startThread(payload: StartThreadPayload): Promise<StartThreadResult> {
    if (this.disposed) {
      throw new Error("ThreadSessionManager is disposed.");
    }
    const threadId = payload.threadId ?? randomUUID();
    const pending = this.startLocks.get(threadId);
    if (pending) {
      return { threadId };
    }
    this.recentlyRemovedThreadIds.delete(threadId);

    const adapter = this.options.adapters.get(payload.agentKind);
    const pendingMcpSettings: PendingStartMcpSettings = {
      agentKind: payload.agentKind,
      usesAgentSettings: adapter?.capabilities.mcpConfigSource === "agentSettings",
      snapshot: {
        mcpServers: resolveEnabledMcpServers(payload.mcpServers ?? []),
        ...(payload.projectMcpServers?.length
          ? { projectMcpServers: [...payload.projectMcpServers] }
          : {}),
        disabledBuiltInMcpServerIds: payload.disabledBuiltInMcpServerIds ?? [],
        disabledBuiltInMcpTools: payload.disabledBuiltInMcpTools ?? {},
      },
    };
    this.pendingStartMcpSettings.set(threadId, pendingMcpSettings);
    if (
      pendingMcpSettings.usesAgentSettings &&
      pendingMcpSettings.snapshot.mcpServers.some(isPersonalPipedreamMcpServer)
    ) {
      this.agentSettingsPersonalMcpThreads.add(threadId);
    } else {
      this.agentSettingsPersonalMcpThreads.delete(threadId);
    }

    const run = this.spawnPipeline.startThreadInner({ ...payload, threadId });
    this.startLocks.set(
      threadId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    try {
      return await run;
    } catch (error) {
      if (this.removedPersonalPendingStarts.has(threadId)) return { threadId };
      throw error;
    } finally {
      this.startLocks.delete(threadId);
      this.pendingStartMcpSettings.delete(threadId);
      this.removedPersonalPendingStarts.delete(threadId);
      if (!this.sessions.has(threadId)) {
        this.agentSettingsPersonalMcpThreads.delete(threadId);
        this.pendingStartInterrupts.delete(threadId);
        this.pendingStartAborts.delete(threadId);
      }
    }
  }

  async sendThreadInput(payload: SendThreadInputPayload): Promise<void> {
    const session = await this.findSessionAfterPendingStart(payload.threadId);
    if (!session) {
      // Never swallow a full user prompt, even for a just-removed thread —
      // callers (renderer composer, `send_to_thread`) resume on this error.
      throw new Error(`Unknown thread session: ${payload.threadId}`);
    }
    if (session.status === "inactive" && !session.sessionRef) {
      throw new Error("This thread exited before a resumable session id was discovered.");
    }
    const usesStructuredFlow =
      session.adapter.capabilities.liveInputMode === "server" || session.presentationMode === "gui";
    const wslSegments = payload.segments
      ? await rewriteSegmentsForWsl(payload.segments, session.projectLocation, {
          preserveImageAttachments: usesStructuredFlow,
          preservePdfAttachments:
            usesStructuredFlow && session.adapter.capabilities.readsPdfAttachmentsFromHost === true,
        })
      : undefined;
    const effectiveSegments = await this.filterPluginSkillSegments(session, wslSegments);
    const prompt = this.formatSegmentsForPrompt(session, effectiveSegments, payload.prompt);

    const turnConfig =
      session.presentationMode !== "gui" &&
      payload.config.mode === "plan" &&
      session.config.mode === undefined
        ? { ...payload.config, mode: undefined }
        : payload.config;
    const effectiveConfig = applyHomeScopePermissions(
      session.projectLocation,
      turnConfig,
      session.adapter.capabilities,
    );

    session.config = effectiveConfig;
    const inlineInstructions = usesStructuredFlow
      ? await this.resolveSkillTurnInjection(session, effectiveSegments)
      : undefined;
    const turn: QueuedStructuredTurn = {
      prompt,
      config: effectiveConfig,
      ...(effectiveSegments ? { segments: effectiveSegments } : {}),
      ...(payload.userMessageItemId ? { userMessageItemId: payload.userMessageItemId } : {}),
      ...(inlineInstructions ? { inlineInstructions } : {}),
    };
    if (session.status === "inactive") {
      // Guaranteed to have a sessionRef here — the no-ref case threw above.
      await this.spawnPipeline.restartThread(session, turn);
      return;
    }
    if (
      usesStructuredFlow &&
      !session.structuredSession &&
      (session.status === "error" || session.status === "idle") &&
      session.sessionRef
    ) {
      await this.spawnPipeline.restartThread(session, turn);
      return;
    }
    // Route through the structured session when either the adapter is
    // server-controlled OR this thread was launched in chat mode (the
    // structured session owns input/output instead of the PTY).
    if (usesStructuredFlow && session.structuredSession?.startTurn) {
      // GUI threads route submit-while-working through the pending-steer
      // path. Renderers should call `setPendingSteer` directly for that case;
      // any `sendThreadInput` that lands here while working is treated as a
      // steer (replace-latest) for backwards compatibility.
      if (session.presentationMode === "gui" && session.status === "working") {
        // Capability-based: sessions that support non-interrupting steer enqueue
        // the message onto the running turn (subagents survive); others fall
        // back to the interrupt-drain pending-steer path.
        if (session.structuredSession.steerTurn) {
          const browserEvidenceTurnId = this.beginBrowserEvidenceTurnForSession(session);
          this.steerCoordinator.steerStructuredTurn(session, {
            ...turn,
            ...(browserEvidenceTurnId ? { browserEvidenceTurnId } : {}),
          });
          return;
        }
        this.steerCoordinator.stagePendingSteer(session, turn);
        this.steerCoordinator.fireSteerInterrupt(session);
        return;
      }
      if (session.presentationMode === "gui" && session.pendingSteer !== undefined) {
        // Drain in progress (cancel acked, slot still set). Replace it; the
        // existing drain-on-idle hook will pick up the new content.
        this.steerCoordinator.stagePendingSteer(session, turn);
        this.steerCoordinator.maybeDrainPendingSteer(session);
        return;
      }
      const browserEvidenceTurnId = this.beginBrowserEvidenceTurnForSession(session);
      this.startStructuredTurn(session, {
        ...turn,
        ...(browserEvidenceTurnId ? { browserEvidenceTurnId } : {}),
      });
      return;
    }

    const pty = requireSessionPty(session);
    // Terminal skills fallback: skill segments the CLI can't resolve natively
    // become short path-hint text before the prompt is typed into the PTY.
    const terminalSegments = await this.resolveTerminalSkillSegments(session, effectiveSegments);
    // Workspace-sandboxed agents (e.g. Command Code) can't read attachments that
    // live outside the project, so copy them in and re-format with the new paths.
    // localizeWorkspaceAttachments returns the same array when it's a no-op, so
    // reuse the already-formatted prompt unless paths actually changed.
    const ptySegments = await this.localizeWorkspaceAttachments(session, terminalSegments);
    const ptyPrompt =
      ptySegments === effectiveSegments
        ? prompt
        : this.formatSegmentsForPrompt(session, ptySegments, payload.prompt);
    this.beginBrowserEvidenceTurnForSession(session);
    await writeSubmittedPrompt(
      pty,
      session.adapter.buildDirectInput?.(
        ptyPrompt,
        ptySegments,
        session.config,
        session.projectLocation,
      ) ?? [ptyPrompt, "\r"],
      session.projectLocation,
    );

    // Optimistic working edge for CLI-hook agents with no turn-START event
    // (Command Code): show `working` the instant the prompt is sent. Gated on
    // `cliHookEnvInjected` so the authoritative `Stop` hook is guaranteed wired
    // to return the thread to idle — never strands it in `working`.
    if (session.adapter.optimisticWorkingOnSubmit && session.cliHookEnvInjected) {
      this.outputPipeline.updateState(session, "working", "working");
    }

    await sleep(300);
    if (session.prevChunk.includes("[Pasted text")) {
      pty.write("\r");
    }
  }

  async interruptThread(payload: { threadId: string }): Promise<void> {
    const session = this.sessions.get(payload.threadId);
    if (!session) {
      if (this.startLocks.has(payload.threadId)) {
        this.pendingStartInterrupts.add(payload.threadId);
        this.pendingStartAborts.add(payload.threadId);
        this.rememberRemovedThread(payload.threadId);
        this.options.emit({
          type: "thread-state",
          threadId: payload.threadId,
          status: "idle",
          attention: "none",
          canResumeWithConfig: false,
          forceCloseActiveTurn: true,
        });
        return;
      }
      // Interrupt is idempotent "ensure this thread is not running". With no
      // session there is nothing to stop, so emit the settled state instead of
      // failing — this is the lever that unsticks a row whose session died
      // while its persisted status still says `working`.
      this.options.emit({
        type: "thread-state",
        threadId: payload.threadId,
        status: "inactive",
        attention: "none",
        canResumeWithConfig: false,
        forceCloseActiveTurn: true,
      });
      return;
    }
    this.options.crossagentMcp?.cancelForeground(payload.threadId);
    await this.structuredInterruptWatchdog.interruptStructuredTurn(session);
  }

  async controlThreadGoal(payload: ControlThreadGoalPayload): Promise<void> {
    const { threadId, ...control } = payload;
    const session = this.requireSession(threadId);
    if (session.structuredSession?.controlGoal) {
      await session.structuredSession.controlGoal(control);
      return;
    }
    const prompt = session.adapter.buildGoalControlPrompt?.(control);
    if (!prompt) throw new Error(`${session.adapter.label} does not support this goal control.`);
    await this.sendThreadInput({ threadId, prompt, config: session.config });
  }

  async rollbackThreadConversation(payload: RollbackThreadConversationPayload): Promise<void> {
    if (payload.numTurns === 0) return;
    const session = this.requireSession(payload.threadId);
    if (session.status === "working") {
      throw new Error("Cannot roll back a thread while the agent is working.");
    }
    if (!session.structuredSession?.rollbackThread) {
      throw new Error(`${session.adapter.label} does not support checkpoint rollback.`);
    }

    const previousSessionId = session.sessionRef?.providerSessionId;
    const history = payload.config
      ? await session.structuredSession.rollbackThread(payload.numTurns, payload.config)
      : await session.structuredSession.rollbackThread(payload.numTurns);
    if (
      history.providerSessionId &&
      history.providerSessionId !== session.sessionRef?.providerSessionId
    ) {
      session.sessionRef = createKnownSessionRef(history.providerSessionId);
      session.canResumeWithConfig = true;
      this.indexSessionRef(session, previousSessionId);
      this.outputPipeline.emitState(session);
    }
  }

  async writeTerminal(payload: WriteTerminalPayload): Promise<void> {
    const shell = this.shellSessions.get(payload.threadId);
    if (shell) {
      shell.pty.write(payload.data);
      return;
    }
    const session = this.sessions.get(payload.threadId);
    if (!session) {
      if (this.recentlyRemovedThreadIds.has(payload.threadId)) return;
      throw new Error(`Unknown thread session: ${payload.threadId}`);
    }
    requireSessionPty(session).write(payload.data);
    this.maybeArmUserInterruptRecovery(session, payload.data);
  }

  /**
   * Type a prompt into a terminal-native thread's PTY input line WITHOUT
   * submitting it. Mirrors the segment formatting of {@link sendThreadInput}'s
   * PTY path (WSL rewrite + adapter `formatPromptSegments`) but collapses the
   * result to a single line and omits the trailing carriage return, so the text
   * lands in the agent's input line for the user to review/extend before they
   * press Enter. Used to route a browser element-picker selection straight to a
   * CLI agent. Rejects for structured (server / GUI) threads, which own input
   * through their session rather than a PTY input line.
   */
  async stageThreadInput(payload: StageThreadInputPayload): Promise<void> {
    const session = this.requireSession(payload.threadId);
    if (session.status === "inactive" || session.status === "launching") {
      throw new Error("This thread is not ready to receive terminal input yet.");
    }
    const usesStructuredFlow =
      session.adapter.capabilities.liveInputMode === "server" || session.presentationMode === "gui";
    if (usesStructuredFlow) {
      throw new Error("stageThreadInput is only supported for terminal-native threads.");
    }
    const wslSegments = payload.segments
      ? await rewriteSegmentsForWsl(payload.segments, session.projectLocation, {
          preserveImageAttachments: false,
        })
      : undefined;
    const policySegments = await this.filterPluginSkillSegments(session, wslSegments);
    const effectiveSegments = await this.localizeWorkspaceAttachments(session, policySegments);
    const formatted = this.formatSegmentsForPrompt(session, effectiveSegments, payload.prompt);
    // Collapse newlines so a raw PTY write cannot accidentally submit the line
    // (a bare \n reads as Enter to most shells/TUIs); the user submits manually.
    const singleLine = formatted.replace(/\s*\r?\n\s*/g, " ").trim();
    if (!singleLine) return;
    requireSessionPty(session).write(singleLine);
  }

  /** Renders prompt segments to text via the adapter (or the default), falling
   * back to `fallbackPrompt` when there are no segments. */
  private formatSegmentsForPrompt(
    session: SessionRuntime,
    segments: PromptSegment[] | undefined,
    fallbackPrompt: string,
  ): string {
    return segments && segments.length > 0
      ? (session.adapter.formatPromptSegments?.(segments) ?? defaultFormatPromptSegments(segments))
      : fallbackPrompt;
  }

  /** Enforce current plugin skill policy before a segment reaches a provider. */
  private async filterPluginSkillSegments(
    session: SessionRuntime,
    segments: PromptSegment[] | undefined,
  ): Promise<PromptSegment[] | undefined> {
    if (!segments?.some((segment) => segment.kind === "skill")) return segments;
    return (
      (await this.options.filterPluginSkillSegments?.({
        agentKind: session.agentKind,
        projectLocation: session.projectLocation,
        ...(session.presentationMode
          ? { presentationMode: session.presentationMode }
          : { presentationMode: session.adapter.capabilities.presentationMode }),
        ...(session.nativePlugins ? { nativePlugins: session.nativePlugins } : {}),
        segments,
      })) ?? segments
    );
  }

  /** Portable-skills fallback for a structured turn (see managerOptions). */
  private async resolveSkillTurnInjection(
    session: SessionRuntime,
    segments: readonly PromptSegment[] | undefined,
  ): Promise<string | undefined> {
    if (!segments?.some((segment) => segment.kind === "skill")) return undefined;
    return this.options.buildSkillTurnInjection?.({
      agentKind: session.agentKind,
      projectLocation: session.projectLocation,
      ...(session.nativePlugins ? { nativePlugins: session.nativePlugins } : {}),
      segments,
    });
  }

  /** Portable-skills fallback for a terminal (PTY) prompt (see managerOptions).
   * Returns the input array unchanged when no rewrite applies, so callers can
   * cheaply detect "nothing changed" by identity. */
  private async resolveTerminalSkillSegments(
    session: SessionRuntime,
    segments: PromptSegment[] | undefined,
  ): Promise<PromptSegment[] | undefined> {
    if (!segments?.some((segment) => segment.kind === "skill")) return segments;
    return (
      (await this.options.rewriteTerminalSkillSegments?.({
        agentKind: session.agentKind,
        projectLocation: session.projectLocation,
        ...(session.nativePlugins ? { nativePlugins: session.nativePlugins } : {}),
        segments,
      })) ?? segments
    );
  }

  /**
   * Copies attachments into the workspace for adapters that can only read files
   * inside their working directory (`requiresWorkspaceLocalAttachments`, e.g.
   * Command Code). No-op for other adapters and for WSL sessions (whose
   * attachments are handled by {@link rewriteSegmentsForWsl}).
   */
  private async localizeWorkspaceAttachments(
    session: SessionRuntime,
    segments: PromptSegment[] | undefined,
  ): Promise<PromptSegment[] | undefined> {
    if (!segments || segments.length === 0) return segments;
    if (!session.adapter.capabilities.requiresWorkspaceLocalAttachments) return segments;
    if (session.projectLocation.kind === "wsl") return segments;
    return rewriteSegmentsForWorkspace(segments, session.projectLocation.path);
  }

  /**
   * Fallback for Claude's hook-gap around user interrupts: arm a grace timer
   * when the user presses Esc / Ctrl+C while hooks are active and the session
   * is in a busy status. If no hook event flips state within the grace window
   * (it won't, for plain-text interrupts or permission-dialog dismiss), treat
   * it as a local idle transition. Hook-driven state changes cancel the timer
   * from `applyCliHookPluginState`.
   */
  private maybeArmUserInterruptRecovery(session: SessionRuntime, data: string): void {
    if (!session.hasCliHookPluginActivity) return;
    if (!isInterruptibleBusyStatus(session.status)) return;
    if (!isUserInterruptKeystroke(data)) return;

    if (session.userInterruptRecoveryTimer) {
      clearTimeout(session.userInterruptRecoveryTimer);
    }
    session.userInterruptRecoveryTimer = setTimeout(() => {
      session.userInterruptRecoveryTimer = undefined;
      if (!session.hasCliHookPluginActivity) return;
      if (!isInterruptibleBusyStatus(session.status)) return;
      this.outputPipeline.applyCliHookPluginState(session, {
        status: "idle",
        attention: "none",
      });
    }, USER_INTERRUPT_RECOVERY_GRACE_MS);
  }

  async resizeTerminal(payload: ResizeTerminalPayload): Promise<void> {
    const shell = this.shellSessions.get(payload.threadId);
    if (shell) {
      this.ptyLifecycle.resize(shell, payload.cols, payload.rows);
      return;
    }
    const session = this.sessions.get(payload.threadId);
    if (!session) {
      return;
    }
    session.terminalSize = { cols: payload.cols, rows: payload.rows };
    this.ptyLifecycle.resize(session, payload.cols, payload.rows);
  }

  /**
   * Stage the user's steer message and fire the cancel notification. The
   * renderer calls this when submit-while-working happens on a GUI thread.
   * Drain is automatic on cancelled-stopReason via `maybeDrainPendingSteer`.
   */
  async setPendingSteer(payload: SetPendingSteerPayload): Promise<void> {
    const session = await this.findSessionAfterPendingStart(payload.threadId);
    if (!session) {
      throw new Error(`Unknown thread session: ${payload.threadId}`);
    }
    if (payload.segments === undefined) {
      await this.steerCoordinator.setPendingSteer(session, payload);
      return;
    }
    const segments = await this.filterPluginSkillSegments(session, payload.segments);
    await this.steerCoordinator.setPendingSteer(session, { ...payload, segments });
  }

  /**
   * User aborted the steer (clicked the X on the strip). Clear the slot
   * without firing a new prompt. The cancel notification we already sent
   * still completes — the agent just stops without a replacement.
   */
  async clearPendingSteer(payload: ClearPendingSteerPayload): Promise<void> {
    const session = this.requireSession(payload.threadId);
    this.steerCoordinator.clearPendingSteerSlot(session);
  }

  async closeThread(payload: CloseThreadPayload): Promise<void> {
    this.options.releasePipedreamMcpBindings?.(payload.threadId);
    // Revoke before any asynchronous provider teardown so a bearer cannot race
    // close, restart, or a pending-start abort.
    this.revokeMcpAccessForThread(payload.threadId);
    if (!this.pendingStartMcpSettings.has(payload.threadId)) {
      this.agentSettingsPersonalMcpThreads.delete(payload.threadId);
    }
    const shell = this.shellSessions.get(payload.threadId);
    if (shell) {
      shell.ignoreExit = true;
      this.shellSessions.delete(payload.threadId);
      this.rememberRemovedThread(payload.threadId);
      this.ptyLifecycle.killShell(shell);
      await this.ptyLifecycle.waitForExit(shell);
      return;
    }

    const existing = this.sessions.get(payload.threadId);
    if (!existing) {
      if (this.startLocks.has(payload.threadId)) {
        this.pendingStartAborts.add(payload.threadId);
        this.rememberRemovedThread(payload.threadId);
      }
      return;
    }

    existing.ignoreExit = true;
    this.rememberRemovedThread(payload.threadId);
    this.outputPipeline.clearSessionTimers(existing);
    existing.stopSessionRefWatcher?.();
    existing.stopSessionRefWatcher = undefined;
    // Final state before the session disappears: without it a working thread
    // freezes at `working` in the DB and in every renderer, with nothing left
    // running to ever move it.
    this.outputPipeline.updateState(existing, "inactive", "none", undefined, {
      forceCloseActiveTurn: true,
    });
    this.sessions.delete(payload.threadId);
    if (existing.sessionRef?.providerSessionId) {
      this.sessionsBySessionId.delete(existing.sessionRef.providerSessionId);
    }
    this.runtimeEventRouter.clearAllForThread(payload.threadId);
    void this.options.crossagentMcp?.cancelAll(payload.threadId);
    this.options.crossagentMcp?.unregister(payload.threadId);
    await existing.structuredSession?.dispose();
    if (existing.structuredSession) {
      await sleep(150);
    }
    this.ptyLifecycle.kill(existing);
    await this.ptyLifecycle.waitForExit(existing);
  }

  async startShell(payload: StartShellPayload): Promise<void> {
    ensureNodePtySpawnHelperExecutable();
    this.recentlyRemovedThreadIds.delete(payload.shellId);
    const existing = this.shellSessions.get(payload.shellId);
    if (existing) {
      existing.ignoreExit = true;
      this.shellSessions.delete(payload.shellId);
      this.ptyLifecycle.killShell(existing);
    }

    // Capture project-scoped shell env (fnm / nvm / asdf / mise cd-hooks
    // fire when the prime probe runs inside the project root) so the
    // user's pinned Node/Python/Ruby are on PATH before the PTY spawns.
    if (shouldPrimeNativeProjectShellEnv(payload.projectLocation)) {
      await primeProjectShellEnv(payload.projectLocation.path);
    }

    const windowsShell =
      process.platform === "win32" && payload.projectLocation.kind === "windows"
        ? this.options.resolveWindowsShell(
            payload.windowsShellRuntime === "powershell" ? "powershell" : "preferred",
          )
        : { shell: "", kind: "cmd" as const, args: [] };
    const shellCommand = buildShellCommand(payload.projectLocation, windowsShell, {
      startInHome: payload.startInHome === true,
    });
    this.options.emit({ type: "thread-reset", threadId: payload.shellId });
    const terminalEnv = resolveTerminalColorEnv(payload.projectLocation);

    // node-pty's C binding expects every env value to be a string. process.env
    // is typed `Record<string, string | undefined>` and spreading can carry
    // undefined holes that surface as opaque "posix_spawnp failed" errors.
    const shellEnv: Record<string, string> = {
      ...sanitizedProcessEnv,
      ...terminalEnv,
    };
    if (payload.projectLocation.kind === "wsl") {
      const existingWslEnv = process.env.WSLENV ?? "";
      const wslEnvNames = new Set(
        existingWslEnv.split(":").map((value) => value.replace(/\/.*/, "")),
      );
      const missingNames = Object.keys(terminalEnv).filter((name) => !wslEnvNames.has(name));
      if (missingNames.length > 0) {
        shellEnv.WSLENV = [...(existingWslEnv ? [existingWslEnv] : []), ...missingNames].join(":");
      }
    } else {
      // A new native shell (terminal tab or the login/install overlay) should
      // see the same PATH a freshly-opened PowerShell would, not the
      // supervisor's launch-time snapshot. Re-read the registry-backed PATH at
      // spawn time so a CLI installed after launch (e.g. just-installed `grok`)
      // is on PATH without an app restart. Only `Path`/`PATH` are touched to
      // avoid reintroducing the undefined-value holes a raw process.env spread
      // would carry.
      const refreshedPath = getRefreshedWindowsPath();
      if (refreshedPath) {
        shellEnv.Path = refreshedPath;
        shellEnv.PATH = refreshedPath;
      }
    }

    // Start the PTY at the renderer-reported xterm size so the shell's first
    // output (Node deprecation warnings, dev server banners, etc.) wraps to
    // the actual viewport — those lines are emitted before any resize IPC
    // can land, and xterm never reflows pre-wrapped scrollback. Fall back to
    // 120×30 only if the renderer hasn't measured yet.
    let pty;
    try {
      pty = spawn(shellCommand.command, shellCommand.args, {
        name: process.platform === "win32" ? "xterm-color" : terminalEnv.TERM,
        cols: payload.initialSize?.cols ?? 120,
        rows: payload.initialSize?.rows ?? 30,
        ...(shellCommand.cwd ? { cwd: shellCommand.cwd } : {}),
        env: shellEnv,
      });
    } catch (error) {
      throw new Error(describeSpawnFailure("shell", shellCommand, shellEnv, error), {
        cause: error,
      });
    }

    const session: ShellSessionRuntime = {
      instanceId: randomUUID(),
      shellId: payload.shellId,
      pty,
      projectLocation: payload.projectLocation,
      outputLength: 0,
      outputTranscript: new TranscriptBuffer(200_000),
      ...(payload.worktreePath ? { worktreePath: payload.worktreePath } : {}),
    };

    this.shellSessions.set(payload.shellId, session);
    this.ptyLifecycle.track(session);
    pty.onData((data) => {
      if (this.shellSessions.get(payload.shellId)?.instanceId !== session.instanceId) {
        return;
      }
      session.outputLength += data.length;
      session.outputTranscript.append(data);
      if (this.options.isDev) {
        this.logWriter.append(this.resolveLogPath(payload.shellId.replace(/:/g, "_")), data);
      }
      this.options.emit({
        type: "thread-output",
        threadId: payload.shellId,
        data,
        outputLength: session.outputLength,
      });
    });

    pty.onExit(({ exitCode }) => {
      this.ptyLifecycle.resolveExit(session);
      if (session.ignoreExit) {
        return;
      }
      this.shellSessions.delete(payload.shellId);
      this.rememberRemovedThread(payload.shellId);
      this.options.emit({
        type: "thread-exited",
        threadId: payload.shellId,
        exitCode: exitCode ?? null,
      });
    });
  }

  async resolveThreadServerRequest(payload: ResolveThreadServerRequestPayload): Promise<void> {
    // Forwarded subagent requests carry a run-namespaced id; route them to the
    // owning child handle first and only fall through to the parent session
    // when the id isn't a subagent request.
    if (this.options.crossagentMcp?.resolveChildRequest(payload.requestId, payload.response)) {
      return;
    }
    const session = this.requireSession(payload.threadId);
    if (!session.structuredSession?.resolveServerRequest) {
      throw new Error(`Thread ${payload.threadId} does not support server request resolution.`);
    }
    await session.structuredSession.resolveServerRequest(payload.requestId, payload.response);
  }

  readTerminalScrollback(threadId: string): string {
    return this.outputPipeline.readTerminalScrollback(
      this.sessions.get(threadId) ?? this.shellSessions.get(threadId),
    );
  }

  readTerminalSize(threadId: string): TerminalSize | null {
    return this.sessions.get(threadId)?.terminalSize ?? null;
  }

  handlePtyDataForTests(session: SessionRuntime, data: string): void {
    this.outputPipeline.handlePtyData(session, data);
  }

  spawnThreadForTests(input: SpawnThreadInput): SessionRuntime {
    return this.spawnPipeline.spawnThread(input);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const threadId of this.startLocks.keys()) {
      this.pendingStartAborts.add(threadId);
    }

    this.runtimeEventRouter.flush();
    await Promise.allSettled(
      [...this.sessions.values()].map(async (session) => {
        session.ignoreExit = true;
        this.rememberRemovedThread(session.threadId);
        this.outputPipeline.clearSessionTimers(session);
        await session.structuredSession?.dispose();
        this.ptyLifecycle.kill(session);
      }),
    );
    this.sessions.clear();
    this.sessionsBySessionId.clear();
    this.agentSettingsPersonalMcpThreads.clear();
    this.agentMcpSettingsReloadEpochs.clear();
    this.rootMcpLaunchAuthorities.clear();
    this.subagentMcpLaunchAuthorities.clear();
    this.subagentMcpResolutionRequests.clear();
    this.browserEvidenceTurns.clear();

    for (const shell of this.shellSessions.values()) {
      shell.ignoreExit = true;
      this.rememberRemovedThread(shell.shellId);
      this.ptyLifecycle.killShell(shell);
    }
    this.shellSessions.clear();
    this.logWriter.dispose();
  }

  private requireSession(threadId: string): SessionRuntime {
    const session = this.sessions.get(threadId);
    if (!session) {
      throw new Error(`Unknown thread session: ${threadId}`);
    }
    return session;
  }

  /**
   * Input can race an in-progress reconnect before `spawnPipeline` publishes
   * the new SessionRuntime. Wait for that thread's serialized start instead of
   * surfacing a false "Unknown thread session" error. Callers still decide
   * normal-turn vs steer from the authoritative session status after startup.
   */
  private async findSessionAfterPendingStart(
    threadId: string,
  ): Promise<SessionRuntime | undefined> {
    const live = this.sessions.get(threadId);
    if (live) return live;
    const pendingStart = this.startLocks.get(threadId);
    if (!pendingStart) return undefined;
    await pendingStart;
    return this.sessions.get(threadId);
  }

  private rememberRemovedThread(threadId: string): void {
    this.recentlyRemovedThreadIds.delete(threadId);
    this.recentlyRemovedThreadIds.add(threadId);
    if (this.recentlyRemovedThreadIds.size <= RECENTLY_REMOVED_THREAD_LIMIT) return;
    const oldest = this.recentlyRemovedThreadIds.values().next().value;
    if (oldest !== undefined) {
      this.recentlyRemovedThreadIds.delete(oldest);
    }
  }

  private isCurrentSession(session: SessionRuntime): boolean {
    return this.sessions.get(session.threadId)?.instanceId === session.instanceId;
  }

  private pollSessionRefDiscovery(session: SessionRuntime): void {
    let attempt = 0;
    let polling = false;
    const existingIds = new Set<string>();
    for (const activeSession of this.sessions.values()) {
      if (activeSession.sessionRef && activeSession.threadId !== session.threadId) {
        existingIds.add(activeSession.sessionRef.providerSessionId);
      }
    }

    const poll = async (force = false) => {
      if (polling || session.sessionRef || session.status === "inactive") {
        return;
      }
      if (!force && attempt >= 5) {
        return;
      }
      polling = true;
      if (!force) {
        attempt += 1;
      }
      try {
        const ref = await session.adapter.discoverSessionRef?.(session.projectLocation);
        if (ref && !session.sessionRef && !existingIds.has(ref.providerSessionId)) {
          session.sessionRef = ref;
          session.canResumeWithConfig = true;
          this.indexSessionRef(session, undefined);
          session.stopSessionRefWatcher?.();
          session.stopSessionRefWatcher = undefined;
          this.outputPipeline.emitState(session);
          return;
        }
      } catch {
        // retry later
      } finally {
        polling = false;
      }
      if (!force && attempt < 5) {
        setTimeout(() => void poll(), 3000);
      }
    };

    session.stopSessionRefWatcher = session.adapter.watchSessionRef?.(
      session.projectLocation,
      () => void poll(true),
    );
    const initialDelay = session.adapter.initialSessionRefDiscoveryDelayMs ?? 0;
    if (initialDelay > 0) {
      setTimeout(() => void poll(), initialDelay);
      return;
    }
    void poll();
  }

  private recoverInvalidSessionRef(session: SessionRuntime): void {
    void this.invalidSessionRecovery.recover(session);
  }

  private resolveLogPath(threadId: string): string {
    return join(this.options.logsDir, `${threadId}.log`);
  }

  private resolveHintLogPath(threadId: string): string {
    return join(this.options.logsDir, `${threadId}.hints.log`);
  }

  private resolveAgentSettings(adapter: AgentAdapter): Record<string, boolean | string> {
    const settings = readSupervisorSharedSettings(this.options.settingsPath);
    return {
      ...(adapter.capabilities.agentSettingsDefaults ?? {}),
      ...(settings.agentSettings[adapter.kind] ?? {}),
    };
  }
}
