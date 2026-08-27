import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useBrowserPanelStore } from "@/renderer/state/browserPanelStore";
import { renderWithI18n as render } from "@/renderer/testUtils/i18n";
import type { PoracodeBridge } from "@/shared/ipc";
import { BrowserTabStrip } from "./BrowserTabStrip";

const bridge = vi.hoisted(() => ({
  browserActivateTab: vi.fn<PoracodeBridge["browserActivateTab"]>(async () => undefined),
  browserMoveTab: vi.fn<PoracodeBridge["browserMoveTab"]>(async () => undefined),
  browserCloseTab: vi.fn<PoracodeBridge["browserCloseTab"]>(async () => undefined),
  browserSetGroupCollapsed: vi.fn<PoracodeBridge["browserSetGroupCollapsed"]>(
    async () => undefined,
  ),
}));

vi.mock("@/renderer/bridge", () => ({ readBridge: () => bridge }));

const tabs = [
  {
    tabId: "tab-1",
    url: "https://one.example/",
    title: "One",
    loading: false,
    canGoBack: false,
    canGoForward: false,
  },
  {
    tabId: "tab-2",
    url: "https://two.example/",
    title: "Two",
    loading: false,
    canGoBack: false,
    canGoForward: false,
  },
  {
    tabId: "tab-3",
    url: "https://three.example/",
    title: "Three",
    loading: false,
    canGoBack: false,
    canGoForward: false,
  },
];

describe("BrowserTabStrip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useBrowserPanelStore.setState({
      tabs: [],
      groups: [],
      activeTabId: null,
      attentionTabId: null,
    });
  });

  it("exposes tablist semantics with one selected, roving-focus tab", () => {
    useBrowserPanelStore.setState({ tabs, activeTabId: "tab-2" });

    render(<BrowserTabStrip onCreateTab={vi.fn<() => void>()} />);

    expect(screen.getByRole("tablist", { name: "Browser tabs" })).toBeInTheDocument();
    const renderedTabs = screen.getAllByRole("tab");
    expect(renderedTabs).toHaveLength(3);
    expect(screen.getByRole("tab", { name: "Two" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Two" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: "One" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tab", { name: "One" })).toHaveAttribute("tabindex", "-1");
  });

  it("moves focus and selection with Arrow, Home, and End keys", () => {
    useBrowserPanelStore.setState({ tabs, activeTabId: "tab-2" });
    render(<BrowserTabStrip onCreateTab={vi.fn<() => void>()} />);
    const two = screen.getByRole("tab", { name: "Two" });
    two.focus();

    fireEvent.keyDown(two, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Three" }));
    expect(bridge.browserActivateTab).toHaveBeenLastCalledWith({ tabId: "tab-3" });

    fireEvent.keyDown(screen.getByRole("tab", { name: "Three" }), { key: "Home" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "One" }));
    expect(bridge.browserActivateTab).toHaveBeenLastCalledWith({ tabId: "tab-1" });

    fireEvent.keyDown(screen.getByRole("tab", { name: "One" }), { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Three" }));
    expect(bridge.browserActivateTab).toHaveBeenLastCalledWith({ tabId: "tab-3" });

    fireEvent.keyDown(screen.getByRole("tab", { name: "Three" }), { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "One" }));
    expect(bridge.browserActivateTab).toHaveBeenLastCalledWith({ tabId: "tab-1" });
  });

  it("reorders tabs with Alt+Shift+Arrow while leaving plain arrows for selection", () => {
    useBrowserPanelStore.setState({ tabs, activeTabId: "tab-2" });
    render(<BrowserTabStrip onCreateTab={vi.fn<() => void>()} />);
    const two = screen.getByRole("tab", { name: "Two" });

    fireEvent.keyDown(two, { key: "ArrowLeft", altKey: true, shiftKey: true });
    expect(bridge.browserMoveTab).toHaveBeenLastCalledWith({
      tabId: "tab-2",
      targetTabId: "tab-1",
      position: "before",
    });

    fireEvent.keyDown(two, { key: "ArrowRight", altKey: true, shiftKey: true });
    expect(bridge.browserMoveTab).toHaveBeenLastCalledWith({
      tabId: "tab-2",
      targetTabId: "tab-3",
      position: "after",
    });
  });

  it("keeps the replacement active tab selected and focusable after a group collapses", () => {
    const groupedTab = { ...tabs[0]!, groupId: "group-agent" };
    const group = {
      id: "group-agent",
      title: "Y Space",
      color: "purple" as const,
      collapsed: false,
    };
    useBrowserPanelStore.setState({
      tabs: [groupedTab, tabs[1]!],
      groups: [group],
      activeTabId: groupedTab.tabId,
    });
    render(<BrowserTabStrip onCreateTab={vi.fn<() => void>()} />);

    fireEvent.click(screen.getByTitle("Collapse group"));
    expect(bridge.browserSetGroupCollapsed).toHaveBeenCalledWith({
      groupId: "group-agent",
      collapsed: true,
    });

    act(() => {
      useBrowserPanelStore.setState({
        groups: [{ ...group, collapsed: true }],
        activeTabId: "tab-2",
      });
    });

    expect(screen.queryByRole("tab", { name: "One" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Two" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Two" })).toHaveAttribute("tabindex", "0");
  });

  it("moves keyboard focus and selection to the next tab after closing", async () => {
    useBrowserPanelStore.setState({ tabs, activeTabId: "tab-2" });
    render(<BrowserTabStrip onCreateTab={vi.fn<() => void>()} />);
    const closeTwo = screen.getAllByRole("button", { name: "Close tab" })[1]!;
    closeTwo.focus();

    fireEvent.keyDown(closeTwo, { key: "Enter" });

    await waitFor(() => expect(bridge.browserCloseTab).toHaveBeenCalledWith({ tabId: "tab-2" }));
    await waitFor(() => expect(bridge.browserActivateTab).toHaveBeenCalledWith({ tabId: "tab-3" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Three" })),
    );
  });

  it("moves focus and selection to the adjacent tab after clicking close", async () => {
    useBrowserPanelStore.setState({ tabs, activeTabId: "tab-2" });
    render(<BrowserTabStrip onCreateTab={vi.fn<() => void>()} />);
    const closeTwo = screen.getAllByRole("button", { name: "Close tab" })[1]!;
    closeTwo.focus();

    fireEvent.click(closeTwo);

    await waitFor(() => expect(bridge.browserCloseTab).toHaveBeenCalledWith({ tabId: "tab-2" }));
    await waitFor(() => expect(bridge.browserActivateTab).toHaveBeenCalledWith({ tabId: "tab-3" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Three" })),
    );
  });

  it("moves keyboard focus to New tab after closing the last tab", async () => {
    useBrowserPanelStore.setState({ tabs: [tabs[0]!], activeTabId: "tab-1" });
    render(<BrowserTabStrip onCreateTab={vi.fn<() => void>()} />);
    const closeOne = screen.getByRole("button", { name: "Close tab" });
    closeOne.focus();

    fireEvent.keyDown(closeOne, { key: " " });

    await waitFor(() => expect(bridge.browserCloseTab).toHaveBeenCalledWith({ tabId: "tab-1" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "New tab" })),
    );
    expect(bridge.browserActivateTab).not.toHaveBeenCalled();
  });

  it("renders a localized status for a semantic sensitive-integration tab", () => {
    useBrowserPanelStore.setState({
      tabs: [
        {
          ...tabs[0]!,
          url: "about:blank",
          title: "",
          sensitiveIntegration: true,
        },
      ],
      activeTabId: "tab-1",
    });

    render(<BrowserTabStrip onCreateTab={vi.fn<() => void>()} />);

    expect(screen.getByRole("tab", { name: "Connecting…" })).toBeInTheDocument();
  });

  it("renders the first tab after mounting with no tabs", () => {
    const { getByText, queryByRole } = render(
      <BrowserTabStrip onCreateTab={vi.fn<() => void>()} />,
    );

    expect(queryByRole("button", { name: "New tab" })).toBeTruthy();

    act(() => {
      useBrowserPanelStore.setState({
        tabs: [
          {
            tabId: "tab-1",
            url: "https://example.com/",
            title: "Example",
            loading: false,
            canGoBack: false,
            canGoForward: false,
          },
        ],
        activeTabId: "tab-1",
      });
    });

    expect(getByText("Example")).toBeTruthy();
    expect(queryByRole("button", { name: "New tab" })).toBeTruthy();
  });
});
