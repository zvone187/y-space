import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserEvent, BrowserTabGroupInfo, BrowserTabInfo } from "@/shared/ipc";
import {
  inspectSensitiveSessionPartitionPoolForTests,
  resetSensitiveSessionPartitionPoolForTests,
  SENSITIVE_SESSION_PARTITION_POOL_SIZE,
} from "./sensitiveSessionPartitionPool";

const resolveWebContentsById = vi.hoisted(() => vi.fn<(id: number) => unknown>());
const shellOpenExternal = vi.hoisted(() => vi.fn<(url: string) => Promise<void>>());
const dbGetState = vi.hoisted(() => vi.fn<(key: string) => string | null>());
const dbSetState = vi.hoisted(() => vi.fn<(key: string, value: string) => void>());
const saveClipboardImageFile = vi.hoisted(() => vi.fn<() => string>(() => "/tmp/Selection.png"));
const electronSessionsByPartition = vi.hoisted(() => new Map<string, object>());
const electronSessionFromPartition = vi.hoisted(() =>
  vi.fn<(partition: string) => object>((partition) => {
    const existing = electronSessionsByPartition.get(partition);
    if (existing) return existing;
    const created = { partition };
    electronSessionsByPartition.set(partition, created);
    return created;
  }),
);
const mainOwnedSensitiveViews = vi.hoisted(
  () =>
    [] as Array<{
      webContents: ReturnType<typeof createMockMainOwnedWebContents>;
      setVisible: ReturnType<typeof vi.fn>;
      setBounds: ReturnType<typeof vi.fn>;
    }>,
);
const deferredSensitiveLoads = vi.hoisted(() => [] as Array<{ promise: Promise<void> }>);
let mainOwnedSensitiveViewId = 10_000;
let mainOwnedSensitiveSessionOverride: object | undefined;
let mainOwnedSensitiveHostOverride: object | null = null;
let deferMainOwnedSensitiveClose = false;

function createMockMainOwnedWebContents(partition: string) {
  let destroyed = false;
  const listeners = new Map<
    string,
    Set<{ listener: (...args: unknown[]) => void; once: boolean }>
  >();
  const addListener = (event: string, listener: (...args: unknown[]) => void, once: boolean) => {
    const registered = listeners.get(event) ?? new Set();
    registered.add({ listener, once });
    listeners.set(event, registered);
  };
  const removeListener = (event: string, listener: (...args: unknown[]) => void) => {
    const registered = listeners.get(event);
    if (!registered) return;
    for (const entry of registered) {
      if (entry.listener === listener) registered.delete(entry);
    }
  };
  const emit = (event: string, ...args: unknown[]) => {
    const registered = listeners.get(event);
    if (!registered) return;
    for (const entry of [...registered]) {
      if (entry.once) registered.delete(entry);
      entry.listener(...args);
    }
  };
  const finishClose = () => {
    if (destroyed) return;
    destroyed = true;
    emit("destroyed");
  };
  return {
    id: ++mainOwnedSensitiveViewId,
    session: mainOwnedSensitiveSessionOverride ?? electronSessionFromPartition(partition),
    hostWebContents: mainOwnedSensitiveHostOverride,
    getType: () => "webview" as const,
    isDestroyed: () => destroyed,
    on: vi.fn<(event: string, listener: (...args: unknown[]) => void) => void>((event, listener) =>
      addListener(event, listener, false),
    ),
    once: vi.fn<(event: string, listener: (...args: unknown[]) => void) => void>(
      (event, listener) => addListener(event, listener, true),
    ),
    removeListener:
      vi.fn<(event: string, listener: (...args: unknown[]) => void) => void>(removeListener),
    emitRenderProcessGone: () => emit("render-process-gone", {}, { reason: "crashed" }),
    close: vi.fn<() => void>(() => {
      if (destroyed) return;
      if (!deferMainOwnedSensitiveClose) finishClose();
    }),
    finishClose,
  };
}
let sensitivePartitionSerial = 0;
const browserTabs = vi.hoisted(
  () =>
    new Map<
      string,
      {
        emitUrl(url: string, title?: string): void;
        emitPopup(url: string): void;
        clearHistory: ReturnType<typeof vi.fn>;
        loadUrls: string[];
        attachedWebContents: unknown[];
        permissionProfile: "ordinary" | "sensitive" | undefined;
        toggleDevTools: ReturnType<typeof vi.fn>;
        capturePng: ReturnType<typeof vi.fn>;
      }
    >(),
);

vi.mock("electron", () => ({
  BrowserWindow: class BrowserWindow {},
  WebContentsView: class WebContentsView {
    readonly webContents: ReturnType<typeof createMockMainOwnedWebContents>;
    readonly setVisible = vi.fn<(visible: boolean) => void>();
    readonly setBounds = vi.fn<(bounds: Electron.Rectangle) => void>();

    constructor(options?: { webPreferences?: { partition?: string } }) {
      this.webContents = createMockMainOwnedWebContents(options?.webPreferences?.partition ?? "");
      mainOwnedSensitiveViews.push(this);
    }
  },
  session: { fromPartition: electronSessionFromPartition },
  shell: { openExternal: shellOpenExternal },
}));

vi.mock("../db", () => ({
  dbGetState,
  dbSetState,
}));

vi.mock("../sharedSettingsFile", () => ({
  readSharedSettingsFile: vi.fn<(path: string) => unknown>(),
}));

vi.mock("../attachments/localFiles", () => ({
  saveClipboardImageFile,
}));

vi.mock("@/shared/ipc", () => ({
  IPC_EVENT_CHANNELS: { browserEvent: "browser-event" },
  browserTabGroupSchema: {
    safeParse: vi.fn<(value: unknown) => { success: true; data: unknown }>((value) => ({
      success: true,
      data: value,
    })),
  },
}));

vi.mock("./picker/pickerProtocol", () => ({
  PICKER_COMMIT_ORIGIN: "poracode-picker",
  onPickerCommit: vi.fn<() => () => void>(() => vi.fn<() => void>()),
}));

vi.mock("./picker/pickerScript", () => ({
  buildPickerScript: vi.fn<() => string>(),
}));

vi.mock("./BrowserTab", () => ({
  BROWSER_TAB_ATTACH_TIMEOUT_MS: 8_000,
  MAX_BROWSER_URL_BYTES: 64 * 1024,
  BrowserTab: class BrowserTab {
    readonly tabId: string;
    readonly clearHistory = vi.fn<() => void>();
    readonly toggleDevTools = vi.fn<() => void>();
    readonly capturePng = vi.fn<() => Promise<Buffer>>(async () => Buffer.from("private-png"));
    private attachedWebContentsValue: unknown = null;
    private readonly attachedWebContents: unknown[];
    private snapshotValue: {
      tabId: string;
      url: string;
      title: string;
      loading: boolean;
      canGoBack: boolean;
      canGoForward: boolean;
      devToolsOpen: boolean;
    };

    constructor(
      private readonly options: {
        tabId: string;
        initialUrl?: string;
        initialTitle?: string;
        permissionProfile?: "ordinary" | "sensitive";
        onUpdate(snapshot: unknown): void;
        onPopup?(sourceTabId: string, popupUrl: string): void;
      },
    ) {
      this.tabId = options.tabId;
      this.snapshotValue = {
        tabId: options.tabId,
        url: options.initialUrl ?? "about:blank",
        title: options.initialTitle ?? "",
        loading: false,
        canGoBack: false,
        canGoForward: false,
        devToolsOpen: false,
      };
      const loadUrls: string[] = [];
      const attachedWebContents: unknown[] = [];
      browserTabs.set(options.tabId, {
        emitUrl: (url, title = "Connected") => {
          this.snapshotValue = { ...this.snapshotValue, url, title, loading: false };
          options.onUpdate(this.snapshotValue);
        },
        emitPopup: (url) => options.onPopup?.(options.tabId, url),
        clearHistory: this.clearHistory,
        loadUrls,
        attachedWebContents,
        permissionProfile: options.permissionProfile,
        toggleDevTools: this.toggleDevTools,
        capturePng: this.capturePng,
      });
      this.attachedWebContents = attachedWebContents;
    }

    snapshot() {
      return { ...this.snapshotValue };
    }

    attach(webContents: unknown) {
      if (this.attachedWebContentsValue === webContents) return false;
      this.attachedWebContentsValue = webContents;
      this.attachedWebContents.push(webContents);
      return true;
    }
    isAttached() {
      return this.attachedWebContentsValue !== null;
    }
    isDestroyed() {
      return false;
    }
    whenAttached() {
      return Promise.resolve();
    }
    async loadURL(url: string) {
      browserTabs.get(this.tabId)?.loadUrls.push(url);
      const deferred = deferredSensitiveLoads.shift();
      if (deferred) await deferred.promise;
      this.snapshotValue = { ...this.snapshotValue, url, loading: false };
      this.options.onUpdate(this.snapshotValue);
    }
    async destroy() {
      browserTabs.delete(this.tabId);
    }
  },
  resolveWebContentsById,
}));

function createGuestWebContents(
  id: number,
  guestSession: object | null = electronSessionFromPartition("persist:lightcode-browser"),
  options: { hostWebContents?: object | null; type?: string } = {},
) {
  let destroyed = false;
  const destroyedListeners = new Set<() => void>();
  return {
    id,
    hostWebContents: options.hostWebContents ?? null,
    getType: () => options.type ?? "webview",
    ...(guestSession === null ? {} : { session: guestSession }),
    isDestroyed: () => destroyed,
    once: vi.fn<(event: string, listener: () => void) => void>((event, listener) => {
      if (event === "destroyed") destroyedListeners.add(listener);
    }),
    removeListener: vi.fn<(event: string, listener: () => void) => void>((event, listener) => {
      if (event === "destroyed") destroyedListeners.delete(listener);
    }),
    emitDestroyed: () => {
      destroyed = true;
      for (const listener of [...destroyedListeners]) listener();
      destroyedListeners.clear();
    },
    emitStaleDestroyed: (listener: () => void) => listener(),
  };
}

function createSensitiveOwnership(overrides?: {
  sessionPartition?: string;
  canOpenTab?: () => boolean;
  onTabOpened?: (tabId: string) => void;
  onTabClosed?: (tabId: string) => void;
}) {
  const suffix = (++sensitivePartitionSerial).toString(16).padStart(32, "0");
  return {
    sessionPartition: overrides?.sessionPartition ?? `pipedream-oauth-${suffix}`,
    canOpenTab: overrides?.canOpenTab ?? (() => true),
    onTabOpened: overrides?.onTabOpened ?? (() => undefined),
    onTabClosed: overrides?.onTabClosed ?? (() => undefined),
  };
}

function sensitiveViewGeneration(tab: BrowserTabInfo): number {
  if (!tab.sensitiveIntegration) throw new Error(`Expected sensitive tab: ${tab.tabId}`);
  return tab.sensitiveViewGeneration;
}

function createManagerWithTab(webContentsId = 42) {
  const tab = {
    tabId: "tab-1",
    attach: vi.fn<(webContents: unknown) => boolean>(() => true),
  };
  const webContentsListeners = new Map<string, Set<(...args: unknown[]) => void>>();
  let mainFrame = { processId: webContentsId + 100, routingId: webContentsId + 200 };
  const hostWebContents = {
    id: webContentsId,
    get mainFrame() {
      return mainFrame;
    },
    isLoadingMainFrame: vi.fn<() => boolean>(() => false),
    on: vi.fn<(event: string, listener: (...args: unknown[]) => void) => void>(
      (event, listener) => {
        const listeners = webContentsListeners.get(event) ?? new Set();
        listeners.add(listener);
        webContentsListeners.set(event, listeners);
      },
    ),
    removeListener: vi.fn<(event: string, listener: (...args: unknown[]) => void) => void>(
      (event, listener) => {
        webContentsListeners.get(event)?.delete(listener);
      },
    ),
    send: vi.fn<() => void>(),
  };
  const contentView = {
    addChildView: vi.fn<() => void>(),
    removeChildView: vi.fn<() => void>(),
  };
  const windowOnceListeners = new Map<string, () => void>();
  let destroyed = false;
  const host = {
    webContents: hostWebContents,
    contentView,
    getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
    on: vi.fn<() => void>(),
    once: vi.fn<(event: string, listener: () => void) => void>((event, listener) => {
      windowOnceListeners.set(event, listener);
    }),
    removeListener: vi.fn<(event: string, listener: () => void) => void>((event, listener) => {
      if (windowOnceListeners.get(event) === listener) windowOnceListeners.delete(event);
    }),
    isDestroyed: () => destroyed,
  };
  const emitWebContentsEvent = (event: string, ...args: unknown[]) => {
    for (const listener of [...(webContentsListeners.get(event) ?? [])]) listener(...args);
  };
  const replaceMainFrame = () => {
    mainFrame = { processId: mainFrame.processId + 1, routingId: mainFrame.routingId + 1 };
    return mainFrame;
  };
  const emitClosed = () => {
    destroyed = true;
    windowOnceListeners.get("closed")?.();
    windowOnceListeners.delete("closed");
  };
  return {
    tab,
    host,
    hostWebContents,
    contentView,
    emitWebContentsEvent,
    replaceMainFrame,
    emitClosed,
    webContentsListenerCount: (event: string) => webContentsListeners.get(event)?.size ?? 0,
    windowListenerCount: (event: string) => (windowOnceListeners.has(event) ? 1 : 0),
  };
}

function attachWebviewFromHost(
  manager: {
    attachWebContents(
      tabId: string,
      webContentsId: number,
      senderWebContentsId?: number,
      senderFrame?: { processId: number; routingId: number } | null,
    ): boolean;
  },
  tabId: string,
  webContentsId: number,
  host: ReturnType<typeof createManagerWithTab>,
): boolean {
  return manager.attachWebContents(
    tabId,
    webContentsId,
    host.hostWebContents.id,
    host.hostWebContents.mainFrame,
  );
}

function acknowledgePresentationFromHost(
  manager: {
    acknowledgeAutomationPresentation(
      payload: Parameters<
        import("./BrowserPanelManager").BrowserPanelManager["acknowledgeAutomationPresentation"]
      >[0],
      senderWebContentsId?: number,
      senderFrame?: { processId: number; routingId: number } | null,
    ): boolean;
  },
  payload: Parameters<
    import("./BrowserPanelManager").BrowserPanelManager["acknowledgeAutomationPresentation"]
  >[0],
  host: ReturnType<typeof createManagerWithTab>,
): boolean {
  return manager.acknowledgeAutomationPresentation(
    payload,
    host.hostWebContents.id,
    host.hostWebContents.mainFrame,
  );
}

function invalidatePresentationFromHost(
  manager: {
    invalidateAutomationPresentation(
      payload: Parameters<
        import("./BrowserPanelManager").BrowserPanelManager["invalidateAutomationPresentation"]
      >[0],
      senderWebContentsId?: number,
      senderFrame?: { processId: number; routingId: number } | null,
    ): boolean;
  },
  payload: Parameters<
    import("./BrowserPanelManager").BrowserPanelManager["invalidateAutomationPresentation"]
  >[0],
  host: ReturnType<typeof createManagerWithTab>,
): boolean {
  return manager.invalidateAutomationPresentation(
    payload,
    host.hostWebContents.id,
    host.hostWebContents.mainFrame,
  );
}

function createFakeTab(tabId: string) {
  return {
    tabId,
    isAttached: () => false,
    destroy: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    snapshot: () => ({
      tabId,
      url: `https://${tabId}.test/`,
      title: tabId,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      devToolsOpen: false,
    }),
  };
}

function seedGroupState(
  manager: unknown,
  tabs: ReturnType<typeof createFakeTab>[],
  groups: BrowserTabGroupInfo[],
  tabGroupPairs: Array<[string, string]>,
): void {
  const state = manager as {
    tabs: ReturnType<typeof createFakeTab>[];
    tabGroups: {
      restore(groups: BrowserTabGroupInfo[]): void;
      assignRestoredTab(tabId: string, groupId: string): boolean;
    };
  };
  state.tabs = tabs;
  state.tabGroups.restore(groups);
  for (const [tabId, groupId] of tabGroupPairs) {
    state.tabGroups.assignRestoredTab(tabId, groupId);
  }
}

describe("BrowserPanelManager", () => {
  beforeEach(() => {
    resetSensitiveSessionPartitionPoolForTests();
    vi.clearAllMocks();
    electronSessionsByPartition.clear();
    mainOwnedSensitiveViews.length = 0;
    mainOwnedSensitiveViewId = 10_000;
    mainOwnedSensitiveSessionOverride = undefined;
    mainOwnedSensitiveHostOverride = null;
    deferMainOwnedSensitiveClose = false;
    deferredSensitiveLoads.length = 0;
    sensitivePartitionSerial = 0;
    browserTabs.clear();
    dbGetState.mockReturnValue(null);
    shellOpenExternal.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("keeps opt-in browser presentation diagnostics runtime-controlled and bounded", async () => {
    const { BrowserPanelManager, MAX_AUTOMATION_PRESENTATION_TRACE_EVENTS } =
      await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.stubEnv("Y_SPACE_BROWSER_PRESENTATION_TRACE", "1");
    const trace = (
      manager as unknown as {
        traceAutomationPresentation(event: string, details: Record<string, unknown>): void;
      }
    ).traceAutomationPresentation.bind(manager);

    for (let index = 0; index < MAX_AUTOMATION_PRESENTATION_TRACE_EVENTS + 10; index += 1) {
      trace("test", { index });
    }

    expect(info).toHaveBeenCalledTimes(MAX_AUTOMATION_PRESENTATION_TRACE_EVENTS + 1);
    expect(info).toHaveBeenLastCalledWith("[y-space:browser-presentation]", "trace-suppressed", {
      limit: MAX_AUTOMATION_PRESENTATION_TRACE_EVENTS,
    });
  });

  it("rejects the host window WebContents as a browser tab target", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const hostContext = createManagerWithTab();
    const { tab, host } = hostContext;

    manager.bindHost(host as never);
    (manager as unknown as { tabs: (typeof tab)[] }).tabs = [tab];
    attachWebviewFromHost(manager, "tab-1", 42, hostContext);

    expect(resolveWebContentsById).not.toHaveBeenCalled();
    expect(tab.attach).not.toHaveBeenCalled();
  });

  it("attaches a non-host WebContents to the browser tab", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const hostContext = createManagerWithTab();
    const { tab, host } = hostContext;
    const guestWebContents = createGuestWebContents(99, undefined, {
      hostWebContents: hostContext.hostWebContents,
    });
    resolveWebContentsById.mockReturnValue(guestWebContents);

    manager.bindHost(host as never);
    (manager as unknown as { tabs: (typeof tab)[] }).tabs = [tab];
    const attached = manager.attachWebContents("tab-1", 99, hostContext.hostWebContents.id, {
      ...hostContext.hostWebContents.mainFrame,
    });

    expect(attached).toBe(true);
    expect(resolveWebContentsById).toHaveBeenCalledWith(99);
    expect(tab.attach).toHaveBeenCalledWith(guestWebContents);
  });

  it("restores host authority when loading stops without a did-finish-load event", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const hostContext = createManagerWithTab();
    const guestWebContents = createGuestWebContents(99, undefined, {
      hostWebContents: hostContext.hostWebContents,
    });
    resolveWebContentsById.mockReturnValue(guestWebContents);

    manager.bindHost(hostContext.host as never);
    const ordinary = await manager.createTab({}, { awaitAttach: false });
    hostContext.emitWebContentsEvent("did-start-loading");
    expect(attachWebviewFromHost(manager, ordinary.tabId, 99, hostContext)).toBe(false);

    hostContext.hostWebContents.isLoadingMainFrame.mockReturnValue(true);
    hostContext.emitWebContentsEvent("did-stop-loading");
    expect(attachWebviewFromHost(manager, ordinary.tabId, 99, hostContext)).toBe(false);
    hostContext.hostWebContents.isLoadingMainFrame.mockReturnValue(false);

    // Electron pairs spinner-level did-start-loading with did-stop-loading.
    // did-finish-load is main-document-specific and is not guaranteed for
    // every loading cycle, so authority must recover from the paired event.
    hostContext.emitWebContentsEvent("did-stop-loading");

    expect(attachWebviewFromHost(manager, ordinary.tabId, 99, hostContext)).toBe(true);
    expect(browserTabs.get(ordinary.tabId)?.attachedWebContents).toEqual([guestWebContents]);

    hostContext.emitWebContentsEvent("render-process-gone");
    hostContext.emitWebContentsEvent("did-stop-loading");
    const afterCrash = await manager.createTab({}, { awaitAttach: false });
    const postCrashGuest = createGuestWebContents(100, undefined, {
      hostWebContents: hostContext.hostWebContents,
    });
    resolveWebContentsById.mockReturnValue(postCrashGuest);
    expect(attachWebviewFromHost(manager, afterCrash.tabId, 100, hostContext)).toBe(false);
    expect(browserTabs.get(afterCrash.tabId)?.attachedWebContents).toEqual([]);

    // A stale document event from the crashed renderer cannot restore host
    // authority. Only a subsequent loading cycle may clear the crash epoch.
    hostContext.emitWebContentsEvent("did-finish-load");
    expect(attachWebviewFromHost(manager, afterCrash.tabId, 100, hostContext)).toBe(false);
    hostContext.emitWebContentsEvent("did-start-loading");
    hostContext.emitWebContentsEvent("did-finish-load");
    expect(attachWebviewFromHost(manager, afterCrash.tabId, 100, hostContext)).toBe(true);
  });

  it("binds each host once and removes every host listener on manager disposal", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const host = createManagerWithTab(42);

    manager.bindHost(host.host as never);
    manager.bindHost(host.host as never);

    for (const event of [
      "before-input-event",
      "did-start-loading",
      "did-stop-loading",
      "did-finish-load",
      "render-process-gone",
    ]) {
      expect(host.webContentsListenerCount(event)).toBe(1);
    }
    expect(host.windowListenerCount("closed")).toBe(1);

    manager.dispose();

    for (const event of [
      "before-input-event",
      "did-start-loading",
      "did-stop-loading",
      "did-finish-load",
      "render-process-gone",
    ]) {
      expect(host.webContentsListenerCount(event)).toBe(0);
    }
    expect(host.windowListenerCount("closed")).toBe(0);
  });

  it("rejects arbitrary windows, cross-host webviews, and stale or subframe attach senders", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const main = createManagerWithTab(42);
    const otherHost = createManagerWithTab(43);
    manager.bindHost(main.host as never);
    manager.bindHost(otherHost.host as never);
    const ordinary = await manager.createTab({}, { awaitAttach: false });
    const arbitraryWindow = createGuestWebContents(91, undefined, {
      hostWebContents: main.hostWebContents,
      type: "window",
    });
    const crossHostWebview = createGuestWebContents(92, undefined, {
      hostWebContents: otherHost.hostWebContents,
    });
    const validWebview = createGuestWebContents(93, undefined, {
      hostWebContents: main.hostWebContents,
    });

    resolveWebContentsById.mockReturnValue(arbitraryWindow);
    attachWebviewFromHost(manager, ordinary.tabId, arbitraryWindow.id, main);
    resolveWebContentsById.mockReturnValue(crossHostWebview);
    attachWebviewFromHost(manager, ordinary.tabId, crossHostWebview.id, main);
    resolveWebContentsById.mockReturnValue(validWebview);
    manager.attachWebContents(ordinary.tabId, validWebview.id, main.hostWebContents.id, {
      processId: main.hostWebContents.mainFrame.processId,
      routingId: main.hostWebContents.mainFrame.routingId + 1,
    });
    manager.attachWebContents(
      ordinary.tabId,
      validWebview.id,
      otherHost.hostWebContents.id,
      otherHost.hostWebContents.mainFrame,
    );
    main.emitWebContentsEvent("did-start-loading");
    expect(attachWebviewFromHost(manager, ordinary.tabId, validWebview.id, main)).toBe(false);
    expect(browserTabs.get(ordinary.tabId)?.attachedWebContents).toEqual([]);

    main.emitWebContentsEvent("did-finish-load");
    expect(attachWebviewFromHost(manager, ordinary.tabId, validWebview.id, main)).toBe(true);
    expect(browserTabs.get(ordinary.tabId)?.attachedWebContents).toEqual([validWebview]);
  });

  it("never aliases one sensitive guest WebContents into an ordinary browser tab", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const hostContext = createManagerWithTab();
    manager.bindHost(hostContext.host as never);
    const ownership = createSensitiveOwnership();
    const sensitive = await manager.createSensitiveIntegrationTab(
      { url: "https://pipedream.com/connect?app=gmail&token=private" },
      { awaitAttach: false },
      ownership,
    );
    const ordinary = await manager.createTab(
      { url: "https://ordinary.test/" },
      { awaitAttach: false },
    );
    const guest = createGuestWebContents(
      99,
      electronSessionFromPartition(ownership.sessionPartition),
      { hostWebContents: hostContext.hostWebContents },
    );
    resolveWebContentsById.mockReturnValue(guest);

    manager.attachWebContents(sensitive.tabId, guest.id);
    attachWebviewFromHost(manager, ordinary.tabId, guest.id, hostContext);

    expect(browserTabs.get(sensitive.tabId)?.attachedWebContents).toEqual([
      mainOwnedSensitiveViews[0]!.webContents,
    ]);
    expect(browserTabs.get(ordinary.tabId)?.attachedWebContents).toEqual([]);
  });

  it("rejects every renderer attachment to a sensitive tab before private navigation", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const ownership = createSensitiveOwnership();
    const privateUrl = "https://pipedream.com/connect?app=gmail&token=private";
    const sensitive = await manager.createSensitiveIntegrationTab(
      { url: privateUrl },
      { awaitAttach: false },
      ownership,
    );
    const missingSession = createGuestWebContents(191, null);
    const persistentSession = createGuestWebContents(
      192,
      electronSessionFromPartition("persist:pipedream-oauth-private"),
    );
    const exactSession = createGuestWebContents(
      193,
      electronSessionFromPartition(ownership.sessionPartition),
    );

    for (const rejected of [missingSession, persistentSession]) {
      resolveWebContentsById.mockReturnValue(rejected);
      manager.attachWebContents(sensitive.tabId, rejected.id);
    }

    expect(browserTabs.get(sensitive.tabId)?.attachedWebContents).toEqual([
      mainOwnedSensitiveViews[0]!.webContents,
    ]);
    expect(browserTabs.get(sensitive.tabId)?.loadUrls).toEqual([privateUrl]);

    resolveWebContentsById.mockReturnValue(exactSession);
    manager.attachWebContents(sensitive.tabId, exactSession.id);

    expect(browserTabs.get(sensitive.tabId)?.attachedWebContents).toEqual([
      mainOwnedSensitiveViews[0]!.webContents,
    ]);
    expect(browserTabs.get(sensitive.tabId)?.loadUrls).toEqual([privateUrl]);
  });

  it("selects the deny-by-default session permission profile only for sensitive tabs", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const sensitive = await manager.createSensitiveIntegrationTab(
      { url: "https://pipedream.com/connect?app=gmail&token=private" },
      { awaitAttach: false },
      createSensitiveOwnership(),
    );
    const ordinary = await manager.createTab({}, { awaitAttach: false });

    expect(browserTabs.get(sensitive.tabId)?.permissionProfile).toBe("sensitive");
    expect(browserTabs.get(ordinary.tabId)?.permissionProfile).toBeUndefined();
  });

  it("binds sensitive view presentation to the exact main-owned host sender", async () => {
    vi.useFakeTimers();
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const { host, hostWebContents, contentView } = createManagerWithTab();
    manager.bindHost(host as never);
    const sensitive = await manager.createSensitiveIntegrationTab(
      { url: "https://pipedream.com/connect?app=gmail&token=private" },
      { awaitAttach: false },
      createSensitiveOwnership(),
    );
    const view = mainOwnedSensitiveViews[0]!;
    const generation = sensitiveViewGeneration(sensitive);

    manager.presentSensitiveIntegrationView(
      sensitive.tabId,
      { x: 20, y: 30, width: 600, height: 500 },
      true,
      generation,
      999,
      hostWebContents.mainFrame,
    );
    manager.presentSensitiveIntegrationView(
      "wrong-tab",
      { x: 20, y: 30, width: 600, height: 500 },
      true,
      generation,
      42,
      hostWebContents.mainFrame,
    );
    expect(contentView.addChildView).not.toHaveBeenCalled();

    manager.presentSensitiveIntegrationView(
      sensitive.tabId,
      { x: 20, y: 30, width: 600, height: 500 },
      true,
      generation,
      42,
      { ...hostWebContents.mainFrame },
    );
    expect(contentView.addChildView).toHaveBeenCalledExactlyOnceWith(view);
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 20, y: 30, width: 600, height: 500 });
    expect(view.setVisible).toHaveBeenLastCalledWith(true);

    view.webContents.close();
    expect(mainOwnedSensitiveViews).toHaveLength(1);
    expect(view.setVisible).toHaveBeenLastCalledWith(false);
    const recoveryGeneration = sensitiveViewGeneration(
      manager.snapshot().tabs.find((tab) => tab.tabId === sensitive.tabId)!,
    );
    expect(recoveryGeneration).toBeGreaterThan(generation);
    manager.presentSensitiveIntegrationView(
      sensitive.tabId,
      { x: 25, y: 35, width: 610, height: 510 },
      true,
      recoveryGeneration,
      42,
      hostWebContents.mainFrame,
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(mainOwnedSensitiveViews).toHaveLength(2);
    const recoveredView = mainOwnedSensitiveViews[1]!;
    expect(contentView.addChildView).toHaveBeenLastCalledWith(recoveredView);
    expect(recoveredView.setBounds).toHaveBeenLastCalledWith({
      x: 25,
      y: 35,
      width: 610,
      height: 510,
    });
    expect(recoveredView.setVisible).toHaveBeenLastCalledWith(true);
  });

  it("invalidates native sensitive geometry across main to extracted to main transitions", async () => {
    let extracted = false;
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
      { isExtracted: () => extracted },
    );
    const main = createManagerWithTab(42);
    manager.bindHost(main.host as never);
    const sensitive = await manager.createSensitiveIntegrationTab(
      { url: "https://pipedream.com/connect?app=gmail&token=private" },
      { awaitAttach: false },
      createSensitiveOwnership(),
    );
    const view = mainOwnedSensitiveViews[0]!;
    const currentGeneration = () => {
      const tab = manager.snapshot().tabs.find((candidate) => candidate.tabId === sensitive.tabId);
      if (!tab) throw new Error("Missing sensitive tab");
      return sensitiveViewGeneration(tab);
    };
    const bounds = { x: 20, y: 30, width: 600, height: 500 };
    const mainGeneration = currentGeneration();
    manager.presentSensitiveIntegrationView(
      sensitive.tabId,
      bounds,
      true,
      mainGeneration,
      main.hostWebContents.id,
      main.hostWebContents.mainFrame,
    );
    expect(main.contentView.addChildView).toHaveBeenCalledExactlyOnceWith(view);

    extracted = true;
    const extractedHost = createManagerWithTab(43);
    manager.bindHost(extractedHost.host as never);
    const extractedGeneration = currentGeneration();
    expect(extractedGeneration).toBeGreaterThan(mainGeneration);
    expect(view.setVisible).toHaveBeenLastCalledWith(false);
    expect(main.contentView.removeChildView).toHaveBeenCalledExactlyOnceWith(view);

    manager.presentSensitiveIntegrationView(
      sensitive.tabId,
      bounds,
      true,
      mainGeneration,
      main.hostWebContents.id,
      main.hostWebContents.mainFrame,
    );
    expect(extractedHost.contentView.addChildView).not.toHaveBeenCalled();
    manager.presentSensitiveIntegrationView(
      sensitive.tabId,
      bounds,
      true,
      extractedGeneration,
      extractedHost.hostWebContents.id,
      extractedHost.hostWebContents.mainFrame,
    );
    expect(extractedHost.contentView.addChildView).toHaveBeenCalledExactlyOnceWith(view);

    extracted = false;
    manager.notifyState();
    const preCloseGeneration = currentGeneration();
    extractedHost.emitClosed();
    const returnedGeneration = currentGeneration();
    expect(preCloseGeneration).toBeGreaterThan(extractedGeneration);
    expect(returnedGeneration).toBeGreaterThan(preCloseGeneration);
    expect(extractedHost.contentView.removeChildView).toHaveBeenCalledExactlyOnceWith(view);
    expect(view.setVisible).toHaveBeenLastCalledWith(false);

    manager.presentSensitiveIntegrationView(
      sensitive.tabId,
      bounds,
      true,
      extractedGeneration,
      extractedHost.hostWebContents.id,
      extractedHost.hostWebContents.mainFrame,
    );
    expect(main.contentView.addChildView).toHaveBeenCalledTimes(1);
    manager.presentSensitiveIntegrationView(
      sensitive.tabId,
      bounds,
      true,
      returnedGeneration,
      main.hostWebContents.id,
      main.hostWebContents.mainFrame,
    );
    expect(main.contentView.addChildView).toHaveBeenCalledTimes(2);
    expect(main.contentView.addChildView).toHaveBeenLastCalledWith(view);
  });

  it("requires fresh current-document bounds after host reload, crash, and close", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const host = createManagerWithTab(42);
    manager.bindHost(host.host as never);
    const sensitive = await manager.createSensitiveIntegrationTab(
      { url: "https://pipedream.com/connect?app=gmail&token=private" },
      { awaitAttach: false },
      createSensitiveOwnership(),
    );
    const view = mainOwnedSensitiveViews[0]!;
    const bounds = { x: 20, y: 30, width: 600, height: 500 };
    const currentGeneration = () => {
      const tab = manager.snapshot().tabs.find((candidate) => candidate.tabId === sensitive.tabId);
      if (!tab) throw new Error("Missing sensitive tab");
      return sensitiveViewGeneration(tab);
    };
    const firstGeneration = currentGeneration();
    const firstFrame = host.hostWebContents.mainFrame;
    manager.presentSensitiveIntegrationView(
      sensitive.tabId,
      bounds,
      true,
      firstGeneration,
      host.hostWebContents.id,
      firstFrame,
    );
    expect(host.contentView.addChildView).toHaveBeenCalledOnce();

    host.emitWebContentsEvent("did-start-loading");
    const loadingGeneration = currentGeneration();
    expect(loadingGeneration).toBeGreaterThan(firstGeneration);
    expect(view.setVisible).toHaveBeenLastCalledWith(false);
    expect(host.contentView.removeChildView).toHaveBeenCalledExactlyOnceWith(view);
    manager.presentSensitiveIntegrationView(
      sensitive.tabId,
      bounds,
      true,
      loadingGeneration,
      host.hostWebContents.id,
      firstFrame,
    );
    expect(host.contentView.addChildView).toHaveBeenCalledTimes(1);

    const secondFrame = host.replaceMainFrame();
    host.emitWebContentsEvent("did-finish-load");
    const loadedGeneration = currentGeneration();
    expect(loadedGeneration).toBeGreaterThan(loadingGeneration);
    manager.presentSensitiveIntegrationView(
      sensitive.tabId,
      bounds,
      true,
      loadedGeneration,
      host.hostWebContents.id,
      firstFrame,
    );
    expect(host.contentView.addChildView).toHaveBeenCalledTimes(1);
    manager.presentSensitiveIntegrationView(
      sensitive.tabId,
      bounds,
      true,
      loadedGeneration,
      host.hostWebContents.id,
      secondFrame,
    );
    expect(host.contentView.addChildView).toHaveBeenCalledTimes(2);

    host.emitWebContentsEvent("render-process-gone");
    const crashedGeneration = currentGeneration();
    expect(crashedGeneration).toBeGreaterThan(loadedGeneration);
    expect(host.contentView.removeChildView).toHaveBeenCalledTimes(2);
    manager.presentSensitiveIntegrationView(
      sensitive.tabId,
      bounds,
      true,
      crashedGeneration,
      host.hostWebContents.id,
      secondFrame,
    );
    expect(host.contentView.addChildView).toHaveBeenCalledTimes(2);

    host.emitClosed();
    expect(view.setVisible).toHaveBeenLastCalledWith(false);
    manager.presentSensitiveIntegrationView(
      sensitive.tabId,
      bounds,
      true,
      currentGeneration(),
      host.hostWebContents.id,
      secondFrame,
    );
    expect(host.contentView.addChildView).toHaveBeenCalledTimes(2);
  });

  it("recovers render-process-gone with exact bounded backoff and no restart loop", async () => {
    vi.useFakeTimers();
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const host = createManagerWithTab(42);
    manager.bindHost(host.host as never);
    const sensitive = await manager.createSensitiveIntegrationTab(
      { url: "https://pipedream.com/connect?app=gmail&token=private" },
      { awaitAttach: false },
      createSensitiveOwnership(),
    );
    const firstView = mainOwnedSensitiveViews[0]!;
    manager.presentSensitiveIntegrationView(
      sensitive.tabId,
      { x: 20, y: 30, width: 600, height: 500 },
      true,
      sensitiveViewGeneration(sensitive),
      host.hostWebContents.id,
      host.hostWebContents.mainFrame,
    );

    firstView.webContents.emitRenderProcessGone();
    expect(firstView.setVisible).toHaveBeenLastCalledWith(false);
    expect(host.contentView.removeChildView).toHaveBeenCalledExactlyOnceWith(firstView);
    expect(firstView.webContents.close).toHaveBeenCalledOnce();
    expect(mainOwnedSensitiveViews).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(99);
    expect(mainOwnedSensitiveViews).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mainOwnedSensitiveViews).toHaveLength(2);

    mainOwnedSensitiveViews[1]!.webContents.emitRenderProcessGone();
    await vi.advanceTimersByTimeAsync(499);
    expect(mainOwnedSensitiveViews).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(mainOwnedSensitiveViews).toHaveLength(3);

    mainOwnedSensitiveViews[2]!.webContents.emitRenderProcessGone();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(mainOwnedSensitiveViews).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(mainOwnedSensitiveViews).toHaveLength(4);

    mainOwnedSensitiveViews[3]!.webContents.emitRenderProcessGone();
    await vi.runAllTimersAsync();
    await Promise.resolve();
    expect(mainOwnedSensitiveViews).toHaveLength(4);
    expect(manager.snapshot().tabs).toEqual([]);
    expect(browserTabs.size).toBe(0);
  });

  it("fails closed when Electron creates a main-owned sensitive view in the wrong session", async () => {
    mainOwnedSensitiveSessionOverride = electronSessionFromPartition("persist:wrong-session");
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const ownership = createSensitiveOwnership();

    await expect(
      manager.createSensitiveIntegrationTab(
        { url: "https://pipedream.com/connect?app=gmail&token=private" },
        { awaitAttach: false },
        ownership,
      ),
    ).rejects.toThrow(/register sensitive integration tab/i);
    expect(mainOwnedSensitiveViews[0]?.webContents.close).toHaveBeenCalledOnce();
    expect(manager.snapshot().tabs).toEqual([]);
    expect(JSON.stringify(manager.snapshot())).not.toContain(ownership.sessionPartition);
  });

  it("does not declassify a live sensitive guest when its tab reports a replacement", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const hostContext = createManagerWithTab();
    manager.bindHost(hostContext.host as never);
    const ownership = createSensitiveOwnership();
    const sensitive = await manager.createSensitiveIntegrationTab(
      { url: "https://pipedream.com/connect?app=gmail&token=private" },
      { awaitAttach: false },
      ownership,
    );
    const ordinary = await manager.createTab({}, { awaitAttach: false });
    const sensitiveSession = electronSessionFromPartition(ownership.sessionPartition);
    const sensitiveGuest = createGuestWebContents(111, sensitiveSession, {
      hostWebContents: hostContext.hostWebContents,
    });
    const prematureReplacement = createGuestWebContents(222, sensitiveSession, {
      hostWebContents: hostContext.hostWebContents,
    });

    resolveWebContentsById.mockReturnValue(sensitiveGuest);
    manager.attachWebContents(sensitive.tabId, sensitiveGuest.id);
    resolveWebContentsById.mockReturnValue(prematureReplacement);
    manager.attachWebContents(sensitive.tabId, prematureReplacement.id);
    resolveWebContentsById.mockReturnValue(sensitiveGuest);
    attachWebviewFromHost(manager, ordinary.tabId, sensitiveGuest.id, hostContext);

    expect(browserTabs.get(sensitive.tabId)?.attachedWebContents).toEqual([
      mainOwnedSensitiveViews[0]!.webContents,
    ]);
    expect(browserTabs.get(ordinary.tabId)?.attachedWebContents).toEqual([]);

    sensitiveGuest.emitDestroyed();
    resolveWebContentsById.mockReturnValue(prematureReplacement);
    manager.attachWebContents(sensitive.tabId, prematureReplacement.id);
    expect(browserTabs.get(sensitive.tabId)?.attachedWebContents).toEqual([
      mainOwnedSensitiveViews[0]!.webContents,
    ]);
  });

  it("never aliases the main-owned sensitive WebContents into an ordinary tab", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const hostContext = createManagerWithTab();
    manager.bindHost(hostContext.host as never);
    mainOwnedSensitiveHostOverride = hostContext.hostWebContents;
    const ownership = createSensitiveOwnership();
    const sensitive = await manager.createSensitiveIntegrationTab(
      { url: "https://pipedream.com/connect?app=gmail&token=private" },
      { awaitAttach: false },
      ownership,
    );
    const ordinary = await manager.createTab({}, { awaitAttach: false });
    const closingGuest = mainOwnedSensitiveViews[0]!.webContents;
    resolveWebContentsById.mockReturnValue(closingGuest);
    attachWebviewFromHost(manager, ordinary.tabId, closingGuest.id, hostContext);
    expect(browserTabs.get(ordinary.tabId)?.attachedWebContents).toEqual([]);

    await manager.closeTab(sensitive.tabId);
    const reusedIdGuest = createGuestWebContents(closingGuest.id, undefined, {
      hostWebContents: hostContext.hostWebContents,
    });
    resolveWebContentsById.mockReturnValue(reusedIdGuest);
    attachWebviewFromHost(manager, ordinary.tabId, reusedIdGuest.id, hostContext);
    expect(browserTabs.get(ordinary.tabId)?.attachedWebContents).toEqual([reusedIdGuest]);
  });

  it("keeps a closing sensitive WebContents tombstoned until exact destruction", async () => {
    const cleanupSensitiveSessionPartition = vi
      .fn<(partition: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
      { cleanupSensitiveSessionPartition },
    );
    const hostContext = createManagerWithTab();
    manager.bindHost(hostContext.host as never);
    mainOwnedSensitiveHostOverride = hostContext.hostWebContents;
    const ownership = createSensitiveOwnership();
    const sensitive = await manager.createSensitiveIntegrationTab(
      { url: "https://pipedream.com/connect?app=gmail&token=private" },
      { awaitAttach: false },
      ownership,
    );
    const ordinary = await manager.createTab({}, { awaitAttach: false });
    const closingGuest = mainOwnedSensitiveViews[0]!.webContents;
    deferMainOwnedSensitiveClose = true;

    const closing = manager.closeTab(sensitive.tabId);
    await vi.waitFor(() => expect(closingGuest.close).toHaveBeenCalledOnce());
    expect(manager.snapshot().tabs.map((tab) => tab.tabId)).toEqual([ordinary.tabId]);
    expect(cleanupSensitiveSessionPartition).not.toHaveBeenCalled();

    resolveWebContentsById.mockReturnValue(closingGuest);
    attachWebviewFromHost(manager, ordinary.tabId, closingGuest.id, hostContext);
    expect(browserTabs.get(ordinary.tabId)?.attachedWebContents).toEqual([]);
    expect(cleanupSensitiveSessionPartition).not.toHaveBeenCalled();

    closingGuest.finishClose();
    await closing;
    expect(cleanupSensitiveSessionPartition).toHaveBeenCalledExactlyOnceWith(
      ownership.sessionPartition,
    );
  });

  it("denies delayed sensitive popups after close starts instead of declassifying them", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
      { cleanupSensitiveSessionPartition: async () => undefined },
    );
    const sensitive = await manager.createSensitiveIntegrationTab(
      { url: "https://pipedream.com/connect?app=gmail&token=private" },
      { awaitAttach: false },
      createSensitiveOwnership(),
    );
    const closingGuest = mainOwnedSensitiveViews[0]!.webContents;
    deferMainOwnedSensitiveClose = true;

    const closing = manager.closeTab(sensitive.tabId);
    await vi.waitFor(() => expect(closingGuest.close).toHaveBeenCalledOnce());
    browserTabs
      .get(sensitive.tabId)
      ?.emitPopup("https://accounts.example.test/oauth/popup-after-close");
    await Promise.resolve();

    expect(manager.snapshot().tabs).toEqual([]);
    expect(mainOwnedSensitiveViews).toHaveLength(1);
    closingGuest.finishClose();
    await closing;
  });

  it("keeps a reused WebContents id owned when an obsolete guest reports destruction", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const hostContext = createManagerWithTab();
    manager.bindHost(hostContext.host as never);
    const first = await manager.createTab({}, { awaitAttach: false });
    const second = await manager.createTab({}, { awaitAttach: false });
    const attemptedAlias = await manager.createTab({}, { awaitAttach: false });
    const obsoleteGuest = createGuestWebContents(101, undefined, {
      hostWebContents: hostContext.hostWebContents,
    });
    const replacementGuest = createGuestWebContents(202, undefined, {
      hostWebContents: hostContext.hostWebContents,
    });
    const reusedIdGuest = createGuestWebContents(101, undefined, {
      hostWebContents: hostContext.hostWebContents,
    });

    resolveWebContentsById.mockReturnValue(obsoleteGuest);
    attachWebviewFromHost(manager, first.tabId, obsoleteGuest.id, hostContext);
    const staleDestroyedListener = obsoleteGuest.once.mock.calls[0]?.[1];
    expect(staleDestroyedListener).toBeTypeOf("function");
    obsoleteGuest.emitDestroyed();

    resolveWebContentsById.mockReturnValue(replacementGuest);
    attachWebviewFromHost(manager, first.tabId, replacementGuest.id, hostContext);
    resolveWebContentsById.mockReturnValue(reusedIdGuest);
    attachWebviewFromHost(manager, second.tabId, reusedIdGuest.id, hostContext);
    obsoleteGuest.emitStaleDestroyed(staleDestroyedListener!);

    attachWebviewFromHost(manager, attemptedAlias.tabId, reusedIdGuest.id, hostContext);
    expect(browserTabs.get(first.tabId)?.attachedWebContents).toEqual([
      obsoleteGuest,
      replacementGuest,
    ]);
    expect(browserTabs.get(second.tabId)?.attachedWebContents).toEqual([reusedIdGuest]);
    expect(browserTabs.get(attemptedAlias.tabId)?.attachedWebContents).toEqual([]);
  });

  it("attaches one-shot proven replacements after delayed main-extracted guest destruction", async () => {
    let extracted = false;
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
      { isExtracted: () => extracted },
    );
    const main = createManagerWithTab(42);
    const extractedHost = createManagerWithTab(43);
    manager.bindHost(main.host as never);
    manager.bindHost(extractedHost.host as never);
    const tab = await manager.createTab({}, { awaitAttach: false });
    const mainGuest = createGuestWebContents(101, undefined, {
      hostWebContents: main.hostWebContents,
    });
    const extractedGuest = createGuestWebContents(202, undefined, {
      hostWebContents: extractedHost.hostWebContents,
    });
    const returnedMainGuest = createGuestWebContents(303, undefined, {
      hostWebContents: main.hostWebContents,
    });

    resolveWebContentsById.mockReturnValue(mainGuest);
    attachWebviewFromHost(manager, tab.tabId, mainGuest.id, main);
    extracted = true;
    manager.notifyState();
    resolveWebContentsById.mockReturnValue(extractedGuest);
    attachWebviewFromHost(manager, tab.tabId, extractedGuest.id, extractedHost);
    expect(browserTabs.get(tab.tabId)?.attachedWebContents).toEqual([mainGuest]);

    mainGuest.emitDestroyed();
    await vi.waitFor(() =>
      expect(browserTabs.get(tab.tabId)?.attachedWebContents).toEqual([mainGuest, extractedGuest]),
    );

    extracted = false;
    manager.notifyState();
    resolveWebContentsById.mockReturnValue(returnedMainGuest);
    attachWebviewFromHost(manager, tab.tabId, returnedMainGuest.id, main);
    expect(browserTabs.get(tab.tabId)?.attachedWebContents).toHaveLength(2);

    extractedGuest.emitDestroyed();
    await vi.waitFor(() =>
      expect(browserTabs.get(tab.tabId)?.attachedWebContents).toEqual([
        mainGuest,
        extractedGuest,
        returnedMainGuest,
      ]),
    );
    expect(
      (manager as unknown as { pendingGuestReplacementByTab: Map<string, unknown> })
        .pendingGuestReplacementByTab.size,
    ).toBe(0);
  });

  it("drops a queued guest replacement when its host document navigates before handoff", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const host = createManagerWithTab(42);
    manager.bindHost(host.host as never);
    const tab = await manager.createTab({}, { awaitAttach: false });
    const originalGuest = createGuestWebContents(101, undefined, {
      hostWebContents: host.hostWebContents,
    });
    const replacementGuest = createGuestWebContents(202, undefined, {
      hostWebContents: host.hostWebContents,
    });

    resolveWebContentsById.mockReturnValue(originalGuest);
    attachWebviewFromHost(manager, tab.tabId, originalGuest.id, host);
    resolveWebContentsById.mockReturnValue(replacementGuest);
    expect(
      manager.attachWebContents(tab.tabId, replacementGuest.id, host.hostWebContents.id, {
        ...host.hostWebContents.mainFrame,
      }),
    ).toBe(true);

    host.replaceMainFrame();
    originalGuest.emitDestroyed();

    await vi.waitFor(() =>
      expect(
        (manager as unknown as { pendingGuestReplacementByTab: Map<string, unknown> })
          .pendingGuestReplacementByTab.size,
      ).toBe(0),
    );
    expect(browserTabs.get(tab.tabId)?.attachedWebContents).toEqual([originalGuest]);
  });

  it("keeps automation active until every explicit session ends", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const activity: boolean[] = [];
    manager.addEventListener((event) => {
      if (event.type === "automation-active") activity.push(event.active);
    });

    expect(manager.setAutomationSession("thread-1", true)).toBe(false);
    expect(manager.setAutomationSession("thread-2", true)).toBe(false);
    expect(manager.setAutomationSession("thread-1", false)).toBe(false);
    expect(activity).toEqual([true]);

    expect(manager.setAutomationSession("thread-2", false)).toBe(true);
    expect(activity).toEqual([true, false]);
  });

  it("expires an abandoned explicit automation session instead of pinning guests forever", async () => {
    vi.useFakeTimers();
    const { AUTOMATION_SESSION_LEASE_MS, BrowserPanelManager } =
      await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const activity: boolean[] = [];
    manager.addEventListener((event) => {
      if (event.type === "automation-active") activity.push(event.active);
    });

    manager.setAutomationSession("abandoned-thread", true);
    expect(activity).toEqual([true]);

    await vi.advanceTimersByTimeAsync(AUTOMATION_SESSION_LEASE_MS);

    expect(activity).toEqual([true, false]);
    expect(
      (manager as unknown as { automationSessions: Map<string, unknown> }).automationSessions.size,
    ).toBe(0);
    manager.dispose();
  });

  it("refreshes and records a session target synchronously before attachment can wait", async () => {
    vi.useFakeTimers();
    const { AUTOMATION_SESSION_LEASE_MS, BrowserPanelManager } =
      await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const activity: boolean[] = [];
    manager.addEventListener((event) => {
      if (event.type === "automation-active") activity.push(event.active);
    });
    manager.setAutomationSession("thread-near-expiry", true);
    await vi.advanceTimersByTimeAsync(AUTOMATION_SESSION_LEASE_MS - 1);
    let resolveAttachment!: () => void;
    const tab = {
      tabId: "tab-waiting",
      isAttached: () => false,
      whenAttached: () =>
        new Promise<void>((resolve) => {
          resolveAttachment = resolve;
        }),
      destroy: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };
    (manager as unknown as { tabs: (typeof tab)[] }).tabs = [tab];

    manager.recordAutomationTarget("thread-near-expiry", tab.tabId);
    const readiness = manager.ensureTabReady(tab.tabId);
    await vi.advanceTimersByTimeAsync(2);

    expect(activity).toEqual([true]);
    expect(
      (
        manager as unknown as {
          automationSessions: Map<string, { tabIds: Set<string> }>;
        }
      ).automationSessions.get("thread-near-expiry")?.tabIds,
    ).toContain(tab.tabId);

    resolveAttachment();
    await readiness;
    manager.dispose();
  });

  it("clears the losing attachment timeout as soon as a tab becomes ready", async () => {
    vi.useFakeTimers();
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    manager.setAutomationSession("thread-ready", true);
    const timersBefore = vi.getTimerCount();
    const tab = {
      tabId: "tab-ready",
      isAttached: () => true,
      whenAttached: () => Promise.resolve(),
      destroy: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };
    (manager as unknown as { tabs: (typeof tab)[] }).tabs = [tab];

    await manager.ensureTabReady(tab.tabId);

    expect(vi.getTimerCount()).toBe(timersBefore);
    manager.dispose();
  });

  it("hides every session's touched cursor without disturbing another session's tab", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const sendA = vi.fn<() => Promise<unknown>>().mockResolvedValue({
      result: { type: "boolean", value: true },
    });
    const sendB = vi.fn<() => Promise<unknown>>().mockResolvedValue({
      result: { type: "boolean", value: true },
    });
    const makeTab = (tabId: string, send: typeof sendA) => ({
      tabId,
      isAttached: () => true,
      destroy: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      cdp: {
        attach: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
        send,
      },
    });
    (manager as unknown as { tabs: ReturnType<typeof makeTab>[] }).tabs = [
      makeTab("tab-a", sendA),
      makeTab("tab-b", sendB),
    ];
    manager.setAutomationSession("thread-a", true);
    manager.setAutomationSession("thread-b", true);
    await manager.showAutomationCursor("thread-a", "tab-a");
    await manager.showAutomationCursor("thread-b", "tab-b");
    sendA.mockClear();
    sendB.mockClear();

    expect(manager.setAutomationSession("thread-a", false)).toBe(false);
    await vi.waitFor(() => expect(sendA).toHaveBeenCalled());
    expect(sendB).not.toHaveBeenCalled();

    expect(manager.setAutomationSession("thread-b", false)).toBe(true);
    await vi.waitFor(() => expect(sendB).toHaveBeenCalled());
    manager.dispose();
  });

  it("keeps a shared tab cursor owned until the final launch lease releases it", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const send = vi.fn<() => Promise<unknown>>().mockResolvedValue({
      result: { type: "boolean", value: true },
    });
    const tab = {
      tabId: "tab-shared",
      isAttached: () => true,
      destroy: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      cdp: {
        attach: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
        send,
      },
    };
    (manager as unknown as { tabs: (typeof tab)[] }).tabs = [tab];
    manager.setAutomationSession("launch:a", true);
    manager.setAutomationSession("launch:b", true);
    await manager.showAutomationCursor("launch:a", tab.tabId);
    await manager.showAutomationCursor("launch:b", tab.tabId);
    send.mockClear();

    expect(manager.setAutomationSession("launch:a", false)).toBe(false);
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();

    expect(manager.setAutomationSession("launch:b", false)).toBe(true);
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    manager.dispose();
  });

  it("asks the renderer to promote a suspended page before awaiting attachment", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const tab = {
      tabId: "tab-suspended",
      isAttached: () => false,
      whenAttached: () => Promise.resolve(),
    };
    (manager as unknown as { tabs: (typeof tab)[] }).tabs = [tab];
    const events: unknown[] = [];
    manager.addEventListener((event) => events.push(event));

    await manager.ensureTabReady(tab.tabId);

    expect(events).toContainEqual({
      type: "ensure-browser-page-resident",
      tabId: tab.tabId,
    });
  });

  it("refreshes residency and awaits target readiness for an already-attached page", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const tab = {
      tabId: "tab-resident",
      isAttached: () => true,
      whenAttached: vi.fn<() => Promise<void>>(),
    };
    (manager as unknown as { tabs: (typeof tab)[] }).tabs = [tab];
    const events: unknown[] = [];
    manager.addEventListener((event) => events.push(event));

    await manager.ensureTabReady(tab.tabId);

    expect(events).toContainEqual({
      type: "ensure-browser-page-resident",
      tabId: tab.tabId,
    });
    expect(tab.whenAttached).toHaveBeenCalledOnce();
  });

  it("presents the exact ordinary automation target without changing its sibling tabs", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const host = createManagerWithTab(42);
    manager.bindHost(host.host as never);
    const first = createFakeTab("tab-first");
    const target = createFakeTab("tab-target");
    const sibling = createFakeTab("tab-sibling");
    (manager as unknown as { tabs: ReturnType<typeof createFakeTab>[] }).tabs = [
      first,
      target,
      sibling,
    ];
    (manager as unknown as { activeTabId: string }).activeTabId = first.tabId;
    const originalTabs = manager.snapshot().tabs;
    const events: BrowserEvent[] = [];
    manager.addEventListener((event) => events.push(event));

    const presentation = manager.presentAutomationTarget(target.tabId);
    const request = events.find(
      (event): event is Extract<BrowserEvent, { type: "automation-presentation-request" }> =>
        event.type === "automation-presentation-request",
    );
    expect(request).toMatchObject({
      type: "automation-presentation-request",
      tabId: target.tabId,
      surface: "main",
    });
    expect(
      acknowledgePresentationFromHost(
        manager,
        {
          requestId: request!.requestId,
          tabId: target.tabId,
          surface: "main",
          presented: true,
        },
        host,
      ),
    ).toBe(true);
    await expect(presentation).resolves.toMatchObject({
      requestId: request!.requestId,
      tabId: target.tabId,
      surface: "main",
    });

    expect(manager.snapshot()).toMatchObject({
      activeTabId: target.tabId,
      tabs: originalTabs,
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: "state",
        state: expect.objectContaining({ activeTabId: target.tabId, tabs: originalTabs }),
      }),
      { type: "open-panel", mode: "panel" },
      {
        type: "automation-presentation-request",
        requestId: expect.any(String),
        tabId: target.tabId,
        surface: "main",
      },
    ]);
    manager.dispose();
  });

  it("fails closed without selecting or revealing missing and sensitive automation targets", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const ordinary = createFakeTab("tab-ordinary");
    const sensitive = createFakeTab("tab-sensitive");
    (manager as unknown as { tabs: ReturnType<typeof createFakeTab>[] }).tabs = [
      ordinary,
      sensitive,
    ];
    (manager as unknown as { activeTabId: string }).activeTabId = ordinary.tabId;
    const sensitiveOwnership = createSensitiveOwnership();
    (
      manager as unknown as {
        sensitiveIntegrationTabs: Map<
          string,
          {
            privateResumeUrl: string;
            ownership: ReturnType<typeof createSensitiveOwnership>;
            sessionPartition: string;
            partitionLease: {
              ownership: ReturnType<typeof createSensitiveOwnership>;
              partition: string;
              released: boolean;
            };
          }
        >;
      }
    ).sensitiveIntegrationTabs.set(sensitive.tabId, {
      privateResumeUrl: "https://connect.example.test/private",
      ownership: sensitiveOwnership,
      sessionPartition: sensitiveOwnership.sessionPartition,
      partitionLease: {
        ownership: sensitiveOwnership,
        partition: sensitiveOwnership.sessionPartition,
        released: true,
      },
    });
    const events: unknown[] = [];
    manager.addEventListener((event) => events.push(event));

    await expect(manager.presentAutomationTarget("tab-missing")).resolves.toBeNull();
    await expect(manager.presentAutomationTarget(sensitive.tabId)).resolves.toBeNull();

    expect(manager.snapshot().activeTabId).toBe(ordinary.tabId);
    expect(events).toEqual([]);
    manager.dispose();
  });

  it("rejects mismatched and replayed presentation acknowledgements", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const host = createManagerWithTab(42);
    manager.bindHost(host.host as never);
    const target = createFakeTab("tab-target");
    (manager as unknown as { tabs: ReturnType<typeof createFakeTab>[] }).tabs = [target];
    (manager as unknown as { activeTabId: string }).activeTabId = target.tabId;
    let request: Extract<BrowserEvent, { type: "automation-presentation-request" }> | undefined;
    manager.addEventListener((event) => {
      if (event.type === "automation-presentation-request") request = event;
    });

    const presentation = manager.presentAutomationTarget(target.tabId);
    const mismatched = {
      requestId: request!.requestId,
      tabId: target.tabId,
      surface: "extracted" as const,
      presented: true,
    };
    expect(acknowledgePresentationFromHost(manager, mismatched, host)).toBe(false);
    await expect(presentation).resolves.toBeNull();
    expect(
      acknowledgePresentationFromHost(
        manager,
        {
          ...mismatched,
          surface: "main",
        },
        host,
      ),
    ).toBe(false);
    manager.dispose();
  });

  it("times out closed when no renderer confirms compositor presentation", async () => {
    vi.useFakeTimers();
    const { AUTOMATION_PRESENTATION_TIMEOUT_MS, BrowserPanelManager } =
      await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const target = createFakeTab("tab-target");
    (manager as unknown as { tabs: ReturnType<typeof createFakeTab>[] }).tabs = [target];
    (manager as unknown as { activeTabId: string }).activeTabId = target.tabId;

    const presentation = manager.presentAutomationTarget(target.tabId);
    await vi.advanceTimersByTimeAsync(AUTOMATION_PRESENTATION_TIMEOUT_MS);

    await expect(presentation).resolves.toBeNull();
    manager.dispose();
  });

  it("routes presentation acknowledgement exclusively through the extracted surface", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const focusExtractedWindow = vi.fn<() => void>();
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
      {
        isExtracted: () => true,
        focusExtractedWindow,
      },
    );
    const mainHost = createManagerWithTab(42);
    const extractedHost = createManagerWithTab(43);
    manager.bindHost(mainHost.host as never);
    manager.bindHost(extractedHost.host as never);
    const target = createFakeTab("tab-target");
    (manager as unknown as { tabs: ReturnType<typeof createFakeTab>[] }).tabs = [target];
    (manager as unknown as { activeTabId: string }).activeTabId = target.tabId;
    const events: BrowserEvent[] = [];
    manager.addEventListener((event) => events.push(event));

    const presentation = manager.presentAutomationTarget(target.tabId);
    const request = events.find(
      (event): event is Extract<BrowserEvent, { type: "automation-presentation-request" }> =>
        event.type === "automation-presentation-request",
    );
    expect(focusExtractedWindow).toHaveBeenCalledOnce();
    expect(events).not.toContainEqual(expect.objectContaining({ type: "open-panel" }));
    expect(request).toMatchObject({ tabId: target.tabId, surface: "extracted" });
    const acknowledgement = {
      requestId: request!.requestId,
      tabId: target.tabId,
      surface: "extracted" as const,
      presented: true,
    };
    expect(acknowledgePresentationFromHost(manager, acknowledgement, mainHost)).toBe(false);
    expect(
      manager.acknowledgeAutomationPresentation(acknowledgement, extractedHost.hostWebContents.id, {
        processId: extractedHost.hostWebContents.mainFrame.processId,
        routingId: extractedHost.hostWebContents.mainFrame.routingId + 1,
      }),
    ).toBe(false);
    expect(
      manager.acknowledgeAutomationPresentation(acknowledgement, extractedHost.hostWebContents.id, {
        ...extractedHost.hostWebContents.mainFrame,
      }),
    ).toBe(true);
    expect(acknowledgePresentationFromHost(manager, acknowledgement, extractedHost)).toBe(false);

    const lease = await presentation;
    expect(lease).toMatchObject({
      requestId: request!.requestId,
      tabId: target.tabId,
      surface: "extracted",
    });
    expect(manager.validateAutomationPresentation(lease!)).toBe(true);
    const invalidation = {
      requestId: lease!.requestId,
      tabId: target.tabId,
      surface: "extracted" as const,
      reason: "obstructed" as const,
    };
    expect(invalidatePresentationFromHost(manager, invalidation, mainHost)).toBe(false);
    expect(
      manager.invalidateAutomationPresentation(invalidation, extractedHost.hostWebContents.id, {
        processId: extractedHost.hostWebContents.mainFrame.processId,
        routingId: extractedHost.hostWebContents.mainFrame.routingId + 1,
      }),
    ).toBe(false);
    expect(manager.validateAutomationPresentation(lease!)).toBe(true);
    expect(
      manager.invalidateAutomationPresentation(invalidation, extractedHost.hostWebContents.id, {
        ...extractedHost.hostWebContents.mainFrame,
      }),
    ).toBe(true);
    expect(invalidatePresentationFromHost(manager, invalidation, extractedHost)).toBe(false);
    expect(manager.validateAutomationPresentation(lease!)).toBe(false);
    manager.dispose();
  });

  it("revokes ordinary input presentation across host reload and crash epochs", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const host = createManagerWithTab(42);
    manager.bindHost(host.host as never);
    const target = createFakeTab("tab-target");
    (manager as unknown as { tabs: ReturnType<typeof createFakeTab>[] }).tabs = [target];
    (manager as unknown as { activeTabId: string }).activeTabId = target.tabId;
    let request: Extract<BrowserEvent, { type: "automation-presentation-request" }> | undefined;
    manager.addEventListener((event) => {
      if (event.type === "automation-presentation-request") request = event;
    });
    const obtainLease = async () => {
      const presentation = manager.presentAutomationTarget(target.tabId);
      expect(
        acknowledgePresentationFromHost(
          manager,
          {
            requestId: request!.requestId,
            tabId: target.tabId,
            surface: "main",
            presented: true,
          },
          host,
        ),
      ).toBe(true);
      return await presentation;
    };

    const beforeReload = await obtainLease();
    expect(manager.validateAutomationPresentation(beforeReload!)).toBe(true);

    host.emitWebContentsEvent("did-start-loading");
    expect(manager.validateAutomationPresentation(beforeReload!)).toBe(false);
    host.emitWebContentsEvent("did-stop-loading");
    expect(manager.validateAutomationPresentation(beforeReload!)).toBe(false);

    const afterReload = await obtainLease();
    expect(manager.validateAutomationPresentation(afterReload!)).toBe(true);

    host.emitWebContentsEvent("render-process-gone");
    expect(manager.validateAutomationPresentation(afterReload!)).toBe(false);
    host.emitWebContentsEvent("did-finish-load");

    const rejectedAfterStaleFinish = manager.presentAutomationTarget(target.tabId);
    expect(
      acknowledgePresentationFromHost(
        manager,
        {
          requestId: request!.requestId,
          tabId: target.tabId,
          surface: "main",
          presented: true,
        },
        host,
      ),
    ).toBe(false);
    host.emitWebContentsEvent("did-start-loading");
    host.emitWebContentsEvent("did-finish-load");
    await expect(rejectedAfterStaleFinish).resolves.toBeNull();

    const beforeClose = await obtainLease();
    expect(manager.validateAutomationPresentation(beforeClose!)).toBe(true);
    host.emitClosed();
    expect(manager.validateAutomationPresentation(beforeClose!)).toBe(false);
    manager.dispose();
  });

  it("revokes a presentation lease after an active-tab A-B-A switch", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const host = createManagerWithTab(42);
    manager.bindHost(host.host as never);
    const target = createFakeTab("tab-target");
    const sibling = createFakeTab("tab-sibling");
    (manager as unknown as { tabs: ReturnType<typeof createFakeTab>[] }).tabs = [target, sibling];
    (manager as unknown as { activeTabId: string }).activeTabId = target.tabId;
    let request: Extract<BrowserEvent, { type: "automation-presentation-request" }> | undefined;
    manager.addEventListener((event) => {
      if (event.type === "automation-presentation-request") request = event;
    });

    const presentation = manager.presentAutomationTarget(target.tabId);
    expect(
      acknowledgePresentationFromHost(
        manager,
        {
          requestId: request!.requestId,
          tabId: target.tabId,
          surface: "main",
          presented: true,
        },
        host,
      ),
    ).toBe(true);
    const lease = await presentation;
    expect(lease).not.toBeNull();
    expect(manager.validateAutomationPresentation(lease!)).toBe(true);

    manager.setActiveTab(sibling.tabId);
    manager.setActiveTab(target.tabId);

    expect(manager.validateAutomationPresentation(lease!)).toBe(false);
    manager.dispose();
  });

  it("revokes a presentation lease after the Browser surface changes main-extracted-main", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    let extracted = false;
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
      {
        isExtracted: () => extracted,
      },
    );
    const host = createManagerWithTab(42);
    manager.bindHost(host.host as never);
    const target = createFakeTab("tab-target");
    (manager as unknown as { tabs: ReturnType<typeof createFakeTab>[] }).tabs = [target];
    (manager as unknown as { activeTabId: string }).activeTabId = target.tabId;
    let request: Extract<BrowserEvent, { type: "automation-presentation-request" }> | undefined;
    manager.addEventListener((event) => {
      if (event.type === "automation-presentation-request") request = event;
    });

    const presentation = manager.presentAutomationTarget(target.tabId);
    expect(
      acknowledgePresentationFromHost(
        manager,
        {
          requestId: request!.requestId,
          tabId: target.tabId,
          surface: "main",
          presented: true,
        },
        host,
      ),
    ).toBe(true);
    const lease = await presentation;
    expect(lease).not.toBeNull();
    expect(manager.validateAutomationPresentation(lease!)).toBe(true);

    extracted = true;
    manager.notifyState();
    extracted = false;
    manager.notifyState();

    expect(manager.validateAutomationPresentation(lease!)).toBe(false);
    manager.dispose();
  });

  it("authorizes exact CDP input without treating desktop focus as target authority", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const host = createManagerWithTab(42);
    manager.bindHost(host.host as never);
    const target = createFakeTab("tab-target");
    (manager as unknown as { tabs: ReturnType<typeof createFakeTab>[] }).tabs = [target];
    (manager as unknown as { activeTabId: string }).activeTabId = target.tabId;
    let request: Extract<BrowserEvent, { type: "automation-presentation-request" }> | undefined;
    manager.addEventListener((event) => {
      if (event.type === "automation-presentation-request") request = event;
    });

    const presentation = manager.presentAutomationTarget(target.tabId);
    expect(
      acknowledgePresentationFromHost(
        manager,
        {
          requestId: request!.requestId,
          tabId: target.tabId,
          surface: "main",
          presented: true,
        },
        host,
      ),
    ).toBe(true);
    const lease = await presentation;
    expect(lease).not.toBeNull();
    expect(manager.validateAutomationPresentation(lease!)).toBe(true);

    // Structural renderer obstruction, unlike OS focus churn, still revokes.
    invalidatePresentationFromHost(
      manager,
      {
        requestId: lease!.requestId,
        tabId: target.tabId,
        surface: "main",
        reason: "obstructed",
      },
      host,
    );
    expect(manager.validateAutomationPresentation(lease!)).toBe(false);
    manager.dispose();
  });

  it("bounds ordinary tab metadata even when older pages are suspended", async () => {
    const { BrowserPanelManager, MAX_BROWSER_TABS } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    (manager as unknown as { tabs: ReturnType<typeof createFakeTab>[] }).tabs = Array.from(
      { length: MAX_BROWSER_TABS },
      (_, index) => createFakeTab(`tab-${index}`),
    );

    await expect(
      manager.createTab({ url: "https://over-limit.test" }, { awaitAttach: false }),
    ).rejects.toThrow(`Browser tab limit reached (${MAX_BROWSER_TABS})`);
  });

  it("bounds pinned sensitive guests so abandoned auth flows cannot leak webviews", async () => {
    const { BrowserPanelManager, MAX_SENSITIVE_BROWSER_TABS } =
      await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    for (let index = 0; index < MAX_SENSITIVE_BROWSER_TABS; index += 1) {
      await manager.createSensitiveIntegrationTab(
        { url: `https://connect.example.test/${index}`, activate: false },
        { awaitAttach: false },
        createSensitiveOwnership(),
      );
    }

    await expect(
      manager.createSensitiveIntegrationTab(
        { url: "https://connect.example.test/over-limit", activate: false },
        { awaitAttach: false },
        createSensitiveOwnership(),
      ),
    ).rejects.toThrow(`Sensitive browser tab limit reached (${MAX_SENSITIVE_BROWSER_TABS})`);
    manager.dispose();
  });

  it("keeps an independent implicit active tab for each trusted agent thread", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const threadA = {
      id: "group-thread-thread-a",
      title: "Thread A",
      color: "blue",
      collapsed: false,
      threadId: "thread-a",
    } satisfies BrowserTabGroupInfo;
    const threadB = {
      id: "group-thread-thread-b",
      title: "Thread B",
      color: "green",
      collapsed: false,
      threadId: "thread-b",
    } satisfies BrowserTabGroupInfo;
    seedGroupState(
      manager,
      [createFakeTab("tab-a"), createFakeTab("tab-b"), createFakeTab("tab-a-2")],
      [threadA, threadB],
      [
        ["tab-a", threadA.id],
        ["tab-b", threadB.id],
        ["tab-a-2", threadA.id],
      ],
    );
    (manager as unknown as { activeTabId: string }).activeTabId = "tab-b";

    expect(manager.getActiveTabForThread("thread-a")?.tabId).toBe("tab-a-2");
    expect(manager.getActiveTabForThread("thread-b")?.tabId).toBe("tab-b");

    expect(manager.rememberTabForThread("thread-a", "tab-a")).toBe(true);
    manager.setActiveTab("tab-b");
    expect(manager.getActiveTabForThread("thread-a")?.tabId).toBe("tab-a");
    expect(manager.getActiveTab()?.tabId).toBe("tab-b");
  });

  it("bounds remembered agent targets across abandoned thread identities", async () => {
    const { BrowserPanelManager, MAX_REMEMBERED_AGENT_TARGETS } =
      await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const tab = createFakeTab("tab-shared");
    (manager as unknown as { tabs: (typeof tab)[] }).tabs = [tab];

    for (let index = 0; index < MAX_REMEMBERED_AGENT_TARGETS + 12; index += 1) {
      expect(manager.rememberTabForThread(`thread-${index}`, tab.tabId)).toBe(true);
    }

    expect(
      (manager as unknown as { activeAgentTabByThread: Map<string, string> }).activeAgentTabByThread
        .size,
    ).toBe(MAX_REMEMBERED_AGENT_TARGETS);
  });

  it("moves ungrouped tabs into the target tab's group", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const group = {
      id: "group-agent",
      title: "Poracode",
      color: "purple",
      collapsed: false,
    } satisfies BrowserTabGroupInfo;

    seedGroupState(
      manager,
      [createFakeTab("tab-free"), createFakeTab("tab-a"), createFakeTab("tab-b")],
      [group],
      [
        ["tab-a", group.id],
        ["tab-b", group.id],
      ],
    );

    manager.moveTab("tab-free", "tab-a", "after");

    const state = manager.snapshot();
    expect(state.tabs.map((t) => t.tabId)).toEqual(["tab-a", "tab-free", "tab-b"]);
    expect(state.tabs.find((t) => t.tabId === "tab-free")?.groupId).toBe(group.id);
  });

  it("removes a tab from its group when moved beside an ungrouped tab", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const group = {
      id: "group-agent",
      title: "Poracode",
      color: "purple",
      collapsed: false,
    } satisfies BrowserTabGroupInfo;

    seedGroupState(
      manager,
      [createFakeTab("tab-a"), createFakeTab("tab-free")],
      [group],
      [["tab-a", group.id]],
    );

    manager.moveTab("tab-a", "tab-free", "after");

    const state = manager.snapshot();
    expect(state.tabs.map((t) => t.tabId)).toEqual(["tab-free", "tab-a"]);
    expect(state.tabs.find((t) => t.tabId === "tab-a")?.groupId).toBeUndefined();
    expect(state.groups).toEqual([]);
  });

  it("selects the nearest visible tab when collapsing the active tab's group", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const group = {
      id: "group-agent",
      title: "Y Space",
      color: "purple",
      collapsed: false,
    } satisfies BrowserTabGroupInfo;
    seedGroupState(
      manager,
      [
        createFakeTab("tab-before"),
        createFakeTab("tab-group-1"),
        createFakeTab("tab-group-2"),
        createFakeTab("tab-after"),
      ],
      [group],
      [
        ["tab-group-1", group.id],
        ["tab-group-2", group.id],
      ],
    );
    (manager as unknown as { activeTabId: string }).activeTabId = "tab-group-1";

    manager.setGroupCollapsed(group.id, true);

    expect(manager.snapshot().activeTabId).toBe("tab-after");
  });

  it("clears the active tab when collapsing the only visible group", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const group = {
      id: "group-agent",
      title: "Y Space",
      color: "purple",
      collapsed: false,
    } satisfies BrowserTabGroupInfo;
    seedGroupState(
      manager,
      [createFakeTab("tab-group-1"), createFakeTab("tab-group-2")],
      [group],
      [
        ["tab-group-1", group.id],
        ["tab-group-2", group.id],
      ],
    );
    (manager as unknown as { activeTabId: string }).activeTabId = "tab-group-2";

    manager.setGroupCollapsed(group.id, true);

    expect(manager.snapshot().activeTabId).toBeNull();
  });

  it("keeps every HTTP(S) link inside Y Space even when legacy settings request the system browser", async () => {
    const { readSharedSettingsFile } = await import("../sharedSettingsFile");
    vi.mocked(readSharedSettingsFile).mockReturnValue({
      browser: { linkOpenTarget: "system", linkPresentationMode: "panel" },
    } as never);
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );

    await expect(manager.openLink("https://example.test/path")).resolves.toBe(true);

    expect(shellOpenExternal).not.toHaveBeenCalled();
    expect(manager.snapshot().tabs).toHaveLength(1);
    expect(manager.snapshot().tabs[0]?.url).toBe("https://example.test/path");
  });

  it("does not classify ordinary links as sensitive from generic query parameter names", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const ordinaryUrl = "https://example.test/search?state=California&code=SPRING";

    await expect(manager.openLink(ordinaryUrl)).resolves.toBe(true);

    const created = manager.snapshot().tabs[0];
    expect(created?.url).toBe(ordinaryUrl);
    expect(created && manager.getTab(created.tabId)).not.toBeNull();
  });

  it("flushes the newest tab state when disposed before the persistence debounce", async () => {
    vi.useFakeTimers();
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );

    await manager.createTab(
      { url: "https://persist.test/path", activate: true },
      { awaitAttach: false },
    );
    expect(dbSetState).not.toHaveBeenCalled();

    manager.dispose();

    expect(dbSetState).toHaveBeenCalledTimes(1);
    expect(JSON.parse(dbSetState.mock.calls[0]?.[1] ?? "{}")).toMatchObject({
      tabs: [{ url: "https://persist.test/path" }],
      activeIndex: 0,
    });
  });

  it("restores saved titles before dormant tabs remount", async () => {
    dbGetState.mockReturnValue(
      JSON.stringify({
        tabs: [{ url: "https://persist.test/path", title: "Saved page title" }],
        activeIndex: 0,
      }),
    );
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const { host } = createManagerWithTab();

    manager.bindHost(host as never);
    await vi.waitFor(() => {
      expect(manager.snapshot().tabs).toHaveLength(1);
    });

    expect(manager.snapshot().tabs[0]).toMatchObject({
      url: "https://persist.test/path",
      title: "Saved page title",
    });
  });

  it("drops blocked persisted URLs before projecting global browser tabs", async () => {
    dbGetState.mockReturnValue(
      JSON.stringify({
        tabs: [
          { url: "file:///etc/passwd", title: "Blocked local file" },
          { url: "https://persist.test/safe", title: "Safe page" },
        ],
        activeIndex: 1,
      }),
    );
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const { host } = createManagerWithTab();

    manager.bindHost(host as never);
    await vi.waitFor(() => {
      expect(manager.snapshot().tabs).toHaveLength(1);
    });

    expect(manager.snapshot().tabs[0]).toMatchObject({
      url: "https://persist.test/safe",
      title: "Safe page",
    });
    expect(JSON.stringify(manager.snapshot())).not.toContain("etc/passwd");
    manager.dispose();
  });

  it("keeps an explicitly sensitive integration tab redacted and agent-inaccessible for its full lifetime", async () => {
    vi.useFakeTimers();
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const events: unknown[] = [];
    manager.addEventListener((event) => events.push(event));
    const privateUrl =
      "https://pipedream.com/_static/connect.html?token=connect-token-private&connectLink=true&app=slack";

    const created = await manager.createSensitiveIntegrationTab(
      { url: privateUrl, activate: true, reveal: true },
      { awaitAttach: false },
      createSensitiveOwnership(),
    );
    await vi.runAllTimersAsync();

    expect(JSON.stringify(events)).not.toContain("connect-token-private");
    expect(created.url).not.toContain("connect-token-private");
    expect(JSON.stringify(dbSetState.mock.calls)).not.toContain("connect-token-private");
    expect(manager.hasSensitiveIntegrationTab(created.tabId)).toBe(true);
    expect(manager.getTab(created.tabId)).toBeNull();
    expect(manager.getActiveTab()).toBeNull();

    browserTabs.get(created.tabId)?.emitUrl("https://pipedream.com/connected", "Connected");
    await vi.runAllTimersAsync();

    expect(manager.snapshot().tabs[0]).toMatchObject({
      tabId: created.tabId,
      url: "about:blank",
      title: "",
      sensitiveIntegration: true,
    });
    expect(manager.getTab(created.tabId)).toBeNull();
    expect(manager.getActiveTab()).toBeNull();
    expect(browserTabs.get(created.tabId)?.clearHistory).not.toHaveBeenCalled();
    expect(JSON.stringify(events)).not.toContain("https://pipedream.com/connected");
    expect(JSON.stringify(events)).not.toContain("connect-token-private");
    expect(JSON.stringify(dbSetState.mock.calls)).not.toContain("connect-token-private");

    await manager.closeTab(created.tabId);
    await vi.runAllTimersAsync();
    expect(manager.hasSensitiveIntegrationTab(created.tabId)).toBe(false);
    expect(manager.snapshot().tabs).toEqual([]);
    expect(JSON.stringify(dbSetState.mock.calls)).not.toContain("https://pipedream.com/connected");
  });

  it("removes only a failed sensitive tab when an ordinary tab completes concurrently", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const cleanupSensitiveSessionPartition = vi
      .fn<(partition: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
      { cleanupSensitiveSessionPartition },
    );
    const events: BrowserEvent[] = [];
    manager.addEventListener((event) => events.push(event));
    const onTabOpened = vi.fn<(tabId: string) => void>();
    const onTabClosed = vi.fn<(tabId: string) => void>();
    const ownership = createSensitiveOwnership({ onTabOpened, onTabClosed });
    const privateUrl =
      "https://pipedream.com/_static/connect.html?token=private-race-secret&connectLink=true";
    let rejectSensitiveLoad!: (reason?: unknown) => void;
    deferredSensitiveLoads.push({
      promise: new Promise<void>((_resolve, reject) => {
        rejectSensitiveLoad = reject;
      }),
    });

    const sensitiveCreation = manager.createSensitiveIntegrationTab(
      { url: privateUrl, activate: true },
      { awaitAttach: false },
      ownership,
    );
    await vi.waitFor(() => {
      expect(mainOwnedSensitiveViews).toHaveLength(1);
      expect([...browserTabs.values()].some((tab) => tab.loadUrls.includes(privateUrl))).toBe(true);
    });

    const ordinary = await manager.createTab(
      { url: "https://ordinary.test/", activate: true },
      { awaitAttach: false },
    );
    const failedCreation = sensitiveCreation.catch((error: unknown) => error);
    rejectSensitiveLoad(new Error("private navigation failed"));
    await expect(failedCreation).resolves.toEqual(
      expect.objectContaining({
        message: expect.stringMatching(/register sensitive integration tab/i),
      }),
    );

    expect(manager.snapshot().tabs).toEqual([
      expect.objectContaining({ tabId: ordinary.tabId, url: "https://ordinary.test/" }),
    ]);
    expect(manager.snapshot().activeTabId).toBe(ordinary.tabId);
    expect(browserTabs.has(ordinary.tabId)).toBe(true);
    expect(browserTabs.size).toBe(1);
    expect(mainOwnedSensitiveViews[0]?.webContents.close).toHaveBeenCalledOnce();
    expect(onTabOpened).toHaveBeenCalledOnce();
    expect(onTabClosed).toHaveBeenCalledExactlyOnceWith(onTabOpened.mock.calls[0]![0]);
    await vi.waitFor(() =>
      expect(cleanupSensitiveSessionPartition).toHaveBeenCalledExactlyOnceWith(
        ownership.sessionPartition,
      ),
    );
    const finalStateEvent = events.filter((event) => event.type === "state").at(-1);
    expect(finalStateEvent).toMatchObject({
      type: "state",
      state: {
        activeTabId: ordinary.tabId,
        tabs: [{ tabId: ordinary.tabId, url: "https://ordinary.test/" }],
      },
    });
    expect(JSON.stringify(events)).not.toContain("private-race-secret");
  });

  it("rejects missing, malformed, and persistent sensitive session ownership", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const cleanupSensitiveSessionPartition = vi.fn<(partition: string) => Promise<void>>();
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
      { cleanupSensitiveSessionPartition },
    );
    const payload = { url: "https://pipedream.com/connect?app=gmail&token=private" };
    const opts = { awaitAttach: false };

    await expect(manager.createSensitiveIntegrationTab(payload, opts)).rejects.toThrow(
      /ownership|partition/i,
    );
    await expect(
      manager.createSensitiveIntegrationTab(
        payload,
        opts,
        createSensitiveOwnership({ sessionPartition: "persist:pipedream-oauth-private" }),
      ),
    ).rejects.toThrow(/partition/i);
    await expect(
      manager.createSensitiveIntegrationTab(
        payload,
        opts,
        createSensitiveOwnership({ sessionPartition: "pipedream-oauth-unsafe/value" }),
      ),
    ).rejects.toThrow(/partition/i);

    expect(cleanupSensitiveSessionPartition).not.toHaveBeenCalled();
    expect(manager.snapshot().tabs).toEqual([]);
  });

  it("keeps ordinary tabs separate without projecting distinct private partitions", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const ordinary = await manager.createTab(
      { url: "https://ordinary.example/" },
      { awaitAttach: false },
    );
    const firstOwnership = createSensitiveOwnership();
    const secondOwnership = createSensitiveOwnership();
    const first = await manager.createSensitiveIntegrationTab(
      { url: "https://pipedream.com/connect?app=gmail&token=first" },
      { awaitAttach: false },
      firstOwnership,
    );
    const second = await manager.createSensitiveIntegrationTab(
      { url: "https://pipedream.com/connect?app=slack&token=second" },
      { awaitAttach: false },
      secondOwnership,
    );

    const byId = new Map(manager.snapshot().tabs.map((tab) => [tab.tabId, tab]));
    expect(byId.get(ordinary.tabId)).not.toHaveProperty("sensitiveSessionPartition");
    expect(byId.get(first.tabId)).toMatchObject({ sensitiveIntegration: true });
    expect(byId.get(first.tabId)).not.toHaveProperty("sensitiveSessionPartition");
    expect(byId.get(second.tabId)).toMatchObject({ sensitiveIntegration: true });
    expect(byId.get(second.tabId)).not.toHaveProperty("sensitiveSessionPartition");
    expect(firstOwnership.sessionPartition).not.toBe(secondOwnership.sessionPartition);
    expect(mainOwnedSensitiveViews.map((view) => view.webContents.session)).toEqual([
      electronSessionFromPartition(firstOwnership.sessionPartition),
      electronSessionFromPartition(secondOwnership.sessionPartition),
    ]);
    manager.dispose();
  });

  it("cleans a shared sensitive partition only after its final descendant closes", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const cleanupSensitiveSessionPartition = vi
      .fn<(partition: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
      { cleanupSensitiveSessionPartition },
    );
    const opened: string[] = [];
    const ownership = createSensitiveOwnership({ onTabOpened: (tabId) => opened.push(tabId) });
    const root = await manager.createSensitiveIntegrationTab(
      { url: "https://pipedream.com/connect?app=gmail&token=root" },
      { awaitAttach: false },
      ownership,
    );
    browserTabs.get(root.tabId)?.emitPopup("https://accounts.google.com/o/oauth2/auth?token=popup");
    await vi.waitFor(() => expect(opened).toHaveLength(2));
    const popupTabId = opened[1]!;

    expect(JSON.stringify(manager.snapshot())).not.toContain(ownership.sessionPartition);
    expect(mainOwnedSensitiveViews.map((view) => view.webContents.session)).toEqual([
      electronSessionFromPartition(ownership.sessionPartition),
      electronSessionFromPartition(ownership.sessionPartition),
    ]);
    await manager.closeTab(popupTabId);
    expect(cleanupSensitiveSessionPartition).not.toHaveBeenCalled();

    await manager.closeTab(root.tabId);
    await vi.waitFor(() =>
      expect(cleanupSensitiveSessionPartition).toHaveBeenCalledExactlyOnceWith(
        ownership.sessionPartition,
      ),
    );
  });

  it("never reuses a sensitive partition after its final guest closes", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const cleanupSensitiveSessionPartition = vi
      .fn<(partition: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
      { cleanupSensitiveSessionPartition },
    );
    const ownership = createSensitiveOwnership();
    const first = await manager.createSensitiveIntegrationTab(
      { url: "https://pipedream.com/connect?app=gmail&token=first" },
      { awaitAttach: false },
      ownership,
    );
    await manager.closeTab(first.tabId);

    await expect(
      manager.createSensitiveIntegrationTab(
        { url: "https://pipedream.com/connect?app=gmail&token=reused" },
        { awaitAttach: false },
        ownership,
      ),
    ).rejects.toThrow(/reuse/i);
    expect(cleanupSensitiveSessionPartition).toHaveBeenCalledExactlyOnceWith(
      ownership.sessionPartition,
    );
  });

  it("blocks cross-ownership partition reuse until exact cleanup completes", async () => {
    let finishCleanup!: () => void;
    let cleanupCall = 0;
    const cleanupSensitiveSessionPartition = vi.fn<() => Promise<void>>(() => {
      cleanupCall += 1;
      if (cleanupCall > 1) return Promise.resolve();
      return new Promise<void>((resolve) => {
        finishCleanup = resolve;
      });
    });
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
      { cleanupSensitiveSessionPartition },
    );
    const partition = "pipedream-oauth-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const firstOwnership = createSensitiveOwnership({ sessionPartition: partition });
    const first = await manager.createSensitiveIntegrationTab(
      { url: "https://pipedream.com/connect?app=gmail&token=first" },
      { awaitAttach: false },
      firstOwnership,
    );
    const closing = manager.closeTab(first.tabId);
    await vi.waitFor(() => expect(cleanupSensitiveSessionPartition).toHaveBeenCalledOnce());

    const nextOwnership = createSensitiveOwnership({ sessionPartition: partition });
    await expect(
      manager.createSensitiveIntegrationTab(
        { url: "https://pipedream.com/connect?app=gmail&token=racing" },
        { awaitAttach: false },
        nextOwnership,
      ),
    ).rejects.toThrow(/cleanup.*progress/i);

    finishCleanup();
    await closing;
    const next = await manager.createSensitiveIntegrationTab(
      { url: "https://pipedream.com/connect?app=gmail&token=clean" },
      { awaitAttach: false },
      nextOwnership,
    );
    expect(next.sensitiveIntegration).toBe(true);
    await manager.closeTab(next.tabId);
  });

  it("keeps partition retirement tracking bounded across high-cycle connect flows", async () => {
    const cleanupSensitiveSessionPartition = vi
      .fn<(partition: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
      { cleanupSensitiveSessionPartition },
    );
    const firstOwnership = createSensitiveOwnership();

    for (let index = 0; index < 128; index += 1) {
      const ownership = index === 0 ? firstOwnership : createSensitiveOwnership();
      const tab = await manager.createSensitiveIntegrationTab(
        { url: `https://pipedream.com/connect?app=gmail&cycle=${index}` },
        { awaitAttach: false },
        ownership,
      );
      await manager.closeTab(tab.tabId);
    }

    const tracking = manager as unknown as {
      sensitiveSessionPartitionReferences: Map<string, unknown>;
      sensitiveSessionPartitionCleanups: Map<string, unknown>;
      retiredSensitiveSessionPartitions?: Set<string>;
    };
    expect(tracking.sensitiveSessionPartitionReferences.size).toBe(0);
    expect(tracking.sensitiveSessionPartitionCleanups.size).toBe(0);
    expect(tracking.retiredSensitiveSessionPartitions).toBeUndefined();
    expect(cleanupSensitiveSessionPartition).toHaveBeenCalledTimes(128);
    await expect(
      manager.createSensitiveIntegrationTab(
        { url: "https://pipedream.com/connect?app=gmail&cycle=reuse" },
        { awaitAttach: false },
        firstOwnership,
      ),
    ).rejects.toThrow(/reuse/i);
  });

  it("reuses only the bounded native partition pool across isolated create and close cycles", async () => {
    const cleanupSensitiveSessionPartition = vi
      .fn<(partition: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
      { cleanupSensitiveSessionPartition },
    );

    for (let index = 0; index < 128; index += 1) {
      const tab = await manager.createIsolatedSensitiveIntegrationTab(
        { url: `https://example.test/oauth?cycle=${index}` },
        { awaitAttach: false },
      );
      await manager.closeTab(tab.tabId);
    }

    const observedPartitions = cleanupSensitiveSessionPartition.mock.calls.map(
      ([partition]) => partition,
    );
    expect(observedPartitions).toHaveLength(128);
    expect(new Set(observedPartitions).size).toBe(SENSITIVE_SESSION_PARTITION_POOL_SIZE);
    expect(inspectSensitiveSessionPartitionPoolForTests()).toEqual(
      expect.arrayContaining([expect.objectContaining({ state: "available" })]),
    );
    expect(
      inspectSensitiveSessionPartitionPoolForTests().every(({ state }) => state === "available"),
    ).toBe(true);
  });

  it("quarantines an isolated pool slot when exact session cleanup fails", async () => {
    const cleanupSensitiveSessionPartition = vi
      .fn<(partition: string) => Promise<void>>()
      .mockRejectedValue(new Error("auth cache unavailable"));
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
      { cleanupSensitiveSessionPartition },
    );
    const tab = await manager.createIsolatedSensitiveIntegrationTab(
      { url: "https://example.test/oauth?failed-cleanup=1" },
      { awaitAttach: false },
    );

    await manager.closeTab(tab.tabId);

    const failedPartition = cleanupSensitiveSessionPartition.mock.calls[0]?.[0];
    expect(failedPartition).toBeDefined();
    expect(inspectSensitiveSessionPartitionPoolForTests()).toContainEqual({
      partition: failedPartition,
      state: "quarantined",
    });
  });

  it("times out hung sensitive cleanup, quarantines its pool slot, and settles close", async () => {
    vi.useFakeTimers();
    let rejectLate!: (reason?: unknown) => void;
    const cleanupSensitiveSessionPartition = vi
      .fn<(partition: string) => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectLate = reject;
          }),
      )
      .mockResolvedValue(undefined);
    const { SENSITIVE_SESSION_CLEANUP_TIMEOUT_MS } =
      await import("./cleanupSensitiveSessionPartition");
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
      { cleanupSensitiveSessionPartition },
    );
    const tab = await manager.createIsolatedSensitiveIntegrationTab(
      { url: "https://example.test/oauth?hung-cleanup=1" },
      { awaitAttach: false },
    );

    const closing = manager.closeTab(tab.tabId);
    await vi.waitFor(() => expect(cleanupSensitiveSessionPartition).toHaveBeenCalledOnce());
    const failedPartition = cleanupSensitiveSessionPartition.mock.calls[0]?.[0];
    await vi.advanceTimersByTimeAsync(SENSITIVE_SESSION_CLEANUP_TIMEOUT_MS);

    await expect(closing).resolves.toBeUndefined();
    expect(failedPartition).toBeDefined();
    expect(inspectSensitiveSessionPartitionPoolForTests()).toContainEqual({
      partition: failedPartition,
      state: "quarantined",
    });

    const reusedPartitions: string[] = [];
    for (let index = 0; index < SENSITIVE_SESSION_PARTITION_POOL_SIZE * 2; index += 1) {
      const next = await manager.createIsolatedSensitiveIntegrationTab(
        { url: `https://example.test/oauth?after-timeout=${index}` },
        { awaitAttach: false },
      );
      await manager.closeTab(next.tabId);
      reusedPartitions.push(cleanupSensitiveSessionPartition.mock.calls.at(-1)![0]);
    }
    expect(reusedPartitions).not.toContain(failedPartition);

    rejectLate(new Error("late injected cleanup failure"));
    await vi.runAllTimersAsync();
    await Promise.resolve();
  });

  it("caps active and cleaning sensitive partition records under stalled cleanup", async () => {
    const cleanupResolvers: Array<() => void> = [];
    const cleanupSensitiveSessionPartition = vi.fn<() => Promise<void>>(
      () =>
        new Promise<void>((resolve) => {
          cleanupResolvers.push(resolve);
        }),
    );
    const { BrowserPanelManager, MAX_TRACKED_SENSITIVE_SESSION_PARTITIONS } =
      await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
      { cleanupSensitiveSessionPartition },
    );
    const closings: Array<Promise<void>> = [];

    for (let index = 0; index < MAX_TRACKED_SENSITIVE_SESSION_PARTITIONS; index += 1) {
      const tab = await manager.createSensitiveIntegrationTab(
        { url: `https://pipedream.com/connect?app=gmail&stalled=${index}` },
        { awaitAttach: false },
        createSensitiveOwnership(),
      );
      closings.push(manager.closeTab(tab.tabId));
      await vi.waitFor(() => expect(cleanupResolvers).toHaveLength(index + 1));
    }

    await expect(
      manager.createSensitiveIntegrationTab(
        { url: "https://pipedream.com/connect?app=gmail&stalled=overflow" },
        { awaitAttach: false },
        createSensitiveOwnership(),
      ),
    ).rejects.toThrow(/backlog.*full/i);
    const tracking = manager as unknown as {
      sensitiveSessionPartitionReferences: Map<string, unknown>;
      sensitiveSessionPartitionCleanups: Map<string, unknown>;
    };
    expect(
      tracking.sensitiveSessionPartitionReferences.size +
        tracking.sensitiveSessionPartitionCleanups.size,
    ).toBe(MAX_TRACKED_SENSITIVE_SESSION_PARTITIONS);

    for (const resolve of cleanupResolvers) resolve();
    await Promise.all(closings);
    expect(tracking.sensitiveSessionPartitionCleanups.size).toBe(0);
  });

  it("cleans valid partitions after sensitive create failure and manager disposal", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const cleanupSensitiveSessionPartition = vi
      .fn<(partition: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
      { cleanupSensitiveSessionPartition },
    );
    const failedOwnership = createSensitiveOwnership({
      onTabOpened: () => {
        throw new Error("registration failed");
      },
    });

    await expect(
      manager.createSensitiveIntegrationTab(
        { url: "https://pipedream.com/connect?app=gmail&token=failed" },
        { awaitAttach: false },
        failedOwnership,
      ),
    ).rejects.toThrow(/register/i);
    await vi.waitFor(() =>
      expect(cleanupSensitiveSessionPartition).toHaveBeenCalledExactlyOnceWith(
        failedOwnership.sessionPartition,
      ),
    );

    const disposedOwnership = createSensitiveOwnership();
    await manager.createSensitiveIntegrationTab(
      { url: "https://pipedream.com/connect?app=gmail&token=dispose" },
      { awaitAttach: false },
      disposedOwnership,
    );
    manager.dispose();
    await vi.waitFor(() =>
      expect(cleanupSensitiveSessionPartition).toHaveBeenCalledWith(
        disposedOwnership.sessionPartition,
      ),
    );
    expect(cleanupSensitiveSessionPartition).toHaveBeenCalledTimes(2);
  });

  it("contains cleanup-hook rejection during close and dispose", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const cleanupSensitiveSessionPartition = vi
      .fn<(partition: string) => Promise<void>>()
      .mockRejectedValue(new Error("storage cleanup unavailable"));
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
      { cleanupSensitiveSessionPartition },
    );
    const closedOwnership = createSensitiveOwnership();
    const closed = await manager.createSensitiveIntegrationTab(
      { url: "https://pipedream.com/connect?app=gmail&token=close" },
      { awaitAttach: false },
      closedOwnership,
    );

    await expect(manager.closeTab(closed.tabId)).resolves.toBeUndefined();
    await Promise.resolve();
    expect(cleanupSensitiveSessionPartition).toHaveBeenCalledExactlyOnceWith(
      closedOwnership.sessionPartition,
    );

    const disposedOwnership = createSensitiveOwnership();
    await manager.createSensitiveIntegrationTab(
      { url: "https://pipedream.com/connect?app=slack&token=dispose" },
      { awaitAttach: false },
      disposedOwnership,
    );
    manager.dispose();
    await vi.waitFor(() => expect(cleanupSensitiveSessionPartition).toHaveBeenCalledTimes(2));
    expect(cleanupSensitiveSessionPartition).toHaveBeenLastCalledWith(
      disposedOwnership.sessionPartition,
    );
  });

  it("inherits one main-owned lifecycle across sensitive popup descendants", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const opened: string[] = [];
    const closed: string[] = [];
    let active = true;
    const ownership = {
      sessionPartition: "pipedream-oauth-11111111111111111111111111111111",
      canOpenTab: () => active,
      onTabOpened: (tabId: string) => opened.push(tabId),
      onTabClosed: (tabId: string) => closed.push(tabId),
    };

    const root = await manager.createSensitiveIntegrationTab(
      {
        url: "https://pipedream.com/connect?token=private-root&connectLink=true&app=gmail",
        activate: true,
      },
      { awaitAttach: false },
      ownership,
    );
    expect(opened).toEqual([root.tabId]);

    browserTabs
      .get(root.tabId)
      ?.emitPopup("https://accounts.google.com/o/oauth2/auth?token=private-popup&app=gmail");
    await vi.waitFor(() => expect(opened).toHaveLength(2));
    const popupTabId = opened[1]!;

    browserTabs
      .get(popupTabId)
      ?.emitPopup("https://accounts.google.com/signin?token=private-grandchild&app=gmail");
    await vi.waitFor(() => expect(opened).toHaveLength(3));
    const grandchildTabId = opened[2]!;

    expect(manager.hasSensitiveIntegrationTab(popupTabId)).toBe(true);
    expect(manager.hasSensitiveIntegrationTab(grandchildTabId)).toBe(true);
    expect(JSON.stringify(manager.snapshot())).not.toMatch(
      /private-root|private-popup|private-grandchild|accounts\.google\.com/i,
    );

    active = false;
    browserTabs
      .get(grandchildTabId)
      ?.emitPopup("https://accounts.google.com/late-popup?token=private-late&app=gmail");
    await Promise.resolve();
    expect(opened).toHaveLength(3);

    for (const tabId of opened) await manager.closeTab(tabId);
    expect(new Set(closed)).toEqual(new Set(opened));
    expect(manager.snapshot().tabs).toEqual([]);
  });

  it("rejects the element picker for a sensitive integration tab before capturing data", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const privateUrl = "https://pipedream.com/connect?token=private-picker-token&connectLink=true";
    const created = await manager.createSensitiveIntegrationTab(
      { url: privateUrl, activate: true },
      { awaitAttach: false },
      createSensitiveOwnership(),
    );

    await expect(
      manager.startPicker({ threadId: "thread-picker", tabId: created.tabId }),
    ).resolves.toEqual({
      ok: false,
      error: `No browser tab: ${created.tabId}`,
    });
    expect((manager as unknown as { pendingPicker: unknown }).pendingPicker).toBeNull();
    expect(JSON.stringify(manager.snapshot())).not.toContain("private-picker-token");
    manager.dispose();
  });

  it("rejects renderer navigation, storage, DevTools, and capture for sensitive tabs", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const created = await manager.createSensitiveIntegrationTab(
      { url: "https://pipedream.com/connect?app=gmail&token=private-inspection" },
      { awaitAttach: false },
      createSensitiveOwnership(),
    );
    const guest = createGuestWebContents(303);
    resolveWebContentsById.mockReturnValue(guest);
    manager.attachWebContents(created.tabId, guest.id);

    await expect(
      manager.navigate(created.tabId, "https://attacker.example/replace-oauth"),
    ).rejects.toThrow(`No browser tab: ${created.tabId}`);
    await expect(manager.back(created.tabId)).resolves.toBeUndefined();
    await expect(manager.forward(created.tabId)).resolves.toBeUndefined();
    await expect(manager.reload(created.tabId)).resolves.toBeUndefined();
    await expect(manager.hardReload(created.tabId)).resolves.toBeUndefined();
    await expect(manager.clearHistory(created.tabId)).resolves.toBeUndefined();
    await expect(manager.clearCookies(created.tabId)).resolves.toBeUndefined();
    await expect(manager.clearCache(created.tabId)).resolves.toBeUndefined();
    await expect(manager.toggleDevTools(created.tabId)).resolves.toBeUndefined();
    await expect(manager.capturePng(created.tabId)).resolves.toBeNull();
    expect(browserTabs.get(created.tabId)?.toggleDevTools).not.toHaveBeenCalled();
    expect(browserTabs.get(created.tabId)?.capturePng).not.toHaveBeenCalled();
  });

  it("cancels and resolves a picker when its target tab closes", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const resolvePicker = vi.fn<(result: unknown) => void>();
    const cleanupShortcut = vi.fn<() => void>();
    const tab = {
      ...createFakeTab("tab-picker"),
      isAttached: () => false,
      destroy: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };
    (manager as unknown as { tabs: (typeof tab)[] }).tabs = [tab];
    (manager as unknown as { pendingPicker: unknown }).pendingPicker = {
      threadId: "thread-picker",
      tabId: tab.tabId,
      resolve: resolvePicker,
    };
    (manager as unknown as { pickerKeyCleanup: (() => void) | null }).pickerKeyCleanup =
      cleanupShortcut;

    await manager.closeTab(tab.tabId);

    expect(resolvePicker).toHaveBeenCalledWith({ ok: true, cancelled: true });
    expect(cleanupShortcut).toHaveBeenCalledOnce();
    expect((manager as unknown as { pendingPicker: unknown }).pendingPicker).toBeNull();
    manager.dispose();
  });

  it("rejects malformed picker replies and clears the pending picker", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const resolvePicker = vi.fn<(result: unknown) => void>();
    const cleanupShortcut = vi.fn<() => void>();
    (manager as unknown as { pendingPicker: unknown }).pendingPicker = {
      threadId: "thread-picker",
      tabId: "tab-picker",
      resolve: resolvePicker,
    };
    (manager as unknown as { pickerKeyCleanup: (() => void) | null }).pickerKeyCleanup =
      cleanupShortcut;

    await (
      manager as unknown as {
        onPickerCommit(commit: { tabId: string; payload: unknown }): Promise<void>;
      }
    ).onPickerCommit({
      tabId: "tab-picker",
      payload: {
        kind: "picked",
        selector: "button",
        rect: { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 10 },
        dpr: 1,
        url: "https://spoofed.test/",
        title: "Spoofed",
      },
    });

    expect(resolvePicker).toHaveBeenCalledWith({ ok: false, error: "Invalid picker response" });
    expect(cleanupShortcut).toHaveBeenCalledOnce();
    expect((manager as unknown as { pendingPicker: unknown }).pendingPicker).toBeNull();
    manager.dispose();
  });

  it("bounds picker clips and strings and uses the attached tab URL as the source", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const resolvePicker = vi.fn<(result: unknown) => void>();
    const capturePng = vi
      .fn<(clip: Electron.Rectangle) => Promise<Buffer>>()
      .mockResolvedValue(Buffer.from("png"));
    const tab = {
      ...createFakeTab("tab-picker-bounds"),
      isAttached: () => true,
      webContents: { getURL: () => "https://authoritative.test/current" },
      capturePng,
    };
    (manager as unknown as { tabs: (typeof tab)[] }).tabs = [tab];
    (manager as unknown as { pendingPicker: unknown }).pendingPicker = {
      threadId: "thread-picker",
      tabId: tab.tabId,
      resolve: resolvePicker,
    };

    await (
      manager as unknown as {
        onPickerCommit(commit: { tabId: string; payload: unknown }): Promise<void>;
      }
    ).onPickerCommit({
      tabId: tab.tabId,
      payload: {
        kind: "picked",
        selector: `button.${"s".repeat(20_000)}`,
        rect: { x: -100, y: 2_000_000, width: 100_000, height: 100_000 },
        dpr: 2,
        url: "https://spoofed.test/private?token=secret",
        title: "T".repeat(50_000),
      },
    });

    const clip = capturePng.mock.calls[0]?.[0];
    expect(clip).toBeDefined();
    expect(clip?.x).toBe(0);
    expect(clip?.y).toBeLessThanOrEqual(1_000_000);
    expect((clip?.width ?? 0) * (clip?.height ?? 0)).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(resolvePicker).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        sourceUrl: "https://authoritative.test/current",
      }),
    );
    const result = resolvePicker.mock.calls[0]?.[0] as { selector?: string } | undefined;
    expect(Buffer.byteLength(result?.selector ?? "", "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(JSON.stringify(result)).not.toContain("spoofed.test");
    expect(saveClipboardImageFile).toHaveBeenCalledOnce();
    manager.dispose();
  });

  it("rejects blocked initial URLs before a webview can mount them", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );

    await expect(
      manager.createTab({ url: "file:///etc/passwd", activate: true }, { awaitAttach: false }),
    ).rejects.toThrow("Navigation blocked");
    await expect(
      manager.createTab(
        { url: "javascript:alert(document.domain)", activate: true },
        { awaitAttach: false },
      ),
    ).rejects.toThrow("Navigation blocked");
    expect(manager.snapshot().tabs).toEqual([]);
  });

  it("recovers a crashed main-owned sensitive view at its private redirect", async () => {
    vi.useFakeTimers();
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const events: unknown[] = [];
    manager.addEventListener((event) => events.push(event));
    const initialPrivateUrl =
      "https://pipedream.com/_static/connect.html?token=initial-private-token&connectLink=true";
    const currentPrivateUrl = "https://accounts.example.test/authorize?state=current-private-state";
    const ownership = createSensitiveOwnership();
    const created = await manager.createSensitiveIntegrationTab(
      { url: initialPrivateUrl, activate: true },
      { awaitAttach: false },
      ownership,
    );
    expect(browserTabs.get(created.tabId)?.loadUrls).toEqual([initialPrivateUrl]);

    browserTabs.get(created.tabId)?.emitUrl(currentPrivateUrl, "Authorize");
    mainOwnedSensitiveViews[0]!.webContents.close();
    await vi.waitFor(() => expect(mainOwnedSensitiveViews).toHaveLength(2));
    await vi.runAllTimersAsync();

    expect(browserTabs.get(created.tabId)?.loadUrls).toEqual([
      initialPrivateUrl,
      currentPrivateUrl,
    ]);
    expect(browserTabs.get(created.tabId)?.attachedWebContents).toEqual([
      mainOwnedSensitiveViews[0]!.webContents,
      mainOwnedSensitiveViews[1]!.webContents,
    ]);
    expect(manager.snapshot().tabs[0]).toMatchObject({
      tabId: created.tabId,
      url: "about:blank",
      title: "",
      sensitiveIntegration: true,
    });
    const publicState = JSON.stringify({
      events,
      snapshot: manager.snapshot(),
      persistence: dbSetState.mock.calls,
    });
    expect(publicState).not.toContain("initial-private-token");
    expect(publicState).not.toContain("current-private-state");
    expect(publicState).not.toContain(initialPrivateUrl);
    expect(publicState).not.toContain(currentPrivateUrl);
  });

  it("inherits sensitive lifetime protection for popups opened by a sensitive tab", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const parent = await manager.createSensitiveIntegrationTab(
      { url: "https://oauth.example.test/authorize?state=private", activate: true },
      { awaitAttach: false },
      createSensitiveOwnership(),
    );

    browserTabs
      .get(parent.tabId)
      ?.emitPopup("https://accounts.example.test/consent?state=popup-private");
    await vi.waitFor(() => expect(manager.snapshot().tabs).toHaveLength(2));

    const popup = manager.snapshot().tabs.find((tab) => tab.tabId !== parent.tabId);
    expect(popup).toMatchObject({
      url: "about:blank",
      title: "",
      sensitiveIntegration: true,
    });
    expect(popup && manager.getTab(popup.tabId)).toBeNull();
  });
});
