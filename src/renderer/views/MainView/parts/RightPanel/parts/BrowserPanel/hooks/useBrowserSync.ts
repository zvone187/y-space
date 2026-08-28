import { useEffect } from "react";
import { readBridge } from "@/renderer/bridge";
import { useBrowserPanelStore } from "@/renderer/state/browserPanelStore";
import { selectAnyObstructingOverlayOpen, usePanelStore } from "@/renderer/state/panelStore";
import { useRightWorkspaceTabsStore } from "@/renderer/state/rightWorkspaceTabsStore";
import { WORKSPACE_TAB_CYCLE_EVENT } from "@/renderer/commands/workspaceTabCycle";
import type { BrowserState, BrowserTabInfo } from "@/shared/ipc";

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
    let receivedLiveState = false;
    const liveTabUpdates = new Map<string, BrowserTabInfo>();
    const isMainWindow = readBridge().windowKind === "main";
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
    const unsub = readBridge().onBrowserEvent((event) => {
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
        const panel = usePanelStore.getState();
        const wantsFullscreen = event.mode === "overlay";
        // Browser pages are already projected into the global strip before a
        // reveal event is emitted. Select the exact active page, then choose
        // docked/drawer/fullscreen presentation without creating a singleton.
        const activeBrowserTabId = useBrowserPanelStore.getState().activeTabId;
        if (activeBrowserTabId) {
          useRightWorkspaceTabsStore.getState().selectBrowserPage(activeBrowserTabId);
        }
        panel.setBrowserPanelOpen(true);
        panel.setRightPanelTab("browser");
        if (wantsFullscreen || selectAnyObstructingOverlayOpen()) {
          // Float the overlay above any active z-50 surface. Fullscreen when the
          // user explicitly chose "overlay" presentation, drawer (z-60) when
          // forced because an obstructing overlay would otherwise hide the page.
          panel.setBrowserOverlayMaximized(wantsFullscreen);
          panel.setBrowserOverlayOpen(true);
        } else {
          if (event.mode === "panel") {
            panel.setBrowserOverlayOpen(false);
          }
        }
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
    readBridge()
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
      cancelled = true;
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
