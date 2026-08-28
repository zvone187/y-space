import type { ProjectLocation, Thread } from "@/shared/contracts";
import { BROWSER_HOME_URL } from "@/shared/browserDefaults";
import type { BrowserTabInfo } from "@/shared/ipc";
import { toast } from "@heroui/react";
import { friendlyError } from "@/shared/messages";
import { readBridge } from "@/renderer/bridge";
import { useAppStore } from "@/renderer/state/appStore";
import { useBrowserPanelStore } from "@/renderer/state/browserPanelStore";
import { useDevTerminalStore } from "@/renderer/state/devTerminalStore";
import { useFileEditorStore } from "@/renderer/state/fileEditorStore";
import {
  DOCKABLE_PANEL_TABS,
  usePanelStore,
  type PanelDockTarget,
  type RightPanelTab,
} from "@/renderer/state/panelStore";
import { remoteOwner } from "@/renderer/state/remoteProjection";
import { useRemoteServersStore } from "@/renderer/state/remoteServersStore";
import { useSharedSettings } from "@/renderer/state/sharedSettingsStore";
import { useRightWorkspaceTabsStore } from "@/renderer/state/rightWorkspaceTabsStore";
import {
  rightWorkspaceToolTabId,
  type RightWorkspaceBrowserPage,
} from "@/renderer/state/rightWorkspaceTabs";
import {
  useThreadTodoDockStore,
  type ThreadTodoDockPlacement,
} from "@/renderer/state/threadTodoDockStore";
import { buildFileEditorContext, resolveWorktreeBranch } from "@/renderer/utils/gitHelpers";
import { closeThreads } from "@/renderer/utils/shellUtils";
import { resolveActivePaneId } from "./currentProject";
import { showTerminalPanel } from "./terminalActions";
import { fileEditorRootsMatch, switchFileEditorRoot } from "./fileEditorRootActions";

function panelContextMatchesThread(
  projectId: string,
  worktreePath: string | undefined,
  ctxProjectId: string,
  ctxWorktreePath: string | undefined,
): boolean {
  if (ctxProjectId !== projectId) return false;
  if (worktreePath) return ctxWorktreePath === worktreePath;
  return ctxWorktreePath === undefined;
}

function toWorkspaceBrowserPage(tab: BrowserTabInfo): RightWorkspaceBrowserPage {
  return {
    browserTabId: tab.tabId,
    url: tab.url,
    title: tab.sensitiveIntegration ? "Connecting…" : tab.title || tab.url || "New tab",
    ...(tab.sensitiveIntegration ? { sensitiveIntegration: true } : {}),
    ...(tab.groupId ? { groupId: tab.groupId } : {}),
  };
}

function focusWorkspaceBrowserPage(tab: BrowserTabInfo): void {
  const workspace = useRightWorkspaceTabsStore.getState();
  const exists = workspace.tabs.some(
    (candidate) => candidate.kind === "browser-page" && candidate.browserTabId === tab.tabId,
  );
  if (exists) workspace.selectBrowserPage(tab.tabId);
  else workspace.openBrowserPage(toWorkspaceBrowserPage(tab));
}

/** Clear git, files, file editor, and worktree dev-terminal tabs for this thread's project/worktree. */
export function closePanelsForUnloadedThread(thread: Thread): void {
  const { projectId, worktreePath } = thread;
  const panelStore = usePanelStore.getState();

  if (
    panelStore.gitReviewContext &&
    panelContextMatchesThread(
      projectId,
      worktreePath,
      panelStore.gitReviewContext.projectId,
      panelStore.gitReviewContext.worktreePath,
    )
  ) {
    panelStore.setGitOverlayOpen(false);
    panelStore.setGitReviewContext(null);
  }

  if (
    panelStore.filesPanelContext &&
    panelContextMatchesThread(
      projectId,
      worktreePath,
      panelStore.filesPanelContext.projectId,
      panelStore.filesPanelContext.worktreePath,
    )
  ) {
    panelStore.setFilesPanelContext(null);
  }

  if (panelStore.subAgentPanelContext?.threadId === thread.id) {
    panelStore.setSubAgentPanelContext(null);
  }

  const fileRoot = useFileEditorStore.getState().rootContext;
  if (
    fileRoot &&
    panelContextMatchesThread(projectId, worktreePath, fileRoot.projectId, fileRoot.worktreePath)
  ) {
    useFileEditorStore.getState().clearSession();
  }

  if (worktreePath) {
    const removedTabIds = useDevTerminalStore.getState().removeTabsForWorktree(worktreePath);
    if (removedTabIds.length > 0) {
      void closeThreads(removedTabIds);
    }
  }
}

export function openSettings(): void {
  usePanelStore.getState().openSettings();
}

export function openUsageSettings(): void {
  usePanelStore.getState().openSettingsSection("usage");
}

export function openRemoteAccessSettings(): void {
  usePanelStore.getState().openSettingsSection("remoteAccess");
}

export function openChangelogSettings(): void {
  usePanelStore.getState().openSettingsSection("changelog");
}

export function openWorkspaceSettings(): void {
  usePanelStore.getState().openSettingsSection("workspaces");
}

/** Open or focus the singleton Usage workspace tab. */
export function openUsagePanel(): void {
  const panelStore = usePanelStore.getState();
  undockPanelTab("usage");
  panelStore.openUsagePanel();
}

/** Open or focus the singleton Notes workspace tab. */
export function openNotesPanel(): void {
  const panelStore = usePanelStore.getState();
  undockPanelTab("notes");
  panelStore.openNotesPanel();
}

/** Open or focus the active first-class Browser page and clear legacy docking. */
export function openBrowserPanel(): void {
  const panelStore = usePanelStore.getState();
  undockPanelTab("browser");
  panelStore.openBrowserPanel();

  const browser = useBrowserPanelStore.getState();
  const managerPage =
    browser.tabs.find((tab) => tab.tabId === browser.activeTabId) ?? browser.tabs[0];
  if (managerPage) {
    focusWorkspaceBrowserPage(managerPage);
    if (browser.activeTabId !== managerPage.tabId) {
      void readBridge()
        .browserActivateTab({ tabId: managerPage.tabId })
        .catch(() => {});
    }
    return;
  }

  const workspace = useRightWorkspaceTabsStore.getState();
  const existingPage = workspace.tabs.find(
    (tab): tab is Extract<(typeof workspace.tabs)[number], { kind: "browser-page" }> =>
      tab.kind === "browser-page",
  );
  if (existingPage) {
    workspace.selectBrowserPage(existingPage.browserTabId);
    void readBridge()
      .browserActivateTab({ tabId: existingPage.browserTabId })
      .catch(() => {});
    return;
  }

  // The bridge emits browser state before this promise resolves, allowing the
  // headless host to attach the new webview. Only apply the eventual focus if
  // the user has not selected another global tab while creation was pending.
  const activeTabIdAtRequest = workspace.activeTabId;
  void readBridge()
    .browserCreateTab({ url: BROWSER_HOME_URL, activate: true })
    .then((created) => {
      const currentWorkspace = useRightWorkspaceTabsStore.getState();
      if (
        !usePanelStore.getState().browserPanelOpen ||
        currentWorkspace.activeTabId !== activeTabIdAtRequest
      ) {
        return;
      }
      focusWorkspaceBrowserPage(created);
    })
    .catch(() => {});
}

/** Command binding entry point; Browser launch is intentionally idempotent. */
export function toggleBrowserPanel(): void {
  openBrowserPanel();
}

export function openProjectSettings(projectId: string): void {
  const project = useAppStore.getState().projects.find((candidate) => candidate.id === projectId);
  const owner = remoteOwner(project);
  if (owner) {
    void useRemoteServersStore
      .getState()
      .loadProjectSettings(owner.desktopId, owner.remoteId)
      .catch((error) => toast.danger(friendlyError(error)));
  }
  usePanelStore.getState().openProjectSettings(projectId);
}

export function moveThreadTodoDock(threadId: string, placement: ThreadTodoDockPlacement): void {
  useThreadTodoDockStore.getState().setPlacement(threadId, placement);
  if (placement === "right") {
    usePanelStore.getState().setRightPanelTab("plan");
    useRightWorkspaceTabsStore.getState().openTool("plan");
  } else {
    useRightWorkspaceTabsStore.getState().closeTab(rightWorkspaceToolTabId("plan"));
  }
}

/** Close right-panel content and return its focused Plan to the composer. */
export function closeAllPanels(): void {
  const appState = useAppStore.getState();
  if (appState.view.kind === "thread") {
    moveThreadTodoDock(
      resolveActivePaneId(appState.view.panes, appState.focusedPaneId),
      "composer",
    );
  }
  // Bottom docks survive this (they are their own surface), but only while
  // there is a bottom row to hold them — drop stale slots first so they cannot
  // pin a panel's open flag from a row that no longer renders.
  if (useSharedSettings.getState().terminalPosition !== "bottom") {
    usePanelStore.getState().clearBottomPanelDocks();
  }
  // These legacy callers mean "close panel surfaces". Global document tabs
  // are independent workspace state and must survive a Git/terminal/overlay
  // dismissal. Remove tool tabs only; the explicit workspace close control is
  // responsible for discarding document tabs after its dirty-buffer prompt.
  const workspace = useRightWorkspaceTabsStore.getState();
  for (const tab of workspace.tabs) {
    if (tab.kind === "tool") workspace.closeTab(tab.id);
  }
  usePanelStore.getState().closeAllPanels();
}

/** Show one subagent as a temporary right-panel tab beside its parent thread. */
export function showSubAgentPanel(
  threadId: string,
  parentItemId: string,
  projectLocation?: ProjectLocation,
): void {
  const panelStore = usePanelStore.getState();
  panelStore.setSubAgentPanelContext({
    threadId,
    parentItemId,
    ...(projectLocation ? { projectLocation } : {}),
  });
  panelStore.setRightPanelTab("subagent");
  useRightWorkspaceTabsStore.getState().openTool("subagent");
}

/** Dismiss every panel that can occupy the right edge — used by the overlay backdrop. */
export function dismissRightOverlay(): void {
  useRightWorkspaceTabsStore.getState().hide();
}

function applyFilesPanel(
  projectId: string,
  worktreePath: string | undefined,
  options: { toggleCloseIfActive: boolean },
): boolean {
  const project = useAppStore.getState().projects.find((item) => item.id === projectId);
  if (!project) return false;

  const context = buildFileEditorContext(
    project,
    worktreePath,
    worktreePath ? resolveWorktreeBranch(projectId, worktreePath) : undefined,
  );

  const fileEditor = useFileEditorStore.getState();
  const currentRoot = fileEditor.rootContext;
  const isSameContext = fileEditorRootsMatch(currentRoot, context);

  if (!isSameContext && !switchFileEditorRoot(context)) return false;

  const panelStore = usePanelStore.getState();

  if (options.toggleCloseIfActive) {
    undockPanelTab("files");
  }

  panelStore.setFilesPanelContext(context);
  panelStore.setRightPanelTab("files");
  useRightWorkspaceTabsStore.getState().openTool("files");
  return true;
}

export function openFilesPanel(projectId: string, worktreePath?: string): void {
  applyFilesPanel(projectId, worktreePath, { toggleCloseIfActive: true });
}

export function showFilesPanel(projectId: string, worktreePath?: string): boolean {
  return applyFilesPanel(projectId, worktreePath, { toggleCloseIfActive: false });
}

export function openGitReview(
  projectId: string,
  worktreePath?: string,
  originComposerId?: string,
): void {
  undockPanelTab("git");
  const panelStore = usePanelStore.getState();
  panelStore.setGitReviewContext({
    projectId,
    ...(worktreePath ? { worktreePath } : {}),
    ...(originComposerId ? { originComposerId } : {}),
  });
  panelStore.setGitReviewAsPanel(true);
  panelStore.setGitOverlayOpen(false);
  panelStore.setRightPanelTab("git");
  useRightWorkspaceTabsStore.getState().openTool("git");
}

export function showGitReviewPanel(projectId: string, worktreePath?: string): void {
  const panelStore = usePanelStore.getState();
  panelStore.setGitReviewContext({ projectId, ...(worktreePath ? { worktreePath } : {}) });
  panelStore.setGitReviewAsPanel(true);
  panelStore.setGitOverlayOpen(false);
  panelStore.setRightPanelTab("git");
  useRightWorkspaceTabsStore.getState().openTool("git");
}

export function openGitOverlay(): void {
  usePanelStore.getState().setGitOverlayOpen(true);
}

/** Project/worktree scope of the focused thread, falling back to the first project. */
function resolveCurrentThreadScope(): { projectId: string; worktreePath?: string } | null {
  const appState = useAppStore.getState();
  if (appState.view.kind === "thread") {
    const paneId = resolveActivePaneId(appState.view.panes, appState.focusedPaneId);
    const thread = appState.threads.find((item) => item.id === paneId);
    if (thread) {
      return {
        projectId: thread.projectId,
        ...(thread.worktreePath ? { worktreePath: thread.worktreePath } : {}),
      };
    }
  }
  if (appState.view.kind === "draft" || appState.view.kind === "experiment") {
    return { projectId: appState.view.projectId };
  }
  const firstProject = appState.projects[0];
  return firstProject ? { projectId: firstProject.id } : null;
}

/**
 * Open the given tab's content without stealing the active right-panel tab.
 * The `show*` actions activate the tab they open; a drag-and-drop dock must
 * leave the active tab alone, so the pre-call tab is restored afterwards.
 */
function ensurePanelTabContent(tab: RightPanelTab): boolean {
  const panelStore = usePanelStore.getState();
  const previousTab = panelStore.rightPanelTab;
  switch (tab) {
    case "usage":
      panelStore.setUsagePanelOpen(true);
      return true;
    case "notes":
      panelStore.setNotesPanelOpen(true);
      return true;
    case "git": {
      if (panelStore.gitReviewContext) {
        panelStore.setGitReviewAsPanel(true);
        panelStore.setGitOverlayOpen(false);
        return true;
      }
      const scope = resolveCurrentThreadScope();
      if (!scope) return false;
      showGitReviewPanel(scope.projectId, scope.worktreePath);
      usePanelStore.getState().setRightPanelTab(previousTab);
      return true;
    }
    case "files": {
      if (panelStore.filesPanelContext) return true;
      const scope = resolveCurrentThreadScope();
      if (!scope) return false;
      if (!showFilesPanel(scope.projectId, scope.worktreePath)) return false;
      usePanelStore.getState().setRightPanelTab(previousTab);
      return true;
    }
    case "terminal": {
      if (useDevTerminalStore.getState().isOpen) return true;
      const scope = resolveCurrentThreadScope();
      if (!scope) return false;
      if (!showTerminalPanel(scope.projectId, scope.worktreePath)) return false;
      usePanelStore.getState().setRightPanelTab(previousTab);
      return true;
    }
    default:
      return false;
  }
}

/** Take a tab out of the right-panel split and any bottom dock slot holding it. */
export function undockPanelTab(tab: RightPanelTab): void {
  const panelStore = usePanelStore.getState();
  if (panelStore.rightPanelSplit?.tab === tab) panelStore.setRightPanelSplit(null);
  panelStore.clearBottomPanelDockTab(tab);
}

/** Apply a drag-and-drop dock of a right-panel tab icon onto a dock zone. */
export function dockPanelTab(tab: RightPanelTab, target: PanelDockTarget): void {
  if (!DOCKABLE_PANEL_TABS.has(tab)) return;
  if (tab === "browser" || tab === "ports" || tab === "plan" || tab === "subagent") return;
  const workspace = useRightWorkspaceTabsStore.getState();
  const workspaceTabId = rightWorkspaceToolTabId(tab);
  const previouslyActiveWorkspaceTabId = workspace.activeTabId;
  const closeDockedWorkspaceTab = () => {
    const current = useRightWorkspaceTabsStore.getState();
    current.closeTab(workspaceTabId);
    if (
      previouslyActiveWorkspaceTabId &&
      previouslyActiveWorkspaceTabId !== workspaceTabId &&
      current.tabs.some((candidate) => candidate.id === previouslyActiveWorkspaceTabId)
    ) {
      current.activateTab(previouslyActiveWorkspaceTabId);
    }
  };
  if (target.zone === "bottom-panel") {
    // The terminal already owns the middle of the bottom row.
    if (tab === "terminal") return;
    if (!ensurePanelTabContent(tab)) return;
    const terminalStore = useDevTerminalStore.getState();
    const { left, right } = usePanelStore.getState().bottomPanelDocks;
    // Terminal can sit beside one dock (`left | terminal` or `terminal | right`),
    // but not both. When the opposite slot is free the terminal keeps the
    // remaining space; only close it when the other side is already filled.
    if (terminalStore.isOpen) {
      const oppositeOccupied = target.placement === "left" ? right !== null : left !== null;
      if (oppositeOccupied) terminalStore.closePanel();
    }
    const panelStore = usePanelStore.getState();
    if (panelStore.rightPanelSplit?.tab === tab) panelStore.setRightPanelSplit(null);
    panelStore.setBottomPanelDock(target.placement, tab);
    closeDockedWorkspaceTab();
    return;
  }
  if (!ensurePanelTabContent(tab)) return;
  const panelStore = usePanelStore.getState();
  panelStore.clearBottomPanelDockTab(tab);
  // The active tab cannot split with itself — pulling it back out is enough.
  if (panelStore.rightPanelTab === tab && previouslyActiveWorkspaceTabId === workspaceTabId) {
    panelStore.setRightPanelSplit(null);
    return;
  }
  panelStore.setRightPanelSplit({ tab, placement: target.placement });
  closeDockedWorkspaceTab();
}

export function closeGitPanel(): void {
  usePanelStore.getState().setGitReviewContext(null);
}

export function openExternalUrl(url: string): void {
  void readBridge()
    .openExternal(url)
    .catch(() => undefined);
}
