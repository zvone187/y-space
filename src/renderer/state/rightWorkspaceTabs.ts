import { getBasename } from "@/shared/pathUtils";

export type RightWorkspaceTool =
  | "files"
  | "git"
  | "usage"
  | "notes"
  | "terminal"
  | "plan"
  | "subagent";

/**
 * Maximum number of ordinary browser pages whose live webviews should remain
 * mounted. Sensitive integration/auth pages are pinned residents outside this
 * budget so an OAuth flow cannot be suspended midway through authorization.
 */
export const RIGHT_WORKSPACE_BROWSER_PAGE_RESIDENT_LIMIT = 6;

export interface RightWorkspaceFileKey {
  readonly projectId: string;
  readonly worktreePath: string;
  readonly path: string;
}

/** Backend browser identity and the metadata agents need to find a page. */
export interface RightWorkspaceBrowserPage {
  readonly browserTabId: string;
  readonly url: string;
  readonly title: string;
  readonly sensitiveIntegration?: boolean;
  readonly groupId?: string;
}

export interface RightWorkspaceToolTab {
  readonly id: string;
  readonly kind: "tool";
  readonly tool: RightWorkspaceTool;
  readonly title: string;
  readonly closable: boolean;
}

export interface RightWorkspaceFileTab {
  readonly id: string;
  readonly kind: "file";
  readonly file: RightWorkspaceFileKey;
  readonly title: string;
  readonly preview: boolean;
  readonly closable: boolean;
}

export interface RightWorkspaceBrowserPageTab {
  readonly id: string;
  readonly kind: "browser-page";
  readonly browserTabId: string;
  readonly url: string;
  readonly title: string;
  readonly resident: boolean;
  readonly sensitiveIntegration?: boolean;
  readonly groupId?: string;
  readonly closable: true;
  /** Monotonic reducer-owned recency; deterministic and independent of wall time. */
  readonly lastActivatedSequence: number;
}

export type RightWorkspaceTab =
  | RightWorkspaceToolTab
  | RightWorkspaceFileTab
  | RightWorkspaceBrowserPageTab;

export interface RightWorkspaceTabsState {
  readonly tabs: readonly RightWorkspaceTab[];
  readonly activeTabId: string | null;
  /** The sole replaceable, unpinned file preview, when one exists. */
  readonly previewTabId: string | null;
  /** Last issued browser-page activation sequence. */
  readonly browserPageActivationSequence: number;
}

export type RightWorkspaceTabsAction =
  | {
      readonly type: "open-tool";
      readonly tool: RightWorkspaceTool;
      readonly title: string;
      readonly closable?: boolean;
    }
  | {
      readonly type: "open-file";
      readonly file: RightWorkspaceFileKey;
      readonly title: string;
      readonly preview: boolean;
    }
  | {
      readonly type: "ensure-tool";
      readonly tool: RightWorkspaceTool;
      readonly title: string;
      readonly closable?: boolean;
    }
  | ({
      readonly type: "open-browser-page";
    } & RightWorkspaceBrowserPage)
  | ({
      readonly type: "update-browser-page";
    } & RightWorkspaceBrowserPage)
  | {
      /** Reconcile the authoritative backend page set without stealing file/tool focus. */
      readonly type: "sync-browser-pages";
      readonly pages: readonly RightWorkspaceBrowserPage[];
      readonly selectedBrowserTabId?: string | null;
    }
  | { readonly type: "select-browser-page"; readonly browserTabId: string }
  | { readonly type: "promote-browser-page"; readonly browserTabId: string }
  | { readonly type: "activate"; readonly tabId: string }
  | { readonly type: "close"; readonly tabId: string }
  | { readonly type: "pin-preview"; readonly tabId: string }
  | { readonly type: "reorder"; readonly tabId: string; readonly toIndex: number }
  | {
      readonly type: "rename-file-path";
      readonly root: Pick<RightWorkspaceFileKey, "projectId" | "worktreePath">;
      readonly path: string;
      readonly nextPath: string;
    }
  | {
      readonly type: "remove-file-path";
      readonly root: Pick<RightWorkspaceFileKey, "projectId" | "worktreePath">;
      readonly path: string;
    };

/** Tool IDs occupy their own namespace and are singleton by construction. */
export function rightWorkspaceToolTabId(tool: RightWorkspaceTool): string {
  return `tool:${tool}`;
}

/** Prefixing the complete backend ID is injective over string page IDs. */
export function rightWorkspaceBrowserPageTabId(browserTabId: string): string {
  return `browser:${browserTabId}`;
}

function createBrowserPageTab(
  page: RightWorkspaceBrowserPage,
  options: { resident: boolean; lastActivatedSequence: number },
): RightWorkspaceBrowserPageTab {
  return {
    id: rightWorkspaceBrowserPageTabId(page.browserTabId),
    kind: "browser-page",
    browserTabId: page.browserTabId,
    url: page.url,
    title: page.title,
    resident: options.resident,
    ...(page.sensitiveIntegration === undefined
      ? {}
      : { sensitiveIntegration: page.sensitiveIntegration }),
    ...(page.groupId === undefined ? {} : { groupId: page.groupId }),
    closable: true,
    lastActivatedSequence: options.lastActivatedSequence,
  };
}

/**
 * A JSON tuple is an injective encoding for these string fields. In particular,
 * separators inside paths cannot make two distinct file identities collide.
 */
export function rightWorkspaceFileTabId(file: RightWorkspaceFileKey): string {
  return `file:${JSON.stringify([file.projectId, file.worktreePath, file.path])}`;
}

export function createRightWorkspaceTabsState(): RightWorkspaceTabsState {
  return {
    tabs: [],
    activeTabId: null,
    previewTabId: null,
    browserPageActivationSequence: 0,
  };
}

export interface RightWorkspaceBrowserPageOverview {
  readonly tabId: string;
  readonly browserTabId: string;
  readonly url: string;
  readonly title: string;
  readonly sensitiveIntegration: boolean;
  readonly groupId?: string;
  readonly active: boolean;
  readonly resident: boolean;
  readonly lastActivatedSequence: number;
  readonly tabIndex: number;
}

/**
 * Agent-facing browser overview. `resident` is reducer-maintained so the UI can
 * mount only live pages while all suspended tab metadata remains discoverable.
 */
export function getRightWorkspaceBrowserPageOverview(
  state: Pick<RightWorkspaceTabsState, "tabs" | "activeTabId">,
): readonly RightWorkspaceBrowserPageOverview[] {
  return state.tabs.flatMap((tab, tabIndex) =>
    tab.kind === "browser-page"
      ? [
          {
            tabId: tab.id,
            browserTabId: tab.browserTabId,
            url: tab.url,
            title: tab.title,
            sensitiveIntegration: tab.sensitiveIntegration === true,
            ...(tab.groupId === undefined ? {} : { groupId: tab.groupId }),
            active: tab.id === state.activeTabId,
            resident: tab.resident,
            lastActivatedSequence: tab.lastActivatedSequence,
            tabIndex,
          } satisfies RightWorkspaceBrowserPageOverview,
        ]
      : [],
  );
}

export function adjacentRightWorkspaceTabId(
  tabs: readonly RightWorkspaceTab[],
  activeTabId: string | null,
  direction: "next" | "previous",
): string | null {
  if (tabs.length < 2) return null;
  const currentIndex = activeTabId ? tabs.findIndex((tab) => tab.id === activeTabId) : -1;
  const delta = direction === "next" ? 1 : -1;
  const from = currentIndex === -1 ? (direction === "next" ? -1 : 0) : currentIndex;
  return tabs[(from + delta + tabs.length) % tabs.length]?.id ?? null;
}

function applyBrowserPageResidency(state: RightWorkspaceTabsState): RightWorkspaceTabsState {
  const browserTabs = state.tabs.filter(
    (tab): tab is RightWorkspaceBrowserPageTab => tab.kind === "browser-page",
  );
  const residentIds = new Set(
    browserTabs.filter((tab) => tab.sensitiveIntegration).map((tab) => tab.id),
  );
  const activeBrowserTab = browserTabs.find((tab) => tab.id === state.activeTabId);
  const ordinaryResidentIds = new Set<string>();
  if (activeBrowserTab && !activeBrowserTab.sensitiveIntegration) {
    ordinaryResidentIds.add(activeBrowserTab.id);
  }
  const ordinaryByRecency = browserTabs
    .filter((tab) => !tab.sensitiveIntegration && tab.id !== activeBrowserTab?.id)
    .sort((left, right) => right.lastActivatedSequence - left.lastActivatedSequence);
  for (const tab of ordinaryByRecency) {
    if (ordinaryResidentIds.size >= RIGHT_WORKSPACE_BROWSER_PAGE_RESIDENT_LIMIT) break;
    ordinaryResidentIds.add(tab.id);
  }
  for (const id of ordinaryResidentIds) residentIds.add(id);

  let changed = false;
  const tabs = state.tabs.map((tab) => {
    if (tab.kind !== "browser-page") return tab;
    const resident = residentIds.has(tab.id);
    if (resident === tab.resident) return tab;
    changed = true;
    return { ...tab, resident };
  });
  return changed ? { ...state, tabs } : state;
}

function promoteBrowserPage(
  state: RightWorkspaceTabsState,
  browserTabId: string,
): RightWorkspaceTabsState {
  const id = rightWorkspaceBrowserPageTabId(browserTabId);
  const index = state.tabs.findIndex((tab) => tab.id === id);
  const tab = state.tabs[index];
  if (!tab || tab.kind !== "browser-page") return state;
  const browserPageActivationSequence = state.browserPageActivationSequence + 1;
  const tabs = [...state.tabs];
  tabs[index] = { ...tab, lastActivatedSequence: browserPageActivationSequence };
  return applyBrowserPageResidency({
    ...state,
    tabs,
    browserPageActivationSequence,
  });
}

function activateTab(state: RightWorkspaceTabsState, tabId: string): RightWorkspaceTabsState {
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  const tab = state.tabs[index];
  if (!tab || state.activeTabId === tabId) return state;
  if (tab.kind !== "browser-page") {
    return applyBrowserPageResidency({ ...state, activeTabId: tabId });
  }

  const browserPageActivationSequence = state.browserPageActivationSequence + 1;
  const tabs = [...state.tabs];
  tabs[index] = { ...tab, lastActivatedSequence: browserPageActivationSequence };
  return applyBrowserPageResidency({
    ...state,
    tabs,
    activeTabId: tabId,
    browserPageActivationSequence,
  });
}

function openTool(
  state: RightWorkspaceTabsState,
  action: Extract<RightWorkspaceTabsAction, { type: "open-tool" }>,
): RightWorkspaceTabsState {
  const id = rightWorkspaceToolTabId(action.tool);
  const existingIndex = state.tabs.findIndex((tab) => tab.id === id);
  if (existingIndex >= 0) {
    const existing = state.tabs[existingIndex];
    if (
      existing?.kind === "tool" &&
      (existing.title !== action.title || existing.closable !== (action.closable ?? true))
    ) {
      const tabs = [...state.tabs];
      tabs[existingIndex] = {
        ...existing,
        title: action.title,
        closable: action.closable ?? true,
      };
      return { ...state, tabs, activeTabId: id };
    }
    return state.activeTabId === id ? state : { ...state, activeTabId: id };
  }

  return {
    ...state,
    tabs: [
      ...state.tabs,
      {
        id,
        kind: "tool",
        tool: action.tool,
        title: action.title,
        closable: action.closable ?? true,
      },
    ],
    activeTabId: id,
  };
}

function ensureTool(
  state: RightWorkspaceTabsState,
  action: Extract<RightWorkspaceTabsAction, { type: "ensure-tool" }>,
): RightWorkspaceTabsState {
  const next = openTool(state, { ...action, type: "open-tool" });
  // Reconciliation must not steal focus from the user's current document/tool.
  return state.activeTabId === null ? next : { ...next, activeTabId: state.activeTabId };
}

function openBrowserPage(
  state: RightWorkspaceTabsState,
  action: Extract<RightWorkspaceTabsAction, { type: "open-browser-page" }>,
): RightWorkspaceTabsState {
  const id = rightWorkspaceBrowserPageTabId(action.browserTabId);
  const existingIndex = state.tabs.findIndex((tab) => tab.id === id);
  if (existingIndex >= 0) {
    const existing = state.tabs[existingIndex];
    if (existing?.kind !== "browser-page") return state;
    const pageChanged =
      existing.url !== action.url ||
      existing.title !== action.title ||
      existing.sensitiveIntegration !== action.sensitiveIntegration ||
      existing.groupId !== action.groupId;
    const next = pageChanged
      ? {
          ...state,
          tabs: state.tabs.map((tab, index) =>
            index === existingIndex
              ? createBrowserPageTab(action, {
                  resident: existing.resident,
                  lastActivatedSequence: existing.lastActivatedSequence,
                })
              : tab,
          ),
        }
      : state;
    return state.activeTabId === id ? applyBrowserPageResidency(next) : activateTab(next, id);
  }

  const tab = createBrowserPageTab(action, { resident: false, lastActivatedSequence: 0 });
  return activateTab({ ...state, tabs: [...state.tabs, tab] }, id);
}

function updateBrowserPage(
  state: RightWorkspaceTabsState,
  action: Extract<RightWorkspaceTabsAction, { type: "update-browser-page" }>,
): RightWorkspaceTabsState {
  const id = rightWorkspaceBrowserPageTabId(action.browserTabId);
  const existingIndex = state.tabs.findIndex((tab) => tab.id === id);
  const existing = state.tabs[existingIndex];
  if (existingIndex < 0 || existing?.kind !== "browser-page") return state;
  if (
    existing.url === action.url &&
    existing.title === action.title &&
    existing.sensitiveIntegration === action.sensitiveIntegration &&
    existing.groupId === action.groupId
  ) {
    return state;
  }
  const tabs = [...state.tabs];
  tabs[existingIndex] = createBrowserPageTab(action, {
    resident: existing.resident,
    lastActivatedSequence: existing.lastActivatedSequence,
  });
  return applyBrowserPageResidency({ ...state, tabs });
}

function syncBrowserPages(
  state: RightWorkspaceTabsState,
  action: Extract<RightWorkspaceTabsAction, { type: "sync-browser-pages" }>,
): RightWorkspaceTabsState {
  const browserTabIds: string[] = [];
  const pagesById = new Map<string, RightWorkspaceBrowserPage>();
  for (const page of action.pages) {
    if (!pagesById.has(page.browserTabId)) browserTabIds.push(page.browserTabId);
    pagesById.set(page.browserTabId, page);
  }

  const activeBefore = state.tabs.find((tab) => tab.id === state.activeTabId);
  // If the backend just closed the globally selected browser page (for
  // example Cmd/Ctrl+W inside its guest), global peer order owns the fallback:
  // the next item may be a file/tool, not the manager's next browser-only
  // entry. When the selected page still exists, normal backend activation does
  // continue to follow it.
  const activeBrowserWasRemoved =
    activeBefore?.kind === "browser-page" && !pagesById.has(activeBefore.browserTabId);
  const followBackendSelection = activeBefore?.kind === "browser-page" && !activeBrowserWasRemoved;
  let next = state;
  for (const tab of state.tabs) {
    if (tab.kind === "browser-page" && !pagesById.has(tab.browserTabId)) {
      next = closeTab(next, tab.id);
    }
  }

  const presentPageIds = new Set<string>();
  let tabsChanged = false;
  const tabs = next.tabs.map((tab) => {
    if (tab.kind !== "browser-page") return tab;
    const page = pagesById.get(tab.browserTabId);
    if (!page) return tab;
    presentPageIds.add(page.browserTabId);
    if (
      tab.url === page.url &&
      tab.title === page.title &&
      tab.sensitiveIntegration === page.sensitiveIntegration &&
      tab.groupId === page.groupId
    ) {
      return tab;
    }
    tabsChanged = true;
    return createBrowserPageTab(page, {
      resident: tab.resident,
      lastActivatedSequence: tab.lastActivatedSequence,
    });
  });
  for (const browserTabId of browserTabIds) {
    if (presentPageIds.has(browserTabId)) continue;
    const page = pagesById.get(browserTabId);
    if (!page) continue;
    tabs.push(createBrowserPageTab(page, { resident: false, lastActivatedSequence: 0 }));
    tabsChanged = true;
  }
  if (tabsChanged) next = applyBrowserPageResidency({ ...next, tabs });

  if (action.selectedBrowserTabId !== null && action.selectedBrowserTabId !== undefined) {
    next = promoteBrowserPage(next, action.selectedBrowserTabId);
    if (followBackendSelection) {
      const selectedId = rightWorkspaceBrowserPageTabId(action.selectedBrowserTabId);
      if (next.tabs.some((tab) => tab.id === selectedId)) {
        return applyBrowserPageResidency({ ...next, activeTabId: selectedId });
      }
    }
  }
  return next;
}

function openFile(
  state: RightWorkspaceTabsState,
  action: Extract<RightWorkspaceTabsAction, { type: "open-file" }>,
): RightWorkspaceTabsState {
  const id = rightWorkspaceFileTabId(action.file);
  const existingIndex = state.tabs.findIndex((tab) => tab.id === id);

  if (existingIndex >= 0) {
    const existing = state.tabs[existingIndex];
    if (existing?.kind !== "file") return state;

    // Opening a preview permanently must pin it. Opening an already-permanent
    // file as a preview must never demote it back into the replaceable slot.
    const preview = existing.preview && action.preview;
    const previewTabId = preview ? id : state.previewTabId === id ? null : state.previewTabId;
    const unchanged =
      existing.title === action.title &&
      existing.preview === preview &&
      state.activeTabId === id &&
      state.previewTabId === previewTabId;
    if (unchanged) return state;

    const tabs = [...state.tabs];
    tabs[existingIndex] = {
      ...existing,
      file: action.file,
      title: action.title,
      preview,
    };
    return applyBrowserPageResidency({ ...state, tabs, activeTabId: id, previewTabId });
  }

  const tab: RightWorkspaceFileTab = {
    id,
    kind: "file",
    file: action.file,
    title: action.title,
    preview: action.preview,
    closable: true,
  };

  if (action.preview && state.previewTabId) {
    const replaceIndex = state.tabs.findIndex(
      (candidate) =>
        candidate.id === state.previewTabId && candidate.kind === "file" && candidate.preview,
    );
    if (replaceIndex >= 0) {
      const tabs = [...state.tabs];
      tabs[replaceIndex] = tab;
      return applyBrowserPageResidency({
        ...state,
        tabs,
        activeTabId: id,
        previewTabId: id,
      });
    }
  }

  return applyBrowserPageResidency({
    ...state,
    tabs: [...state.tabs, tab],
    activeTabId: id,
    previewTabId: action.preview ? id : state.previewTabId,
  });
}

function closeTab(state: RightWorkspaceTabsState, tabId: string): RightWorkspaceTabsState {
  const closedIndex = state.tabs.findIndex((tab) => tab.id === tabId);
  if (closedIndex < 0) return state;

  const tabs = state.tabs.filter((tab) => tab.id !== tabId);
  const activeTabId =
    state.activeTabId === tabId
      ? (tabs[closedIndex]?.id ?? tabs[closedIndex - 1]?.id ?? null)
      : state.activeTabId;
  return applyBrowserPageResidency({
    ...state,
    tabs,
    activeTabId,
    previewTabId: state.previewTabId === tabId ? null : state.previewTabId,
  });
}

function pinPreview(state: RightWorkspaceTabsState, tabId: string): RightWorkspaceTabsState {
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  const tab = state.tabs[index];
  if (index < 0 || tab?.kind !== "file" || !tab.preview) return state;

  const tabs = [...state.tabs];
  tabs[index] = { ...tab, preview: false };
  return {
    ...state,
    tabs,
    previewTabId: state.previewTabId === tabId ? null : state.previewTabId,
  };
}

function reorderTab(
  state: RightWorkspaceTabsState,
  tabId: string,
  requestedIndex: number,
): RightWorkspaceTabsState {
  const fromIndex = state.tabs.findIndex((tab) => tab.id === tabId);
  if (fromIndex < 0 || !Number.isFinite(requestedIndex) || state.tabs.length < 2) return state;

  const toIndex = Math.max(0, Math.min(state.tabs.length - 1, Math.trunc(requestedIndex)));
  if (fromIndex === toIndex) return state;

  const tabs = [...state.tabs];
  const [tab] = tabs.splice(fromIndex, 1);
  if (!tab) return state;
  tabs.splice(toIndex, 0, tab);
  return { ...state, tabs };
}

function fileMatchesRootAndPath(
  tab: RightWorkspaceTab,
  root: Pick<RightWorkspaceFileKey, "projectId" | "worktreePath">,
  path: string,
): tab is RightWorkspaceFileTab {
  return (
    tab.kind === "file" &&
    tab.file.projectId === root.projectId &&
    tab.file.worktreePath === root.worktreePath &&
    (tab.file.path === path || tab.file.path.startsWith(`${path}/`))
  );
}

function renameFilePath(
  state: RightWorkspaceTabsState,
  action: Extract<RightWorkspaceTabsAction, { type: "rename-file-path" }>,
): RightWorkspaceTabsState {
  const idChanges = new Map<string, string>();
  const tabs = state.tabs.map((tab) => {
    if (!fileMatchesRootAndPath(tab, action.root, action.path)) return tab;
    const suffix = tab.file.path.slice(action.path.length);
    const file = { ...tab.file, path: `${action.nextPath}${suffix}` };
    const id = rightWorkspaceFileTabId(file);
    idChanges.set(tab.id, id);
    return { ...tab, id, file, title: getBasename(file.path) };
  });
  if (idChanges.size === 0) return state;

  // Filesystem rename/move normally guarantees a free destination. Deduplicate
  // defensively if stale UI state already contained that identity.
  const seen = new Set<string>();
  const uniqueTabs = tabs.filter((tab) => {
    if (seen.has(tab.id)) return false;
    seen.add(tab.id);
    return true;
  });
  return {
    ...state,
    tabs: uniqueTabs,
    activeTabId: state.activeTabId ? (idChanges.get(state.activeTabId) ?? state.activeTabId) : null,
    previewTabId: state.previewTabId
      ? (idChanges.get(state.previewTabId) ?? state.previewTabId)
      : null,
  };
}

function removeFilePath(
  state: RightWorkspaceTabsState,
  action: Extract<RightWorkspaceTabsAction, { type: "remove-file-path" }>,
): RightWorkspaceTabsState {
  return state.tabs
    .filter((tab) => fileMatchesRootAndPath(tab, action.root, action.path))
    .reduce((next, tab) => closeTab(next, tab.id), state);
}

export function rightWorkspaceTabsReducer(
  state: RightWorkspaceTabsState,
  action: RightWorkspaceTabsAction,
): RightWorkspaceTabsState {
  switch (action.type) {
    case "open-tool":
      return openTool(state, action);
    case "ensure-tool":
      return ensureTool(state, action);
    case "open-browser-page":
      return openBrowserPage(state, action);
    case "update-browser-page":
      return updateBrowserPage(state, action);
    case "sync-browser-pages":
      return syncBrowserPages(state, action);
    case "select-browser-page":
      return activateTab(state, rightWorkspaceBrowserPageTabId(action.browserTabId));
    case "promote-browser-page":
      return promoteBrowserPage(state, action.browserTabId);
    case "open-file":
      return openFile(state, action);
    case "activate":
      return activateTab(state, action.tabId);
    case "close":
      return closeTab(state, action.tabId);
    case "pin-preview":
      return pinPreview(state, action.tabId);
    case "reorder":
      return reorderTab(state, action.tabId, action.toIndex);
    case "rename-file-path":
      return renameFilePath(state, action);
    case "remove-file-path":
      return removeFilePath(state, action);
  }
}
