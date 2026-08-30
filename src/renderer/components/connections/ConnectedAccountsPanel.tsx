import { Trans, useLingui } from "@lingui/react/macro";
import { Check, RefreshCw, Unplug } from "lucide-react";
import { Button } from "@/renderer/components/common/Button";
import { ToggleSwitch } from "@/renderer/components/common";
import type { PipedreamAccountSummary } from "@/shared/contracts";
import { ConnectionAppIcon } from "./ConnectionAppIcon";

interface ConnectedAccountsPanelProps {
  readonly accounts: readonly PipedreamAccountSummary[];
  readonly busy: string | null;
  readonly onAgentAccessChange: (account: PipedreamAccountSummary, enabled: boolean) => void;
  readonly onRefresh: () => void;
  readonly onRequestDisconnect: (account: PipedreamAccountSummary) => void;
}

export function ConnectedAccountsPanel(props: ConnectedAccountsPanelProps) {
  const { t } = useLingui();
  return (
    <aside className="min-w-0 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-foreground">
            <Trans>Connected</Trans>
          </p>
          <p className="text-xs text-muted">
            <Trans>{props.accounts.length} accounts</Trans>
          </p>
        </div>
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label={t`Refresh accounts`}
          isDisabled={props.busy !== null}
          onPress={props.onRefresh}
        >
          <RefreshCw className={`size-3.5 ${props.busy === "refresh" ? "animate-spin" : ""}`} />
        </Button>
      </div>
      {props.accounts.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[var(--hairline)] px-4 py-8 text-center text-xs text-muted">
          <Trans>No connected accounts yet.</Trans>
        </div>
      ) : (
        <div className="space-y-2">
          {props.accounts.map((account) => (
            <div
              key={account.id}
              className="rounded-2xl border border-[var(--hairline)] bg-surface-secondary/45 p-3"
            >
              <div className="flex items-center gap-2.5">
                <ConnectionAppIcon app={account.app} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{account.name}</p>
                  <p className="truncate text-[11px] text-muted">
                    {account.app.name} · {account.healthy ? t`Healthy` : t`Needs attention`}
                  </p>
                </div>
                <ToggleSwitch
                  aria-label={t`Allow agents to use ${account.name}`}
                  isSelected={account.agentAccess}
                  isDisabled={props.busy !== null || !account.healthy}
                  onChange={(enabled) => props.onAgentAccessChange(account, enabled)}
                />
              </div>
              <div className="mt-2 flex items-center justify-between border-t border-[var(--hairline)] pt-2">
                <span className="flex items-center gap-1 text-[11px] text-muted">
                  {account.agentAccess ? (
                    <>
                      <Check className="size-3 text-success" />
                      <Trans>Available to agents</Trans>
                    </>
                  ) : (
                    <Trans>Agent access off</Trans>
                  )}
                </span>
                <Button
                  isIconOnly
                  size="sm"
                  variant="ghost"
                  aria-label={t`Disconnect ${account.name}`}
                  isDisabled={props.busy !== null}
                  onPress={() => props.onRequestDisconnect(account)}
                >
                  <Unplug className="size-3.5 text-danger" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
