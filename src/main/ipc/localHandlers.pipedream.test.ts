import { beforeEach, describe, expect, it, vi } from "vitest";

const showOpenDialogMock = vi.hoisted(() =>
  vi.fn<
    (
      parent: unknown,
      options: unknown,
    ) => Promise<{ canceled: boolean; filePaths: readonly string[] }>
  >(),
);

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp", isPackaged: false },
  clipboard: { writeImage: vi.fn<(image: unknown) => void>() },
  dialog: {
    showOpenDialog: showOpenDialogMock,
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
    pipedreamMainService: { importEnvironmentFile, clearEnvironmentFile } as never,
    browserCookieImportService: {} as never,
    cookieImportBridge: {} as never,
    browserCookieImportExtensionDir: "/tmp/y-space-cookie-import",
  });
}

describe("local Pipedream env-file IPC handler", () => {
  beforeEach(() => vi.clearAllMocks());

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

  it("clears path metadata through a main-only service call", async () => {
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
});
