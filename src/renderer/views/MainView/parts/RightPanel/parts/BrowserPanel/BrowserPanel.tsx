import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { Tooltip } from "@heroui/react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Check, Copy, Maximize2, Minimize2, PanelRightOpen, X } from "lucide-react";
import { BROWSER_SESSION_PARTITION } from "@/shared/browserPartition";
import { BROWSER_HOME_URL } from "@/shared/browserDefaults";
import type { BrowserTabInfo } from "@/shared/ipc";
import { isMac, readBridge } from "@/renderer/bridge";
import { useBrowserPanelStore } from "@/renderer/state/browserPanelStore";
import { usePanelStore } from "@/renderer/state/panelStore";
import {
  RIGHT_WORKSPACE_BROWSER_PAGE_RESIDENT_LIMIT,
  type RightWorkspaceBrowserPageTab,
} from "@/renderer/state/rightWorkspaceTabs";
import { useRightWorkspaceTabsStore } from "@/renderer/state/rightWorkspaceTabsStore";
import { openBrowserPanel } from "@/renderer/actions/panelActions";
import {
  macosTrafficLightGutterClass,
  overlayHeaderStyle,
  panelHeaderIconButtonClass,
} from "@/renderer/components/layout/sidebarChrome";
import { BrowserBookmarkBar } from "./parts/BrowserBookmarkBar";
import { BrowserEmptyState } from "./parts/BrowserEmptyState";
import { BrowserToolbar } from "./parts/BrowserToolbar";
import { injectBrowserToMain } from "./browserWindowActions";
import { useElementPicker } from "./hooks/useElementPicker";

interface ExtractedBrowserLruState {
  readonly sequence: number;
  readonly lastActiveTabId: string | null;
  readonly lastUsedByTabId: ReadonlyMap<string, number>;
}

interface ExtractedBrowserLruInput {
  readonly tabs: readonly BrowserTabInfo[];
  readonly activeTabId: string | null;
}

const INITIAL_EXTRACTED_BROWSER_LRU: ExtractedBrowserLruState = {
  sequence: 0,
  lastActiveTabId: null,
  lastUsedByTabId: new Map(),
};

function reconcileExtractedBrowserLru(
  state: ExtractedBrowserLruState,
  input: ExtractedBrowserLruInput,
): ExtractedBrowserLruState {
  const liveTabIds = new Set(input.tabs.map((tab) => tab.tabId));
  const normalizedActiveTabId =
    input.activeTabId && liveTabIds.has(input.activeTabId) ? input.activeTabId : null;
  const hasSameTabs =
    liveTabIds.size === state.lastUsedByTabId.size &&
    [...liveTabIds].every((tabId) => state.lastUsedByTabId.has(tabId));
  if (hasSameTabs && normalizedActiveTabId === state.lastActiveTabId) return state;

  let sequence = state.sequence;
  const lastUsedByTabId = new Map<string, number>();
  for (const tab of input.tabs) {
    const existing = state.lastUsedByTabId.get(tab.tabId);
    lastUsedByTabId.set(tab.tabId, existing ?? ++sequence);
  }
  if (normalizedActiveTabId && normalizedActiveTabId !== state.lastActiveTabId) {
    lastUsedByTabId.set(normalizedActiveTabId, ++sequence);
  }
  return {
    sequence,
    lastActiveTabId: normalizedActiveTabId,
    lastUsedByTabId,
  };
}

function selectExtractedResidentBrowserTabs(
  tabs: readonly BrowserTabInfo[],
  activeTabId: string | null,
  lru: ExtractedBrowserLruState,
): readonly BrowserTabInfo[] {
  const ordinaryCandidates = tabs
    .map((tab, index) => ({
      tab,
      index,
      lastUsed:
        tab.tabId === activeTabId
          ? Number.POSITIVE_INFINITY
          : (lru.lastUsedByTabId.get(tab.tabId) ?? lru.sequence + index + 1),
    }))
    .filter(({ tab }) => !tab.sensitiveIntegration)
    .sort((left, right) => right.lastUsed - left.lastUsed || right.index - left.index)
    .slice(0, RIGHT_WORKSPACE_BROWSER_PAGE_RESIDENT_LIMIT);
  const residentOrdinaryIds = new Set(ordinaryCandidates.map(({ tab }) => tab.tabId));
  // Preserve backend order for stable keyed DOM placement. Sensitives live
  // outside the ordinary cap and therefore remain mounted throughout OAuth.
  return tabs.filter((tab) => tab.sensitiveIntegration || residentOrdinaryIds.has(tab.tabId));
}

export function BrowserPanel(props: { visible: boolean; surface?: "main" | "window" }) {
  const { t } = useLingui();
  const tabs = useBrowserPanelStore((s) => s.tabs);
  const activeTabId = useBrowserPanelStore((s) => s.activeTabId);
  const workspaceTabs = useRightWorkspaceTabsStore((s) => s.tabs);
  const activeWorkspaceTabId = useRightWorkspaceTabsStore((s) => s.activeTabId);
  const openBrowserPage = useRightWorkspaceTabsStore((s) => s.openBrowserPage);
  const browserPanelOpen = usePanelStore((s) => s.browserPanelOpen);
  const browserOverlayOpen = usePanelStore((s) => s.browserOverlayOpen);
  const browserOverlayMaximized = usePanelStore((s) => s.browserOverlayMaximized);
  const setBrowserOverlayOpen = usePanelStore((s) => s.setBrowserOverlayOpen);
  const setBrowserOverlayMaximized = usePanelStore((s) => s.setBrowserOverlayMaximized);
  const isWindowSurface = props.surface === "window";
  const visible = props.visible || browserOverlayOpen || isWindowSurface;
  const [menuPreviewDataUrl, setMenuPreviewDataUrl] = useState<string | null>(null);
  const {
    pickerActive,
    startPicker,
    threadTargets,
    pendingPickerAttachment,
    chooseTargetForPendingPick,
    cancelPendingPick,
  } = useElementPicker();
  const everHadTabsRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const [extractedBrowserLru, recordExtractedBrowserLru] = useReducer(
    reconcileExtractedBrowserLru,
    INITIAL_EXTRACTED_BROWSER_LRU,
  );

  useLayoutEffect(() => {
    if (!isWindowSurface) return;
    recordExtractedBrowserLru({ tabs, activeTabId });
  }, [activeTabId, isWindowSurface, tabs]);

  const activeWorkspaceBrowserTab = workspaceTabs.find(
    (tab): tab is RightWorkspaceBrowserPageTab =>
      tab.id === activeWorkspaceTabId && tab.kind === "browser-page",
  );
  const presentedBrowserTabId = activeWorkspaceBrowserTab?.browserTabId ?? activeTabId;
  const metadataByBrowserTabId = new Map(tabs.map((tab) => [tab.tabId, tab]));
  const mainResidentBrowserTabs = workspaceTabs.flatMap((tab) => {
    if (tab.kind !== "browser-page" || !tab.resident) return [];
    const metadata = metadataByBrowserTabId.get(tab.browserTabId);
    return metadata ? [metadata] : [];
  });
  // The extracted renderer deliberately does not mirror the main window's
  // global workspace store. Keep that surface functional without reintroducing
  // a nested strip, using local observed activation recency for true LRU.
  const residentBrowserTabs = isWindowSurface
    ? selectExtractedResidentBrowserTabs(tabs, activeTabId, extractedBrowserLru)
    : mainResidentBrowserTabs;
  const hasActiveTab = residentBrowserTabs.some((tab) => tab.tabId === presentedBrowserTabId);

  const createTab = useCallback(() => {
    void readBridge()
      .browserCreateTab({ url: BROWSER_HOME_URL, activate: true })
      .then((tab) => {
        // The bridge result is authoritative browser metadata. Mirror it now so
        // the new global page can paint without waiting for the broadcast state
        // event, then make that page the selected first-class workspace tab.
        const browser = useBrowserPanelStore.getState();
        browser.upsertTab(tab);
        browser.setActive(tab.tabId);
        openBrowserPage({
          browserTabId: tab.tabId,
          url: tab.url,
          title:
            tab.title.trim() ||
            (tab.sensitiveIntegration
              ? "Secure connection"
              : tab.url && tab.url !== "about:blank"
                ? tab.url
                : "New tab"),
          ...(tab.sensitiveIntegration === undefined
            ? {}
            : { sensitiveIntegration: tab.sensitiveIntegration }),
          ...(tab.groupId === undefined ? {} : { groupId: tab.groupId }),
        });
      })
      .catch(() => {});
  }, [openBrowserPage]);

  useEffect(() => {
    const browserTabId = activeWorkspaceBrowserTab?.browserTabId;
    if (!browserTabId || browserTabId === activeTabId) return;
    readBridge()
      .browserActivateTab({ tabId: browserTabId })
      .catch(() => {});
  }, [activeTabId, activeWorkspaceBrowserTab?.browserTabId]);

  // Attached imperatively (rather than a JSX onKeyDown) because this container
  // is a plain grouping element, not a widget — the reload shortcut is a
  // global-ish capture over the panel's focused descendants, not an
  // interaction of the group itself.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!activeTabId || !isBrowserReloadShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const bridge = readBridge();
      if (event.shiftKey) {
        bridge.browserHardReload({ tabId: activeTabId }).catch(() => {});
        return;
      }
      bridge.browserReload({ tabId: activeTabId }).catch(() => {});
    };
    el.addEventListener("keydown", handleKeyDown);
    return () => el.removeEventListener("keydown", handleKeyDown);
  }, [activeTabId]);

  const onPick = useCallback(() => {
    void startPicker();
  }, [startPicker]);

  useEffect(() => {
    if (tabs.length > 0) everHadTabsRef.current = true;
  }, [tabs.length]);

  useEffect(() => {
    if (!visible) return;
    if (tabs.length > 0) return;
    if (everHadTabsRef.current) return;
    // Small grace window so persisted tabs restored by main don't race with
    // an auto-create on cold start.
    const timer = setTimeout(() => {
      if (useBrowserPanelStore.getState().tabs.length === 0 && !everHadTabsRef.current) {
        void createTab();
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [createTab, visible, tabs.length]);

  const isFullscreenOverlay = browserOverlayOpen && browserOverlayMaximized;
  const hasWindowHeader = isFullscreenOverlay || isWindowSurface;
  const headerButtonClass = `${
    hasWindowHeader ? "poracode-overlay-header__controls " : ""
  }${panelHeaderIconButtonClass}`;
  const restoreToPanel = () => {
    setBrowserOverlayMaximized(false);
    setBrowserOverlayOpen(false);
    openBrowserPanel();
  };
  return (
    <div
      ref={rootRef}
      data-poracode-browser=""
      role="group"
      aria-label={t`Browser`}
      className="flex h-full w-full min-h-0 flex-col bg-[var(--content-background)]"
    >
      {browserOverlayOpen || isWindowSurface ? (
        <div
          className={`${
            hasWindowHeader
              ? "poracode-overlay-header"
              : "poracode-overlay-header poracode-overlay-header--no-drag"
          } flex shrink-0 items-center gap-1 border-b border-[color:var(--border)] bg-[var(--content-background)] px-2`}
          style={hasWindowHeader ? overlayHeaderStyle() : { height: "32px" }}
        >
          {isMac() && hasWindowHeader ? (
            <div className={macosTrafficLightGutterClass} aria-hidden />
          ) : null}
          <div className="text-xs font-medium text-foreground">
            <Trans>Browser</Trans>
          </div>
          <BrowserDeviceCodeButton />
          <div className="flex-1" />
          {isWindowSurface ? (
            <button
              type="button"
              className={headerButtonClass}
              title={t`Move browser back to main window`}
              aria-label={t`Move browser back to main window`}
              onClick={injectBrowserToMain}
            >
              <PanelRightOpen className="size-3.5" />
            </button>
          ) : browserPanelOpen ? (
            <button
              type="button"
              className={headerButtonClass}
              title={t`Minimize to panel`}
              aria-label={t`Minimize browser to right panel`}
              onClick={restoreToPanel}
            >
              <Minimize2 className="size-3.5" />
            </button>
          ) : (
            <>
              {browserOverlayMaximized ? (
                <button
                  type="button"
                  className={headerButtonClass}
                  title={t`Restore`}
                  aria-label={t`Restore browser`}
                  onClick={() => setBrowserOverlayMaximized(false)}
                >
                  <Minimize2 className="size-3.5" />
                </button>
              ) : (
                <button
                  type="button"
                  className={headerButtonClass}
                  title={t`Maximize`}
                  aria-label={t`Maximize browser`}
                  onClick={() => setBrowserOverlayMaximized(true)}
                >
                  <Maximize2 className="size-3.5" />
                </button>
              )}
              <button
                type="button"
                className={headerButtonClass}
                title={t`Close`}
                aria-label={t`Close browser`}
                onClick={() => setBrowserOverlayOpen(false)}
              >
                <X className="size-3.5" />
              </button>
            </>
          )}
        </div>
      ) : null}
      <BrowserToolbar
        onPick={onPick}
        pickerActive={pickerActive}
        pickerTargets={threadTargets}
        hasPendingPick={pendingPickerAttachment !== null}
        pendingPickAnchor={
          pendingPickerAttachment &&
          typeof pendingPickerAttachment.anchorX === "number" &&
          typeof pendingPickerAttachment.anchorY === "number"
            ? { x: pendingPickerAttachment.anchorX, y: pendingPickerAttachment.anchorY }
            : null
        }
        onChoosePickTarget={chooseTargetForPendingPick}
        onCancelPendingPick={cancelPendingPick}
        onMenuPreviewChange={setMenuPreviewDataUrl}
      />
      <BrowserBookmarkBar />
      <div className="poracode-browser-content-plane relative flex-1 overflow-hidden bg-[var(--content-background)]">
        {residentBrowserTabs.map((tab) => (
          <BrowserTabWebview
            key={tab.tabId}
            tabId={tab.tabId}
            initialSrc={tab.url}
            visible={visible && !menuPreviewDataUrl && tab.tabId === presentedBrowserTabId}
          />
        ))}
        {menuPreviewDataUrl ? (
          <img
            src={menuPreviewDataUrl}
            alt=""
            draggable={false}
            className="pointer-events-none absolute inset-0 size-full object-cover object-left-top"
          />
        ) : null}
        {!hasActiveTab ? (
          <div className="absolute inset-0">
            <BrowserEmptyState onCreateTab={createTab} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function BrowserDeviceCodeButton() {
  const { t } = useLingui();
  const deviceCode = useBrowserPanelStore((s) => s.usageLoginDeviceCode);
  const [copied, setCopied] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!deviceCode) {
      setCopied(false);
      setTooltipOpen(false);
      return;
    }
    setCopied(true);
    setTooltipOpen(true);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopied(false), 1_500);
  }, [deviceCode]);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  if (!deviceCode) return null;
  const activeDeviceCode = deviceCode;

  function copyDeviceCode() {
    navigator.clipboard
      .writeText(activeDeviceCode.code)
      .then(() => {
        setCopied(true);
        setTooltipOpen(true);
        if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = setTimeout(() => setCopied(false), 1_500);
      })
      .catch(() => {});
  }

  return (
    <Tooltip delay={0} isOpen={tooltipOpen} onOpenChange={setTooltipOpen}>
      <Tooltip.Trigger>
        <button
          type="button"
          className="ml-1.5 flex h-5 max-w-[170px] items-center gap-1 rounded border border-accent/30 bg-accent/10 px-1.5 text-[11px] text-foreground transition-colors hover:bg-accent/15"
          title={t`Copy ${activeDeviceCode.providerLabel} device code ${activeDeviceCode.code}`}
          aria-label={t`Copy ${activeDeviceCode.providerLabel} device code ${activeDeviceCode.code}`}
          onClick={copyDeviceCode}
        >
          {copied ? (
            <Check className="size-3 shrink-0 text-accent-text" />
          ) : (
            <Copy className="size-3 shrink-0 text-accent-text" />
          )}
          <span className="shrink-0 text-muted">
            <Trans>Paste</Trans>
          </span>
          <span className="truncate font-mono text-foreground">{activeDeviceCode.code}</span>
        </button>
      </Tooltip.Trigger>
      <Tooltip.Content placement="bottom" className="z-[1000] px-2 py-1.5 text-xs">
        <span className="block whitespace-nowrap">
          {copied ? <Trans>Code copied. </Trans> : ""}
          <Trans>
            Paste <span className="font-mono text-foreground">{activeDeviceCode.code}</span> here.
            Click to copy.
          </Trans>
        </span>
      </Tooltip.Content>
    </Tooltip>
  );
}

function BrowserTabWebview(props: { tabId: string; initialSrc: string; visible: boolean }) {
  const ref = useRef<HTMLWebViewElement | null>(null);
  const initialSrcRef = useRef(props.initialSrc);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    const onDomReady = () => {
      if (cancelled) return;
      let webContentsId: number;
      try {
        webContentsId = el.getWebContentsId();
      } catch {
        return;
      }
      readBridge()
        .browserAttachWebContents({ tabId: props.tabId, webContentsId })
        .catch(() => {});
    };
    el.addEventListener("dom-ready", onDomReady);
    return () => {
      cancelled = true;
      el.removeEventListener("dom-ready", onDomReady);
    };
  }, [props.tabId]);

  useEffect(() => {
    if (!props.visible) return;
    const el = ref.current;
    if (!el) return;
    let webContentsId: number;
    try {
      webContentsId = el.getWebContentsId();
    } catch {
      return;
    }
    readBridge()
      .browserAttachWebContents({ tabId: props.tabId, webContentsId })
      .catch(() => {});
  }, [props.tabId, props.visible]);

  return (
    <webview
      ref={ref}
      data-tab-id={props.tabId}
      partition={BROWSER_SESSION_PARTITION}
      src={initialSrcRef.current || "about:blank"}
      // Electron's React type says boolean, but React warns unless this custom
      // element attribute is serialized as a string.
      allowpopups={"true" as unknown as boolean}
      className="absolute inset-0 size-full"
      aria-hidden={!props.visible}
      inert={!props.visible}
      // A resident background guest must keep a nonzero layout surface: agent
      // screenshots and synthesized input can otherwise hit a blank Chromium
      // surface after another global tab is selected. The six-page residency
      // budget bounds these painted guests; opacity/pointer/z-order keep every
      // non-selected page completely hidden from user interaction.
      style={{
        display: "flex",
        opacity: props.visible ? 1 : 0,
        pointerEvents: props.visible ? "auto" : "none",
        zIndex: props.visible ? 1 : 0,
      }}
    />
  );
}

function isBrowserReloadShortcut(event: KeyboardEvent): boolean {
  if (event.key === "F5") return true;
  return (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r";
}
