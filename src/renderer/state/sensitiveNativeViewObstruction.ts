import { useLayoutEffect, useRef, useState } from "react";

type SensitiveNativeViewPresenter = (obstructed: boolean) => Promise<void>;
type BrowserAutomationPresentationObstructionListener = () => void | Promise<void>;

interface SensitiveNativeViewPresenterEntry {
  readonly present: SensitiveNativeViewPresenter;
  readonly removedAfterHide: Promise<void>;
  retiring: boolean;
  removeAfter(hideAcknowledged: Promise<void>): void;
}

export interface SensitiveNativeViewObstructionLease {
  /** Resolves only after every mounted native sensitive view confirms it is hidden. */
  readonly hidden: Promise<void>;
  /** True only when acquisition found no presenter or automation listener to acknowledge. */
  readonly hiddenSynchronously: boolean;
  release(): void;
}

const presenters = new Set<SensitiveNativeViewPresenterEntry>();
const automationObstructionListeners = new Set<BrowserAutomationPresentationObstructionListener>();
let activeObstructionLeases = 0;
let activeAutomationInvalidation: Promise<void> | null = null;

/** Longer than the renderer's longest common menu/modal exit transition. */
const OVERLAY_EXIT_LINGER_MS = 250;

export function isSensitiveNativeViewObstructed(): boolean {
  return activeObstructionLeases > 0;
}

/** Invalidate any acknowledged ordinary-tab automation presentation. */
export async function notifyBrowserAutomationPresentationObstructed(): Promise<void> {
  const pending: Promise<void>[] = [];
  for (const listener of [...automationObstructionListeners]) {
    const result = listener();
    if (result) pending.push(result);
  }
  await Promise.all(pending);
}

export function subscribeBrowserAutomationPresentationObstruction(
  listener: BrowserAutomationPresentationObstructionListener,
): () => void {
  automationObstructionListeners.add(listener);
  return () => automationObstructionListeners.delete(listener);
}

/**
 * Register one mounted native-sensitive surface. Registration is renderer
 * local: the main and extracted browser windows each gate only their own DOM
 * overlays and their own authorized native view presenter.
 */
export function registerSensitiveNativeViewPresenter(
  presenter: SensitiveNativeViewPresenter,
): (hideAcknowledged: Promise<void>) => void {
  let resolveRemovedAfterHide!: (value: void | PromiseLike<void>) => void;
  const entry: SensitiveNativeViewPresenterEntry = {
    present: presenter,
    removedAfterHide: new Promise<void>((resolve) => {
      resolveRemovedAfterHide = resolve;
    }),
    retiring: false,
    removeAfter: resolveRemovedAfterHide,
  };
  // A rejected cleanup hide must keep future overlays fail-closed, but the
  // registry itself must not create an unhandled rejection when none is open.
  void entry.removedAfterHide.catch(() => {});
  presenters.add(entry);
  if (isSensitiveNativeViewObstructed()) void presenter(true).catch(() => {});
  return (hideAcknowledged) => {
    if (entry.retiring) return;
    entry.retiring = true;
    // Removal alone is not proof that Electron stopped painting the native
    // view. Keep the retiring presenter authoritative for both current and new
    // overlay barriers until this exact cleanup hide IPC has acknowledged.
    entry.removeAfter(hideAcknowledged);
    void hideAcknowledged.then(
      () => presenters.delete(entry),
      () => {
        // Retain the failed entry. Its rejected removedAfterHide promise makes
        // every later obstruction acquisition fail closed as well.
      },
    );
  };
}

/**
 * Acquire an obstruction lease before painting renderer UI over a native
 * WebContentsView. The caller must not reveal the overlay until `hidden`
 * resolves, and must always release the lease when the overlay closes.
 */
export function acquireSensitiveNativeViewObstruction(): SensitiveNativeViewObstructionLease {
  const startsObstruction = activeObstructionLeases === 0;
  activeObstructionLeases += 1;
  if (
    automationObstructionListeners.size > 0 &&
    (startsObstruction || activeAutomationInvalidation === null)
  ) {
    // Listener invocation begins synchronously, before any sensitive-view hide
    // calls and before React can reveal the requested overlay.
    activeAutomationInvalidation = notifyBrowserAutomationPresentationObstructed();
  }
  // Listener invocation is synchronous up to its returned Promise. Snapshot
  // afterward so a presenter registered by that work joins this same barrier.
  const presenterSnapshot = [...presenters];
  const hiddenSynchronously =
    activeAutomationInvalidation === null && presenterSnapshot.length === 0;
  const hidden = hiddenSynchronously
    ? Promise.resolve()
    : Promise.all([
        activeAutomationInvalidation ?? Promise.resolve(),
        ...presenterSnapshot.map((presenter) =>
          presenter.retiring
            ? presenter.removedAfterHide
            : Promise.race([presenter.present(true), presenter.removedAfterHide]),
        ),
      ]).then(() => undefined);
  let released = false;
  return {
    hidden,
    hiddenSynchronously,
    release() {
      if (released) return;
      released = true;
      activeObstructionLeases = Math.max(0, activeObstructionLeases - 1);
      if (activeObstructionLeases !== 0) return;
      activeAutomationInvalidation = null;
      for (const presenter of presenters) {
        if (!presenter.retiring) void presenter.present(false).catch(() => {});
      }
    },
  };
}

/**
 * Gate a renderer overlay on the native hide acknowledgment. A failed hide is
 * fail-closed: the overlay stays unpainted instead of being covered by an
 * interactive native surface.
 */
export function useSensitiveNativeViewOverlayGate(active: boolean): boolean {
  const [ready, setReady] = useState(false);
  const leaseRef = useRef<SensitiveNativeViewObstructionLease | null>(null);
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readinessGenerationRef = useRef(0);

  useLayoutEffect(() => {
    const generation = ++readinessGenerationRef.current;
    if (active) {
      if (releaseTimerRef.current !== null) {
        clearTimeout(releaseTimerRef.current);
        releaseTimerRef.current = null;
      }
      const lease = leaseRef.current ?? acquireSensitiveNativeViewObstruction();
      leaseRef.current = lease;
      if (lease.hiddenSynchronously) {
        setReady(true);
        return;
      }
      setReady(false);
      void lease.hidden.then(
        () => {
          if (readinessGenerationRef.current === generation) setReady(true);
        },
        () => {
          if (readinessGenerationRef.current === generation) setReady(false);
        },
      );
      return;
    }

    setReady(false);
    if (leaseRef.current && releaseTimerRef.current === null) {
      releaseTimerRef.current = setTimeout(() => {
        releaseTimerRef.current = null;
        leaseRef.current?.release();
        leaseRef.current = null;
      }, OVERLAY_EXIT_LINGER_MS);
    }
  }, [active]);

  useLayoutEffect(
    () => () => {
      ++readinessGenerationRef.current;
      if (releaseTimerRef.current !== null) clearTimeout(releaseTimerRef.current);
      const lease = leaseRef.current;
      leaseRef.current = null;
      // A component unmount removes its portal immediately; only a still-
      // mounted component can own HeroUI's data-exiting surface.
      lease?.release();
    },
    [],
  );

  return active && ready;
}
