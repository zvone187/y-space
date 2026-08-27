import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserTabGroupInfo } from "@/shared/ipc";

const resolveWebContentsById = vi.hoisted(() => vi.fn<(id: number) => unknown>());
const shellOpenExternal = vi.hoisted(() => vi.fn<(url: string) => Promise<void>>());
const dbGetState = vi.hoisted(() => vi.fn<(key: string) => string | null>());
const dbSetState = vi.hoisted(() => vi.fn<(key: string, value: string) => void>());
const browserTabs = vi.hoisted(
  () =>
    new Map<
      string,
      {
        emitUrl(url: string, title?: string): void;
        clearHistory: ReturnType<typeof vi.fn>;
      }
    >(),
);

vi.mock("electron", () => ({
  BrowserWindow: class BrowserWindow {},
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
  saveClipboardImageFile: vi.fn<() => string>(),
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
  BrowserTab: class BrowserTab {
    readonly tabId: string;
    readonly clearHistory = vi.fn<() => void>();
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
        onUpdate(snapshot: unknown): void;
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
      browserTabs.set(options.tabId, {
        emitUrl: (url, title = "Connected") => {
          this.snapshotValue = { ...this.snapshotValue, url, title, loading: false };
          options.onUpdate(this.snapshotValue);
        },
        clearHistory: this.clearHistory,
      });
    }

    snapshot() {
      return { ...this.snapshotValue };
    }

    attach() {}
    whenAttached() {
      return Promise.resolve();
    }
    async loadURL(url: string) {
      this.snapshotValue = { ...this.snapshotValue, url, loading: false };
      this.options.onUpdate(this.snapshotValue);
    }
    async destroy() {
      browserTabs.delete(this.tabId);
    }
  },
  resolveWebContentsById,
}));

function createManagerWithTab() {
  const tab = {
    tabId: "tab-1",
    attach: vi.fn<(webContents: unknown) => void>(),
  };
  const hostWebContents = {
    id: 42,
    on: vi.fn<() => void>(),
    send: vi.fn<() => void>(),
  };
  const host = {
    webContents: hostWebContents,
    once: vi.fn<() => void>(),
    isDestroyed: () => false,
  };
  return { tab, host, hostWebContents };
}

function createFakeTab(tabId: string) {
  return {
    tabId,
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
    vi.clearAllMocks();
    browserTabs.clear();
    dbGetState.mockReturnValue(null);
    shellOpenExternal.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects the host window WebContents as a browser tab target", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const { tab, host } = createManagerWithTab();

    manager.bindHost(host as never);
    (manager as unknown as { tabs: (typeof tab)[] }).tabs = [tab];
    manager.attachWebContents("tab-1", 42);

    expect(resolveWebContentsById).not.toHaveBeenCalled();
    expect(tab.attach).not.toHaveBeenCalled();
  });

  it("attaches a non-host WebContents to the browser tab", async () => {
    const { BrowserPanelManager } = await import("./BrowserPanelManager");
    const manager = new BrowserPanelManager(
      { settingsPath: "settings.json" } as never,
      "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
    );
    const { tab, host } = createManagerWithTab();
    const guestWebContents = { id: 99 };
    resolveWebContentsById.mockReturnValue(guestWebContents);

    manager.bindHost(host as never);
    (manager as unknown as { tabs: (typeof tab)[] }).tabs = [tab];
    manager.attachWebContents("tab-1", 99);

    expect(resolveWebContentsById).toHaveBeenCalledWith(99);
    expect(tab.attach).toHaveBeenCalledWith(guestWebContents);
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

  it("never emits, records, or persists a one-use integration URL and reveals only the safe landing URL", async () => {
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
    );
    await vi.runAllTimersAsync();

    expect(JSON.stringify(events)).not.toContain("connect-token-private");
    expect(created.url).not.toContain("connect-token-private");
    expect(JSON.stringify(dbSetState.mock.calls)).not.toContain("connect-token-private");
    expect(manager.getTab(created.tabId)).toBeNull();
    expect(manager.getActiveTab()).toBeNull();

    browserTabs.get(created.tabId)?.emitUrl("https://pipedream.com/connected", "Connected");
    await vi.runAllTimersAsync();

    expect(manager.snapshot().tabs[0]?.url).toBe("https://pipedream.com/connected");
    expect(manager.getTab(created.tabId)?.tabId).toBe(created.tabId);
    expect(browserTabs.get(created.tabId)?.clearHistory).toHaveBeenCalled();
    expect(JSON.stringify(events)).not.toContain("connect-token-private");
    expect(JSON.stringify(dbSetState.mock.calls)).not.toContain("connect-token-private");
  });
});
