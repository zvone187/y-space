import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PIPEDREAM_PERSONAL_MCP_SERVER_ID,
  PIPEDREAM_PERSONAL_MCP_URL,
  type AgentKind,
  type McpServer,
  type ProjectLocation,
  type ResolvedMcpServer,
} from "@/shared/contracts";
import type { McpThreadIdentity } from "@/shared/browserMcpThread";
import type { SupervisorEvent } from "@/shared/ipc";
import { MAX_BROWSER_EVIDENCE_ACTIONS_PER_TURN } from "@/shared/browserMcpEvidence";
import type { AgentAdapter, StructuredSessionHandle } from "../agents/base";
import type { WindowsShellPreference } from "../shellPreference";
import type { SessionRuntime } from "./sessionTypes";
import type { McpLaunchAuthorization, McpLaunchIdentity } from "./threadSession/spawnPipeline";
import { BROWSER_MCP_TOKEN_ENV, BROWSER_MCP_URL_ENV } from "../agents/browserMcp";

const captureSupervisorException = vi.hoisted(() =>
  vi.fn<(error: unknown, tags?: Record<string, string>) => void>(),
);

vi.mock("../diagnostics/sentry", async (importActual) => {
  const actual = await importActual<typeof import("../diagnostics/sentry")>();
  return { ...actual, captureSupervisorException };
});

vi.mock("../agents/base", async (importActual) => {
  const actual = await importActual<typeof import("../agents/base")>();
  return {
    ...actual,
    getRefreshedWindowsPath: vi.fn<() => string | undefined>(() => undefined),
    primeProjectShellEnv: vi.fn<(cwd: string) => Promise<Record<string, string> | undefined>>(() =>
      Promise.resolve(undefined),
    ),
  };
});

// These tests synchronize lifecycle races with explicit deferred promises;
// the production-only 150ms process-settle pause adds no behavioral coverage.
vi.mock("node:timers/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:timers/promises")>();
  return {
    ...actual,
    setTimeout: vi.fn<(delay?: number) => Promise<void>>(async () => undefined),
  };
});

import { ThreadSessionManager } from "./threadSessionManager";
import { spawn as spawnPty } from "node-pty";

vi.mock("node-pty", () => ({
  spawn: vi.fn<
    () => {
      pid: number;
      kill: () => void;
      onData: () => void;
      onExit: () => void;
      write: () => void;
    }
  >(() => ({
    pid: 123,
    kill: vi.fn<() => void>(),
    onData: vi.fn<() => void>(),
    onExit: vi.fn<() => void>(),
    write: vi.fn<() => void>(),
  })),
}));

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function inertCrossagentMcp(cancelAll: (threadId: string) => void | Promise<void>) {
  return {
    register: () => undefined,
    registerProviderSession: () => undefined,
    unregister: vi.fn<(threadId: string) => void>(),
    cancelForeground: vi.fn<(threadId: string) => void>(),
    cancelAll,
    resolveChildRequest: () => false,
  };
}

function createManager(
  agentKind: AgentKind,
  adapter: AgentAdapter,
  emit: (event: SupervisorEvent) => void = vi.fn<(event: SupervisorEvent) => void>(),
  resolveWindowsShell: () => WindowsShellPreference = () => ({
    shell: "powershell.exe",
    kind: "powershell" as const,
    args: ["-NoLogo"],
  }),
  releasePipedreamMcpBindings?: (threadId: string) => void,
): ThreadSessionManager {
  const tempDir = mkdtempSync(join(tmpdir(), "poracode-start-close-"));
  tempDirs.push(tempDir);
  const manager = new ThreadSessionManager({
    emit,
    isDev: false,
    logsDir: join(tempDir, "logs"),
    settingsPath: join(tempDir, "settings.json"),
    readDisableCliHookPlugin: () => false,
    adapters: new Map([[agentKind, adapter]]),
    resolveWindowsShell,
    ...(releasePipedreamMcpBindings ? { releasePipedreamMcpBindings } : {}),
    resolvePluginEnvForSpawn: async (input) =>
      input.agentKind === "codex"
        ? {
            env: {
              PORACODE_HOOK_URL: "http://127.0.0.1:43200/v1/agent-event",
              PORACODE_HOOK_SECRET: "thread-session-manager-test-hook-secret",
              PORACODE_HOOK_NONCE: "thread-session-manager-test-hook-secret",
              PORACODE_HOOK_PROTOCOL_VERSION: "1",
              PORACODE_THREAD_ID: input.threadId,
              PORACODE_AGENT_KIND: "codex",
              CODEX_HOME: join(tempDir, "agent-plugins", "codex", "home"),
              CODEX_SQLITE_HOME: join(tempDir, "codex-profile"),
            },
            extraArgs: ["--dangerously-bypass-hook-trust", "--enable", "hooks"],
          }
        : undefined,
  });
  managersToDispose.push(manager);
  return manager;
}

function createStructuredSession(
  activation: Promise<void>,
  onActivate?: () => void,
): StructuredSessionHandle {
  return {
    launchOptions: {},
    activate: vi.fn<NonNullable<StructuredSessionHandle["activate"]>>(() => {
      onActivate?.();
      return activation;
    }),
    openThread: vi.fn<NonNullable<StructuredSessionHandle["openThread"]>>(async () => "ses_test"),
    setListener: vi.fn<StructuredSessionHandle["setListener"]>(),
    dispose: vi.fn<StructuredSessionHandle["dispose"]>(async () => undefined),
  };
}

function createAdapter(
  agentKind: AgentKind,
  structuredSession: StructuredSessionHandle,
): AgentAdapter {
  return {
    kind: agentKind,
    label: agentKind,
    binary: agentKind,
    browserRouting: { terminal: "exclusive", gui: "exclusive" },
    capabilities: {
      models: [],
      efforts: [],
      modelEfforts: {},
      modes: [],
      approvalPolicies: [],
      sandboxModes: [],
      supportsResume: true,
      supportsDirectInput: true,
      liveInputMode: "terminal",
      presentationMode: "terminal",
      presentationModes: ["terminal", "gui"],
      settingDefs: [],
    },
    detectInstall: vi.fn<AgentAdapter["detectInstall"]>(),
    buildLaunchArgv: vi.fn<AgentAdapter["buildLaunchArgv"]>(() => ({
      binary: agentKind,
      args: [],
    })),
    buildResumeArgv: vi.fn<AgentAdapter["buildResumeArgv"]>(() => ({
      binary: agentKind,
      args: [],
    })),
    createInitialSessionRef: vi.fn<AgentAdapter["createInitialSessionRef"]>(() => undefined),
    createStructuredSession: vi.fn<NonNullable<AgentAdapter["createStructuredSession"]>>(
      async () => structuredSession,
    ),
  };
}

function createInactiveRuntime(
  agentKind: AgentKind,
  adapter: AgentAdapter,
  structuredSession: StructuredSessionHandle,
): SessionRuntime {
  return {
    instanceId: `instance-${agentKind}`,
    threadId: `thread-${agentKind}`,
    agentKind,
    adapter,
    projectLocation: { kind: "windows", path: "C:\\repo" },
    config: { model: `${agentKind}/model` },
    terminalSize: { cols: 80, rows: 24 },
    launchPrompt: "",
    sessionRef: { providerSessionId: "ses_existing" },
    status: "inactive",
    attention: "none",
    canResumeWithConfig: true,
    outputLength: 0,
    prevChunk: "",
    lastStrippedPtyChunk: "",
    ptyOscCarry: "",
    presentationMode: "gui",
    structuredSession,
    mcpLaunchSnapshot: { mcpServers: [], disabledBuiltInMcpServerIds: [] },
  } as unknown as SessionRuntime;
}

function attachAuthorizedRuntime(
  manager: ThreadSessionManager,
  runtime: SessionRuntime,
): McpLaunchIdentity {
  const identity: McpLaunchIdentity = {
    ...runtime.mcpIdentity,
    threadId: runtime.threadId,
    launchId: runtime.mcpIdentity?.launchId ?? `launch-${runtime.threadId}`,
  };
  runtime.mcpIdentity = identity;
  manager.sessions.set(runtime.threadId, runtime);
  const authorization: McpLaunchAuthorization = {
    identity,
    adapter: runtime.adapter,
    config: runtime.config,
    launchConfig: runtime.launchConfig ?? runtime.config,
    mcpLaunchSnapshot: runtime.mcpLaunchSnapshot,
  };
  const capabilityManager = manager as unknown as {
    beginMcpLaunchAuthorization(authorization: McpLaunchAuthorization): void;
    activateMcpLaunchAuthorization(session: SessionRuntime): void;
  };
  capabilityManager.beginMcpLaunchAuthorization(authorization);
  capabilityManager.activateMcpLaunchAuthorization(runtime);
  return identity;
}

function collectRuntimeEvents(events: readonly SupervisorEvent[]) {
  return events.flatMap((event) => {
    if (event.type === "thread-runtime-event") return [event.event];
    if (event.type === "thread-runtime-events") return event.events;
    if (event.type === "thread-runtime-events-multi") {
      return event.batches.flatMap((batch) => batch.events);
    }
    return [];
  });
}

const guardedStructuredProviders = ["codex", "opencode"] as const;
const managersToDispose: ThreadSessionManager[] = [];
const tempDirs: string[] = [];
const savedBrowserMcpUrl = process.env[BROWSER_MCP_URL_ENV];
const savedBrowserMcpToken = process.env[BROWSER_MCP_TOKEN_ENV];

beforeEach(() => {
  process.env[BROWSER_MCP_URL_ENV] = "http://127.0.0.1:43199";
  process.env[BROWSER_MCP_TOKEN_ENV] = "thread-session-manager-test-browser-token";
});

it("releases only the exact exited MCP launch and every child binding it authorized", () => {
  const structuredSession = createStructuredSession(Promise.resolve());
  const adapter = createAdapter("codex", structuredSession);
  const releasePipedreamMcpBindings = vi.fn<(threadId: string) => void>();
  const manager = createManager(
    "codex",
    adapter,
    undefined,
    undefined,
    releasePipedreamMcpBindings,
  );
  const current = createInactiveRuntime("codex", adapter, structuredSession);
  current.status = "idle";
  const currentIdentity = attachAuthorizedRuntime(manager, current);
  releasePipedreamMcpBindings.mockClear();

  const childThreadId = "thread-codex-child";
  const internals = manager as unknown as {
    releaseExitedMcpLaunch(session: SessionRuntime): void;
    rootMcpLaunchAuthorities: Map<string, unknown>;
    subagentMcpLaunchAuthorities: Map<string, unknown>;
  };
  internals.subagentMcpLaunchAuthorities.set(childThreadId, {
    parentThreadId: current.threadId,
    parentSessionInstanceId: current.instanceId,
    authorization: {
      identity: { threadId: childThreadId, launchId: "child-launch" },
      adapter,
      config: current.config,
      launchConfig: current.config,
      mcpLaunchSnapshot: current.mcpLaunchSnapshot,
    },
  });
  const stale = {
    ...current,
    instanceId: "stale-instance",
    mcpIdentity: { ...currentIdentity, launchId: "stale-launch" },
  } as SessionRuntime;

  internals.releaseExitedMcpLaunch(stale);

  expect(releasePipedreamMcpBindings).not.toHaveBeenCalled();
  expect(internals.rootMcpLaunchAuthorities.has(current.threadId)).toBe(true);
  expect(internals.subagentMcpLaunchAuthorities.has(childThreadId)).toBe(true);

  internals.releaseExitedMcpLaunch(current);

  expect(releasePipedreamMcpBindings.mock.calls.map(([threadId]) => threadId)).toEqual([
    current.threadId,
    childThreadId,
  ]);
  expect(internals.rootMcpLaunchAuthorities.has(current.threadId)).toBe(false);
  expect(internals.subagentMcpLaunchAuthorities.has(childThreadId)).toBe(false);
});

afterEach(async () => {
  for (const manager of managersToDispose.splice(0)) {
    await manager.dispose();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (savedBrowserMcpUrl === undefined) delete process.env[BROWSER_MCP_URL_ENV];
  else process.env[BROWSER_MCP_URL_ENV] = savedBrowserMcpUrl;
  if (savedBrowserMcpToken === undefined) delete process.env[BROWSER_MCP_TOKEN_ENV];
  else process.env[BROWSER_MCP_TOKEN_ENV] = savedBrowserMcpToken;
});

describe("ThreadSessionManager provider-session routing", () => {
  it("records authenticated Browser outcomes for the exact current launch and user turn", async () => {
    const structuredSession = createStructuredSession(Promise.resolve());
    const adapter = createAdapter("codex", structuredSession);
    const events: SupervisorEvent[] = [];
    const manager = createManager("codex", adapter, (event) => events.push(event));
    const runtime = createInactiveRuntime("codex", adapter, structuredSession);
    runtime.threadId = "browser-evidence-current-turn";
    runtime.status = "idle";
    runtime.config = { model: "codex/model", browserMcp: true };
    runtime.launchConfig = { ...runtime.config };
    const identity = attachAuthorizedRuntime(manager, runtime);
    const firstTurnId = identity.browserEvidenceTurnId!;
    const report = {
      threadId: runtime.threadId,
      launchId: identity.launchId,
      turnId: firstTurnId,
      toolName: "navigate",
      success: true,
      occurredAt: 1_778_000_000_000,
      tabId: "tab-proof",
      url: "http://127.0.0.1:41739/alpha",
      title: "Alpha",
    } as const;

    expect(manager.recordBrowserMcpToolCall({ ...report, toolName: "enable" })).toBe(false);
    expect(manager.recordBrowserMcpToolCall({ ...report, toolName: "list_tabs" })).toBe(false);
    expect(manager.recordBrowserMcpToolCall(report)).toBe(true);
    const proofEvents = collectRuntimeEvents(events);
    expect(proofEvents).toEqual([
      expect.objectContaining({
        type: "item.started",
        threadId: runtime.threadId,
        itemType: "mcp_tool_call",
        payload: expect.objectContaining({
          name: "navigate",
          serverId: "browser",
          status: "success",
          browserEvidence: {
            source: "y-space-browser-mcp",
            occurredAt: 1_778_000_000_000,
            tabId: "tab-proof",
            url: "http://127.0.0.1:41739/alpha",
            title: "Alpha",
          },
        }),
      }),
      expect.objectContaining({ type: "item.completed", threadId: runtime.threadId }),
    ]);

    const eventCountBeforeFailure = collectRuntimeEvents(events).length;
    expect(
      manager.recordBrowserMcpToolCall({
        ...report,
        toolName: "select",
        success: false,
        tabId: "tab-must-not-leak",
        url: "https://secret.example/private?token=must-not-leak",
        title: "Must not leak",
      }),
    ).toBe(true);
    expect(collectRuntimeEvents(events).slice(eventCountBeforeFailure)).toEqual([
      expect.objectContaining({
        type: "item.started",
        threadId: runtime.threadId,
        itemType: "mcp_tool_call",
        payload: {
          name: "select",
          serverId: "browser",
          status: "error",
          browserEvidence: {
            source: "y-space-browser-mcp",
            occurredAt: 1_778_000_000_000,
          },
        },
      }),
      expect.objectContaining({ type: "item.completed", threadId: runtime.threadId }),
    ]);
    expect(manager.recordBrowserMcpToolCall({ ...report, launchId: "stale-launch" })).toBe(false);

    const internal = manager as unknown as {
      beginBrowserEvidenceTurnForSession(session: SessionRuntime): string | undefined;
    };
    const nextTurnId = internal.beginBrowserEvidenceTurnForSession(runtime)!;
    expect(nextTurnId).not.toBe(firstTurnId);
    expect(manager.recordBrowserMcpToolCall(report)).toBe(false);
    expect(manager.recordBrowserMcpToolCall({ ...report, turnId: nextTurnId })).toBe(true);

    await manager.closeThread({ threadId: runtime.threadId });
    expect(manager.recordBrowserMcpToolCall({ ...report, turnId: nextTurnId })).toBe(false);
  });

  it("retains one negative Browser outcome after the successful evidence cap is full", () => {
    const structuredSession = createStructuredSession(Promise.resolve());
    const adapter = createAdapter("codex", structuredSession);
    const events: SupervisorEvent[] = [];
    const manager = createManager("codex", adapter, (event) => events.push(event));
    const runtime = createInactiveRuntime("codex", adapter, structuredSession);
    runtime.threadId = "browser-evidence-cap-failure";
    runtime.status = "idle";
    runtime.config = { model: "codex/model", browserMcp: true };
    runtime.launchConfig = { ...runtime.config };
    const identity = attachAuthorizedRuntime(manager, runtime);
    const report = {
      threadId: runtime.threadId,
      launchId: identity.launchId,
      turnId: identity.browserEvidenceTurnId!,
      toolName: "click",
      success: true,
      occurredAt: 1_778_000_000_000,
    } as const;

    for (let index = 0; index < MAX_BROWSER_EVIDENCE_ACTIONS_PER_TURN; index += 1) {
      expect(
        manager.recordBrowserMcpToolCall({ ...report, occurredAt: report.occurredAt + index }),
      ).toBe(true);
    }
    expect(manager.recordBrowserMcpToolCall(report)).toBe(false);
    const eventCountBeforeFailure = collectRuntimeEvents(events).length;

    expect(
      manager.recordBrowserMcpToolCall({ ...report, toolName: "select", success: false }),
    ).toBe(true);
    expect(collectRuntimeEvents(events).slice(eventCountBeforeFailure)).toEqual([
      expect.objectContaining({
        type: "item.started",
        payload: expect.objectContaining({ name: "select", status: "error" }),
      }),
      expect.objectContaining({ type: "item.completed" }),
    ]);
  });

  it("rotates Browser proof authority across an accepted restart prompt", async () => {
    const structuredSession = createStructuredSession(Promise.resolve());
    structuredSession.startTurn = vi.fn<NonNullable<StructuredSessionHandle["startTurn"]>>(
      async () => undefined,
    );
    const adapter = createAdapter("codex", structuredSession);
    const manager = createManager("codex", adapter);
    const runtime = createInactiveRuntime("codex", adapter, structuredSession);
    runtime.threadId = "browser-evidence-restart";
    runtime.config = { model: "codex/model", browserMcp: true };
    runtime.launchConfig = { ...runtime.config };
    const oldIdentity = { ...attachAuthorizedRuntime(manager, runtime) };

    await manager.sendThreadInput({
      threadId: runtime.threadId,
      prompt: "continue in the embedded browser",
      config: runtime.config,
    });

    const restarted = manager.sessions.get(runtime.threadId)!;
    const newIdentity = manager.resolveMcpCallerIdentity({
      routing: "thread",
      threadId: runtime.threadId,
      launchId: restarted.mcpIdentity!.launchId,
      serverId: "browser",
    })!;
    expect(newIdentity.launchId).not.toBe(oldIdentity.launchId);
    expect(newIdentity.browserEvidenceTurnId).not.toBe(oldIdentity.browserEvidenceTurnId);
    expect(
      manager.recordBrowserMcpToolCall({
        threadId: runtime.threadId,
        launchId: oldIdentity.launchId,
        turnId: oldIdentity.browserEvidenceTurnId!,
        toolName: "snapshot",
        success: true,
        occurredAt: Date.now(),
      }),
    ).toBe(false);
    expect(
      manager.recordBrowserMcpToolCall({
        threadId: runtime.threadId,
        launchId: newIdentity.launchId!,
        turnId: newIdentity.browserEvidenceTurnId!,
        toolName: "snapshot",
        success: true,
        occurredAt: Date.now(),
      }),
    ).toBe(true);
  });

  it("attributes structured-child Browser proof to the current parent turn only", async () => {
    const structuredSession = createStructuredSession(Promise.resolve());
    const adapter = createAdapter("codex", structuredSession);
    const events: SupervisorEvent[] = [];
    const manager = createManager("codex", adapter, (event) => events.push(event));
    const parent = createInactiveRuntime("codex", adapter, structuredSession);
    parent.threadId = "browser-evidence-parent";
    parent.status = "idle";
    parent.config = { model: "codex/model", browserMcp: true };
    parent.launchConfig = { ...parent.config };
    const parentIdentity = attachAuthorizedRuntime(manager, parent);
    structuredSession.startTurn = vi.fn<NonNullable<StructuredSessionHandle["startTurn"]>>(
      async () => undefined,
    );
    structuredSession.steerTurn = vi.fn<NonNullable<StructuredSessionHandle["steerTurn"]>>(
      async () => undefined,
    );

    const spawnPipeline = (
      manager as unknown as {
        spawnPipeline: {
          resolveMcpServersForLaunch(input: {
            identity: McpThreadIdentity;
          }): Promise<ResolvedMcpServer[]>;
        };
      }
    ).spawnPipeline;
    const childIdentities: McpThreadIdentity[] = [];
    vi.spyOn(spawnPipeline, "resolveMcpServersForLaunch").mockImplementation(async (input) => {
      childIdentities.push(input.identity);
      return [];
    });
    const authorizeChild = async (threadId: string) => {
      await manager.resolveSubagentParentMcpAccess(
        parent.threadId,
        { threadId, title: threadId },
        "codex",
        { model: "codex/model", browserMcp: true },
      );
      return childIdentities.at(-1)!;
    };

    const firstChild = await authorizeChild("browser-evidence-child-1");
    const firstChildTurnId = firstChild.browserEvidenceTurnId!;
    expect(firstChild.browserEvidenceTurnId).toBe(parentIdentity.browserEvidenceTurnId);
    expect(
      manager.recordBrowserMcpToolCall({
        threadId: firstChild.threadId!,
        launchId: firstChild.launchId!,
        turnId: firstChildTurnId,
        toolName: "click",
        success: true,
        occurredAt: Date.now(),
      }),
    ).toBe(true);
    expect(
      collectRuntimeEvents(events).some(
        (event) =>
          event.type === "item.started" &&
          event.threadId === parent.threadId &&
          event.itemType === "mcp_tool_call",
      ),
    ).toBe(true);

    parent.status = "working";
    await manager.setPendingSteer({
      threadId: parent.threadId,
      prompt: "continue through the surviving child",
      config: parent.config,
    });
    const nextTurnId = parent.mcpIdentity!.browserEvidenceTurnId!;
    expect(nextTurnId).not.toBe(firstChildTurnId);
    expect(firstChild.browserEvidenceTurnId).toBe(nextTurnId);
    expect(structuredSession.steerTurn).toHaveBeenCalledOnce();
    expect(
      manager.recordBrowserMcpToolCall({
        threadId: firstChild.threadId!,
        launchId: firstChild.launchId!,
        turnId: firstChildTurnId,
        toolName: "click",
        success: true,
        occurredAt: Date.now(),
      }),
    ).toBe(false);
    expect(
      manager.recordBrowserMcpToolCall({
        threadId: firstChild.threadId!,
        launchId: firstChild.launchId!,
        turnId: nextTurnId,
        toolName: "snapshot",
        success: true,
        occurredAt: Date.now(),
      }),
    ).toBe(true);

    const nextChild = await authorizeChild("browser-evidence-child-2");
    expect(nextChild.browserEvidenceTurnId).toBe(nextTurnId);
    expect(
      manager.recordBrowserMcpToolCall({
        threadId: nextChild.threadId!,
        launchId: nextChild.launchId!,
        turnId: nextTurnId,
        toolName: "snapshot",
        success: true,
        occurredAt: Date.now(),
      }),
    ).toBe(true);
  });

  it("drops a child MCP resolution that crossed a Personal credential revocation", async () => {
    const structuredSession = createStructuredSession(Promise.resolve());
    const adapter = createAdapter("codex", structuredSession);
    const manager = createManager("codex", adapter);
    const parent = createInactiveRuntime("codex", adapter, structuredSession);
    parent.threadId = "personal-oauth-pending-child-parent";
    parent.status = "idle";
    attachAuthorizedRuntime(manager, parent);

    const resolution = deferred<ResolvedMcpServer[]>();
    const spawnPipeline = (
      manager as unknown as {
        spawnPipeline: {
          resolveMcpServersForLaunch(): Promise<ResolvedMcpServer[]>;
        };
      }
    ).spawnPipeline;
    const resolveMcpServers = vi
      .spyOn(spawnPipeline, "resolveMcpServersForLaunch")
      .mockReturnValue(resolution.promise);
    const childAccess = manager.resolveSubagentParentMcpAccess(
      parent.threadId,
      { threadId: "personal-oauth-pending-child", title: "pending child" },
      "codex",
      parent.config,
    );
    await vi.waitFor(() => expect(resolveMcpServers).toHaveBeenCalledOnce());

    const revocation = manager.reloadPipedreamMcpServers({ revokePersonalOauth: true });
    resolution.resolve([
      {
        id: PIPEDREAM_PERSONAL_MCP_SERVER_ID,
        name: "pd",
        timeoutMs: 30_000,
        transport: {
          type: "http",
          url: PIPEDREAM_PERSONAL_MCP_URL,
          headers: { Authorization: "Bearer child-stale-token" },
        },
      },
    ]);

    await expect(childAccess).resolves.toEqual({});
    await expect(revocation).resolves.toEqual({ state: "applied" });
    expect(
      (
        manager as unknown as { subagentMcpLaunchAuthorities: Map<string, unknown> }
      ).subagentMcpLaunchAuthorities.has("personal-oauth-pending-child"),
    ).toBe(false);
  });

  it("keeps interrupt-backed steer proof on the old turn until the replacement starts", async () => {
    const interrupt = deferred();
    const structuredSession = createStructuredSession(Promise.resolve());
    structuredSession.startTurn = vi.fn<NonNullable<StructuredSessionHandle["startTurn"]>>(
      async () => undefined,
    );
    structuredSession.interruptTurn = vi.fn<NonNullable<StructuredSessionHandle["interruptTurn"]>>(
      () => interrupt.promise,
    );
    const adapter = createAdapter("codex", structuredSession);
    const events: SupervisorEvent[] = [];
    const manager = createManager("codex", adapter, (event) => events.push(event));
    const parent = createInactiveRuntime("codex", adapter, structuredSession);
    parent.threadId = "browser-evidence-interrupt-steer";
    parent.status = "working";
    parent.config = { model: "codex/model", browserMcp: true };
    parent.launchConfig = { ...parent.config };
    const parentIdentity = attachAuthorizedRuntime(manager, parent);
    const oldTurnId = parentIdentity.browserEvidenceTurnId!;

    const spawnPipeline = (
      manager as unknown as {
        spawnPipeline: {
          resolveMcpServersForLaunch(input: {
            identity: McpThreadIdentity;
          }): Promise<ResolvedMcpServer[]>;
        };
      }
    ).spawnPipeline;
    const childIdentities: McpThreadIdentity[] = [];
    vi.spyOn(spawnPipeline, "resolveMcpServersForLaunch").mockImplementation(async (input) => {
      childIdentities.push(input.identity);
      return [];
    });
    await manager.resolveSubagentParentMcpAccess(
      parent.threadId,
      { threadId: "browser-evidence-interrupt-child", title: "surviving child" },
      "codex",
      parent.config,
    );
    const childIdentity = childIdentities.at(-1)!;
    expect(childIdentity.browserEvidenceTurnId).toBe(oldTurnId);

    await manager.setPendingSteer({
      threadId: parent.threadId,
      prompt: "replacement after interrupt",
      config: parent.config,
    });
    await vi.waitFor(() => expect(structuredSession.interruptTurn).toHaveBeenCalledOnce());

    // Staging and even issuing the interrupt must leave the old nonce in
    // place. Late parent/child work is therefore evidence for the old turn,
    // never for the replacement that has not started yet.
    expect(parent.mcpIdentity!.browserEvidenceTurnId).toBe(oldTurnId);
    expect(childIdentity.browserEvidenceTurnId).toBe(oldTurnId);
    expect(
      manager.recordBrowserMcpToolCall({
        threadId: parent.threadId,
        launchId: parentIdentity.launchId,
        turnId: oldTurnId,
        toolName: "snapshot",
        success: true,
        occurredAt: Date.now(),
      }),
    ).toBe(true);
    expect(
      manager.recordBrowserMcpToolCall({
        threadId: childIdentity.threadId!,
        launchId: childIdentity.launchId!,
        turnId: oldTurnId,
        toolName: "click",
        success: true,
        occurredAt: Date.now(),
      }),
    ).toBe(true);
    expect(structuredSession.startTurn).not.toHaveBeenCalled();

    parent.status = "idle";
    const internal = manager as unknown as {
      steerCoordinator: { maybeDrainPendingSteer(session: SessionRuntime): void };
    };
    internal.steerCoordinator.maybeDrainPendingSteer(parent);

    const replacementTurnId = parent.mcpIdentity!.browserEvidenceTurnId!;
    expect(replacementTurnId).not.toBe(oldTurnId);
    expect(childIdentity.browserEvidenceTurnId).toBe(replacementTurnId);
    expect(structuredSession.startTurn).toHaveBeenCalledOnce();
    expect(
      manager.recordBrowserMcpToolCall({
        threadId: childIdentity.threadId!,
        launchId: childIdentity.launchId!,
        turnId: oldTurnId,
        toolName: "snapshot",
        success: true,
        occurredAt: Date.now(),
      }),
    ).toBe(false);
    expect(
      manager.recordBrowserMcpToolCall({
        threadId: childIdentity.threadId!,
        launchId: childIdentity.launchId!,
        turnId: replacementTurnId,
        toolName: "snapshot",
        success: true,
        occurredAt: Date.now(),
      }),
    ).toBe(true);

    const runtimeEvents = collectRuntimeEvents(events);
    const replacementUserIndex = runtimeEvents.findIndex(
      (event) => event.type === "item.started" && event.itemType === "user_message",
    );
    const proofIndexes = runtimeEvents.flatMap((event, index) =>
      event.type === "item.started" && event.itemType === "mcp_tool_call" ? [index] : [],
    );
    expect(replacementUserIndex).toBeGreaterThan(-1);
    expect(proofIndexes).toHaveLength(3);
    expect(proofIndexes.slice(0, 2).every((index) => index < replacementUserIndex)).toBe(true);
    expect(proofIndexes[2]).toBeGreaterThan(replacementUserIndex);

    interrupt.resolve();
  });

  it.each(["codex", "claude", "opencode"] as const)(
    "authorizes %s Browser and App Controls during provider creation before runtime attachment",
    async (agentKind) => {
      const structuredSession = createStructuredSession(Promise.resolve());
      const adapter = createAdapter(agentKind, structuredSession);
      let manager!: ThreadSessionManager;
      let launchIdentity: McpThreadIdentity | undefined;
      let browserDuringCreation: McpThreadIdentity | undefined;
      let appControlsDuringCreation: McpThreadIdentity | undefined;
      let hadAttachedSessionDuringCreation = true;

      vi.mocked(adapter.createStructuredSession!).mockImplementation(async (input) => {
        launchIdentity = input.mcpIdentity;
        hadAttachedSessionDuringCreation = manager.sessions.has(input.threadId);
        if (input.mcpIdentity?.threadId && input.mcpIdentity.launchId) {
          browserDuringCreation = manager.resolveMcpCallerIdentity({
            routing: "thread",
            threadId: input.mcpIdentity.threadId,
            launchId: input.mcpIdentity.launchId,
            serverId: "browser",
          });
          appControlsDuringCreation = manager.resolveMcpCallerIdentity({
            routing: "thread",
            threadId: input.mcpIdentity.threadId,
            launchId: input.mcpIdentity.launchId,
            serverId: "app-controls",
          });
        }
        return structuredSession;
      });
      manager = createManager(agentKind, adapter);

      await manager.startThread({
        threadId: `launch-capability-${agentKind}`,
        projectLocation: { kind: "windows", path: "C:\\repo" },
        agentKind,
        config: { model: `${agentKind}/model`, browserMcp: true },
        prompt: "",
        initialSize: { cols: 80, rows: 24 },
        presentationMode: "gui",
      });

      expect(hadAttachedSessionDuringCreation).toBe(false);
      expect(launchIdentity?.launchId).toEqual(expect.any(String));
      expect(browserDuringCreation).toEqual(launchIdentity);
      expect(appControlsDuringCreation).toEqual(launchIdentity);
      expect(
        manager.resolveMcpCallerIdentity({
          routing: "thread",
          threadId: launchIdentity!.threadId!,
          launchId: launchIdentity!.launchId,
          serverId: "browser",
        }),
      ).toEqual(launchIdentity);

      await manager.closeThread({ threadId: launchIdentity!.threadId! });
      expect(
        manager.resolveMcpCallerIdentity({
          routing: "thread",
          threadId: launchIdentity!.threadId!,
          launchId: launchIdentity!.launchId,
          serverId: "browser",
        }),
      ).toBeUndefined();
    },
  );

  it("resolves both root and provider-owned child sessions to the live thread", () => {
    const structuredSession = createStructuredSession(Promise.resolve());
    structuredSession.ownsProviderSession = (sessionId) => sessionId === "ses_child";
    const adapter = createAdapter("opencode", structuredSession);
    adapter.capabilities.crossagentMcpRouting = "provider-session";
    const manager = createManager("opencode", adapter);
    const runtime = createInactiveRuntime("opencode", adapter, structuredSession);
    manager.sessions.set(runtime.threadId, runtime);
    manager.sessionsBySessionId.set("ses_existing", runtime);

    expect(manager.getThreadIdByProviderSessionId("ses_existing")).toBe(runtime.threadId);
    expect(manager.getThreadIdByProviderSessionId("ses_child")).toBe(runtime.threadId);
    expect(manager.getThreadIdByProviderSessionId("ses_unknown")).toBeUndefined();

    delete adapter.capabilities.crossagentMcpRouting;
    expect(manager.getThreadIdByProviderSessionId("ses_existing")).toBeUndefined();
  });

  it("resolves root and child provider sessions to the owning MCP identity and expires it", () => {
    const structuredSession = createStructuredSession(Promise.resolve());
    structuredSession.ownsProviderSession = (sessionId) => sessionId === "ses_child";
    const adapter = createAdapter("opencode", structuredSession);
    adapter.capabilities.crossagentMcpRouting = "provider-session";
    const manager = createManager("opencode", adapter);
    const runtime = createInactiveRuntime(
      "opencode",
      adapter,
      structuredSession,
    ) as SessionRuntime & {
      mcpIdentity: { threadId: string; title: string };
    };
    runtime.mcpIdentity = { threadId: runtime.threadId, title: "OpenCode caller" };
    runtime.mcpLaunchSnapshot.disabledBuiltInMcpTools = {
      browser: ["close_tab"],
      "app-controls": ["delete_thread"],
    };
    manager.sessions.set(runtime.threadId, runtime);
    manager.sessionsBySessionId.set("ses_existing", runtime);
    const identityManager = manager as unknown as {
      getMcpIdentityByProviderSessionId(
        providerSessionId: string,
        serverId?: "browser" | "app-controls",
      ): { threadId?: string; title?: string } | undefined;
    };

    expect(identityManager.getMcpIdentityByProviderSessionId("ses_existing")).toEqual(
      runtime.mcpIdentity,
    );
    expect(identityManager.getMcpIdentityByProviderSessionId("ses_child")).toEqual(
      runtime.mcpIdentity,
    );
    expect(identityManager.getMcpIdentityByProviderSessionId("ses_existing", "browser")).toEqual({
      ...runtime.mcpIdentity,
      disabledTools: ["close_tab"],
    });
    expect(identityManager.getMcpIdentityByProviderSessionId("ses_child", "app-controls")).toEqual({
      ...runtime.mcpIdentity,
      disabledTools: ["delete_thread"],
    });
    expect(identityManager.getMcpIdentityByProviderSessionId("ses_unknown")).toBeUndefined();

    manager.sessions.delete(runtime.threadId);
    manager.sessionsBySessionId.delete("ses_existing");
    expect(identityManager.getMcpIdentityByProviderSessionId("ses_existing")).toBeUndefined();
  });

  it("binds built-in MCP identity to the exact live task even in one OpenCode directory", () => {
    const structuredSession = createStructuredSession(Promise.resolve());
    const adapter = createAdapter("opencode", structuredSession);
    adapter.capabilities.mcpConfigSource = "agentSettings";
    adapter.capabilities.agentSettingsDefaults = { browserMcp: true };
    adapter.capabilities.crossagentMcpRouting = "provider-session";
    const manager = createManager("opencode", adapter);
    const first = createInactiveRuntime("opencode", adapter, structuredSession);
    first.threadId = "thread-first";
    first.projectLocation = { kind: "posix", path: "/repo/shared" };
    first.config = { model: "opencode/model", browserMcp: true };
    first.launchConfig = { ...first.config };
    first.sessionRef = { providerSessionId: "ses_first", discoveredAt: new Date().toISOString() };
    first.mcpIdentity = { threadId: first.threadId, title: "First" };
    const second = createInactiveRuntime("opencode", adapter, structuredSession);
    second.threadId = "thread-second";
    second.projectLocation = { kind: "posix", path: "/repo/shared" };
    second.config = { model: "opencode/model", browserMcp: true };
    second.launchConfig = { ...second.config };
    second.sessionRef = {
      providerSessionId: "ses_second",
      discoveredAt: new Date().toISOString(),
    };
    second.mcpIdentity = { threadId: second.threadId, title: "Second" };
    attachAuthorizedRuntime(manager, first);
    attachAuthorizedRuntime(manager, second);
    manager.sessionsBySessionId.set("ses_first", first);
    manager.sessionsBySessionId.set("ses_second", second);
    expect(
      manager.resolveMcpCallerIdentity({
        routing: "thread",
        threadId: "thread-first",
        launchId: first.mcpIdentity!.launchId,
        serverId: "browser",
      }),
    ).toEqual(first.mcpIdentity);
    expect(
      manager.resolveMcpCallerIdentity({
        routing: "thread",
        threadId: "thread-second",
        launchId: second.mcpIdentity!.launchId,
        serverId: "browser",
      }),
    ).toEqual(second.mcpIdentity);

    const settingsPath = (manager as unknown as { options: { settingsPath: string } }).options
      .settingsPath;
    writeFileSync(
      settingsPath,
      JSON.stringify({ agentSettings: { opencode: { browserMcp: false } } }),
      "utf8",
    );
    expect(
      manager.resolveMcpCallerIdentity({
        routing: "thread",
        threadId: "thread-first",
        launchId: first.mcpIdentity!.launchId,
        serverId: "browser",
      }),
    ).toEqual(first.mcpIdentity);

    writeFileSync(
      settingsPath,
      JSON.stringify({ disabledBuiltInMcpServers: { browser: true } }),
      "utf8",
    );
    expect(
      manager.resolveMcpCallerIdentity({
        routing: "thread",
        threadId: "thread-first",
        launchId: first.mcpIdentity!.launchId,
        serverId: "browser",
      }),
    ).toBeUndefined();

    manager.sessions.delete(first.threadId);
    manager.sessionsBySessionId.delete("ses_first");
    expect(
      manager.resolveMcpCallerIdentity({
        routing: "thread",
        threadId: "thread-first",
        launchId: first.mcpIdentity!.launchId,
        serverId: "app-controls",
      }),
    ).toBeUndefined();
  });

  it("rejects an old Browser capability when the live task did not launch Browser", () => {
    const structuredSession = createStructuredSession(Promise.resolve());
    const adapter = createAdapter("codex", structuredSession);
    const manager = createManager("codex", adapter);
    const runtime = createInactiveRuntime("codex", adapter, structuredSession);
    runtime.threadId = "thread-reused-without-browser";
    runtime.config = { model: "codex/model" };
    runtime.launchConfig = { ...runtime.config };
    runtime.mcpIdentity = { threadId: runtime.threadId, title: "Reused task" };
    attachAuthorizedRuntime(manager, runtime);

    expect(
      manager.resolveMcpCallerIdentity({
        routing: "thread",
        threadId: runtime.threadId,
        launchId: runtime.mcpIdentity.launchId,
        serverId: "browser",
      }),
    ).toBeUndefined();
    expect(
      manager.resolveMcpCallerIdentity({
        routing: "thread",
        threadId: runtime.threadId,
        launchId: runtime.mcpIdentity.launchId,
        serverId: "app-controls",
      }),
    ).toEqual(runtime.mcpIdentity);
  });

  it("marks Computer Use identity when the same live task has managed Browser connected", () => {
    const structuredSession = createStructuredSession(Promise.resolve());
    const adapter = createAdapter("codex", structuredSession);
    const manager = createManager("codex", adapter);
    const runtime = createInactiveRuntime("codex", adapter, structuredSession);
    runtime.threadId = "thread-computer-with-browser";
    runtime.config = { model: "codex/model", browserMcp: true, computerUse: true };
    runtime.launchConfig = { ...runtime.config };
    runtime.mcpIdentity = { threadId: runtime.threadId, title: "Desktop task" };
    attachAuthorizedRuntime(manager, runtime);

    expect(
      manager.resolveMcpCallerIdentity({
        routing: "thread",
        threadId: runtime.threadId,
        launchId: runtime.mcpIdentity.launchId,
        serverId: "computer-use",
      }),
    ).toEqual({ ...runtime.mcpIdentity, managedBrowserConnected: true });

    const settingsPath = (manager as unknown as { options: { settingsPath: string } }).options
      .settingsPath;
    writeFileSync(
      settingsPath,
      JSON.stringify({ disabledBuiltInMcpServers: { browser: true } }),
      "utf8",
    );
    expect(
      manager.resolveMcpCallerIdentity({
        routing: "thread",
        threadId: runtime.threadId,
        launchId: runtime.mcpIdentity.launchId,
        serverId: "computer-use",
      }),
    ).toEqual(runtime.mcpIdentity);
  });

  it("rejects a capability from an earlier launch of the same persistent task", () => {
    const structuredSession = createStructuredSession(Promise.resolve());
    const adapter = createAdapter("codex", structuredSession);
    const manager = createManager("codex", adapter);
    const runtime = createInactiveRuntime("codex", adapter, structuredSession);
    runtime.threadId = "thread-restarted";
    runtime.config = { model: "codex/model", browserMcp: true };
    runtime.launchConfig = { ...runtime.config };
    runtime.mcpIdentity = {
      threadId: runtime.threadId,
      launchId: "current-launch",
      title: "Restarted task",
    };
    attachAuthorizedRuntime(manager, runtime);

    expect(
      manager.resolveMcpCallerIdentity({
        routing: "thread",
        threadId: runtime.threadId,
        launchId: "previous-launch",
        serverId: "browser",
      }),
    ).toBeUndefined();
    expect(
      manager.resolveMcpCallerIdentity({
        routing: "thread",
        threadId: runtime.threadId,
        launchId: "current-launch",
        serverId: "browser",
      }),
    ).toEqual(runtime.mcpIdentity);
  });

  it("rotates authority before restart creation and revokes a failed replacement launch", async () => {
    const initialSession = createStructuredSession(Promise.resolve());
    const adapter = createAdapter("codex", initialSession);
    let initialIdentity: McpThreadIdentity | undefined;
    vi.mocked(adapter.createStructuredSession!).mockImplementationOnce(async (input) => {
      initialIdentity = input.mcpIdentity;
      return initialSession;
    });
    const manager = createManager("codex", adapter);

    await manager.startThread({
      threadId: "restart-capability",
      projectLocation: { kind: "windows", path: "C:\\repo" },
      agentKind: "codex",
      config: { model: "codex/model", browserMcp: true },
      prompt: "",
      initialSize: { cols: 80, rows: 24 },
      sessionRef: {
        providerSessionId: "ses_restart",
        discoveredAt: "2026-08-15T00:00:00.000Z",
      },
      presentationMode: "gui",
    });
    const runtime = manager.sessions.get("restart-capability")!;
    runtime.status = "inactive";

    const replacement = createStructuredSession(Promise.resolve());
    replacement.activate = vi.fn<NonNullable<StructuredSessionHandle["activate"]>>(async () => {
      throw new Error("replacement activation failed");
    });
    let replacementIdentity: McpThreadIdentity | undefined;
    let oldDuringReplacement: McpThreadIdentity | undefined;
    let replacementDuringCreation: McpThreadIdentity | undefined;
    vi.mocked(adapter.createStructuredSession!).mockImplementationOnce(async (input) => {
      replacementIdentity = input.mcpIdentity;
      oldDuringReplacement = manager.resolveMcpCallerIdentity({
        routing: "thread",
        threadId: initialIdentity!.threadId!,
        launchId: initialIdentity!.launchId,
        serverId: "browser",
      });
      replacementDuringCreation = manager.resolveMcpCallerIdentity({
        routing: "thread",
        threadId: input.mcpIdentity!.threadId!,
        launchId: input.mcpIdentity!.launchId,
        serverId: "browser",
      });
      return replacement;
    });

    await expect(
      manager.sendThreadInput({
        threadId: runtime.threadId,
        prompt: "resume",
        config: { model: "codex/model", browserMcp: true },
      }),
    ).rejects.toThrow("replacement activation failed");

    expect(initialIdentity?.launchId).toEqual(expect.any(String));
    expect(replacementIdentity?.launchId).toEqual(expect.any(String));
    expect(replacementIdentity?.launchId).not.toBe(initialIdentity?.launchId);
    expect(oldDuringReplacement).toBeUndefined();
    expect(replacementDuringCreation).toEqual(replacementIdentity);
    for (const identity of [initialIdentity!, replacementIdentity!]) {
      expect(
        manager.resolveMcpCallerIdentity({
          routing: "thread",
          threadId: identity.threadId!,
          launchId: identity.launchId,
          serverId: "browser",
        }),
      ).toBeUndefined();
    }
  });

  it("authorizes a structured child only while its lease and parent are live", async () => {
    const structuredSession = createStructuredSession(Promise.resolve());
    const adapter = createAdapter("codex", structuredSession);
    const manager = createManager("codex", adapter);
    const parent = createInactiveRuntime("codex", adapter, structuredSession);
    parent.threadId = "parent-with-child-capability";
    parent.config = { model: "codex/model", browserMcp: true };
    parent.launchConfig = { ...parent.config };
    manager.sessions.set(parent.threadId, parent);

    const spawnPipeline = (
      manager as unknown as {
        spawnPipeline: {
          resolveMcpServersForLaunch(input: {
            identity: McpThreadIdentity;
          }): Promise<ResolvedMcpServer[]>;
        };
      }
    ).spawnPipeline;
    const childIdentities: McpThreadIdentity[] = [];
    vi.spyOn(spawnPipeline, "resolveMcpServersForLaunch").mockImplementation(async (input) => {
      childIdentities.push(input.identity);
      return [
        {
          id: "browser",
          name: "browser",
          timeoutMs: 30_000,
          transport: { type: "http", url: "http://browser/mcp", headers: {} },
        },
        {
          id: "app-controls",
          name: "app_controls",
          timeoutMs: 30_000,
          transport: { type: "http", url: "http://app-controls/mcp", headers: {} },
        },
      ];
    });

    const authorizeChild = async (childThreadId: string) => {
      await manager.resolveSubagentParentMcpAccess(
        parent.threadId,
        { threadId: childThreadId, title: childThreadId },
        "codex",
        { model: "codex/model", browserMcp: true },
      );
      return childIdentities.at(-1)!;
    };
    const resolveChild = (identity: McpThreadIdentity, serverId: "browser" | "app-controls") =>
      manager.resolveMcpCallerIdentity({
        routing: "thread",
        threadId: identity.threadId!,
        launchId: identity.launchId,
        serverId,
      });

    const releasedChild = await authorizeChild("structured-child-released");
    expect(releasedChild.launchId).toEqual(expect.any(String));
    expect(resolveChild(releasedChild, "browser")).toEqual(releasedChild);
    expect(resolveChild(releasedChild, "app-controls")).toEqual(releasedChild);

    manager.releaseSubagentParentMcpAccess(parent.threadId, releasedChild.threadId!);
    expect(resolveChild(releasedChild, "browser")).toBeUndefined();
    expect(resolveChild(releasedChild, "app-controls")).toBeUndefined();

    const parentClosedChild = await authorizeChild("structured-child-parent-closed");
    expect(resolveChild(parentClosedChild, "browser")).toEqual(parentClosedChild);
    await manager.closeThread({ threadId: parent.threadId });
    expect(resolveChild(parentClosedChild, "browser")).toBeUndefined();
    expect(resolveChild(parentClosedChild, "app-controls")).toBeUndefined();
  });
});

describe("ThreadSessionManager Windows shells", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    vi.mocked(spawnPty).mockClear();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("resolves the current shell preference for every shell launch", async () => {
    const structuredSession = createStructuredSession(Promise.resolve());
    const adapter = createAdapter("codex", structuredSession);
    const resolveWindowsShell = vi.fn<() => WindowsShellPreference>(() => ({
      shell: "C:\\Program Files\\WindowsApps\\PowerShell\\pwsh.exe",
      kind: "pwsh" as const,
      args: ["-NoLogo", "-NoProfile"],
    }));
    const manager = createManager("codex", adapter, undefined, resolveWindowsShell);

    await manager.startShell({
      shellId: "shell:preferred",
      projectLocation: { kind: "windows", path: process.cwd() },
    });

    expect(resolveWindowsShell).toHaveBeenCalledWith("preferred");
    expect(spawnPty).toHaveBeenCalledWith(
      "C:\\Program Files\\WindowsApps\\PowerShell\\pwsh.exe",
      ["-NoLogo", "-NoProfile"],
      expect.objectContaining({ cwd: process.cwd() }),
    );
  });

  it("requests a PowerShell host for login and install overlays", async () => {
    const structuredSession = createStructuredSession(Promise.resolve());
    const adapter = createAdapter("codex", structuredSession);
    const resolveWindowsShell = vi.fn<
      (runtime?: "preferred" | "powershell") => WindowsShellPreference
    >(() => ({
      shell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      kind: "powershell" as const,
      args: ["-NoLogo"],
    }));
    const manager = createManager("codex", adapter, undefined, resolveWindowsShell);

    await manager.startShell({
      shellId: "login:preferred",
      projectLocation: { kind: "windows", path: process.cwd() },
      windowsShellRuntime: "powershell",
    });

    expect(resolveWindowsShell).toHaveBeenCalledWith("powershell");
    expect(spawnPty).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ["-NoLogo"],
      expect.objectContaining({ cwd: process.cwd() }),
    );
  });
});

describe("ThreadSessionManager start guards", () => {
  it("waits for a reconnect before delivering input to the new live session", async () => {
    const activation = deferred();
    const structuredSession = createStructuredSession(activation.promise);
    structuredSession.startTurn = vi.fn<NonNullable<StructuredSessionHandle["startTurn"]>>(
      async () => undefined,
    );
    const adapter = createAdapter("codex", structuredSession);
    const manager = createManager("codex", adapter);
    const start = manager.startThread({
      threadId: "reconnecting-input",
      projectLocation: { kind: "windows", path: "C:\\repo" },
      agentKind: "codex",
      config: { model: "codex/model" },
      prompt: "",
      initialSize: { cols: 80, rows: 24 },
      sessionRef: {
        providerSessionId: "ses_existing",
        discoveredAt: "2026-08-15T00:00:00.000Z",
      },
      presentationMode: "gui",
    });
    await vi.waitFor(() => expect(structuredSession.activate).toHaveBeenCalledOnce());

    const delivered = vi.fn<() => void>();
    const send = manager
      .sendThreadInput({
        threadId: "reconnecting-input",
        prompt: "send after reconnect",
        config: { model: "codex/model" },
      })
      .then(delivered);
    await Promise.resolve();
    expect(delivered).not.toHaveBeenCalled();

    activation.resolve();
    await start;
    await send;
    expect(structuredSession.startTurn).toHaveBeenCalledWith(
      "send after reconnect",
      { model: "codex/model" },
      undefined,
      { userMessageItemId: expect.stringMatching(/^user-/) },
    );
  });

  it("reclassifies a premature reconnect steer from authoritative idle state", async () => {
    const activation = deferred();
    const structuredSession = createStructuredSession(activation.promise);
    structuredSession.startTurn = vi.fn<NonNullable<StructuredSessionHandle["startTurn"]>>(
      async () => undefined,
    );
    structuredSession.interruptTurn = vi.fn<NonNullable<StructuredSessionHandle["interruptTurn"]>>(
      async () => undefined,
    );
    structuredSession.steerTurn = vi.fn<NonNullable<StructuredSessionHandle["steerTurn"]>>(
      async () => undefined,
    );
    const adapter = createAdapter("codex", structuredSession);
    const manager = createManager("codex", adapter);
    const start = manager.startThread({
      threadId: "reconnecting-steer",
      projectLocation: { kind: "windows", path: "C:\\repo" },
      agentKind: "codex",
      config: { model: "codex/model" },
      prompt: "",
      initialSize: { cols: 80, rows: 24 },
      sessionRef: {
        providerSessionId: "ses_existing",
        discoveredAt: "2026-08-15T00:00:00.000Z",
      },
      presentationMode: "gui",
    });
    await vi.waitFor(() => expect(structuredSession.activate).toHaveBeenCalledOnce());

    const steer = manager.setPendingSteer({
      threadId: "reconnecting-steer",
      prompt: "normal turn after reconnect",
      config: { model: "codex/model" },
    });
    activation.resolve();
    await start;
    await steer;

    expect(structuredSession.startTurn).toHaveBeenCalledWith(
      "normal turn after reconnect",
      { model: "codex/model" },
      undefined,
      { userMessageItemId: expect.stringMatching(/^user-/) },
    );
    expect(structuredSession.interruptTurn).not.toHaveBeenCalled();
    expect(structuredSession.steerTurn).not.toHaveBeenCalled();
  });

  it("lets the IPC boundary exclusively own a structured GUI factory failure", async () => {
    captureSupervisorException.mockClear();
    const structuredSession = createStructuredSession(Promise.resolve());
    const adapter = createAdapter("codex", structuredSession);
    vi.mocked(adapter.createStructuredSession!).mockRejectedValueOnce(
      new Error("factory output with private provider details"),
    );
    const manager = createManager("codex", adapter);

    await expect(
      manager.startThread({
        threadId: "factory-failure",
        projectLocation: { kind: "windows", path: "C:\\repo" },
        agentKind: "codex",
        config: { model: "codex/model" },
        prompt: "",
        initialSize: { cols: 80, rows: 24 },
        presentationMode: "gui",
      }),
    ).rejects.toMatchObject({
      name: "StructuredRuntimeDiagnosticError",
      message: "Structured runtime session creation failed.",
    });
    expect(captureSupervisorException).not.toHaveBeenCalled();
  });

  it("reports an optional terminal structured factory failure once and falls back", async () => {
    captureSupervisorException.mockClear();
    const structuredSession = createStructuredSession(Promise.resolve());
    const adapter = createAdapter("codex", structuredSession);
    vi.mocked(adapter.createStructuredSession!).mockRejectedValueOnce(
      new Error("factory output with private provider details"),
    );
    const manager = createManager("codex", adapter);

    await expect(
      manager.startThread({
        threadId: "terminal-factory-failure",
        projectLocation: { kind: "windows", path: "C:\\repo" },
        agentKind: "codex",
        config: { model: "codex/model" },
        prompt: "",
        initialSize: { cols: 80, rows: 24 },
        presentationMode: "terminal",
      }),
    ).resolves.toEqual({ threadId: "terminal-factory-failure" });
    expect(captureSupervisorException).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        name: "StructuredRuntimeDiagnosticError",
        message: "Structured runtime session creation failed.",
      }),
      expect.objectContaining({
        "poracode.feature_area": "structured-runtime-session-creation",
      }),
    );
  });

  it("settles a closed working session so consumers never freeze at working", async () => {
    const structuredSession = createStructuredSession(Promise.resolve());
    const adapter = createAdapter("codex", structuredSession);
    const emit = vi.fn<(event: SupervisorEvent) => void>();
    const manager = createManager("codex", adapter, emit);
    const runtime = createInactiveRuntime("codex", adapter, structuredSession);
    runtime.threadId = "closed-thread";
    runtime.status = "working";
    runtime.attention = "working";
    manager.sessions.set(runtime.threadId, runtime);

    await manager.closeThread({ threadId: runtime.threadId });

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread-state",
        threadId: "closed-thread",
        status: "inactive",
        attention: "none",
        forceCloseActiveTurn: true,
      }),
    );
  });

  it("rejects a prompt for a closed session instead of dropping it", async () => {
    const structuredSession = createStructuredSession(Promise.resolve());
    const adapter = createAdapter("codex", structuredSession);
    const manager = createManager("codex", adapter);
    const runtime = createInactiveRuntime("codex", adapter, structuredSession);
    runtime.threadId = "closed-thread";
    manager.sessions.set(runtime.threadId, runtime);
    await manager.closeThread({ threadId: runtime.threadId });

    await expect(
      manager.sendThreadInput({
        threadId: "closed-thread",
        prompt: "late",
        config: { model: "codex/model" },
      }),
    ).rejects.toThrow("Unknown thread session: closed-thread");
    // Raw keystrokes racing a close stay idempotent — only prompts must survive.
    await expect(
      manager.writeTerminal({ threadId: "closed-thread", data: "late" }),
    ).resolves.toBeUndefined();
  });

  it.each(guardedStructuredProviders)(
    "delivers a prompt sent while a %s start is still in flight",
    async (agentKind) => {
      const activation = deferred<void>();
      const activationStarted = deferred<void>();
      const structuredSession: StructuredSessionHandle = {
        ...createStructuredSession(activation.promise, () => activationStarted.resolve()),
        startTurn: vi.fn<NonNullable<StructuredSessionHandle["startTurn"]>>(async () => undefined),
      };
      const adapter = createAdapter(agentKind, structuredSession);
      const manager = createManager(agentKind, adapter);

      const start = manager.startThread({
        threadId: `thread-${agentKind}`,
        projectLocation: { kind: "windows", path: "C:\\repo" },
        agentKind,
        config: { model: `${agentKind}/model` },
        prompt: "",
        initialSize: { cols: 80, rows: 24 },
        presentationMode: "gui",
      });
      await activationStarted.promise;

      // The session only lands in the map when the start settles; a prompt
      // typed during the spawn must wait for it, not fail as unknown.
      const send = manager.sendThreadInput({
        threadId: `thread-${agentKind}`,
        prompt: "queued while starting",
        config: { model: `${agentKind}/model` },
      });
      activation.resolve();
      await start;
      await expect(send).resolves.toBeUndefined();
      expect(structuredSession.startTurn).toHaveBeenCalledWith(
        "queued while starting",
        expect.objectContaining({ model: `${agentKind}/model` }),
        undefined,
        expect.objectContaining({ userMessageItemId: expect.any(String) }),
      );
    },
  );

  it("recovers a closed thread's state on interrupt", async () => {
    const structuredSession = createStructuredSession(Promise.resolve());
    const adapter = createAdapter("codex", structuredSession);
    const emit = vi.fn<(event: SupervisorEvent) => void>();
    const manager = createManager("codex", adapter, emit);
    const runtime = createInactiveRuntime("codex", adapter, structuredSession);
    runtime.threadId = "closed-thread";
    manager.sessions.set(runtime.threadId, runtime);
    await manager.closeThread({ threadId: runtime.threadId });
    emit.mockClear();

    await expect(manager.interruptThread({ threadId: "closed-thread" })).resolves.toBeUndefined();
    expect(emit).toHaveBeenCalledWith({
      type: "thread-state",
      threadId: "closed-thread",
      status: "inactive",
      attention: "none",
      canResumeWithConfig: false,
      forceCloseActiveTurn: true,
    });
  });

  it("preserves bookkeeping errors for never-known session ids", async () => {
    const structuredSession = createStructuredSession(Promise.resolve());
    const adapter = createAdapter("codex", structuredSession);
    const emit = vi.fn<(event: SupervisorEvent) => void>();
    const manager = createManager("codex", adapter, emit);

    await expect(
      manager.sendThreadInput({
        threadId: "never-known",
        prompt: "late",
        config: { model: "codex/model" },
      }),
    ).rejects.toThrow("Unknown thread session: never-known");
    await expect(manager.writeTerminal({ threadId: "never-known", data: "late" })).rejects.toThrow(
      "Unknown thread session: never-known",
    );
    // Interrupt is idempotent "ensure not running", so it settles rather than throws.
    await expect(manager.interruptThread({ threadId: "never-known" })).resolves.toBeUndefined();
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "never-known", status: "inactive" }),
    );
  });

  it("bounds removal tombstones and clears one when the thread id is reused", async () => {
    const structuredSession = createStructuredSession(Promise.resolve());
    const adapter = createAdapter("codex", structuredSession);
    const manager = createManager("codex", adapter);
    const internal = manager as unknown as {
      recentlyRemovedThreadIds: Set<string>;
      rememberRemovedThread(threadId: string): void;
    };

    for (let index = 0; index < 257; index++) {
      internal.rememberRemovedThread(`removed-${index}`);
    }
    expect(internal.recentlyRemovedThreadIds.size).toBe(256);
    expect(internal.recentlyRemovedThreadIds.has("removed-0")).toBe(false);
    expect(internal.recentlyRemovedThreadIds.has("removed-256")).toBe(true);

    internal.rememberRemovedThread("reused-thread");
    await manager.startThread({
      threadId: "reused-thread",
      projectLocation: { kind: "windows", path: "C:\\repo" },
      agentKind: "codex",
      config: { model: "codex/model" },
      prompt: "",
      initialSize: { cols: 80, rows: 24 },
      presentationMode: "gui",
    });
    expect(internal.recentlyRemovedThreadIds.has("reused-thread")).toBe(false);
  });

  it("passes an empty MCP set to provider-owned structured sessions", async () => {
    const structuredSession = createStructuredSession(Promise.resolve());
    const adapter = createAdapter("opencode", structuredSession);
    adapter.capabilities.mcpConfigSource = "agentSettings";
    adapter.capabilities.agentSettingsDefaults = { crossagentMcp: true };
    adapter.capabilities.crossagentMcpRouting = "provider-session";
    const events: SupervisorEvent[] = [];
    const manager = createManager("opencode", adapter, (event) => events.push(event));

    await manager.startThread({
      threadId: "thread-opencode-empty-mcp",
      projectLocation: { kind: "windows", path: "C:\\repo" },
      agentKind: "opencode",
      config: { model: "opencode/model" },
      prompt: "hello",
      initialSize: { cols: 80, rows: 24 },
      presentationMode: "gui",
      disabledBuiltInMcpServerIds: ["browser", "app-controls"],
    });

    expect(adapter.createStructuredSession).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ crossagentMcp: true }),
        mcpServers: [],
      }),
    );
    expect(manager.getThreadSnapshots()[0]?.launchConfig).toEqual(
      expect.objectContaining({ crossagentMcp: true }),
    );
    expect(
      events.find((event) => event.type === "thread-state" && event.status === "working"),
    ).toEqual(
      expect.objectContaining({ launchConfig: expect.objectContaining({ crossagentMcp: true }) }),
    );
  });

  it("reports Pipedream grants as applied when there are no live sessions to reload", async () => {
    const adapter = createAdapter("opencode", createStructuredSession(Promise.resolve()));
    const manager = createManager("opencode", adapter);

    await expect(manager.reloadPipedreamMcpServers()).resolves.toEqual({ state: "applied" });
  });

  it("re-resolves Pipedream grants and revocations for an already-running supported session", async () => {
    const updateMcpServers = vi.fn<NonNullable<StructuredSessionHandle["updateMcpServers"]>>(
      async () => undefined,
    );
    const structuredSession = createStructuredSession(Promise.resolve());
    structuredSession.updateMcpServers = updateMcpServers;
    const adapter = createAdapter("opencode", structuredSession);
    adapter.capabilities.mcpConfigSource = "agentSettings";
    adapter.capabilities.crossagentMcpRouting = "provider-session";
    const manager = createManager("opencode", adapter);
    const gmailRelay: ResolvedMcpServer = {
      id: "pipedream:local-gmail",
      name: "pipedream-gmail-local",
      timeoutMs: 30_000,
      transport: {
        type: "http",
        url: "http://127.0.0.1:43123/mcp",
        headers: { Authorization: "Bearer local-test" },
      },
    };
    const resolvePipedreamMcpServers = vi
      .fn<
        (input: {
          threadId: string;
          providerBindingId?: string;
          projectLocation: ProjectLocation;
        }) => Promise<ResolvedMcpServer[]>
      >()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([gmailRelay])
      .mockResolvedValueOnce([]);
    (
      manager as unknown as {
        options: { resolvePipedreamMcpServers: typeof resolvePipedreamMcpServers };
      }
    ).options.resolvePipedreamMcpServers = resolvePipedreamMcpServers;

    await manager.startThread({
      threadId: "thread-live-pipedream-reload",
      projectLocation: { kind: "windows", path: "C:\\repo" },
      agentKind: "opencode",
      config: { model: "opencode/model" },
      prompt: "",
      initialSize: { cols: 80, rows: 24 },
      presentationMode: "gui",
      disabledBuiltInMcpServerIds: ["browser", "crossagents", "computer-use", "app-controls"],
    });
    const originalIdentity = manager.sessions.get("thread-live-pipedream-reload")?.mcpIdentity;
    expect(originalIdentity).toBeDefined();
    updateMcpServers.mockClear();
    const internal = manager as unknown as {
      spawnPipeline: {
        resolveMcpServersForLaunch(input: {
          identity?: McpThreadIdentity;
        }): Promise<ResolvedMcpServer[]>;
      };
    };
    const resolveLaunch = vi.spyOn(internal.spawnPipeline, "resolveMcpServersForLaunch");

    await expect(manager.reloadPipedreamMcpServers()).resolves.toEqual({ state: "applied" });
    await expect(manager.reloadPipedreamMcpServers()).resolves.toEqual({
      state: "applied",
    });

    expect(resolveLaunch).toHaveBeenCalledTimes(2);
    for (const [input] of resolveLaunch.mock.calls) {
      expect(input.identity).toMatchObject({
        threadId: originalIdentity?.threadId,
        launchId: originalIdentity?.launchId,
      });
    }
    expect(resolvePipedreamMcpServers).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        threadId: "thread-live-pipedream-reload",
        projectLocation: { kind: "windows", path: "C:\\repo" },
      }),
    );
    expect(resolvePipedreamMcpServers).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        threadId: "thread-live-pipedream-reload",
        projectLocation: { kind: "windows", path: "C:\\repo" },
      }),
    );
    expect(updateMcpServers).toHaveBeenNthCalledWith(1, [gmailRelay]);
    expect(updateMcpServers).toHaveBeenNthCalledWith(2, []);
  });

  it("re-resolves current Personal OAuth for a live update and removes a stale launch token on sign-out", async () => {
    const updateMcpServers = vi.fn<NonNullable<StructuredSessionHandle["updateMcpServers"]>>(
      async () => undefined,
    );
    const structuredSession = createStructuredSession(Promise.resolve());
    structuredSession.updateMcpServers = updateMcpServers;
    const adapter = createAdapter("opencode", structuredSession);
    adapter.capabilities.mcpConfigSource = "agentSettings";
    adapter.capabilities.crossagentMcpRouting = "provider-session";
    const manager = createManager("opencode", adapter);
    const stalePersonalServer: McpServer = {
      id: PIPEDREAM_PERSONAL_MCP_SERVER_ID,
      name: "pd",
      description: "Personal Pipedream tools",
      enabled: true,
      timeoutMs: 30_000,
      transport: {
        type: "http",
        url: PIPEDREAM_PERSONAL_MCP_URL,
        headers: { Authorization: "Bearer stale-launch-token" },
      },
    };

    await manager.startThread({
      threadId: "thread-personal-oauth-live-refresh",
      projectLocation: { kind: "windows", path: "C:\\repo" },
      agentKind: "opencode",
      config: { model: "opencode/model" },
      prompt: "",
      initialSize: { cols: 80, rows: 24 },
      presentationMode: "gui",
      mcpServers: [stalePersonalServer],
      disabledBuiltInMcpServerIds: ["browser", "crossagents", "computer-use", "app-controls"],
    });

    const settingsPath = (manager as unknown as { options: { settingsPath: string } }).options
      .settingsPath;
    writeFileSync(
      settingsPath,
      JSON.stringify({
        mcpServers: [
          {
            ...stalePersonalServer,
            transport: { ...stalePersonalServer.transport, headers: {} },
          },
        ],
      }),
      "utf8",
    );
    let currentToken: string | undefined = "fresh-current-token";
    const applyMcpServerAuthorization = vi.fn<(servers: McpServer[]) => Promise<McpServer[]>>(
      async (servers) =>
        servers.map((server) => {
          if (
            (server.transport.type !== "http" && server.transport.type !== "sse") ||
            server.transport.url !== PIPEDREAM_PERSONAL_MCP_URL
          ) {
            return server;
          }
          const headers = { ...server.transport.headers };
          delete headers.Authorization;
          return {
            ...server,
            transport: {
              ...server.transport,
              headers: currentToken
                ? { ...headers, Authorization: `Bearer ${currentToken}` }
                : headers,
            },
          };
        }),
    );
    (
      manager as unknown as {
        options: { applyMcpServerAuthorization: typeof applyMcpServerAuthorization };
      }
    ).options.applyMcpServerAuthorization = applyMcpServerAuthorization;
    updateMcpServers.mockClear();

    await expect(manager.reloadPipedreamMcpServers()).resolves.toEqual({ state: "applied" });
    expect(JSON.stringify(updateMcpServers.mock.calls.at(-1)?.[0])).toContain(
      "Bearer fresh-current-token",
    );
    expect(JSON.stringify(updateMcpServers.mock.calls.at(-1)?.[0])).not.toContain(
      "stale-launch-token",
    );

    currentToken = undefined;
    updateMcpServers.mockClear();
    const cancelAllChildren = vi.fn<(threadId: string) => Promise<void>>(async () => undefined);
    (
      manager as unknown as {
        options: { crossagentMcp: ReturnType<typeof inertCrossagentMcp> };
      }
    ).options.crossagentMcp = inertCrossagentMcp(cancelAllChildren);
    await expect(manager.reloadPipedreamMcpServers({ revokePersonalOauth: true })).resolves.toEqual(
      { state: "applied" },
    );

    const appliedAfterSignOut = JSON.stringify(updateMcpServers.mock.calls.at(-1)?.[0]);
    const storedAfterSignOut = JSON.stringify(
      manager.sessions.get("thread-personal-oauth-live-refresh")?.mcpLaunchSnapshot,
    );
    const activeAuthorityAfterSignOut = (
      manager as unknown as {
        rootMcpLaunchAuthorities: Map<string, { authorization: { mcpLaunchSnapshot: unknown } }>;
      }
    ).rootMcpLaunchAuthorities.get("thread-personal-oauth-live-refresh")?.authorization
      .mcpLaunchSnapshot;
    expect(appliedAfterSignOut).not.toMatch(
      /authorization|stale-launch-token|fresh-current-token/i,
    );
    expect(storedAfterSignOut).not.toMatch(/authorization|stale-launch-token|fresh-current-token/i);
    expect(JSON.stringify(activeAuthorityAfterSignOut)).not.toMatch(
      /authorization|stale-launch-token|fresh-current-token/i,
    );
    expect(structuredSession.dispose).not.toHaveBeenCalled();
    expect(cancelAllChildren).toHaveBeenCalledExactlyOnceWith("thread-personal-oauth-live-refresh");
  });

  it("cancels a pending root launch so its stale Personal bearer can never attach", async () => {
    const activation = deferred();
    const structuredSession = createStructuredSession(activation.promise);
    const adapter = createAdapter("codex", structuredSession);
    const manager = createManager("codex", adapter);
    const stalePersonalServer: McpServer = {
      id: PIPEDREAM_PERSONAL_MCP_SERVER_ID,
      name: "pd",
      description: "Personal Pipedream tools",
      enabled: true,
      timeoutMs: 30_000,
      transport: {
        type: "http",
        url: PIPEDREAM_PERSONAL_MCP_URL,
        headers: { Authorization: "Bearer pending-root-stale-token" },
      },
    };

    const launch = manager.startThread({
      threadId: "thread-personal-oauth-pending-root",
      projectLocation: { kind: "windows", path: "C:\\repo" },
      agentKind: "codex",
      config: { model: "codex/model" },
      prompt: "",
      initialSize: { cols: 80, rows: 24 },
      presentationMode: "gui",
      mcpServers: [stalePersonalServer],
      disabledBuiltInMcpServerIds: ["browser", "crossagents", "computer-use", "app-controls"],
    });
    await vi.waitFor(() => expect(structuredSession.activate).toHaveBeenCalledOnce());

    await expect(manager.reloadPipedreamMcpServers({ revokePersonalOauth: true })).resolves.toEqual(
      { state: "applied" },
    );
    activation.resolve();
    await launch;

    expect(manager.sessions.has("thread-personal-oauth-pending-root")).toBe(false);
    expect(structuredSession.dispose).toHaveBeenCalledOnce();
    expect(
      (
        manager as unknown as {
          rootMcpLaunchAuthorities: Map<string, unknown>;
        }
      ).rootMcpLaunchAuthorities.has("thread-personal-oauth-pending-root"),
    ).toBe(false);
  });

  it("terminates and restarts a live-update session when Personal OAuth revocation cannot apply", async () => {
    const revocationOrder: string[] = [];
    const updateMcpServers = vi.fn<NonNullable<StructuredSessionHandle["updateMcpServers"]>>(
      async () => {
        revocationOrder.push("live-update-failed");
        throw new Error("simulated live update rejection");
      },
    );
    const structuredSession = createStructuredSession(Promise.resolve());
    structuredSession.updateMcpServers = updateMcpServers;
    vi.mocked(structuredSession.dispose).mockImplementation(async () => {
      revocationOrder.push("dispose-old-process");
    });
    const adapter = createAdapter("opencode", structuredSession);
    adapter.capabilities.mcpConfigSource = "agentSettings";
    adapter.capabilities.crossagentMcpRouting = "provider-session";
    const manager = createManager("opencode", adapter);
    const stalePersonalServer: McpServer = {
      id: PIPEDREAM_PERSONAL_MCP_SERVER_ID,
      name: "pd",
      description: "Personal Pipedream tools",
      enabled: true,
      timeoutMs: 30_000,
      transport: {
        type: "http",
        url: PIPEDREAM_PERSONAL_MCP_URL,
        headers: { Authorization: "Bearer rejected-update-token" },
      },
    };

    await manager.startThread({
      threadId: "thread-personal-oauth-live-update-fallback",
      projectLocation: { kind: "windows", path: "C:\\repo" },
      agentKind: "opencode",
      config: { model: "opencode/model" },
      prompt: "",
      initialSize: { cols: 80, rows: 24 },
      presentationMode: "gui",
      mcpServers: [stalePersonalServer],
      disabledBuiltInMcpServerIds: ["browser", "crossagents", "computer-use", "app-controls"],
    });
    const session = manager.sessions.get("thread-personal-oauth-live-update-fallback")!;
    session.status = "working";
    session.sessionRef = {
      providerSessionId: "ses_personal_oauth_live_update_fallback",
      discoveredAt: "2026-08-29T07:00:00.000Z",
    };
    const settingsPath = (manager as unknown as { options: { settingsPath: string } }).options
      .settingsPath;
    writeFileSync(
      settingsPath,
      JSON.stringify({
        mcpServers: [
          {
            ...stalePersonalServer,
            transport: { ...stalePersonalServer.transport, headers: {} },
          },
        ],
      }),
      "utf8",
    );
    const applyMcpServerAuthorization = vi.fn<(servers: McpServer[]) => Promise<McpServer[]>>(
      async (servers) => {
        revocationOrder.push("resolve-current-authorization");
        return servers;
      },
    );
    (
      manager as unknown as {
        options: { applyMcpServerAuthorization: typeof applyMcpServerAuthorization };
      }
    ).options.applyMcpServerAuthorization = applyMcpServerAuthorization;
    const internal = manager as unknown as {
      spawnPipeline: {
        restartThread(
          session: SessionRuntime,
          turn: { prompt: string; config: object },
        ): Promise<void>;
      };
    };
    const restartThread = vi
      .spyOn(internal.spawnPipeline, "restartThread")
      .mockImplementation(async (runtime) => {
        revocationOrder.push("restart");
        expect(JSON.stringify(runtime.mcpLaunchSnapshot)).not.toMatch(
          /authorization|rejected-update-token/i,
        );
      });

    await expect(manager.reloadPipedreamMcpServers({ revokePersonalOauth: true })).resolves.toEqual(
      { state: "applied" },
    );

    expect(restartThread).toHaveBeenCalledExactlyOnceWith(session, {
      prompt: "",
      config: session.config,
    });
    expect(revocationOrder).toEqual([
      "resolve-current-authorization",
      "live-update-failed",
      "dispose-old-process",
      "resolve-current-authorization",
      "restart",
    ]);
    expect(session.pendingPipedreamMcpReload).toBeUndefined();
  });

  it("serializes concurrent provider-settings and Pipedream MCP mutations", async () => {
    const updateMcpServers = vi.fn<NonNullable<StructuredSessionHandle["updateMcpServers"]>>(
      async () => undefined,
    );
    const structuredSession = createStructuredSession(Promise.resolve());
    structuredSession.updateMcpServers = updateMcpServers;
    const adapter = createAdapter("opencode", structuredSession);
    adapter.capabilities.mcpConfigSource = "agentSettings";
    const manager = createManager("opencode", adapter);
    const oldServer: McpServer = {
      id: "old-concurrent-server",
      name: "old-concurrent-server",
      description: "",
      enabled: true,
      timeoutMs: 30_000,
      transport: { type: "http", url: "https://old.concurrent.test/mcp", headers: {} },
    };
    const newServer: McpServer = {
      id: "new-concurrent-server",
      name: "new-concurrent-server",
      description: "",
      enabled: true,
      timeoutMs: 30_000,
      transport: { type: "http", url: "https://new.concurrent.test/mcp", headers: {} },
    };
    const oldResolved: ResolvedMcpServer = {
      id: oldServer.id,
      name: oldServer.name,
      timeoutMs: oldServer.timeoutMs,
      transport: oldServer.transport,
    };
    const newResolved: ResolvedMcpServer = {
      id: newServer.id,
      name: newServer.name,
      timeoutMs: newServer.timeoutMs,
      transport: newServer.transport,
    };

    await manager.startThread({
      threadId: "thread-concurrent-mcp-mutations",
      projectLocation: { kind: "windows", path: "C:\\repo" },
      agentKind: "opencode",
      config: { model: "opencode/model" },
      prompt: "",
      initialSize: { cols: 80, rows: 24 },
      presentationMode: "gui",
      mcpServers: [oldServer],
      disabledBuiltInMcpServerIds: ["browser", "crossagents", "computer-use", "app-controls"],
    });
    updateMcpServers.mockClear();
    const settingsPath = (manager as unknown as { options: { settingsPath: string } }).options
      .settingsPath;
    writeFileSync(settingsPath, JSON.stringify({ mcpServers: [newServer] }), "utf8");
    const currentSettingsResolution = deferred<ResolvedMcpServer[]>();
    const stalePipedreamResolution = deferred<ResolvedMcpServer[]>();
    const internal = manager as unknown as {
      spawnPipeline: {
        resolveMcpServersForLaunch(input: {
          mcpLaunchSnapshot: { mcpServers: McpServer[] };
        }): Promise<ResolvedMcpServer[]>;
      };
    };
    const resolveLaunch = vi
      .spyOn(internal.spawnPipeline, "resolveMcpServersForLaunch")
      .mockImplementation((input) =>
        input.mcpLaunchSnapshot.mcpServers.some((server) => server.id === newServer.id)
          ? currentSettingsResolution.promise
          : stalePipedreamResolution.promise,
      );

    const settingsReload = manager.reloadAgentMcpServers({ agentKind: "opencode" });
    const pipedreamReload = manager.reloadPipedreamMcpServers();
    await vi.waitFor(() => expect(resolveLaunch).toHaveBeenCalled());
    await Promise.resolve();
    const resolutionsBeforeSettingsApply = resolveLaunch.mock.calls.length;

    currentSettingsResolution.resolve([newResolved]);
    await vi.waitFor(() => expect(updateMcpServers).toHaveBeenCalled());
    stalePipedreamResolution.resolve([oldResolved]);
    await Promise.all([settingsReload, pipedreamReload]);

    expect(resolutionsBeforeSettingsApply).toBe(1);
    expect(updateMcpServers).toHaveBeenLastCalledWith([newResolved]);
    expect(
      manager.sessions
        .get("thread-concurrent-mcp-mutations")
        ?.mcpLaunchSnapshot.mcpServers.map((server) => server.id),
    ).toContain(newServer.id);
  });

  it("reloads Pipedream MCPs by live-session capability instead of provider kind", async () => {
    const updateMcpServers = vi.fn<NonNullable<StructuredSessionHandle["updateMcpServers"]>>(
      async () => undefined,
    );
    const structuredSession = createStructuredSession(Promise.resolve());
    structuredSession.updateMcpServers = updateMcpServers;
    const adapter = createAdapter("claude", structuredSession);
    const manager = createManager("claude", adapter);

    await manager.startThread({
      threadId: "thread-provider-neutral-pipedream-reload",
      projectLocation: { kind: "windows", path: "C:\\repo" },
      agentKind: "claude",
      config: { model: "claude/model" },
      prompt: "",
      initialSize: { cols: 80, rows: 24 },
      presentationMode: "gui",
      disabledBuiltInMcpServerIds: ["browser", "crossagents", "computer-use", "app-controls"],
    });
    updateMcpServers.mockClear();

    await expect(manager.reloadPipedreamMcpServers()).resolves.toEqual({
      state: "applied",
    });

    expect(updateMcpServers).toHaveBeenCalledOnce();
  });

  it("retries a failed live Pipedream MCP reload before the next user turn", async () => {
    const updateMcpServers = vi
      .fn<NonNullable<StructuredSessionHandle["updateMcpServers"]>>()
      .mockRejectedValueOnce(new Error("simulated live update failure"))
      .mockResolvedValue(undefined);
    const structuredSession = createStructuredSession(Promise.resolve());
    structuredSession.updateMcpServers = updateMcpServers;
    const adapter = createAdapter("opencode", structuredSession);
    const manager = createManager("opencode", adapter);

    await manager.startThread({
      threadId: "thread-opencode-pipedream-retry",
      projectLocation: { kind: "windows", path: "C:\\repo" },
      agentKind: "opencode",
      config: { model: "opencode/model" },
      prompt: "",
      initialSize: { cols: 80, rows: 24 },
      presentationMode: "gui",
      disabledBuiltInMcpServerIds: ["browser", "crossagents", "computer-use", "app-controls"],
    });
    const session = manager.sessions.get("thread-opencode-pipedream-retry")!;
    const internal = manager as unknown as {
      structuredTurnQueue: {
        start(session: SessionRuntime, turn: { prompt: string; config: object }): void;
      };
      startStructuredTurn(session: SessionRuntime, turn: { prompt: string; config: object }): void;
    };
    const start = vi.spyOn(internal.structuredTurnQueue, "start");

    await expect(manager.reloadPipedreamMcpServers()).resolves.toEqual({
      state: "failed-pending",
    });

    expect(session.pendingPipedreamMcpReload).toBe(true);
    const turn = { prompt: "Count my unread Gmail messages", config: session.config };
    internal.startStructuredTurn(session, turn);

    await vi.waitFor(() => expect(updateMcpServers).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(start).toHaveBeenCalledExactlyOnceWith(session, turn));
    expect(session.pendingPipedreamMcpReload).toBeUndefined();
  });

  it("transparently resumes an idle Codex GUI session when Pipedream grants change", async () => {
    const structuredSession = createStructuredSession(Promise.resolve());
    const adapter = createAdapter("codex", structuredSession);
    const manager = createManager("codex", adapter);

    await manager.startThread({
      threadId: "thread-codex-pipedream-resume",
      projectLocation: { kind: "windows", path: "C:\\repo" },
      agentKind: "codex",
      config: { model: "codex/model" },
      prompt: "",
      initialSize: { cols: 80, rows: 24 },
      presentationMode: "gui",
      disabledBuiltInMcpServerIds: ["browser", "crossagents", "computer-use", "app-controls"],
    });
    const session = manager.sessions.get("thread-codex-pipedream-resume")!;
    const stalePersonalServer: McpServer = {
      id: PIPEDREAM_PERSONAL_MCP_SERVER_ID,
      name: "pd",
      description: "Personal Pipedream tools",
      enabled: true,
      timeoutMs: 30_000,
      transport: {
        type: "http",
        url: PIPEDREAM_PERSONAL_MCP_URL,
        headers: { Authorization: "Bearer stale-restart-token" },
      },
    };
    session.mcpLaunchSnapshot = {
      ...session.mcpLaunchSnapshot,
      mcpServers: [stalePersonalServer],
    };
    const settingsPath = (manager as unknown as { options: { settingsPath: string } }).options
      .settingsPath;
    writeFileSync(
      settingsPath,
      JSON.stringify({
        mcpServers: [
          {
            ...stalePersonalServer,
            transport: { ...stalePersonalServer.transport, headers: {} },
          },
        ],
      }),
      "utf8",
    );
    const applyMcpServerAuthorization = vi.fn<(servers: McpServer[]) => Promise<McpServer[]>>(
      async (servers) => servers,
    );
    (
      manager as unknown as {
        options: { applyMcpServerAuthorization: typeof applyMcpServerAuthorization };
      }
    ).options.applyMcpServerAuthorization = applyMcpServerAuthorization;
    session.status = "idle";
    session.sessionRef = {
      providerSessionId: "ses_codex_existing",
      discoveredAt: "2026-08-29T07:00:00.000Z",
    };
    const internal = manager as unknown as {
      spawnPipeline: {
        restartThread(
          session: SessionRuntime,
          turn: { prompt: string; config: object },
        ): Promise<void>;
      };
    };
    const restartThread = vi
      .spyOn(internal.spawnPipeline, "restartThread")
      .mockImplementation(async (runtime) => {
        expect(JSON.stringify(runtime.mcpLaunchSnapshot)).not.toMatch(
          /authorization|stale-restart-token/i,
        );
      });

    await expect(manager.reloadPipedreamMcpServers()).resolves.toEqual({
      state: "applied",
    });

    expect(restartThread).toHaveBeenCalledExactlyOnceWith(session, {
      prompt: "",
      config: session.config,
    });
    expect(session.pendingPipedreamMcpReload).toBeUndefined();
  });

  it("defers a Claude GUI Pipedream reload while working and resumes before its next turn", async () => {
    const structuredSession = createStructuredSession(Promise.resolve());
    const adapter = createAdapter("claude", structuredSession);
    const manager = createManager("claude", adapter);

    await manager.startThread({
      threadId: "thread-claude-pipedream-deferred",
      projectLocation: { kind: "windows", path: "C:\\repo" },
      agentKind: "claude",
      config: { model: "claude/model" },
      prompt: "",
      initialSize: { cols: 80, rows: 24 },
      presentationMode: "gui",
      disabledBuiltInMcpServerIds: ["browser", "crossagents", "computer-use", "app-controls"],
    });
    const session = manager.sessions.get("thread-claude-pipedream-deferred")!;
    session.status = "working";
    session.sessionRef = {
      providerSessionId: "ses_claude_existing",
      discoveredAt: "2026-08-29T07:00:00.000Z",
    };
    const internal = manager as unknown as {
      spawnPipeline: {
        restartThread(
          session: SessionRuntime,
          turn: { prompt: string; config: object },
        ): Promise<void>;
      };
      startStructuredTurn(session: SessionRuntime, turn: { prompt: string; config: object }): void;
    };
    const restartThread = vi
      .spyOn(internal.spawnPipeline, "restartThread")
      .mockResolvedValue(undefined);

    await expect(manager.reloadPipedreamMcpServers()).resolves.toEqual({
      state: "restart-required",
    });

    expect(restartThread).not.toHaveBeenCalled();
    expect(session.pendingPipedreamMcpReload).toBe(true);

    session.status = "idle";
    const turn = { prompt: "Read my latest Gmail message", config: session.config };
    internal.startStructuredTurn(session, turn);
    await vi.waitFor(() => expect(restartThread).toHaveBeenCalledExactlyOnceWith(session, turn));
    expect(session.pendingPipedreamMcpReload).toBeUndefined();
  });

  it("immediately restarts a working launch-bound GUI session when Personal OAuth is revoked", async () => {
    const structuredSession = createStructuredSession(Promise.resolve());
    const adapter = createAdapter("claude", structuredSession);
    const manager = createManager("claude", adapter);
    const stalePersonalServer: McpServer = {
      id: PIPEDREAM_PERSONAL_MCP_SERVER_ID,
      name: "pd",
      description: "Personal Pipedream tools",
      enabled: true,
      timeoutMs: 30_000,
      transport: {
        type: "http",
        url: PIPEDREAM_PERSONAL_MCP_URL,
        headers: { Authorization: "Bearer revoked-working-token" },
      },
    };

    await manager.startThread({
      threadId: "thread-claude-personal-oauth-revoked",
      projectLocation: { kind: "windows", path: "C:\\repo" },
      agentKind: "claude",
      config: { model: "claude/model" },
      prompt: "",
      initialSize: { cols: 80, rows: 24 },
      presentationMode: "gui",
      disabledBuiltInMcpServerIds: ["browser", "crossagents", "computer-use", "app-controls"],
    });
    const session = manager.sessions.get("thread-claude-personal-oauth-revoked")!;
    session.mcpLaunchSnapshot = {
      ...session.mcpLaunchSnapshot,
      mcpServers: [stalePersonalServer],
    };
    const settingsPath = (manager as unknown as { options: { settingsPath: string } }).options
      .settingsPath;
    writeFileSync(
      settingsPath,
      JSON.stringify({
        mcpServers: [
          {
            ...stalePersonalServer,
            transport: { ...stalePersonalServer.transport, headers: {} },
          },
        ],
      }),
      "utf8",
    );
    const revocationOrder: string[] = [];
    vi.mocked(structuredSession.dispose).mockImplementation(async () => {
      revocationOrder.push("dispose-old-process");
    });
    const applyMcpServerAuthorization = vi.fn<(servers: McpServer[]) => Promise<McpServer[]>>(
      async (servers) => {
        revocationOrder.push("resolve-current-authorization");
        return servers;
      },
    );
    (
      manager as unknown as {
        options: { applyMcpServerAuthorization: typeof applyMcpServerAuthorization };
      }
    ).options.applyMcpServerAuthorization = applyMcpServerAuthorization;
    session.status = "working";
    session.sessionRef = {
      providerSessionId: "ses_claude_personal_oauth_revoked",
      discoveredAt: "2026-08-29T07:00:00.000Z",
    };
    const internal = manager as unknown as {
      spawnPipeline: {
        restartThread(
          session: SessionRuntime,
          turn: { prompt: string; config: object },
        ): Promise<void>;
      };
    };
    const restartThread = vi
      .spyOn(internal.spawnPipeline, "restartThread")
      .mockImplementation(async (runtime) => {
        revocationOrder.push("restart");
        expect(JSON.stringify(runtime.mcpLaunchSnapshot)).not.toMatch(
          /authorization|revoked-working-token/i,
        );
      });

    await expect(manager.reloadPipedreamMcpServers({ revokePersonalOauth: true })).resolves.toEqual(
      { state: "applied" },
    );

    expect(restartThread).toHaveBeenCalledExactlyOnceWith(session, {
      prompt: "",
      config: session.config,
    });
    expect(revocationOrder).toEqual([
      "dispose-old-process",
      "resolve-current-authorization",
      "restart",
    ]);
    expect(session.pendingPipedreamMcpReload).toBeUndefined();
  });

  it("revokes authority and kills the root process without waiting forever for provider or child disposal", async () => {
    vi.useFakeTimers();
    try {
      const hungDispose = deferred();
      const hungChildDisposal = deferred();
      const structuredSession = createStructuredSession(Promise.resolve());
      const terminationOrder: string[] = [];
      vi.mocked(structuredSession.dispose).mockImplementation(() => {
        terminationOrder.push("dispose-root");
        return hungDispose.promise;
      });
      const adapter = createAdapter("claude", structuredSession);
      const manager = createManager("claude", adapter);
      const session = createInactiveRuntime("claude", adapter, structuredSession);
      session.threadId = "thread-personal-oauth-hung-dispose";
      session.status = "working";
      session.mcpLaunchSnapshot = {
        ...session.mcpLaunchSnapshot,
        mcpServers: [
          {
            id: PIPEDREAM_PERSONAL_MCP_SERVER_ID,
            name: "pd",
            description: "Personal Pipedream tools",
            enabled: true,
            timeoutMs: 30_000,
            transport: {
              type: "http",
              url: PIPEDREAM_PERSONAL_MCP_URL,
              headers: { Authorization: "Bearer hung-dispose-stale-token" },
            },
          },
        ],
      };
      attachAuthorizedRuntime(manager, session);
      const cancelAllChildren = vi.fn<(threadId: string) => Promise<void>>(() => {
        terminationOrder.push("cancel-children");
        return hungChildDisposal.promise;
      });
      const internals = manager as unknown as {
        options: { crossagentMcp: ReturnType<typeof inertCrossagentMcp> };
        ptyLifecycle: { kill(runtime: SessionRuntime): void };
        rootMcpLaunchAuthorities: Map<string, unknown>;
        spawnPipeline: {
          restartThread(
            runtime: SessionRuntime,
            turn: { prompt: string; config: object },
          ): Promise<void>;
        };
      };
      internals.options.crossagentMcp = inertCrossagentMcp(cancelAllChildren);
      const kill = vi.spyOn(internals.ptyLifecycle, "kill").mockImplementation(() => {
        terminationOrder.push("kill-root");
      });
      vi.spyOn(internals.spawnPipeline, "restartThread").mockResolvedValue(undefined);

      let settled = false;
      const reload = manager
        .reloadPipedreamMcpServers({ revokePersonalOauth: true })
        .then((outcome) => {
          settled = true;
          return outcome;
        });
      await vi.advanceTimersByTimeAsync(0);
      const authorityRevokedWhileDisposalHung = !internals.rootMcpLaunchAuthorities.has(
        session.threadId,
      );
      const killedWhileDisposalHung = kill.mock.calls.length > 0;
      const childrenCancelledWhileDisposalHung = cancelAllChildren.mock.calls.length > 0;

      await vi.advanceTimersByTimeAsync(2_000);
      const settledWithinBound = settled;
      hungDispose.resolve();
      hungChildDisposal.resolve();
      await reload;

      expect(authorityRevokedWhileDisposalHung).toBe(true);
      expect(killedWhileDisposalHung).toBe(true);
      expect(childrenCancelledWhileDisposalHung).toBe(true);
      expect(settledWithinBound).toBe(true);
      expect(terminationOrder.indexOf("kill-root")).toBeLessThanOrEqual(
        terminationOrder.indexOf("dispose-root"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an unresumable GUI reload pending until a provider session id exists", async () => {
    const structuredSession = createStructuredSession(Promise.resolve());
    const adapter = createAdapter("codex", structuredSession);
    const manager = createManager("codex", adapter);

    await manager.startThread({
      threadId: "thread-codex-pipedream-await-ref",
      projectLocation: { kind: "windows", path: "C:\\repo" },
      agentKind: "codex",
      config: { model: "codex/model" },
      prompt: "",
      initialSize: { cols: 80, rows: 24 },
      presentationMode: "gui",
      disabledBuiltInMcpServerIds: ["browser", "crossagents", "computer-use", "app-controls"],
    });
    const session = manager.sessions.get("thread-codex-pipedream-await-ref")!;
    session.status = "idle";
    delete session.sessionRef;
    const internal = manager as unknown as {
      spawnPipeline: {
        restartThread(
          session: SessionRuntime,
          turn: { prompt: string; config: object },
        ): Promise<void>;
      };
    };
    const restartThread = vi
      .spyOn(internal.spawnPipeline, "restartThread")
      .mockResolvedValue(undefined);

    await expect(manager.reloadPipedreamMcpServers()).resolves.toEqual({
      state: "restart-required",
    });

    expect(restartThread).not.toHaveBeenCalled();
    expect(session.pendingPipedreamMcpReload).toBe(true);
  });

  it("marks a mid-launch GUI session pending when its structured handle is not ready", async () => {
    const structuredSession = createStructuredSession(Promise.resolve());
    const adapter = createAdapter("codex", structuredSession);
    const manager = createManager("codex", adapter);

    await manager.startThread({
      threadId: "thread-codex-pipedream-mid-launch",
      projectLocation: { kind: "windows", path: "C:\\repo" },
      agentKind: "codex",
      config: { model: "codex/model" },
      prompt: "",
      initialSize: { cols: 80, rows: 24 },
      presentationMode: "gui",
      disabledBuiltInMcpServerIds: ["browser", "crossagents", "computer-use", "app-controls"],
    });
    const session = manager.sessions.get("thread-codex-pipedream-mid-launch")!;
    session.structuredSession = undefined;

    await expect(manager.reloadPipedreamMcpServers()).resolves.toEqual({
      state: "restart-required",
    });

    expect(session.pendingPipedreamMcpReload).toBe(true);
  });

  it("gates a concurrent GUI submit behind an in-flight Pipedream restart", async () => {
    const structuredSession = createStructuredSession(Promise.resolve());
    const startTurn = vi.fn<NonNullable<StructuredSessionHandle["startTurn"]>>(
      async () => undefined,
    );
    structuredSession.startTurn = startTurn;
    const adapter = createAdapter("codex", structuredSession);
    const manager = createManager("codex", adapter);

    await manager.startThread({
      threadId: "thread-submit-during-pipedream-restart",
      projectLocation: { kind: "windows", path: "C:\\repo" },
      agentKind: "codex",
      config: { model: "codex/model" },
      prompt: "",
      initialSize: { cols: 80, rows: 24 },
      presentationMode: "gui",
      disabledBuiltInMcpServerIds: ["browser", "crossagents", "computer-use", "app-controls"],
    });
    const session = manager.sessions.get("thread-submit-during-pipedream-restart")!;
    session.status = "idle";
    session.sessionRef = {
      providerSessionId: "ses_submit_during_restart",
      discoveredAt: "2026-08-29T08:00:00.000Z",
    };
    const restart = deferred<void>();
    const internal = manager as unknown as {
      spawnPipeline: {
        restartThread(
          session: SessionRuntime,
          turn: { prompt: string; config: object },
        ): Promise<void>;
      };
    };
    const restartThread = vi
      .spyOn(internal.spawnPipeline, "restartThread")
      .mockReturnValue(restart.promise);

    const reload = manager.reloadPipedreamMcpServers();
    await vi.waitFor(() => expect(restartThread).toHaveBeenCalledOnce());
    await manager.sendThreadInput({
      threadId: session.threadId,
      prompt: "Use my new Gmail connection",
      config: session.config,
    });
    const submittedThroughStaleHandle = startTurn.mock.calls.length > 0;
    const pendingDuringRestart = session.pendingPipedreamMcpReload;

    restart.resolve();
    await reload;
    await vi.waitFor(() => expect(structuredSession.startTurn).toHaveBeenCalledOnce());

    expect(submittedThroughStaleHandle).toBe(false);
    expect(pendingDuringRestart).toBe(true);
    expect(restartThread).toHaveBeenCalledOnce();
    expect(structuredSession.startTurn).toHaveBeenCalledWith(
      "Use my new Gmail connection",
      session.config,
      undefined,
      expect.any(Object),
    );
  });

  it("retains a failed GUI Pipedream restart and retries it with the next submit", async () => {
    const structuredSession = createStructuredSession(Promise.resolve());
    structuredSession.startTurn = vi.fn<NonNullable<StructuredSessionHandle["startTurn"]>>(
      async () => undefined,
    );
    const adapter = createAdapter("claude", structuredSession);
    const manager = createManager("claude", adapter);

    await manager.startThread({
      threadId: "thread-retry-failed-pipedream-restart",
      projectLocation: { kind: "windows", path: "C:\\repo" },
      agentKind: "claude",
      config: { model: "claude/model" },
      prompt: "",
      initialSize: { cols: 80, rows: 24 },
      presentationMode: "gui",
      disabledBuiltInMcpServerIds: ["browser", "crossagents", "computer-use", "app-controls"],
    });
    const session = manager.sessions.get("thread-retry-failed-pipedream-restart")!;
    session.status = "idle";
    session.sessionRef = {
      providerSessionId: "ses_retry_failed_restart",
      discoveredAt: "2026-08-29T08:00:00.000Z",
    };
    const internal = manager as unknown as {
      spawnPipeline: {
        restartThread(
          session: SessionRuntime,
          turn: { prompt: string; config: object },
        ): Promise<void>;
      };
    };
    const restartThread = vi
      .spyOn(internal.spawnPipeline, "restartThread")
      .mockRejectedValueOnce(new Error("simulated Pipedream restart failure"))
      .mockResolvedValueOnce(undefined);

    await expect(manager.reloadPipedreamMcpServers()).resolves.toEqual({
      state: "failed-pending",
    });
    const pendingAfterFailure = session.pendingPipedreamMcpReload;
    await manager.sendThreadInput({
      threadId: session.threadId,
      prompt: "Retry with current Gmail access",
      config: session.config,
    });
    await vi.waitFor(() => expect(restartThread).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(session.pendingPipedreamMcpReload).toBeUndefined());

    expect(pendingAfterFailure).toBe(true);
    expect(restartThread).toHaveBeenNthCalledWith(
      2,
      session,
      expect.objectContaining({ prompt: "Retry with current Gmail access" }),
    );
    expect(structuredSession.startTurn).not.toHaveBeenCalled();
  });

  it("never submits through a stale GUI handle while a pending reload lacks a session ref", async () => {
    const structuredSession = createStructuredSession(Promise.resolve());
    structuredSession.startTurn = vi.fn<NonNullable<StructuredSessionHandle["startTurn"]>>(
      async () => undefined,
    );
    const adapter = createAdapter("codex", structuredSession);
    const events: SupervisorEvent[] = [];
    const manager = createManager("codex", adapter, (event) => events.push(event));

    await manager.startThread({
      threadId: "thread-submit-pipedream-without-session-ref",
      projectLocation: { kind: "windows", path: "C:\\repo" },
      agentKind: "codex",
      config: { model: "codex/model" },
      prompt: "",
      initialSize: { cols: 80, rows: 24 },
      presentationMode: "gui",
      disabledBuiltInMcpServerIds: ["browser", "crossagents", "computer-use", "app-controls"],
    });
    const session = manager.sessions.get("thread-submit-pipedream-without-session-ref")!;
    session.status = "idle";
    delete session.sessionRef;

    await manager.reloadPipedreamMcpServers();
    await manager.sendThreadInput({
      threadId: session.threadId,
      prompt: "Do not use the stale connection",
      config: session.config,
    });

    expect(structuredSession.startTurn).not.toHaveBeenCalled();
    expect(session.pendingPipedreamMcpReload).toBe(true);
    expect(session.status).toBe("error");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread-state",
        status: "error",
        errorMessage: expect.stringContaining("integration access before starting"),
      }),
    );
  });

  it("reports launch-bound terminal sessions as restart-required without restarting them", async () => {
    const structuredSession = createStructuredSession(Promise.resolve());
    const adapter = createAdapter("codex", structuredSession);
    const manager = createManager("codex", adapter);

    await manager.startThread({
      threadId: "thread-terminal-pipedream-next-launch",
      projectLocation: { kind: "windows", path: "C:\\repo" },
      agentKind: "codex",
      config: { model: "codex/model" },
      prompt: "",
      initialSize: { cols: 80, rows: 24 },
      presentationMode: "terminal",
      disabledBuiltInMcpServerIds: ["browser", "crossagents", "computer-use", "app-controls"],
    });
    const session = manager.sessions.get("thread-terminal-pipedream-next-launch")!;
    const internal = manager as unknown as {
      spawnPipeline: {
        restartThread(
          session: SessionRuntime,
          turn: { prompt: string; config: object },
        ): Promise<void>;
      };
    };
    const restartThread = vi
      .spyOn(internal.spawnPipeline, "restartThread")
      .mockResolvedValue(undefined);

    await expect(manager.reloadPipedreamMcpServers()).resolves.toEqual({
      state: "restart-required",
    });

    expect(restartThread).not.toHaveBeenCalled();
    expect(session.pendingPipedreamMcpReload).toBeUndefined();
  });

  it("does not emit a stale launch state after an MCP reload's session closes", async () => {
    const updateMcpServers = vi.fn<NonNullable<StructuredSessionHandle["updateMcpServers"]>>();
    const update = deferred<void>();
    updateMcpServers.mockReturnValue(update.promise);
    const structuredSession = createStructuredSession(Promise.resolve());
    structuredSession.updateMcpServers = updateMcpServers;
    const adapter = createAdapter("opencode", structuredSession);
    adapter.capabilities.mcpConfigSource = "agentSettings";
    const events: SupervisorEvent[] = [];
    const manager = createManager("opencode", adapter, (event) => events.push(event));

    await manager.startThread({
      threadId: "thread-reload-race",
      projectLocation: { kind: "windows", path: "C:\\repo" },
      agentKind: "opencode",
      config: { model: "opencode/model" },
      prompt: "",
      initialSize: { cols: 80, rows: 24 },
      presentationMode: "gui",
    });

    const reload = manager.reloadAgentMcpServers({ agentKind: "opencode" });
    await vi.waitFor(() => expect(updateMcpServers).toHaveBeenCalled());
    await manager.closeThread({ threadId: "thread-reload-race" });
    const eventCountAfterClose = events.length;

    update.resolve();
    await reload;

    expect(
      events.slice(eventCountAfterClose).filter((event) => event.type === "thread-state"),
    ).toEqual([]);
  });

  it("filters initial custom MCPs with the effective forced-on Browser policy", async () => {
    const structuredSession = createStructuredSession(Promise.resolve());
    const adapter = createAdapter("opencode", structuredSession);
    const manager = createManager("opencode", adapter);
    const prepareMcpToolFilters = vi.fn<
      (
        servers: McpServer[],
        location: ProjectLocation,
        browserExclusive?: boolean,
      ) => Promise<McpServer[]>
    >(
      async (servers: McpServer[], _location: ProjectLocation, _browserExclusive?: boolean) =>
        servers,
    );
    (
      manager as unknown as { options: { prepareMcpToolFilters: typeof prepareMcpToolFilters } }
    ).options.prepareMcpToolFilters = prepareMcpToolFilters;

    await manager.startThread({
      threadId: "thread-effective-browser-filter",
      projectLocation: { kind: "windows", path: "C:\\repo" },
      agentKind: "opencode",
      config: { model: "opencode/model", browserMcp: false },
      prompt: "",
      initialSize: { cols: 80, rows: 24 },
      presentationMode: "gui",
      mcpServers: [
        {
          id: "neutral",
          name: "neutral",
          description: "",
          enabled: true,
          timeoutMs: 30_000,
          transport: { type: "http", url: "https://neutral.test/mcp", headers: {} },
        },
      ],
    });

    expect(prepareMcpToolFilters).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "neutral" })],
      { kind: "windows", path: "C:\\repo" },
      true,
    );
  });

  it("preserves the trusted thread identity when live OpenCode MCP servers reload", async () => {
    const structuredSession = createStructuredSession(Promise.resolve());
    structuredSession.updateMcpServers = vi.fn<
      NonNullable<StructuredSessionHandle["updateMcpServers"]>
    >(async () => undefined);
    const adapter = createAdapter("opencode", structuredSession);
    adapter.capabilities.mcpConfigSource = "agentSettings";
    adapter.capabilities.crossagentMcpRouting = "provider-session";
    const manager = createManager("opencode", adapter);

    await manager.startThread({
      threadId: "thread-reload-identity",
      projectLocation: { kind: "windows", path: "C:\\repo" },
      agentKind: "opencode",
      config: { model: "opencode/model" },
      prompt: "",
      initialSize: { cols: 80, rows: 24 },
      presentationMode: "gui",
    });

    const internal = manager as unknown as {
      spawnPipeline: {
        resolveMcpServersForLaunch: ReturnType<typeof vi.fn>;
      };
    };
    const resolveSpy = vi.spyOn(internal.spawnPipeline, "resolveMcpServersForLaunch");
    await manager.reloadAgentMcpServers({ agentKind: "opencode" });

    expect(resolveSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({ threadId: "thread-reload-identity" }),
      }),
    );
  });

  it("rebuilds live OpenCode MCPs from current settings while preserving launch policy", async () => {
    const updateMcpServers = vi.fn<NonNullable<StructuredSessionHandle["updateMcpServers"]>>(
      async () => undefined,
    );
    const structuredSession = createStructuredSession(Promise.resolve());
    structuredSession.updateMcpServers = updateMcpServers;
    const adapter = createAdapter("opencode", structuredSession);
    adapter.capabilities.mcpConfigSource = "agentSettings";
    adapter.capabilities.crossagentMcpRouting = "provider-session";
    const manager = createManager("opencode", adapter);
    const prepareMcpToolFilters = vi.fn<
      (
        servers: McpServer[],
        location: ProjectLocation,
        browserExclusive?: boolean,
      ) => Promise<McpServer[]>
    >(
      async (servers: McpServer[], _location: ProjectLocation, _browserExclusive?: boolean) =>
        servers,
    );
    (
      manager as unknown as { options: { prepareMcpToolFilters: typeof prepareMcpToolFilters } }
    ).options.prepareMcpToolFilters = prepareMcpToolFilters;
    const oldServer: McpServer = {
      id: "old-server",
      name: "old-server",
      description: "",
      enabled: true,
      timeoutMs: 30_000,
      transport: { type: "http", url: "https://old.example.test/mcp", headers: {} },
    };
    const newServer: McpServer = {
      id: "new-server",
      name: "new-server",
      description: "",
      enabled: true,
      timeoutMs: 30_000,
      transport: { type: "http", url: "https://new.example.test/mcp", headers: {} },
    };
    const projectServer: McpServer = {
      id: "project-server",
      name: "project-server",
      description: "",
      enabled: true,
      timeoutMs: 30_000,
      transport: { type: "http", url: "https://project.example.test/mcp", headers: {} },
    };

    await manager.startThread({
      threadId: "thread-reload-current-settings",
      projectLocation: { kind: "windows", path: "C:\\repo" },
      agentKind: "opencode",
      config: { model: "opencode/model" },
      prompt: "",
      initialSize: { cols: 80, rows: 24 },
      presentationMode: "gui",
      mcpServers: [oldServer, projectServer],
      projectMcpServers: [projectServer],
      disabledBuiltInMcpTools: { browser: ["close_tab"] },
    });
    updateMcpServers.mockClear();
    const settingsPath = (manager as unknown as { options: { settingsPath: string } }).options
      .settingsPath;
    writeFileSync(settingsPath, JSON.stringify({ mcpServers: [newServer] }), "utf8");

    await manager.reloadAgentMcpServers({ agentKind: "opencode" });

    expect(updateMcpServers).toHaveBeenCalledTimes(1);
    const applied = updateMcpServers.mock.calls[0]?.[0] ?? [];
    expect(applied.map((server) => server.id)).toContain("new-server");
    expect(applied.map((server) => server.id)).toContain("project-server");
    expect(applied.map((server) => server.id)).not.toContain("old-server");
    expect(prepareMcpToolFilters).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: "new-server" }),
        expect.objectContaining({ id: "project-server" }),
      ]),
      { kind: "windows", path: "C:\\repo" },
      true,
    );
    expect(manager.sessions.get("thread-reload-current-settings")?.mcpLaunchSnapshot).toMatchObject(
      {
        mcpServers: expect.arrayContaining([
          expect.objectContaining({ id: "new-server" }),
          expect.objectContaining({ id: "project-server" }),
        ]),
        projectMcpServers: [expect.objectContaining({ id: "project-server" })],
        disabledBuiltInMcpTools: { browser: ["close_tab"] },
      },
    );
  });

  it.each(guardedStructuredProviders)(
    "disposes a %s structured GUI session that is closed before activation completes",
    async (agentKind) => {
      const activation = deferred<void>();
      const activationStarted = deferred<void>();
      const structuredSession = createStructuredSession(activation.promise, () =>
        activationStarted.resolve(),
      );
      const adapter = createAdapter(agentKind, structuredSession);
      const manager = createManager(agentKind, adapter);

      const start = manager.startThread({
        threadId: `thread-${agentKind}`,
        projectLocation: { kind: "windows", path: "C:\\repo" },
        agentKind,
        config: { model: `${agentKind}/model` },
        prompt: "",
        initialSize: { cols: 80, rows: 24 },
        presentationMode: "gui",
      });
      await activationStarted.promise;
      expect(structuredSession.activate).toHaveBeenCalledTimes(1);

      await manager.closeThread({ threadId: `thread-${agentKind}` });
      activation.resolve();
      await start;

      expect(structuredSession.dispose).toHaveBeenCalledTimes(1);
      expect(structuredSession.openThread).not.toHaveBeenCalled();
      expect(manager.sessions.has(`thread-${agentKind}`)).toBe(false);
    },
  );

  it.each(guardedStructuredProviders)(
    "disposes a %s structured GUI session that is interrupted before activation completes",
    async (agentKind) => {
      const activation = deferred<void>();
      const activationStarted = deferred<void>();
      const structuredSession = createStructuredSession(activation.promise, () =>
        activationStarted.resolve(),
      );
      const adapter = createAdapter(agentKind, structuredSession);
      const manager = createManager(agentKind, adapter);

      const start = manager.startThread({
        threadId: `thread-${agentKind}`,
        projectLocation: { kind: "windows", path: "C:\\repo" },
        agentKind,
        config: { model: `${agentKind}/model` },
        prompt: "hello",
        initialSize: { cols: 80, rows: 24 },
        presentationMode: "gui",
      });
      await activationStarted.promise;
      expect(structuredSession.activate).toHaveBeenCalledTimes(1);

      await manager.interruptThread({ threadId: `thread-${agentKind}` });
      activation.resolve();
      await start;

      expect(structuredSession.dispose).toHaveBeenCalledTimes(1);
      expect(structuredSession.openThread).not.toHaveBeenCalled();
      expect(manager.sessions.has(`thread-${agentKind}`)).toBe(false);
    },
  );

  it.each(guardedStructuredProviders)(
    "disposes a %s structured GUI session when the manager is disposed during activation",
    async (agentKind) => {
      const activation = deferred<void>();
      const activationStarted = deferred<void>();
      const structuredSession = createStructuredSession(activation.promise, () =>
        activationStarted.resolve(),
      );
      const adapter = createAdapter(agentKind, structuredSession);
      const manager = createManager(agentKind, adapter);

      const start = manager.startThread({
        threadId: `thread-${agentKind}`,
        projectLocation: { kind: "windows", path: "C:\\repo" },
        agentKind,
        config: { model: `${agentKind}/model` },
        prompt: "hello",
        initialSize: { cols: 80, rows: 24 },
        presentationMode: "gui",
      });
      await activationStarted.promise;
      expect(structuredSession.activate).toHaveBeenCalledTimes(1);

      await manager.dispose();
      activation.resolve();
      await start;

      expect(structuredSession.dispose).toHaveBeenCalledTimes(1);
      expect(structuredSession.openThread).not.toHaveBeenCalled();
      expect(manager.sessions.has(`thread-${agentKind}`)).toBe(false);
    },
  );

  it.each(guardedStructuredProviders)(
    "disposes a replacement %s structured GUI session when the thread is closed during restart",
    async (agentKind) => {
      const activation = deferred<void>();
      const activationStarted = deferred<void>();
      const replacementSession = createStructuredSession(activation.promise, () =>
        activationStarted.resolve(),
      );
      const adapter = createAdapter(agentKind, replacementSession);
      const existingSession = createInactiveRuntime(
        agentKind,
        adapter,
        createStructuredSession(Promise.resolve()),
      );
      const manager = createManager(agentKind, adapter);
      manager.sessions.set(existingSession.threadId, existingSession);

      const restart = manager.sendThreadInput({
        threadId: existingSession.threadId,
        prompt: "resume work",
        config: { model: `${agentKind}/model` },
      });
      await activationStarted.promise;
      expect(replacementSession.activate).toHaveBeenCalledTimes(1);

      await manager.closeThread({ threadId: existingSession.threadId });
      activation.resolve();
      await restart;

      expect(replacementSession.dispose).toHaveBeenCalledTimes(1);
      expect(replacementSession.openThread).not.toHaveBeenCalled();
      expect(manager.sessions.has(existingSession.threadId)).toBe(false);
    },
  );
});
