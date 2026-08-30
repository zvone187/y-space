import { randomUUID } from "node:crypto";
import {
  BrowserWindow,
  WebContentsView,
  session as electronSession,
  shell,
  type WebContents,
} from "electron";
import {
  IPC_EVENT_CHANNELS,
  type BrowserAcknowledgeAutomationPresentationPayload,
  type BrowserAutomationPresentationSurface,
  type BrowserEvent,
  type BrowserInvalidateAutomationPresentationPayload,
  type BrowserRect,
  type BrowserState,
  type BrowserStartPickerResult,
  type BrowserTabGroupInfo,
  type BrowserTabInfo,
} from "@/shared/ipc";
import type { UsageLoginConfirmationAction, UsageLoginDeviceCode } from "@/shared/contracts";
import { BROWSER_HOME_URL } from "@/shared/browserDefaults";
import type { PoracodePaths } from "@/shared/poracodePaths";
import type { BrowserLinkPresentationMode } from "@/shared/settings";
import { dbGetState, dbSetState } from "../db";
import { readSharedSettingsFile } from "../sharedSettingsFile";
import { saveClipboardImageFile } from "../attachments/localFiles";
import { BrowserLoginCaptureCoordinator } from "./BrowserLoginCaptureCoordinator";
import {
  BrowserTab,
  BROWSER_TAB_ATTACH_TIMEOUT_MS,
  MAX_BROWSER_URL_BYTES,
  type BrowserTabSnapshot,
  resolveWebContentsById,
} from "./BrowserTab";
import { BrowserTabGroups } from "./BrowserTabGroups";
import { BrowserHistoryStore, fetchSearchSuggestions } from "./browserHistory";
import { BrowserBookmarkStore, type BrowserBookmark } from "./browserBookmarks";
import { truncateUtf8 } from "./boundedText";
import { setCursorOverlayVisible } from "./cursorOverlay";
import { isNavigationUrlAllowed } from "./permissions";
import { withSensitiveSessionCleanupTimeout } from "./cleanupSensitiveSessionPartition";
import {
  allocateSensitiveSessionPartition,
  beginSensitiveSessionPartitionCleanup,
  claimSensitiveSessionPartition,
  completeSensitiveSessionPartitionCleanup,
  isPooledSensitiveSessionPartition,
  releaseUnusedSensitiveSessionPartition,
  type SensitiveSessionPartitionPoolLease,
} from "./sensitiveSessionPartitionPool";
import { PICKER_COMMIT_ORIGIN, onPickerCommit } from "./picker/pickerProtocol";
import { buildPickerScript } from "./picker/pickerScript";

const PERSIST_KEY = "browser-panel-tabs-v1";
const PERSIST_DEBOUNCE_MS = 750;

function shortPresentationId(value: string | null | undefined): string | null {
  return value ? value.slice(0, 8) : null;
}
/** Lightweight metadata may outlive a suspended webview, but it is still
 * bounded so a runaway agent cannot grow persisted tabs without limit. */
export const MAX_BROWSER_TABS = 30;
/** Sensitive OAuth guests are pinned outside the ordinary residency budget;
 * cap them separately so abandoned connect flows cannot grow live Chromium
 * guests without bound. Four still permits a parent flow plus popup chain. */
export const MAX_SENSITIVE_BROWSER_TABS = 4;
/** Active ephemeral partitions plus in-flight cleanup records share one hard
 * ceiling, so a slow cleanup backend cannot become a renderer-driven heap DoS. */
export const MAX_TRACKED_SENSITIVE_SESSION_PARTITIONS = 32;
/** A crashed OAuth renderer gets a small, lifetime-bounded number of delayed
 * replacements. Never spin Chromium guests in an unbounded crash loop. */
export const SENSITIVE_VIEW_RECOVERY_DELAYS_MS = [100, 500, 2_000] as const;
// How long the browser stays "active" (webviews kept mounted for headless work)
// after the last agent tool call, before the renderer unmounts them.
const AUTOMATION_GRACE_MS = 45_000;
/** Explicit browser.enable sessions are leased so a crashed agent cannot keep
 * Chromium guests resident for the rest of the desktop app's lifetime. Every
 * page-targeting call refreshes this lease. */
export const AUTOMATION_SESSION_LEASE_MS = 120_000;
/** Per-thread implicit targets are convenience metadata, not an unbounded task
 * registry. Keep a generous LRU ceiling above the browser tab metadata cap. */
export const MAX_REMEMBERED_AGENT_TARGETS = 128;
/** Renderer/compositor presentation must be confirmed before native input is
 * dispatched. A missing, hidden, or torn-down renderer therefore fails closed
 * instead of letting an action land on an unobserved page. */
export const AUTOMATION_PRESENTATION_TIMEOUT_MS = 2_000;
/** Diagnostic logging is opt-in and lifetime-bounded so a failing renderer
 * retry loop cannot turn troubleshooting into an unbounded log sink. */
export const MAX_AUTOMATION_PRESENTATION_TRACE_EVENTS = 64;
const INTERNAL_BROWSER_PROTOCOLS = new Set(["http:", "https:"]);
const SYSTEM_BROWSER_PROTOCOLS = new Set(["mailto:"]);
const REDACTED_INTEGRATION_URL = "about:blank";
const MAX_PICKER_SELECTOR_BYTES = 8 * 1024;
const MAX_PICKER_URL_BYTES = MAX_BROWSER_URL_BYTES;
const MAX_PICKER_TITLE_BYTES = 8 * 1024;
const MAX_PICKER_COORDINATE = 1_000_000;
const MAX_PICKER_CLIP_DIMENSION = 4096;
const MAX_PICKER_CLIP_PIXELS = 16 * 1024 * 1024;
const SENSITIVE_SESSION_PARTITION_PATTERN = /^(?:pipedream|sensitive)-oauth-[a-f0-9]{32}$/u;

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
  cleanupSensitiveSessionPartition?: (partition: string) => Promise<void>;
}

interface CreateTabOptions {
  markActivity?: boolean;
  awaitAttach?: boolean;
  agent?: boolean;
  threadId?: string;
  threadTitle?: string;
  restoredTitle?: string;
}

export interface SensitiveIntegrationTabOwnership {
  readonly sessionPartition: string;
  /** Exact process-local generation capability for fixed pooled partitions. */
  readonly nativeSessionPartitionLease?: SensitiveSessionPartitionPoolLease;
  canOpenTab(): boolean;
  onTabOpened(tabId: string): void;
  onTabClosed(tabId: string): void;
}

interface SensitiveIntegrationTabState {
  /** Latest safe resume point, retained only in main-process memory. */
  privateResumeUrl: string;
  /** Main-only flow capability inherited by every popup descendant. */
  ownership: SensitiveIntegrationTabOwnership;
  /** Non-persistent session name retained only in main. Renderer-owned
   * webviews never receive or select it. */
  sessionPartition: string;
  partitionLease: SensitiveSessionPartitionLease;
  /** OAuth content is a main-owned native child view. Keeping both the view
   * and its current parent here makes renderer webview attachment irrelevant
   * to the sensitive session authority. */
  view: WebContentsView | null;
  viewHost: BrowserWindow | null;
  viewGeneration: number;
  viewRecoveryAttempts: number;
  viewRecoveryTimer: ReturnType<typeof setTimeout> | null;
  viewLifecycleCleanup: (() => void) | null;
  viewDestruction: Promise<void> | null;
  presentation: {
    host: BrowserWindow;
    bounds: Electron.Rectangle;
    visible: boolean;
    generation: number;
  } | null;
}

interface SensitiveSessionPartitionLease {
  readonly ownership: SensitiveIntegrationTabOwnership;
  readonly partition: string;
  readonly generation: number;
  readonly nativePoolLease: SensitiveSessionPartitionPoolLease | null;
  released: boolean;
}

interface SensitiveSessionPartitionReference {
  readonly ownership: SensitiveIntegrationTabOwnership;
  readonly generation: number;
  count: number;
}

interface SensitiveSessionPartitionCleanup {
  readonly generation: number;
  readonly promise: Promise<void>;
}

interface BrowserGuestOwnership {
  readonly tabId: string;
  readonly webContentsId: number;
  readonly webContents: WebContents;
  readonly onDestroyed: () => void;
}

interface BrowserHostFrameIdentity {
  readonly processId: number;
  readonly routingId: number;
}

interface PendingBrowserGuestReplacement {
  readonly tabId: string;
  readonly webContentsId: number;
  readonly webContents: WebContents;
  readonly senderHost: BrowserWindow;
  readonly senderFrame: BrowserHostFrameIdentity;
}

interface AutomationSessionState {
  readonly tabIds: Set<string>;
  leaseTimer: ReturnType<typeof setTimeout>;
}

interface PendingAutomationPresentation {
  readonly tabId: string;
  readonly surface: BrowserAutomationPresentationSurface;
  readonly revision: number;
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly resolve: (lease: AutomationPresentationLease | null) => void;
}

/** Opaque, one-presentation proof returned only after the renderer confirms
 * that the exact ordinary browser page reached the requested compositor
 * surface. Callers must revalidate it immediately before native input. */
export interface AutomationPresentationLease {
  readonly requestId: string;
  readonly tabId: string;
  readonly surface: BrowserAutomationPresentationSurface;
  readonly revision: number;
}

export class BrowserPanelManager {
  private tabs: BrowserTab[] = [];
  private readonly tabGroups = new BrowserTabGroups();
  private activeTabId: string | null = null;
  private hosts = new Set<BrowserWindow>();
  /** Exact listener teardown for every bound renderer host. Binding is
   * idempotent and manager disposal must not retain closures through a live
   * BrowserWindow. */
  private readonly hostLifecycleCleanups = new Map<BrowserWindow, () => void>();
  /** The main renderer is always the first host bound; extracted browser hosts
   * are additional mirrors. Track it explicitly so a stale extracted window
   * can never receive main-surface focus. */
  private mainHost: BrowserWindow | null = null;
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
  /** Classification is immutable while native destruction is pending. A
   * delayed popup callback from a closing OAuth renderer must never fall
   * through to ordinary persistent-browser creation. */
  private readonly closingSensitiveIntegrationTabIds = new Set<string>();
  private readonly sensitiveSessionPartitionReferences = new Map<
    string,
    SensitiveSessionPartitionReference
  >();
  /** Retire a flow capability by object identity without retaining every
   * random partition string forever. Weak ownership retirement plus an exact
   * active/cleanup generation prevents late reuse while remaining GC-bounded. */
  private readonly retiredSensitiveSessionOwnerships =
    new WeakSet<SensitiveIntegrationTabOwnership>();
  private readonly sensitiveSessionPartitionCleanups = new Map<
    string,
    SensitiveSessionPartitionCleanup
  >();
  private nextSensitiveSessionPartitionGeneration = 0;
  /** A Chromium guest is a single security principal. Renderer attachment
   * notifications may repeat or arrive out of order, so enforce a bijection in
   * main before BrowserTab installs any listeners or popup routing on it. */
  private readonly guestOwnershipByWebContentsId = new Map<number, BrowserGuestOwnership>();
  private readonly guestWebContentsIdByTab = new Map<string, number>();
  private readonly pendingGuestReplacementByTab = new Map<string, PendingBrowserGuestReplacement>();
  private restored = false;
  private automationActive = false;
  private readonly automationSessions = new Map<string, AutomationSessionState>();
  private readonly pendingAutomationPresentations = new Map<
    string,
    PendingAutomationPresentation
  >();
  private activeAutomationPresentation: AutomationPresentationLease | null = null;
  private automationPresentationRevision = 0;
  private automationPresentationSurface: BrowserAutomationPresentationSurface = "main";
  private automationPresentationTraceCount = 0;
  private automationPresentationTraceSuppressed = false;
  /** Renderer geometry is valid only for the host/surface document generation
   * that produced it. Lifecycle invalidation advances this epoch in main and
   * detaches every native OAuth view before any fresh bounds can be accepted. */
  private sensitiveViewGeneration = 0;
  private readonly sensitiveHostReady = new WeakMap<BrowserWindow, boolean>();
  /** A stale did-stop-loading after a renderer crash must not restore host
   * authority. A subsequent did-start/did-finish cycle clears this marker. */
  private readonly crashedSensitiveHosts = new WeakSet<BrowserWindow>();
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
    this.automationPresentationSurface = this.currentAutomationPresentationSurface();
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
    if (this.hosts.has(window)) return;
    if (!this.mainHost || this.mainHost.isDestroyed()) this.mainHost = window;
    this.hosts.add(window);
    this.crashedSensitiveHosts.delete(window);
    this.sensitiveHostReady.set(window, !window.webContents.isLoadingMainFrame());
    if (window !== this.mainHost) {
      this.invalidateSensitiveIntegrationPresentations();
    }
    const onBeforeInputEvent = (event: Electron.Event, input: Electron.Input) => {
      if (!this.pendingPicker || !isEscapeKeyDown(input)) return;
      event.preventDefault();
      this.cancelPicker();
    };
    const onDidStartLoading = () => {
      if (!this.hosts.has(window)) return;
      this.crashedSensitiveHosts.delete(window);
      this.sensitiveHostReady.set(window, false);
      this.revokeAutomationPresentation("host-loading");
      this.invalidateSensitiveIntegrationPresentations();
      this.emitState();
    };
    const onDidStopLoading = () => {
      if (
        !this.hosts.has(window) ||
        this.crashedSensitiveHosts.has(window) ||
        window.webContents.isLoadingMainFrame() ||
        this.sensitiveHostReady.get(window) === true
      ) {
        return;
      }
      // did-start-loading is spinner-level and is paired with
      // did-stop-loading. did-finish-load is document-level and may not fire
      // for every loading cycle, so relying on it alone can strand an already
      // stable host in a permanently unauthorized state.
      this.sensitiveHostReady.set(window, true);
      this.invalidateSensitiveIntegrationPresentations();
      this.emitState();
    };
    const onDidFinishLoad = () => {
      if (!this.hosts.has(window) || this.crashedSensitiveHosts.has(window)) return;
      this.sensitiveHostReady.set(window, true);
      this.invalidateSensitiveIntegrationPresentations();
      this.emitState();
    };
    const onRenderProcessGone = () => {
      if (!this.hosts.has(window)) return;
      this.crashedSensitiveHosts.add(window);
      this.sensitiveHostReady.set(window, false);
      this.revokeAutomationPresentation("host-renderer-gone");
      this.invalidateSensitiveIntegrationPresentations();
      this.emitState();
    };
    let listenersRemoved = false;
    const removeHostListeners = () => {
      if (listenersRemoved) return;
      listenersRemoved = true;
      this.hostLifecycleCleanups.delete(window);
      try {
        window.webContents.removeListener("before-input-event", onBeforeInputEvent);
        window.webContents.removeListener("did-start-loading", onDidStartLoading);
        window.webContents.removeListener("did-stop-loading", onDidStopLoading);
        window.webContents.removeListener("did-finish-load", onDidFinishLoad);
        window.webContents.removeListener("render-process-gone", onRenderProcessGone);
      } catch {}
      try {
        window.removeListener("closed", onClosed);
      } catch {}
    };
    const onClosed = () => {
      removeHostListeners();
      this.hosts.delete(window);
      this.sensitiveHostReady.delete(window);
      this.crashedSensitiveHosts.delete(window);
      if (this.mainHost === window) this.mainHost = null;
      this.revokeAutomationPresentation("host-closed");
      this.invalidateSensitiveIntegrationPresentations();
      this.emitState();
    };
    window.webContents.on("before-input-event", onBeforeInputEvent);
    window.webContents.on("did-start-loading", onDidStartLoading);
    window.webContents.on("did-stop-loading", onDidStopLoading);
    window.webContents.on("did-finish-load", onDidFinishLoad);
    window.webContents.on("render-process-gone", onRenderProcessGone);
    window.once("closed", onClosed);
    this.hostLifecycleCleanups.set(window, removeHostListeners);
    void this.restoreFromDisk();
    this.emitState();
  }

  dispose(): void {
    if (this.pendingPicker) this.cancelPicker();
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
    for (const session of this.automationSessions.values()) {
      clearTimeout(session.leaseTimer);
    }
    this.automationSessions.clear();
    this.revokeAutomationPresentation("manager-disposed");
    this.automationActive = false;
    this.clearPickerShortcut();
    this.loginCoordinator.cancelLoginConfirmations();
    for (const sensitive of this.sensitiveIntegrationTabs.values()) {
      try {
        sensitive.view?.setVisible(false);
      } catch {}
    }
    for (const tabId of this.sensitiveIntegrationTabs.keys()) {
      this.closingSensitiveIntegrationTabIds.add(tabId);
    }
    for (const t of this.tabs) {
      void (async () => {
        try {
          await t.destroy();
        } finally {
          await this.releaseSensitiveIntegrationTab(t.tabId);
        }
      })().catch(() => undefined);
    }
    for (const ownership of [...this.guestOwnershipByWebContentsId.values()]) {
      this.releaseGuestOwnership(ownership);
    }
    for (const cleanup of [...this.hostLifecycleCleanups.values()]) cleanup();
    this.hostLifecycleCleanups.clear();
    this.tabs = [];
    this.activeTabId = null;
    this.activeAgentTabByThread.clear();
    this.pendingGuestReplacementByTab.clear();
    this.hosts.clear();
    this.mainHost = null;
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
    this.synchronizeAutomationPresentationSurface();
    this.emit({ type: "state", state: this.snapshot() });
  }

  private updateActiveTabId(tabId: string | null): boolean {
    if (this.activeTabId === tabId) return false;
    this.activeTabId = tabId;
    this.revokeAutomationPresentation("active-tab-changed");
    return true;
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

  private focusMainHost(): void {
    const host = this.mainHost;
    if (!host || host.isDestroyed()) return;
    try {
      if (host.isMinimized()) host.restore();
      if (!host.isVisible()) host.show();
      host.focus();
    } catch {
      // Desktop focus is a presentation convenience, never CDP target
      // authority. The renderer's exact painted page proof remains required.
    }
  }

  /**
   * Present the exact ordinary tab an interactive automation action will use.
   * Passive inspection keeps using `ensureTabReady()` alone so it can remain
   * resident and headless. Sensitive integration guests are never eligible for
   * agent presentation through the public browser surface.
   */
  async presentAutomationTarget(tabId: string): Promise<AutomationPresentationLease | null> {
    if (this.sensitiveIntegrationTabs.has(tabId) || !this.findTab(tabId)) return null;
    const surface = this.synchronizeAutomationPresentationSurface();
    // Every handshake supersedes every earlier proof, including a repeated
    // presentation of the same tab. A revision makes A-B-A transitions
    // observable even when the final tab/surface values happen to match.
    this.revokeAutomationPresentation("presentation-superseded");
    const activeChanged = this.activeTabId !== tabId;
    this.activeTabId = tabId;
    const requestId = randomUUID();
    const revision = this.automationPresentationRevision;
    this.traceAutomationPresentation("presentation-requested", {
      request: shortPresentationId(requestId),
      tab: shortPresentationId(tabId),
      surface,
      revision,
    });
    return await new Promise<AutomationPresentationLease | null>((resolve) => {
      const timeout = setTimeout(() => {
        this.finishAutomationPresentation(requestId, null);
      }, AUTOMATION_PRESENTATION_TIMEOUT_MS);
      this.pendingAutomationPresentations.set(requestId, {
        tabId,
        surface,
        revision,
        timeout,
        resolve,
      });
      try {
        // Emit even when the backend target was already active. The ordered
        // state event makes the renderer's following request select this exact
        // first-class browser page instead of a stale peer.
        this.emitState();
        if (activeChanged) this.schedulePersist();
        if (surface === "main") this.focusMainHost();
        this.revealPanel("panel");
        this.emit({
          type: "automation-presentation-request",
          requestId,
          tabId,
          surface,
        });
      } catch {
        this.finishAutomationPresentation(requestId, null);
      }
    });
  }

  /** Complete a renderer presentation handshake. The request id is an
   * unguessable one-shot capability, while tab, surface, manager state, and
   * sensitivity are rechecked here so stale or cross-window acknowledgements
   * cannot authorize input. */
  acknowledgeAutomationPresentation(
    payload: BrowserAcknowledgeAutomationPresentationPayload,
    senderWebContentsId?: number,
    senderFrame?: { readonly processId: number; readonly routingId: number } | null,
  ): boolean {
    if (!this.isAuthorizedBrowserHostDocument(payload.surface, senderWebContentsId, senderFrame)) {
      return false;
    }
    const currentSurface = this.synchronizeAutomationPresentationSurface();
    const pending = this.pendingAutomationPresentations.get(payload.requestId);
    if (!pending) {
      this.traceAutomationPresentation("presentation-acknowledgement-missing", {
        request: shortPresentationId(payload.requestId),
        tab: shortPresentationId(payload.tabId),
        surface: payload.surface,
      });
      return false;
    }
    const checks = {
      rendererPresented: payload.presented,
      tabMatches: payload.tabId === pending.tabId,
      payloadSurfaceMatches: payload.surface === pending.surface,
      currentSurfaceMatches: currentSurface === pending.surface,
      revisionMatches: this.automationPresentationRevision === pending.revision,
      activeTabMatches: this.activeTabId === pending.tabId,
      ordinaryTab: !this.sensitiveIntegrationTabs.has(pending.tabId),
      tabExists: this.findTab(pending.tabId) !== undefined,
    };
    const presented = Object.values(checks).every(Boolean);
    const lease = presented
      ? Object.freeze({
          requestId: payload.requestId,
          tabId: pending.tabId,
          surface: pending.surface,
          revision: pending.revision,
        })
      : null;
    if (lease) this.activeAutomationPresentation = lease;
    this.traceAutomationPresentation("presentation-acknowledged", {
      request: shortPresentationId(payload.requestId),
      tab: shortPresentationId(pending.tabId),
      surface: pending.surface,
      revision: pending.revision,
      accepted: presented,
      checks,
    });
    this.finishAutomationPresentation(payload.requestId, lease);
    return presented;
  }

  /** Renderer-side visibility/store observers use the same unguessable
   * capability to revoke either an in-flight handshake or its issued lease as
   * soon as the exact page stops being presented. */
  invalidateAutomationPresentation(
    payload: BrowserInvalidateAutomationPresentationPayload,
    senderWebContentsId?: number,
    senderFrame?: { readonly processId: number; readonly routingId: number } | null,
  ): boolean {
    if (!this.isAuthorizedBrowserHostDocument(payload.surface, senderWebContentsId, senderFrame)) {
      return false;
    }
    this.synchronizeAutomationPresentationSurface();
    const pending = this.pendingAutomationPresentations.get(payload.requestId);
    const active = this.activeAutomationPresentation;
    const matchesPending =
      pending !== undefined &&
      pending.tabId === payload.tabId &&
      pending.surface === payload.surface;
    const matchesActive =
      active !== null &&
      active.requestId === payload.requestId &&
      active.tabId === payload.tabId &&
      active.surface === payload.surface;
    if (!matchesPending && !matchesActive) return false;
    this.revokeAutomationPresentation(`renderer-invalidated:${payload.reason ?? "unspecified"}`);
    return true;
  }

  /** Revalidate the exact one-shot presentation proof immediately before a
   * native input sequence. This also observes main/extracted surface changes
   * that occurred since the renderer acknowledgement. */
  validateAutomationPresentation(lease: AutomationPresentationLease): boolean {
    const currentSurface = this.synchronizeAutomationPresentationSurface();
    const currentHost = this.browserHostForSurface(lease.surface);
    const checks = {
      activeLeaseMatches: this.activeAutomationPresentation === lease,
      revisionMatches: lease.revision === this.automationPresentationRevision,
      surfaceMatches: lease.surface === currentSurface,
      activeTabMatches: lease.tabId === this.activeTabId,
      ordinaryTab: !this.sensitiveIntegrationTabs.has(lease.tabId),
      tabExists: this.findTab(lease.tabId) !== undefined,
      hostExists: currentHost !== null,
      hostReady: currentHost !== null && this.sensitiveHostReady.get(currentHost) === true,
    };
    const valid = Object.values(checks).every(Boolean);
    if (!valid) {
      this.traceAutomationPresentation("presentation-validation-failed", {
        request: shortPresentationId(lease.requestId),
        tab: shortPresentationId(lease.tabId),
        leaseRevision: lease.revision,
        currentRevision: this.automationPresentationRevision,
        leaseSurface: lease.surface,
        currentSurface,
        checks,
      });
    }
    return valid;
  }

  private currentAutomationPresentationSurface(): BrowserAutomationPresentationSurface {
    return this.options.isExtracted?.() ? "extracted" : "main";
  }

  private synchronizeAutomationPresentationSurface(): BrowserAutomationPresentationSurface {
    const current = this.currentAutomationPresentationSurface();
    if (current !== this.automationPresentationSurface) {
      this.automationPresentationSurface = current;
      this.revokeAutomationPresentation("surface-changed");
      this.invalidateSensitiveIntegrationPresentations();
    }
    return current;
  }

  private revokeAutomationPresentation(reason: string): void {
    const previousRevision = this.automationPresentationRevision;
    const active = this.activeAutomationPresentation;
    const pendingCount = this.pendingAutomationPresentations.size;
    this.automationPresentationRevision += 1;
    this.activeAutomationPresentation = null;
    this.traceAutomationPresentation("presentation-revoked", {
      reason,
      previousRevision,
      revision: this.automationPresentationRevision,
      activeRequest: shortPresentationId(active?.requestId),
      activeTab: shortPresentationId(active?.tabId),
      pendingCount,
    });
    for (const requestId of [...this.pendingAutomationPresentations.keys()]) {
      this.finishAutomationPresentation(requestId, null);
    }
  }

  private traceAutomationPresentation(event: string, details: Record<string, unknown>): void {
    // Computed access keeps this a runtime diagnostic switch in packaged
    // builds; build tooling may statically fold direct process.env access.
    if (Reflect.get(process.env, "Y_SPACE_BROWSER_PRESENTATION_TRACE") !== "1") return;
    if (this.automationPresentationTraceCount >= MAX_AUTOMATION_PRESENTATION_TRACE_EVENTS) {
      if (this.automationPresentationTraceSuppressed) return;
      this.automationPresentationTraceSuppressed = true;
      console.info("[y-space:browser-presentation]", "trace-suppressed", {
        limit: MAX_AUTOMATION_PRESENTATION_TRACE_EVENTS,
      });
      return;
    }
    this.automationPresentationTraceCount += 1;
    console.info("[y-space:browser-presentation]", event, details);
  }

  private finishAutomationPresentation(
    requestId: string,
    lease: AutomationPresentationLease | null,
  ): boolean {
    const pending = this.pendingAutomationPresentations.get(requestId);
    if (!pending) return false;
    this.pendingAutomationPresentations.delete(requestId);
    clearTimeout(pending.timeout);
    pending.resolve(lease);
    return true;
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
      this.deactivateAutomation();
    }, AUTOMATION_GRACE_MS);
  }

  setAutomationSession(sessionId: string, active: boolean): boolean {
    if (active) {
      const existing = this.automationSessions.get(sessionId);
      if (existing) {
        clearTimeout(existing.leaseTimer);
        existing.leaseTimer = this.createAutomationSessionLease(sessionId);
      } else {
        this.automationSessions.set(sessionId, {
          tabIds: new Set(),
          leaseTimer: this.createAutomationSessionLease(sessionId),
        });
      }
      this.markAutomationActivity();
      return false;
    }

    return this.releaseAutomationSession(sessionId);
  }

  touchAutomationSession(sessionId: string): void {
    const session = this.automationSessions.get(sessionId);
    if (!session) return;
    clearTimeout(session.leaseTimer);
    session.leaseTimer = this.createAutomationSessionLease(sessionId);
    this.markAutomationActivity();
  }

  /** Refresh the explicit session lease and claim a target before any mount or
   * attachment await. This ordering prevents a near-expiry lease from tearing
   * down the very guest the in-flight tool call is waiting to drive. */
  recordAutomationTarget(sessionId: string, tabId: string): void {
    const session = this.automationSessions.get(sessionId);
    if (!session) return;
    this.touchAutomationSession(sessionId);
    session.tabIds.add(tabId);
  }

  /** Track and reveal presence on every tab an explicit agent session touches.
   * Session release hides only tabs no other session still owns, then the final
   * release performs a defensive all-tab sweep. */
  async showAutomationCursor(sessionId: string, tabId: string): Promise<void> {
    if (!this.automationSessions.has(sessionId)) return;
    this.recordAutomationTarget(sessionId, tabId);
    await this.setAutomationCursorVisible(tabId, true);
  }

  private createAutomationSessionLease(sessionId: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      this.releaseAutomationSession(sessionId);
    }, AUTOMATION_SESSION_LEASE_MS);
  }

  private releaseAutomationSession(sessionId: string): boolean {
    const released = this.automationSessions.get(sessionId);
    if (released) {
      clearTimeout(released.leaseTimer);
      this.automationSessions.delete(sessionId);
      for (const tabId of released.tabIds) {
        const stillOwned = [...this.automationSessions.values()].some((session) =>
          session.tabIds.has(tabId),
        );
        if (!stillOwned) void this.setAutomationCursorVisible(tabId, false);
      }
    }
    if (this.automationSessions.size > 0) return false;
    this.deactivateAutomation();
    return true;
  }

  private deactivateAutomation(): void {
    if (this.automationTimer) {
      clearTimeout(this.automationTimer);
      this.automationTimer = null;
    }
    const wasActive = this.automationActive;
    this.automationActive = false;
    void this.hideAllAutomationCursors();
    if (wasActive) this.emit({ type: "automation-active", active: false });
  }

  private async hideAllAutomationCursors(): Promise<void> {
    await Promise.all(this.tabs.map((tab) => this.setAutomationCursorVisible(tab.tabId, false)));
  }

  private async setAutomationCursorVisible(tabId: string, visible: boolean): Promise<void> {
    const tab = this.findTab(tabId);
    if (!tab || !tab.isAttached()) return;
    try {
      await tab.cdp.attach();
      await setCursorOverlayVisible(tab.cdp, visible);
    } catch {
      // Presence is visual best-effort and must never block browser teardown.
    }
  }

  /**
   * Ensure a tab is mounted + attached before a tool drives it. Marks activity
   * (so the renderer mounts the headless host) and, if the tab was unmounted
   * while idle, waits for it to remount + re-attach.
   */
  async ensureTabReady(tabId: string): Promise<void> {
    this.markAutomationActivity();
    const tab = this.findTab(tabId);
    if (!tab) return;
    // Promote every explicit agent target, including an already-attached
    // background page. Besides refreshing LRU recency, this guarantees that a
    // suspended page is mounted before `whenAttached()` is awaited.
    this.emit({ type: "ensure-browser-page-resident", tabId });
    // A replacement guest becomes physically attached before BrowserTab has
    // restored its target-scoped CDP registrations. Await readiness even for
    // that already-mounted guest so automation cannot race a navigation ahead
    // of persistent scripts/styles being reinstalled.
    await this.awaitAttach(tab);
  }

  /** Wait for a tab's `<webview>` to mount + attach with a cancellable timeout. */
  private async awaitAttach(tab: BrowserTab): Promise<void> {
    await tab.whenAttached(BROWSER_TAB_ATTACH_TIMEOUT_MS);
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
    const sensitiveIntegration = this.sensitiveIntegrationTabs.get(s.tabId);
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
      ...(sensitiveIntegration
        ? {
            sensitiveIntegration: true as const,
            sensitiveViewGeneration: this.sensitiveViewGeneration,
          }
        : {}),
    };
  }

  snapshot(): BrowserState {
    this.synchronizeAutomationPresentationSurface();
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
      const nextActiveTabId = this.visibleTabIdAtOrNear(activeIndex + 1);
      this.updateActiveTabId(nextActiveTabId);
      this.hideSensitiveIntegrationViewsExcept(nextActiveTabId);
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

  attachWebContents(
    tabId: string,
    webContentsId: number,
    senderWebContentsId?: number,
    senderFrame?: BrowserHostFrameIdentity | null,
  ): boolean {
    const tab = this.findTab(tabId);
    const rejectAttachment = (reason: string, details: Record<string, unknown> = {}) => {
      this.traceAutomationPresentation("guest-attachment-rejected", {
        reason,
        tab: shortPresentationId(tabId),
        webContentsId,
        senderWebContentsId: senderWebContentsId ?? null,
        ...details,
      });
      return false;
    };
    if (!tab) return rejectAttachment("unknown-tab");
    // Sensitive OAuth pages are main-owned WebContentsViews. A renderer IPC
    // can never attach, replace, or name their WebContents, even if it guesses
    // an id belonging to the private session.
    if (this.sensitiveIntegrationTabs.has(tabId)) {
      return rejectAttachment("sensitive-tab");
    }
    const senderHost = [...this.hosts].find(
      (host) => !host.isDestroyed() && host.webContents.id === senderWebContentsId,
    );
    const expectedHost = this.expectedSensitiveIntegrationHost();
    if (!senderHost) return rejectAttachment("unknown-sender-host");
    if (senderHost !== expectedHost) {
      return rejectAttachment("unexpected-sender-host", {
        expectedWebContentsId: expectedHost?.webContents.id ?? null,
        surface: this.currentAutomationPresentationSurface(),
      });
    }
    if (!this.isExactHostMainFrame(senderHost, senderFrame)) {
      let currentFrame: BrowserHostFrameIdentity | null = null;
      try {
        currentFrame = {
          processId: senderHost.webContents.mainFrame.processId,
          routingId: senderHost.webContents.mainFrame.routingId,
        };
      } catch {}
      return rejectAttachment("stale-or-subframe-sender", {
        senderFrame: senderFrame ?? null,
        currentFrame,
      });
    }
    if (this.sensitiveHostReady.get(senderHost) !== true) {
      return rejectAttachment("sender-host-not-ready");
    }
    // Reject a host window's own WebContents by id first, before resolving it.
    if (senderHost.webContents.id === webContentsId) {
      return rejectAttachment("host-self-attachment");
    }
    const wc = resolveWebContentsById(webContentsId);
    if (!wc) return rejectAttachment("missing-webcontents");
    const guestType = wc.getType();
    const guestHostWebContentsId = wc.hostWebContents?.id ?? null;
    if (guestType !== "webview") {
      return rejectAttachment("unexpected-webcontents-type", { guestType });
    }
    if (wc.hostWebContents !== senderHost.webContents) {
      return rejectAttachment("guest-host-mismatch", {
        guestHostWebContentsId,
        expectedHostWebContentsId: senderHost.webContents.id,
      });
    }
    // A renderer cannot relabel a second WebContents from a live sensitive
    // session as an ordinary tab. The native OAuth view is the only accepted
    // owner of that exact session object.
    for (const sensitive of this.sensitiveIntegrationTabs.values()) {
      try {
        if (wc.session === electronSession.fromPartition(sensitive.sessionPartition)) {
          return rejectAttachment("sensitive-session-alias");
        }
      } catch {
        return rejectAttachment("sensitive-session-check-failed");
      }
    }
    const claimed = this.guestOwnershipByWebContentsId.get(webContentsId);
    if (claimed) {
      if (claimed.tabId === tabId && claimed.webContents === wc) return true;
      // A destroyed guest can disappear before its event reaches this manager.
      // Release only that exact claim; a live or reused id remains fail-closed.
      if (!claimed.webContents.isDestroyed()) {
        return rejectAttachment("webcontents-already-owned", {
          ownerTab: shortPresentationId(claimed.tabId),
        });
      }
      this.releaseGuestOwnership(claimed);
    }
    const previousWebContentsId = this.guestWebContentsIdByTab.get(tabId);
    if (previousWebContentsId !== undefined && previousWebContentsId !== webContentsId) {
      const previous = this.guestOwnershipByWebContentsId.get(previousWebContentsId);
      // Reparenting main <-> extracted mounts the proven replacement before
      // Chromium necessarily destroys the old host guest. Retain one bounded,
      // exact replacement and attach it from the old guest's destruction
      // signal; renderer dom-ready is one-shot and cannot be relied on to retry.
      if (previous && !previous.webContents.isDestroyed()) {
        this.queueGuestReplacement(tabId, webContentsId, wc, senderHost, senderFrame);
        return true;
      }
      if (previous) this.releaseGuestOwnership(previous);
      else this.guestWebContentsIdByTab.delete(tabId);
    }

    const attached = tab.attach(wc);
    if (!attached) return rejectAttachment("tab-rejected-attachment");
    this.pendingGuestReplacementByTab.delete(tabId);
    if (this.activeAutomationPresentation?.tabId === tabId) {
      this.revokeAutomationPresentation("guest-replaced");
    }
    this.claimGuestOwnership(tabId, webContentsId, wc);
    this.traceAutomationPresentation("guest-attached", {
      tab: shortPresentationId(tabId),
      webContentsId,
      senderWebContentsId: senderHost.webContents.id,
    });
    return true;
  }

  /** Position a main-owned sensitive OAuth view over its renderer anchor. The
   * renderer supplies presentation geometry only; the exact sender window,
   * active tab, view, WebContents, and private session remain main authority. */
  presentSensitiveIntegrationView(
    tabId: string,
    bounds: BrowserRect,
    visible: boolean,
    generation: number,
    senderWebContentsId: number,
    senderFrame: { readonly processId: number; readonly routingId: number } | null,
  ): void {
    const sensitive = this.sensitiveIntegrationTabs.get(tabId);
    if (!sensitive) return;
    const senderHost = [...this.hosts].find(
      (host) => !host.isDestroyed() && host.webContents.id === senderWebContentsId,
    );
    if (!senderHost || senderHost !== this.expectedSensitiveIntegrationHost()) return;
    if (!this.isExactHostMainFrame(senderHost, senderFrame)) return;
    if (
      generation !== this.sensitiveViewGeneration ||
      this.sensitiveHostReady.get(senderHost) !== true
    ) {
      return;
    }
    if (!visible || this.activeTabId !== tabId) {
      sensitive.presentation = {
        host: senderHost,
        bounds: sensitive.presentation?.bounds ?? { x: 0, y: 0, width: 1, height: 1 },
        visible: false,
        generation,
      };
      try {
        sensitive.view?.setVisible(false);
      } catch {}
      return;
    }
    const normalized = normalizeSensitiveViewBounds(bounds, senderHost.getContentBounds());
    if (!normalized) {
      sensitive.presentation = {
        host: senderHost,
        bounds: sensitive.presentation?.bounds ?? { x: 0, y: 0, width: 1, height: 1 },
        visible: false,
        generation,
      };
      try {
        sensitive.view?.setVisible(false);
      } catch {}
      return;
    }
    sensitive.presentation = {
      host: senderHost,
      bounds: normalized,
      visible: true,
      generation,
    };
    this.applySensitiveIntegrationPresentation(tabId, sensitive);
  }

  private applySensitiveIntegrationPresentation(
    tabId: string,
    sensitive: SensitiveIntegrationTabState,
  ): void {
    const view = sensitive.view;
    const presentation = sensitive.presentation;
    if (!view || view.webContents.isDestroyed() || !presentation) return;
    if (
      !presentation.visible ||
      presentation.generation !== this.sensitiveViewGeneration ||
      this.activeTabId !== tabId ||
      presentation.host !== this.expectedSensitiveIntegrationHost() ||
      this.sensitiveHostReady.get(presentation.host) !== true
    ) {
      try {
        view.setVisible(false);
      } catch {}
      return;
    }
    if (sensitive.viewHost !== presentation.host) {
      try {
        sensitive.viewHost?.contentView.removeChildView(view);
      } catch {}
      try {
        presentation.host.contentView.addChildView(view);
      } catch {
        return;
      }
      sensitive.viewHost = presentation.host;
    }
    try {
      view.setBounds(presentation.bounds);
      view.setVisible(true);
    } catch {}
  }

  private expectedSensitiveIntegrationHost(): BrowserWindow | null {
    return this.browserHostForSurface(this.currentAutomationPresentationSurface());
  }

  private browserHostForSurface(
    surface: BrowserAutomationPresentationSurface,
  ): BrowserWindow | null {
    if (surface === "extracted") {
      return [...this.hosts].find((host) => host !== this.mainHost && !host.isDestroyed()) ?? null;
    }
    return this.mainHost && !this.mainHost.isDestroyed() ? this.mainHost : null;
  }

  private isAuthorizedBrowserHostDocument(
    surface: BrowserAutomationPresentationSurface,
    senderWebContentsId?: number,
    senderFrame?: BrowserHostFrameIdentity | null,
  ): boolean {
    const host = this.browserHostForSurface(surface);
    return (
      host !== null &&
      host.webContents.id === senderWebContentsId &&
      this.isExactHostMainFrame(host, senderFrame) &&
      this.sensitiveHostReady.get(host) === true
    );
  }

  /** Electron may return distinct WebFrameMain wrapper objects for the same
   * underlying frame. Chromium's process/routing pair is the stable identity;
   * pair it with the exact sender WebContents before granting host authority. */
  private isExactHostMainFrame(
    host: BrowserWindow,
    senderFrame?: BrowserHostFrameIdentity | null,
  ): senderFrame is BrowserHostFrameIdentity {
    if (!senderFrame) return false;
    try {
      const mainFrame = host.webContents.mainFrame;
      return (
        senderFrame.processId === mainFrame.processId &&
        senderFrame.routingId === mainFrame.routingId
      );
    } catch {
      return false;
    }
  }

  private invalidateSensitiveIntegrationPresentations(): void {
    this.sensitiveViewGeneration += 1;
    for (const sensitive of this.sensitiveIntegrationTabs.values()) {
      const view = sensitive.view;
      const host = sensitive.viewHost;
      sensitive.presentation = null;
      sensitive.viewHost = null;
      try {
        view?.setVisible(false);
      } catch {}
      try {
        if (view) host?.contentView.removeChildView(view);
      } catch {}
    }
  }

  private hideSensitiveIntegrationViewsExcept(tabId: string | null): void {
    for (const [candidateTabId, sensitive] of this.sensitiveIntegrationTabs) {
      if (candidateTabId === tabId) continue;
      try {
        sensitive.presentation = sensitive.presentation
          ? { ...sensitive.presentation, visible: false }
          : null;
        sensitive.view?.setVisible(false);
      } catch {}
    }
  }

  private claimGuestOwnership(tabId: string, webContentsId: number, wc: WebContents): void {
    const ownership: BrowserGuestOwnership = {
      tabId,
      webContentsId,
      webContents: wc,
      onDestroyed: () => this.releaseGuestOwnership(ownership),
    };
    this.guestOwnershipByWebContentsId.set(webContentsId, ownership);
    this.guestWebContentsIdByTab.set(tabId, webContentsId);
    try {
      wc.once("destroyed", ownership.onDestroyed);
    } catch {
      // Retain the claim and fail closed until replacement/close cleanup.
    }
  }

  private queueGuestReplacement(
    tabId: string,
    webContentsId: number,
    webContents: WebContents,
    senderHost: BrowserWindow,
    senderFrame: BrowserHostFrameIdentity,
  ): void {
    if (webContents.isDestroyed()) return;
    for (const pending of this.pendingGuestReplacementByTab.values()) {
      if (
        pending.tabId !== tabId &&
        pending.webContentsId === webContentsId &&
        pending.webContents === webContents
      ) {
        return;
      }
    }
    this.pendingGuestReplacementByTab.set(tabId, {
      tabId,
      webContentsId,
      webContents,
      senderHost,
      senderFrame: {
        processId: senderFrame.processId,
        routingId: senderFrame.routingId,
      },
    });
  }

  private attachPendingGuestReplacement(tabId: string): void {
    const pending = this.pendingGuestReplacementByTab.get(tabId);
    if (!pending) return;
    this.pendingGuestReplacementByTab.delete(tabId);
    if (this.guestWebContentsIdByTab.has(tabId)) return;
    if (
      !this.findTab(tabId) ||
      pending.webContents.isDestroyed() ||
      pending.senderHost.isDestroyed() ||
      pending.senderHost !== this.expectedSensitiveIntegrationHost() ||
      !this.isExactHostMainFrame(pending.senderHost, pending.senderFrame) ||
      this.sensitiveHostReady.get(pending.senderHost) !== true ||
      resolveWebContentsById(pending.webContentsId) !== pending.webContents
    ) {
      return;
    }
    this.attachWebContents(
      pending.tabId,
      pending.webContentsId,
      pending.senderHost.webContents.id,
      pending.senderFrame,
    );
  }

  private releaseGuestOwnership(ownership: BrowserGuestOwnership): void {
    if (
      this.guestOwnershipByWebContentsId.get(ownership.webContentsId) !== ownership ||
      this.guestWebContentsIdByTab.get(ownership.tabId) !== ownership.webContentsId
    ) {
      return;
    }
    this.guestOwnershipByWebContentsId.delete(ownership.webContentsId);
    this.guestWebContentsIdByTab.delete(ownership.tabId);
    if (this.activeAutomationPresentation?.tabId === ownership.tabId) {
      this.revokeAutomationPresentation("guest-released");
    }
    try {
      ownership.webContents.removeListener("destroyed", ownership.onDestroyed);
    } catch {}
    queueMicrotask(() => this.attachPendingGuestReplacement(ownership.tabId));
  }

  async createSensitiveIntegrationTab(
    payload: { url: string; activate?: boolean; reveal?: boolean },
    opts: CreateTabOptions = {},
    ownership?: SensitiveIntegrationTabOwnership,
  ): Promise<BrowserTabInfo> {
    const validatedOwnership = requireSensitiveIntegrationTabOwnership(ownership);
    const partitionLease = this.retainSensitiveSessionPartition(validatedOwnership);
    try {
      const privateUrl = parseInternalBrowserUrl(payload.url);
      if (!privateUrl) throw new Error("Sensitive integration URL must use HTTP(S)");
      if (!validatedOwnership.canOpenTab()) {
        throw new Error("Sensitive integration flow is no longer active");
      }
      return await this.createTabInternal(
        {
          ...(payload.activate !== undefined ? { activate: payload.activate } : {}),
          ...(payload.reveal !== undefined ? { reveal: payload.reveal } : {}),
        },
        opts,
        privateUrl.toString(),
        validatedOwnership,
        partitionLease,
      );
    } catch (error) {
      await this.releaseSensitiveSessionPartition(partitionLease);
      throw error;
    }
  }

  /** Renderer-requested OAuth tabs receive a fresh main-owned flow capability;
   * the renderer never chooses or supplies the session partition. */
  async createIsolatedSensitiveIntegrationTab(
    payload: { url: string; activate?: boolean; reveal?: boolean },
    opts: CreateTabOptions = {},
  ): Promise<BrowserTabInfo> {
    const nativeSessionPartitionLease = allocateSensitiveSessionPartition();
    const ownership = Object.freeze({
      sessionPartition: nativeSessionPartitionLease.partition,
      nativeSessionPartitionLease,
      canOpenTab: () => true,
      onTabOpened: () => undefined,
      onTabClosed: () => undefined,
    });
    try {
      return await this.createSensitiveIntegrationTab(payload, opts, ownership);
    } catch (error) {
      // If retain never claimed the reservation, no Electron Session was
      // instantiated and it is safe to return immediately. Claimed slots are
      // released only by the exact destruction + cleanup path.
      releaseUnusedSensitiveSessionPartition(nativeSessionPartitionLease);
      throw error;
    }
  }

  /** Main-process-only presence check for a retained sensitive integration guest. */
  hasSensitiveIntegrationTab(tabId: string): boolean {
    return this.sensitiveIntegrationTabs.has(tabId) && this.findTab(tabId) !== undefined;
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
    sensitiveOwnership?: SensitiveIntegrationTabOwnership,
    sensitivePartitionLease?: SensitiveSessionPartitionLease,
  ): Promise<BrowserTabInfo> {
    const initialUrl = sensitiveInitialUrl ?? payload.url;
    if (initialUrl && Buffer.byteLength(initialUrl, "utf8") > MAX_BROWSER_URL_BYTES) {
      throw new Error(`Navigation URL limit is ${MAX_BROWSER_URL_BYTES} bytes`);
    }
    if (payload.url && !isNavigationUrlAllowed(payload.url)) {
      throw new Error(`Navigation blocked: ${payload.url}`);
    }
    const ordinaryTabCount = this.tabs.reduce(
      (count, tab) => count + (this.sensitiveIntegrationTabs.has(tab.tabId) ? 0 : 1),
      0,
    );
    if (sensitiveInitialUrl && this.sensitiveIntegrationTabs.size >= MAX_SENSITIVE_BROWSER_TABS) {
      throw new Error(
        `Sensitive browser tab limit reached (${MAX_SENSITIVE_BROWSER_TABS}); close a connection page before opening another.`,
      );
    }
    if (!sensitiveInitialUrl && ordinaryTabCount >= MAX_BROWSER_TABS) {
      throw new Error(
        `Browser tab limit reached (${MAX_BROWSER_TABS}); close a tab before opening another.`,
      );
    }
    // Creating a tab is agent activity (mounts the headless host). Restore
    // passes markActivity:false so reopening the app doesn't wake dormant tabs.
    if (opts.markActivity !== false) this.markAutomationActivity();
    const tabId = `tab-${randomUUID()}`;
    if (sensitiveInitialUrl) {
      if (!sensitiveOwnership || !sensitivePartitionLease) {
        throw new Error("Sensitive integration ownership is required");
      }
      this.sensitiveIntegrationTabs.set(tabId, {
        privateResumeUrl: sensitiveInitialUrl,
        ownership: sensitiveOwnership,
        sessionPartition: sensitivePartitionLease.partition,
        partitionLease: sensitivePartitionLease,
        view: null,
        viewHost: null,
        viewGeneration: 0,
        viewRecoveryAttempts: 0,
        viewRecoveryTimer: null,
        viewLifecycleCleanup: null,
        viewDestruction: null,
        presentation: null,
      });
    }
    let tab: BrowserTab;
    const capturedSensitiveOwnership = sensitiveOwnership;
    try {
      tab = new BrowserTab({
        tabId,
        ...(payload.url ? { initialUrl: payload.url } : {}),
        ...(opts.restoredTitle ? { initialTitle: opts.restoredTitle } : {}),
        ...(sensitiveInitialUrl ? { permissionProfile: "sensitive" as const } : {}),
        userAgent: this.browserUserAgent,
        onUpdate: (snap) => {
          this.onTabUpdate(tab, snap);
        },
        onAttention: (id) => {
          this.emit({ type: "tab-attention", tabId: id });
        },
        onPopup: (sourceTabId, popupUrl) => {
          if (!this.findTab(sourceTabId)) return;
          if (capturedSensitiveOwnership) {
            if (
              this.closingSensitiveIntegrationTabIds.has(sourceTabId) ||
              !this.sensitiveIntegrationTabs.has(sourceTabId) ||
              !capturedSensitiveOwnership.canOpenTab()
            ) {
              return;
            }
            void this.createSensitiveIntegrationTab(
              { url: popupUrl, activate: true, reveal: true },
              {},
              capturedSensitiveOwnership,
            ).catch(() => {});
            return;
          }
          const popup = this.openLink(popupUrl);
          void popup.catch(() => {});
        },
        onClose: (id) => {
          void this.closeTab(id).catch(() => {});
        },
        onNewTab: () => {
          void this.createTab({ url: BROWSER_HOME_URL, activate: true }).catch(() => {});
        },
        onCycle: (id, direction) => {
          this.emit({ type: "workspace-tab-cycle", tabId: id, direction });
        },
      });
    } catch (error) {
      this.sensitiveIntegrationTabs.delete(tabId);
      throw error;
    }
    this.tabs.push(tab);
    if (sensitiveInitialUrl) {
      let ownershipRegistered = false;
      try {
        const sensitive = this.sensitiveIntegrationTabs.get(tabId);
        if (!sensitive) throw new Error("Sensitive integration ownership is required");
        sensitive.ownership.onTabOpened(tabId);
        ownershipRegistered = true;
        await this.initializeSensitiveIntegrationView(tab, sensitive);
      } catch {
        let viewDestruction = Promise.resolve();
        let failedPartitionLease: SensitiveSessionPartitionLease | null = null;
        const failedIndex = this.tabs.findIndex((candidate) => candidate.tabId === tabId);
        if (failedIndex >= 0) this.tabs.splice(failedIndex, 1);
        this.closingSensitiveIntegrationTabIds.add(tabId);
        const sensitive = this.sensitiveIntegrationTabs.get(tabId);
        if (sensitive) {
          const guestWebContentsId = this.guestWebContentsIdByTab.get(tabId);
          const guestOwnership =
            guestWebContentsId === undefined
              ? undefined
              : this.guestOwnershipByWebContentsId.get(guestWebContentsId);
          if (guestOwnership?.tabId === tabId) this.releaseGuestOwnership(guestOwnership);
          else this.guestWebContentsIdByTab.delete(tabId);
          viewDestruction = this.destroySensitiveIntegrationView(sensitive);
          this.sensitiveIntegrationTabs.delete(tabId);
          if (ownershipRegistered) {
            try {
              sensitive.ownership.onTabClosed(tabId);
            } catch {}
          }
          failedPartitionLease = sensitive.partitionLease;
        }
        await tab.destroy();
        for (const [threadId, activeTabId] of this.activeAgentTabByThread) {
          if (activeTabId === tabId) this.activeAgentTabByThread.delete(threadId);
        }
        for (const session of this.automationSessions.values()) {
          session.tabIds.delete(tabId);
        }
        this.tabGroups.removeTab(tabId);
        if (this.activeTabId === tabId) {
          const nextActiveTabId = this.visibleTabIdAtOrNear(Math.max(0, failedIndex));
          this.updateActiveTabId(nextActiveTabId);
          this.hideSensitiveIntegrationViewsExcept(nextActiveTabId);
        }
        this.emitState();
        this.schedulePersist();
        await viewDestruction;
        if (failedPartitionLease) {
          await this.releaseSensitiveSessionPartition(failedPartitionLease);
        }
        this.closingSensitiveIntegrationTabIds.delete(tabId);
        throw new Error("Unable to register sensitive integration tab");
      }
    }
    // Agent-created tabs auto-join a group (parity with the external extension)
    // so they're visually distinct from the user's tabs. Tabs carrying a thread
    // get that thread's own group (named after its task); the rest fall back to
    // the shared "Y Space" group.
    if (opts.agent) {
      this.tabGroups.assignAgentTab(this.tabs, tabId, opts.threadId, opts.threadTitle);
      if (opts.threadId) this.rememberAgentTarget(opts.threadId, tabId);
    }
    const shouldActivate = payload.activate !== false;
    if (shouldActivate || this.activeTabId === null) {
      this.updateActiveTabId(tabId);
      this.hideSensitiveIntegrationViewsExcept(tabId);
    }
    this.emitState();
    // Publish the new page before asking the renderer to reveal it. This lets
    // the global workspace projection create the peer tab first, so the reveal
    // event can select that exact page without a transient singleton Browser
    // tab or a race against a later state event.
    if (payload.reveal) {
      this.revealForUserOpen();
    }
    this.schedulePersist();
    // Wait for the renderer to mount the <webview> and attach its webContents
    // so callers (e.g. MCP) can immediately use cdp / dialogs / network.
    if (opts.awaitAttach !== false) {
      try {
        await this.awaitAttach(tab);
      } catch (error) {
        await this.closeTab(tabId).catch(() => undefined);
        throw error;
      }
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
    const sensitive = this.sensitiveIntegrationTabs.get(tab.tabId);
    if (sensitive) {
      // Capture redirects before public redaction so a replacement guest can
      // resume the current auth page. Never copy this URL into IPC or persistence.
      const privateResumeUrl = parseInternalBrowserUrl(snapshot.url);
      if (privateResumeUrl) sensitive.privateResumeUrl = privateResumeUrl.toString();
      this.emit({
        type: "tab-updated",
        tab: {
          ...this.publicSnapshot(tab, snapshot),
          sensitiveIntegration: true,
          sensitiveViewGeneration: this.sensitiveViewGeneration,
        },
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
    if (!this.updateActiveTabId(tabId)) return;
    this.hideSensitiveIntegrationViewsExcept(tabId);
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
    for (const [requestId, pending] of this.pendingAutomationPresentations) {
      if (pending.tabId === tabId) this.finishAutomationPresentation(requestId, null);
    }
    if (this.pendingPicker?.tabId === tabId) this.cancelPicker();
    const [tab] = this.tabs.splice(idx, 1);
    if (!tab) return;
    if (this.sensitiveIntegrationTabs.has(tabId)) {
      this.closingSensitiveIntegrationTabIds.add(tabId);
    }
    this.pendingGuestReplacementByTab.delete(tabId);
    for (const [threadId, activeTabId] of this.activeAgentTabByThread) {
      if (activeTabId === tabId) this.activeAgentTabByThread.delete(threadId);
    }
    for (const session of this.automationSessions.values()) {
      session.tabIds.delete(tabId);
    }
    let partitionCleanup = Promise.resolve();
    try {
      await tab.destroy();
    } finally {
      partitionCleanup = this.releaseSensitiveIntegrationTab(tabId);
    }
    this.tabGroups.removeTab(tabId);
    if (this.activeTabId === tabId) {
      const nextActiveTabId = this.visibleTabIdAtOrNear(idx);
      this.updateActiveTabId(nextActiveTabId);
      this.hideSensitiveIntegrationViewsExcept(nextActiveTabId);
    }
    this.emitState();
    this.schedulePersist();
    await partitionCleanup;
  }

  private async releaseSensitiveIntegrationTab(tabId: string): Promise<void> {
    const sensitive = this.sensitiveIntegrationTabs.get(tabId);
    if (!sensitive) return;
    const destruction = this.destroySensitiveIntegrationView(sensitive);
    this.sensitiveIntegrationTabs.delete(tabId);
    try {
      sensitive.ownership.onTabClosed(tabId);
    } catch {}
    await destruction;
    await this.releaseSensitiveSessionPartition(sensitive.partitionLease);
    this.closingSensitiveIntegrationTabIds.delete(tabId);
  }

  private async initializeSensitiveIntegrationView(
    tab: BrowserTab,
    sensitive: SensitiveIntegrationTabState,
  ): Promise<void> {
    const expectedSession = electronSession.fromPartition(sensitive.sessionPartition);
    const view = new WebContentsView({
      webPreferences: {
        partition: sensitive.sessionPartition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    sensitive.view = view;
    const viewGeneration = ++sensitive.viewGeneration;
    view.setVisible(false);
    view.setBounds({ x: 0, y: 0, width: 1, height: 1 });
    const wc = view.webContents;
    if (wc.session !== expectedSession) {
      void this.destroySensitiveIntegrationView(sensitive);
      throw new Error("Sensitive integration view received the wrong session");
    }
    if (!tab.attach(wc)) {
      void this.destroySensitiveIntegrationView(sensitive);
      throw new Error("Sensitive integration view could not attach");
    }
    this.claimGuestOwnership(tab.tabId, wc.id, wc);
    this.bindSensitiveIntegrationViewLifecycle(tab.tabId, sensitive, view, viewGeneration);
    this.applySensitiveIntegrationPresentation(tab.tabId, sensitive);
    await tab.loadURL(sensitive.privateResumeUrl);
  }

  private bindSensitiveIntegrationViewLifecycle(
    tabId: string,
    sensitive: SensitiveIntegrationTabState,
    view: WebContentsView,
    viewGeneration: number,
  ): void {
    const onTerminated = () => {
      this.onSensitiveIntegrationViewTerminated(tabId, sensitive, view, viewGeneration);
    };
    view.webContents.once("destroyed", onTerminated);
    view.webContents.once("render-process-gone", onTerminated);
    sensitive.viewLifecycleCleanup = () => {
      try {
        view.webContents.removeListener("destroyed", onTerminated);
        view.webContents.removeListener("render-process-gone", onTerminated);
      } catch {}
    };
  }

  private onSensitiveIntegrationViewTerminated(
    tabId: string,
    sensitive: SensitiveIntegrationTabState,
    view: WebContentsView,
    viewGeneration: number,
  ): void {
    if (
      this.sensitiveIntegrationTabs.get(tabId) !== sensitive ||
      sensitive.view !== view ||
      sensitive.viewGeneration !== viewGeneration
    ) {
      return;
    }
    const tab = this.findTab(tabId);
    this.invalidateSensitiveIntegrationPresentations();
    const destruction = this.destroySensitiveIntegrationView(sensitive);
    this.emitState();
    if (!tab || tab.isDestroyed() || !sensitive.ownership.canOpenTab()) {
      void this.closeTab(tabId).catch(() => undefined);
      return;
    }
    void destruction.then(() => {
      this.scheduleSensitiveIntegrationViewRecovery(tabId, sensitive, viewGeneration);
    });
  }

  private scheduleSensitiveIntegrationViewRecovery(
    tabId: string,
    sensitive: SensitiveIntegrationTabState,
    failedViewGeneration: number,
  ): void {
    if (sensitive.viewRecoveryTimer) return;
    const attempt = sensitive.viewRecoveryAttempts;
    const delay = SENSITIVE_VIEW_RECOVERY_DELAYS_MS[attempt];
    if (delay === undefined) {
      void this.closeTab(tabId).catch(() => undefined);
      return;
    }
    sensitive.viewRecoveryAttempts += 1;
    const expectedOwnership = sensitive.ownership;
    sensitive.viewRecoveryTimer = setTimeout(() => {
      sensitive.viewRecoveryTimer = null;
      const tab = this.findTab(tabId);
      if (
        this.sensitiveIntegrationTabs.get(tabId) !== sensitive ||
        sensitive.ownership !== expectedOwnership ||
        sensitive.view !== null ||
        sensitive.viewGeneration !== failedViewGeneration
      ) {
        return;
      }
      if (!tab || tab.isDestroyed() || !expectedOwnership.canOpenTab()) {
        void this.closeTab(tabId).catch(() => undefined);
        return;
      }
      void this.initializeSensitiveIntegrationView(tab, sensitive).catch(() => {
        if (this.sensitiveIntegrationTabs.get(tabId) !== sensitive) return;
        const nextFailedViewGeneration = sensitive.viewGeneration;
        void this.destroySensitiveIntegrationView(sensitive).then(() => {
          this.scheduleSensitiveIntegrationViewRecovery(tabId, sensitive, nextFailedViewGeneration);
        });
      });
    }, delay);
  }

  private destroySensitiveIntegrationView(sensitive: SensitiveIntegrationTabState): Promise<void> {
    if (sensitive.viewRecoveryTimer) {
      clearTimeout(sensitive.viewRecoveryTimer);
      sensitive.viewRecoveryTimer = null;
    }
    const view = sensitive.view;
    if (!view) return sensitive.viewDestruction ?? Promise.resolve();
    sensitive.view = null;
    sensitive.viewLifecycleCleanup?.();
    sensitive.viewLifecycleCleanup = null;
    sensitive.presentation = null;
    const host = sensitive.viewHost;
    sensitive.viewHost = null;
    try {
      view.setVisible(false);
    } catch {}
    try {
      host?.contentView.removeChildView(view);
    } catch {}
    const wc = view.webContents;
    if (wc.isDestroyed()) {
      const guestOwnership = this.guestOwnershipByWebContentsId.get(wc.id);
      if (guestOwnership?.webContents === wc) this.releaseGuestOwnership(guestOwnership);
      return Promise.resolve();
    }
    let resolveDestruction!: () => void;
    const destruction = new Promise<void>((resolve) => {
      resolveDestruction = resolve;
    });
    sensitive.viewDestruction = destruction;
    const onDestroyed = () => {
      try {
        wc.removeListener("destroyed", onDestroyed);
      } catch {}
      const guestOwnership = this.guestOwnershipByWebContentsId.get(wc.id);
      if (guestOwnership?.webContents === wc) this.releaseGuestOwnership(guestOwnership);
      if (sensitive.viewDestruction === destruction) sensitive.viewDestruction = null;
      resolveDestruction();
    };
    wc.once("destroyed", onDestroyed);
    try {
      // Explicitly bypass page beforeunload so remote OAuth content cannot
      // strand a hidden guest and hold a bounded pool slot indefinitely.
      wc.close({ waitForBeforeUnload: false });
    } catch {
      // Keep the ownership tombstone and partition lease indefinitely if
      // Chromium cannot prove destruction. Failing open would declassify a
      // still-live OAuth renderer under an ordinary tab.
    }
    return destruction;
  }

  private retainSensitiveSessionPartition(
    ownership: SensitiveIntegrationTabOwnership,
  ): SensitiveSessionPartitionLease {
    const partition = ownership.sessionPartition;
    if (this.retiredSensitiveSessionOwnerships.has(ownership)) {
      throw new Error("Sensitive integration session partition cannot be reused");
    }
    if (this.sensitiveSessionPartitionCleanups.has(partition)) {
      throw new Error("Sensitive integration session partition cleanup is still in progress");
    }
    const existing = this.sensitiveSessionPartitionReferences.get(partition);
    if (existing && existing.ownership !== ownership) {
      throw new Error("Sensitive integration session partition is already owned");
    }
    if (
      !existing &&
      this.sensitiveSessionPartitionReferences.size + this.sensitiveSessionPartitionCleanups.size >=
        MAX_TRACKED_SENSITIVE_SESSION_PARTITIONS
    ) {
      throw new Error("Sensitive integration session cleanup backlog is full");
    }
    if (existing) existing.count += 1;
    else {
      const nativePoolLease = ownership.nativeSessionPartitionLease;
      if (nativePoolLease) {
        if (nativePoolLease.partition !== partition) {
          throw new Error("Sensitive integration session partition lease does not match");
        }
        claimSensitiveSessionPartition(nativePoolLease);
      } else if (isPooledSensitiveSessionPartition(partition)) {
        throw new Error("Sensitive integration session partition lease is required");
      }
      this.nextSensitiveSessionPartitionGeneration += 1;
      this.sensitiveSessionPartitionReferences.set(partition, {
        ownership,
        generation: this.nextSensitiveSessionPartitionGeneration,
        count: 1,
      });
    }
    const reference = this.sensitiveSessionPartitionReferences.get(partition);
    if (!reference) throw new Error("Sensitive integration session partition was not retained");
    return {
      ownership,
      partition,
      generation: reference.generation,
      nativePoolLease: ownership.nativeSessionPartitionLease ?? null,
      released: false,
    };
  }

  private releaseSensitiveSessionPartition(lease: SensitiveSessionPartitionLease): Promise<void> {
    if (lease.released) return Promise.resolve();
    lease.released = true;
    const reference = this.sensitiveSessionPartitionReferences.get(lease.partition);
    if (
      !reference ||
      reference.ownership !== lease.ownership ||
      reference.generation !== lease.generation
    ) {
      return Promise.resolve();
    }
    reference.count -= 1;
    if (reference.count > 0) return Promise.resolve();
    if (lease.nativePoolLease) {
      beginSensitiveSessionPartitionCleanup(lease.nativePoolLease);
    }
    this.sensitiveSessionPartitionReferences.delete(lease.partition);
    this.retiredSensitiveSessionOwnerships.add(lease.ownership);
    let cleanupSucceeded = false;
    const cleanupPromise = Promise.resolve()
      .then(() => {
        const cleanup = this.options.cleanupSensitiveSessionPartition;
        if (!cleanup) {
          if (lease.nativePoolLease) {
            throw new Error("Sensitive integration session cleanup is unavailable");
          }
          return;
        }
        return withSensitiveSessionCleanupTimeout(cleanup(lease.partition));
      })
      .then(() => {
        cleanupSucceeded = true;
      })
      .catch(() => undefined)
      .finally(() => {
        if (lease.nativePoolLease) {
          completeSensitiveSessionPartitionCleanup(lease.nativePoolLease, cleanupSucceeded);
        }
      });
    const cleanup = { generation: lease.generation, promise: cleanupPromise };
    this.sensitiveSessionPartitionCleanups.set(lease.partition, cleanup);
    void cleanupPromise.then(() => {
      if (this.sensitiveSessionPartitionCleanups.get(lease.partition) === cleanup) {
        this.sensitiveSessionPartitionCleanups.delete(lease.partition);
      }
    });
    return cleanupPromise;
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
    if (this.sensitiveIntegrationTabs.has(tabId)) {
      throw new Error(`No browser tab: ${tabId}`);
    }
    const t = this.findTab(tabId);
    if (!t) throw new Error(`No browser tab: ${tabId}`);
    await t.loadURL(url);
  }

  async back(tabId: string): Promise<void> {
    if (this.sensitiveIntegrationTabs.has(tabId)) return;
    const t = this.findTab(tabId);
    if (!t || !t.isAttached()) return;
    const wc = t.webContents;
    if (wc.navigationHistory.canGoBack()) {
      wc.navigationHistory.goBack();
    }
  }

  async forward(tabId: string): Promise<void> {
    if (this.sensitiveIntegrationTabs.has(tabId)) return;
    const t = this.findTab(tabId);
    if (!t || !t.isAttached()) return;
    const wc = t.webContents;
    if (wc.navigationHistory.canGoForward()) {
      wc.navigationHistory.goForward();
    }
  }

  async reload(tabId: string): Promise<void> {
    if (this.sensitiveIntegrationTabs.has(tabId)) return;
    const t = this.findTab(tabId);
    if (!t || !t.isAttached()) return;
    t.webContents.reload();
  }

  async hardReload(tabId: string): Promise<void> {
    if (this.sensitiveIntegrationTabs.has(tabId)) return;
    const t = this.findTab(tabId);
    if (!t) return;
    t.hardReload();
  }

  async toggleDevTools(tabId: string): Promise<void> {
    if (this.sensitiveIntegrationTabs.has(tabId)) return;
    const t = this.findTab(tabId);
    if (!t) return;
    t.toggleDevTools();
  }

  async clearHistory(tabId: string): Promise<void> {
    if (this.sensitiveIntegrationTabs.has(tabId)) return;
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
    if (this.sensitiveIntegrationTabs.has(tabId)) return;
    const t = this.findTab(tabId);
    if (!t) return;
    await t.clearCookies();
  }

  async clearCache(tabId: string): Promise<void> {
    if (this.sensitiveIntegrationTabs.has(tabId)) return;
    const t = this.findTab(tabId);
    if (!t) return;
    await t.clearCache();
  }

  async capturePng(tabId: string): Promise<Buffer | null> {
    if (this.sensitiveIntegrationTabs.has(tabId)) return null;
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
      if (tab && !this.sensitiveIntegrationTabs.has(remembered)) {
        this.rememberAgentTarget(threadId, remembered);
        return tab;
      }
      this.activeAgentTabByThread.delete(threadId);
    }
    const ownedIds = this.tabGroups.tabIdsForThread(threadId);
    const fallbackId = ownedIds[ownedIds.length - 1];
    if (!fallbackId) return null;
    const fallback = this.findTab(fallbackId);
    if (!fallback || this.sensitiveIntegrationTabs.has(fallbackId)) return null;
    this.rememberAgentTarget(threadId, fallbackId);
    return fallback;
  }

  /** Remember an explicit agent selection for later tabId-omitted calls. */
  rememberTabForThread(threadId: string, tabId: string): boolean {
    if (!this.findTab(tabId) || this.sensitiveIntegrationTabs.has(tabId)) return false;
    this.rememberAgentTarget(threadId, tabId);
    return true;
  }

  private rememberAgentTarget(threadId: string, tabId: string): void {
    this.activeAgentTabByThread.delete(threadId);
    while (this.activeAgentTabByThread.size >= MAX_REMEMBERED_AGENT_TARGETS) {
      const oldestThreadId = this.activeAgentTabByThread.keys().next().value;
      if (typeof oldestThreadId !== "string") break;
      this.activeAgentTabByThread.delete(oldestThreadId);
    }
    this.activeAgentTabByThread.set(threadId, tabId);
  }

  getTab(tabId: string): BrowserTab | null {
    if (this.sensitiveIntegrationTabs.has(tabId)) return null;
    return this.findTab(tabId) ?? null;
  }

  async startPicker(payload: {
    threadId: string;
    tabId: string;
  }): Promise<BrowserStartPickerResult> {
    // getTab deliberately excludes sensitive OAuth/Connect guests. The picker
    // returns screenshots and a source URL to a task attachment, so allowing it
    // here would bypass the rest of the sensitive-tab redaction boundary.
    const tab = this.getTab(payload.tabId);
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

  private async onPickerCommit(commit: { tabId: string; payload: unknown }): Promise<void> {
    const pending = this.pendingPicker;
    if (!pending || pending.tabId !== commit.tabId) return;
    this.clearPickerShortcut();
    this.pendingPicker = null;

    const pickerPayload = normalizePickerPayload(commit.payload);
    if (!pickerPayload) {
      pending.resolve({ ok: false, error: "Invalid picker response" });
      return;
    }

    if (pickerPayload.kind === "cancelled") {
      pending.resolve({ ok: true, cancelled: true });
      this.emit({ type: "picker-cancelled" });
      return;
    }

    try {
      const result = await this.captureElement(pending.threadId, commit.tabId, {
        selector: pickerPayload.selector,
        rect: pickerPayload.rect,
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
    },
  ): Promise<BrowserStartPickerResult> {
    if (this.sensitiveIntegrationTabs.has(tabId)) {
      return { ok: false, error: `No browser tab: ${tabId}` };
    }
    const tab = this.findTab(tabId);
    if (!tab || !tab.isAttached()) return { ok: false, error: `No browser tab: ${tabId}` };

    // The user clicked the element in the picker, so it's already inside the
    // viewport. Capture from the renderer's painted bitmap via
    // `webContents.capturePage` — no scrolling, no CDP off-surface path, and
    // no visible flicker. `pick.rect` is viewport-relative as captured by the
    // picker script.
    const clip = normalizePickerClip(pick.rect);
    if (!clip) throw new Error("Invalid picker response");
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
      selector: truncateUtf8(pick.selector, MAX_PICKER_SELECTOR_BYTES),
      sourceUrl: authoritativeTabUrl(tab),
      rect: clip,
    };
  }
}

function requireSensitiveIntegrationTabOwnership(
  ownership: SensitiveIntegrationTabOwnership | undefined,
): SensitiveIntegrationTabOwnership {
  if (
    !ownership ||
    typeof ownership.sessionPartition !== "string" ||
    !SENSITIVE_SESSION_PARTITION_PATTERN.test(ownership.sessionPartition)
  ) {
    throw new Error("Valid sensitive integration session partition ownership is required");
  }
  return ownership;
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

function normalizePickerPayload(value: unknown): PickerPayload | null {
  if (!value || typeof value !== "object") return null;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "cancelled") return { kind: "cancelled" };
  if (kind !== "picked") return null;
  const payload = value as {
    selector?: unknown;
    rect?: unknown;
    dpr?: unknown;
    url?: unknown;
    title?: unknown;
  };
  if (
    typeof payload.selector !== "string" ||
    typeof payload.url !== "string" ||
    typeof payload.title !== "string" ||
    typeof payload.dpr !== "number" ||
    !Number.isFinite(payload.dpr) ||
    payload.dpr <= 0 ||
    !normalizePickerClip(payload.rect)
  ) {
    return null;
  }
  const rect = payload.rect as { x: number; y: number; width: number; height: number };
  return {
    kind: "picked",
    selector: truncateUtf8(payload.selector, MAX_PICKER_SELECTOR_BYTES),
    rect,
    dpr: Math.min(16, payload.dpr),
    url: truncateUtf8(payload.url, MAX_PICKER_URL_BYTES),
    title: truncateUtf8(payload.title, MAX_PICKER_TITLE_BYTES),
  };
}

function normalizePickerClip(value: unknown): Electron.Rectangle | null {
  if (!value || typeof value !== "object") return null;
  const rect = value as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
  if (![rect.x, rect.y, rect.width, rect.height].every(isFiniteNumber)) return null;
  const x = Math.max(0, Math.min(MAX_PICKER_COORDINATE, Math.floor(rect.x as number)));
  const y = Math.max(0, Math.min(MAX_PICKER_COORDINATE, Math.floor(rect.y as number)));
  const width = Math.max(1, Math.min(MAX_PICKER_CLIP_DIMENSION, Math.ceil(rect.width as number)));
  let height = Math.max(1, Math.min(MAX_PICKER_CLIP_DIMENSION, Math.ceil(rect.height as number)));
  height = Math.min(height, Math.max(1, Math.floor(MAX_PICKER_CLIP_PIXELS / width)));
  return { x, y, width, height };
}

function normalizeSensitiveViewBounds(
  value: BrowserRect,
  contentBounds: Electron.Rectangle,
): Electron.Rectangle | null {
  if (![value.x, value.y, value.width, value.height].every(isFiniteNumber)) return null;
  const contentWidth = Math.max(0, Math.floor(contentBounds.width));
  const contentHeight = Math.max(0, Math.floor(contentBounds.height));
  if (contentWidth === 0 || contentHeight === 0 || value.width < 1 || value.height < 1) return null;
  const x = Math.max(0, Math.min(contentWidth - 1, Math.floor(value.x)));
  const y = Math.max(0, Math.min(contentHeight - 1, Math.floor(value.y)));
  const width = Math.max(1, Math.min(contentWidth - x, Math.ceil(value.width)));
  const height = Math.max(1, Math.min(contentHeight - y, Math.ceil(value.height)));
  return { x, y, width, height };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function authoritativeTabUrl(tab: BrowserTab): string {
  try {
    return truncateUtf8(tab.webContents.getURL() || tab.snapshot().url, MAX_PICKER_URL_BYTES);
  } catch {
    return truncateUtf8(tab.snapshot().url, MAX_PICKER_URL_BYTES);
  }
}
