// @vitest-environment jsdom
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserEvent, BrowserState, BrowserTabInfo } from "@/shared/ipc";
import { useBrowserPanelStore } from "@/renderer/state/browserPanelStore";
import { usePanelStore } from "@/renderer/state/panelStore";
import { useRightWorkspaceTabsStore } from "@/renderer/state/rightWorkspaceTabsStore";
import { useFileEditorStore } from "@/renderer/state/fileEditorStore";
import { WORKSPACE_TAB_CYCLE_EVENT } from "@/renderer/commands/workspaceTabCycle";
import { useBrowserSync } from "./useBrowserSync";

const bridge = vi.hoisted(() => ({
  handlers: [] as Array<(event: BrowserEvent) => void>,
  browserGetState: vi.fn<() => Promise<BrowserState>>(),
  windowKind: "main" as "main" | "browserExtract",
}));

vi.mock("@/renderer/bridge", () => ({
  readBridge: () => ({
    windowKind: bridge.windowKind,
    onBrowserEvent: (handler: (event: BrowserEvent) => void) => {
      bridge.handlers.push(handler);
      return () => {
        const index = bridge.handlers.indexOf(handler);
        if (index >= 0) bridge.handlers.splice(index, 1);
      };
    },
    browserGetState: bridge.browserGetState,
  }),
}));

function Harness() {
  useBrowserSync();
  return null;
}

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

describe("useBrowserSync global Browser routing", () => {
  beforeEach(() => {
    bridge.handlers.length = 0;
    bridge.windowKind = "main";
    bridge.browserGetState.mockReset().mockResolvedValue({ tabs: [], activeTabId: null });
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
    useFileEditorStore.setState({ overlayMode: null });
    usePanelStore.setState({
      rightPanelTab: "git",
      rightPanelSplit: null,
      bottomPanelDocks: { left: null, right: null },
      browserPanelOpen: false,
      browserOverlayOpen: false,
      browserOverlayMaximized: false,
    });
  });

  it("projects browser pages into global tabs without stealing focus from another workspace tab", async () => {
    const first = browserTab("page-1", "Example", "https://example.com/");
    const second = browserTab("page-2", "Reference", "https://example.org/");
    bridge.browserGetState.mockResolvedValue({ tabs: [first, second], activeTabId: second.tabId });
    useRightWorkspaceTabsStore.getState().openTool("git");

    render(<Harness />);

    await waitFor(() =>
      expect(useRightWorkspaceTabsStore.getState().tabs).toEqual([
        expect.objectContaining({ id: "tool:git", kind: "tool", tool: "git" }),
        expect.objectContaining({
          id: "browser:page-1",
          kind: "browser-page",
          browserTabId: "page-1",
          title: "Example",
        }),
        expect.objectContaining({
          id: "browser:page-2",
          kind: "browser-page",
          browserTabId: "page-2",
          title: "Reference",
        }),
      ]),
    );
    expect(useRightWorkspaceTabsStore.getState().activeTabId).toBe("tool:git");
    expect(
      useRightWorkspaceTabsStore.getState().tabs.some((tab) => tab.id === "tool:browser"),
    ).toBe(false);
  });

  it("reconciles opened and closed browser pages without selecting a background agent page", async () => {
    const first = browserTab("page-1", "Example", "https://example.com/");
    const second = browserTab("page-2", "Agent result", "https://example.org/result");
    bridge.browserGetState.mockResolvedValue({ tabs: [first], activeTabId: first.tabId });
    useRightWorkspaceTabsStore.getState().openTool("git");

    render(<Harness />);
    await waitFor(() =>
      expect(useRightWorkspaceTabsStore.getState().tabs).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "browser:page-1" })]),
      ),
    );

    act(() =>
      bridge.handlers[0]?.({
        type: "state",
        state: { tabs: [first, second], activeTabId: second.tabId },
      }),
    );

    expect(useRightWorkspaceTabsStore.getState().tabs).toEqual([
      expect.objectContaining({ id: "tool:git" }),
      expect.objectContaining({ id: "browser:page-1", browserTabId: "page-1" }),
      expect.objectContaining({ id: "browser:page-2", browserTabId: "page-2" }),
    ]);
    expect(useRightWorkspaceTabsStore.getState().activeTabId).toBe("tool:git");

    act(() =>
      bridge.handlers[0]?.({
        type: "state",
        state: { tabs: [second], activeTabId: second.tabId },
      }),
    );

    expect(useRightWorkspaceTabsStore.getState().tabs).toEqual([
      expect.objectContaining({ id: "tool:git" }),
      expect.objectContaining({ id: "browser:page-2", browserTabId: "page-2" }),
    ]);
    expect(useRightWorkspaceTabsStore.getState().activeTabId).toBe("tool:git");
  });

  it("routes a focused guest cycle request through the workspace coordinator", async () => {
    const page = browserTab("page-1", "Example", "https://example.com/");
    bridge.browserGetState.mockResolvedValue({ tabs: [page], activeTabId: page.tabId });
    useRightWorkspaceTabsStore
      .getState()
      .syncBrowserPages(
        [{ browserTabId: page.tabId, title: page.title, url: page.url }],
        page.tabId,
      );
    useRightWorkspaceTabsStore.getState().selectBrowserPage(page.tabId);
    const cycle = vi.fn<(event: Event) => void>();
    window.addEventListener(WORKSPACE_TAB_CYCLE_EVENT, cycle);

    const view = render(<Harness />);
    await waitFor(() => expect(bridge.handlers).toHaveLength(1));
    act(() =>
      bridge.handlers[0]?.({
        type: "workspace-tab-cycle",
        tabId: page.tabId,
        direction: "next",
      }),
    );

    expect(cycle).toHaveBeenCalledOnce();
    const cycleEvent = cycle.mock.calls[0]?.[0];
    expect(cycleEvent).toBeInstanceOf(CustomEvent);
    expect((cycleEvent as CustomEvent).detail).toEqual({ direction: "next" });
    view.unmount();
    window.removeEventListener(WORKSPACE_TAB_CYCLE_EVENT, cycle);
  });

  it("closes the browser overlay when guest close falls back to a non-browser peer", async () => {
    const first = browserTab("page-1", "First", "https://example.com/first");
    const second = browserTab("page-2", "Second", "https://example.com/second");
    bridge.browserGetState.mockResolvedValue({ tabs: [first, second], activeTabId: first.tabId });
    const workspace = useRightWorkspaceTabsStore.getState();
    workspace.syncBrowserPages(
      [
        { browserTabId: first.tabId, title: first.title, url: first.url },
        { browserTabId: second.tabId, title: second.title, url: second.url },
      ],
      first.tabId,
    );
    workspace.openTool("git");
    workspace.reorderTab("tool:git", 1);
    workspace.selectBrowserPage(first.tabId);
    useBrowserPanelStore.setState({ tabs: [first, second], activeTabId: first.tabId });
    usePanelStore.setState({
      browserPanelOpen: true,
      browserOverlayOpen: true,
      browserOverlayMaximized: true,
      rightPanelTab: "browser",
    });

    render(<Harness />);
    await waitFor(() => expect(bridge.handlers).toHaveLength(1));
    act(() =>
      bridge.handlers[0]?.({
        type: "state",
        state: { tabs: [second], activeTabId: second.tabId },
      }),
    );

    expect(useRightWorkspaceTabsStore.getState().activeTabId).toBe("tool:git");
    expect(usePanelStore.getState().browserOverlayOpen).toBe(false);
  });

  it("projects browser pages only from the main window", async () => {
    const page = browserTab("page-1", "Example", "https://example.com/");
    bridge.windowKind = "browserExtract";
    bridge.browserGetState.mockResolvedValue({ tabs: [page], activeTabId: page.tabId });
    useRightWorkspaceTabsStore.getState().openTool("git");

    render(<Harness />);

    await waitFor(() =>
      expect(useBrowserPanelStore.getState()).toMatchObject({
        tabs: [page],
        activeTabId: page.tabId,
      }),
    );
    expect(useRightWorkspaceTabsStore.getState().tabs).toEqual([
      expect.objectContaining({ id: "tool:git" }),
    ]);

    act(() => bridge.handlers[0]?.({ type: "open-panel", mode: "overlay" }));

    expect(useRightWorkspaceTabsStore.getState().activeTabId).toBe("tool:git");
    expect(usePanelStore.getState()).toMatchObject({
      rightPanelTab: "git",
      browserPanelOpen: false,
      browserOverlayOpen: false,
    });
  });

  it("presents an agent-requested browser page without stealing global workspace focus", async () => {
    const pages = Array.from({ length: 7 }, (_, index) =>
      browserTab(`page-${index + 1}`, `Page ${index + 1}`, `https://example.com/${index + 1}`),
    );
    bridge.browserGetState.mockResolvedValue({ tabs: pages, activeTabId: "page-1" });
    useRightWorkspaceTabsStore.getState().openTool("git");

    render(<Harness />);

    await waitFor(() =>
      expect(
        useRightWorkspaceTabsStore.getState().tabs.find((tab) => tab.id === "browser:page-7"),
      ).toMatchObject({ resident: false }),
    );

    act(() => bridge.handlers[0]?.({ type: "ensure-browser-page-resident", tabId: "page-7" }));

    expect(useBrowserPanelStore.getState().activeTabId).toBe("page-7");
    expect(useRightWorkspaceTabsStore.getState().activeTabId).toBe("tool:git");
    expect(
      useRightWorkspaceTabsStore.getState().tabs.find((tab) => tab.id === "browser:page-7"),
    ).toMatchObject({ resident: true });
    expect(
      useRightWorkspaceTabsStore.getState().tabs.find((tab) => tab.id === "browser:page-6"),
    ).toMatchObject({ resident: false });
  });

  it("does not let a stale initial snapshot resurrect a page closed by live state", async () => {
    const page = browserTab("page-1", "Example", "https://example.com/");
    let resolveInitialState!: (state: BrowserState) => void;
    const initialState = new Promise<BrowserState>((resolve) => {
      resolveInitialState = resolve;
    });
    bridge.browserGetState.mockReturnValue(initialState);
    useRightWorkspaceTabsStore.getState().openTool("git");

    render(<Harness />);
    await waitFor(() => expect(bridge.handlers).toHaveLength(1));

    act(() =>
      bridge.handlers[0]?.({
        type: "state",
        state: { tabs: [page], activeTabId: page.tabId },
      }),
    );
    expect(useRightWorkspaceTabsStore.getState().tabs).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "browser:page-1" })]),
    );

    act(() =>
      bridge.handlers[0]?.({
        type: "state",
        state: { tabs: [], activeTabId: null },
      }),
    );
    expect(useRightWorkspaceTabsStore.getState().tabs).toEqual([
      expect.objectContaining({ id: "tool:git" }),
    ]);

    await act(async () => {
      resolveInitialState({ tabs: [page], activeTabId: page.tabId });
      await initialState;
    });

    expect(useBrowserPanelStore.getState().tabs).toEqual([]);
    expect(useRightWorkspaceTabsStore.getState().tabs).toEqual([
      expect.objectContaining({ id: "tool:git" }),
    ]);
  });

  it("merges a live tab update that arrives before the initial snapshot", async () => {
    const stale = browserTab("page-1", "Old title", "https://example.com/old");
    const fresh = browserTab("page-1", "Fresh title", "https://example.com/fresh");
    let resolveInitialState!: (state: BrowserState) => void;
    const initialState = new Promise<BrowserState>((resolve) => {
      resolveInitialState = resolve;
    });
    bridge.browserGetState.mockReturnValue(initialState);
    useRightWorkspaceTabsStore.getState().openTool("git");

    render(<Harness />);
    await waitFor(() => expect(bridge.handlers).toHaveLength(1));

    act(() => bridge.handlers[0]?.({ type: "tab-updated", tab: fresh }));
    await act(async () => {
      resolveInitialState({ tabs: [stale], activeTabId: stale.tabId });
      await initialState;
    });

    expect(useBrowserPanelStore.getState().tabs).toEqual([fresh]);
    expect(
      useRightWorkspaceTabsStore.getState().tabs.find((tab) => tab.id === "browser:page-1"),
    ).toMatchObject({ title: "Fresh title", url: "https://example.com/fresh" });
    expect(useRightWorkspaceTabsStore.getState().activeTabId).toBe("tool:git");
  });

  it("focuses the active first-class browser page when a user or agent explicitly reveals it", async () => {
    const first = browserTab("page-1", "Example", "https://example.com/");
    const second = browserTab("page-2", "Agent result", "https://example.org/result");
    bridge.browserGetState.mockResolvedValue({ tabs: [first, second], activeTabId: second.tabId });
    useRightWorkspaceTabsStore.getState().openTool("git");

    render(<Harness />);
    await waitFor(() =>
      expect(useRightWorkspaceTabsStore.getState().tabs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "browser:page-1" }),
          expect.objectContaining({ id: "browser:page-2" }),
        ]),
      ),
    );

    act(() => bridge.handlers[0]?.({ type: "open-panel", mode: "overlay" }));

    expect(useRightWorkspaceTabsStore.getState()).toMatchObject({
      activeTabId: "browser:page-2",
    });
    expect(
      useRightWorkspaceTabsStore.getState().tabs.some((tab) => tab.id === "tool:browser"),
    ).toBe(false);
    expect(usePanelStore.getState()).toMatchObject({
      rightPanelTab: "browser",
      browserPanelOpen: true,
      browserOverlayOpen: true,
      browserOverlayMaximized: true,
    });
  });
});
