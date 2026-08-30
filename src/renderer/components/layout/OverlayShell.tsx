import { useEffect, useRef, useState, type ReactNode, type TransitionEvent } from "react";
import { useSensitiveNativeViewOverlayGate } from "@/renderer/state/sensitiveNativeViewObstruction";
import { pushEscapeHandler } from "./overlayEscapeStack";

export type OverlayShellMode = "fixed" | "absolute";

/**
 * Shared overlay wrapper with fade-in/fade-out animation.
 * Renders children in a full-cover container and animates opacity on
 * mount/unmount. Pressing Escape triggers a close via the fade-out → onExited
 * path.
 *
 * `mode="fixed"` (default) covers the whole window. `mode="absolute"` covers
 * the nearest positioned ancestor — used for pane-scoped overlays (e.g. the
 * sub-agent drawer over a single chat pane in a split-pane layout).
 *
 * `instantEnter` skips the fade-in. Glass overlays hide the base app while they
 * are shown, so a fade-in composites the overlay against bare desktop material.
 * That is fine for content that paints in one frame, but an overlay that is
 * still mounting during the fade (GitHub Actions builds its view model and
 * fetches workflows) leaves the user watching full-screen acrylic instead. Such
 * overlays appear at full opacity and keep the fade-out only.
 */
export function OverlayShell(props: {
  open: boolean;
  onExited?: () => void;
  children: ReactNode;
  mode?: OverlayShellMode;
  instantEnter?: boolean;
}) {
  const { open, onExited, children, mode = "fixed", instantEnter = false } = props;
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);
  const obstructionReady = useSensitiveNativeViewOverlayGate(open || mounted);
  const presentedOpen = open && obstructionReady;
  const escapeClosingRef = useRef(false);
  const wasPresentedRef = useRef(false);
  // Overlays that clear their own context on close (e.g. the GitHub Actions
  // view) drop their children in the same render that flips `open` to false,
  // which would blank the surface before the fade-out ran. Keep the last open
  // children and render those for the duration of the exit transition.
  const exitChildrenRef = useRef(children);

  useEffect(() => {
    if (presentedOpen) {
      wasPresentedRef.current = true;
      exitChildrenRef.current = children;
    }
  }, [children, presentedOpen]);

  // Mount immediately when opened, fade in on next frame
  useEffect(() => {
    if (presentedOpen) {
      if (escapeClosingRef.current) return undefined;
      setMounted(true);
      // Batched with setMounted into a single render, so the surface never
      // paints at opacity-0 and no enter transition runs.
      if (instantEnter) {
        setVisible(true);
        return undefined;
      }
      // Delay to allow the DOM to render at opacity-0 before transitioning
      const raf = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(raf);
    }
    // Parent acknowledged close — reset escape flag
    escapeClosingRef.current = false;
    // Start fade-out
    setVisible(false);
    return undefined;
  }, [presentedOpen, instantEnter]);

  // If the requested overlay closes before the native hide acknowledgment,
  // there was no renderer surface to animate out. Tear it down immediately so
  // its obstruction lease cannot wait forever for a transition that will
  // never run.
  useEffect(() => {
    if (open || !mounted || wasPresentedRef.current) return;
    setMounted(false);
    onExited?.();
  }, [mounted, onExited, open]);

  // Close on Escape via the overlay escape stack — only the topmost overlay
  // dismisses, so a transient overlay floating above this one (e.g. the
  // browser drawer at z-60 above Settings at z-50) consumes Escape first.
  useEffect(() => {
    if (!presentedOpen || !onExited) return;
    return pushEscapeHandler(() => {
      escapeClosingRef.current = true;
      setVisible(false);
      (document.activeElement as HTMLElement | null)?.blur();
    });
  }, [presentedOpen, onExited]);

  // Unmount after this surface's own fade-out completes. Overlay content
  // animates too, and those transitions bubble — unmounting on a child's
  // transitionEnd cut the fade short and read as a flicker.
  function handleTransitionEnd(event: TransitionEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    if (event.propertyName !== "opacity") return;
    if (!visible) {
      setMounted(false);
      wasPresentedRef.current = false;
      onExited?.();
    }
  }

  if (!mounted || !obstructionReady) return null;

  const positionClass = mode === "fixed" ? "fixed inset-0 z-50" : "absolute inset-0 z-30";
  return (
    <div
      data-overlay-surface=""
      // Present from the start of the fade-in until the start of the fade-out.
      // The glass-sidebar CSS hides the base app behind this overlay, so it
      // must engage immediately — leaving the app painted during the fade
      // shows the main-window sidebar through the translucent overlay. The
      // overlay is responsible for painting its own chrome on the first frame.
      {...(visible ? { "data-overlay-visible": "" } : {})}
      className={`${positionClass} flex flex-col bg-background transition-opacity duration-150 ${
        visible ? "opacity-100" : "opacity-0"
      }`}
      onTransitionEnd={handleTransitionEnd}
    >
      {presentedOpen ? children : exitChildrenRef.current}
    </div>
  );
}
