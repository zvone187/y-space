import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef } from "react";
import { useLingui } from "@lingui/react/macro";
import { toast } from "@heroui/react";
import { isHomeProjectId } from "@/shared/homeScope";
import { readBridge } from "@/renderer/bridge";
import {
  productSurfaceView,
  useProductViewTracking,
} from "@/renderer/analytics/useProductViewTracking";
import { BrowserDockSlot } from "@/renderer/views/MainView/parts/RightPanel/parts/BrowserPanel/BrowserDockSlot";
import { injectBrowserToMain } from "@/renderer/views/MainView/parts/RightPanel/parts/BrowserPanel/browserWindowActions";
import { DevTerminalPanel } from "@/renderer/views/MainView/parts/RightPanel/parts/DevTerminalPanel/DevTerminalPanel";
import {
  UnifiedRightPanel,
  type RightPanelTab,
} from "@/renderer/components/layout/UnifiedRightPanel";
import { ProjectFilesPanel } from "@/renderer/views/FileEditorOverlay/parts/ProjectFilesPanel";
import { WorkspaceDocumentPanel } from "@/renderer/components/files/WorkspaceDocumentPanel";
import { NotesPanel } from "@/renderer/views/MainView/parts/RightPanel/parts/NotesPanel/NotesPanel";
import { UsagePanel } from "@/renderer/views/MainView/parts/RightPanel/parts/UsagePanel/UsagePanel";
import { UsagePanelHeaderActions } from "@/renderer/views/MainView/parts/RightPanel/parts/UsagePanel/parts/UsagePanelHeaderActions";
import {
  SubAgentContent,
  SubAgentHeaderText,
} from "@/renderer/components/thread/ChatPane/parts/items/SubAgentOverlay";
import { ThreadTodoDock } from "@/renderer/components/thread/ThreadTodoDock";
import { selectThreadTodoDockState } from "@/renderer/components/thread/threadTodoState";
import { useAppStore } from "@/renderer/state/appStore";
import { useBrowserPanelStore } from "@/renderer/state/browserPanelStore";
import { useDevTerminalStore } from "@/renderer/state/devTerminalStore";
import { useFileEditorStore, type FileEditorRootContext } from "@/renderer/state/fileEditorStore";
import {
  selectAnyObstructingOverlayOpen,
  usePanelStore,
  type GitReviewContext,
} from "@/renderer/state/panelStore";
import { useRightWorkspaceTabsStore } from "@/renderer/state/rightWorkspaceTabsStore";
import {
  adjacentRightWorkspaceTabId,
  rightWorkspaceToolTabId,
} from "@/renderer/state/rightWorkspaceTabs";
import { useThreadTodoDockStore } from "@/renderer/state/threadTodoDockStore";
import { watchRemoteTerminal } from "@/renderer/state/remoteTerminalFeed";
import { prefetchVisibleGitPanelPrData } from "@/renderer/state/gitRefresh";
import {
  moveThreadTodoDock,
  createBrowserPanelTab,
  openBrowserPanel,
  showFilesPanel,
  showGitReviewPanel,
  undockPanelTab,
} from "@/renderer/actions/panelActions";
import { showTerminalPanel } from "@/renderer/actions/terminalActions";
import { getCurrentProjectId } from "@/renderer/actions/currentProject";
import { WORKSPACE_TAB_CYCLE_EVENT } from "@/renderer/commands/workspaceTabCycle";
import { selectFocusedThreadId, useFocusedThreadId } from "@/renderer/hooks/uiSelectors";
import { syncRightPanelTabToFocusedThread } from "@/renderer/hooks/useRightPanelThreadLock";
import { formatProjectScopeLabel } from "@/renderer/utils/projectScopeLabel";
import { useBottomDockedTabs } from "@/renderer/state/panelDockSelectors";
import { GitReviewPanelContent } from "./RightPanel/parts/GitReviewPanelContent";
import { resolveFilesRootContext } from "./RightPanel/parts/resolveFilesRootContext";

interface PanelProjectScope {
  projectId: string;
  worktreePath?: string;
}

function scopeFromGitContext(context: GitReviewContext | null): PanelProjectScope | null {
  if (!context) return null;
  return {
    projectId: context.projectId,
    ...(context.worktreePath ? { worktreePath: context.worktreePath } : {}),
  };
}

function scopeFromFilesContext(context: FileEditorRootContext | null): PanelProjectScope | null {
  if (!context) return null;
  return {
    projectId: context.projectId,
    ...(context.worktreePath ? { worktreePath: context.worktreePath } : {}),
  };
}

export function ProjectAuxiliaryPanel(props: { includeTerminal: boolean; visible: boolean }) {
  const { t } = useLingui();
  const projects = useAppStore((s) => s.projects);
  const gitReviewContext = usePanelStore((s) => s.gitReviewContext);
  const gitReviewAsPanel = usePanelStore((s) => s.gitReviewAsPanel);
  const filesPanelContext = usePanelStore((s) => s.filesPanelContext);
  const subAgentPanelContext = usePanelStore((s) => s.subAgentPanelContext);
  const rightPanelTab = usePanelStore((s) => s.rightPanelTab);
  const rightPanelSplit = usePanelStore((s) => s.rightPanelSplit);
  const bottomDocks = useBottomDockedTabs();
  const dockedTabs = [bottomDocks.left, bottomDocks.right].filter(
    (tab): tab is RightPanelTab => tab !== null,
  );
  const isBottomDocked = (tab: RightPanelTab) => dockedTabs.includes(tab);
  const setRightPanelTab = usePanelStore((s) => s.setRightPanelTab);
  const rightPanelFollowsThread = usePanelStore((s) => s.rightPanelFollowsThread);
  const toggleRightPanelFollowsThread = usePanelStore((s) => s.toggleRightPanelFollowsThread);
  const browserPanelOpen = usePanelStore((s) => s.browserPanelOpen);
  const browserExtracted = useBrowserPanelStore((s) => s.extracted);
  const usagePanelOpen = usePanelStore((s) => s.usagePanelOpen);
  const setUsagePanelOpen = usePanelStore((s) => s.setUsagePanelOpen);
  const notesPanelOpen = usePanelStore((s) => s.notesPanelOpen);
  const setNotesPanelOpen = usePanelStore((s) => s.setNotesPanelOpen);
  // Reactive id of the project the notes panel should show — recomputed (and
  // re-rendered) as the user navigates between threads/drafts/projects.
  const currentProjectId = useAppStore(() => getCurrentProjectId());
  const setBrowserPanelOpen = usePanelStore((s) => s.setBrowserPanelOpen);
  const setBrowserOverlayOpen = usePanelStore((s) => s.setBrowserOverlayOpen);
  const setBrowserOverlayMaximized = usePanelStore((s) => s.setBrowserOverlayMaximized);
  const setGitReviewContext = usePanelStore((s) => s.setGitReviewContext);
  const setGitOverlayOpen = usePanelStore((s) => s.setGitOverlayOpen);
  const editorTabs = useFileEditorStore((s) => s.tabs);
  const editorPreviewTab = useFileEditorStore((s) => s.previewTab);
  const workspaceTabs = useRightWorkspaceTabsStore((s) => s.tabs);
  const activeWorkspaceTabId = useRightWorkspaceTabsStore((s) => s.activeTabId);
  const activeWorkspaceTab = workspaceTabs.find((tab) => tab.id === activeWorkspaceTabId);
  const restorableBrowserTabId = workspaceTabs.find(
    (tab) => tab.kind === "browser-page",
  )?.browserTabId;
  const terminalOpen = useDevTerminalStore((s) => s.isOpen);
  const terminalProjectId = useDevTerminalStore((s) => s.activeProjectId);
  const terminalWorktreePath = useDevTerminalStore((s) => s.activeWorktreePath);
  const terminalProject = projects.find((project) => project.id === terminalProjectId);
  const currentThreadId = useFocusedThreadId();
  const todoDockPlacement = useThreadTodoDockStore((state) =>
    currentThreadId
      ? (state.byThreadId[currentThreadId]?.placement ?? state.defaultPlacement)
      : "composer",
  );
  const todoDockCollapsed = useThreadTodoDockStore((state) =>
    currentThreadId
      ? (state.byThreadId[currentThreadId]?.collapsed ?? state.defaultCollapsed)
      : false,
  );
  const retiredTodoSourceItemId = useThreadTodoDockStore((state) =>
    currentThreadId ? state.byThreadId[currentThreadId]?.retiredSourceItemId : undefined,
  );
  const todoDockState = useAppStore((state) =>
    currentThreadId && todoDockPlacement === "right"
      ? selectThreadTodoDockState(state, currentThreadId)
      : null,
  );

  const gitPanelOpen = !!gitReviewContext && gitReviewAsPanel;
  const filesPanelOpen = filesPanelContext !== null;
  const subAgentItemExists = useAppStore((state) =>
    subAgentPanelContext
      ? state.runtimeItemsByIdByThread[subAgentPanelContext.threadId]?.[
          subAgentPanelContext.parentItemId
        ] !== undefined
      : false,
  );
  const subAgentInCurrentThread =
    subAgentPanelContext !== null &&
    subAgentPanelContext.threadId === currentThreadId &&
    subAgentItemExists;
  const planInCurrentThread =
    currentThreadId !== null &&
    todoDockPlacement === "right" &&
    todoDockState !== null &&
    todoDockState.sourceItemId !== retiredTodoSourceItemId;

  const previousGitReviewContextRef = useRef<GitReviewContext | null>(null);
  const gitReviewContextChanged = previousGitReviewContextRef.current !== gitReviewContext;
  previousGitReviewContextRef.current = gitReviewContext;

  const lastGitPanelContextRef = useRef(gitReviewContext);
  if (gitReviewContext && gitReviewAsPanel) {
    lastGitPanelContextRef.current = gitReviewContext;
  }
  const gitPanelContext = gitPanelOpen ? gitReviewContext : lastGitPanelContextRef.current;

  const lastFilesPanelContextRef = useRef(filesPanelContext);
  if (filesPanelContext) {
    lastFilesPanelContextRef.current = filesPanelContext;
  }
  const rawFilesPanelContext = filesPanelOpen
    ? filesPanelContext
    : lastFilesPanelContextRef.current;
  const resolvedFilesPanelContext = resolveFilesRootContext(rawFilesPanelContext, projects);

  const requestedTab: RightPanelTab = props.includeTerminal
    ? rightPanelTab === "ports"
      ? "git"
      : rightPanelTab
    : rightPanelTab === "files" ||
        rightPanelTab === "browser" ||
        rightPanelTab === "usage" ||
        rightPanelTab === "notes" ||
        rightPanelTab === "plan" ||
        rightPanelTab === "subagent"
      ? rightPanelTab
      : "git";

  function requestedTabIsAvailable(): boolean {
    // A bottom-docked tab already renders in the bottom row.
    if (isBottomDocked(requestedTab)) return false;
    if (requestedTab === "subagent") return subAgentInCurrentThread;
    if (requestedTab === "plan") return planInCurrentThread;
    // The browser panel is dismissed out-of-band when its last tab closes (the
    // browser sync clears browserPanelOpen but leaves rightPanelTab pointing at
    // "browser"), so it must honor its open flag even when no plan is present —
    // otherwise the panel stays open on an empty browser layer.
    if (requestedTab === "browser") return browserPanelOpen;
    if (requestedTab === "terminal") return terminalOpen;
    if (requestedTab === "files") return filesPanelOpen;
    if (requestedTab === "git") return gitPanelOpen;
    if (requestedTab === "usage") return usagePanelOpen;
    return requestedTab === "notes" && notesPanelOpen;
  }

  function fallbackActiveTab(): RightPanelTab {
    if (planInCurrentThread) return "plan";
    if (subAgentInCurrentThread) return "subagent";
    if (filesPanelOpen && !isBottomDocked("files")) return "files";
    if (gitPanelOpen && !isBottomDocked("git")) return "git";
    if (browserPanelOpen && !isBottomDocked("browser")) return "browser";
    if (usagePanelOpen && !isBottomDocked("usage")) return "usage";
    if (notesPanelOpen && !isBottomDocked("notes")) return "notes";
    if (props.includeTerminal && terminalOpen) return "terminal";
    if (restorableBrowserTabId && !isBottomDocked("browser")) return "browser";
    return "git";
  }

  const activeTab = requestedTabIsAvailable() ? requestedTab : fallbackActiveTab();
  const activateBrowserPage = useCallback(
    (browserTabId: string) => {
      if (browserExtracted) injectBrowserToMain();
      useBrowserPanelStore.getState().setActive(browserTabId);
      setBrowserPanelOpen(true);
      setRightPanelTab("browser");
      void readBridge()
        .browserActivateTab({ tabId: browserTabId })
        .catch(() => {});
    },
    [browserExtracted, setBrowserPanelOpen, setRightPanelTab],
  );
  useLayoutEffect(() => {
    if (!props.visible || activeWorkspaceTabId !== null) return;
    const workspace = useRightWorkspaceTabsStore.getState();
    if (activeTab === "browser") {
      const browser = useBrowserPanelStore.getState();
      const browserTabId =
        browser.activeTabId ??
        workspace.tabs.find((tab) => tab.kind === "browser-page")?.browserTabId;
      if (browserTabId) {
        workspace.selectBrowserPage(browserTabId);
        activateBrowserPage(browserTabId);
      }
      return;
    }
    if (activeTab !== "ports") workspace.openTool(activeTab);
  }, [activateBrowserPage, activeTab, activeWorkspaceTabId, props.visible, workspaceTabs]);

  useEffect(() => {
    if (!props.visible) return;
    const workspace = useRightWorkspaceTabsStore.getState();
    if (planInCurrentThread) workspace.ensureTool("plan");
    if (subAgentInCurrentThread) workspace.ensureTool("subagent");
  }, [planInCurrentThread, props.visible, subAgentInCurrentThread]);

  useEffect(() => {
    if (activeWorkspaceTab?.kind !== "file") return;
    useFileEditorStore.getState().setActivePath(activeWorkspaceTab.file.path);
  }, [activeWorkspaceTab]);

  useEffect(() => {
    if (activeWorkspaceTab?.kind === "browser-page") {
      if (rightPanelTab !== "browser") setRightPanelTab("browser");
      return;
    }
    if (activeWorkspaceTab?.kind === "tool" && activeWorkspaceTab.tool !== rightPanelTab) {
      setRightPanelTab(activeWorkspaceTab.tool);
    }
  }, [activeWorkspaceTab, rightPanelTab, setRightPanelTab]);

  useEffect(() => {
    const workspace = useRightWorkspaceTabsStore.getState();
    for (const tab of workspaceTabs) {
      if (
        tab.kind === "file" &&
        tab.preview &&
        editorTabs.includes(tab.file.path) &&
        editorPreviewTab !== tab.file.path
      ) {
        workspace.pinPreview(tab.id);
      }
    }
  }, [editorPreviewTab, editorTabs, workspaceTabs]);

  useEffect(() => {
    if (!props.visible) return;
    let refreshTimer: number | undefined;
    const frame = requestAnimationFrame(() => {
      // A new git context is an explicit target (for example, clicking thread
      // B's badge while thread A is focused). Let that open win; the follow
      // lock will take over again on the next thread or tab change.
      if (activeTab !== "git" || !gitReviewContextChanged) {
        syncRightPanelTabToFocusedThread(activeTab);
      }
      if (activeTab !== "git") return;

      // Let the thread and linked-panel frames paint before paying for PR I/O.
      // The prefetch itself gates on gh availability + GitHub remote, and also
      // throttles and deduplicates per project.
      refreshTimer = window.setTimeout(() => {
        const app = useAppStore.getState();
        if (selectFocusedThreadId(app) !== currentThreadId) return;
        const thread = app.threads.find((item) => item.id === currentThreadId);
        if (!thread || isHomeProjectId(thread.projectId)) return;
        void prefetchVisibleGitPanelPrData(thread.projectId, thread.worktreePath);
      }, 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    };
  }, [
    activeTab,
    currentThreadId,
    gitReviewContext,
    gitReviewContextChanged,
    props.visible,
    rightPanelFollowsThread,
  ]);
  useProductViewTracking(productSurfaceView(activeTab, "panel"), "panel", {
    active: props.visible,
    finishWhenInactive: true,
  });

  const gitScope = scopeFromGitContext(gitPanelContext);
  const filesScope = scopeFromFilesContext(resolvedFilesPanelContext);
  const terminalScope: PanelProjectScope | null = terminalProjectId
    ? {
        projectId: terminalProjectId,
        ...(terminalWorktreePath ? { worktreePath: terminalWorktreePath } : {}),
      }
    : null;

  function fallbackScope(): PanelProjectScope | null {
    const firstProject = projects[0];
    return firstProject ? { projectId: firstProject.id } : null;
  }

  function activeProjectScope(): PanelProjectScope | null {
    if (activeWorkspaceTab?.kind === "file") {
      return {
        projectId: activeWorkspaceTab.file.projectId,
        ...(activeWorkspaceTab.file.worktreePath
          ? { worktreePath: activeWorkspaceTab.file.worktreePath }
          : {}),
      };
    }
    if (activeTab === "terminal") return terminalScope ?? filesScope ?? gitScope;
    if (activeTab === "files") return filesScope ?? gitScope ?? terminalScope;
    if (activeTab === "git") return gitScope ?? filesScope ?? terminalScope;
    return filesScope ?? gitScope ?? terminalScope;
  }

  function projectNameForScope(scope: PanelProjectScope | null): string | undefined {
    if (!scope) return undefined;
    return projects.find((p) => p.id === scope.projectId)?.name;
  }

  const notesProjectId = currentProjectId ?? resolveNextProjectScope()?.projectId;

  function resolveProjectName(): string | undefined {
    if (activeWorkspaceTab?.kind === "file") return activeWorkspaceTab.title;
    switch (activeTab) {
      case "browser":
        return t`Browser`;
      case "usage":
        return t`Usage`;
      case "notes":
        return notesProjectId ? projectNameForScope({ projectId: notesProjectId }) : t`Notes`;
      case "terminal": {
        const terminalProjectName = projectNameForScope(terminalScope);
        return terminalProjectName
          ? formatProjectScopeLabel(terminalProjectName, terminalWorktreePath ?? undefined)
          : undefined;
      }
      case "subagent":
      case "plan":
        return undefined;
      case "files":
        return resolvedFilesPanelContext?.rootLabel ?? projectNameForScope(activeProjectScope());
      default:
        return projectNameForScope(activeProjectScope());
    }
  }
  const projectName = resolveProjectName();
  const isHomeScope = isHomeProjectId(activeProjectScope()?.projectId);

  function resolveNextProjectScope(): PanelProjectScope | null {
    return activeProjectScope() ?? fallbackScope();
  }

  /**
   * Clicking a toolbar icon always lands the tab in this panel, so a tab that
   * currently lives in the split half or the bottom row is pulled back first —
   * otherwise the click would have no visible effect.
   */
  function pressTab(tab: RightPanelTab, open: () => void) {
    undockPanelTab(tab);
    open();
    if (tab !== "ports" && tab !== "browser") {
      useRightWorkspaceTabsStore.getState().openTool(tab);
    }
  }

  function handleOpenGit() {
    const scope = resolveNextProjectScope();
    if (!scope) return;
    showGitReviewPanel(scope.projectId, scope.worktreePath);
  }

  function handleOpenFiles() {
    const scope = resolveNextProjectScope();
    if (!scope) return;
    showFilesPanel(scope.projectId, scope.worktreePath);
  }

  function handleOpenTerminal() {
    const scope = resolveNextProjectScope();
    if (!scope) return;
    showTerminalPanel(scope.projectId, scope.worktreePath);
  }

  function activateWorkspaceTab(tabId: string) {
    const workspace = useRightWorkspaceTabsStore.getState();
    const tab = workspace.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    if (tab.kind !== "browser-page") setBrowserOverlayOpen(false);
    workspace.activateTab(tabId);

    if (tab.kind === "file") {
      useFileEditorStore.getState().setActivePath(tab.file.path);
      return;
    }

    if (tab.kind === "browser-page") {
      activateBrowserPage(tab.browserTabId);
      return;
    }

    switch (tab.tool) {
      case "files":
        pressTab("files", handleOpenFiles);
        return;
      case "git":
        pressTab("git", handleOpenGit);
        return;
      case "terminal":
        pressTab("terminal", handleOpenTerminal);
        return;
      case "usage":
        pressTab("usage", () => {
          setUsagePanelOpen(true);
          setRightPanelTab("usage");
        });
        return;
      case "notes":
        pressTab("notes", () => {
          setNotesPanelOpen(true);
          setRightPanelTab("notes");
        });
        return;
      case "plan":
        if (renderPlanContent) setRightPanelTab("plan");
        return;
      case "subagent":
        if (renderSubAgentContent) setRightPanelTab("subagent");
        return;
    }
  }

  const activateWorkspaceTabFromEffect = useEffectEvent((tabId: string) => {
    activateWorkspaceTab(tabId);
  });

  function closeWorkspaceTab(tabId: string) {
    const workspace = useRightWorkspaceTabsStore.getState();
    const tab = workspace.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;

    if (tab.kind === "file") {
      const editor = useFileEditorStore.getState();
      const buffer = editor.buffers[tab.file.path];
      if (
        buffer?.status === "ready" &&
        buffer.isDirty &&
        !window.confirm(t`Discard unsaved changes in ${tab.file.path}?`)
      ) {
        return;
      }
      editor.closeTab(tab.file.path);
      workspace.closeTab(tabId);
    } else if (tab.kind === "browser-page") {
      // Remove the global entry immediately so React unmounts the webview and
      // its DOM listeners; the manager close then destroys CDP/network/dialog
      // state and its authoritative state event confirms the removal.
      workspace.closeBrowserPage(tab.browserTabId);
      void readBridge()
        .browserCloseTab({ tabId: tab.browserTabId })
        .catch(() => {});
      if (
        !useRightWorkspaceTabsStore
          .getState()
          .tabs.some((candidate) => candidate.kind === "browser-page")
      ) {
        setBrowserPanelOpen(false);
      }
    } else {
      workspace.closeTab(tabId);
      switch (tab.tool) {
        case "files":
          usePanelStore.getState().setFilesPanelContext(null);
          break;
        case "git":
          usePanelStore.getState().setGitReviewContext(null);
          break;
        case "usage":
          setUsagePanelOpen(false);
          break;
        case "notes":
          setNotesPanelOpen(false);
          break;
        case "terminal":
          useDevTerminalStore.getState().closePanel();
          break;
        case "plan":
          if (currentThreadId) moveThreadTodoDock(currentThreadId, "composer");
          break;
        case "subagent":
          usePanelStore.getState().setSubAgentPanelContext(null);
          break;
      }
    }

    const nextActiveId = useRightWorkspaceTabsStore.getState().activeTabId;
    if (nextActiveId) activateWorkspaceTab(nextActiveId);
  }

  useEffect(() => {
    if (!props.visible) return undefined;
    const handleCycle = (event: Event) => {
      const direction =
        event instanceof CustomEvent && event.detail?.direction === "previous"
          ? "previous"
          : "next";
      const workspace = useRightWorkspaceTabsStore.getState();
      const nextTabId = adjacentRightWorkspaceTabId(
        workspace.tabs,
        workspace.activeTabId,
        direction,
      );
      if (!nextTabId) return;
      activateWorkspaceTab(nextTabId);
      requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>('[data-y-space-workspace] [role="tab"][aria-selected="true"]')
          ?.focus();
      });
    };
    window.addEventListener(WORKSPACE_TAB_CYCLE_EVENT, handleCycle);
    return () => window.removeEventListener(WORKSPACE_TAB_CYCLE_EVENT, handleCycle);
  });

  function handleClose() {
    useRightWorkspaceTabsStore.getState().hide();
  }

  function handleCloseSubAgent() {
    closeWorkspaceTab(rightWorkspaceToolTabId("subagent"));
  }

  // A bottom-docked tab renders in the bottom row; keep it out of this panel so
  // singleton surfaces (the browser webview) are never mounted twice.
  const renderTerminalContent = props.includeTerminal && terminalOpen;
  const renderGitContent = gitPanelOpen && !isBottomDocked("git");
  const renderFilesContent = filesPanelOpen && !isBottomDocked("files");
  const renderBrowserContent = browserPanelOpen && !isBottomDocked("browser");
  const renderUsageContent = usagePanelOpen && !isBottomDocked("usage");
  const renderNotesContent =
    notesPanelOpen && notesProjectId !== undefined && !isBottomDocked("notes");
  const renderPlanContent = planInCurrentThread;
  const renderSubAgentContent = subAgentInCurrentThread;

  useEffect(() => {
    const workspace = useRightWorkspaceTabsStore.getState();
    const staleIds = workspace.tabs
      .filter(
        (tab) =>
          tab.kind === "tool" &&
          ((tab.tool === "terminal" && !terminalOpen) ||
            (tab.tool === "plan" && !renderPlanContent) ||
            (tab.tool === "subagent" && !renderSubAgentContent)),
      )
      .map((tab) => tab.id);
    if (staleIds.length === 0) return;
    const activeWasClosed = staleIds.includes(workspace.activeTabId ?? "");
    for (const tabId of staleIds) workspace.closeTab(tabId);
    const nextWorkspace = useRightWorkspaceTabsStore.getState();
    const nextTab = nextWorkspace.tabs.find((tab) => tab.id === nextWorkspace.activeTabId);
    if (!activeWasClosed || !nextTab) return;
    activateWorkspaceTabFromEffect(nextTab.id);
  }, [renderPlanContent, renderSubAgentContent, setRightPanelTab, terminalOpen]);

  useEffect(() => {
    if (!props.visible) return undefined;
    const handleWorkspaceShortcut = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        (!event.metaKey && !event.ctrlKey) ||
        event.altKey ||
        event.shiftKey
      ) {
        return;
      }
      const target = event.target;
      const insideBrowserHost =
        target instanceof Element && target.closest("[data-y-space-browser-host]") !== null;
      const insideWorkspace =
        target instanceof Element &&
        (target.closest("[data-poracode-panel]") !== null || insideBrowserHost);
      if (
        !insideWorkspace ||
        (insideBrowserHost && activeWorkspaceTab?.kind !== "browser-page") ||
        selectAnyObstructingOverlayOpen() ||
        usePanelStore.getState().browserOverlayOpen
      ) {
        return;
      }
      const workspace = useRightWorkspaceTabsStore.getState();
      const tabId = workspace.activeTabId;
      if (!tabId) return;
      const selectedWorkspaceTab = workspace.tabs.find((tab) => tab.id === tabId);
      if (event.key.toLowerCase() === "s" && selectedWorkspaceTab?.kind === "file") {
        event.preventDefault();
        void useFileEditorStore
          .getState()
          .saveFile(selectedWorkspaceTab.file.path)
          .catch((error) => toast.danger(error instanceof Error ? error.message : String(error)));
        return;
      }
      if (event.key.toLowerCase() !== "w") return;
      event.preventDefault();
      closeWorkspaceTab(tabId);
    };
    window.addEventListener("keydown", handleWorkspaceShortcut);
    return () => window.removeEventListener("keydown", handleWorkspaceShortcut);
  });

  return (
    <UnifiedRightPanel
      activeTab={activeTab}
      onTabChange={(tab) => {
        if (tab === "subagent" && !renderSubAgentContent) return;
        if (tab === "plan" && !renderPlanContent) return;
        if (tab === "browser") {
          pressTab("browser", openBrowserPanel);
          return;
        }
        pressTab(tab, () => setRightPanelTab(tab));
      }}
      workspaceTabs={workspaceTabs}
      activeWorkspaceTabId={activeWorkspaceTabId}
      documentContent={
        activeWorkspaceTab?.kind === "file" ? (
          <WorkspaceDocumentPanel key={activeWorkspaceTab.id} tab={activeWorkspaceTab} />
        ) : undefined
      }
      onWorkspaceTabActivate={activateWorkspaceTab}
      onWorkspaceTabClose={closeWorkspaceTab}
      onWorkspaceTabReorder={(tabId, toIndex) =>
        useRightWorkspaceTabsStore.getState().reorderTab(tabId, toIndex)
      }
      {...(renderTerminalContent
        ? {
            terminalContent: (
              <DevTerminalPanel
                hideHeader
                {...(terminalProject?.remoteServerId
                  ? {
                      watchTerminal: (terminalId, listener) =>
                        watchRemoteTerminal(terminalProject.remoteServerId!, terminalId, listener),
                    }
                  : {})}
              />
            ),
          }
        : {})}
      gitContent={
        renderGitContent ? (
          <GitReviewPanelContent
            gitPanelContext={gitPanelContext}
            onClose={() => setGitReviewContext(null)}
            onExpandToOverlay={() => setGitOverlayOpen(true)}
          />
        ) : undefined
      }
      filesContent={
        renderFilesContent && resolvedFilesPanelContext ? (
          <ProjectFilesPanel rootContext={resolvedFilesPanelContext} />
        ) : undefined
      }
      browserContent={
        renderBrowserContent ? (
          <BrowserDockSlot extracted={browserExtracted} onBringBack={injectBrowserToMain} />
        ) : undefined
      }
      usageContent={renderUsageContent ? <UsagePanel /> : undefined}
      notesContent={
        renderNotesContent && notesProjectId ? (
          <NotesPanel key={notesProjectId} projectId={notesProjectId} />
        ) : undefined
      }
      {...(renderPlanContent && currentThreadId && todoDockState
        ? {
            planContent: (
              <ThreadTodoDock
                collapsed={todoDockCollapsed}
                placement="right"
                state={todoDockState}
                onCollapsedChange={(collapsed) =>
                  useThreadTodoDockStore.getState().setCollapsed(currentThreadId, collapsed)
                }
                onPlacementChange={(placement) => moveThreadTodoDock(currentThreadId, placement)}
                onRetire={() =>
                  useThreadTodoDockStore
                    .getState()
                    .retire(currentThreadId, todoDockState.sourceItemId)
                }
              />
            ),
          }
        : {})}
      subagentContent={
        renderSubAgentContent ? (
          <SubAgentContent
            key={`${subAgentPanelContext.threadId}:${subAgentPanelContext.parentItemId}`}
            threadId={subAgentPanelContext.threadId}
            parentItemId={subAgentPanelContext.parentItemId}
            hideHeader
            {...(subAgentPanelContext.projectLocation
              ? { projectLocation: subAgentPanelContext.projectLocation }
              : {})}
          />
        ) : undefined
      }
      usageHeaderActions={
        <UsagePanelHeaderActions dragControlClass="poracode-overlay-header__controls" />
      }
      showTerminalTab={props.includeTerminal}
      showFilesTab={!isHomeScope}
      showGitTab={!isHomeScope}
      showNotesTab={notesProjectId !== undefined}
      showPlanTab={renderPlanContent}
      showSubagentTab={renderSubAgentContent}
      {...(renderSubAgentContent
        ? {
            subagentModel: (
              <SubAgentHeaderText
                threadId={subAgentPanelContext.threadId}
                parentItemId={subAgentPanelContext.parentItemId}
                compact
                part="description"
              />
            ),
            subagentTitle: (
              <SubAgentHeaderText
                threadId={subAgentPanelContext.threadId}
                parentItemId={subAgentPanelContext.parentItemId}
                compact
                part="title"
              />
            ),
            onCloseSubagent: handleCloseSubAgent,
          }
        : {})}
      projectName={projectName}
      onExpandGitToOverlay={() => setGitOverlayOpen(true)}
      onExpandBrowserToOverlay={() => {
        setBrowserOverlayMaximized(true);
        setBrowserOverlayOpen(true);
      }}
      onOpenGit={() => pressTab("git", handleOpenGit)}
      onOpenFiles={() => pressTab("files", handleOpenFiles)}
      {...(props.includeTerminal
        ? { onOpenTerminal: () => pressTab("terminal", handleOpenTerminal) }
        : {})}
      onOpenBrowser={() =>
        pressTab("browser", () => {
          if (browserExtracted) {
            injectBrowserToMain();
          }
          openBrowserPanel();
        })
      }
      onCreateBrowserTab={createBrowserPanelTab}
      onImportBrowserCookies={() =>
        usePanelStore.getState().openSettingsSection("browser", "browser.cookieImport")
      }
      onOpenUsage={() =>
        pressTab("usage", () => {
          setUsagePanelOpen(true);
          setRightPanelTab("usage");
        })
      }
      onOpenNotes={() =>
        pressTab("notes", () => {
          setNotesPanelOpen(true);
          setRightPanelTab("notes");
        })
      }
      followsThread={rightPanelFollowsThread}
      onToggleFollowsThread={toggleRightPanelFollowsThread}
      dockedTabs={dockedTabs}
      {...(rightPanelSplit && !isBottomDocked(rightPanelSplit.tab)
        ? {
            splitTab: rightPanelSplit.tab,
            splitPlacement: rightPanelSplit.placement,
            onCloseSplit: () => usePanelStore.getState().setRightPanelSplit(null),
          }
        : {})}
      onClose={handleClose}
    />
  );
}
