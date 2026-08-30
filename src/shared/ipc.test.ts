import { describe, expect, it, vi } from "vitest";
import { createLocalIpcHandlers } from "@/main/ipc/localHandlers";
import { createSupervisorIpcHandlers } from "@/supervisor/ipcHandlers";
import {
  createInvokeBridge,
  createProcedureBridge,
  browserTabSchema,
  ipcProcedureMap,
  MAIN_LOCAL_PROCEDURE_NAMES,
  RENDERER_IPC_PROCEDURE_NAMES,
  SUPERVISOR_INTERNAL_PROCEDURE_NAMES,
  type MainLocalProcedureName,
} from "./ipc";

describe("ipcProcedureMap", () => {
  it("defines a channel and payload schema for every procedure", () => {
    for (const [name, procedure] of Object.entries(ipcProcedureMap)) {
      expect(name.length).toBeGreaterThan(0);
      expect(procedure.channel).toMatch(/^poracode:/);
      expect(procedure.payloadSchema).toBeDefined();
    }
  });

  it("creates bridge methods only for renderer-callable procedures", () => {
    const bridge = createInvokeBridge(async () => undefined);
    for (const name of RENDERER_IPC_PROCEDURE_NAMES) {
      expect(typeof bridge[name as keyof typeof bridge]).toBe("function");
    }
    for (const name of SUPERVISOR_INTERNAL_PROCEDURE_NAMES) {
      expect(Object.hasOwn(bridge, name)).toBe(false);
    }
    expect(
      [...RENDERER_IPC_PROCEDURE_NAMES, ...SUPERVISOR_INTERNAL_PROCEDURE_NAMES].sort(),
    ).toEqual(Object.keys(ipcProcedureMap).sort());
  });

  it("can generate a bridge while preserving procedure names and arguments", async () => {
    const invoke = vi.fn<(name: string, args: unknown[]) => Promise<unknown>>(async () => null);
    const bridge = createProcedureBridge(invoke);

    await bridge.dbGetProjectNotes("project-1");

    expect(invoke).toHaveBeenCalledWith("dbGetProjectNotes", ["project-1"]);
  });

  it("validates exact automation presentation acknowledgement capabilities", () => {
    const payload = {
      requestId: "1b74121a-44ed-4ec0-aa75-68a5f4fb03ed",
      tabId: "tab-target",
      surface: "main" as const,
      presented: true,
    };

    expect(ipcProcedureMap.browserAcknowledgeAutomationPresentation.parseArgs(payload)).toEqual(
      payload,
    );
    expect(() =>
      ipcProcedureMap.browserAcknowledgeAutomationPresentation.parseArgs({
        ...payload,
        requestId: "predictable",
      }),
    ).toThrow(/Invalid/u);
    expect(() =>
      ipcProcedureMap.browserAcknowledgeAutomationPresentation.parseArgs({
        ...payload,
        surface: "other" as never,
      }),
    ).toThrow(/Invalid/u);

    const invalidation = {
      requestId: payload.requestId,
      tabId: payload.tabId,
      surface: payload.surface,
      reason: "workspace-tab-changed" as const,
    };
    expect(ipcProcedureMap.browserInvalidateAutomationPresentation.parseArgs(invalidation)).toEqual(
      invalidation,
    );
    expect(() =>
      ipcProcedureMap.browserInvalidateAutomationPresentation.parseArgs({
        ...invalidation,
        requestId: "predictable",
      }),
    ).toThrow(/Invalid/u);
    expect(() =>
      ipcProcedureMap.browserInvalidateAutomationPresentation.parseArgs({
        ...invalidation,
        reason: "page-supplied-reason" as never,
      }),
    ).toThrow(/Invalid/u);
  });

  it("never exposes a sensitive browser session partition through renderer metadata", () => {
    const baseTab = {
      tabId: "tab-1",
      url: "about:blank",
      title: "",
      loading: true,
      canGoBack: false,
      canGoForward: false,
    };
    const sensitiveTab = {
      ...baseTab,
      sensitiveIntegration: true as const,
      sensitiveViewGeneration: 7,
    };

    expect(browserTabSchema.parse(sensitiveTab)).toEqual(sensitiveTab);
    expect(() =>
      browserTabSchema.parse({
        ...sensitiveTab,
        sensitiveSessionPartition: "pipedream-oauth-11111111111111111111111111111111",
      }),
    ).toThrow(/Invalid/u);
    expect(() =>
      browserTabSchema.parse({
        ...baseTab,
        sensitiveSessionPartition: "persist:browser",
      }),
    ).toThrow(/Invalid/u);
  });

  it("repairs blank legacy thread models at the database persistence boundary", () => {
    const baseThread = {
      id: "thread-1",
      projectId: "project-1",
      title: "Thread",
      agentKind: "claude" as const,
      status: "idle" as const,
      attention: "none" as const,
      canResumeWithConfig: false,
      archived: false,
      done: false,
      starred: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const parsed = ipcProcedureMap.dbSyncAll.parseArgs(
      [],
      [
        { ...baseThread, config: { model: "", effort: "high" } },
        { ...baseThread, id: "thread-2", config: { model: "sonnet", effort: "low" } },
      ],
      JSON.stringify({ kind: "home" }),
    );

    expect(parsed.threads[0]?.config).toEqual({ model: "auto", effort: "high" });
    expect(parsed.threads[1]?.config).toEqual({ model: "sonnet", effort: "low" });
  });

  it("covers every main-local procedure with a local handler", () => {
    const handlers = createLocalIpcHandlers({
      getMainWindow: () => null as never,
      getBrowserPanelManager: () => null,
      getRemoteAccessServer: () => null,
      setRemoteAccessEnabled: vi.fn<(enabled: boolean) => Promise<never>>(),
      getRemoteAccessTailscaleStatus: vi.fn<() => Promise<never>>(),
      setRemoteAccessTailscaleHttps: vi.fn<(enabled: boolean) => Promise<never>>(),
      startTailscale: vi.fn<() => Promise<{ ok: boolean }>>(async () => ({ ok: true })),
      setRemoteAccessAdvertisedUrl: vi.fn<(url: string) => Promise<never>>(),
      sshConnectionManager: {
        discoverHosts: vi.fn<() => never[]>(() => []),
        connect: vi.fn<() => Promise<never>>(),
        disconnect: vi.fn<() => Promise<void>>(),
      } as never,
      requirePoracodePaths: () =>
        ({
          baseDir: "C:\\tmp",
          dbPath: "C:\\tmp\\db.sqlite",
          logsDir: "C:\\tmp\\logs",
          terminalLogsDir: "C:\\tmp\\logs",
          attachmentsDir: "C:\\tmp\\attachments",
          worktreesDir: "C:\\tmp\\worktrees",
          cacheDir: "C:\\tmp\\cache",
          settingsPath: "C:\\tmp\\settings.json",
          keybindingsPath: "C:\\tmp\\keybindings.json",
          statusCachePath: "C:\\tmp\\status-cache.json",
        }) as never,
      updatePowerSaveBlocker: vi.fn<() => void>(),
      autoUpdater: {
        initialize: vi.fn<() => void>(),
        dispose: vi.fn<() => void>(),
        getStatus: vi.fn<() => null>(() => null),
        checkForUpdate: vi.fn<() => Promise<void>>(),
        startUpdateDownload: vi.fn<() => Promise<void>>(),
        installUpdate: vi.fn<() => void>(),
      },
      extractBrowserToWindow: vi.fn<() => void>(),
      injectBrowserToMain: vi.fn<() => void>(),
      requestRelaunch: vi.fn<() => void>(),
      scheduleService: {} as never,
      prWatchService: {} as never,
      pipedreamMainService: {
        beginConnect: vi.fn<() => Promise<never>>(),
        importEnvironmentFile: vi.fn<() => Promise<never>>(),
        clearEnvironmentFile: vi.fn<() => Promise<never>>(),
      } as never,
      browserCookieImportService: {} as never,
      cookieImportBridge: {} as never,
      browserCookieImportExtensionDir: "C:\\tmp\\y-space-cookie-import",
    });

    expect(Object.keys(handlers).sort()).toEqual([...MAIN_LOCAL_PROCEDURE_NAMES].sort());
  });

  it("covers every supervisor procedure with a dispatcher handler", () => {
    const runtime = new Proxy(
      {},
      {
        get: () => vi.fn<(...args: never[]) => unknown>(),
      },
    ) as never;
    const handlers = createSupervisorIpcHandlers(runtime);
    const supervisorProcedureNames = Object.keys(ipcProcedureMap).filter(
      (name) => !MAIN_LOCAL_PROCEDURE_NAMES.includes(name as MainLocalProcedureName),
    );

    expect(Object.keys(handlers).sort()).toEqual(supervisorProcedureNames.sort());
  });

  it("returns LSP request results from the supervisor dispatcher", async () => {
    const result = { items: [{ label: "completion" }] };
    const runtime = {
      lspManager: {
        sendMessage: vi.fn<() => Promise<unknown>>().mockResolvedValue(result),
      },
    } as never;

    const handlers = createSupervisorIpcHandlers(runtime);

    await expect(handlers.lspSendMessage({ sessionId: "session", message: {} })).resolves.toBe(
      result,
    );
  });
});
