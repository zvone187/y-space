import { buildWorktreeLocation } from "@/shared/worktree";
import { useAppStore } from "@/renderer/state/appStore";
import { useDevTerminalStore } from "@/renderer/state/devTerminalStore";
import { usePanelStore } from "@/renderer/state/panelStore";
import {
  useSharedSettings,
  whenSharedSettingsHydrated,
} from "@/renderer/state/sharedSettingsStore";
import { useThreadOutputStore } from "@/renderer/state/threadOutputStore";
import { useRightWorkspaceTabsStore } from "@/renderer/state/rightWorkspaceTabsStore";
import { rightWorkspaceToolTabId } from "@/renderer/state/rightWorkspaceTabs";
import {
  closeThreads,
  startShellWithToast,
  writeScriptToShellThenExitOnSuccess,
} from "@/renderer/utils/shellUtils";

const actionRunTokens = new Map<string, symbol>();

function applyTerminalPanel(
  projectId: string,
  worktreePath: string | undefined,
  options: { toggleCloseIfActive: boolean },
): boolean {
  const project = useAppStore.getState().projects.find((p) => p.id === projectId);
  if (!project) return false;

  const store = useDevTerminalStore.getState();
  const isBottom = useSharedSettings.getState().terminalPosition === "bottom";

  if (options.toggleCloseIfActive) {
    const isSameTerminal =
      store.isOpen &&
      store.activeProjectId === projectId &&
      (store.activeWorktreePath ?? undefined) === worktreePath;
    if (isSameTerminal && isBottom) {
      store.closePanel();
      return true;
    }
  }

  if (worktreePath) {
    store.openWorktreePanel(projectId, worktreePath);
  } else {
    store.openPanel(projectId);
  }
  if (!isBottom) {
    usePanelStore.getState().setRightPanelTab("terminal");
    useRightWorkspaceTabsStore.getState().openTool("terminal");
  }

  const existingTab = store.tabs.find(
    (t) => t.projectId === projectId && (t.worktreePath ?? undefined) === worktreePath,
  );
  if (existingTab) {
    store.setActiveTab(existingTab.id);
    return true;
  }

  const label = worktreePath ? (worktreePath.split(/[/\\]/).pop() ?? project.name) : project.name;
  const tab = store.addTab(projectId, label, worktreePath);
  store.setActiveTab(tab.id);
  return true;
}

export function openTerminal(projectId: string): void {
  applyTerminalPanel(projectId, undefined, { toggleCloseIfActive: true });
}

export function openWorktreeTerminal(projectId: string, worktreePath: string): void {
  applyTerminalPanel(projectId, worktreePath, { toggleCloseIfActive: true });
}

export function showTerminalPanel(projectId: string, worktreePath?: string): boolean {
  return applyTerminalPanel(projectId, worktreePath, { toggleCloseIfActive: false });
}

/** Close only the Terminal singleton; adjacent global tools/documents survive. */
export function closeTerminalPanel(): void {
  useDevTerminalStore.getState().closePanel();
  useRightWorkspaceTabsStore.getState().closeTab(rightWorkspaceToolTabId("terminal"));
}

export function runProjectAction(projectId: string, actionId: string, worktreePath?: string): void {
  const project = useAppStore.getState().projects.find((p) => p.id === projectId);
  if (!project) return;
  const action = project.scripts?.actions?.find((a) => a.id === actionId);
  if (!action) return;

  const location = worktreePath
    ? buildWorktreeLocation(project.location, worktreePath)
    : project.location;

  const store = useDevTerminalStore.getState();
  const tabLabel = action.name;
  const tab =
    store.tabs.find(
      (candidate) =>
        candidate.projectId === projectId &&
        (candidate.worktreePath ?? undefined) === worktreePath &&
        candidate.runActionId === actionId,
    ) ?? store.addTab(projectId, tabLabel, worktreePath, actionId);
  store.setActiveTab(tab.id);
  store.markShellRunning(tab.id);
  useThreadOutputStore.getState().clearOutput(tab.id);
  const runToken = Symbol(tab.id);
  actionRunTokens.set(tab.id, runToken);

  // Decide panel visibility only once the authoritative settings are loaded —
  // right after launch the store still holds defaults (autoShowTerminalPanel:
  // true), which would open the panel for users who keep it hidden.
  void whenSharedSettingsHydrated().then(() => {
    if (!useSharedSettings.getState().autoShowTerminalPanel) return;
    showTerminalPanel(projectId, worktreePath);
  });

  void startShellWithToast(
    {
      shellId: tab.id,
      projectLocation: location,
      ...(worktreePath ? { worktreePath } : {}),
    },
    tabLabel,
  ).then((started) => {
    if (actionRunTokens.get(tab.id) !== runToken || started) return;
    actionRunTokens.delete(tab.id);
    useDevTerminalStore.getState().markShellExited(tab.id);
  });
  const markActionComplete = () => {
    if (actionRunTokens.get(tab.id) !== runToken) return;
    actionRunTokens.delete(tab.id);
    useDevTerminalStore.getState().markShellExited(tab.id);
    void closeThreads([tab.id]);
  };
  writeScriptToShellThenExitOnSuccess(
    tab.id,
    action.command,
    location.kind,
    markActionComplete,
    markActionComplete,
    project.remoteServerId,
    {
      onOutput: (output) => useThreadOutputStore.getState().appendOutput(tab.id, output),
      onReset: () => useThreadOutputStore.getState().clearOutput(tab.id),
    },
  );
}

export function stopProjectAction(
  projectId: string,
  actionId: string,
  worktreePath?: string,
): void {
  const store = useDevTerminalStore.getState();
  const tab = store.tabs.find(
    (candidate) =>
      candidate.projectId === projectId &&
      (candidate.worktreePath ?? undefined) === worktreePath &&
      candidate.runActionId === actionId,
  );
  if (!tab) return;

  actionRunTokens.delete(tab.id);
  store.removeTab(tab.id);
  useThreadOutputStore.getState().clearOutput(tab.id);
  void closeThreads([tab.id]);
}
