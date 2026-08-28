import {
  memo,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { useLingui } from "@lingui/react/macro";
import { usePanelStore } from "@/renderer/state/panelStore";
import { useIsPanelTabVisible } from "@/renderer/state/panelDockSelectors";
import { useBrowserPanelStore } from "@/renderer/state/browserPanelStore";
import { useRightWorkspaceTabsStore } from "@/renderer/state/rightWorkspaceTabsStore";
import { pushEscapeHandler } from "@/renderer/components/layout/overlayEscapeStack";
import { BrowserPanel } from "./BrowserPanel";
import {
  HEADLESS_HEIGHT,
  HEADLESS_WIDTH,
  HEADLESS_Z,
  type BrowserHostMode,
  useBrowserHostPositioning,
} from "./useBrowserHostPositioning";

const MemoBrowserPanel = memo(BrowserPanel);

// Step used when the drawer's resize handle is nudged via arrow keys.
const DRAWER_RESIZE_STEP_PX = 24;

/**
 * Mounts the in-app browser exactly once, in a `document.body` portal, and
 * repositions it per presentation mode (docked over the right-panel slot,
 * floating drawer, or fullscreen). Keeping a single mounted instance is what
 * lets the live page survive every docked↔drawer↔fullscreen transition — each
 * `<webview>` owns its own guest WebContents, so remounting would reload it.
 *
 * Rendering from the body (rather than inside the right panel) is also required
 * for correctness: the panel lives under a `will-change-transform` ancestor
 * (AsideSlot) and inside a `z-index` stacking context (UnifiedRightPanel tab
 * layer), both of which would clip a nested `position: fixed` overlay.
 *
 * Positioning is applied imperatively so per-frame rect tracking never
 * re-renders the embedded webview.
 */
export function BrowserHost() {
  const { t } = useLingui();
  const browserPanelOpen = usePanelStore((s) => s.browserPanelOpen);
  const browserOverlayOpen = usePanelStore((s) => s.browserOverlayOpen);
  const browserOverlayMaximized = usePanelStore((s) => s.browserOverlayMaximized);
  const drawerWidth = usePanelStore((s) => s.browserOverlayDrawerWidth);
  const setDrawerWidth = usePanelStore((s) => s.setBrowserOverlayDrawerWidth);
  const setBrowserOverlayOpen = usePanelStore((s) => s.setBrowserOverlayOpen);
  const setBrowserOverlayMaximized = usePanelStore((s) => s.setBrowserOverlayMaximized);
  const setRightPanelTab = usePanelStore((s) => s.setRightPanelTab);
  const extracted = useBrowserPanelStore((s) => s.extracted);
  const automationActive = useBrowserPanelStore((s) => s.automationActive);
  const browserWorkspaceTabActive = useRightWorkspaceTabsStore((s) =>
    s.tabs.some((tab) => tab.id === s.activeTabId && tab.kind === "browser-page"),
  );
  const hasResidentBrowserPages = useRightWorkspaceTabsStore((s) =>
    s.tabs.some((tab) => tab.kind === "browser-page" && tab.resident),
  );
  const hasWorkspaceTabs = useRightWorkspaceTabsStore((s) => s.tabs.length > 0);
  const workspaceHidden = useRightWorkspaceTabsStore((s) => s.hidden);

  // The browser is painted wherever its dock slot lives: the right panel's
  // active layer, a right-panel split section, or a bottom dock slot. Keying
  // this off `rightPanelTab` alone would drop a split/docked browser into
  // off-screen background mode, leaving an empty section behind.
  const legacyDockedVisible = useIsPanelTabVisible("browser");
  // Each page is now a first-class global workspace tab. The legacy dock slot
  // still supplies geometry, but only the active global browser page may paint
  // there; switching to a file/tool moves resident pages off-screen intact.
  const dockedVisible = legacyDockedVisible && !workspaceHidden && browserWorkspaceTabActive;
  // An empty workspace may still show Browser's create-first-page state. Once
  // any global peer exists, only a selected Browser page may own the overlay.
  const overlayVisible = browserOverlayOpen && (browserWorkspaceTabActive || !hasWorkspaceTabs);

  const mode: BrowserHostMode = extracted
    ? "hidden"
    : overlayVisible
      ? browserOverlayMaximized
        ? "fullscreen"
        : "drawer"
      : browserPanelOpen && dockedVisible
        ? "docked"
        : // Panel + overlay both closed: keep tabs alive off-screen so the agent
          // can drive them headless (no forced panel reveal).
          "background";

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  useBrowserHostPositioning({ wrapperRef, mode, drawerWidth, dockedVisible });

  useLayoutEffect(() => {
    if (browserOverlayOpen && hasWorkspaceTabs && !browserWorkspaceTabActive) {
      setBrowserOverlayOpen(false);
    }
  }, [browserOverlayOpen, browserWorkspaceTabActive, hasWorkspaceTabs, setBrowserOverlayOpen]);

  useLayoutEffect(() => {
    if (mode !== "drawer" && mode !== "fullscreen") return;
    return pushEscapeHandler(restoreOrCloseOverlay);
    // restoreOrCloseOverlay closes over stable store setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, browserPanelOpen]);

  useLayoutEffect(
    () => () => {
      resizeCleanupRef.current?.();
      resizeCleanupRef.current = null;
    },
    [],
  );

  useLayoutEffect(() => {
    if (mode === "drawer" || !resizeCleanupRef.current) return;
    resizeCleanupRef.current();
    resizeCleanupRef.current = null;
    setIsResizing(false);
  }, [mode]);

  // Extracted → the standalone window owns the browser. Once the browser panel
  // has been opened, resident pages remain mounted off-screen while a file/tool
  // is selected; agent automation may mount those residents headlessly too.
  // Restored metadata alone stays lazy so app startup does not create webviews.
  if (mode === "hidden") return null;
  if (
    mode === "background" &&
    (!hasResidentBrowserPages || (!browserPanelOpen && !automationActive))
  ) {
    return null;
  }

  function restoreOrCloseOverlay() {
    setBrowserOverlayMaximized(false);
    setBrowserOverlayOpen(false);
    if (browserPanelOpen) setRightPanelTab("browser");
  }

  function handleResizeStart(event: ReactMouseEvent<HTMLDivElement>) {
    event.preventDefault();
    resizeCleanupRef.current?.();
    const startX = event.clientX;
    const startWidth = drawerWidth;
    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "ew-resize";
    setIsResizing(true);
    let active = true;
    const onMove = (e: MouseEvent) => {
      // Handle is on the LEFT edge of a panel anchored to the RIGHT viewport
      // edge; dragging left (negative delta) grows the panel.
      setDrawerWidth(startWidth + (startX - e.clientX));
    };
    const onUp = () => teardown(true);
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") onUp();
    };
    const cleanupWithoutState = () => teardown(false);
    const teardown = (updateState: boolean) => {
      if (!active) return;
      active = false;
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("blur", onUp);
      window.removeEventListener("pagehide", onUp);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (resizeCleanupRef.current === cleanupWithoutState) {
        resizeCleanupRef.current = null;
      }
      if (updateState) setIsResizing(false);
    };
    resizeCleanupRef.current = cleanupWithoutState;
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("blur", onUp);
    window.addEventListener("pagehide", onUp);
    document.addEventListener("visibilitychange", onVisibilityChange);
  }

  // Keyboard equivalent of dragging: the handle sits on the drawer's left
  // edge, so ArrowLeft (drag left) grows the drawer and ArrowRight (drag
  // right) shrinks it — matching handleResizeStart's drag semantics.
  function handleResizeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setDrawerWidth(drawerWidth + DRAWER_RESIZE_STEP_PX);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setDrawerWidth(drawerWidth - DRAWER_RESIZE_STEP_PX);
    }
  }

  // Docked z-index defaults to z-30 here; while the host panel is floating as a
  // fixed overlay, the positioning effect lifts it to 55 imperatively (see the
  // docked branch above) so it never re-renders the embedded webview.
  const wrapperClassName =
    mode === "docked"
      ? "fixed z-30 flex min-h-0 flex-col overflow-hidden bg-[var(--content-background)]"
      : mode === "drawer"
        ? "fixed z-[60] flex min-h-0 flex-col overflow-hidden rounded-3xl border border-border bg-background shadow-2xl"
        : mode === "background"
          ? "fixed flex min-h-0 flex-col overflow-hidden pointer-events-none opacity-0 bg-[var(--content-background)]"
          : "fixed z-[80] flex min-h-0 flex-col overflow-hidden bg-background";

  // Give the static modes (drawer/fullscreen) a definite box at first render,
  // mirroring the values the layout effect re-applies below. The embedded
  // <webview> self-paints its guest at whatever size its layout box has the
  // moment it mounts; if geometry is only applied a tick later in useLayoutEffect
  // the wrapper commits at auto (~0) height and the guest latches a blank surface
  // it never re-presents (docked dodges this via its per-frame rAF resize loop).
  const wrapperStyle: CSSProperties | undefined =
    mode === "drawer"
      ? {
          top: "2rem",
          right: "2rem",
          bottom: "2rem",
          left: "auto",
          width: `${drawerWidth}px`,
          maxWidth: "calc(100vw - 4rem)",
        }
      : mode === "fullscreen"
        ? { top: 0, left: 0, right: 0, bottom: 0 }
        : mode === "background"
          ? {
              top: 0,
              left: 0,
              width: HEADLESS_WIDTH,
              height: HEADLESS_HEIGHT,
              zIndex: Number(HEADLESS_Z),
            }
          : mode === "docked" && !dockedVisible
            ? { display: "none" }
            : undefined;

  // Keep the active tab painting (display:flex) even off-screen so the agent
  // can screenshot it headlessly; only the docked-but-not-selected case hides.
  const browserVisible = mode === "docked" ? dockedVisible : true;

  return createPortal(
    <>
      {mode === "drawer" ? (
        <div
          className="fixed inset-0 z-[59] bg-black/40"
          onClick={restoreOrCloseOverlay}
          aria-hidden
        />
      ) : null}
      <div
        ref={wrapperRef}
        data-y-space-browser-host=""
        aria-hidden={mode === "background"}
        inert={mode === "background"}
        className={wrapperClassName}
        style={wrapperStyle}
      >
        {mode === "drawer" ? (
          <div
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-label={t`Resize browser drawer`}
            className="absolute left-0 top-0 bottom-0 z-10 w-1.5 cursor-ew-resize transition-colors hover:bg-foreground/15"
            onMouseDown={handleResizeStart}
            onKeyDown={handleResizeKeyDown}
          />
        ) : null}
        <MemoBrowserPanel visible={browserVisible} />
      </div>
      {isResizing ? (
        <div className="fixed inset-0 z-[100]" style={{ cursor: "ew-resize" }} aria-hidden />
      ) : null}
    </>,
    document.body,
  );
}
