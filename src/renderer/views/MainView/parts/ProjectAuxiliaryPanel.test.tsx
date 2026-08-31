import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "@/shared/contracts";
import { i18n } from "@/renderer/i18n/i18n";
import { useAppStore } from "@/renderer/state/appStore";
import { useBrowserPanelStore } from "@/renderer/state/browserPanelStore";
import { usePanelStore } from "@/renderer/state/panelStore";
import { useRightWorkspaceTabsStore } from "@/renderer/state/rightWorkspaceTabsStore";
import { WORKSPACE_TAB_CYCLE_EVENT } from "@/renderer/commands/workspaceTabCycle";
import { ProjectAuxiliaryPanel } from "./ProjectAuxiliaryPanel";

vi.mock("@/renderer/analytics/useProductViewTracking", () => ({
  productSurfaceView: vi.fn<(tab: string, mode: string) => string>(() => "git"),
  useProductViewTracking: vi.fn<() => void>(),
}));

vi.mock("@/renderer/state/gitRefresh", () => ({
  prefetchVisibleGitPanelPrData: vi.fn<(projectId: string, worktreePath?: string) => Promise<void>>(
    () => Promise.resolve(),
  ),
}));

const bridge = vi.hoisted(() => ({
  browserCreateTab: vi.fn<
    (payload: { url?: string; activate?: boolean }) => Promise<{
      tabId: string;
      url: string;
      title: string;
      loading: boolean;
      canGoBack: boolean;
      canGoForward: boolean;
    }>
  >(),
  browserActivateTab: vi.fn<(payload: { tabId: string }) => Promise<void>>(),
  browserCloseTab: vi.fn<(payload: { tabId: string }) => Promise<void>>(),
}));

vi.mock("@/renderer/bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/renderer/bridge")>()),
  readBridge: () => bridge,
}));

const unifiedRightPanelProps = vi.hoisted(() => ({
  current: null as {
    activeTab: string;
    workspaceTabs?: ReadonlyArray<{ id: string; title: string }>;
    activeWorkspaceTabId?: string | null;
    onWorkspaceTabActivate?: (tabId: string) => void;
    onWorkspaceTabClose?: (tabId: string) => void;
    onOpenBrowser?: () => void;
    onCreateBrowserTab?: () => void;
    onImportBrowserCookies?: () => void;
    onExtractBrowserToWindow?: () => void;
  } | null,
}));

vi.mock("@/renderer/components/layout/UnifiedRightPanel", () => ({
  UnifiedRightPanel: (props: {
    activeTab: string;
    workspaceTabs?: ReadonlyArray<{ id: string; title: string }>;
    activeWorkspaceTabId?: string | null;
    onWorkspaceTabActivate?: (tabId: string) => void;
    onWorkspaceTabClose?: (tabId: string) => void;
    onOpenBrowser?: () => void;
    onCreateBrowserTab?: () => void;
    onImportBrowserCookies?: () => void;
    onExtractBrowserToWindow?: () => void;
  }) => {
    unifiedRightPanelProps.current = props;
    return (
      <div data-testid="workspace-panel" data-poracode-panel="" data-y-space-workspace="">
        {props.workspaceTabs?.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            data-tab-id={tab.id}
            aria-selected={props.activeWorkspaceTabId === tab.id}
            onClick={() => props.onWorkspaceTabActivate?.(tab.id)}
          >
            {tab.title}
          </button>
        ))}
        <button type="button" data-y-space-browser-host="" data-testid="browser-host-focus-target">
          Browser host focus target
        </button>
        <button type="button" data-testid="open-browser" onClick={props.onOpenBrowser}>
          Open Browser
        </button>
        <button type="button" data-testid="new-browser-tab" onClick={props.onCreateBrowserTab}>
          New Browser tab
        </button>
        <button
          type="button"
          data-testid="import-browser-cookies"
          onClick={props.onImportBrowserCookies}
        >
          Import cookies
        </button>
      </div>
    );
  },
}));

function makeThread(id: string, projectId: string, worktreePath: string): Thread {
  const now = "2026-08-03T00:00:00.000Z";
  return {
    id,
    projectId,
    worktreePath,
    title: id,
    agentKind: "codex",
    config: { model: "gpt-5.4" },
    status: "idle",
    attention: "none",
    canResumeWithConfig: false,
    archived: false,
    done: false,
    starred: false,
    createdAt: now,
    updatedAt: now,
  };
}

const threadA = makeThread("thread-a", "project-a", "/worktree-a");
const threadB = makeThread("thread-b", "project-b", "/worktree-b");
const threadC = makeThread("thread-c", "project-c", "/worktree-c");

function focusThread(threadId: string): void {
  useAppStore.setState({
    threads: [threadA, threadB, threadC],
    view: { kind: "thread", panes: [threadId] },
    focusedPaneId: threadId,
  });
}

const browserPage = {
  browserTabId: "page-1",
  title: "Example",
  url: "https://example.com/",
} as const;

function seedBrowserPage(options: { active: boolean; withGit?: boolean } = { active: true }): void {
  const workspace = useRightWorkspaceTabsStore.getState();
  if (options.withGit) workspace.openTool("git");
  workspace.syncBrowserPages([browserPage], browserPage.browserTabId);
  if (options.active) workspace.selectBrowserPage(browserPage.browserTabId);
  useBrowserPanelStore.setState({
    tabs: [
      {
        tabId: browserPage.browserTabId,
        title: browserPage.title,
        url: browserPage.url,
        loading: false,
        canGoBack: false,
        canGoForward: false,
      },
    ],
    activeTabId: options.active ? browserPage.browserTabId : null,
  });
}

describe("ProjectAuxiliaryPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bridge.browserActivateTab.mockResolvedValue(undefined);
    bridge.browserCloseTab.mockResolvedValue(undefined);
    bridge.browserCreateTab.mockResolvedValue({
      tabId: "page-new",
      url: "https://duckduckgo.com",
      title: "DuckDuckGo",
      loading: false,
      canGoBack: false,
      canGoForward: false,
    });
    globalThis.localStorage?.clear();
    useRightWorkspaceTabsStore.getState().reset();
    useBrowserPanelStore.setState({
      tabs: [],
      groups: [],
      activeTabId: null,
      extracted: false,
      attentionTabId: null,
      automationActive: false,
    });
    unifiedRightPanelProps.current = null;
    focusThread(threadA.id);
    usePanelStore.setState({
      gitReviewContext: {
        projectId: threadB.projectId,
        worktreePath: threadB.worktreePath!,
        originComposerId: threadB.id,
      },
      gitReviewAsPanel: true,
      rightPanelFollowsThread: true,
      rightPanelTab: "git",
      filesPanelContext: null,
      browserPanelOpen: false,
      browserOverlayOpen: false,
      browserOverlayMaximized: false,
      usagePanelOpen: false,
      notesPanelOpen: false,
      settingsOpen: false,
      settingsSection: null,
      settingsAnchor: null,
    });
  });

  it("preserves a git badge target when the locked panel opens", async () => {
    render(
      <I18nProvider i18n={i18n}>
        <ProjectAuxiliaryPanel includeTerminal visible />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(usePanelStore.getState().gitReviewContext).toEqual({
        projectId: threadB.projectId,
        worktreePath: threadB.worktreePath!,
        originComposerId: threadB.id,
      });
    });

    act(() => focusThread(threadC.id));

    await waitFor(() => {
      expect(usePanelStore.getState().gitReviewContext).toEqual({
        projectId: threadC.projectId,
        worktreePath: threadC.worktreePath!,
      });
    });
  });

  it("leaves the browser tab when the browser panel was dismissed with it selected", async () => {
    // Closing the last browser tab clears browserPanelOpen over IPC but leaves
    // rightPanelTab on "browser"; the panel must fall back to an open panel
    // instead of rendering an empty browser layer.
    usePanelStore.setState({ rightPanelTab: "browser", browserPanelOpen: false });

    render(
      <I18nProvider i18n={i18n}>
        <ProjectAuxiliaryPanel includeTerminal visible />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(unifiedRightPanelProps.current?.activeTab).toBe("git");
    });
  });

  it("activates a real default peer when restored browser metadata is dormant", async () => {
    seedBrowserPage({ active: false });

    render(
      <I18nProvider i18n={i18n}>
        <ProjectAuxiliaryPanel includeTerminal visible />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(useRightWorkspaceTabsStore.getState().activeTabId).toBe("tool:git");
      expect(unifiedRightPanelProps.current?.activeWorkspaceTabId).toBe("tool:git");
    });
    expect(useRightWorkspaceTabsStore.getState().tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "tool:git", kind: "tool" }),
        expect.objectContaining({ id: "browser:page-1", kind: "browser-page" }),
      ]),
    );
  });

  it("restores a dormant browser page instead of fabricating an unavailable Git tab", async () => {
    usePanelStore.setState({
      gitReviewContext: null,
      gitReviewAsPanel: false,
      rightPanelTab: "git",
      browserPanelOpen: false,
    });
    seedBrowserPage({ active: false });

    render(
      <I18nProvider i18n={i18n}>
        <ProjectAuxiliaryPanel includeTerminal visible />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(useRightWorkspaceTabsStore.getState().activeTabId).toBe("browser:page-1");
      expect(unifiedRightPanelProps.current?.activeWorkspaceTabId).toBe("browser:page-1");
      expect(unifiedRightPanelProps.current?.activeTab).toBe("browser");
      expect(useBrowserPanelStore.getState().activeTabId).toBe(browserPage.browserTabId);
      expect(usePanelStore.getState().browserPanelOpen).toBe(true);
      expect(usePanelStore.getState().rightPanelTab).toBe("browser");
    });
    expect(useRightWorkspaceTabsStore.getState().tabs).not.toContainEqual(
      expect.objectContaining({ id: "tool:git" }),
    );
    expect(bridge.browserActivateTab).toHaveBeenCalledWith({ tabId: browserPage.browserTabId });
  });

  it("selects a first-class browser page, activates its backing page, and opens Browser", async () => {
    seedBrowserPage({ active: false, withGit: true });

    render(
      <I18nProvider i18n={i18n}>
        <ProjectAuxiliaryPanel includeTerminal visible />
      </I18nProvider>,
    );

    fireEvent.click(await screen.findByRole("tab", { name: browserPage.title }));

    await waitFor(() => {
      expect(bridge.browserActivateTab).toHaveBeenCalledWith({ tabId: browserPage.browserTabId });
      expect(useRightWorkspaceTabsStore.getState().activeTabId).toBe("browser:page-1");
      expect(useBrowserPanelStore.getState().activeTabId).toBe(browserPage.browserTabId);
      expect(usePanelStore.getState().browserPanelOpen).toBe(true);
      expect(usePanelStore.getState().rightPanelTab).toBe("browser");
      expect(unifiedRightPanelProps.current?.activeTab).toBe("browser");
    });
    expect(useRightWorkspaceTabsStore.getState().tabs).not.toContainEqual(
      expect.objectContaining({ id: "tool:browser" }),
    );
  });

  it("opens the top-right Browser action as a first-class global page", async () => {
    useRightWorkspaceTabsStore.getState().openTool("git");

    render(
      <I18nProvider i18n={i18n}>
        <ProjectAuxiliaryPanel includeTerminal visible />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByTestId("open-browser"));

    await waitFor(() => {
      expect(bridge.browserCreateTab).toHaveBeenCalledWith({
        url: "https://duckduckgo.com",
        activate: true,
      });
      expect(useRightWorkspaceTabsStore.getState().activeTabId).toBe("browser:page-new");
    });
    expect(useRightWorkspaceTabsStore.getState().tabs).toContainEqual(
      expect.objectContaining({
        id: "browser:page-new",
        kind: "browser-page",
        browserTabId: "page-new",
      }),
    );
    expect(useRightWorkspaceTabsStore.getState().tabs).not.toContainEqual(
      expect.objectContaining({ id: "tool:browser" }),
    );
  });

  it("creates a new independent Browser peer from the global Add tab action", async () => {
    seedBrowserPage({ active: true });
    usePanelStore.setState({ browserPanelOpen: true, rightPanelTab: "browser" });

    render(
      <I18nProvider i18n={i18n}>
        <ProjectAuxiliaryPanel includeTerminal visible />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByTestId("new-browser-tab"));

    await waitFor(() => expect(bridge.browserCreateTab).toHaveBeenCalledOnce());
    expect(useRightWorkspaceTabsStore.getState().tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "browser:page-1" }),
        expect.objectContaining({ id: "browser:page-new" }),
      ]),
    );
  });

  it("deep-links the global Add tab cookie action to the importer", () => {
    render(
      <I18nProvider i18n={i18n}>
        <ProjectAuxiliaryPanel includeTerminal visible />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByTestId("import-browser-cookies"));

    expect(usePanelStore.getState()).toMatchObject({
      settingsOpen: true,
      settingsSection: "browser",
      settingsAnchor: "browser.cookieImport",
    });
  });

  it("does not expose a browser extraction action from the global workspace", () => {
    render(
      <I18nProvider i18n={i18n}>
        <ProjectAuxiliaryPanel includeTerminal visible />
      </I18nProvider>,
    );

    expect(unifiedRightPanelProps.current?.onExtractBrowserToWindow).toBeUndefined();
  });

  it("closes the backing page and unmounts its first-class global entry", async () => {
    seedBrowserPage({ active: true, withGit: true });
    usePanelStore.setState({ browserPanelOpen: true, rightPanelTab: "browser" });

    render(
      <I18nProvider i18n={i18n}>
        <ProjectAuxiliaryPanel includeTerminal visible />
      </I18nProvider>,
    );

    expect(await screen.findByRole("tab", { name: browserPage.title })).toBeInTheDocument();
    act(() => unifiedRightPanelProps.current?.onWorkspaceTabClose?.("browser:page-1"));

    await waitFor(() => {
      expect(bridge.browserCloseTab).toHaveBeenCalledWith({ tabId: browserPage.browserTabId });
      expect(screen.queryByRole("tab", { name: browserPage.title })).not.toBeInTheDocument();
    });
    expect(useRightWorkspaceTabsStore.getState().tabs).toEqual([
      expect.objectContaining({ id: "tool:git" }),
    ]);
    expect(useRightWorkspaceTabsStore.getState().tabs).not.toContainEqual(
      expect.objectContaining({ id: "tool:browser" }),
    );
    expect(usePanelStore.getState().browserPanelOpen).toBe(false);
  });

  it("closes the backing browser page on Ctrl/Cmd+W while the browser host is focused", async () => {
    seedBrowserPage({ active: true, withGit: true });
    usePanelStore.setState({ rightPanelTab: "browser" });
    usePanelStore.getState().setBrowserPanelOpen(true);

    render(
      <I18nProvider i18n={i18n}>
        <ProjectAuxiliaryPanel includeTerminal visible />
      </I18nProvider>,
    );

    const hostTarget = screen.getByTestId("browser-host-focus-target");
    hostTarget.focus();
    expect(hostTarget).toHaveFocus();
    fireEvent.keyDown(hostTarget, { key: "w", ctrlKey: true });

    await waitFor(() =>
      expect(bridge.browserCloseTab).toHaveBeenCalledWith({ tabId: browserPage.browserTabId }),
    );
    expect(useRightWorkspaceTabsStore.getState().tabs).not.toContainEqual(
      expect.objectContaining({ id: "browser:page-1" }),
    );
    expect(useRightWorkspaceTabsStore.getState().activeTabId).toBe("tool:git");
  });

  it("cycles mixed outer tabs through the activation coordinator and restores tab focus", async () => {
    useRightWorkspaceTabsStore.getState().openTool("git");
    seedBrowserPage({ active: false });
    usePanelStore.getState().setUsagePanelOpen(true);
    useRightWorkspaceTabsStore.getState().selectBrowserPage(browserPage.browserTabId);
    usePanelStore.getState().setBrowserPanelOpen(true);
    usePanelStore.setState({
      rightPanelTab: "browser",
      browserOverlayOpen: true,
      browserOverlayMaximized: true,
    });

    render(
      <I18nProvider i18n={i18n}>
        <ProjectAuxiliaryPanel includeTerminal visible />
      </I18nProvider>,
    );
    await waitFor(() =>
      expect(useRightWorkspaceTabsStore.getState().activeTabId).toBe("browser:page-1"),
    );

    act(() => {
      window.dispatchEvent(
        new CustomEvent(WORKSPACE_TAB_CYCLE_EVENT, { detail: { direction: "next" } }),
      );
    });

    await waitFor(() => {
      expect(useRightWorkspaceTabsStore.getState().activeTabId).toBe("tool:usage");
      expect(usePanelStore.getState().rightPanelTab).toBe("usage");
      expect(usePanelStore.getState().browserOverlayOpen).toBe(false);
      expect(document.activeElement).toHaveAttribute("data-tab-id", "tool:usage");
    });
  });
});
