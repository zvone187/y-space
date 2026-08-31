// @vitest-environment jsdom
import { act, render, waitFor } from "@testing-library/react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserAcknowledgeAutomationPresentationPayload,
  BrowserEvent,
  BrowserInvalidateAutomationPresentationPayload,
  BrowserState,
  BrowserTabInfo,
} from "@/shared/ipc";
import { useBrowserPanelStore } from "@/renderer/state/browserPanelStore";
import { usePanelStore } from "@/renderer/state/panelStore";
import { useRightWorkspaceTabsStore } from "@/renderer/state/rightWorkspaceTabsStore";
import { useFileEditorStore } from "@/renderer/state/fileEditorStore";
import {
  notifyBrowserAutomationPresentationObstructed,
  useSensitiveNativeViewOverlayGate,
} from "@/renderer/state/sensitiveNativeViewObstruction";
import { WORKSPACE_TAB_CYCLE_EVENT } from "@/renderer/commands/workspaceTabCycle";
import { useBrowserSync } from "./useBrowserSync";

const documentHasFocus = vi.spyOn(document, "hasFocus");

const bridge = vi.hoisted(() => ({
  handlers: [] as Array<(event: BrowserEvent) => void>,
  browserGetState: vi.fn<() => Promise<BrowserState>>(),
  browserAcknowledgeAutomationPresentation:
    vi.fn<(payload: BrowserAcknowledgeAutomationPresentationPayload) => Promise<void>>(),
  browserInvalidateAutomationPresentation:
    vi.fn<(payload: BrowserInvalidateAutomationPresentationPayload) => Promise<void>>(),
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
    browserAcknowledgeAutomationPresentation: bridge.browserAcknowledgeAutomationPresentation,
    browserInvalidateAutomationPresentation: bridge.browserInvalidateAutomationPresentation,
  }),
}));

function Harness() {
  useBrowserSync();
  return null;
}

function GatedOverlay(props: { open: boolean }) {
  const ready = useSensitiveNativeViewOverlayGate(props.open);
  return ready ? <div data-testid="ordinary-obstruction-overlay" /> : null;
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

function mountPresentedWebview(tabId: string, surface: "main" | "extracted"): HTMLElement {
  const container = document.createElement("div");
  if (surface === "main") {
    container.setAttribute("data-y-space-browser-host", "");
    container.setAttribute("aria-hidden", "false");
  }
  const browser = document.createElement("div");
  browser.setAttribute("data-poracode-browser", "");
  const webview = document.createElement("webview");
  webview.dataset.tabId = tabId;
  webview.setAttribute("aria-hidden", "false");
  webview.style.display = "flex";
  webview.style.opacity = "1";
  webview.style.pointerEvents = "auto";
  webview.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      top: 0,
      right: 800,
      bottom: 600,
      left: 0,
      width: 800,
      height: 600,
      toJSON: () => ({}),
    }) as DOMRect;
  browser.append(webview);
  container.append(browser);
  document.body.append(container);
  return container;
}

describe("useBrowserSync global Browser routing", () => {
  beforeEach(() => {
    documentHasFocus.mockReturnValue(true);
    bridge.handlers.length = 0;
    bridge.windowKind = "main";
    bridge.browserGetState.mockReset().mockResolvedValue({ tabs: [], activeTabId: null });
    bridge.browserAcknowledgeAutomationPresentation.mockReset().mockResolvedValue(undefined);
    bridge.browserInvalidateAutomationPresentation.mockReset().mockResolvedValue(undefined);
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

  afterAll(() => {
    documentHasFocus.mockRestore();
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

  it("keeps residency headless until an interactive action presents the exact browser page", async () => {
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

    act(() =>
      bridge.handlers[0]?.({
        type: "state",
        state: { tabs: pages, activeTabId: "page-7" },
      }),
    );
    expect(useRightWorkspaceTabsStore.getState().activeTabId).toBe("tool:git");

    act(() => bridge.handlers[0]?.({ type: "open-panel", mode: "panel" }));

    expect(useRightWorkspaceTabsStore.getState().activeTabId).toBe("browser:page-7");
    expect(usePanelStore.getState()).toMatchObject({
      rightPanelTab: "browser",
      browserPanelOpen: true,
      browserOverlayOpen: false,
    });
    expect(
      useRightWorkspaceTabsStore.getState().tabs.find((tab) => tab.id === "browser:page-6"),
    ).toMatchObject({ resident: false });
  });

  it("acknowledges an exact main-window browser page only after its webview paints", async () => {
    const first = browserTab("page-1", "First", "https://example.com/first");
    const target = browserTab("page-2", "Target", "https://example.com/target");
    bridge.browserGetState.mockResolvedValue({ tabs: [first, target], activeTabId: first.tabId });
    useRightWorkspaceTabsStore.getState().openTool("git");
    const presented = mountPresentedWebview(target.tabId, "main");

    const view = render(<Harness />);
    await waitFor(() => expect(bridge.handlers).toHaveLength(1));
    act(() =>
      bridge.handlers[0]?.({
        type: "automation-presentation-request",
        requestId: "1b74121a-44ed-4ec0-aa75-68a5f4fb03ed",
        tabId: target.tabId,
        surface: "main",
      }),
    );

    await waitFor(() =>
      expect(bridge.browserAcknowledgeAutomationPresentation).toHaveBeenCalledWith({
        requestId: "1b74121a-44ed-4ec0-aa75-68a5f4fb03ed",
        tabId: target.tabId,
        surface: "main",
        presented: true,
      }),
    );
    expect(useRightWorkspaceTabsStore.getState().activeTabId).toBe("browser:page-2");
    expect(usePanelStore.getState()).toMatchObject({
      browserPanelOpen: true,
      rightPanelTab: "browser",
    });
    view.unmount();
    presented.remove();
  });

  it("keeps a user-hidden workspace hidden while granting exact background browser automation", async () => {
    const target = browserTab("page-hidden", "Background", "https://example.com/background");
    bridge.browserGetState.mockResolvedValue({ tabs: [target], activeTabId: target.tabId });
    const presented = mountPresentedWebview(target.tabId, "main");

    const view = render(<Harness />);
    await waitFor(() =>
      expect(
        useRightWorkspaceTabsStore.getState().tabs.some((tab) => tab.id === "browser:page-hidden"),
      ).toBe(true),
    );
    act(() => {
      const workspace = useRightWorkspaceTabsStore.getState();
      workspace.selectBrowserPage(target.tabId);
      workspace.hide();
      usePanelStore.setState({ browserPanelOpen: true, rightPanelTab: "browser" });
    });

    act(() =>
      bridge.handlers[0]?.({
        type: "automation-presentation-request",
        requestId: "beaa2ef6-6957-4e3f-8d91-e78b47471c9c",
        tabId: target.tabId,
        surface: "main",
      }),
    );

    await waitFor(() =>
      expect(bridge.browserAcknowledgeAutomationPresentation).toHaveBeenCalledWith({
        requestId: "beaa2ef6-6957-4e3f-8d91-e78b47471c9c",
        tabId: target.tabId,
        surface: "main",
        presented: true,
      }),
    );
    expect(useRightWorkspaceTabsStore.getState()).toMatchObject({
      hidden: true,
      activeTabId: "browser:page-hidden",
    });
    expect(usePanelStore.getState().browserPanelOpen).toBe(true);
    view.unmount();
    presented.remove();
  });

  it("keeps presentation valid when focus moves into the selected embedded guest", async () => {
    const target = browserTab("page-2", "Target", "https://example.com/target");
    bridge.browserGetState.mockResolvedValue({ tabs: [target], activeTabId: target.tabId });
    documentHasFocus.mockReturnValue(false);
    const presented = mountPresentedWebview(target.tabId, "main");

    const view = render(<Harness />);
    await waitFor(() => expect(bridge.handlers).toHaveLength(1));
    act(() =>
      bridge.handlers[0]?.({
        type: "automation-presentation-request",
        requestId: "7fb0c76e-89f8-4d71-958f-e2a16d47f58e",
        tabId: target.tabId,
        surface: "main",
      }),
    );

    await waitFor(() =>
      expect(bridge.browserAcknowledgeAutomationPresentation).toHaveBeenCalledWith({
        requestId: "7fb0c76e-89f8-4d71-958f-e2a16d47f58e",
        tabId: target.tabId,
        surface: "main",
        presented: true,
      }),
    );
    window.dispatchEvent(new Event("blur"));
    await act(async () => Promise.resolve());
    expect(bridge.browserInvalidateAutomationPresentation).not.toHaveBeenCalled();
    view.unmount();
    presented.remove();
  });

  it("revokes an acknowledged presentation when an async menu preview becomes ready", async () => {
    const target = browserTab("page-2", "Target", "https://example.com/target");
    bridge.browserGetState.mockResolvedValue({ tabs: [target], activeTabId: target.tabId });
    const presented = mountPresentedWebview(target.tabId, "main");
    let resolvePreview!: () => void;
    const previewReady = new Promise<void>((resolve) => {
      resolvePreview = resolve;
    });
    const previewObstructed = previewReady.then(() =>
      notifyBrowserAutomationPresentationObstructed(),
    );

    const view = render(<Harness />);
    await waitFor(() => expect(bridge.handlers).toHaveLength(1));
    act(() =>
      bridge.handlers[0]?.({
        type: "automation-presentation-request",
        requestId: "6360917c-2dc5-45f2-9ca4-6523ff733f45",
        tabId: target.tabId,
        surface: "main",
      }),
    );
    await waitFor(() =>
      expect(bridge.browserAcknowledgeAutomationPresentation).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: "6360917c-2dc5-45f2-9ca4-6523ff733f45",
          presented: true,
        }),
      ),
    );

    await act(async () => {
      resolvePreview();
      await previewObstructed;
    });

    expect(bridge.browserInvalidateAutomationPresentation).toHaveBeenCalledWith({
      requestId: "6360917c-2dc5-45f2-9ca4-6523ff733f45",
      tabId: target.tabId,
      surface: "main",
      reason: "obstructed",
    });
    view.unmount();
    presented.remove();
  });

  it("blocks overlay paint on ordinary-tab invalidation and rejects presentation while obstructed", async () => {
    const target = browserTab("page-2", "Target", "https://example.com/target");
    bridge.browserGetState.mockResolvedValue({ tabs: [target], activeTabId: target.tabId });
    const presented = mountPresentedWebview(target.tabId, "main");
    let finishInvalidation!: () => void;
    const invalidationCompleted = new Promise<void>((resolve) => {
      finishInvalidation = resolve;
    });

    const view = render(
      <>
        <Harness />
        <GatedOverlay open={false} />
      </>,
    );
    await waitFor(() => expect(bridge.handlers).toHaveLength(1));
    act(() =>
      bridge.handlers[0]?.({
        type: "automation-presentation-request",
        requestId: "410df163-722b-48b7-a989-e8cf518ca43b",
        tabId: target.tabId,
        surface: "main",
      }),
    );
    await waitFor(() =>
      expect(bridge.browserAcknowledgeAutomationPresentation).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: "410df163-722b-48b7-a989-e8cf518ca43b",
          presented: true,
        }),
      ),
    );

    bridge.browserInvalidateAutomationPresentation.mockImplementationOnce(
      () => invalidationCompleted,
    );
    view.rerender(
      <>
        <Harness />
        <GatedOverlay open />
      </>,
    );

    await waitFor(() =>
      expect(bridge.browserInvalidateAutomationPresentation).toHaveBeenCalledWith({
        requestId: "410df163-722b-48b7-a989-e8cf518ca43b",
        tabId: target.tabId,
        surface: "main",
        reason: "obstructed",
      }),
    );
    expect(view.queryByTestId("ordinary-obstruction-overlay")).not.toBeInTheDocument();

    await act(async () => {
      finishInvalidation();
      await invalidationCompleted;
      await Promise.resolve();
    });
    expect(view.getByTestId("ordinary-obstruction-overlay")).toBeInTheDocument();

    act(() =>
      bridge.handlers[0]?.({
        type: "automation-presentation-request",
        requestId: "14557b4c-01c6-40e0-8d8b-72c5c0f5a39c",
        tabId: target.tabId,
        surface: "main",
      }),
    );
    await waitFor(() =>
      expect(bridge.browserAcknowledgeAutomationPresentation).toHaveBeenCalledWith({
        requestId: "14557b4c-01c6-40e0-8d8b-72c5c0f5a39c",
        tabId: target.tabId,
        surface: "main",
        presented: false,
      }),
    );

    view.unmount();
    presented.remove();
  });

  it("revokes the presentation capability when the user switches to another global tab", async () => {
    const target = browserTab("page-2", "Target", "https://example.com/target");
    bridge.browserGetState.mockResolvedValue({ tabs: [target], activeTabId: target.tabId });
    useRightWorkspaceTabsStore.getState().openTool("git");
    const presented = mountPresentedWebview(target.tabId, "main");

    const view = render(<Harness />);
    await waitFor(() => expect(bridge.handlers).toHaveLength(1));
    act(() =>
      bridge.handlers[0]?.({
        type: "automation-presentation-request",
        requestId: "28415d6c-84ca-48a4-9247-ab5207f465d5",
        tabId: target.tabId,
        surface: "main",
      }),
    );
    await waitFor(() =>
      expect(bridge.browserAcknowledgeAutomationPresentation).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: "28415d6c-84ca-48a4-9247-ab5207f465d5",
          presented: true,
        }),
      ),
    );

    act(() => useRightWorkspaceTabsStore.getState().openTool("git"));

    await waitFor(() =>
      expect(bridge.browserInvalidateAutomationPresentation).toHaveBeenCalledWith({
        requestId: "28415d6c-84ca-48a4-9247-ab5207f465d5",
        tabId: target.tabId,
        surface: "main",
        reason: "workspace-tab-changed",
      }),
    );
    view.unmount();
    presented.remove();
  });

  it("fails a presentation acknowledgement when the exact webview did not paint", async () => {
    const target = browserTab("page-1", "Target", "https://example.com/target");
    bridge.browserGetState.mockResolvedValue({ tabs: [target], activeTabId: target.tabId });

    const view = render(<Harness />);
    await waitFor(() => expect(bridge.handlers).toHaveLength(1));
    act(() =>
      bridge.handlers[0]?.({
        type: "automation-presentation-request",
        requestId: "64e7a4e0-d9ee-4a72-8818-672038641635",
        tabId: target.tabId,
        surface: "main",
      }),
    );

    await waitFor(() =>
      expect(bridge.browserAcknowledgeAutomationPresentation).toHaveBeenCalledWith({
        requestId: "64e7a4e0-d9ee-4a72-8818-672038641635",
        tabId: target.tabId,
        surface: "main",
        presented: false,
      }),
    );
    view.unmount();
  });

  it("acknowledges the exact active page from the extracted browser renderer", async () => {
    const first = browserTab("page-1", "First", "https://example.com/first");
    const target = browserTab("page-2", "Target", "https://example.com/target");
    bridge.windowKind = "browserExtract";
    bridge.browserGetState.mockResolvedValue({
      tabs: [first, target],
      activeTabId: first.tabId,
      extracted: true,
    });
    const presented = mountPresentedWebview(target.tabId, "extracted");

    const view = render(<Harness />);
    await waitFor(() => expect(bridge.handlers).toHaveLength(1));
    act(() =>
      bridge.handlers[0]?.({
        type: "automation-presentation-request",
        requestId: "ea67c301-12a3-4e03-bf59-19af93e11840",
        tabId: target.tabId,
        surface: "extracted",
      }),
    );

    await waitFor(() =>
      expect(bridge.browserAcknowledgeAutomationPresentation).toHaveBeenCalledWith({
        requestId: "ea67c301-12a3-4e03-bf59-19af93e11840",
        tabId: target.tabId,
        surface: "extracted",
        presented: true,
      }),
    );
    expect(useBrowserPanelStore.getState().activeTabId).toBe(target.tabId);
    expect(useRightWorkspaceTabsStore.getState().tabs).toEqual([]);
    view.unmount();
    presented.remove();
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
