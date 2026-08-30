import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { spawn } from "node-pty";
import {
  applyHomeScopePermissions,
  type UnrestrictedPermissionCapabilities,
} from "@/shared/agents/unrestrictedPermissions";
import {
  type AgentKind,
  type CloseThreadPayload,
  type ProjectLocation,
  type PromptSegment,
  type SessionRef,
  type StartThreadPayload,
  type StartThreadResult,
  type TerminalSize,
  type ThreadAttention,
  type ThreadConfig,
  type ThreadPresentationMode,
  type ThreadStatus,
  type BuiltInMcpServerId,
  type McpLaunchSnapshot,
  type ResolvedMcpServer,
  BUILT_IN_MCP_SERVER_NAMES,
  DEFAULT_MCP_SERVER_TIMEOUT_MS,
  isPipedreamPersonalMcpUrl,
  resolveEnabledMcpServers,
} from "@/shared/contracts";
import type { McpThreadIdentity } from "@/shared/browserMcpThread";
import {
  filterCompetingBrowserMcpServers,
  hasYSpaceBrowserMcp,
} from "@/shared/browserExclusivePolicy";
import type { AgentNativePlugin } from "@/supervisor/agents/base";
import {
  resolveBrowserMcpHttpConfigForLaunch,
  type BrowserMcpHttpConfig,
} from "@/supervisor/agents/browserMcp";
import {
  resolveCrossagentMcpHttpConfigForLaunch,
  type CrossagentMcpHttpConfig,
} from "@/supervisor/agents/crossagentMcp";
import {
  resolveComputerUseMcpHttpConfigForLaunch,
  type ComputerUseMcpHttpConfig,
} from "@/supervisor/agents/computerUseMcp";
import {
  resolveAppControlsMcpHttpConfigForLaunch,
  type AppControlsMcpHttpConfig,
} from "@/supervisor/agents/appControlsMcp";
import {
  type AgentAdapter,
  type AgentLaunchOptions,
  type CommandSpec,
  type StructuredSessionHandle,
  createKnownSessionRef,
  defaultFormatPromptSegments,
  injectWslEnv,
  primeProjectShellEnv,
  resolveLaunchSpec,
  mergeSpawnEnv,
} from "../../agents/base";
import { captureSupervisorException } from "../../diagnostics/sentry";
import {
  attachMcpToolFilterCleanup,
  combineMcpToolFilterCleanups,
  getMcpToolFilterCleanup,
} from "../../mcp/McpToolFilterService";
import { ensureNodePtySpawnHelperExecutable } from "../../nodePty";
import type { QueuedStructuredTurn, SessionRuntime } from "../sessionTypes";
import type { ThreadOutputPipeline } from "../threadOutputPipeline";
import { rewriteSegmentsForWsl } from "../threadAttachments";
import { applyLaunchArgsConfigRewrite, mergeCliHookExtraArgs } from "./cliHookArgs";
import type { CliHookSessionCoordinator } from "./cliHookPlugin";
import { shouldPrimeNativeProjectShellEnv } from "./helpers";
import type { ThreadSessionManagerOptions } from "./managerOptions";
import type { PtyLifecycle } from "./ptyLifecycle";
import type { RuntimeEventRouter } from "./runtimeEventRouter";
import {
  StructuredRuntimeDiagnosticError,
  structuredRuntimeFeatureArea,
} from "./structuredRuntimeDiagnosticError";
import {
  describeSpawnFailure,
  sanitizeChildProcessEnv,
  sanitizeEnv,
  sanitizedProcessEnv,
} from "./spawnDiagnostics";
import type { SessionRuntimeLifecycle } from "./sessionRuntimeLifecycle";
import { getIterm2StatusL2TerminalEnv, resolveTerminalColorEnv } from "./terminalEnv";

export interface SpawnThreadInput {
  threadId: string;
  agentKind: AgentKind;
  adapter: AgentAdapter;
  projectLocation: ProjectLocation;
  config: ThreadConfig;
  initialSize: TerminalSize;
  launchPrompt: string;
  command?: CommandSpec;
  /**
   * Extra env injected into the agent PTY (merged on top of agentEnv +
   * provider spawnEnv). Currently used by the CLI hook ingress to ferry
   * `PORACODE_HOOK_URL` / `PORACODE_HOOK_SECRET` / `PORACODE_THREAD_ID` etc.
   */
  extraEnv?: Record<string, string>;
  structuredSession?: StructuredSessionHandle;
  sessionRef?: SessionRef;
  pendingLaunchPrompt?: string;
  pendingTerminalPreInputs?: string[][];
  pendingTerminalPrompt?: string;
  pendingTerminalSegments?: PromptSegment[];
  /** Exact lease for private skill copies used by this launch/resume terminal turn. */
  terminalSkillLeaseId?: string;
  presentationMode?: ThreadPresentationMode;
  initialStatus?: ThreadStatus;
  initialAttention?: ThreadAttention;
  suppressInitialStructuredIdle?: boolean;
  mcpLaunchSnapshot: McpLaunchSnapshot;
  launchConfig?: ThreadConfig;
  nativePlugins?: readonly AgentNativePlugin[];
  /** Trusted app-thread identity used to scope built-in MCP calls. */
  mcpIdentity?: McpThreadIdentity;
  /** Owns WSL filter deployments used by this exact provider process. */
  mcpToolFilterCleanup?: () => void;
}

export type McpLaunchIdentity = McpThreadIdentity & {
  threadId: string;
  launchId: string;
};

/** Authorization state published before a provider can make its first MCP call. */
export interface McpLaunchAuthorization {
  identity: McpLaunchIdentity;
  adapter: AgentAdapter;
  config: ThreadConfig;
  launchConfig: ThreadConfig;
  mcpLaunchSnapshot: McpLaunchSnapshot;
  /**
   * Supervisor-owned generation for the Personal localhost capability.
   * Sign-out advances it so an already-resolving launch cannot publish a
   * process containing a capability minted before credential revocation.
   */
  personalMcpCredentialEpoch?: number;
  /**
   * Supervisor-owned revision for any MCP launch configuration that can change
   * while a provider is being created (Pipedream grants or agent settings).
   */
  mcpLaunchConfigurationEpoch?: number;
}

export class McpLaunchConfigurationChangedError extends Error {
  constructor() {
    super(
      "Integration settings changed while this agent was starting; retrying with current access.",
    );
    this.name = "McpLaunchConfigurationChangedError";
  }
}

/**
 * Per-launch config with plugin-bundled built-in MCPs enabled and globally
 * hard-disabled servers cleared. Together with the `resolve*ForLaunch` gates,
 * this keeps both policies at one provider boundary. The original per-thread
 * config stays on `SessionRuntime`; plugin contributions stay in its launch
 * snapshot for restart and recovery.
 */
export function effectiveLaunchConfig(
  config: ThreadConfig,
  disabledBuiltInMcpServerIds: readonly BuiltInMcpServerId[],
  pluginBuiltInMcpServerIds: readonly BuiltInMcpServerId[] = [],
  forceBrowser = true,
): ThreadConfig {
  const withDefaults =
    !forceBrowser || config.browserMcp === true ? config : { ...config, browserMcp: true };
  if (disabledBuiltInMcpServerIds.length === 0 && pluginBuiltInMcpServerIds.length === 0) {
    return withDefaults;
  }
  const next = { ...withDefaults };
  if (forceBrowser && pluginBuiltInMcpServerIds.includes("browser")) next.browserMcp = true;
  if (pluginBuiltInMcpServerIds.includes("crossagents")) next.crossagentMcp = true;
  if (pluginBuiltInMcpServerIds.includes("computer-use")) next.computerUse = true;
  if (disabledBuiltInMcpServerIds.includes("browser")) next.browserMcp = false;
  if (disabledBuiltInMcpServerIds.includes("crossagents")) next.crossagentMcp = false;
  if (disabledBuiltInMcpServerIds.includes("computer-use")) next.computerUse = false;
  return next;
}

/**
 * Launch config for a workspace: MCP flag gating plus Home-scope unrestricted
 * approval/sandbox so every agent (not just ACP) can read and write anywhere
 * when the session is the projectless Home folder.
 */
export function workspaceLaunchConfig(
  location: ProjectLocation,
  config: ThreadConfig,
  adapter: {
    capabilities: UnrestrictedPermissionCapabilities;
    browserRouting?: AgentAdapter["browserRouting"];
  },
  disabledBuiltInMcpServerIds: readonly BuiltInMcpServerId[],
  pluginBuiltInMcpServerIds: readonly BuiltInMcpServerId[] = [],
): ThreadConfig {
  return applyHomeScopePermissions(
    location,
    effectiveLaunchConfig(
      config,
      disabledBuiltInMcpServerIds,
      pluginBuiltInMcpServerIds,
      Object.values(adapter.browserRouting ?? {}).includes("exclusive"),
    ),
    adapter.capabilities,
  );
}

/**
 * Launch config for providers that declare `mcpConfigSource: "agentSettings"`:
 * the built-in MCP flags come from the provider's saved settings
 * (`sharedSettings.agentSettings[kind]`) instead of the per-thread composer
 * flags. Crossagents remains off unless the provider explicitly supports
 * trusted routing. Providers may use either a direct thread credential or a
 * provider-native session credential, as declared by their adapter.
 */
export function applyAgentSettingsMcpFlags(
  config: ThreadConfig,
  agentSettings: Record<string, boolean | string>,
  disabledBuiltInMcpServerIds: readonly BuiltInMcpServerId[],
  crossagentRoutingAvailable: boolean,
): ThreadConfig {
  return effectiveLaunchConfig(
    {
      ...config,
      browserMcp: agentSettings.browserMcp === true,
      computerUse: agentSettings.computerUse === true,
      crossagentMcp: crossagentRoutingAvailable && agentSettings.crossagentMcp === true,
    },
    disabledBuiltInMcpServerIds,
  );
}

export function usesProviderSessionCrossagentRouting(
  adapter:
    | {
        kind?: AgentKind;
        capabilities: {
          presentationMode: ThreadPresentationMode;
          crossagentMcpRouting?: AgentAdapter["capabilities"]["crossagentMcpRouting"];
        };
      }
    | undefined,
  presentationMode: ThreadPresentationMode | undefined,
  crossagentThreadId: string | undefined,
): boolean {
  return (
    adapter?.capabilities.crossagentMcpRouting === "provider-session" &&
    (presentationMode ?? adapter.capabilities.presentationMode) !== "terminal" &&
    crossagentThreadId !== undefined
  );
}

export function composeResolvedMcpServers(
  snapshot: McpLaunchSnapshot,
  browserMcp: BrowserMcpHttpConfig | undefined,
  crossagentMcp: CrossagentMcpHttpConfig | undefined,
  computerUseMcp: ComputerUseMcpHttpConfig | undefined,
  appControlsMcp: AppControlsMcpHttpConfig | undefined,
): ResolvedMcpServer[] {
  const http = (
    id: BuiltInMcpServerId,
    config:
      | {
          url: string;
          headers: Record<string, string>;
          disabledTools?: readonly string[];
        }
      | undefined,
    timeoutMs = DEFAULT_MCP_SERVER_TIMEOUT_MS,
    approvalMode?: "approve",
  ): ResolvedMcpServer | undefined =>
    config
      ? {
          id,
          name: BUILT_IN_MCP_SERVER_NAMES[id],
          timeoutMs,
          transport: { type: "http", url: config.url, headers: config.headers },
          ...(config.disabledTools && config.disabledTools.length > 0
            ? { disabledTools: [...config.disabledTools] }
            : {}),
          ...(approvalMode ? { approvalMode } : {}),
        }
      : undefined;
  const managedBrowserMcp = snapshot.disabledBuiltInMcpServerIds.includes("browser")
    ? undefined
    : browserMcp;
  const baseServers = managedBrowserMcp
    ? filterCompetingBrowserMcpServers(snapshot.mcpServers)
    : [...snapshot.mcpServers];
  return [
    ...baseServers,
    http("browser", managedBrowserMcp),
    http("crossagents", crossagentMcp, 300_000, "approve"),
    http("computer-use", computerUseMcp),
    http("app-controls", appControlsMcp),
  ].filter((server): server is ResolvedMcpServer => server !== undefined);
}

/**
 * Everything the spawn pipeline borrows from the manager. The pipeline owns
 * process creation (structured-session bring-up, argv assembly, PTY spawn,
 * runtime construction); the injected lifecycle owns registration and event
 * bindings, while the manager keeps terminal I/O, teardown, and ref recovery.
 */
export interface SpawnPipelineContext {
  options: ThreadSessionManagerOptions;
  sessions: Map<string, SessionRuntime>;
  pendingStartInterrupts: Set<string>;
  pendingStartAborts: Set<string>;
  ptyLifecycle: PtyLifecycle;
  outputPipeline: ThreadOutputPipeline;
  runtimeEventRouter: RuntimeEventRouter;
  sessionRuntimeLifecycle: Pick<SessionRuntimeLifecycle, "attach">;
  cliHookPlugin: CliHookSessionCoordinator;
  closeThread(payload: CloseThreadPayload): Promise<void>;
  failStructuredSession(session: SessionRuntime, error: unknown): void;
  isCurrentSession(session: SessionRuntime): boolean;
  resolveAgentSettings(adapter: AgentAdapter): Record<string, boolean | string>;
  beginMcpLaunchAuthorization(authorization: McpLaunchAuthorization): void;
  activateMcpLaunchAuthorization(session: SessionRuntime): void;
  /** Fail closed immediately before process creation/runtime publication. */
  assertMcpLaunchAuthorizationCurrent?(identity: McpLaunchIdentity): void;
  /** Capture the credential generation before any asynchronous launch work. */
  getPersonalMcpCredentialEpoch?(): number;
  /** Capture the shared MCP launch revision before asynchronous provider work. */
  getMcpLaunchConfigurationEpoch?(): number;
  /** Rebuild current settings/plugin inputs before retrying a superseded launch. */
  refreshPendingMcpLaunchSnapshot?(input: {
    threadId: string;
    agentKind: AgentKind;
    adapter: AgentAdapter;
    projectLocation: ProjectLocation;
    config: ThreadConfig;
    mcpLaunchSnapshot: McpLaunchSnapshot;
  }): Promise<{
    mcpLaunchSnapshot: McpLaunchSnapshot;
    nativePlugins: readonly AgentNativePlugin[];
  }>;
  revokeMcpLaunchAuthorization(identity: McpLaunchIdentity): void;
  emitOptimisticUserMessage(
    threadId: string,
    prompt: string,
    segments?: PromptSegment[],
    requestedItemId?: string,
  ): string;
}

const MAX_MCP_LAUNCH_CONFIGURATION_RETRIES = 2;

/**
 * Spawn orchestration for agent threads: initial launches, restarts of
 * inactive-but-resumable threads, and the shared `spawnThread` runtime-session
 * assembly they (and invalid-session-ref recovery) all funnel through.
 * Extracted from `ThreadSessionManager`.
 */
export class SpawnPipeline {
  constructor(private readonly ctx: SpawnPipelineContext) {}

  async startThreadInner(
    payload: StartThreadPayload & { threadId: string },
    terminalSkillLeaseId: string = randomUUID(),
  ): Promise<StartThreadResult> {
    const ctx = this.ctx;
    let personalMcpCredentialEpoch = ctx.getPersonalMcpCredentialEpoch?.() ?? 0;
    let mcpLaunchConfigurationEpoch = ctx.getMcpLaunchConfigurationEpoch?.() ?? 0;
    await ctx.closeThread({ threadId: payload.threadId });
    if (ctx.pendingStartAborts.delete(payload.threadId)) {
      ctx.pendingStartInterrupts.delete(payload.threadId);
      return { threadId: payload.threadId };
    }

    const adapter = this.requireAdapter(payload.agentKind);
    const isServerControlled = adapter.capabilities.liveInputMode === "server";
    // Per-thread mode wins over the adapter default. Chat-mode threads route
    // input/output through the structured session even for adapters whose
    // `liveInputMode` is "terminal".
    const requestedPresentation = payload.presentationMode ?? adapter.capabilities.presentationMode;
    const usesTerminalPresentation = requestedPresentation === "terminal";
    const useStructuredFlow = isServerControlled || !usesTerminalPresentation;
    const pluginContributions = (await ctx.options.resolvePluginLaunchContributions?.(
      payload.projectLocation,
      payload.agentKind,
    )) ?? { mcpServers: [], builtInMcpServerIds: [], nativePlugins: [] };
    let nativePlugins: readonly AgentNativePlugin[] = pluginContributions.nativePlugins;
    const wslSegments = payload.segments
      ? await rewriteSegmentsForWsl(payload.segments, payload.projectLocation, {
          preserveImageAttachments: useStructuredFlow,
          preservePdfAttachments:
            useStructuredFlow && adapter.capabilities.readsPdfAttachmentsFromHost === true,
        })
      : undefined;
    // Terminal skills fallback: skill segments the CLI can't resolve natively
    // become short path-hint text before the prompt is typed into the PTY.
    // Structured turns keep the raw segments (they use inline injection).
    const policySegments = wslSegments?.some((segment) => segment.kind === "skill")
      ? ((await ctx.options.filterPluginSkillSegments?.({
          agentKind: payload.agentKind,
          projectLocation: payload.projectLocation,
          presentationMode: requestedPresentation,
          nativePlugins,
          segments: wslSegments,
        })) ?? wslSegments)
      : wslSegments;
    const effectiveSegments =
      !useStructuredFlow && policySegments?.some((segment) => segment.kind === "skill")
        ? ((await ctx.options.rewriteTerminalSkillSegments?.({
            leaseId: terminalSkillLeaseId,
            agentKind: payload.agentKind,
            projectLocation: payload.projectLocation,
            nativePlugins,
            segments: policySegments,
          })) ?? policySegments)
        : policySegments;
    const initialPrompt =
      effectiveSegments && effectiveSegments.length > 0
        ? (adapter.formatPromptSegments?.(effectiveSegments) ??
          defaultFormatPromptSegments(effectiveSegments))
        : payload.prompt.trim();
    // Portable-skills fallback for the initial structured turn: inline SKILL.md
    // instructions for invoked skills this provider can't load natively.
    const inlineSkillInstructions =
      useStructuredFlow && effectiveSegments?.some((segment) => segment.kind === "skill")
        ? await ctx.options.buildSkillTurnInjection?.({
            agentKind: payload.agentKind,
            projectLocation: payload.projectLocation,
            nativePlugins,
            segments: effectiveSegments,
          })
        : undefined;
    const shouldQueueInitialPrompt =
      !payload.sessionRef &&
      isServerControlled &&
      usesTerminalPresentation &&
      initialPrompt.length > 0 &&
      adapter.isReadyForInitialPrompt !== undefined;

    // Optimistic user_message: for GUI threads with a fresh prompt, surface
    // the user's typed text in the chat pane immediately — before the slow
    // structured-session work (process spawn + ACP handshake +
    // newSession/loadSession) runs. When the renderer has already painted an
    // optimistic message and shipped its id with the payload, we reuse that
    // id end-to-end so the chat pane never sees a duplicate.
    const optimisticUserMessageItemId =
      !usesTerminalPresentation && initialPrompt.length > 0 && !payload.sessionRef
        ? ctx.emitOptimisticUserMessage(
            payload.threadId,
            initialPrompt,
            effectiveSegments,
            payload.userMessageItemId,
          )
        : undefined;
    const mcpLaunchSnapshotBase = {
      ...(payload.projectMcpServers?.length
        ? { projectMcpServers: [...payload.projectMcpServers] }
        : {}),
      disabledBuiltInMcpServerIds: payload.disabledBuiltInMcpServerIds ?? [],
      disabledBuiltInMcpTools: payload.disabledBuiltInMcpTools ?? {},
      pluginBuiltInMcpServerIds: pluginContributions.builtInMcpServerIds,
    };
    const optimisticMcpLaunchSnapshot: McpLaunchSnapshot = {
      mcpServers: [],
      ...mcpLaunchSnapshotBase,
    };
    const optimisticLaunchConfig = this.resolveMcpLaunchConfig(
      workspaceLaunchConfig(
        payload.projectLocation,
        payload.config,
        adapter,
        optimisticMcpLaunchSnapshot.disabledBuiltInMcpServerIds,
        optimisticMcpLaunchSnapshot.pluginBuiltInMcpServerIds,
      ),
      optimisticMcpLaunchSnapshot,
      adapter,
      payload.threadId,
    );
    if (optimisticUserMessageItemId) {
      this.emitOptimisticWorkingState(payload.threadId, payload.config, optimisticLaunchConfig);
    }

    // Prime the user's interactive-shell env (fnm / nvm / asdf / mise cd-hooks
    // applied at the project root) before any agent process — structured or
    // PTY — is spawned. Electron-from-Finder inherits launchd's skeleton PATH,
    // so without this the spawned CLI picks up homebrew node instead of the
    // project-pinned version. Memoized per cwd; the later prime before the PTY
    // launch is a no-op after this.
    if (shouldPrimeNativeProjectShellEnv(payload.projectLocation)) {
      await primeProjectShellEnv(payload.projectLocation.path);
    }
    await this.ctx.options.prepareSkillsForLaunch?.(payload.projectLocation, payload.agentKind);

    let mcpIdentity: McpLaunchIdentity = {
      threadId: payload.threadId,
      launchId: randomUUID(),
      browserEvidenceTurnId: randomUUID(),
      title: initialPrompt.split("\n", 1)[0]?.trim() ?? "",
    };
    // Every provider translator keys its output record by `server.name`, so a
    // plugin server sharing a name with a user-configured one would silently
    // replace it — dropping the user's headers and tokens. The user's own
    // servers win; the colliding plugin server is skipped.
    const userMcpServers = payload.mcpServers ?? [];
    const userMcpServerNames = new Set(userMcpServers.map((server) => server.name));
    const pluginMcpServers = pluginContributions.mcpServers.filter(
      (server) => !userMcpServerNames.has(server.name),
    );
    let mcpServers = resolveEnabledMcpServers([...userMcpServers, ...pluginMcpServers]);
    if (this.ctx.options.applyMcpServerAuthorization) {
      mcpServers = await this.ctx.options.applyMcpServerAuthorization(mcpServers);
    }
    // Keep snapshots restart-safe: WSL filter deployments belong to one live
    // provider attempt and are created later by resolveMcpServersForLaunch.
    // Personal Pipedream remains recognizable for the privileged relay resolver.
    mcpServers = [
      ...mcpServers.filter((server) => !isPersonalPipedreamMcpServer(server)),
      ...mcpServers.filter(isPersonalPipedreamMcpServer).map(stripResolvedAuthorizationHeader),
    ];
    let mcpLaunchSnapshot: McpLaunchSnapshot = {
      mcpServers,
      ...mcpLaunchSnapshotBase,
    };
    let launchConfig = this.resolveMcpLaunchConfig(
      workspaceLaunchConfig(
        payload.projectLocation,
        payload.config,
        adapter,
        mcpLaunchSnapshot.disabledBuiltInMcpServerIds,
        mcpLaunchSnapshot.pluginBuiltInMcpServerIds,
      ),
      mcpLaunchSnapshot,
      adapter,
      payload.threadId,
    );
    // closeThread can arrive while any of the asynchronous launch-preparation
    // hooks above are running. Keep its abort marker sticky until startThread's
    // outer finally unwinds; peeking here prevents relay authority from being
    // minted, and there is no await between this gate and synchronous
    // authorization registration.
    if (ctx.pendingStartAborts.has(payload.threadId)) {
      return { threadId: payload.threadId };
    }
    let retryCount = 0;
    while (true) {
      // A configuration retry awaits a fresh shared/plugin snapshot. Close can
      // land during that refresh, after attempt A was revoked; keep the abort
      // marker sticky and gate every attempt before it can remint authority.
      if (ctx.pendingStartAborts.has(payload.threadId)) {
        return { threadId: payload.threadId };
      }
      try {
        return await this.withMcpLaunchAuthorization(
          {
            identity: mcpIdentity,
            adapter,
            config: payload.config,
            launchConfig,
            mcpLaunchSnapshot,
            personalMcpCredentialEpoch,
            mcpLaunchConfigurationEpoch,
          },
          async () => {
            const resolvedMcpServers = await this.resolveMcpServersForLaunch({
              location: payload.projectLocation,
              config: launchConfig,
              mcpLaunchSnapshot,
              identity: mcpIdentity,
              crossagentThreadId: payload.threadId,
              adapter,
              presentationMode: requestedPresentation,
            });
            return await withMcpToolFilterCleanupLease(
              resolvedMcpServers,
              async (mcpToolFilterCleanup, transferMcpToolFilterCleanup) => {
                // Resolution can traverse WSL reachability and privileged relay setup.
                // Re-check the exact launch authority before any stale descriptor can
                // cross into provider creation after a concurrent settings removal.
                ctx.assertMcpLaunchAuthorizationCurrent?.(mcpIdentity);
                const structuredSession = await this.createStructuredSession(
                  adapter,
                  payload.threadId,
                  payload.agentKind,
                  payload.projectLocation,
                  launchConfig,
                  resolvedMcpServers,
                  mcpIdentity,
                  payload.sessionRef,
                  requestedPresentation,
                );
                if (await this.abortPendingStart(payload.threadId, structuredSession)) {
                  return { threadId: payload.threadId };
                }
                await this.assertMcpLaunchAuthorizationCurrentOrDispose(
                  mcpIdentity,
                  structuredSession,
                );

                if (structuredSession?.activate) {
                  try {
                    await structuredSession.activate();
                  } catch (error) {
                    await structuredSession.dispose();
                    if (ctx.pendingStartInterrupts.delete(payload.threadId)) {
                      return { threadId: payload.threadId };
                    }
                    throw error;
                  }
                }
                if (await this.abortPendingStart(payload.threadId, structuredSession)) {
                  return { threadId: payload.threadId };
                }
                await this.assertMcpLaunchAuthorizationCurrentOrDispose(
                  mcpIdentity,
                  structuredSession,
                );

                let openedStructuredThreadId: string | undefined;
                if (structuredSession?.openThread) {
                  try {
                    openedStructuredThreadId = await structuredSession.openThread(
                      launchConfig,
                      payload.sessionRef,
                    );
                  } catch (error) {
                    await structuredSession.dispose();
                    if (ctx.pendingStartInterrupts.delete(payload.threadId)) {
                      return { threadId: payload.threadId };
                    }
                    throw error;
                  }
                }
                if (await this.abortPendingStart(payload.threadId, structuredSession)) {
                  return { threadId: payload.threadId };
                }
                await this.assertMcpLaunchAuthorizationCurrentOrDispose(
                  mcpIdentity,
                  structuredSession,
                );

                if (!usesTerminalPresentation) {
                  if (!structuredSession) {
                    throw new Error(
                      `Agent ${payload.agentKind} does not support ${requestedPresentation} presentation.`,
                    );
                  }
                  const resolvedSessionRef =
                    payload.sessionRef ??
                    (openedStructuredThreadId
                      ? createKnownSessionRef(openedStructuredThreadId)
                      : undefined);
                  const startInterrupted = ctx.pendingStartInterrupts.delete(payload.threadId);
                  const session = this.spawnThread({
                    threadId: payload.threadId,
                    adapter,
                    agentKind: payload.agentKind,
                    projectLocation: payload.projectLocation,
                    config: payload.config,
                    initialSize: payload.initialSize,
                    launchPrompt: "",
                    structuredSession,
                    ...(resolvedSessionRef ? { sessionRef: resolvedSessionRef } : {}),
                    presentationMode: requestedPresentation,
                    initialStatus:
                      optimisticUserMessageItemId && !startInterrupted ? "working" : "idle",
                    initialAttention:
                      optimisticUserMessageItemId && !startInterrupted ? "working" : "none",
                    suppressInitialStructuredIdle:
                      optimisticUserMessageItemId !== undefined && !startInterrupted,
                    mcpLaunchSnapshot,
                    launchConfig,
                    nativePlugins,
                    mcpIdentity,
                    ...(mcpToolFilterCleanup ? { mcpToolFilterCleanup } : {}),
                  });
                  transferMcpToolFilterCleanup();
                  if (
                    !startInterrupted &&
                    !payload.sessionRef &&
                    initialPrompt.length > 0 &&
                    structuredSession.startTurn
                  ) {
                    const startOptions = {
                      ...(optimisticUserMessageItemId
                        ? { userMessageItemId: optimisticUserMessageItemId }
                        : {}),
                      ...(inlineSkillInstructions
                        ? { inlineInstructions: inlineSkillInstructions }
                        : {}),
                    };
                    void structuredSession
                      .startTurn(
                        initialPrompt,
                        launchConfig,
                        effectiveSegments,
                        Object.keys(startOptions).length > 0 ? startOptions : undefined,
                      )
                      .catch((error) => {
                        if (ctx.sessions.get(session.threadId)?.instanceId !== session.instanceId) {
                          return;
                        }
                        ctx.failStructuredSession(session, error);
                      });
                  }
                  return { threadId: payload.threadId };
                }

                if (
                  !payload.sessionRef &&
                  useStructuredFlow &&
                  initialPrompt.length > 0 &&
                  !shouldQueueInitialPrompt &&
                  structuredSession?.startTurn
                ) {
                  void structuredSession
                    .startTurn(
                      initialPrompt,
                      launchConfig,
                      effectiveSegments,
                      inlineSkillInstructions
                        ? { inlineInstructions: inlineSkillInstructions }
                        : undefined,
                    )
                    .catch((error) => {
                      console.error("[supervisor] initial turn failed:", error);
                      const activeSession = ctx.sessions.get(payload.threadId);
                      if (!activeSession) {
                        return;
                      }
                      ctx.failStructuredSession(activeSession, error);
                    });
                }

                if (shouldQueueInitialPrompt) {
                  await structuredSession?.ensureResumeArtifacts?.();
                }

                const deferToTerminal =
                  adapter.shouldDeferPromptToTerminal?.(payload.config) ?? false;
                // Use `initialPrompt` (the adapter-formatted version with `~/` shortening
                // and WSL path rewriting) so attachments hand off cleanly as the launch
                // arg instead of being staged for a deferred PTY-write.
                const launchPrompt = useStructuredFlow || deferToTerminal ? "" : initialPrompt;
                const launchOptionsWithMcp = this.composeLaunchOptions(
                  adapter,
                  structuredSession?.launchOptions,
                  resolvedMcpServers,
                );
                const argv = payload.sessionRef
                  ? adapter.buildResumeArgv(
                      payload.projectLocation,
                      launchConfig,
                      launchPrompt,
                      payload.sessionRef,
                      launchOptionsWithMcp,
                    )
                  : adapter.buildLaunchArgv(
                      payload.projectLocation,
                      launchConfig,
                      launchPrompt,
                      payload.sessionRef,
                      launchOptionsWithMcp,
                    );
                const cleanupArgv = onceLaunchCleanup(argv.cleanup);
                if (cleanupArgv) argv.cleanup = cleanupArgv;
                let argvTransferred = false;
                try {
                  // Append CLI hook plugin args (e.g. Claude `--settings <path>`); env vars
                  // (`PORACODE_HOOK_URL`, `PORACODE_HOOK_SECRET`, `PORACODE_THREAD_ID`,
                  // `PORACODE_AGENT_KIND`, `PORACODE_HOOK_PROTOCOL_VERSION`) flow through
                  // `spawnThread` → `agentEnv` so they end up in the PTY env on every
                  // platform (WSL, win32, posix). Failure to resolve plugin extras normally
                  // degrades to L2. A Codex terminal connected to the canonical Browser is
                  // the exception: it requires the app-owned PreToolUse command gate and
                  // fails closed before spawn when that gate cannot be staged.
                  const cliHookExtras = await ctx.cliHookPlugin.resolveCliHookPluginExtras(
                    payload.threadId,
                    payload.agentKind,
                    payload.projectLocation,
                    resolvedMcpServers,
                  );
                  if (cliHookExtras.extraArgs.length > 0) {
                    argv.args = mergeCliHookExtraArgs(
                      adapter,
                      argv.args,
                      cliHookExtras.extraArgs,
                      launchPrompt,
                      payload.sessionRef,
                    );
                  }
                  argv.args = await applyLaunchArgsConfigRewrite(
                    adapter,
                    argv.args,
                    payload.config,
                    payload.projectLocation,
                  );
                  if (shouldPrimeNativeProjectShellEnv(payload.projectLocation)) {
                    await primeProjectShellEnv(payload.projectLocation.path);
                  }
                  const keepStructuredSession = structuredSession && useStructuredFlow;
                  if (structuredSession && !keepStructuredSession) {
                    try {
                      await structuredSession.dispose();
                    } catch (error) {
                      argv.cleanup?.();
                      throw error;
                    }
                  }
                  if (ctx.pendingStartAborts.delete(payload.threadId)) {
                    ctx.pendingStartInterrupts.delete(payload.threadId);
                    try {
                      if (structuredSession && keepStructuredSession) {
                        await structuredSession.dispose();
                      }
                    } finally {
                      argv.cleanup?.();
                    }
                    return { threadId: payload.threadId };
                  }

                  // Materialize WSL launch files only after every awaited pre-launch
                  // operation has settled, keeping the credential-file lifetime minimal.
                  const command = resolveLaunchSpec(payload.projectLocation, argv);
                  const resolvedSessionRef = payload.sessionRef ?? command.sessionRef;
                  this.spawnThread({
                    threadId: payload.threadId,
                    adapter,
                    agentKind: payload.agentKind,
                    projectLocation: payload.projectLocation,
                    config: payload.config,
                    initialSize: payload.initialSize,
                    launchPrompt,
                    command,
                    ...(Object.keys(cliHookExtras.env).length > 0
                      ? { extraEnv: cliHookExtras.env }
                      : {}),
                    ...(keepStructuredSession ? { structuredSession } : {}),
                    ...(resolvedSessionRef ? { sessionRef: resolvedSessionRef } : {}),
                    mcpLaunchSnapshot,
                    launchConfig,
                    mcpIdentity,
                    nativePlugins,
                    ...(mcpToolFilterCleanup ? { mcpToolFilterCleanup } : {}),
                    ...(shouldQueueInitialPrompt ? { pendingLaunchPrompt: initialPrompt } : {}),
                    presentationMode: requestedPresentation,
                    ...(!useStructuredFlow ? { terminalSkillLeaseId } : {}),
                    ...(deferToTerminal && !useStructuredFlow
                      ? (() => {
                          const preInputs = adapter.buildTerminalPreInputs?.(payload.config);
                          return {
                            ...(preInputs ? { pendingTerminalPreInputs: preInputs } : {}),
                            pendingTerminalPrompt: initialPrompt,
                            ...(effectiveSegments
                              ? { pendingTerminalSegments: effectiveSegments }
                              : {}),
                          };
                        })()
                      : {}),
                  });
                  argvTransferred = true;
                  transferMcpToolFilterCleanup();

                  return { threadId: payload.threadId };
                } finally {
                  if (!argvTransferred) cleanupArgv?.();
                }
              },
            );
          },
        );
      } catch (error) {
        if (
          !(error instanceof McpLaunchConfigurationChangedError) ||
          !ctx.refreshPendingMcpLaunchSnapshot
        ) {
          throw error;
        }
        let refreshed:
          | {
              mcpLaunchSnapshot: McpLaunchSnapshot;
              nativePlugins: readonly AgentNativePlugin[];
            }
          | undefined;
        while (retryCount < MAX_MCP_LAUNCH_CONFIGURATION_RETRIES) {
          retryCount += 1;
          const refreshEpoch = ctx.getMcpLaunchConfigurationEpoch?.() ?? 0;
          const candidate = await ctx.refreshPendingMcpLaunchSnapshot({
            threadId: payload.threadId,
            agentKind: payload.agentKind,
            adapter,
            projectLocation: payload.projectLocation,
            config: payload.config,
            mcpLaunchSnapshot,
          });
          if ((ctx.getMcpLaunchConfigurationEpoch?.() ?? 0) !== refreshEpoch) continue;
          refreshed = candidate;
          mcpLaunchConfigurationEpoch = refreshEpoch;
          break;
        }
        if (!refreshed) throw error;
        personalMcpCredentialEpoch = ctx.getPersonalMcpCredentialEpoch?.() ?? 0;
        mcpLaunchSnapshot = refreshed.mcpLaunchSnapshot;
        nativePlugins = refreshed.nativePlugins;
        mcpIdentity = {
          threadId: payload.threadId,
          launchId: randomUUID(),
          browserEvidenceTurnId: randomUUID(),
          title: initialPrompt.split("\n", 1)[0]?.trim() ?? "",
        };
        launchConfig = this.resolveMcpLaunchConfig(
          workspaceLaunchConfig(
            payload.projectLocation,
            payload.config,
            adapter,
            mcpLaunchSnapshot.disabledBuiltInMcpServerIds,
            mcpLaunchSnapshot.pluginBuiltInMcpServerIds,
          ),
          mcpLaunchSnapshot,
          adapter,
          payload.threadId,
        );
      }
    }
  }

  async restartThread(
    session: SessionRuntime,
    turn: QueuedStructuredTurn,
    terminalSkillLeaseId?: string,
  ): Promise<void> {
    const ctx = this.ctx;
    const personalMcpCredentialEpoch = ctx.getPersonalMcpCredentialEpoch?.() ?? 0;
    const mcpLaunchConfigurationEpoch = ctx.getMcpLaunchConfigurationEpoch?.() ?? 0;
    const { prompt, config } = turn;
    if (!session.sessionRef) {
      throw new Error("Session cannot be restarted without a known session reference.");
    }
    const sessionRef = session.sessionRef;
    const mcpLaunchSnapshot = session.mcpLaunchSnapshot;
    const mcpIdentity: McpLaunchIdentity = {
      ...session.mcpIdentity,
      threadId: session.threadId,
      // Replace authority before teardown begins. A bearer from the prior
      // provider process must stop working while its replacement is starting.
      launchId: randomUUID(),
      browserEvidenceTurnId: turn.browserEvidenceTurnId ?? randomUUID(),
    };
    const launchConfig = this.resolveMcpLaunchConfig(
      workspaceLaunchConfig(
        session.projectLocation,
        config,
        session.adapter,
        mcpLaunchSnapshot.disabledBuiltInMcpServerIds,
        mcpLaunchSnapshot.pluginBuiltInMcpServerIds,
      ),
      mcpLaunchSnapshot,
      session.adapter,
      session.threadId,
    );

    return await this.withMcpLaunchAuthorization(
      {
        identity: mcpIdentity,
        adapter: session.adapter,
        config,
        launchConfig,
        mcpLaunchSnapshot,
        personalMcpCredentialEpoch,
        mcpLaunchConfigurationEpoch,
      },
      async () => {
        const isServerControlled = session.adapter.capabilities.liveInputMode === "server";
        const usesTerminalPresentation =
          (session.presentationMode ?? session.adapter.capabilities.presentationMode) ===
          "terminal";
        const useStructuredFlow = isServerControlled || !usesTerminalPresentation;
        session.ignoreExit = true;
        ctx.outputPipeline.clearSessionTimers(session);
        // Subagent maps from the prior session would otherwise leak across resume:
        // any unsubscribed buffers, lingering child→parent entries, and overlay
        // subscriptions from the dead session are stale once the structured
        // session is replaced. `closeThread` already does this on full teardown.
        ctx.runtimeEventRouter.clearAllForThread(session.threadId);
        await session.structuredSession?.dispose();
        if (session.structuredSession) {
          await sleep(150);
        }
        ctx.ptyLifecycle.kill(session);
        if (!ctx.isCurrentSession(session)) {
          return;
        }

        // Prime the user's interactive-shell env before respawning. See the same
        // call in `startThreadInner` — must run before the structured-session
        // spawn so the child inherits the project-pinned PATH, not launchd's.
        if (shouldPrimeNativeProjectShellEnv(session.projectLocation)) {
          await primeProjectShellEnv(session.projectLocation.path);
        }
        await this.ctx.options.prepareSkillsForLaunch?.(session.projectLocation, session.agentKind);
        if (!ctx.isCurrentSession(session)) {
          return;
        }

        const resolvedMcpServers = await this.resolveMcpServersForLaunch({
          location: session.projectLocation,
          config: launchConfig,
          mcpLaunchSnapshot,
          identity: mcpIdentity,
          crossagentThreadId: session.threadId,
          adapter: session.adapter,
          ...(session.presentationMode ? { presentationMode: session.presentationMode } : {}),
        });
        return await withMcpToolFilterCleanupLease(
          resolvedMcpServers,
          async (newMcpToolFilterCleanup, transferMcpToolFilterCleanup) => {
            const mcpToolFilterCleanup = combineMcpToolFilterCleanups(
              session.mcpToolFilterCleanup,
              newMcpToolFilterCleanup,
            );
            ctx.assertMcpLaunchAuthorizationCurrent?.(mcpIdentity);
            const structuredSession = await this.createStructuredSession(
              session.adapter,
              session.threadId,
              session.agentKind,
              session.projectLocation,
              launchConfig,
              resolvedMcpServers,
              mcpIdentity,
              sessionRef,
              session.presentationMode,
            );
            if (!ctx.isCurrentSession(session)) {
              await structuredSession?.dispose();
              return;
            }
            await this.assertMcpLaunchAuthorizationCurrentOrDispose(mcpIdentity, structuredSession);

            if (structuredSession?.activate) {
              try {
                await structuredSession.activate();
              } catch (error) {
                await structuredSession.dispose();
                throw error;
              }
            }
            if (!ctx.isCurrentSession(session)) {
              await structuredSession?.dispose();
              return;
            }
            await this.assertMcpLaunchAuthorizationCurrentOrDispose(mcpIdentity, structuredSession);

            if (structuredSession?.openThread) {
              try {
                await structuredSession.openThread(launchConfig, sessionRef);
              } catch (error) {
                await structuredSession.dispose();
                throw error;
              }
            }
            if (!ctx.isCurrentSession(session)) {
              await structuredSession?.dispose();
              return;
            }
            await this.assertMcpLaunchAuthorizationCurrentOrDispose(mcpIdentity, structuredSession);

            if (!usesTerminalPresentation) {
              if (!structuredSession) {
                throw new Error(
                  `Thread ${session.threadId} cannot restart without a structured session.`,
                );
              }
              const restarted = this.spawnThread({
                threadId: session.threadId,
                agentKind: session.agentKind,
                adapter: session.adapter,
                projectLocation: session.projectLocation,
                config,
                initialSize: session.terminalSize,
                launchPrompt: "",
                structuredSession,
                sessionRef,
                mcpLaunchSnapshot,
                launchConfig,
                mcpIdentity,
                ...(mcpToolFilterCleanup ? { mcpToolFilterCleanup } : {}),
                ...(session.nativePlugins ? { nativePlugins: session.nativePlugins } : {}),
                ...(session.presentationMode ? { presentationMode: session.presentationMode } : {}),
              });
              session.mcpToolFilterCleanup = undefined;
              transferMcpToolFilterCleanup();
              if (prompt.trim().length > 0 && structuredSession.startTurn) {
                // Retry/recovery callers preserve the id of a user message that was
                // already broadcast before the old session stopped. Reuse it without
                // emitting another turn.started + item pair. A missing id means this
                // path owns the first canonical paint and must emit it now.
                const optimisticItemId =
                  turn.userMessageItemId ??
                  ctx.emitOptimisticUserMessage(session.threadId, prompt, turn.segments);
                const startOptions = {
                  userMessageItemId: optimisticItemId,
                  ...(turn.inlineInstructions
                    ? { inlineInstructions: turn.inlineInstructions }
                    : {}),
                };
                void structuredSession
                  .startTurn(prompt, launchConfig, turn.segments, startOptions)
                  .catch((error) => {
                    if (ctx.sessions.get(restarted.threadId)?.instanceId !== restarted.instanceId) {
                      return;
                    }
                    ctx.failStructuredSession(restarted, error);
                  });
              }
              return;
            }

            const launchPrompt = useStructuredFlow ? "" : prompt;
            const cliHookExtras = await ctx.cliHookPlugin.resolveCliHookPluginExtras(
              session.threadId,
              session.agentKind,
              session.projectLocation,
              resolvedMcpServers,
            );
            if (!ctx.isCurrentSession(session)) {
              await structuredSession?.dispose();
              return;
            }
            const argv = session.adapter.buildResumeArgv(
              session.projectLocation,
              launchConfig,
              launchPrompt,
              sessionRef,
              this.composeLaunchOptions(
                session.adapter,
                structuredSession?.launchOptions,
                resolvedMcpServers,
              ),
            );
            const cleanupArgv = onceLaunchCleanup(argv.cleanup);
            if (cleanupArgv) argv.cleanup = cleanupArgv;
            let argvTransferred = false;
            try {
              if (cliHookExtras.extraArgs.length > 0) {
                argv.args = mergeCliHookExtraArgs(
                  session.adapter,
                  argv.args,
                  cliHookExtras.extraArgs,
                  launchPrompt,
                  sessionRef,
                );
              }
              argv.args = await applyLaunchArgsConfigRewrite(
                session.adapter,
                argv.args,
                config,
                session.projectLocation,
              );
              if (shouldPrimeNativeProjectShellEnv(session.projectLocation)) {
                await primeProjectShellEnv(session.projectLocation.path);
              }
              if (!ctx.isCurrentSession(session)) {
                await structuredSession?.dispose();
                argv.cleanup?.();
                return;
              }
              const keepStructuredSession = structuredSession && useStructuredFlow;
              if (structuredSession && !keepStructuredSession) {
                try {
                  await structuredSession.dispose();
                } catch (error) {
                  argv.cleanup?.();
                  throw error;
                }
              }
              if (!ctx.isCurrentSession(session)) {
                try {
                  if (structuredSession && keepStructuredSession) {
                    await structuredSession.dispose();
                  }
                } finally {
                  argv.cleanup?.();
                }
                return;
              }

              // Avoid creating WSL launch files until no asynchronous pre-launch
              // disposal can strand them.
              const command = resolveLaunchSpec(session.projectLocation, argv);
              this.spawnThread({
                threadId: session.threadId,
                agentKind: session.agentKind,
                adapter: session.adapter,
                projectLocation: session.projectLocation,
                config,
                initialSize: session.terminalSize,
                launchPrompt,
                command,
                ...(Object.keys(cliHookExtras.env).length > 0
                  ? { extraEnv: cliHookExtras.env }
                  : {}),
                ...(keepStructuredSession ? { structuredSession } : {}),
                sessionRef,
                mcpLaunchSnapshot,
                launchConfig,
                mcpIdentity,
                ...(mcpToolFilterCleanup ? { mcpToolFilterCleanup } : {}),
                ...(session.nativePlugins ? { nativePlugins: session.nativePlugins } : {}),
                ...(session.presentationMode ? { presentationMode: session.presentationMode } : {}),
                ...(terminalSkillLeaseId ? { terminalSkillLeaseId } : {}),
              });
              argvTransferred = true;
              session.mcpToolFilterCleanup = undefined;
              transferMcpToolFilterCleanup();
            } finally {
              if (!argvTransferred) cleanupArgv?.();
            }
          },
        );
      },
    );
  }

  spawnThread(input: SpawnThreadInput): SessionRuntime {
    const ctx = this.ctx;
    if (input.mcpIdentity?.launchId) {
      try {
        ctx.assertMcpLaunchAuthorizationCurrent?.(input.mcpIdentity as McpLaunchIdentity);
      } catch (error) {
        disposeRejectedSpawnInput(input);
        throw error;
      }
    }
    const mcpLaunchSnapshot =
      input.mcpLaunchSnapshot ?? ({ mcpServers: [], disabledBuiltInMcpServerIds: [] } as const);
    // `thread-reset` is only consumed by the terminal panel (renderer scrollback
    // reset) and the renderer-side runtime-event/server-request slice clear.
    // GUI threads have no terminal scrollback, and clearing the slice would
    // wipe the optimistic user_message we may have already painted ahead of
    // structured-session setup. Skip the reset for any GUI-presentation
    // thread (initial launch, resume, restart all run through here).
    const isGuiPresentation =
      input.presentationMode !== undefined && input.presentationMode !== "terminal";
    if (!isGuiPresentation) {
      ctx.options.emit({ type: "thread-reset", threadId: input.threadId });
    }

    const agentEnv = this.resolveAgentProcessEnv(input.adapter);
    const cliHookEnvInjected = Boolean(input.extraEnv?.PORACODE_HOOK_URL);
    // `baseSpawnEnv` underlies every lane; the location-specific `spawnEnv`
    // layers on top so a provider can still override per platform.
    const providerEnv = mergeSpawnEnv(
      input.adapter.baseSpawnEnv,
      input.projectLocation.kind === "wsl"
        ? input.adapter.spawnEnv?.wsl
        : input.adapter.spawnEnv?.native,
    );
    if (providerEnv) {
      Object.assign(agentEnv, providerEnv);
    }
    if (input.extraEnv) {
      Object.assign(agentEnv, input.extraEnv);
    }
    Object.assign(
      agentEnv,
      getIterm2StatusL2TerminalEnv({
        adapter: input.adapter,
        disableCliHookPlugin: ctx.options.readDisableCliHookPlugin(),
        cliHookEnvInjected,
      }),
    );
    const terminalEnv = resolveTerminalColorEnv(input.projectLocation);
    const terminalAgentEnv = { ...agentEnv, ...terminalEnv };
    const command = input.command
      ? injectWslEnv(input.command, input.projectLocation, terminalAgentEnv)
      : undefined;
    let pty;
    if (command) {
      ensureNodePtySpawnHelperExecutable();
      const ptyEnv = sanitizeChildProcessEnv({
        ...sanitizedProcessEnv,
        ...(command.env ?? {}),
        ...agentEnv,
        ...terminalEnv,
      });
      try {
        pty = spawn(command.command, command.args, {
          name: process.platform === "win32" ? "xterm-color" : terminalEnv.TERM,
          cols: input.initialSize.cols,
          rows: input.initialSize.rows,
          cwd: command.cwd ?? process.cwd(),
          env: ptyEnv,
        });
      } catch (error) {
        try {
          command.cleanup?.();
        } catch {
          // Best-effort cleanup must not hide the spawn failure.
        }
        throw new Error(
          describeSpawnFailure(
            "agent",
            {
              command: command.command,
              args: command.args,
              ...(command.cwd ? { cwd: command.cwd } : {}),
            },
            sanitizeEnv(ptyEnv),
            error,
          ),
          { cause: error },
        );
      }
    }
    const session: SessionRuntime = {
      instanceId: randomUUID(),
      threadId: input.threadId,
      agentKind: input.agentKind,
      adapter: input.adapter,
      ...(pty ? { pty } : {}),
      ...(pty && command?.cleanup ? { launchCleanup: command.cleanup } : {}),
      ...(input.mcpToolFilterCleanup ? { mcpToolFilterCleanup: input.mcpToolFilterCleanup } : {}),
      projectLocation: input.projectLocation,
      config: input.config,
      mcpLaunchSnapshot,
      ...(input.nativePlugins ? { nativePlugins: input.nativePlugins } : {}),
      ...(input.mcpIdentity ? { mcpIdentity: input.mcpIdentity } : {}),
      launchConfig:
        input.launchConfig ??
        workspaceLaunchConfig(
          input.projectLocation,
          input.config,
          input.adapter,
          mcpLaunchSnapshot.disabledBuiltInMcpServerIds,
          mcpLaunchSnapshot.pluginBuiltInMcpServerIds,
        ),
      terminalSize: input.initialSize,
      launchPrompt: input.launchPrompt,
      ...(input.sessionRef ? { sessionRef: input.sessionRef } : {}),
      status: input.initialStatus ?? "launching",
      attention: input.initialAttention ?? "none",
      canResumeWithConfig: input.sessionRef !== undefined,
      outputLength: 0,
      pendingLaunchPrompt: input.pendingLaunchPrompt,
      pendingTerminalPreInputs: input.pendingTerminalPreInputs,
      pendingTerminalPrompt: input.pendingTerminalPrompt,
      pendingTerminalSegments: input.pendingTerminalSegments,
      ...(input.terminalSkillLeaseId
        ? { activeTerminalSkillLeaseIds: [input.terminalSkillLeaseId] }
        : {}),
      ...(input.presentationMode ? { presentationMode: input.presentationMode } : {}),
      ...(input.suppressInitialStructuredIdle ? { suppressInitialStructuredIdle: true } : {}),
      prevChunk: "",
      lastStrippedPtyChunk: "",
      ptyOscCarry: "",
      ...(cliHookEnvInjected ? { cliHookEnvInjected: true } : {}),
      ...(input.structuredSession ? { structuredSession: input.structuredSession } : {}),
    };

    try {
      ctx.activateMcpLaunchAuthorization(session);
    } catch (error) {
      try {
        pty?.kill();
      } catch {
        // The authorization error remains the actionable launch failure.
      }
      disposeRejectedSpawnInput(input);
      throw error;
    }
    ctx.sessionRuntimeLifecycle.attach(session);

    return session;
  }

  private async withMcpLaunchAuthorization<T>(
    authorization: McpLaunchAuthorization,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.ctx.beginMcpLaunchAuthorization(authorization);
    try {
      return await operation();
    } finally {
      // Compare-and-revoke in the manager makes this a no-op after spawnThread
      // promotes the exact launch to active authority.
      this.ctx.revokeMcpLaunchAuthorization(authorization.identity);
    }
  }

  /** Fold provider-neutral MCP descriptors into every launch path. */
  composeLaunchOptions(
    adapter: AgentAdapter,
    launchOptions: AgentLaunchOptions | undefined,
    mcpServers: readonly ResolvedMcpServer[],
  ): AgentLaunchOptions {
    return {
      ...(launchOptions ?? {}),
      agentSettings: this.ctx.resolveAgentSettings(adapter),
      ...(mcpServers.length > 0 ? { mcpServers } : {}),
    };
  }

  async resolveMcpServersForLaunch({
    location,
    config,
    mcpLaunchSnapshot,
    identity,
    crossagentThreadId,
    adapter,
    presentationMode,
  }: {
    location: ProjectLocation;
    config: ThreadConfig;
    mcpLaunchSnapshot: McpLaunchSnapshot;
    identity?: McpThreadIdentity;
    crossagentThreadId?: string;
    adapter?: AgentAdapter;
    presentationMode?: ThreadPresentationMode;
  }): Promise<ResolvedMcpServer[]> {
    // Pipedream front-door bearers bind to one concrete app launch. Provider
    // runtimes may pool their own credential-free transport internally, but a
    // stale process must never retain a sibling task's relay authorization.
    const pipedreamIdentity = identity;
    const providerSessionCrossagents = usesProviderSessionCrossagentRouting(
      adapter,
      presentationMode,
      crossagentThreadId,
    );
    if (adapter?.capabilities.mcpConfigSource === "agentSettings") {
      // Provider-level MCP flags come from the provider's settings page.
      config = this.resolveMcpLaunchConfig(config, mcpLaunchSnapshot, adapter, crossagentThreadId);
      if (adapter.capabilities.crossagentMcpRouting === undefined) {
        crossagentThreadId = undefined;
      }
    }
    const effectivePresentation = presentationMode ?? adapter?.capabilities.presentationMode;
    if (
      adapter &&
      config.browserMcp === true &&
      !mcpLaunchSnapshot.disabledBuiltInMcpServerIds.includes("browser") &&
      (!effectivePresentation || adapter.browserRouting?.[effectivePresentation] !== "exclusive")
    ) {
      throw new Error(
        `Y Space Browser is required for ${adapter.label} in ${effectivePresentation ?? "this"} mode, but that agent mode does not provide an exclusive embedded Browser connection. Globally disable Browser MCP to launch this mode without browser access.`,
      );
    }
    const browserMcp = await this.resolveBrowserMcpForLaunch(
      location,
      config,
      mcpLaunchSnapshot,
      identity,
    );
    const crossagentMcp = crossagentThreadId
      ? await this.resolveCrossagentMcpForLaunch(
          crossagentThreadId,
          location,
          config,
          mcpLaunchSnapshot,
          providerSessionCrossagents,
        )
      : undefined;
    const computerUseMcp = this.resolveComputerUseMcpForLaunch(
      location,
      config,
      mcpLaunchSnapshot,
      identity,
    );
    const appControlsMcp = await this.resolveAppControlsMcpForLaunch(
      location,
      mcpLaunchSnapshot,
      identity,
    );
    let filterCleanup: (() => void) | undefined;
    try {
      const snapshotPersonalServers = mcpLaunchSnapshot.mcpServers
        .filter(isPersonalPipedreamMcpServer)
        .map(stripResolvedAuthorizationHeader);
      let snapshotBaseServers = mcpLaunchSnapshot.mcpServers.filter(
        (server) => !isPersonalPipedreamMcpServer(server),
      );
      const browserExclusive = browserMcp !== undefined;
      if (browserExclusive) {
        snapshotBaseServers = filterCompetingBrowserMcpServers(snapshotBaseServers);
      }
      if (
        snapshotBaseServers.length > 0 &&
        this.ctx.options.prepareMcpToolFilters &&
        (browserExclusive ||
          snapshotBaseServers.some((server) => (server.disabledTools?.length ?? 0) > 0))
      ) {
        snapshotBaseServers = await this.ctx.options.prepareMcpToolFilters(
          snapshotBaseServers,
          location,
          browserExclusive,
        );
        filterCleanup = combineMcpToolFilterCleanups(
          filterCleanup,
          getMcpToolFilterCleanup(snapshotBaseServers),
        );
      }
      const resolvedBaseServers = composeResolvedMcpServers(
        {
          ...mcpLaunchSnapshot,
          mcpServers: [...snapshotBaseServers, ...snapshotPersonalServers],
        },
        browserMcp,
        crossagentMcp,
        computerUseMcp,
        appControlsMcp,
      );
      // Personal Pipedream is a privileged credential boundary. Never allow a
      // stored or user-supplied upstream Authorization value to reach provider
      // translation; only the supervisor resolver may replace this sanitized
      // descriptor with a launch-scoped localhost capability.
      const personalMcpServers = resolvedBaseServers
        .filter(isPersonalPipedreamMcpServer)
        .map(stripResolvedAuthorizationHeader);
      const baseServers = resolvedBaseServers.filter(
        (server) => !isPersonalPipedreamMcpServer(server),
      );
      let pipedreamServers = pipedreamIdentity?.threadId
        ? await this.ctx.options.resolvePipedreamMcpServers?.({
            threadId: pipedreamIdentity.threadId,
            providerBindingId: resolvePipedreamProviderBindingId(
              pipedreamIdentity.threadId,
              pipedreamIdentity.launchId,
            ),
            projectLocation: location,
            ...(personalMcpServers.length > 0 ? { personalMcpServers } : {}),
          })
        : undefined;
      if (pipedreamServers?.length) {
        const pipedreamBrowserExclusive = hasYSpaceBrowserMcp(baseServers);
        if (pipedreamBrowserExclusive) {
          pipedreamServers = filterCompetingBrowserMcpServers(pipedreamServers);
        }
        if (
          pipedreamServers.length > 0 &&
          this.ctx.options.prepareMcpToolFilters &&
          (pipedreamBrowserExclusive ||
            pipedreamServers.some((server) => (server.disabledTools?.length ?? 0) > 0))
        ) {
          const filtered = await this.ctx.options.prepareMcpToolFilters(
            pipedreamServers.map((server) => ({
              ...server,
              description: "",
              enabled: true,
            })),
            location,
            pipedreamBrowserExclusive,
          );
          filterCleanup = combineMcpToolFilterCleanups(
            filterCleanup,
            getMcpToolFilterCleanup(filtered),
          );
          pipedreamServers = filtered;
        }
      }
      const combinedServers = pipedreamServers?.length
        ? [...baseServers, ...pipedreamServers]
        : baseServers;
      const filteredServers = hasYSpaceBrowserMcp(combinedServers)
        ? filterCompetingBrowserMcpServers(combinedServers)
        : combinedServers;
      return attachMcpToolFilterCleanup(filteredServers, filterCleanup);
    } catch (error) {
      filterCleanup?.();
      throw error;
    }
  }

  resolveMcpLaunchConfig(
    config: ThreadConfig,
    mcpLaunchSnapshot: McpLaunchSnapshot,
    adapter: AgentAdapter,
    crossagentThreadId?: string,
  ): ThreadConfig {
    if (adapter.capabilities.mcpConfigSource !== "agentSettings") return config;
    const withProviderSettings = applyAgentSettingsMcpFlags(
      config,
      this.ctx.resolveAgentSettings(adapter),
      mcpLaunchSnapshot.disabledBuiltInMcpServerIds,
      adapter.capabilities.crossagentMcpRouting !== undefined && crossagentThreadId !== undefined,
    );
    return effectiveLaunchConfig(
      withProviderSettings,
      mcpLaunchSnapshot.disabledBuiltInMcpServerIds,
      mcpLaunchSnapshot.pluginBuiltInMcpServerIds,
    );
  }

  async resolveBrowserMcpForLaunch(
    location: ProjectLocation,
    config: ThreadConfig,
    mcpLaunchSnapshot: McpLaunchSnapshot,
    identity?: McpThreadIdentity,
  ): Promise<BrowserMcpHttpConfig | undefined> {
    if (mcpLaunchSnapshot.disabledBuiltInMcpServerIds.includes("browser")) return undefined;
    const enabled = config.browserMcp === true;
    if (!enabled) return undefined;
    const cfg = await resolveBrowserMcpHttpConfigForLaunch(
      location,
      enabled,
      this.ctx.options.wslBridge,
      {
        ...identity,
        disabledTools: mcpLaunchSnapshot.disabledBuiltInMcpTools?.browser ?? [],
      },
    );
    if (cfg) return cfg;
    throw new Error(
      "Y Space Browser is required for this agent launch, but its embedded Browser connection is unavailable. Restart Y Space and try again, or globally disable Browser MCP before launching the agent.",
    );
  }

  /**
   * Resolve the computer-use MCP http config for a launch when the thread opted
   * in (`config.computerUse === true`). Unlike browser MCP there is no
   * force-disable ctx gate — computer-use scope gating happens in the renderer,
   * so the per-thread config flag is authoritative. The resolver declines for
   * WSL projects by design (computer-use is disabled for WSL). Parallel to
   * `resolveBrowserMcpForLaunch`.
   */
  resolveComputerUseMcpForLaunch(
    location: ProjectLocation,
    config: ThreadConfig,
    mcpLaunchSnapshot: McpLaunchSnapshot,
    identity?: McpThreadIdentity,
  ): ComputerUseMcpHttpConfig | undefined {
    const enabled = config.computerUse === true;
    return resolveComputerUseMcpHttpConfigForLaunch(location, enabled, {
      ...identity,
      disabledTools: mcpLaunchSnapshot.disabledBuiltInMcpTools?.["computer-use"] ?? [],
    });
  }

  resolveAppControlsMcpForLaunch(
    location: ProjectLocation,
    mcpLaunchSnapshot: McpLaunchSnapshot,
    identity?: McpThreadIdentity,
  ): Promise<AppControlsMcpHttpConfig | undefined> {
    if (mcpLaunchSnapshot.disabledBuiltInMcpServerIds.includes("app-controls")) {
      return Promise.resolve(undefined);
    }
    return resolveAppControlsMcpHttpConfigForLaunch(location, this.ctx.options.wslHostAccess, {
      ...identity,
      disabledTools: mcpLaunchSnapshot.disabledBuiltInMcpTools?.["app-controls"] ?? [],
    });
  }

  /**
   * Resolve the Crossagents MCP http config for a launch when the thread opted
   * in (`config.crossagentMcp === true`). Registers the thread with the ingress
   * (idempotent — reuses an existing token), then rewrites the loopback URL to
   * the WSL → host gateway IP for NAT-mode WSL projects (mirrored-mode WSL and
   * native projects pass through unchanged). Parallel to
   * `resolveBrowserMcpForLaunch`.
   */
  async resolveCrossagentMcpForLaunch(
    threadId: string,
    location: ProjectLocation,
    config: ThreadConfig,
    mcpLaunchSnapshot: McpLaunchSnapshot,
    providerSessionRouting = false,
  ): Promise<CrossagentMcpHttpConfig | undefined> {
    if (config.crossagentMcp !== true) {
      this.ctx.options.crossagentMcp?.unregister(threadId);
      return undefined;
    }
    const disabledTools = mcpLaunchSnapshot.disabledBuiltInMcpTools?.crossagents ?? [];
    const native = providerSessionRouting
      ? this.ctx.options.crossagentMcp?.registerProviderSession(threadId, disabledTools)
      : this.ctx.options.crossagentMcp?.register(threadId, disabledTools);
    return resolveCrossagentMcpHttpConfigForLaunch(
      native,
      location,
      this.ctx.options.wslHostAccess,
    );
  }

  private resolveAgentProcessEnv(adapter: AgentAdapter): Record<string, string> {
    const settingDefs = adapter.capabilities.settingDefs ?? [];
    if (settingDefs.length === 0) {
      return {};
    }

    const agentValues = this.ctx.resolveAgentSettings(adapter);
    const env: Record<string, string> = {};
    for (const definition of settingDefs) {
      if (definition.platforms && !definition.platforms.includes(process.platform)) {
        continue;
      }
      const value = agentValues[definition.key] ?? definition.default;
      if (definition.type === "toggle") {
        if (value) {
          Object.assign(env, definition.env);
        }
      } else if (definition.type === "select") {
        env[definition.envVar] = String(value);
      }
    }
    return env;
  }

  private requireAdapter(kind: AgentKind): AgentAdapter {
    const adapter = this.ctx.options.adapters.get(kind);
    if (!adapter) {
      throw new Error(`Unsupported agent adapter: ${kind}`);
    }
    return adapter;
  }

  private async assertMcpLaunchAuthorizationCurrentOrDispose(
    identity: McpLaunchIdentity,
    structuredSession: StructuredSessionHandle | undefined,
  ): Promise<void> {
    try {
      this.ctx.assertMcpLaunchAuthorizationCurrent?.(identity);
    } catch (error) {
      await structuredSession?.dispose();
      throw error;
    }
  }

  private async createStructuredSession(
    adapter: AgentAdapter,
    threadId: string,
    agentKind: AgentKind,
    projectLocation: ProjectLocation,
    config: ThreadConfig,
    mcpServers: readonly ResolvedMcpServer[],
    mcpIdentity: McpThreadIdentity | undefined,
    sessionRef?: SessionRef,
    presentationMode?: ThreadPresentationMode,
  ): Promise<StructuredSessionHandle | undefined> {
    if (!adapter.createStructuredSession) {
      return undefined;
    }
    try {
      return await adapter.createStructuredSession({
        threadId,
        projectLocation,
        config,
        agentSettings: this.ctx.resolveAgentSettings(adapter),
        ...(adapter.baseSpawnEnv ? { baseSpawnEnv: adapter.baseSpawnEnv } : {}),
        ...(mcpIdentity ? { mcpIdentity } : {}),
        ...(mcpServers.length > 0 || adapter.capabilities.mcpConfigSource === "agentSettings"
          ? { mcpServers }
          : {}),
        ...(sessionRef ? { sessionRef } : {}),
        ...(presentationMode ? { presentationMode } : {}),
      });
    } catch (error) {
      console.error("[supervisor] structured session creation failed:", error);
      const diagnosticError = new StructuredRuntimeDiagnosticError("session-creation", agentKind);
      if (presentationMode === "gui") {
        // The startThread IPC boundary owns GUI startup failures. Throw one
        // privacy-safe classified error instead of capturing here and then
        // manufacturing a second "does not support GUI" failure below.
        throw diagnosticError;
      }
      // Terminal presentation can safely fall back to its PTY path when the
      // optional structured helper cannot be created, so report once here.
      captureSupervisorException(diagnosticError, {
        "poracode.feature_area": structuredRuntimeFeatureArea("session-creation"),
        ...(presentationMode ? { "poracode.presentation": presentationMode } : {}),
        "poracode.provider": agentKind,
        "poracode.runtime_kind": "structured",
      });
      return undefined;
    }
  }

  private async abortPendingStart(
    threadId: string,
    structuredSession: StructuredSessionHandle | undefined,
  ): Promise<boolean> {
    if (!this.ctx.pendingStartAborts.delete(threadId)) {
      return false;
    }
    this.ctx.pendingStartInterrupts.delete(threadId);
    await structuredSession?.dispose();
    return true;
  }

  private emitOptimisticWorkingState(
    threadId: string,
    config: ThreadConfig,
    launchConfig: ThreadConfig,
  ): void {
    this.ctx.options.emit({
      type: "thread-state",
      threadId,
      status: "working",
      attention: "working",
      config,
      launchConfig,
      canResumeWithConfig: false,
      threadStatusSource: "server",
    });
  }
}

function disposeRejectedSpawnInput(input: SpawnThreadInput): void {
  input.mcpToolFilterCleanup?.();
  try {
    input.command?.cleanup?.();
  } catch {
    // Best-effort launch artifact cleanup must not hide revocation.
  }
  try {
    const disposal = input.structuredSession?.dispose();
    if (disposal) void disposal.catch(() => {});
  } catch {
    // Revocation must stay synchronous even if provider disposal throws.
  }
}

async function withMcpToolFilterCleanupLease<T>(
  servers: readonly ResolvedMcpServer[],
  operation: (cleanup: (() => void) | undefined, transferCleanup: () => void) => Promise<T>,
): Promise<T> {
  const cleanup = getMcpToolFilterCleanup(servers);
  let transferred = false;
  try {
    return await operation(cleanup, () => {
      transferred = true;
    });
  } finally {
    if (!transferred) cleanup?.();
  }
}

export function resolvePipedreamProviderBindingId(
  threadId: string,
  launchId: string | undefined,
): string {
  const threadBindingId = `thread:${threadId}`;
  return launchId ? `${threadBindingId}:launch:${launchId}` : threadBindingId;
}

export function isPersonalPipedreamMcpServer(server: ResolvedMcpServer): boolean {
  const transport = server.transport;
  return (
    (transport.type === "http" || transport.type === "sse") &&
    isPipedreamPersonalMcpUrl(transport.url)
  );
}

export function stripResolvedAuthorizationHeader<T extends ResolvedMcpServer>(server: T): T {
  const transport = server.transport;
  if (transport.type !== "http" && transport.type !== "sse") return server;
  const headers = Object.fromEntries(
    Object.entries(transport.headers).filter(([name]) => name.toLowerCase() !== "authorization"),
  );
  return { ...server, transport: { ...transport, headers } } as T;
}

function onceLaunchCleanup(cleanup: (() => void) | undefined): (() => void) | undefined {
  if (!cleanup) return undefined;
  let called = false;
  return () => {
    if (called) return;
    called = true;
    cleanup();
  };
}
