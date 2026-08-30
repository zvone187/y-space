import type { RuntimeEvent } from "@/shared/contracts";
import type { StructuredSessionHandle } from "@/supervisor/agents/base";
import { runOneShotChild, type OneShotChildHandle } from "./oneShotChild";
import type { PreparedSubagentRun, ResolvedSpawnAttempt } from "./spawnPlan";
import { resolveSubagentExecution } from "./types";
import type { SubagentRunHost, SubagentRunStatus } from "./types";

export interface AttemptExecutionState {
  parentThreadId: string;
  childThreadId: string;
  label: string;
  plan: PreparedSubagentRun;
  handle: StructuredSessionHandle | undefined;
  oneShot: OneShotChildHandle | undefined;
  launchReady: Promise<void> | undefined;
  launchSettled: boolean;
  teardownPromise: Promise<void> | undefined;
  cancelRequested: boolean;
  turnStarted: boolean;
  turnDispatched: boolean;
}

interface AttemptCallbacks {
  isActive(): boolean;
  onRuntimeEvent(event: RuntimeEvent): void;
  onSettle(status: Exclude<SubagentRunStatus, "running">, errorMessage?: string): void;
}

/** Executes one resolved structured or one-shot attempt for a logical run. */
export class SubagentAttemptRunner {
  constructor(private readonly host: SubagentRunHost) {}

  run(
    state: AttemptExecutionState,
    attemptIndex: number,
    attempt: ResolvedSpawnAttempt,
    callbacks: AttemptCallbacks,
  ): void {
    const execution = resolveSubagentExecution(attempt.adapter);
    if (
      attempt.config.browserMcp === true &&
      (execution === "one-shot" || attempt.adapter.browserRouting?.gui !== "exclusive")
    ) {
      callbacks.onSettle(
        "failed",
        `Y Space Browser is required for ${attempt.adapter.label}, but this subagent path does not provide an exclusive embedded Browser connection.`,
      );
      return;
    }
    if (execution === "one-shot") {
      state.launchReady = Promise.resolve();
      state.launchSettled = true;
      this.runOneShot(state, attemptIndex, attempt, callbacks);
      return;
    }
    state.launchSettled = false;
    let resolveLaunchReady!: () => void;
    state.launchReady = new Promise<void>((resolve) => {
      resolveLaunchReady = resolve;
    });
    let launchReady = false;
    const markLaunchReady = () => {
      if (launchReady) return;
      launchReady = true;
      state.launchSettled = true;
      resolveLaunchReady();
    };
    void this.runStructured(state, attempt, callbacks, markLaunchReady);
  }

  async teardown(state: AttemptExecutionState): Promise<void> {
    if (state.teardownPromise) return await state.teardownPromise;
    const parentThreadId = state.parentThreadId;
    const childThreadId = state.childThreadId;
    const launchReady = state.launchReady;
    state.teardownPromise = (async () => {
      // Fail closed before the first await. The returned cleanup owns only the
      // detached filter deployment; authorization and relay bearers are gone.
      const filterCleanup = this.host.revokeParentMcpAccess?.(parentThreadId, childThreadId);
      try {
        const firstStructuredHandle = await this.disposeCurrentHandles(state);
        const needsPostLaunchRedispose = Boolean(firstStructuredHandle && !state.launchSettled);
        await launchReady;
        if (needsPostLaunchRedispose && firstStructuredHandle) {
          // Some SDK handles publish themselves before activation has finished.
          // Their first dispose can legitimately see no worker/server yet; once
          // activation unwinds, dispose the same handle again so a late-created
          // resource cannot outlive the revoked child capability.
          await this.disposeHandle(firstStructuredHandle);
        }
        // A structured launch may have published its handle while teardown was
        // waiting for creation. Take a second pass before deleting the detached
        // filter deployment.
        await this.disposeCurrentHandles(state);
      } finally {
        filterCleanup?.();
      }
    })();
    await state.teardownPromise;
  }

  private async runStructured(
    state: AttemptExecutionState,
    attempt: ResolvedSpawnAttempt,
    callbacks: AttemptCallbacks,
    markLaunchReady: () => void,
  ): Promise<void> {
    const { adapter, config } = attempt;
    try {
      const mcpAccess = await this.host.resolveParentMcpAccess?.(
        state.parentThreadId,
        { threadId: state.childThreadId, title: state.label },
        adapter.kind,
        config,
      );
      if (!callbacks.isActive()) {
        return;
      }

      const handle = await adapter.createStructuredSession?.({
        threadId: state.childThreadId,
        projectLocation: state.plan.projectLocation,
        config,
        presentationMode: "gui",
        // Same contract as SpawnPipeline.createStructuredSession: the shared
        // runtime — not the provider — supplies `baseSpawnEnv`, so a structured
        // subagent child spawns with the provider's updater/telemetry opt-outs.
        ...(adapter.baseSpawnEnv ? { baseSpawnEnv: adapter.baseSpawnEnv } : {}),
        ...(mcpAccess ?? {}),
      });
      if (!handle) {
        callbacks.onSettle("failed", "Failed to create subagent session");
        return;
      }
      if (!callbacks.isActive() || state.cancelRequested) {
        await this.disposeHandle(handle);
        return;
      }

      state.handle = handle;
      handle.setListener({
        onClose: () =>
          callbacks.onSettle("failed", "Subagent session closed before the turn completed"),
        onError: (message) => callbacks.onSettle("failed", message),
        onUpdate: (update) => {
          if (callbacks.isActive() && state.turnStarted && update.status === "idle") {
            callbacks.onSettle("completed");
          }
        },
        onRuntimeEvent: callbacks.onRuntimeEvent,
      });
      if (handle.activate) await handle.activate();
      if (!callbacks.isActive() || state.cancelRequested) return;
      if (handle.openThread) await handle.openThread(config);
      if (!callbacks.isActive() || state.cancelRequested) return;
      if (!handle.startTurn) {
        callbacks.onSettle("failed", "Subagent session cannot start a turn");
        return;
      }
      state.turnStarted = true;
      state.turnDispatched = true;
      await handle.startTurn(state.plan.prompt, config);
    } catch (error) {
      callbacks.onSettle(
        state.cancelRequested ? "cancelled" : "failed",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      markLaunchReady();
    }
  }

  private runOneShot(
    state: AttemptExecutionState,
    attemptIndex: number,
    attempt: ResolvedSpawnAttempt,
    callbacks: AttemptCallbacks,
  ): void {
    const { adapter, config } = attempt;
    const itemId = `attempt-${attemptIndex + 1}-oneshot-out`;
    let opened = false;
    const ensureOpen = () => {
      if (opened) return;
      opened = true;
      callbacks.onRuntimeEvent({
        type: "item.started",
        threadId: state.childThreadId,
        itemId,
        itemType: "assistant_message",
      });
    };

    const handle = runOneShotChild({
      adapter,
      projectLocation: state.plan.projectLocation,
      model: config.model,
      effort: config.effort,
      prompt: state.plan.prompt,
      onTextDelta: (delta) => {
        ensureOpen();
        callbacks.onRuntimeEvent({
          type: "content.delta",
          threadId: state.childThreadId,
          itemId,
          stream: "assistant_text",
          delta,
        });
      },
      onSettle: ({ status, errorMessage }) => {
        if (opened) {
          callbacks.onRuntimeEvent({
            type: "item.completed",
            threadId: state.childThreadId,
            itemId,
          });
        }
        callbacks.onSettle(status, errorMessage);
      },
    });

    state.turnDispatched = true;
    state.oneShot = handle;
    if (state.cancelRequested) handle.cancel();
  }

  private async disposeHandle(handle: StructuredSessionHandle): Promise<void> {
    try {
      if (handle.interruptTurn) await handle.interruptTurn();
    } catch {}
    try {
      await handle.dispose();
    } catch {}
  }

  private async disposeCurrentHandles(
    state: AttemptExecutionState,
  ): Promise<StructuredSessionHandle | undefined> {
    const oneShot = state.oneShot;
    state.oneShot = undefined;
    if (oneShot) await oneShot.dispose();

    const handle = state.handle;
    state.handle = undefined;
    if (handle) await this.disposeHandle(handle);
    return handle;
  }
}
