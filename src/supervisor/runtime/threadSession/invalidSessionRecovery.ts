import { randomUUID } from "node:crypto";
import type { ProjectLocation } from "@/shared/contracts";
import type { AgentArgvSpec, CommandSpec } from "../../agents/base";
import type { SessionRuntime } from "../sessionTypes";
import { applyLaunchArgsConfigRewrite, mergeCliHookExtraArgs } from "./cliHookArgs";
import type { CliHookSessionCoordinator } from "./cliHookPlugin";
import { shouldPrimeNativeProjectShellEnv } from "./helpers";
import type { PtyLifecycle } from "./ptyLifecycle";
import {
  workspaceLaunchConfig,
  type McpLaunchAuthorization,
  type McpLaunchIdentity,
  type SpawnPipeline,
} from "./spawnPipeline";
import type { ThreadOutputPipeline } from "../threadOutputPipeline";

type RecoverySpawnPipeline = Pick<
  SpawnPipeline,
  "resolveMcpLaunchConfig" | "resolveMcpServersForLaunch" | "composeLaunchOptions" | "spawnThread"
>;

export interface InvalidSessionRecoveryContext {
  spawnPipeline: RecoverySpawnPipeline;
  cliHookPlugin: Pick<CliHookSessionCoordinator, "resolveCliHookPluginExtras">;
  outputPipeline: Pick<ThreadOutputPipeline, "clearSessionTimers">;
  ptyLifecycle: Pick<PtyLifecycle, "kill">;
  isCurrentSession(session: SessionRuntime): boolean;
  failStructuredSession(session: SessionRuntime, error: unknown): void;
  beginMcpLaunchAuthorization(authorization: McpLaunchAuthorization): void;
  revokeMcpLaunchAuthorization(identity: McpLaunchIdentity): void;
  getPersonalMcpCredentialEpoch?(): number;
  settleAfterStructuredDispose(): Promise<void>;
  primeProjectShellEnv(cwd: string): Promise<unknown>;
  resolveLaunchSpec(location: ProjectLocation, argv: AgentArgvSpec): CommandSpec;
}

/**
 * Replaces a terminal session whose provider-native resume id is no longer
 * valid. Each session gets at most one recovery, and callers can await that
 * exact in-flight attempt instead of polling for its side effects.
 */
export class InvalidSessionRecoveryCoordinator {
  private readonly recoveries = new WeakMap<SessionRuntime, Promise<void>>();

  constructor(private readonly context: InvalidSessionRecoveryContext) {}

  recover(session: SessionRuntime): Promise<void> {
    const existing = this.recoveries.get(session);
    if (existing) return existing;
    if (!session.sessionRef) {
      return Promise.resolve();
    }

    const recovery = this.recoverOnce(session);
    this.recoveries.set(session, recovery);
    void recovery.catch((error: unknown) => {
      if (this.context.isCurrentSession(session)) {
        this.context.failStructuredSession(session, error);
      }
    });
    return recovery;
  }

  private async recoverOnce(session: SessionRuntime): Promise<void> {
    const context = this.context;
    if (!context.isCurrentSession(session)) {
      return;
    }
    const personalMcpCredentialEpoch = context.getPersonalMcpCredentialEpoch?.() ?? 0;
    const mcpLaunchSnapshot = session.mcpLaunchSnapshot;
    const mcpIdentity: McpLaunchIdentity = {
      ...session.mcpIdentity,
      threadId: session.threadId,
      launchId: randomUUID(),
      browserEvidenceTurnId: randomUUID(),
    };
    const launchConfig = context.spawnPipeline.resolveMcpLaunchConfig(
      workspaceLaunchConfig(
        session.projectLocation,
        session.config,
        session.adapter,
        mcpLaunchSnapshot.disabledBuiltInMcpServerIds,
        mcpLaunchSnapshot.pluginBuiltInMcpServerIds,
      ),
      mcpLaunchSnapshot,
      session.adapter,
      session.threadId,
    );
    context.beginMcpLaunchAuthorization({
      identity: mcpIdentity,
      adapter: session.adapter,
      config: session.config,
      launchConfig,
      mcpLaunchSnapshot,
      personalMcpCredentialEpoch,
    });

    try {
      session.ignoreExit = true;
      context.outputPipeline.clearSessionTimers(session);
      session.stopSessionRefWatcher?.();
      session.stopSessionRefWatcher = undefined;
      await session.structuredSession?.dispose();
      if (session.structuredSession) {
        await context.settleAfterStructuredDispose();
      }
      context.ptyLifecycle.kill(session);

      if (!context.isCurrentSession(session)) {
        return;
      }

      const resolvedMcpServers = await context.spawnPipeline.resolveMcpServersForLaunch({
        location: session.projectLocation,
        config: launchConfig,
        mcpLaunchSnapshot,
        identity: mcpIdentity,
        crossagentThreadId: session.threadId,
        adapter: session.adapter,
      });
      const cliHookExtras = await context.cliHookPlugin.resolveCliHookPluginExtras(
        session.threadId,
        session.agentKind,
        session.projectLocation,
        resolvedMcpServers,
      );
      if (!context.isCurrentSession(session)) {
        return;
      }

      const argv = session.adapter.buildLaunchArgv(
        session.projectLocation,
        launchConfig,
        session.launchPrompt,
        undefined,
        context.spawnPipeline.composeLaunchOptions(session.adapter, undefined, resolvedMcpServers),
      );
      const cleanupArgv = onceRecoveryLaunchCleanup(argv.cleanup);
      if (cleanupArgv) argv.cleanup = cleanupArgv;
      let argvTransferred = false;
      try {
        if (cliHookExtras.extraArgs.length > 0) {
          argv.args = mergeCliHookExtraArgs(
            session.adapter,
            argv.args,
            cliHookExtras.extraArgs,
            session.launchPrompt,
          );
        }
        argv.args = await applyLaunchArgsConfigRewrite(
          session.adapter,
          argv.args,
          session.config,
          session.projectLocation,
        );
        if (shouldPrimeNativeProjectShellEnv(session.projectLocation)) {
          await context.primeProjectShellEnv(session.projectLocation.path);
        }
        if (!context.isCurrentSession(session)) {
          return;
        }
        const command = context.resolveLaunchSpec(session.projectLocation, argv);

        context.spawnPipeline.spawnThread({
          threadId: session.threadId,
          agentKind: session.agentKind,
          adapter: session.adapter,
          projectLocation: session.projectLocation,
          config: session.config,
          initialSize: session.terminalSize,
          launchPrompt: session.launchPrompt,
          command,
          mcpLaunchSnapshot,
          launchConfig,
          mcpIdentity,
          ...(session.nativePlugins ? { nativePlugins: session.nativePlugins } : {}),
          ...(Object.keys(cliHookExtras.env).length > 0 ? { extraEnv: cliHookExtras.env } : {}),
        });
        argvTransferred = true;
      } finally {
        if (!argvTransferred) cleanupArgv?.();
      }
    } finally {
      context.revokeMcpLaunchAuthorization(mcpIdentity);
    }
  }
}

function onceRecoveryLaunchCleanup(cleanup: (() => void) | undefined): (() => void) | undefined {
  if (!cleanup) return undefined;
  let called = false;
  return () => {
    if (called) return;
    called = true;
    cleanup();
  };
}
