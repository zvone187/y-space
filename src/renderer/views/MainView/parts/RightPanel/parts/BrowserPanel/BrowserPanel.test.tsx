import { act, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserTabInfo } from "@/shared/ipc";
import { renderWithI18n as render } from "@/renderer/testUtils/i18n";
import { useBrowserPanelStore } from "@/renderer/state/browserPanelStore";
import { usePanelStore } from "@/renderer/state/panelStore";
import { useRightWorkspaceTabsStore } from "@/renderer/state/rightWorkspaceTabsStore";
import { BrowserPanel } from "./BrowserPanel";

const bridge = vi.hoisted(() => ({
  browserCreateTab: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  browserAttachWebContents: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  browserReload: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  browserHardReload: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  browserExtractToWindow: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  browserInjectToMain: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
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

vi.mock("./parts/BrowserToolbar", () => ({
  BrowserToolbar: () => <div data-testid="browser-toolbar" />,
}));

vi.mock("@/renderer/bridge", () => ({
  isMac: () => false,
  isWindows: () => false,
  readBridge: () => ({
    browserCreateTab: bridge.browserCreateTab,
    browserAttachWebContents: bridge.browserAttachWebContents,
    browserReload: bridge.browserReload,
    browserHardReload: bridge.browserHardReload,
    browserExtractToWindow: bridge.browserExtractToWindow,
    browserInjectToMain: bridge.browserInjectToMain,
  }),
}));

function setBrowserTabs(tabs: BrowserTabInfo[], activeTabId: string | null) {
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
    ...(tab.sensitiveIntegration === undefined
      ? {}
      : { sensitiveIntegration: tab.sensitiveIntegration }),
    ...(tab.groupId === undefined ? {} : { groupId: tab.groupId }),
  })) as unknown as WorkspaceTabs;
  useRightWorkspaceTabsStore.setState({
    tabs: browserPages,
    activeTabId: activeTabId ? `browser:${activeTabId}` : null,
    previewTabId: null,
    browserPageActivationSequence: tabs.length,
    hidden: false,
  });
}

describe("BrowserPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      browserPanelOpen: false,
      browserOverlayOpen: false,
      browserOverlayMaximized: false,
    });
  });

  it("renders the empty state when there are no tabs", () => {
    const { getByText } = render(<BrowserPanel visible />);
    expect(getByText("No browser tab open")).toBeTruthy();
  });

  it("keeps resident page surfaces laid out while hiding inactive ones", () => {
    setBrowserTabs(
      [
        {
          tabId: "tab-1",
          url: "https://example.com/",
          title: "Example",
          loading: false,
          canGoBack: false,
          canGoForward: false,
        },
        {
          tabId: "tab-2",
          url: "https://example.org/",
          title: "Other",
          loading: false,
          canGoBack: false,
          canGoForward: false,
        },
      ],
      "tab-1",
    );
    const { container } = render(<BrowserPanel visible />);
    const webviews = container.querySelectorAll("webview");
    expect(webviews).toHaveLength(2);
    expect(webviews[0]?.getAttribute("partition")).toBe("persist:lightcode-browser");
    expect(webviews[0]?.getAttribute("allowpopups")).toBe("true");
    expect((webviews[0] as HTMLElement).style.display).toBe("flex");
    expect((webviews[0] as HTMLElement).style.opacity).toBe("1");
    expect((webviews[1] as HTMLElement).style.display).toBe("flex");
    expect((webviews[1] as HTMLElement).style.opacity).toBe("0");
    expect((webviews[1] as HTMLElement).style.pointerEvents).toBe("none");
  });

  it("never renders a nested browser tablist on panel, overlay, or window surfaces", () => {
    setBrowserTabs(
      [
        {
          tabId: "tab-1",
          url: "https://example.com/",
          title: "Example",
          loading: false,
          canGoBack: false,
          canGoForward: false,
        },
      ],
      "tab-1",
    );
    const view = render(<BrowserPanel visible />);

    expect(view.queryByRole("tablist", { name: "Browser tabs" })).not.toBeInTheDocument();

    act(() => {
      usePanelStore.setState({ browserOverlayOpen: true, browserOverlayMaximized: true });
    });
    expect(view.queryByRole("tablist", { name: "Browser tabs" })).not.toBeInTheDocument();

    view.rerender(<BrowserPanel visible surface="window" />);
    expect(view.queryByRole("tablist", { name: "Browser tabs" })).not.toBeInTheDocument();
  });

  it("renders the active page in the extracted window without a second tab strip", () => {
    useBrowserPanelStore.setState({
      tabs: [
        {
          tabId: "tab-window",
          url: "https://window.example/",
          title: "Window page",
          loading: false,
          canGoBack: false,
          canGoForward: false,
        },
      ],
      activeTabId: "tab-window",
    });
    useRightWorkspaceTabsStore.getState().reset();

    const view = render(<BrowserPanel visible surface="window" />);

    expect(view.container.querySelector('webview[data-tab-id="tab-window"]')).toBeInTheDocument();
    expect(view.queryByRole("tablist", { name: "Browser tabs" })).not.toBeInTheDocument();
  });

  it("keeps extracted pages resident by true activation LRU while protecting active and sensitive pages", () => {
    const ordinaryTabs = Array.from({ length: 8 }, (_entry, index) => ({
      tabId: `tab-${index + 1}`,
      url: `https://example.com/${index + 1}`,
      title: `Page ${index + 1}`,
      loading: false,
      canGoBack: false,
      canGoForward: false,
    }));
    const sensitiveTab = {
      tabId: "tab-auth",
      url: "about:blank",
      title: "Secure connection",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      sensitiveIntegration: true as const,
    };
    useBrowserPanelStore.setState({
      tabs: [...ordinaryTabs, sensitiveTab],
      activeTabId: "tab-8",
    });
    useRightWorkspaceTabsStore.getState().reset();
    const view = render(<BrowserPanel visible surface="window" />);
    const mountedTabIds = () =>
      [...view.container.querySelectorAll("webview")]
        .map((webview) => webview.getAttribute("data-tab-id"))
        .sort();

    expect(mountedTabIds()).toEqual([
      "tab-3",
      "tab-4",
      "tab-5",
      "tab-6",
      "tab-7",
      "tab-8",
      "tab-auth",
    ]);

    act(() => useBrowserPanelStore.getState().setActive("tab-1"));
    act(() => useBrowserPanelStore.getState().setActive("tab-2"));
    act(() => useBrowserPanelStore.getState().setActive("tab-4"));

    expect(mountedTabIds()).toEqual([
      "tab-1",
      "tab-2",
      "tab-4",
      "tab-6",
      "tab-7",
      "tab-8",
      "tab-auth",
    ]);
    expect(
      view.container.querySelector<HTMLElement>('webview[data-tab-id="tab-4"]')?.style.opacity,
    ).toBe("1");

    // Backend reordering must not reset activation recency or fall back to the
    // first six metadata entries.
    act(() => {
      useBrowserPanelStore.setState({ tabs: [sensitiveTab, ...ordinaryTabs].reverse() });
    });
    expect(mountedTabIds()).toEqual([
      "tab-1",
      "tab-2",
      "tab-4",
      "tab-6",
      "tab-7",
      "tab-8",
      "tab-auth",
    ]);

    act(() => useBrowserPanelStore.getState().setActive("tab-3"));
    expect(mountedTabIds()).toEqual([
      "tab-1",
      "tab-2",
      "tab-3",
      "tab-4",
      "tab-7",
      "tab-8",
      "tab-auth",
    ]);
  });

  it("mounts only global browser pages marked resident", () => {
    setBrowserTabs(
      [
        {
          tabId: "tab-1",
          url: "https://example.com/",
          title: "Example",
          loading: false,
          canGoBack: false,
          canGoForward: false,
        },
        {
          tabId: "tab-2",
          url: "https://example.org/",
          title: "Suspended",
          loading: false,
          canGoBack: false,
          canGoForward: false,
        },
      ],
      "tab-1",
    );
    useRightWorkspaceTabsStore.setState((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.kind === "browser-page" && tab.browserTabId === "tab-2"
          ? { ...tab, resident: false }
          : tab,
      ),
    }));

    const { container } = render(<BrowserPanel visible />);

    expect(container.querySelectorAll("webview")).toHaveLength(1);
    expect(container.querySelector('webview[data-tab-id="tab-1"]')).toBeInTheDocument();
    expect(container.querySelector('webview[data-tab-id="tab-2"]')).not.toBeInTheDocument();
  });

  it("updates tab group membership from browser state", () => {
    const tab = {
      tabId: "tab-1",
      url: "https://example.com/",
      title: "Example",
      loading: false,
      canGoBack: false,
      canGoForward: false,
    };

    act(() => {
      useBrowserPanelStore.getState().setState({
        tabs: [tab],
        activeTabId: "tab-1",
      });
    });
    expect(useBrowserPanelStore.getState().tabs[0]?.groupId).toBeUndefined();

    act(() => {
      useBrowserPanelStore.getState().setState({
        tabs: [{ ...tab, groupId: "group-1" }],
        activeTabId: "tab-1",
        groups: [{ id: "group-1", title: "Group", color: "purple", collapsed: false }],
      });
    });

    expect(useBrowserPanelStore.getState().tabs[0]?.groupId).toBe("group-1");
  });

  it("keeps the same webview mounted when browser panel goes fullscreen", () => {
    setBrowserTabs(
      [
        {
          tabId: "tab-1",
          url: "https://example.com/",
          title: "Example",
          loading: false,
          canGoBack: false,
          canGoForward: false,
        },
      ],
      "tab-1",
    );
    usePanelStore.setState({
      browserPanelOpen: true,
      browserOverlayOpen: false,
      browserOverlayMaximized: false,
    });
    const { container } = render(<BrowserPanel visible />);
    const webview = container.querySelector("webview");

    act(() => {
      usePanelStore.setState({
        browserOverlayOpen: true,
        browserOverlayMaximized: true,
      });
    });

    expect(container.querySelector("webview")).toBe(webview);
  });

  it("attaches the right-panel webview contents to the browser tab", () => {
    setBrowserTabs(
      [
        {
          tabId: "tab-1",
          url: "https://example.com/",
          title: "Example",
          loading: false,
          canGoBack: false,
          canGoForward: false,
        },
      ],
      "tab-1",
    );
    const { container } = render(<BrowserPanel visible />);
    const webview = container.querySelector("webview") as HTMLElement & {
      getWebContentsId(): number;
    };
    webview.getWebContentsId = vi.fn<() => number>().mockReturnValue(42);

    fireEvent(webview, new Event("dom-ready"));

    expect(bridge.browserAttachWebContents).toHaveBeenCalledWith({
      tabId: "tab-1",
      webContentsId: 42,
    });
  });

  it("reattaches a mounted webview when it becomes visible again", () => {
    setBrowserTabs(
      [
        {
          tabId: "tab-1",
          url: "https://example.com/",
          title: "Example",
          loading: false,
          canGoBack: false,
          canGoForward: false,
        },
      ],
      "tab-1",
    );
    const { container, rerender } = render(<BrowserPanel visible={false} />);
    const webview = container.querySelector("webview") as HTMLElement & {
      getWebContentsId(): number;
    };
    webview.getWebContentsId = vi.fn<() => number>().mockReturnValue(42);
    bridge.browserAttachWebContents.mockClear();

    rerender(<BrowserPanel visible />);

    expect(bridge.browserAttachWebContents).toHaveBeenCalledWith({
      tabId: "tab-1",
      webContentsId: 42,
    });
  });

  it("routes browser panel reload shortcuts to the active tab", () => {
    setBrowserTabs(
      [
        {
          tabId: "tab-1",
          url: "https://example.com/",
          title: "Example",
          loading: false,
          canGoBack: false,
          canGoForward: false,
        },
      ],
      "tab-1",
    );
    const { container } = render(<BrowserPanel visible />);
    const panel = container.firstElementChild as HTMLElement;

    fireEvent.keyDown(panel, { key: "r", ctrlKey: true });
    expect(bridge.browserReload).toHaveBeenCalledWith({ tabId: "tab-1" });

    fireEvent.keyDown(panel, { key: "R", ctrlKey: true, shiftKey: true });
    expect(bridge.browserHardReload).toHaveBeenCalledWith({ tabId: "tab-1" });

    fireEvent.keyDown(panel, { key: "F5" });
    expect(bridge.browserReload).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(panel, { key: "F5", shiftKey: true });
    expect(bridge.browserHardReload).toHaveBeenCalledTimes(2);
  });

  it("does not offer moving the overlay browser to a separate window", () => {
    usePanelStore.setState({
      browserOverlayOpen: true,
      browserOverlayMaximized: true,
    });
    const { queryByTitle } = render(<BrowserPanel visible />);

    expect(queryByTitle("Move browser to window")).not.toBeInTheDocument();
    expect(bridge.browserExtractToWindow).not.toHaveBeenCalled();
  });

  it("moves the separate browser window back into the main window", () => {
    const { getByTitle } = render(<BrowserPanel visible surface="window" />);

    fireEvent.click(getByTitle("Move browser back to main window"));

    expect(bridge.browserInjectToMain).toHaveBeenCalledOnce();
  });
});
