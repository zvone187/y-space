import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const nativeThemeMock = vi.hoisted(() => ({
  prefersReducedTransparency: false,
  themeSource: "dark" as "system" | "light" | "dark",
}));
const osReleaseMock = vi.hoisted(() => ({ value: "25.2.0" }));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  release: () => osReleaseMock.value,
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp", isPackaged: false },
  clipboard: { writeImage: vi.fn<(image: unknown) => void>() },
  dialog: {
    showOpenDialog: vi.fn<() => Promise<{ canceled: boolean; filePaths: string[] }>>(),
    showMessageBox: vi.fn<() => Promise<{ response: number }>>(),
    showSaveDialog: vi.fn<() => Promise<unknown>>(),
  },
  nativeImage: {
    createFromBuffer: vi.fn<() => { isEmpty: () => boolean }>(() => ({
      isEmpty: () => true,
    })),
  },
  nativeTheme: nativeThemeMock,
  shell: {
    openExternal: vi.fn<() => Promise<void>>(),
    openPath: vi.fn<() => Promise<void>>(),
  },
}));

import { createLocalIpcHandlers } from "./localHandlers";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

interface WindowMaterialMock {
  setBackgroundColor(color: string): void;
  setBackgroundMaterial(material: "acrylic" | "none"): void;
  setTitleBarOverlay(options: { color: string; symbolColor: string; height: number }): void;
  setVibrancy(material: "sidebar" | null): void;
}

function makeHandlers(overrides: Partial<WindowMaterialMock>) {
  const mainWindow: WindowMaterialMock = {
    setBackgroundColor: vi.fn<WindowMaterialMock["setBackgroundColor"]>(),
    setBackgroundMaterial: vi.fn<WindowMaterialMock["setBackgroundMaterial"]>(),
    setTitleBarOverlay: vi.fn<WindowMaterialMock["setTitleBarOverlay"]>(),
    setVibrancy: vi.fn<WindowMaterialMock["setVibrancy"]>(),
  };
  Object.assign(mainWindow, overrides);
  return createLocalIpcHandlers({
    getMainWindow: () => mainWindow,
    getBrowserPanelManager: () => null,
    getRemoteAccessServer: () => null,
    setRemoteAccessEnabled: vi.fn<() => void>(),
    getRemoteAccessTailscaleStatus: vi.fn<() => void>(),
    setRemoteAccessTailscaleHttps: vi.fn<() => void>(),
    startTailscale: vi.fn<() => void>(),
    setRemoteAccessAdvertisedUrl: vi.fn<() => void>(),
    sshConnectionManager: {},
    requirePoracodePaths: () => ({ baseDir: "/tmp/y-space" }),
    updatePowerSaveBlocker: vi.fn<() => void>(),
    autoUpdater: {},
    extractBrowserToWindow: vi.fn<() => void>(),
    injectBrowserToMain: vi.fn<() => void>(),
    requestRelaunch: vi.fn<() => void>(),
    scheduleService: {},
    prWatchService: {},
    pipedreamMainService: {},
    browserCookieImportService: {},
    cookieImportBridge: {},
    browserCookieImportExtensionDir: "/tmp/y-space-cookie-import",
  } as never);
}

describe("local setWindowChrome native material handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nativeThemeMock.prefersReducedTransparency = false;
    nativeThemeMock.themeSource = "dark";
    osReleaseMock.value = "25.2.0";
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
  });

  afterAll(() => {
    if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
  });

  it("enables macOS vibrancy before revealing the transparent window", async () => {
    const operations: string[] = [];
    const handlers = makeHandlers({
      setBackgroundColor: (color) => operations.push(`background:${color}`),
      setVibrancy: (material) => operations.push(`vibrancy:${String(material)}`),
    });

    const result = await handlers.setWindowChrome({
      appearance: "light",
      backgroundColor: "#ffffff",
      materialEnabled: true,
      symbolColor: "#161616",
      themeMode: "system",
    });

    expect(operations).toEqual(["vibrancy:sidebar", "background:#00000000"]);
    expect(result).toEqual({ nativeCapable: true, nativeActive: true });
    expect(nativeThemeMock.themeSource).toBe("system");
  });

  it("paints an opaque background before disabling macOS vibrancy", async () => {
    const operations: string[] = [];
    const handlers = makeHandlers({
      setBackgroundColor: (color) => operations.push(`background:${color}`),
      setVibrancy: (material) => operations.push(`vibrancy:${String(material)}`),
    });

    const result = await handlers.setWindowChrome({
      appearance: "dark",
      backgroundColor: "#070709",
      materialEnabled: false,
      symbolColor: "#f5f5f7",
      themeMode: "dark",
    });

    expect(operations).toEqual(["background:#070709", "vibrancy:null"]);
    expect(result).toEqual({ nativeCapable: true, nativeActive: false });
    expect(nativeThemeMock.themeSource).toBe("dark");
  });

  it("enables Windows acrylic before revealing the transparent surface", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    osReleaseMock.value = "10.0.22621";
    const operations: string[] = [];
    const handlers = makeHandlers({
      setBackgroundColor: (color) => operations.push(`background:${color}`),
      setBackgroundMaterial: (material) => operations.push(`material:${material}`),
    });

    const result = await handlers.setWindowChrome({
      appearance: "light",
      backgroundColor: "#ffffff",
      materialEnabled: true,
      symbolColor: "#161616",
      themeMode: "light",
    });

    expect(operations).toEqual(["material:acrylic", "background:#00000000"]);
    expect(result).toEqual({ nativeCapable: true, nativeActive: true });
  });

  it("paints Windows opaque before removing acrylic", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    osReleaseMock.value = "10.0.22621";
    const operations: string[] = [];
    const handlers = makeHandlers({
      setBackgroundColor: (color) => operations.push(`background:${color}`),
      setBackgroundMaterial: (material) => operations.push(`material:${material}`),
    });

    const result = await handlers.setWindowChrome({
      appearance: "dark",
      backgroundColor: "#070709",
      materialEnabled: false,
      symbolColor: "#fafafa",
      themeMode: "dark",
    });

    expect(operations).toEqual(["background:#070709", "material:none"]);
    expect(result).toEqual({ nativeCapable: true, nativeActive: false });
  });

  it("keeps Windows acrylic inactive when the OS reduces transparency", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    osReleaseMock.value = "10.0.22621";
    nativeThemeMock.prefersReducedTransparency = true;
    const operations: string[] = [];
    const handlers = makeHandlers({
      setBackgroundColor: (color) => operations.push(`background:${color}`),
      setBackgroundMaterial: (material) => operations.push(`material:${material}`),
    });

    const result = await handlers.setWindowChrome({
      appearance: "light",
      backgroundColor: "#ffffff",
      materialEnabled: true,
      symbolColor: "#161616",
      themeMode: "system",
    });

    expect(operations).toEqual(["background:#ffffff", "material:none"]);
    expect(result).toEqual({ nativeCapable: true, nativeActive: false });
  });
});
