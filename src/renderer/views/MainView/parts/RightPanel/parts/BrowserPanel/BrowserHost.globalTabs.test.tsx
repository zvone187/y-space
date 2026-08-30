// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserTabInfo } from "@/shared/ipc";
import { renderWithI18n as render } from "@/renderer/testUtils/i18n";
import { useBrowserPanelStore } from "@/renderer/state/browserPanelStore";
import { usePanelStore } from "@/renderer/state/panelStore";
import { useRightWorkspaceTabsStore } from "@/renderer/state/rightWorkspaceTabsStore";
import { BrowserHost } from "./BrowserHost";

const bridge = vi.hoisted(() => ({
  browserActivateTab: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  browserAttachWebContents: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
  browserCloseTab: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  browserCreateTab:
    vi.fn<(payload: { url?: string; activate?: boolean }) => Promise<BrowserTabInfo>>(),
  browserHardReload: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  browserReload: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

vi.mock("@/renderer/bridge", () => ({
  isMac: () => false,
  isWindows: () => false,
  readBridge: () => bridge,
}));

vi.mock("./hooks/useElementPicker", () => ({
  useElementPicker: () => ({
    pickerActive: false,
    startPicker: vi.fn<() => Promise<{ ok: boolean; cancelled: boolean }>>(),
    threadTargets: [],
    pendingPickerAttachment: null,
    chooseTargetForPendingPick: vi.fn<(threadId: string) => void>(),
    cancelPendingPick: vi.fn<() => void>(),
  }),
}));

vi.mock("./parts/BrowserBookmarkBar", () => ({
  BrowserBookmarkBar: () => null,
}));

vi.mock("./parts/BrowserToolbar", () => ({
  BrowserToolbar: () => <div data-testid="browser-toolbar" />,
}));

// This sentinel makes the legacy nested strip observable. Once browser pages
// are first-class workspace tabs, BrowserPanel must not render this component.
vi.mock("./parts/BrowserTabStrip", () => ({
  BrowserTabStrip: () => <div data-testid="nested-browser-tab-strip" />,
}));

vi.mock("./useBrowserHostPositioning", () => ({
  HEADLESS_HEIGHT: "768px",
  HEADLESS_WIDTH: "1024px",
  HEADLESS_Z: "-1",
  useBrowserHostPositioning: () => undefined,
}));

function browserTab(tabId: string, title: string, url: string): BrowserTabInfo {
  return {
    tabId,
    title,
    url,
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };
}

function seedBrowserPages(tabs: BrowserTabInfo[], activeTabId: string) {
  useBrowserPanelStore.setState({ tabs, activeTabId });
  type WorkspaceTabs = ReturnType<typeof useRightWorkspaceTabsStore.getState>["tabs"];
  const browserPages = tabs.map((tab, index) => ({
    id: `browser:${tab.tabId}`,
    kind: "browser-page",
    browserTabId: tab.tabId,
    title: tab.title,
    url: tab.url,
    resident: true,
    closable: true,
    lastActivatedSequence: index + 1,
  })) as unknown as WorkspaceTabs;
  useRightWorkspaceTabsStore.setState({
    tabs: browserPages,
    activeTabId: `browser:${activeTabId}`,
    previewTabId: null,
    browserPageActivationSequence: tabs.length,
    hidden: false,
  });
}

describe("BrowserHost global page tabs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bridge.browserCreateTab.mockReset();
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    useRightWorkspaceTabsStore.getState().reset();
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
    usePanelStore.setState({
      rightPanelTab: "browser",
      rightPanelSplit: null,
      bottomPanelDocks: { left: null, right: null },
      browserPanelOpen: true,
      browserOverlayOpen: false,
      browserOverlayMaximized: false,
      browserOverlayDrawerWidth: 520,
    });
  });

  it("renders browser pages through the global workspace without a nested browser strip", async () => {
    seedBrowserPages(
      [
        browserTab("page-1", "Example", "https://example.com/"),
        browserTab("page-2", "Reference", "https://example.org/"),
      ],
      "page-1",
    );

    render(<BrowserHost />);

    expect(await screen.findByRole("group", { name: "Browser" })).toBeInTheDocument();
    expect(document.querySelectorAll("webview")).toHaveLength(2);
    expect(screen.queryByTestId("nested-browser-tab-strip")).not.toBeInTheDocument();
  });

  it("unmounts a globally evicted page and detaches its webview listener", async () => {
    seedBrowserPages(
      [
        browserTab("page-1", "Example", "https://example.com/"),
        browserTab("page-2", "Reference", "https://example.org/"),
      ],
      "page-1",
    );
    render(<BrowserHost />);

    const evictedWebview = document.querySelector<HTMLElement>('webview[data-tab-id="page-1"]');
    expect(evictedWebview).not.toBeNull();
    const removeEventListener = vi.spyOn(evictedWebview!, "removeEventListener");

    act(() => useRightWorkspaceTabsStore.getState().closeTab("browser:page-1"));

    await waitFor(() =>
      expect(document.querySelector('webview[data-tab-id="page-1"]')).not.toBeInTheDocument(),
    );
    expect(document.querySelector('webview[data-tab-id="page-2"]')).toBeInTheDocument();
    expect(removeEventListener).toHaveBeenCalledWith("dom-ready", expect.any(Function));
  });

  it("keeps resident webviews mounted off-screen after switching from Browser to Git", async () => {
    seedBrowserPages(
      [
        browserTab("page-1", "Example", "https://example.com/"),
        browserTab("page-2", "Reference", "https://example.org/"),
      ],
      "page-1",
    );
    render(<BrowserHost />);
    const firstWebview = document.querySelector('webview[data-tab-id="page-1"]');

    act(() => useRightWorkspaceTabsStore.getState().openTool("git"));

    await waitFor(() =>
      expect(document.querySelector("[data-y-space-browser-host]")).toHaveAttribute(
        "aria-hidden",
        "true",
      ),
    );
    expect(document.querySelector('webview[data-tab-id="page-1"]')).toBe(firstWebview);
    expect(document.querySelectorAll("webview")).toHaveLength(2);
  });

  it("closes the overlay when a document becomes the active global peer", async () => {
    seedBrowserPages([browserTab("page-1", "Example", "https://example.com/")], "page-1");
    usePanelStore.setState({ browserOverlayOpen: true, browserOverlayMaximized: true });
    render(<BrowserHost />);
    expect(await screen.findByRole("group", { name: "Browser" })).toBeVisible();

    act(() =>
      useRightWorkspaceTabsStore.getState().openFile(
        {
          projectId: "project-1",
          worktreePath: "/worktree",
          path: "docs/report.pdf",
        },
        "report.pdf",
        false,
      ),
    );

    await waitFor(() => expect(usePanelStore.getState().browserOverlayOpen).toBe(false));
    expect(document.querySelector("[data-y-space-browser-host]")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(document.querySelector('webview[data-tab-id="page-1"]')).toBeInTheDocument();
  });

  it("keeps restored residents lazy until the panel opens or agent automation starts", async () => {
    seedBrowserPages([browserTab("page-1", "Restored", "https://example.com/restored")], "page-1");
    act(() => useRightWorkspaceTabsStore.getState().openTool("git"));
    usePanelStore.setState({ browserPanelOpen: false });

    render(<BrowserHost />);

    expect(document.querySelector("[data-y-space-browser-host]")).not.toBeInTheDocument();
    expect(document.querySelector("webview")).not.toBeInTheDocument();

    act(() => useBrowserPanelStore.getState().setAutomationActive(true));

    expect(await screen.findByRole("group", { name: "Browser", hidden: true })).toBeInTheDocument();
    expect(document.querySelector('webview[data-tab-id="page-1"]')).toBeInTheDocument();
  });

  it("activates the backing browser page when its first-class global tab is selected", async () => {
    seedBrowserPages(
      [
        browserTab("page-1", "Example", "https://example.com/"),
        browserTab("page-2", "Reference", "https://example.org/"),
      ],
      "page-1",
    );
    render(<BrowserHost />);

    act(() => useRightWorkspaceTabsStore.getState().activateTab("browser:page-2"));

    await waitFor(() =>
      expect(bridge.browserActivateTab).toHaveBeenCalledWith({ tabId: "page-2" }),
    );
  });

  it("turns a user-created page into the selected first-class global tab", async () => {
    const created = browserTab("page-created", "New tab", "https://duckduckgo.com/");
    bridge.browserCreateTab.mockResolvedValue(created);
    usePanelStore.setState({ browserOverlayOpen: true, browserOverlayMaximized: true });
    render(<BrowserHost />);

    fireEvent.click(await screen.findByRole("button", { name: "Open new tab" }));

    await waitFor(() =>
      expect(useRightWorkspaceTabsStore.getState()).toMatchObject({
        activeTabId: "browser:page-created",
        tabs: [
          expect.objectContaining({
            id: "browser:page-created",
            kind: "browser-page",
            browserTabId: "page-created",
          }),
        ],
      }),
    );
  });

  it("ends drawer resizing when the window loses the mouseup", async () => {
    seedBrowserPages([browserTab("page-1", "Example", "https://example.com/")], "page-1");
    usePanelStore.setState({ browserOverlayOpen: true, browserOverlayMaximized: false });
    render(<BrowserHost />);
    const separator = await screen.findByRole("separator", { name: "Resize browser drawer" });

    fireEvent.mouseDown(separator, { clientX: 500 });
    fireEvent.mouseMove(window, { clientX: 450 });
    expect(usePanelStore.getState().browserOverlayDrawerWidth).toBe(570);
    expect(document.body.style.userSelect).toBe("none");
    expect(document.body.style.cursor).toBe("ew-resize");

    fireEvent(window, new Event("blur"));

    expect(document.body.style.userSelect).toBe("");
    expect(document.body.style.cursor).toBe("");
    fireEvent.mouseMove(window, { clientX: 400 });
    expect(usePanelStore.getState().browserOverlayDrawerWidth).toBe(570);
  });

  it("removes drawer resize listeners and body styles when unmounted mid-drag", async () => {
    seedBrowserPages([browserTab("page-1", "Example", "https://example.com/")], "page-1");
    usePanelStore.setState({ browserOverlayOpen: true, browserOverlayMaximized: false });
    const view = render(<BrowserHost />);
    const separator = await screen.findByRole("separator", { name: "Resize browser drawer" });

    fireEvent.mouseDown(separator, { clientX: 500 });
    fireEvent.mouseMove(window, { clientX: 460 });
    expect(usePanelStore.getState().browserOverlayDrawerWidth).toBe(560);

    view.unmount();

    expect(document.body.style.userSelect).toBe("");
    expect(document.body.style.cursor).toBe("");
    fireEvent.mouseMove(window, { clientX: 400 });
    expect(usePanelStore.getState().browserOverlayDrawerWidth).toBe(560);
  });
});
