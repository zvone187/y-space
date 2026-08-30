import { AlertDialog } from "@heroui/react";
import { useLingui } from "@lingui/react/macro";
import { useSensitiveNativeViewOverlayGate } from "@/renderer/state/sensitiveNativeViewObstruction";
import { Button } from "./Button";

type ConfirmVariant = "danger" | "primary" | "secondary";

export function ConfirmDialog(props: {
  isOpen: boolean;
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  confirmVariant?: ConfirmVariant;
  status?: "danger" | "warning";
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const {
    isOpen,
    title,
    body,
    confirmLabel,
    cancelLabel,
    confirmVariant = "danger",
    status = "danger",
    onConfirm,
    onClose,
  } = props;
  const overlayReady = useSensitiveNativeViewOverlayGate(isOpen);
  const presentedOpen = isOpen && overlayReady;
  const resolvedCancelLabel = cancelLabel ?? t`Cancel`;

  return (
    <AlertDialog.Backdrop isOpen={presentedOpen} onOpenChange={(open) => !open && onClose()}>
      <AlertDialog.Container>
        <AlertDialog.Dialog>
          <AlertDialog.Header>
            <AlertDialog.Icon status={status} />
            <AlertDialog.Heading>{title}</AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.Body>{body}</AlertDialog.Body>
          <AlertDialog.Footer>
            <Button slot="close" variant="ghost" className="text-muted">
              {resolvedCancelLabel}
            </Button>
            <Button variant={confirmVariant} onPress={onConfirm}>
              {confirmLabel}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
}
