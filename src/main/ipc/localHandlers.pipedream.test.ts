import { beforeEach, describe, expect, it, vi } from "vitest";

const showOpenDialogMock = vi.hoisted(() =>
  vi.fn<
    (
      parent: unknown,
      options: unknown,
    ) => Promise<{ canceled: boolean; filePaths: readonly string[] }>
  >(),
);
const showMessageBoxMock = vi.hoisted(() =>
  vi.fn<() => Promise<{ response: number }>>(async () => ({ response: 1 })),
);

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp", isPackaged: false },
  clipboard: { writeImage: vi.fn<(image: unknown) => void>() },
  dialog: {
    showOpenDialog: showOpenDialogMock,
    showMessageBox: showMessageBoxMock,
    showSaveDialog: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  },
  nativeImage: {
    createFromBuffer: vi.fn<(value: unknown) => { isEmpty: () => boolean }>(() => ({
      isEmpty: () => true,
    })),
  },
  shell: {
    openExternal: vi.fn<(path: string) => Promise<unknown>>(),
    openPath: vi.fn<(path: string) => Promise<unknown>>(),
  },
}));

import { createLocalIpcHandlers } from "./localHandlers";

function makeHandlers(
  importEnvironmentFile: (filePath: string) => Promise<unknown>,
  clearEnvironmentFile: () => Promise<unknown> = async () => ({}),
  connectLifecycle: {
    beginConnect?: (payload: { appSlug: string }) => Promise<unknown>;
    getConnectFlowStatus?: (payload: { flowId: string }) => Promise<unknown>;
    finishConnect?: (payload: { flowId: string }) => Promise<void>;
    cancelConnect?: (payload: { flowId: string }) => Promise<void>;
    beginPersonalMcpOauth?: () => Promise<unknown>;
    getPersonalMcpOauthFlowStatus?: (payload: { flowId: string }) => Promise<unknown>;
    cancelPersonalMcpOauth?: (payload: { flowId: string }) => Promise<void>;
    clearPersonalMcpOauth?: () => Promise<void>;
  } = {},
) {
  return createLocalIpcHandlers({
    getMainWindow: () => ({}) as never,
    getBrowserPanelManager: () => null,
    getRemoteAccessServer: () => null,
    setRemoteAccessEnabled: vi.fn<(enabled: boolean) => Promise<never>>(),
    getRemoteAccessTailscaleStatus: vi.fn<() => Promise<never>>(),
    setRemoteAccessTailscaleHttps: vi.fn<(enabled: boolean) => Promise<never>>(),
    startTailscale: vi.fn<() => Promise<never>>(),
    setRemoteAccessAdvertisedUrl: vi.fn<(url: string) => Promise<never>>(),
    sshConnectionManager: {} as never,
    requirePoracodePaths: () => ({ baseDir: "/tmp/y-space" }) as never,
    updatePowerSaveBlocker: vi.fn<() => void>(),
    autoUpdater: {} as never,
    extractBrowserToWindow: vi.fn<() => void>(),
    injectBrowserToMain: vi.fn<() => void>(),
    requestRelaunch: vi.fn<() => void>(),
    scheduleService: {} as never,
    prWatchService: {} as never,
    pipedreamMainService: {
      importEnvironmentFile,
      clearEnvironmentFile,
      beginConnect:
        connectLifecycle.beginConnect ??
        vi.fn<(payload: { appSlug: string }) => Promise<unknown>>(),
      getConnectFlowStatus:
        connectLifecycle.getConnectFlowStatus ??
        vi.fn<(payload: { flowId: string }) => Promise<unknown>>(),
      finishConnect:
        connectLifecycle.finishConnect ?? vi.fn<(payload: { flowId: string }) => Promise<void>>(),
      cancelConnect:
        connectLifecycle.cancelConnect ?? vi.fn<(payload: { flowId: string }) => Promise<void>>(),
      beginPersonalMcpOauth:
        connectLifecycle.beginPersonalMcpOauth ?? vi.fn<() => Promise<unknown>>(),
      getPersonalMcpOauthFlowStatus:
        connectLifecycle.getPersonalMcpOauthFlowStatus ??
        vi.fn<(payload: { flowId: string }) => Promise<unknown>>(),
      cancelPersonalMcpOauth:
        connectLifecycle.cancelPersonalMcpOauth ??
        vi.fn<(payload: { flowId: string }) => Promise<void>>(),
      clearPersonalMcpOauth: connectLifecycle.clearPersonalMcpOauth ?? vi.fn<() => Promise<void>>(),
    } as never,
    browserCookieImportService: {} as never,
    cookieImportBridge: {} as never,
    browserCookieImportExtensionDir: "/tmp/y-space-cookie-import",
  });
}

describe("local Pipedream env-file IPC handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    showMessageBoxMock.mockResolvedValue({ response: 1 });
  });

  it("keeps the selected path in main and returns only the safe import result", async () => {
    const safeResult = {
      status: "configured" as const,
      snapshot: {
        personalMcp: { enabled: false, authenticated: false, serverName: "pd" as const },
        connect: { state: "partial" as const, missingKeys: ["PIPEDREAM_PROJECT_ID" as const] },
      },
    };
    const importEnvironmentFile = vi.fn<(filePath: string) => Promise<typeof safeResult>>(
      async () => safeResult,
    );
    showOpenDialogMock.mockResolvedValue({
      canceled: false,
      filePaths: ["/private/config/.env.pipedream"],
    });

    const result = await makeHandlers(importEnvironmentFile).pipedreamChooseEnvFile({
      dialogTitle: "Choose Pipedream environment file",
    });

    expect(importEnvironmentFile).toHaveBeenCalledExactlyOnceWith("/private/config/.env.pipedream");
    expect(showOpenDialogMock).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({ properties: ["openFile", "showHiddenFiles"] }),
    );
    expect(showMessageBoxMock).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({ type: "warning", defaultId: 0, cancelId: 0 }),
    );
    const dialogOptions = showOpenDialogMock.mock.calls[0]?.[1];
    expect(dialogOptions).not.toHaveProperty("filters");
    expect(result).toEqual(safeResult);
    expect(JSON.stringify(result)).not.toContain("/private/config");
  });

  it("does not touch configuration when the picker is cancelled", async () => {
    const importEnvironmentFile = vi.fn<(filePath: string) => Promise<unknown>>();
    showOpenDialogMock.mockResolvedValue({ canceled: true, filePaths: [] });

    await expect(
      makeHandlers(importEnvironmentFile).pipedreamChooseEnvFile({
        dialogTitle: "Choose Pipedream environment file",
      }),
    ).resolves.toBeNull();
    expect(importEnvironmentFile).not.toHaveBeenCalled();
  });

  it("does not import or delete the selected source until the user confirms secure removal", async () => {
    const importEnvironmentFile = vi.fn<(filePath: string) => Promise<unknown>>();
    showOpenDialogMock.mockResolvedValue({
      canceled: false,
      filePaths: ["/private/config/.env.pipedream"],
    });
    showMessageBoxMock.mockResolvedValue({ response: 0 });

    await expect(
      makeHandlers(importEnvironmentFile).pipedreamChooseEnvFile({
        dialogTitle: "Choose Pipedream environment file",
      }),
    ).resolves.toBeNull();

    expect(showMessageBoxMock).toHaveBeenCalledOnce();
    expect(importEnvironmentFile).not.toHaveBeenCalled();
  });

  it("clears sealed credentials through a main-only service call", async () => {
    const clearEnvironmentFile = vi.fn<() => Promise<unknown>>(async () => ({
      personalMcp: { enabled: false, authenticated: false, serverName: "pd" as const },
      connect: { state: "absent" as const },
    }));

    await expect(
      makeHandlers(
        vi.fn<(filePath: string) => Promise<unknown>>(),
        clearEnvironmentFile,
      ).pipedreamClearEnvFile({}),
    ).resolves.toMatchObject({ connect: { state: "absent" } });
    expect(clearEnvironmentFile).toHaveBeenCalledOnce();
  });

  it("delegates the renderer-safe Connect lifecycle without accepting a tab id", async () => {
    const flowId = "4d73cb38-1566-4e07-bf92-ce6edf1c82e8";
    const beginConnect = vi.fn<(payload: { appSlug: string }) => Promise<unknown>>(async () => ({
      opened: true as const,
      expiresAt: "2026-08-27T12:10:00.000Z",
      flowId,
    }));
    const getConnectFlowStatus = vi.fn<(payload: { flowId: string }) => Promise<{ state: "open" }>>(
      async () => ({ state: "open" }),
    );
    const finishConnect = vi.fn<(payload: { flowId: string }) => Promise<void>>(
      async () => undefined,
    );
    const cancelConnect = vi.fn<(payload: { flowId: string }) => Promise<void>>(
      async () => undefined,
    );
    const handlers = makeHandlers(vi.fn<(filePath: string) => Promise<unknown>>(), undefined, {
      beginConnect,
      getConnectFlowStatus,
      finishConnect,
      cancelConnect,
    });

    await expect(handlers.pipedreamBeginConnect({ appSlug: "gmail" })).resolves.toMatchObject({
      flowId,
    });
    await expect(handlers.pipedreamGetConnectFlowStatus({ flowId })).resolves.toEqual({
      state: "open",
    });
    await handlers.pipedreamFinishConnect({ flowId });
    await handlers.pipedreamCancelConnect({ flowId });

    expect(beginConnect).toHaveBeenCalledExactlyOnceWith({ appSlug: "gmail" });
    expect(getConnectFlowStatus).toHaveBeenCalledExactlyOnceWith({ flowId });
    expect(finishConnect).toHaveBeenCalledExactlyOnceWith({ flowId });
    expect(cancelConnect).toHaveBeenCalledExactlyOnceWith({ flowId });
    expect(JSON.stringify({ flowId })).not.toMatch(/tabId|https?:|token=/i);
  });

  it("delegates only URL-free Personal Pipedream OAuth handles and coarse status", async () => {
    const flowId = "4d73cb38-1566-4e07-bf92-ce6edf1c82e8";
    const beginPersonalMcpOauth = vi.fn<() => Promise<unknown>>(async () => ({
      state: "open",
      flowId,
    }));
    const getPersonalMcpOauthFlowStatus = vi.fn<(payload: { flowId: string }) => Promise<unknown>>(
      async () => ({ state: "authorized" }),
    );
    const cancelPersonalMcpOauth = vi.fn<(payload: { flowId: string }) => Promise<void>>(
      async () => undefined,
    );
    const clearPersonalMcpOauth = vi.fn<() => Promise<void>>(async () => undefined);
    const handlers = makeHandlers(vi.fn(), undefined, {
      beginPersonalMcpOauth,
      getPersonalMcpOauthFlowStatus,
      cancelPersonalMcpOauth,
      clearPersonalMcpOauth,
    });

    const begin = await handlers.pipedreamBeginPersonalMcpOauth({});
    await expect(handlers.pipedreamGetPersonalMcpOauthFlowStatus({ flowId })).resolves.toEqual({
      state: "authorized",
    });
    await handlers.pipedreamCancelPersonalMcpOauth({ flowId });
    await handlers.pipedreamClearPersonalMcpOauth({});

    expect(begin).toEqual({ state: "open", flowId });
    expect(JSON.stringify(begin)).not.toMatch(
      /authorizationUrl|renderer-secret-sentinel|code_challenge|tabId|supervisorFlowId/i,
    );
    expect(beginPersonalMcpOauth).toHaveBeenCalledOnce();
    expect(getPersonalMcpOauthFlowStatus).toHaveBeenCalledWith({ flowId });
    expect(cancelPersonalMcpOauth).toHaveBeenCalledWith({ flowId });
    expect(clearPersonalMcpOauth).toHaveBeenCalledOnce();
  });
});
