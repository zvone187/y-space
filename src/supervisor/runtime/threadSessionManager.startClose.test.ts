import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentKind, McpServer, ResolvedMcpServer } from "@/shared/contracts";
import type { McpThreadIdentity } from "@/shared/browserMcpThread";
import type { SupervisorEvent } from "@/shared/ipc";
import type { AgentAdapter, StructuredSessionHandle } from "../agents/base";
import type { WindowsShellPreference } from "../shellPreference";
import type { SessionRuntime } from "./sessionTypes";
import type { McpLaunchAuthorization, McpLaunchIdentity } from "./threadSession/spawnPipeline";

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

function createManager(
  agentKind: AgentKind,
  adapter: AgentAdapter,
  emit: (event: SupervisorEvent) => void = vi.fn<(event: SupervisorEvent) => void>(),
  resolveWindowsShell: () => WindowsShellPreference = () => ({
    shell: "powershell.exe",
    kind: "powershell" as const,
    args: ["-NoLogo"],
  }),
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

const guardedStructuredProviders = ["codex", "opencode"] as const;
const managersToDispose: ThreadSessionManager[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const manager of managersToDispose.splice(0)) {
    await manager.dispose();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ThreadSessionManager provider-session routing", () => {
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
    ).toBeUndefined();

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
      disabledBuiltInMcpServerIds: ["app-controls"],
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
