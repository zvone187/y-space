import { create } from "zustand";
import {
  createRightWorkspaceTabsState,
  adjacentRightWorkspaceTabId,
  getRightWorkspaceBrowserPageOverview,
  rightWorkspaceBrowserPageTabId,
  rightWorkspaceTabsReducer,
  type RightWorkspaceBrowserPage,
  type RightWorkspaceBrowserPageOverview,
  type RightWorkspaceFileKey,
  type RightWorkspaceTab,
  type RightWorkspaceTabsAction,
  type RightWorkspaceTabsState,
  type RightWorkspaceTool,
} from "./rightWorkspaceTabs";

export const RIGHT_WORKSPACE_TOOL_TITLES: Readonly<Record<RightWorkspaceTool, string>> = {
  files: "Files",
  git: "Git",
  usage: "Usage",
  notes: "Notes",
  terminal: "Terminal",
  plan: "Plan",
  subagent: "Agent",
};

export interface RightWorkspaceTabsStore extends RightWorkspaceTabsState {
  hidden: boolean;
  dispatch: (action: RightWorkspaceTabsAction) => void;
  openTool: (tool: RightWorkspaceTool, title?: string) => void;
  ensureTool: (tool: RightWorkspaceTool, title?: string) => void;
  openFile: (file: RightWorkspaceFileKey, title: string, preview: boolean) => void;
  openBrowserPage: (page: RightWorkspaceBrowserPage) => void;
  updateBrowserPage: (page: RightWorkspaceBrowserPage) => void;
  syncBrowserPages: (
    pages: readonly RightWorkspaceBrowserPage[],
    selectedBrowserTabId?: string | null,
  ) => void;
  selectBrowserPage: (browserTabId: string) => void;
  promoteBrowserPage: (browserTabId: string) => void;
  closeBrowserPage: (browserTabId: string) => void;
  reorderBrowserPage: (browserTabId: string, toIndex: number) => void;
  getBrowserPageOverview: () => readonly RightWorkspaceBrowserPageOverview[];
  activateTab: (tabId: string) => void;
  cycleTab: (direction: "next" | "previous") => void;
  activateFilePath: (path: string) => void;
  closeTab: (tabId: string) => void;
  pinPreview: (tabId: string) => void;
  reorderTab: (tabId: string, toIndex: number) => void;
  renameFilePath: (
    root: Pick<RightWorkspaceFileKey, "projectId" | "worktreePath">,
    path: string,
    nextPath: string,
  ) => void;
  removeFilePath: (
    root: Pick<RightWorkspaceFileKey, "projectId" | "worktreePath">,
    path: string,
  ) => void;
  reset: () => void;
  hide: () => void;
  show: () => void;
}

function reduceStore(
  state: RightWorkspaceTabsStore,
  action: RightWorkspaceTabsAction,
): Partial<RightWorkspaceTabsStore> {
  return rightWorkspaceTabsReducer(state, action);
}

export const useRightWorkspaceTabsStore = create<RightWorkspaceTabsStore>((set, get) => ({
  ...createRightWorkspaceTabsState(),
  hidden: false,
  dispatch: (action) => set((state) => reduceStore(state, action)),
  openTool: (tool, title = RIGHT_WORKSPACE_TOOL_TITLES[tool]) =>
    set((state) => ({ ...reduceStore(state, { type: "open-tool", tool, title }), hidden: false })),
  ensureTool: (tool, title = RIGHT_WORKSPACE_TOOL_TITLES[tool]) =>
    set((state) => reduceStore(state, { type: "ensure-tool", tool, title })),
  openFile: (file, title, preview) =>
    set((state) => ({
      ...reduceStore(state, { type: "open-file", file, title, preview }),
      hidden: false,
    })),
  openBrowserPage: (page) =>
    set((state) => ({
      ...reduceStore(state, { type: "open-browser-page", ...page }),
      hidden: false,
    })),
  updateBrowserPage: (page) =>
    set((state) => reduceStore(state, { type: "update-browser-page", ...page })),
  syncBrowserPages: (pages, selectedBrowserTabId) =>
    set((state) =>
      reduceStore(state, {
        type: "sync-browser-pages",
        pages,
        ...(selectedBrowserTabId === undefined ? {} : { selectedBrowserTabId }),
      }),
    ),
  selectBrowserPage: (browserTabId) =>
    set((state) => ({
      ...reduceStore(state, { type: "select-browser-page", browserTabId }),
      hidden: false,
    })),
  promoteBrowserPage: (browserTabId) =>
    set((state) => reduceStore(state, { type: "promote-browser-page", browserTabId })),
  closeBrowserPage: (browserTabId) =>
    set((state) =>
      reduceStore(state, {
        type: "close",
        tabId: rightWorkspaceBrowserPageTabId(browserTabId),
      }),
    ),
  reorderBrowserPage: (browserTabId, toIndex) =>
    set((state) =>
      reduceStore(state, {
        type: "reorder",
        tabId: rightWorkspaceBrowserPageTabId(browserTabId),
        toIndex,
      }),
    ),
  getBrowserPageOverview: () => getRightWorkspaceBrowserPageOverview(get()),
  activateTab: (tabId) => set((state) => reduceStore(state, { type: "activate", tabId })),
  cycleTab: (direction) =>
    set((state) => {
      const tabId = adjacentRightWorkspaceTabId(state.tabs, state.activeTabId, direction);
      return tabId ? reduceStore(state, { type: "activate", tabId }) : {};
    }),
  activateFilePath: (path) => {
    const tab = get().tabs.find(
      (candidate): candidate is Extract<RightWorkspaceTab, { kind: "file" }> =>
        candidate.kind === "file" && candidate.file.path === path,
    );
    if (tab) get().activateTab(tab.id);
  },
  closeTab: (tabId) => set((state) => reduceStore(state, { type: "close", tabId })),
  pinPreview: (tabId) => set((state) => reduceStore(state, { type: "pin-preview", tabId })),
  reorderTab: (tabId, toIndex) =>
    set((state) => reduceStore(state, { type: "reorder", tabId, toIndex })),
  renameFilePath: (root, path, nextPath) =>
    set((state) => reduceStore(state, { type: "rename-file-path", root, path, nextPath })),
  removeFilePath: (root, path) =>
    set((state) => reduceStore(state, { type: "remove-file-path", root, path })),
  reset: () => set({ ...createRightWorkspaceTabsState(), hidden: false }),
  hide: () => set((state) => (state.hidden ? {} : { hidden: true })),
  show: () => set((state) => (state.hidden ? { hidden: false } : {})),
}));
