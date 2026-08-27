import { randomUUID } from "node:crypto";
import { BrowserWindow, shell } from "electron";
import {
  IPC_EVENT_CHANNELS,
  type BrowserEvent,
  type BrowserState,
  type BrowserStartPickerResult,
  type BrowserTabGroupInfo,
  type BrowserTabInfo,
} from "@/shared/ipc";
import type { UsageLoginConfirmationAction, UsageLoginDeviceCode } from "@/shared/contracts";
import type { PoracodePaths } from "@/shared/poracodePaths";
import type { BrowserLinkPresentationMode } from "@/shared/settings";
import { dbGetState, dbSetState } from "../db";
import { readSharedSettingsFile } from "../sharedSettingsFile";
import { saveClipboardImageFile } from "../attachments/localFiles";
import { BrowserLoginCaptureCoordinator } from "./BrowserLoginCaptureCoordinator";
import { BrowserTab, type BrowserTabSnapshot, resolveWebContentsById } from "./BrowserTab";
import { BrowserTabGroups } from "./BrowserTabGroups";
import { BrowserHistoryStore, fetchSearchSuggestions } from "./browserHistory";
import { BrowserBookmarkStore, type BrowserBookmark } from "./browserBookmarks";
import { PICKER_COMMIT_ORIGIN, onPickerCommit } from "./picker/pickerProtocol";
import { buildPickerScript } from "./picker/pickerScript";

const PERSIST_KEY = "browser-panel-tabs-v1";
const PERSIST_DEBOUNCE_MS = 750;
const ATTACH_TIMEOUT_MS = 8000;
// How long the browser stays "active" (webviews kept mounted for headless work)
// after the last agent tool call, before the renderer unmounts them.
const AUTOMATION_GRACE_MS = 45_000;
const INTERNAL_BROWSER_PROTOCOLS = new Set(["http:", "https:"]);
const SYSTEM_BROWSER_PROTOCOLS = new Set(["mailto:"]);
const REDACTED_INTEGRATION_URL = "about:blank";

interface PersistedTabsState {
  tabs: Array<{ url: string; title: string; groupId?: string }>;
  activeIndex: number | null;
  groups?: BrowserTabGroupInfo[];
}

interface PendingPicker {
  threadId: string;
  tabId: string;
  resolve(result: BrowserStartPickerResult): void;
}

type PickerPayload =
  | { kind: "cancelled" }
  | {
      kind: "picked";
      selector: string;
      rect: { x: number; y: number; width: number; height: number };
      dpr: number;
      url: string;
      title: string;
    };

interface BrowserPanelManagerOptions {
  isExtracted?: () => boolean;
  focusExtractedWindow?: () => void;
}

interface CreateTabOptions {
  markActivity?: boolean;
  awaitAttach?: boolean;
  agent?: boolean;
  threadId?: string;
  threadTitle?: string;
  restoredTitle?: string;
}

interface SensitiveIntegrationTabState {
  privateUrl: string | null;
  navigationStarted: boolean;
}

export class BrowserPanelManager {
  private tabs: BrowserTab[] = [];
  private readonly tabGroups = new BrowserTabGroups();
  private activeTabId: string | null = null;
  private hosts = new Set<BrowserWindow>();
  /** Out-of-window observers (remote access gateway) fed the same events as
   * the renderer; the renderer stays the only consumer of host-window IPC. */
  private readonly eventListeners = new Set<(event: BrowserEvent) => void>();
  private pendingPicker: PendingPicker | null = null;
  private unsubscribePicker: (() => void) | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly history = new BrowserHistoryStore();
  private readonly bookmarks = new BrowserBookmarkStore();
  /**
   * One-use OAuth / Connect URLs live only in the main process. The renderer
   * receives an about:blank tab and main navigates the attached guest directly.
   */
  private readonly sensitiveIntegrationTabs = new Map<string, SensitiveIntegrationTabState>();
  private restored = false;
  private automationActive = false;
  private readonly automationSessions = new Set<string>();
  /** Per-agent implicit tab target; intentionally independent of the visible UI tab. */
  private readonly activeAgentTabByThread = new Map<string, string>();
  private automationTimer: ReturnType<typeof setTimeout> | null = null;
  private pickerKeyCleanup: (() => void) | null = null;
  private readonly loginCoordinator = new BrowserLoginCaptureCoordinator({
    createTab: (payload) => this.createTab(payload),
    closeTab: (tabId) => this.closeTab(tabId),
    findTab: (tabId) => this.findTab(tabId),
    emit: (event) => this.emit(event),
    hasHostWindow: () => this.hasHostWindow(),
  });

  constructor(
    private readonly paths: PoracodePaths,
    private readonly browserUserAgent: string,
    private readonly options: BrowserPanelManagerOptions = {},
  ) {
    this.unsubscribePicker = onPickerCommit((commit) => {
      void this.onPickerCommit(commit);
    });
  }

  private persistTabsState(): void {
    try {
      const groups = this.tabGroups.serialize();
      const persistedTabs = this.tabs.filter(
        (tab) => !this.sensitiveIntegrationTabs.has(tab.tabId),
      );
      const activeIndex = this.activeTabId
        ? persistedTabs.findIndex((t) => t.tabId === this.activeTabId)
        : -1;
      const state: PersistedTabsState = {
        tabs: persistedTabs.map((t) => {
          const s = t.snapshot();
          const groupId = this.tabGroups.groupIdForTab(t.tabId);
          return { url: s.url, title: s.title, ...(groupId ? { groupId } : {}) };
        }),
        activeIndex: activeIndex >= 0 ? activeIndex : null,
        ...(groups ? { groups } : {}),
      };
      dbSetState(PERSIST_KEY, JSON.stringify(state));
    } catch {}
  }

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistTabsState();
    }, PERSIST_DEBOUNCE_MS);
  }

  private async restoreFromDisk(): Promise<void> {
    if (this.restored) return;
    this.restored = true;
    let parsed: PersistedTabsState | null = null;
    try {
      const raw = dbGetState(PERSIST_KEY);
      if (!raw) return;
      const candidate = JSON.parse(raw) as PersistedTabsState;
      if (!candidate || !Array.isArray(candidate.tabs)) return;
      parsed = candidate;
    } catch {
      return;
    }
    if (!parsed || parsed.tabs.length === 0) return;
    this.tabGroups.restore(parsed.groups);
    for (let i = 0; i < parsed.tabs.length; i++) {
      const entry = parsed.tabs[i];
      if (!entry || typeof entry.url !== "string" || entry.url.length === 0) continue;
      const isActive = parsed.activeIndex === i;
      // Restored tabs are dormant: don't wake the browser or block on attach —
      // they mount lazily when the user opens the panel or the agent uses them.
      const info = await this.createTab(
        { url: entry.url, activate: isActive },
        {
          markActivity: false,
          awaitAttach: false,
          ...(typeof entry.title === "string" ? { restoredTitle: entry.title } : {}),
        },
      ).catch(() => null);
      // Persisted order is already contiguous, so just re-map (no reorder).
      if (info && entry.groupId) this.tabGroups.assignRestoredTab(info.tabId, entry.groupId);
    }
    this.tabGroups.pruneEmptyGroups();
    this.emitState();
  }

  bindHost(window: BrowserWindow): void {
    this.hosts.add(window);
    const onBeforeInputEvent = (event: Electron.Event, input: Electron.Input) => {
      if (!this.pendingPicker || !isEscapeKeyDown(input)) return;
      event.preventDefault();
      this.cancelPicker();
    };
    window.webContents.on("before-input-event", onBeforeInputEvent);
    window.once("closed", () => {
      this.hosts.delete(window);
      try {
        window.webContents.removeListener("before-input-event", onBeforeInputEvent);
      } catch {}
    });
    void this.restoreFromDisk();
    this.emitState();
  }

  dispose(): void {
    this.unsubscribePicker?.();
    this.unsubscribePicker = null;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
      this.persistTabsState();
    }
    if (this.automationTimer) {
      clearTimeout(this.automationTimer);
      this.automationTimer = null;
    }
    this.automationSessions.clear();
    this.automationActive = false;
    this.clearPickerShortcut();
    this.loginCoordinator.cancelLoginConfirmations();
    for (const t of this.tabs) {
      void t.destroy().finally(() => this.sensitiveIntegrationTabs.delete(t.tabId));
    }
    this.tabs = [];
    this.activeTabId = null;
    this.hosts.clear();
  }

  private clearPickerShortcut(): void {
    this.pickerKeyCleanup?.();
    this.pickerKeyCleanup = null;
  }

  private bindPickerShortcut(tab: BrowserTab): void {
    this.clearPickerShortcut();
    if (!tab.isAttached()) return;
    const wc = tab.webContents;
    const onBeforeInputEvent = (event: Electron.Event, input: Electron.Input) => {
      if (this.pendingPicker?.tabId !== tab.tabId || !isEscapeKeyDown(input)) return;
      event.preventDefault();
      this.cancelPicker();
    };
    wc.on("before-input-event", onBeforeInputEvent);
    this.pickerKeyCleanup = () => {
      if (tab.isDestroyed() || !tab.isAttached()) return;
      try {
        wc.removeListener("before-input-event", onBeforeInputEvent);
      } catch {}
    };
  }

  private emit(event: BrowserEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {}
    }
    for (const host of this.hosts) {
      if (host.isDestroyed()) {
        this.hosts.delete(host);
        continue;
      }
      try {
        host.webContents.send(IPC_EVENT_CHANNELS.browserEvent, event);
      } catch {}
    }
  }

  addEventListener(listener: (event: BrowserEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  private emitState(): void {
    this.emit({ type: "state", state: this.snapshot() });
  }

  notifyState(): void {
    this.emitState();
  }

  revealPanel(mode?: BrowserLinkPresentationMode): void {
    if (this.options.isExtracted?.()) {
      this.options.focusExtractedWindow?.();
      return;
    }
    this.emit({
      type: "open-panel",
      ...(mode !== undefined ? { mode } : {}),
    });
  }

  /** Reveal using the user's Browser "Show opened links in" preference. */
  revealForUserOpen(): void {
    this.revealPanel(this.readLinkSettings().linkPresentationMode);
  }

  /**
   * Mark agent browser activity. Tells the renderer to keep the browser's
   * <webview>s mounted (off-screen, headless) so the agent can drive tabs with
   * the panel closed; a grace timer flips it back to idle (unmount) once the
   * agent stops. Called from tab-resolution so passive/metadata tools don't
   * needlessly wake the browser.
   */
  markAutomationActivity(): void {
    if (!this.automationActive) {
      this.automationActive = true;
      this.emit({ type: "automation-active", active: true });
    }
    if (this.automationTimer) clearTimeout(this.automationTimer);
    if (this.automationSessions.size > 0) {
      this.automationTimer = null;
      return;
    }
    this.automationTimer = setTimeout(() => {
      this.automationTimer = null;
      this.automationActive = false;
      this.emit({ type: "automation-active", active: false });
    }, AUTOMATION_GRACE_MS);
  }

  setAutomationSession(sessionId: string, active: boolean): boolean {
    if (active) {
      this.automationSessions.add(sessionId);
      this.markAutomationActivity();
      return false;
    }

    this.automationSessions.delete(sessionId);
    if (this.automationSessions.size > 0) return false;
    if (!this.automationActive) return true;
    if (this.automationTimer) {
      clearTimeout(this.automationTimer);
      this.automationTimer = null;
    }
    this.automationActive = false;
    this.emit({ type: "automation-active", active: false });
    return true;
  }

  /**
   * Ensure a tab is mounted + attached before a tool drives it. Marks activity
   * (so the renderer mounts the headless host) and, if the tab was unmounted
   * while idle, waits for it to remount + re-attach.
   */
  async ensureTabReady(tabId: string): Promise<void> {
    this.markAutomationActivity();
    const tab = this.findTab(tabId);
    if (!tab || tab.isAttached()) return;
    await this.awaitAttach(tab);
  }

  /** Wait for a tab's `<webview>` to mount + attach, capped at ATTACH_TIMEOUT_MS. */
  private awaitAttach(tab: BrowserTab): Promise<void> {
    return Promise.race([
      tab.whenAttached(),
      new Promise<void>((resolve) => setTimeout(resolve, ATTACH_TIMEOUT_MS)),
    ]);
  }

  private hasHostWindow(): boolean {
    for (const host of this.hosts) {
      if (!host.isDestroyed()) return true;
    }
    return false;
  }

  private readLinkSettings(): { linkPresentationMode: BrowserLinkPresentationMode } {
    try {
      const browser = readSharedSettingsFile(this.paths.settingsPath).browser;
      return {
        linkPresentationMode: browser.linkPresentationMode,
      };
    } catch {
      return { linkPresentationMode: "panel" };
    }
  }

  private async openSystemBrowser(rawUrl: string): Promise<boolean> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return false;
    }
    if (!SYSTEM_BROWSER_PROTOCOLS.has(url.protocol)) return false;
    await shell.openExternal(url.toString());
    return true;
  }

  async openLink(rawUrl: string): Promise<boolean> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return false;
    }

    if (!INTERNAL_BROWSER_PROTOCOLS.has(url.protocol)) {
      return this.openSystemBrowser(url.toString());
    }

    void this.createTab({ url: url.toString(), activate: true, reveal: true }).catch(() => {});
    return true;
  }

  private toInfo(t: BrowserTab): BrowserTabInfo {
    const s = this.publicSnapshot(t, t.snapshot());
    const groupId = this.tabGroups.groupIdForTab(s.tabId);
    const sensitiveIntegration = this.sensitiveIntegrationTabs.has(s.tabId);
    return {
      tabId: s.tabId,
      url: s.url,
      title: s.title,
      loading: s.loading,
      canGoBack: s.canGoBack,
      canGoForward: s.canGoForward,
      devToolsOpen: s.devToolsOpen,
      ...(s.faviconUrl ? { faviconUrl: s.faviconUrl } : {}),
      ...(groupId ? { groupId } : {}),
      ...(sensitiveIntegration ? { sensitiveIntegration: true } : {}),
    };
  }

  snapshot(): BrowserState {
    return {
      tabs: this.tabs.map((t) => this.toInfo(t)),
      activeTabId: this.activeTabId,
      extracted: this.options.isExtracted?.() === true,
      bookmarks: this.bookmarks.list(),
      bookmarkBarVisible: this.bookmarks.isBarVisible(),
      groups: this.tabGroups.snapshot(),
    };
  }

  // -- Tab groups -----------------------------------------------------------

  setGroupCollapsed(groupId: string, collapsed: boolean): void {
    if (!this.tabGroups.setCollapsed(groupId, collapsed)) return;
    if (
      collapsed &&
      this.activeTabId &&
      this.tabGroups.groupIdForTab(this.activeTabId) === groupId
    ) {
      const activeIndex = this.tabs.findIndex((tab) => tab.tabId === this.activeTabId);
      this.activeTabId = this.visibleTabIdAtOrNear(activeIndex + 1);
    }
    this.emitState();
    this.schedulePersist();
  }

  /** Remove a group and detach all its tabs (the tabs themselves stay open). */
  ungroupGroup(groupId: string): void {
    if (!this.tabGroups.ungroup(groupId)) return;
    this.emitState();
    this.schedulePersist();
  }

  renameGroup(groupId: string, title: string): void {
    if (!this.tabGroups.rename(groupId, title)) return;
    this.emitState();
    this.schedulePersist();
  }

  setGroupColor(groupId: string, color: BrowserTabGroupInfo["color"]): void {
    if (!this.tabGroups.setColor(groupId, color)) return;
    this.emitState();
    this.schedulePersist();
  }

  /** Close every tab in a group (the group is pruned once empty). */
  async closeGroup(groupId: string): Promise<void> {
    const ids = this.tabGroups.tabIdsInGroup(groupId);
    for (const tabId of ids) {
      await this.closeTab(tabId);
    }
  }

  /** Open a new tab already inside `groupId`. */
  async newTabInGroup(groupId: string): Promise<BrowserTabInfo> {
    const info = await this.createTab({ activate: true });
    if (!this.tabGroups.assignTabToGroup(this.tabs, info.tabId, groupId)) return info;
    this.emitState();
    this.schedulePersist();
    return info;
  }

  addBookmark(bookmark: BrowserBookmark): void {
    this.bookmarks.add(bookmark);
    this.emitState();
  }

  removeBookmark(url: string): void {
    this.bookmarks.remove(url);
    this.emitState();
  }

  setBookmarkBarVisible(visible: boolean): void {
    this.bookmarks.setBarVisible(visible);
    this.emitState();
  }

  private findTab(tabId: string): BrowserTab | undefined {
    return this.tabs.find((t) => t.tabId === tabId);
  }

  attachWebContents(tabId: string, webContentsId: number): void {
    const tab = this.findTab(tabId);
    if (!tab) return;
    // Reject a host window's own WebContents by id first, before resolving it.
    for (const host of this.hosts) {
      if (host.webContents.id === webContentsId) return;
    }
    const wc = resolveWebContentsById(webContentsId);
    if (!wc) return;
    for (const host of this.hosts) {
      if (host.webContents === wc) return;
    }
    tab.attach(wc);
    const sensitive = this.sensitiveIntegrationTabs.get(tabId);
    if (sensitive && !sensitive.navigationStarted && sensitive.privateUrl) {
      const privateUrl = sensitive.privateUrl;
      sensitive.navigationStarted = true;
      sensitive.privateUrl = null;
      void tab.loadURL(privateUrl).catch(() => {
        // Keep the one-use URL redacted even when navigation fails. The user
        // can safely close the blank integration tab and try again.
      });
    }
  }

  async createSensitiveIntegrationTab(
    payload: { url: string; activate?: boolean; reveal?: boolean },
    opts: CreateTabOptions = {},
  ): Promise<BrowserTabInfo> {
    const privateUrl = parseInternalBrowserUrl(payload.url);
    if (!privateUrl) throw new Error("Sensitive integration URL must use HTTP(S)");
    return this.createTabInternal(
      {
        ...(payload.activate !== undefined ? { activate: payload.activate } : {}),
        ...(payload.reveal !== undefined ? { reveal: payload.reveal } : {}),
      },
      opts,
      privateUrl.toString(),
    );
  }

  async createTab(
    payload: { url?: string; activate?: boolean; reveal?: boolean },
    opts: CreateTabOptions = {},
  ): Promise<BrowserTabInfo> {
    return this.createTabInternal(payload, opts);
  }

  private async createTabInternal(
    payload: { url?: string; activate?: boolean; reveal?: boolean },
    opts: CreateTabOptions,
    sensitiveInitialUrl?: string,
  ): Promise<BrowserTabInfo> {
    // Creating a tab is agent activity (mounts the headless host). Restore
    // passes markActivity:false so reopening the app doesn't wake dormant tabs.
    if (opts.markActivity !== false) this.markAutomationActivity();
    // Same presentation path as openLink / openExternal: emit open-panel so
    // useBrowserSync places the browser in panel or overlay (and above the
    // file editor when that is open).
    if (payload.reveal) {
      this.revealForUserOpen();
    }
    const tabId = `tab-${randomUUID()}`;
    if (sensitiveInitialUrl) {
      this.sensitiveIntegrationTabs.set(tabId, {
        privateUrl: sensitiveInitialUrl,
        navigationStarted: false,
      });
    }
    const tab = new BrowserTab({
      tabId,
      ...(payload.url ? { initialUrl: payload.url } : {}),
      ...(opts.restoredTitle ? { initialTitle: opts.restoredTitle } : {}),
      userAgent: this.browserUserAgent,
      onUpdate: (snap) => {
        this.onTabUpdate(tab, snap);
      },
      onAttention: (id) => {
        this.emit({ type: "tab-attention", tabId: id });
      },
      onPopup: (sourceTabId, popupUrl) => {
        const popup = this.sensitiveIntegrationTabs.has(sourceTabId)
          ? this.createSensitiveIntegrationTab({ url: popupUrl, activate: true, reveal: true })
          : this.openLink(popupUrl);
        void popup.catch(() => {});
      },
    });
    this.tabs.push(tab);
    // Agent-created tabs auto-join a group (parity with the external extension)
    // so they're visually distinct from the user's tabs. Tabs carrying a thread
    // get that thread's own group (named after its task); the rest fall back to
    // the shared "Y Space" group.
    if (opts.agent) {
      this.tabGroups.assignAgentTab(this.tabs, tabId, opts.threadId, opts.threadTitle);
      if (opts.threadId) this.activeAgentTabByThread.set(opts.threadId, tabId);
    }
    const shouldActivate = payload.activate !== false;
    if (shouldActivate || this.activeTabId === null) {
      this.activeTabId = tabId;
    }
    this.emitState();
    this.schedulePersist();
    // Wait for the renderer to mount the <webview> and attach its webContents
    // so callers (e.g. MCP) can immediately use cdp / dialogs / network.
    if (opts.awaitAttach !== false) {
      await this.awaitAttach(tab);
    }
    return this.toInfo(tab);
  }

  private publicSnapshot(tab: BrowserTab, snapshot: BrowserTabSnapshot): BrowserTabSnapshot {
    if (!this.sensitiveIntegrationTabs.has(tab.tabId)) return snapshot;
    return {
      tabId: tab.tabId,
      url: REDACTED_INTEGRATION_URL,
      // Keep localized presentation in the renderer. Main exposes only the
      // semantic sensitive-tab flag alongside a blank, non-secret title.
      title: "",
      loading: true,
      canGoBack: false,
      canGoForward: false,
      devToolsOpen: false,
    };
  }

  private onTabUpdate(tab: BrowserTab, snapshot: BrowserTabSnapshot): void {
    if (this.sensitiveIntegrationTabs.has(tab.tabId)) {
      this.emit({
        type: "tab-updated",
        tab: { ...this.publicSnapshot(tab, snapshot), sensitiveIntegration: true },
      });
      this.schedulePersist();
      return;
    }

    this.emit({ type: "tab-updated", tab: { ...snapshot } });
    if (!snapshot.loading) this.history.record(snapshot.url, snapshot.title, Date.now());
    this.schedulePersist();
  }

  setActiveTab(tabId: string): void {
    if (!this.findTab(tabId)) return;
    if (this.activeTabId === tabId) return;
    this.activeTabId = tabId;
    this.emitState();
    this.schedulePersist();
  }

  moveTab(tabId: string, targetTabId: string, position: "before" | "after"): void {
    if (tabId === targetTabId) return;
    const from = this.tabs.findIndex((t) => t.tabId === tabId);
    const target = this.tabs.findIndex((t) => t.tabId === targetTabId);
    if (from < 0 || target < 0) return;
    const [tab] = this.tabs.splice(from, 1);
    if (!tab) return;
    let to = this.tabs.findIndex((t) => t.tabId === targetTabId);
    if (to < 0) {
      this.tabs.splice(from, 0, tab);
      return;
    }
    if (position === "after") to += 1;
    this.tabs.splice(to, 0, tab);
    this.tabGroups.moveTabToTargetGroup(tabId, targetTabId);
    this.emitState();
    this.schedulePersist();
  }

  async closeTab(tabId: string): Promise<void> {
    const idx = this.tabs.findIndex((t) => t.tabId === tabId);
    if (idx < 0) return;
    const [tab] = this.tabs.splice(idx, 1);
    if (!tab) return;
    for (const [threadId, activeTabId] of this.activeAgentTabByThread) {
      if (activeTabId === tabId) this.activeAgentTabByThread.delete(threadId);
    }
    try {
      await tab.destroy();
    } finally {
      this.sensitiveIntegrationTabs.delete(tabId);
    }
    this.tabGroups.removeTab(tabId);
    if (this.activeTabId === tabId) {
      this.activeTabId = this.visibleTabIdAtOrNear(idx);
    }
    this.emitState();
    this.schedulePersist();
  }

  /**
   * Pick the nearest tab that is actually represented by a focusable tab in
   * the strip. Prefer the tab at/to the right of `index`, then walk left.
   */
  private visibleTabIdAtOrNear(index: number): string | null {
    const collapsedGroupIds = new Set(
      this.tabGroups
        .snapshot()
        .filter((group) => group.collapsed)
        .map((group) => group.id),
    );
    const isVisible = (tab: BrowserTab) => {
      const groupId = this.tabGroups.groupIdForTab(tab.tabId);
      return !groupId || !collapsedGroupIds.has(groupId);
    };
    for (
      let candidateIndex = Math.max(0, index);
      candidateIndex < this.tabs.length;
      candidateIndex += 1
    ) {
      const candidate = this.tabs[candidateIndex];
      if (candidate && isVisible(candidate)) return candidate.tabId;
    }
    for (
      let candidateIndex = Math.min(index - 1, this.tabs.length - 1);
      candidateIndex >= 0;
      candidateIndex -= 1
    ) {
      const candidate = this.tabs[candidateIndex];
      if (candidate && isVisible(candidate)) return candidate.tabId;
    }
    return null;
  }

  async navigate(tabId: string, url: string): Promise<void> {
    const t = this.findTab(tabId);
    if (!t) throw new Error(`No browser tab: ${tabId}`);
    await t.loadURL(url);
  }

  async back(tabId: string): Promise<void> {
    const t = this.findTab(tabId);
    if (!t || !t.isAttached()) return;
    const wc = t.webContents;
    if (wc.navigationHistory.canGoBack()) {
      wc.navigationHistory.goBack();
    }
  }

  async forward(tabId: string): Promise<void> {
    const t = this.findTab(tabId);
    if (!t || !t.isAttached()) return;
    const wc = t.webContents;
    if (wc.navigationHistory.canGoForward()) {
      wc.navigationHistory.goForward();
    }
  }

  async reload(tabId: string): Promise<void> {
    const t = this.findTab(tabId);
    if (!t || !t.isAttached()) return;
    t.webContents.reload();
  }

  async hardReload(tabId: string): Promise<void> {
    const t = this.findTab(tabId);
    if (!t) return;
    t.hardReload();
  }

  async toggleDevTools(tabId: string): Promise<void> {
    const t = this.findTab(tabId);
    if (!t) return;
    t.toggleDevTools();
  }

  async clearHistory(tabId: string): Promise<void> {
    this.history.clear();
    const t = this.findTab(tabId);
    if (!t) return;
    t.clearHistory();
  }

  async suggest(query: string): Promise<{
    history: Array<{ url: string; title: string }>;
    suggestions: string[];
  }> {
    const history = this.history.query(query, 6).map((e) => ({ url: e.url, title: e.title }));
    const suggestions = await fetchSearchSuggestions(query, this.browserUserAgent);
    return { history, suggestions };
  }

  recentHistory(limit: number): Array<{ url: string; title: string }> {
    return this.history.recent(limit).map((e) => ({ url: e.url, title: e.title }));
  }

  async clearCookies(tabId: string): Promise<void> {
    const t = this.findTab(tabId);
    if (!t) return;
    await t.clearCookies();
  }

  async clearCache(tabId: string): Promise<void> {
    const t = this.findTab(tabId);
    if (!t) return;
    await t.clearCache();
  }

  async capturePng(tabId: string): Promise<Buffer | null> {
    const t = this.findTab(tabId);
    if (!t || !t.isAttached()) return null;
    return await t.capturePng();
  }

  /**
   * Browser-login capture (cookie/device-code flows) lives in
   * {@link BrowserLoginCaptureCoordinator}; these thin delegates keep the public
   * API stable for `UsageLoginManager` and the IPC layer.
   */
  captureLoginCookies(opts: {
    loginUrl: string;
    cookieUrl: string;
    authCookiePattern: RegExp;
    timeoutMs: number;
    providerLabel?: string;
    validateSession?: (cookieHeader: string) => Promise<boolean>;
  }): Promise<{ ok: boolean; cookie?: string; cancelled?: boolean; error?: string }> {
    return this.loginCoordinator.captureLoginCookies(opts);
  }

  captureLoginLocalStorage(opts: {
    loginUrl: string;
    keys: string[];
    requiredKey: string;
    timeoutMs: number;
    providerLabel?: string;
  }): Promise<{
    ok: boolean;
    values?: Record<string, string>;
    cancelled?: boolean;
    error?: string;
  }> {
    return this.loginCoordinator.captureLoginLocalStorage(opts);
  }

  resolveUsageLoginConfirmation(payload: {
    requestId: string;
    action: UsageLoginConfirmationAction;
  }): void {
    this.loginCoordinator.resolveUsageLoginConfirmation(payload);
  }

  showUsageLoginDeviceCode(deviceCode: UsageLoginDeviceCode): void {
    this.loginCoordinator.showUsageLoginDeviceCode(deviceCode);
  }

  clearUsageLoginDeviceCode(providerId: string): void {
    this.loginCoordinator.clearUsageLoginDeviceCode(providerId);
  }

  clearLoginCookies(opts: { cookieUrl: string; authCookiePattern: RegExp }): Promise<void> {
    return this.loginCoordinator.clearLoginCookies(opts);
  }

  /** Cancel an in-flight `captureLoginCookies` (e.g. user closed the overlay). */
  cancelLoginCapture(): void {
    this.loginCoordinator.cancelLoginCapture();
  }

  getActiveTab(): BrowserTab | null {
    if (!this.activeTabId || this.sensitiveIntegrationTabs.has(this.activeTabId)) return null;
    return this.findTab(this.activeTabId) ?? null;
  }

  /** Resolve a thread's implicit target without consulting another agent's visible tab. */
  getActiveTabForThread(threadId: string): BrowserTab | null {
    const remembered = this.activeAgentTabByThread.get(threadId);
    if (remembered) {
      const tab = this.findTab(remembered);
      if (tab && !this.sensitiveIntegrationTabs.has(remembered)) return tab;
      this.activeAgentTabByThread.delete(threadId);
    }
    const ownedIds = this.tabGroups.tabIdsForThread(threadId);
    const fallbackId = ownedIds[ownedIds.length - 1];
    if (!fallbackId) return null;
    const fallback = this.findTab(fallbackId);
    if (!fallback || this.sensitiveIntegrationTabs.has(fallbackId)) return null;
    this.activeAgentTabByThread.set(threadId, fallbackId);
    return fallback;
  }

  /** Remember an explicit agent selection for later tabId-omitted calls. */
  rememberTabForThread(threadId: string, tabId: string): boolean {
    if (!this.findTab(tabId) || this.sensitiveIntegrationTabs.has(tabId)) return false;
    this.activeAgentTabByThread.set(threadId, tabId);
    return true;
  }

  getTab(tabId: string): BrowserTab | null {
    if (this.sensitiveIntegrationTabs.has(tabId)) return null;
    return this.findTab(tabId) ?? null;
  }

  async startPicker(payload: {
    threadId: string;
    tabId: string;
  }): Promise<BrowserStartPickerResult> {
    const tab = this.findTab(payload.tabId);
    if (!tab) {
      return { ok: false, error: `No browser tab: ${payload.tabId}` };
    }
    if (!tab.isAttached()) {
      return { ok: false, error: `Browser tab ${payload.tabId} is not ready` };
    }
    if (this.pendingPicker) {
      return { ok: false, error: "Picker already active" };
    }
    return await new Promise<BrowserStartPickerResult>((resolve) => {
      this.pendingPicker = { threadId: payload.threadId, tabId: payload.tabId, resolve };
      this.bindPickerShortcut(tab);
      const wc = tab.webContents;
      // Only focus if not already focused — `webContents.focus()` can shift
      // focus onto the currently-focused element of the page, which Chromium
      // may scroll into view, producing a visible page jump the moment the
      // picker starts.
      if (!wc.isFocused()) wc.focus();
      const script = buildPickerScript(payload.tabId, PICKER_COMMIT_ORIGIN);
      wc.executeJavaScript(script, false)
        .then((pickerPayload: unknown) => {
          if (!isPickerPayload(pickerPayload)) return;
          void this.onPickerCommit({ tabId: payload.tabId, payload: pickerPayload });
        })
        .catch((err) => {
          if (this.pendingPicker && this.pendingPicker.tabId === payload.tabId) {
            this.clearPickerShortcut();
            this.pendingPicker = null;
            resolve({ ok: false, error: (err as Error).message ?? "Picker injection failed" });
          }
        });
    });
  }

  cancelPicker(): void {
    if (!this.pendingPicker) return;
    const active = this.findTab(this.pendingPicker.tabId);
    if (active && active.isAttached()) {
      active.webContents
        .executeJavaScript(
          `(() => { window.dispatchEvent(new CustomEvent("__poracode_picker_cancel")); })()`,
          false,
        )
        .catch(() => {});
    }
    this.clearPickerShortcut();
    this.pendingPicker.resolve({ ok: true, cancelled: true });
    this.pendingPicker = null;
    this.emit({ type: "picker-cancelled" });
  }

  private async onPickerCommit(commit: { tabId: string; payload: PickerPayload }): Promise<void> {
    const pending = this.pendingPicker;
    if (!pending || pending.tabId !== commit.tabId) return;
    this.clearPickerShortcut();
    this.pendingPicker = null;

    if (commit.payload.kind === "cancelled") {
      pending.resolve({ ok: true, cancelled: true });
      this.emit({ type: "picker-cancelled" });
      return;
    }

    try {
      const result = await this.captureElement(pending.threadId, commit.tabId, {
        selector: commit.payload.selector,
        rect: commit.payload.rect,
        url: commit.payload.url,
        title: commit.payload.title,
      });
      pending.resolve(result);
    } catch (err) {
      pending.resolve({ ok: false, error: (err as Error).message ?? "Capture failed" });
    }
  }

  private async captureElement(
    threadId: string,
    tabId: string,
    pick: {
      selector: string;
      rect: { x: number; y: number; width: number; height: number };
      url: string;
      title: string;
    },
  ): Promise<BrowserStartPickerResult> {
    const tab = this.findTab(tabId);
    if (!tab || !tab.isAttached()) return { ok: false, error: `No browser tab: ${tabId}` };

    // The user clicked the element in the picker, so it's already inside the
    // viewport. Capture from the renderer's painted bitmap via
    // `webContents.capturePage` — no scrolling, no CDP off-surface path, and
    // no visible flicker. `pick.rect` is viewport-relative as captured by the
    // picker script.
    const rect = pick.rect;
    const clip = {
      x: Math.max(0, Math.floor(rect.x)),
      y: Math.max(0, Math.floor(rect.y)),
      width: Math.max(1, Math.ceil(rect.width)),
      height: Math.max(1, Math.ceil(rect.height)),
    };
    const bytes = await tab.capturePng(clip);

    const data = new Uint8Array(bytes);
    const path = saveClipboardImageFile(this.paths, {
      threadId,
      data,
      extension: "png",
    });
    const baseName = path.split(/[\\/]/).pop() ?? "Selection.png";
    return {
      ok: true,
      attachmentPath: path,
      attachmentName: baseName,
      mimeType: "image/png",
      selector: pick.selector,
      sourceUrl: pick.url,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  }
}

function parseInternalBrowserUrl(rawUrl: string): URL | null {
  try {
    const url = new URL(rawUrl);
    return INTERNAL_BROWSER_PROTOCOLS.has(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function isEscapeKeyDown(input: Electron.Input): boolean {
  if (input.type !== "keyDown") return false;
  return input.key === "Escape" || input.key === "Esc" || input.code === "Escape";
}

function isPickerPayload(value: unknown): value is PickerPayload {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "cancelled") return true;
  if (kind !== "picked") return false;
  const payload = value as { selector?: unknown; rect?: unknown; url?: unknown; title?: unknown };
  return (
    typeof payload.selector === "string" &&
    typeof payload.url === "string" &&
    typeof payload.title === "string" &&
    typeof payload.rect === "object" &&
    payload.rect !== null
  );
}
