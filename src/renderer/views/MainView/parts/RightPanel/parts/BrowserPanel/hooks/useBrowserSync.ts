import { useEffect } from "react";
import { readBridge } from "@/renderer/bridge";
import { useBrowserPanelStore } from "@/renderer/state/browserPanelStore";
import { useFileEditorStore } from "@/renderer/state/fileEditorStore";
import { selectAnyObstructingOverlayOpen, usePanelStore } from "@/renderer/state/panelStore";
import { useRightWorkspaceTabsStore } from "@/renderer/state/rightWorkspaceTabsStore";
import {
  isSensitiveNativeViewObstructed,
  subscribeBrowserAutomationPresentationObstruction,
} from "@/renderer/state/sensitiveNativeViewObstruction";
import { WORKSPACE_TAB_CYCLE_EVENT } from "@/renderer/commands/workspaceTabCycle";
import type {
  BrowserInvalidateAutomationPresentationPayload,
  BrowserState,
  BrowserTabInfo,
} from "@/shared/ipc";
import type { BrowserLinkPresentationMode } from "@/shared/settings";

const AUTOMATION_PRESENTATION_PAINT_TIMEOUT_MS = 1_500;
type AutomationPresentationInvalidationReason = NonNullable<
  BrowserInvalidateAutomationPresentationPayload["reason"]
>;
type ActiveAutomationPresentation = Omit<BrowserInvalidateAutomationPresentationPayload, "reason">;

function waitForTwoPaintFrames(signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let firstFrame: number | null = null;
    let secondFrame: number | null = null;
    let timeout: number | null = null;
    let settled = false;
    const usesAnimationFrame =
      typeof window.requestAnimationFrame === "function" &&
      typeof window.cancelAnimationFrame === "function";
    const scheduleFrame = (callback: FrameRequestCallback) =>
      usesAnimationFrame
        ? window.requestAnimationFrame(callback)
        : window.setTimeout(() => callback(performance.now()), 16);
    const cancelFrame = (handle: number) => {
      if (usesAnimationFrame) window.cancelAnimationFrame(handle);
      else window.clearTimeout(handle);
    };
    const onAbort = () => finish(false);
    const finish = (painted: boolean) => {
      if (settled) return;
      settled = true;
      if (firstFrame !== null) cancelFrame(firstFrame);
      if (secondFrame !== null) cancelFrame(secondFrame);
      if (timeout !== null) window.clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolve(painted);
    };

    if (signal.aborted) {
      finish(false);
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    timeout = window.setTimeout(() => finish(false), AUTOMATION_PRESENTATION_PAINT_TIMEOUT_MS);
    firstFrame = scheduleFrame(() => {
      firstFrame = null;
      secondFrame = scheduleFrame(() => {
        secondFrame = null;
        finish(true);
      });
    });
  });
}

function findPresentedWebview(tabId: string): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>("webview[data-tab-id]")].find(
      (candidate) => candidate.dataset.tabId === tabId,
    ) ?? null
  );
}

function isExactWebviewPresented(tabId: string, surface: "main" | "extracted"): boolean {
  // A focused Electron <webview> owns focus in a separate renderer process, so
  // the host document legitimately reports hasFocus() === false while the page
  // is still the foreground, user-visible surface. Exact renderer geometry and
  // visibility—not transient desktop focus—prove presentation for native CDP input.
  if (document.visibilityState !== "visible") return false;
  const webview = findPresentedWebview(tabId);
  if (
    !webview?.isConnected ||
    webview.style.display === "none" ||
    webview.style.opacity !== "1" ||
    webview.style.pointerEvents !== "auto" ||
    webview.getAttribute("aria-hidden") === "true" ||
    webview.hasAttribute("inert")
  ) {
    return false;
  }
  const rect = webview.getBoundingClientRect();
  if (
    rect.width <= 0 ||
    rect.height <= 0 ||
    rect.right <= 0 ||
    rect.bottom <= 0 ||
    rect.left >= window.innerWidth ||
    rect.top >= window.innerHeight
  ) {
    return false;
  }
  if (surface === "extracted") {
    return webview.closest("[data-poracode-browser]") !== null;
  }
  const host = webview.closest<HTMLElement>("[data-y-space-browser-host]");
  return (
    host !== null && host.getAttribute("aria-hidden") !== "true" && !host.hasAttribute("inert")
  );
}

function presentMainBrowserPage(tabId: string, mode?: BrowserLinkPresentationMode): boolean {
  const browser = useBrowserPanelStore.getState();
  const target = browser.tabs.find((tab) => tab.tabId === tabId);
  if (!target || target.sensitiveIntegration) return false;
  browser.setActive(tabId);
  useRightWorkspaceTabsStore.getState().selectBrowserPage(tabId);
  const panel = usePanelStore.getState();
  const wantsFullscreen = mode === "overlay";
  panel.setBrowserPanelOpen(true);
  panel.setRightPanelTab("browser");
  if (wantsFullscreen || selectAnyObstructingOverlayOpen()) {
    panel.setBrowserOverlayMaximized(wantsFullscreen);
    panel.setBrowserOverlayOpen(true);
  } else if (mode === "panel") {
    panel.setBrowserOverlayOpen(false);
  }
  return true;
}

function isMainBrowserPagePresented(tabId: string): boolean {
  const browser = useBrowserPanelStore.getState();
  const target = browser.tabs.find((tab) => tab.tabId === tabId);
  if (
    browser.extracted ||
    browser.activeTabId !== tabId ||
    !target ||
    target.sensitiveIntegration
  ) {
    return false;
  }
  const workspace = useRightWorkspaceTabsStore.getState();
  if (workspace.hidden) return false;
  const selected = workspace.tabs.find((tab) => tab.id === workspace.activeTabId);
  if (
    selected?.kind !== "browser-page" ||
    selected.browserTabId !== tabId ||
    selected.resident === false
  ) {
    return false;
  }
  const panel = usePanelStore.getState();
  const browserSurfaceVisible =
    panel.browserOverlayOpen || (panel.browserPanelOpen && panel.rightPanelTab === "browser");
  return (
    browserSurfaceVisible &&
    (panel.browserOverlayOpen || !selectAnyObstructingOverlayOpen()) &&
    isExactWebviewPresented(tabId, "main")
  );
}

function presentExtractedBrowserPage(tabId: string): boolean {
  const browser = useBrowserPanelStore.getState();
  const target = browser.tabs.find((tab) => tab.tabId === tabId);
  if (!browser.extracted || !target || target.sensitiveIntegration) return false;
  browser.setActive(tabId);
  return true;
}

function isExtractedBrowserPagePresented(tabId: string): boolean {
  const browser = useBrowserPanelStore.getState();
  const target = browser.tabs.find((tab) => tab.tabId === tabId);
  return (
    browser.extracted &&
    browser.activeTabId === tabId &&
    target !== undefined &&
    !target.sensitiveIntegration &&
    isExactWebviewPresented(tabId, "extracted")
  );
}

function workspacePage(tab: BrowserTabInfo) {
  const title =
    tab.title.trim() ||
    (tab.sensitiveIntegration
      ? "Secure connection"
      : tab.url && tab.url !== "about:blank"
        ? tab.url
        : "New tab");
  return {
    browserTabId: tab.tabId,
    url: tab.url,
    title,
    ...(tab.sensitiveIntegration ? { sensitiveIntegration: true as const } : {}),
    ...(tab.groupId ? { groupId: tab.groupId } : {}),
  };
}

export function useBrowserSync(): void {
  const setState = useBrowserPanelStore((s) => s.setState);
  const upsertTab = useBrowserPanelStore((s) => s.upsertTab);
  const setAttention = useBrowserPanelStore((s) => s.setAttention);
  const setPickerActive = useBrowserPanelStore((s) => s.setPickerActive);
  const setAutomationActive = useBrowserPanelStore((s) => s.setAutomationActive);
  const setUsageLoginConfirmation = useBrowserPanelStore((s) => s.setUsageLoginConfirmation);
  const clearUsageLoginConfirmation = useBrowserPanelStore((s) => s.clearUsageLoginConfirmation);
  const setUsageLoginDeviceCode = useBrowserPanelStore((s) => s.setUsageLoginDeviceCode);
  const clearUsageLoginDeviceCode = useBrowserPanelStore((s) => s.clearUsageLoginDeviceCode);

  useEffect(() => {
    let cancelled = false;
    const presentationAbort = new AbortController();
    let receivedLiveState = false;
    const liveTabUpdates = new Map<string, BrowserTabInfo>();
    const bridge = readBridge();
    const isMainWindow = bridge.windowKind === "main";
    const isExtractedWindow = bridge.windowKind === "browserExtract";
    let currentPresentation: ActiveAutomationPresentation | null = null;
    const invalidateCurrentPresentation = async (
      reason: AutomationPresentationInvalidationReason,
    ): Promise<void> => {
      const presentation = currentPresentation;
      if (!presentation) return;
      await bridge.browserInvalidateAutomationPresentation({ ...presentation, reason });
      if (currentPresentation === presentation) currentPresentation = null;
    };
    const invalidateCurrentPresentationBestEffort = (
      reason: AutomationPresentationInvalidationReason,
    ) => {
      void invalidateCurrentPresentation(reason).catch(() => {});
    };
    const unsubscribePresentationObstruction = subscribeBrowserAutomationPresentationObstruction(
      () => invalidateCurrentPresentation("obstructed"),
    );
    const revalidateCurrentPresentation = (reason: AutomationPresentationInvalidationReason) => {
      const presentation = currentPresentation;
      if (!presentation) return;
      const stillPresented =
        !isSensitiveNativeViewObstructed() &&
        (presentation.surface === "main"
          ? isMainBrowserPagePresented(presentation.tabId)
          : isExtractedBrowserPagePresented(presentation.tabId));
      if (!stillPresented) invalidateCurrentPresentationBestEffort(reason);
    };
    const presentationStoreUnsubscribers = [
      useBrowserPanelStore.subscribe(() => revalidateCurrentPresentation("browser-state-changed")),
      useRightWorkspaceTabsStore.subscribe(() =>
        revalidateCurrentPresentation("workspace-tab-changed"),
      ),
      usePanelStore.subscribe(() => revalidateCurrentPresentation("panel-layout-changed")),
      useFileEditorStore.subscribe(() => revalidateCurrentPresentation("file-editor-changed")),
    ];
    const onVisibilityChange = () => revalidateCurrentPresentation("document-visibility-changed");
    const onViewportResize = () => revalidateCurrentPresentation("viewport-resized");
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("resize", onViewportResize);
    // Overlay/panel presentation side-effects belong to the main window alone,
    // and never while the browser is extracted to its own window — the extract
    // window subscribes purely to mirror tab/bookmark state.
    const reactsToPresentation = () => isMainWindow && !useBrowserPanelStore.getState().extracted;
    const applyState = (state: BrowserState) => {
      const hadTabs = useBrowserPanelStore.getState().tabs.length > 0;
      setState(state);
      if (isMainWindow) {
        const workspace = useRightWorkspaceTabsStore.getState();
        workspace.syncBrowserPages(state.tabs.map(workspacePage), state.activeTabId);
        const nextWorkspace = useRightWorkspaceTabsStore.getState();
        const activeWorkspaceTab = nextWorkspace.tabs.find(
          (tab) => tab.id === nextWorkspace.activeTabId,
        );
        if (activeWorkspaceTab && activeWorkspaceTab.kind !== "browser-page") {
          usePanelStore.getState().setBrowserOverlayOpen(false);
        }
      }
      if (state.extracted && isMainWindow) {
        usePanelStore.getState().setBrowserOverlayOpen(false);
      }
      if (isMainWindow && hadTabs && state.tabs.length === 0) {
        // Closing the last tab dismisses the browser entirely. The panel and
        // overlay are independent (hiding the panel no longer closes the
        // overlay), so dismiss both explicitly here.
        const panel = usePanelStore.getState();
        panel.setBrowserOverlayOpen(false);
        panel.setBrowserPanelOpen(false);
      }
    };
    const unsub = bridge.onBrowserEvent((event) => {
      if (event.type === "state") {
        receivedLiveState = true;
        liveTabUpdates.clear();
        applyState(event.state);
      } else if (event.type === "tab-updated") {
        // Preserve updates that race the initial snapshot request. A title/URL
        // event is newer than that request but does not contain the full tab
        // list, so merge it into the eventual snapshot instead of discarding
        // either side.
        liveTabUpdates.set(event.tab.tabId, event.tab);
        upsertTab(event.tab);
        if (isMainWindow) {
          useRightWorkspaceTabsStore.getState().updateBrowserPage(workspacePage(event.tab));
        }
      } else if (event.type === "tab-attention") {
        setAttention(event.tabId);
      } else if (event.type === "workspace-tab-cycle") {
        if (!reactsToPresentation()) return;
        const workspace = useRightWorkspaceTabsStore.getState();
        const activeWorkspaceTab = workspace.tabs.find((tab) => tab.id === workspace.activeTabId);
        // A background agent can synthesize keys in a resident guest. Only the
        // user-visible browser page is allowed to move the global selection.
        if (
          activeWorkspaceTab?.kind !== "browser-page" ||
          activeWorkspaceTab.browserTabId !== event.tabId
        ) {
          return;
        }
        window.dispatchEvent(
          new CustomEvent(WORKSPACE_TAB_CYCLE_EVENT, {
            detail: { direction: event.direction },
          }),
        );
      } else if (event.type === "open-panel") {
        if (!reactsToPresentation()) return;
        // Browser pages are already projected into the global strip before a
        // reveal event is emitted. Select the exact active page, then choose
        // docked/drawer/fullscreen presentation without creating a singleton.
        const activeBrowserTabId = useBrowserPanelStore.getState().activeTabId;
        if (activeBrowserTabId) {
          presentMainBrowserPage(activeBrowserTabId, event.mode);
        }
      } else if (event.type === "automation-presentation-request") {
        const ownsRequest =
          (event.surface === "main" && reactsToPresentation()) ||
          (event.surface === "extracted" &&
            isExtractedWindow &&
            useBrowserPanelStore.getState().extracted);
        if (!ownsRequest) return;
        invalidateCurrentPresentationBestEffort("superseded");
        const selected =
          !isSensitiveNativeViewObstructed() &&
          (event.surface === "main"
            ? presentMainBrowserPage(event.tabId, "panel")
            : presentExtractedBrowserPage(event.tabId));
        void (async () => {
          const painted = selected && (await waitForTwoPaintFrames(presentationAbort.signal));
          if (cancelled) return;
          const presented =
            painted &&
            !isSensitiveNativeViewObstructed() &&
            (event.surface === "main"
              ? isMainBrowserPagePresented(event.tabId)
              : isExtractedBrowserPagePresented(event.tabId));
          const presentation = {
            requestId: event.requestId,
            tabId: event.tabId,
            surface: event.surface,
          } satisfies ActiveAutomationPresentation;
          if (presented) currentPresentation = presentation;
          const acknowledged = await bridge
            .browserAcknowledgeAutomationPresentation({
              ...presentation,
              presented,
            })
            .then(() => true)
            .catch(() => false);
          if (!acknowledged && currentPresentation === presentation) {
            currentPresentation = null;
            return;
          }
          revalidateCurrentPresentation("post-acknowledgement");
        })();
      } else if (event.type === "automation-active") {
        setAutomationActive(event.active);
      } else if (event.type === "ensure-browser-page-resident") {
        // Explicit agent targeting makes that renderer-local guest the presented
        // page and refreshes residency without changing the user's selected
        // global workspace tab. This lets an agent drive a full-size webview
        // while a file or tool such as Git remains selected.
        if (isMainWindow) {
          useBrowserPanelStore.getState().setActive(event.tabId);
          useRightWorkspaceTabsStore.getState().promoteBrowserPage(event.tabId);
        }
      } else if (event.type === "picker-cancelled") {
        setPickerActive(false);
      } else if (event.type === "usage-login-confirmation") {
        setUsageLoginConfirmation(event.request);
      } else if (event.type === "usage-login-confirmation-closed") {
        clearUsageLoginConfirmation(event.requestId);
      } else if (event.type === "usage-login-device-code") {
        setUsageLoginDeviceCode(event.deviceCode);
      } else if (event.type === "usage-login-device-code-cleared") {
        clearUsageLoginDeviceCode(event.providerId);
      }
    });
    bridge
      .browserGetState()
      .then((state) => {
        // A live state event is newer than this initial request. Never let a
        // late response resurrect a page that was already closed.
        if (cancelled || receivedLiveState) return;
        const initialIds = new Set(state.tabs.map((tab) => tab.tabId));
        const tabs = state.tabs.map((tab) => liveTabUpdates.get(tab.tabId) ?? tab);
        for (const [tabId, tab] of liveTabUpdates) {
          if (!initialIds.has(tabId)) tabs.push(tab);
        }
        applyState({ ...state, tabs });
      })
      .catch(() => {});
    return () => {
      invalidateCurrentPresentationBestEffort("renderer-unmounted");
      cancelled = true;
      presentationAbort.abort();
      unsubscribePresentationObstruction();
      for (const unsubscribe of presentationStoreUnsubscribers) unsubscribe();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("resize", onViewportResize);
      unsub();
    };
  }, [
    setState,
    upsertTab,
    setAttention,
    setPickerActive,
    setAutomationActive,
    setUsageLoginConfirmation,
    clearUsageLoginConfirmation,
    setUsageLoginDeviceCode,
    clearUsageLoginDeviceCode,
  ]);
}
