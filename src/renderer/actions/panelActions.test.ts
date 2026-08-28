import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserTabInfo } from "@/shared/ipc";
import { usePanelStore } from "@/renderer/state/panelStore";
import { useBrowserPanelStore } from "@/renderer/state/browserPanelStore";
import { useDevTerminalStore } from "@/renderer/state/devTerminalStore";
import { useSharedSettings } from "@/renderer/state/sharedSettingsStore";
import { useRightWorkspaceTabsStore } from "@/renderer/state/rightWorkspaceTabsStore";
import { useAppStore } from "@/renderer/state/appStore";
import { useFileEditorStore } from "@/renderer/state/fileEditorStore";
import {
  dockPanelTab,
  openBrowserPanel,
  openGitReview,
  openUsagePanel,
  undockPanelTab,
} from "./panelActions";

const bridge = vi.hoisted(() => ({
  browserActivateTab: vi.fn<(payload: { tabId: string }) => Promise<void>>(),
  browserCreateTab:
    vi.fn<(payload: { url?: string; activate?: boolean }) => Promise<BrowserTabInfo>>(),
}));

vi.mock("@/renderer/bridge", () => ({ readBridge: () => bridge }));

function browserTab(tabId: string, title = "Example", url = "https://example.com/") {
  return {
    tabId,
    title,
    url,
    loading: false,
    canGoBack: false,
    canGoForward: false,
  } satisfies BrowserTabInfo;
}

function resetDockState() {
  useAppStore.setState({ projects: [], threads: [], view: { kind: "home" }, focusedPaneId: null });
  useRightWorkspaceTabsStore.getState().reset();
  useSharedSettings.setState({ terminalPosition: "bottom", gitReviewMode: "panel" });
  usePanelStore.setState({
    rightPanelTab: "git",
    rightPanelSplit: null,
    bottomPanelDocks: { left: null, right: null },
    usagePanelOpen: false,
    notesPanelOpen: false,
    browserPanelOpen: false,
    gitReviewContext: null,
    gitReviewAsPanel: false,
  });
  useBrowserPanelStore.setState({
    tabs: [],
    groups: [],
    activeTabId: null,
    extracted: false,
    bookmarks: [],
    bookmarkBarVisible: false,
    pickerActive: false,
    attentionTabId: null,
    automationActive: false,
  });
  bridge.browserActivateTab.mockReset().mockResolvedValue(undefined);
  bridge.browserCreateTab.mockReset();
  useDevTerminalStore.setState({
    isOpen: false,
    explicitlyOpened: false,
    activeProjectId: null,
    activeWorktreePath: null,
  });
  useFileEditorStore.setState({
    rootContext: null,
    overlayMode: null,
    tabs: [],
    activePath: null,
    previewTab: null,
    markdownPreviewPath: null,
    buffers: {},
    pendingReveal: null,
  });
}

describe("dockPanelTab", () => {
  beforeEach(resetDockState);
  afterEach(() => {
    vi.restoreAllMocks();
    resetDockState();
  });

  it("docks a tab into a bottom slot and opens its content", () => {
    dockPanelTab("usage", { zone: "bottom-panel", placement: "right" });

    expect(usePanelStore.getState().bottomPanelDocks).toEqual({ left: null, right: "usage" });
    expect(usePanelStore.getState().usagePanelOpen).toBe(true);
  });

  it("fills both bottom slots with different tabs", () => {
    dockPanelTab("usage", { zone: "bottom-panel", placement: "left" });
    dockPanelTab("notes", { zone: "bottom-panel", placement: "right" });

    expect(usePanelStore.getState().bottomPanelDocks).toEqual({ left: "usage", right: "notes" });
  });

  it("moves a right-panel split tab into the bottom dock", () => {
    usePanelStore.getState().setRightPanelSplit({ tab: "usage", placement: "bottom" });

    dockPanelTab("usage", { zone: "bottom-panel", placement: "left" });

    expect(usePanelStore.getState().rightPanelSplit).toBeNull();
    expect(usePanelStore.getState().bottomPanelDocks).toEqual({ left: "usage", right: null });
  });

  it("splits the right panel without switching the active tab", () => {
    dockPanelTab("usage", { zone: "right-panel", placement: "bottom" });

    expect(usePanelStore.getState().rightPanelTab).toBe("git");
    expect(usePanelStore.getState().rightPanelSplit).toEqual({
      tab: "usage",
      placement: "bottom",
    });
    expect(usePanelStore.getState().usagePanelOpen).toBe(true);
  });

  it("moves a bottom-docked tab back into the right panel as a split", () => {
    usePanelStore.getState().setBottomPanelDock("right", "usage");

    dockPanelTab("usage", { zone: "right-panel", placement: "top" });

    expect(usePanelStore.getState().bottomPanelDocks).toEqual({ left: null, right: null });
    expect(usePanelStore.getState().rightPanelSplit).toEqual({
      tab: "usage",
      placement: "top",
    });
  });

  it("does not split the active tab with itself", () => {
    usePanelStore.setState({ rightPanelTab: "usage", usagePanelOpen: true });
    useRightWorkspaceTabsStore.getState().openTool("usage");

    dockPanelTab("usage", { zone: "right-panel", placement: "bottom" });

    expect(usePanelStore.getState().rightPanelSplit).toBeNull();
  });

  it("leaves docking and the outer Files tab unchanged when a dirty root switch is declined", () => {
    useAppStore.setState({
      projects: [
        {
          id: "project-b",
          name: "Project B",
          location: { kind: "posix", path: "/repo/b" },
          createdAt: "2026-08-27T00:00:00.000Z",
        },
      ],
      view: { kind: "home" },
    });
    useFileEditorStore.setState({
      rootContext: {
        projectId: "project-a",
        projectName: "Project A",
        projectLocation: { kind: "posix", path: "/repo/a" },
        rootLabel: "Project A",
      },
      tabs: ["dirty.ts"],
      activePath: "dirty.ts",
      buffers: {
        "dirty.ts": {
          path: "dirty.ts",
          status: "ready",
          modifiedAtMs: 1,
          content: "changed",
          savedContent: "original",
          lineEnding: "lf",
          hasBom: false,
          isDirty: true,
          isLoading: false,
        },
      },
    });
    useRightWorkspaceTabsStore.getState().openTool("files");
    vi.spyOn(window, "confirm").mockReturnValue(false);

    dockPanelTab("files", { zone: "right-panel", placement: "bottom" });

    expect(usePanelStore.getState().rightPanelSplit).toBeNull();
    expect(usePanelStore.getState().bottomPanelDocks).toEqual({ left: null, right: null });
    expect(useRightWorkspaceTabsStore.getState()).toMatchObject({
      activeTabId: "tool:files",
      tabs: [expect.objectContaining({ id: "tool:files" })],
    });
    expect(useFileEditorStore.getState().rootContext?.projectId).toBe("project-a");
  });

  it("ignores the terminal in the bottom row — it already owns the middle", () => {
    dockPanelTab("terminal", { zone: "bottom-panel", placement: "right" });

    expect(usePanelStore.getState().bottomPanelDocks).toEqual({ left: null, right: null });
  });

  it("keeps the terminal on the free side when a panel is dropped into the left slot", () => {
    useDevTerminalStore.setState({ isOpen: true, explicitlyOpened: true });

    dockPanelTab("usage", { zone: "bottom-panel", placement: "left" });

    expect(useDevTerminalStore.getState().isOpen).toBe(true);
    expect(usePanelStore.getState().bottomPanelDocks).toEqual({ left: "usage", right: null });
  });

  it("keeps the terminal when a panel is dropped into the right slot", () => {
    useDevTerminalStore.setState({ isOpen: true, explicitlyOpened: true });

    dockPanelTab("usage", { zone: "bottom-panel", placement: "right" });

    expect(useDevTerminalStore.getState().isOpen).toBe(true);
    expect(usePanelStore.getState().bottomPanelDocks).toEqual({ left: null, right: "usage" });
  });

  it("closes the terminal when a panel is dropped into the free slot beside an existing dock", () => {
    useDevTerminalStore.setState({ isOpen: true, explicitlyOpened: true });
    usePanelStore.getState().setBottomPanelDock("right", "notes");

    dockPanelTab("usage", { zone: "bottom-panel", placement: "left" });

    expect(useDevTerminalStore.getState().isOpen).toBe(false);
    expect(usePanelStore.getState().bottomPanelDocks).toEqual({ left: "usage", right: "notes" });
  });

  it("closes the terminal when a panel fills the remaining free slot on the right", () => {
    useDevTerminalStore.setState({ isOpen: true, explicitlyOpened: true });
    usePanelStore.getState().setBottomPanelDock("left", "notes");

    dockPanelTab("usage", { zone: "bottom-panel", placement: "right" });

    expect(useDevTerminalStore.getState().isOpen).toBe(false);
    expect(usePanelStore.getState().bottomPanelDocks).toEqual({ left: "notes", right: "usage" });
  });

  it("ignores non-dockable tabs", () => {
    dockPanelTab("plan", { zone: "right-panel", placement: "bottom" });

    expect(usePanelStore.getState().rightPanelSplit).toBeNull();
  });

  it("ignores Browser now that browser pages live in the global tab strip", () => {
    dockPanelTab("browser", { zone: "bottom-panel", placement: "right" });

    expect(usePanelStore.getState().rightPanelSplit).toBeNull();
    expect(usePanelStore.getState().bottomPanelDocks).toEqual({ left: null, right: null });
    expect(usePanelStore.getState().browserPanelOpen).toBe(false);
  });
});

describe("openBrowserPanel", () => {
  beforeEach(resetDockState);
  afterEach(() => {
    vi.restoreAllMocks();
    resetDockState();
  });

  it("selects the manager's existing page instead of creating a Browser tool singleton", () => {
    const page = browserTab("page-1");
    useBrowserPanelStore.setState({ tabs: [page], activeTabId: page.tabId });
    useRightWorkspaceTabsStore.getState().openTool("git");
    useRightWorkspaceTabsStore
      .getState()
      .syncBrowserPages([{ browserTabId: page.tabId, title: page.title, url: page.url }]);

    openBrowserPanel();

    expect(useRightWorkspaceTabsStore.getState().activeTabId).toBe("browser:page-1");
    expect(
      useRightWorkspaceTabsStore.getState().tabs.some((tab) => tab.id === "tool:browser"),
    ).toBe(false);
    expect(bridge.browserCreateTab).not.toHaveBeenCalled();
    expect(usePanelStore.getState()).toMatchObject({
      browserPanelOpen: true,
      rightPanelTab: "browser",
    });
  });

  it("creates and selects a home page asynchronously when no page exists", async () => {
    const created = browserTab("page-new", "DuckDuckGo", "https://duckduckgo.com/");
    bridge.browserCreateTab.mockResolvedValue(created);
    useRightWorkspaceTabsStore.getState().openTool("git");

    openBrowserPanel();

    expect(bridge.browserCreateTab).toHaveBeenCalledWith({
      url: "https://duckduckgo.com",
      activate: true,
    });
    expect(useRightWorkspaceTabsStore.getState().activeTabId).toBe("tool:git");
    await vi.waitFor(() =>
      expect(useRightWorkspaceTabsStore.getState().activeTabId).toBe("browser:page-new"),
    );
  });

  it("does not steal focus if the user selects another workspace tab before creation resolves", async () => {
    let resolveCreated!: (tab: BrowserTabInfo) => void;
    bridge.browserCreateTab.mockReturnValue(
      new Promise<BrowserTabInfo>((resolve) => {
        resolveCreated = resolve;
      }),
    );
    useRightWorkspaceTabsStore.getState().openTool("git");

    openBrowserPanel();
    useRightWorkspaceTabsStore.getState().openTool("notes");
    resolveCreated(browserTab("page-late"));
    await Promise.resolve();
    await Promise.resolve();

    expect(useRightWorkspaceTabsStore.getState().activeTabId).toBe("tool:notes");
  });
});

// Global workspace launchers always open or focus a singleton. A bottom-docked
// tool is pulled back into the outer tab strip before it is focused.
describe("opening a bottom-docked tab", () => {
  beforeEach(resetDockState);
  afterEach(resetDockState);

  it("brings a docked Usage back into the right panel", () => {
    usePanelStore.getState().setUsagePanelOpen(true);
    usePanelStore.getState().setBottomPanelDock("right", "usage");
    usePanelStore.setState({ rightPanelTab: "usage" });

    openUsagePanel();

    expect(usePanelStore.getState().bottomPanelDocks).toEqual({ left: null, right: null });
    expect(usePanelStore.getState().usagePanelOpen).toBe(true);
    expect(usePanelStore.getState().rightPanelTab).toBe("usage");
  });

  it("brings a docked Git back into the right panel", () => {
    usePanelStore.getState().setGitReviewContext({ projectId: "p1" });
    usePanelStore.getState().setGitReviewAsPanel(true);
    usePanelStore.getState().setBottomPanelDock("left", "git");
    usePanelStore.setState({ rightPanelTab: "git" });

    openGitReview("p1");

    expect(usePanelStore.getState().bottomPanelDocks).toEqual({ left: null, right: null });
    expect(usePanelStore.getState().gitReviewContext).not.toBeNull();
    expect(usePanelStore.getState().rightPanelTab).toBe("git");
  });

  it("focuses the existing singleton when the tab is not docked", () => {
    usePanelStore.getState().setUsagePanelOpen(true);
    usePanelStore.setState({ rightPanelTab: "usage" });

    openUsagePanel();

    expect(usePanelStore.getState().usagePanelOpen).toBe(true);
    expect(useRightWorkspaceTabsStore.getState().tabs).toHaveLength(1);
    expect(useRightWorkspaceTabsStore.getState().activeTabId).toBe("tool:usage");
  });
});

describe("undockPanelTab", () => {
  beforeEach(resetDockState);
  afterEach(resetDockState);

  it("pulls a tab out of the split half and the bottom row", () => {
    usePanelStore.getState().setRightPanelSplit({ tab: "notes", placement: "top" });
    usePanelStore.getState().setBottomPanelDock("left", "usage");

    undockPanelTab("notes");
    undockPanelTab("usage");

    expect(usePanelStore.getState().rightPanelSplit).toBeNull();
    expect(usePanelStore.getState().bottomPanelDocks).toEqual({ left: null, right: null });
  });

  it("leaves other placements untouched", () => {
    usePanelStore.getState().setBottomPanelDock("left", "usage");

    undockPanelTab("notes");

    expect(usePanelStore.getState().bottomPanelDocks).toEqual({ left: "usage", right: null });
  });
});
