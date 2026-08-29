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
  SpawnPipeline,
  workspaceLaunchConfig,
  type SpawnThreadInput,
} from "./threadSession/spawnPipeline";
import { StructuredTurnQueue } from "./threadSession/structuredTurnQueue";
import { StructuredFailureReporter } from "./threadSession/structuredFailureReporter";
import { readSupervisorSharedSettings } from "./supervisorSharedSettings";

export { isUserInterruptKeystroke, USER_INTERRUPT_RECOVERY_GRACE_MS, writeSubmittedPrompt };
export type { ThreadSessionManagerOptions };

const RECENTLY_REMOVED_THREAD_LIMIT = 256;

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

interface BrowserEvidenceTurnLedger {
  launchId: string;
  turnId: string;
  /** Canonical item ids, capped so a runaway page loop cannot grow this ledger. */
  actionItemIds: string[];
}

export class ThreadSessionManager {
  readonly sessions = new Map<string, SessionRuntime>();
  readonly shellSessions = new Map<string, ShellSessionRuntime>();
  /** Reverse index: agent-native session id → SessionRuntime, for CLI hook routing fallback. */
  readonly sessionsBySessionId = new Map<string, SessionRuntime>();
  private readonly startLocks = new Map<string, Promise<void>>();
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
  /** App-owned proof for only the latest accepted user turn of each live task. */
  private readonly browserEvidenceTurns = new Map<string, BrowserEvidenceTurnLedger>();
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
      startStructuredTurn: (session, turn) => this.structuredTurnQueue.start(session, turn),
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
   * Accept one private main-process Browser report only when its signed launch
   * and supervisor-issued turn nonce are both still current. Failed calls,
   * delayed callbacks, closed tasks, and prior launches produce no proof row.
   */
  recordBrowserMcpToolCall(payload: BrowserMcpToolCallReport): boolean {
    if (!payload.success) return false;
    // Connection/control and tab-directory calls prove only that the MCP is
    // reachable. Require a real page navigation, inspection, or interaction
    // before minting evidence used by the final-response badge.
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
    if (ledger.actionItemIds.length >= MAX_BROWSER_EVIDENCE_ACTIONS_PER_TURN) return false;

    const itemId = `browser-evidence-${randomUUID()}`;
    const browserEvidence: NonNullable<ToolCallPayload["browserEvidence"]> = {
      source: Y_SPACE_BROWSER_EVIDENCE_SOURCE,
      occurredAt: payload.occurredAt,
      ...(payload.tabId ? { tabId: payload.tabId } : {}),
      ...(payload.url ? { url: payload.url } : {}),
      ...(payload.title ? { title: payload.title } : {}),
    };
    const toolPayload: ToolCallPayload = {
      name: payload.toolName,
      serverId: "browser",
      status: "success",
      browserEvidence,
    };
    ledger.actionItemIds.push(itemId);
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
    // Pipedream relays carry their own launch bearer, so rotate those alongside
    // the built-in capability nonce before a restart/recovery can begin.
    this.options.releasePipedreamMcpBindings?.(authorization.identity.threadId);
    this.revokeSubagentMcpAccessForParent(authorization.identity.threadId);
    const turnId = authorization.identity.browserEvidenceTurnId ?? randomUUID();
    authorization.identity.browserEvidenceTurnId = turnId;
    this.setBrowserEvidenceTurn(
      authorization.identity.threadId,
      authorization.identity.launchId,
      turnId,
    );
    this.rootMcpLaunchAuthorities.set(authorization.identity.threadId, {
      phase: "pending",
      authorization,
    });
  }

  private activateMcpLaunchAuthorization(session: SessionRuntime): void {
    const identity = session.mcpIdentity;
    if (!identity?.threadId || !identity.launchId) return;
    const current = this.rootMcpLaunchAuthorities.get(identity.threadId);
    if (
      !current ||
      current.phase !== "pending" ||
      current.authorization.identity.launchId !== identity.launchId
    ) {
      return;
    }
    this.rootMcpLaunchAuthorities.set(identity.threadId, {
      phase: "active",
      authorization: {
        ...current.authorization,
        identity: identity as McpLaunchIdentity,
        config: session.config,
        launchConfig: session.launchConfig ?? current.authorization.launchConfig,
        mcpLaunchSnapshot: session.mcpLaunchSnapshot,
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
      },
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
      this.options.releasePipedreamMcpBindings?.(identity.threadId);
      return;
    }
    // Close/dispose can remove the authority while async launch resolution is
    // still unwinding. Release any relay created after that earlier cleanup.
    if (!current) this.options.releasePipedreamMcpBindings?.(identity.threadId);
  }

  private revokeMcpAccessForThread(threadId: string): void {
    this.rootMcpLaunchAuthorities.delete(threadId);
    this.browserEvidenceTurns.delete(threadId);
    this.revokeSubagentMcpAccessForParent(threadId);
  }

  private revokeSubagentMcpAccessForParent(parentThreadId: string): void {
    for (const [childThreadId, authority] of this.subagentMcpLaunchAuthorities) {
      if (authority.parentThreadId === parentThreadId) {
        this.subagentMcpLaunchAuthorities.delete(childThreadId);
        this.options.releasePipedreamMcpBindings?.(childThreadId);
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
    const session = this.sessions.get(threadId);
    if (!session || !this.isCurrentSession(session) || session.ignoreExit === true) return {};
    const targetAdapter = this.options.adapters.get(targetAgentKind);
    if (!targetAdapter || !identity.threadId) return {};
    const mcpLaunchSnapshot = session.mcpLaunchSnapshot;
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
      identity.threadId,
    );
    const childIdentity: McpLaunchIdentity = {
      ...identity,
      threadId: identity.threadId,
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
    };
    this.subagentMcpLaunchAuthorities.set(childIdentity.threadId, {
      parentThreadId: threadId,
      parentSessionInstanceId: session.instanceId,
      authorization,
    });
    try {
      const mcpServers = await this.spawnPipeline.resolveMcpServersForLaunch({
        location: session.projectLocation,
        config: launchConfig,
        mcpLaunchSnapshot,
        identity: childIdentity,
        adapter: targetAdapter,
        presentationMode: "gui",
      });
      if (!this.isCurrentSession(session) || Boolean(session.ignoreExit)) {
        this.releaseSubagentParentMcpAccess(threadId, childIdentity.threadId);
        return {};
      }
      return mcpServers.length > 0 || targetAdapter.capabilities.mcpConfigSource === "agentSettings"
        ? { mcpServers }
        : {};
    } catch (error) {
      this.releaseSubagentParentMcpAccess(threadId, childIdentity.threadId);
      throw error;
    }
  }

  releaseSubagentParentMcpAccess(parentThreadId: string, childThreadId: string): void {
    const authority = this.subagentMcpLaunchAuthorities.get(childThreadId);
    if (authority && authority.parentThreadId !== parentThreadId) return;
    this.subagentMcpLaunchAuthorities.delete(childThreadId);
    this.options.releasePipedreamMcpBindings?.(childThreadId);
  }

  /**
   * Apply a provider-level MCP settings change (the provider settings page's
   * Save) to the provider's live sessions. Only meaningful for adapters that
   * declare `mcpConfigSource: "agentSettings"` — their MCP set is re-resolved
   * from the freshly saved settings and each structured session that exposes
   * `updateMcpServers` applies the new set to its directory instance. Terminal
   * threads and sessions without the hook pick the change up on next launch.
   * Per-session failures are logged, never fatal: one broken directory update
   * must not strand the remaining sessions on the old set.
   */
  async reloadAgentMcpServers(payload: ReloadAgentMcpServersPayload): Promise<void> {
    const reloads: Promise<void>[] = [];
    for (const session of this.sessions.values()) {
      if (session.agentKind !== payload.agentKind) continue;
      if (session.adapter.capabilities.mcpConfigSource !== "agentSettings") continue;
      const update = session.structuredSession?.updateMcpServers?.bind(session.structuredSession);
      if (!update) continue;
      reloads.push(
        (async () => {
          try {
            const refreshed = await this.resolveCurrentMcpLaunchSnapshot(session);
            if (!this.isCurrentSession(session)) return;
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
            if (!this.isCurrentSession(session)) return;
            await update(mcpServers);
            if (!this.isCurrentSession(session)) return;
            session.mcpLaunchSnapshot = refreshed.snapshot;
            session.nativePlugins = refreshed.nativePlugins;
            session.launchConfig = launchConfig;
            this.refreshActiveMcpLaunchAuthorization(session);
            this.outputPipeline.emitState(session);
          } catch (error) {
            console.warn(
              `[supervisor] failed to reload MCP servers for thread ${session.threadId}:`,
              error,
            );
          }
        })(),
      );
    }
    await Promise.all(reloads);
  }

  /** Re-read provider-level custom MCPs instead of replaying launch-time settings. */
  private async resolveCurrentMcpLaunchSnapshot(session: SessionRuntime): Promise<{
    snapshot: McpLaunchSnapshot;
    nativePlugins: readonly AgentNativePlugin[];
  }> {
    const settings = readSupervisorSharedSettings(this.options.settingsPath);
    const pluginContributions = (await this.options.resolvePluginLaunchContributions?.(
      session.projectLocation,
      session.agentKind,
    )) ?? { mcpServers: [], builtInMcpServerIds: [], nativePlugins: [] };

    const userMcpServers = mergeMcpServers(
      settings.mcpServers,
      session.mcpLaunchSnapshot.projectMcpServers ?? [],
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
        ...session.mcpLaunchSnapshot,
        mcpServers,
        pluginBuiltInMcpServerIds: pluginContributions.builtInMcpServerIds,
      };
      const effectiveConfig = this.spawnPipeline.resolveMcpLaunchConfig(
        workspaceLaunchConfig(
          session.projectLocation,
          session.config,
          session.adapter,
          candidateSnapshot.disabledBuiltInMcpServerIds,
          candidateSnapshot.pluginBuiltInMcpServerIds,
        ),
        candidateSnapshot,
        session.adapter,
        session.threadId,
      );
      mcpServers = await this.options.prepareMcpToolFilters(
        mcpServers,
        session.projectLocation,
        effectiveConfig.browserMcp === true,
      );
    }

    return {
      snapshot: {
        ...session.mcpLaunchSnapshot,
        mcpServers,
        pluginBuiltInMcpServerIds: pluginContributions.builtInMcpServerIds,
      },
      nativePlugins: pluginContributions.nativePlugins,
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
    } finally {
      this.startLocks.delete(threadId);
      if (!this.sessions.has(threadId)) {
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
      this.structuredTurnQueue.start(session, {
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
    this.options.crossagentMcp?.cancelAll(payload.threadId);
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
    this.rootMcpLaunchAuthorities.clear();
    this.subagentMcpLaunchAuthorities.clear();
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
