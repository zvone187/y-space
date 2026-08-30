import { Trans } from "@lingui/react/macro";
import { FileKey2 } from "lucide-react";
import { Button } from "@/renderer/components/common/Button";
import type { PipedreamSnapshot } from "@/shared/contracts";

interface ConnectionsConfigurationStateProps {
  readonly snapshot: PipedreamSnapshot | null;
  readonly busy: boolean;
  readonly onChoose: () => void;
}

export function ConnectionsConfigurationState(props: ConnectionsConfigurationStateProps) {
  return (
    <div className="flex min-h-80 items-center justify-center">
      <div className="w-full max-w-md rounded-3xl border border-[var(--hairline)] bg-surface-secondary/55 p-6 text-center">
        <span className="mx-auto flex size-11 items-center justify-center rounded-2xl bg-accent-soft text-accent-soft-foreground">
          <FileKey2 className="size-5" />
        </span>
        <h3 className="mt-4 text-base font-semibold text-foreground">
          <Trans>Set up integrations</Trans>
        </h3>
        <p className="mt-1 text-sm leading-relaxed text-muted">
          <Trans>
            Choose the Pipedream setup file you added for Y Space. Your credentials stay private and
            are never shared with agents.
          </Trans>
        </p>
        {props.snapshot?.connect.state === "partial" ? (
          <p className="mt-3 rounded-xl bg-warning/8 px-3 py-2 text-xs text-warning">
            <Trans>The selected configuration is incomplete.</Trans>
          </p>
        ) : props.snapshot?.connect.state === "error" ? (
          <p className="mt-3 rounded-xl bg-danger/8 px-3 py-2 text-xs text-danger">
            <Trans>Pipedream could not be initialized.</Trans>
          </p>
        ) : null}
        <Button
          className="mt-5"
          variant="secondary"
          isPending={props.busy}
          onPress={props.onChoose}
        >
          <FileKey2 className="size-4" />
          <Trans>Choose setup file</Trans>
        </Button>
      </div>
    </div>
  );
}
