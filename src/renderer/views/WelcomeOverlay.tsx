import { useEffect, useState, type TransitionEvent } from "react";
import { FolderPlus, MessageSquareText } from "lucide-react";
import { Button } from "@heroui/react";
import { Trans } from "@lingui/react/macro";
import { isHomeProject } from "@/shared/homeScope";
import { loadHomeScopeLocation } from "@/renderer/actions/projectActions";
import { useAppStore } from "@/renderer/state/appStore";
import { useSharedSettings } from "@/renderer/state/sharedSettingsStore";
import {
  isWelcomeSeen,
  useWelcomeGateStore,
  WELCOME_SEEN_STORAGE_KEY,
} from "@/renderer/state/welcomeGateStore";
import { useSensitiveNativeViewOverlayGate } from "@/renderer/state/sensitiveNativeViewObstruction";
import { writeStoredBoolean } from "@/renderer/utils/localStorage";
import { BrandWordmark } from "@/renderer/components/common/BrandWordmark";
import { CreateProjectMenu } from "@/renderer/views/MainView/parts/CreateProject/CreateProjectMenu";
import appIconUrl from "../../../build/icon.png";

// Give the first white frame time to paint before cold agent detection begins.
// There is intentionally no staged intro animation on this minimal surface.
const WELCOME_SETTLE_MS = 300;

export function WelcomeOverlay() {
  const homeScopeEnabled = useSharedSettings((state) => state.homeScopeEnabled);
  const setHomeScopeEnabled = useSharedSettings((state) => state.setHomeScopeEnabled);
  const openDraft = useAppStore((state) => state.openDraft);

  // `welcomeSeen` is resolved synchronously from localStorage (or the dev-only
  // manual-test bypass) so the overlay's open state is known on the very first
  // render — no async settings gate, so the main UI never paints uncovered
  // behind the overlay on first launch.
  const [welcomeSeen, setWelcomeSeen] = useState(isWelcomeSeen);
  const open = !welcomeSeen;
  const [mounted, setMounted] = useState(open);
  const overlayReady = useSensitiveNativeViewOverlayGate(mounted);
  // Initialize `visible` to `open` so the overlay is fully opaque on first paint.
  const [visible, setVisible] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      setVisible(true);
      return;
    }
    setVisible(false);
  }, [open]);

  // First launch only: defer heavy background work until the first frame settles.
  useEffect(() => {
    if (!open) return;
    const releaseTimer = window.setTimeout(() => {
      useWelcomeGateStore.getState().releaseBackgroundWork();
    }, WELCOME_SETTLE_MS);
    return () => clearTimeout(releaseTimer);
  }, [open]);

  function handleTransitionEnd(e: TransitionEvent) {
    if (e.target === e.currentTarget && !visible) {
      setMounted(false);
    }
  }

  function dismissWelcome() {
    writeStoredBoolean(WELCOME_SEEN_STORAGE_KEY, true);
    setWelcomeSeen(true);
    // The user is moving on — let deferred startup work (agent detection) run
    // now rather than waiting out the settle timer.
    useWelcomeGateStore.getState().markWelcomeSeen();
  }

  function handleAskQuestion() {
    if (!homeScopeEnabled) {
      setHomeScopeEnabled(true);
    }
    dismissWelcome();

    const existingHomeProject = useAppStore.getState().projects.find(isHomeProject);
    if (existingHomeProject) {
      openDraft(existingHomeProject.id);
      return;
    }

    void loadHomeScopeLocation()
      .then((location) => {
        const project = useAppStore.getState().ensureHomeProject(location);
        openDraft(project.id);
      })
      .catch(() => {
        useAppStore.getState().openHome();
      });
  }

  if (!mounted || !overlayReady) return null;

  return (
    <div
      className={`fixed inset-0 z-50 flex flex-col bg-background transition-opacity ${
        visible ? "opacity-100 duration-100" : "opacity-0 duration-200"
      }`}
      onTransitionEnd={handleTransitionEnd}
    >
      <div
        className="poracode-overlay-header flex shrink-0 items-center px-2"
        style={{ height: "env(titlebar-area-height, 32px)" }}
      />

      <main className="flex flex-1 items-center justify-center px-6 pb-12">
        <div className="flex w-full max-w-sm flex-col items-center text-center">
          <img
            src={appIconUrl}
            alt=""
            draggable={false}
            className="size-12 rounded-xl border border-border shadow-sm"
          />

          <h1 className="mt-5 text-[2rem] leading-tight font-semibold tracking-[-0.04em] text-foreground">
            <BrandWordmark />
          </h1>
          <p className="mt-2 text-sm text-muted">
            <Trans>Where do you want to begin?</Trans>
          </p>

          <div className="mt-8 flex w-full flex-col gap-2">
            <Button
              fullWidth
              size="lg"
              variant="primary"
              className="h-11 justify-center gap-2 rounded-lg shadow-none"
              onPress={handleAskQuestion}
            >
              <MessageSquareText className="size-4" />
              <Trans>Ask Question</Trans>
            </Button>
            <CreateProjectMenu onSelect={dismissWelcome}>
              <Button
                fullWidth
                size="lg"
                variant="secondary"
                className="h-11 justify-center gap-2 rounded-lg shadow-none"
              >
                <FolderPlus className="size-4" />
                <Trans>Add Project</Trans>
              </Button>
            </CreateProjectMenu>
          </div>
        </div>
      </main>
    </div>
  );
}
