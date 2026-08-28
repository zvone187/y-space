import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserTabGroupInfo } from "@/shared/ipc";

const resolveWebContentsById = vi.hoisted(() => vi.fn<(id: number) => unknown>());
const shellOpenExternal = vi.hoisted(() => vi.fn<(url: string) => Promise<void>>());
const dbGetState = vi.hoisted(() => vi.fn<(key: string) => string | null>());
const dbSetState = vi.hoisted(() => vi.fn<(key: string, value: string) => void>());
const saveClipboardImageFile = vi.hoisted(() => vi.fn<() => string>(() => "/tmp/Selection.png"));
const browserTabs = vi.hoisted(
  () =>
    new Map<
      string,
      {
        emitUrl(url: string, title?: string): void;
        emitPopup(url: string): void;
        clearHistory: ReturnType<typeof vi.fn>;
        loadUrls: string[];
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
    private attachedWebContents: unknown = null;
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
      browserTabs.set(options.tabId, {
        emitUrl: (url, title = "Connected") => {
          this.snapshotValue = { ...this.snapshotValue, url, title, loading: false };
          options.onUpdate(this.snapshotValue);
        },
        emitPopup: (url) => options.onPopup?.(options.tabId, url),
        clearHistory: this.clearHistory,
        loadUrls,
      });
    }

    snapshot() {
      return { ...this.snapshotValue };
    }

    attach(webContents: unknown) {
      if (this.attachedWebContents === webContents) return false;
      this.attachedWebContents = webContents;
      return true;
    }
    isAttached() {
      return this.attachedWebContents !== null;
    }
    isDestroyed() {
      return false;
    }
    whenAttached() {
      return Promise.resolve();
    }
    async loadURL(url: string) {
      browserTabs.get(this.tabId)?.loadUrls.push(url);
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
    attach: vi.fn<(webContents: unknown) => boolean>(() => true),
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
      );
    }

    await expect(
      manager.createSensitiveIntegrationTab(
        { url: "https://connect.example.test/over-limit", activate: false },
        { awaitAttach: false },
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
    );
    await vi.runAllTimersAsync();

    expect(JSON.stringify(events)).not.toContain("connect-token-private");
    expect(created.url).not.toContain("connect-token-private");
    expect(JSON.stringify(dbSetState.mock.calls)).not.toContain("connect-token-private");
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
    expect(manager.snapshot().tabs).toEqual([]);
    expect(JSON.stringify(dbSetState.mock.calls)).not.toContain("https://pipedream.com/connected");
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

  it("resumes a sensitive auth page on a replacement guest without exposing or persisting its URL", async () => {
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
    const created = await manager.createSensitiveIntegrationTab(
      { url: initialPrivateUrl, activate: true },
      { awaitAttach: false },
    );
    const firstGuest = { id: "first-guest" };
    const replacementGuest = { id: "replacement-guest" };

    resolveWebContentsById.mockReturnValue(firstGuest);
    manager.attachWebContents(created.tabId, 101);
    // The renderer can report the same mounted guest more than once; that must
    // not restart a one-use auth URL.
    manager.attachWebContents(created.tabId, 101);

    expect(browserTabs.get(created.tabId)?.loadUrls).toEqual([initialPrivateUrl]);

    browserTabs.get(created.tabId)?.emitUrl(currentPrivateUrl, "Authorize");
    resolveWebContentsById.mockReturnValue(replacementGuest);
    manager.attachWebContents(created.tabId, 202);
    await vi.runAllTimersAsync();

    expect(browserTabs.get(created.tabId)?.loadUrls).toEqual([
      initialPrivateUrl,
      currentPrivateUrl,
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
