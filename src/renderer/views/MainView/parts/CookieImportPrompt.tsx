import { AlertDialog, Button } from "@heroui/react";
import { Trans } from "@lingui/react/macro";
import { useState } from "react";
import { usePanelStore } from "@/renderer/state/panelStore";
import { isWelcomeSeen, useWelcomeGateStore } from "@/renderer/state/welcomeGateStore";
import { useSensitiveNativeViewOverlayGate } from "@/renderer/state/sensitiveNativeViewObstruction";
import { readStoredBoolean, writeStoredBoolean } from "@/renderer/utils/localStorage";

export const COOKIE_IMPORT_PROMPT_STORAGE_KEY = "y-space-cookie-import-prompt-seen-v1";

export function CookieImportPrompt() {
  const reactiveWelcomeSeen = useWelcomeGateStore((state) => state.welcomeSeen);
  const [asked, setAsked] = useState(() =>
    readStoredBoolean(COOKIE_IMPORT_PROMPT_STORAGE_KEY, false),
  );
  const wantsOpen = (reactiveWelcomeSeen || isWelcomeSeen()) && !asked;
  const overlayReady = useSensitiveNativeViewOverlayGate(wantsOpen);

  const dismiss = () => {
    writeStoredBoolean(COOKIE_IMPORT_PROMPT_STORAGE_KEY, true);
    setAsked(true);
  };

  const chooseBrowsers = () => {
    dismiss();
    usePanelStore.getState().openSettingsSection("browser", "browser.cookieImport");
  };

  if (!wantsOpen || !overlayReady) return null;

  return (
    <AlertDialog.Backdrop isOpen onOpenChange={(open) => !open && dismiss()}>
      <AlertDialog.Container size="sm">
        <AlertDialog.Dialog className="sm:max-w-[440px] !p-5">
          <AlertDialog.Header className="gap-1">
            <AlertDialog.Heading>
              <Trans>Bring your browser sessions into Y Space?</Trans>
            </AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.Body>
            <p className="text-sm leading-relaxed text-muted">
              <Trans>
                Choose the installed browser profiles and exact sites you want to copy. Nothing is
                imported until you review and confirm it.
              </Trans>
            </p>
          </AlertDialog.Body>
          <AlertDialog.Footer>
            <Button variant="ghost" onPress={dismiss}>
              <Trans>Not now</Trans>
            </Button>
            <Button variant="primary" onPress={chooseBrowsers}>
              <Trans>Choose browsers</Trans>
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
}
