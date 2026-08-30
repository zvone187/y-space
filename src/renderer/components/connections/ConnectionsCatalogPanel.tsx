import type { RefObject } from "react";
import { Input } from "@heroui/react";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChevronDown, CircleAlert, Search } from "lucide-react";
import { Button } from "@/renderer/components/common/Button";
import { PixelLoader } from "@/renderer/components/common/PixelLoader";
import type { PipedreamAppSummary } from "@/shared/contracts";
import { ConnectionAppIcon } from "./ConnectionAppIcon";
import type { CatalogState } from "./connectionsDialogModel";

interface ConnectionsCatalogPanelProps {
  readonly busy: string | null;
  readonly catalog: CatalogState;
  readonly query: string;
  readonly searchRef: RefObject<HTMLInputElement | null>;
  readonly onConnect: (app: PipedreamAppSummary) => void;
  readonly onLoadMore: (cursor: string) => void;
  readonly onQueryChange: (value: string) => void;
  readonly onSearch: () => void;
}

export function ConnectionsCatalogPanel(props: ConnectionsCatalogPanelProps) {
  const { t } = useLingui();
  return (
    <div className="min-w-0 space-y-3">
      <div>
        <p className="text-sm font-semibold text-foreground">
          <Trans>Add an integration</Trans>
        </p>
        <p className="mt-0.5 text-xs text-muted">
          <Trans>Search every available integration.</Trans>
        </p>
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-muted" />
        <Input
          ref={props.searchRef}
          aria-label={t`Search integrations`}
          className="w-full pl-9"
          placeholder={t`Search Gmail, Slack, Notion…`}
          value={props.query}
          onChange={(event) => props.onQueryChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              props.onSearch();
            }
          }}
        />
      </div>

      <div className="min-h-48 overflow-hidden rounded-2xl border border-[var(--hairline)] bg-surface-secondary/45">
        {props.catalog.loading && props.catalog.apps.length === 0 ? (
          <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted">
            <PixelLoader size="xs" />
            <Trans>Loading catalog…</Trans>
          </div>
        ) : props.catalog.error && props.catalog.apps.length === 0 ? (
          <div className="flex min-h-48 flex-col items-center justify-center gap-3 px-6 text-center">
            <CircleAlert className="size-5 text-muted" />
            <p className="text-sm text-muted">
              <Trans>The integration catalog couldn't be loaded.</Trans>
            </p>
            <Button size="sm" variant="tertiary" onPress={props.onSearch}>
              <Trans>Try again</Trans>
            </Button>
          </div>
        ) : props.catalog.apps.length === 0 ? (
          <div className="flex min-h-48 items-center justify-center px-6 text-center text-sm text-muted">
            <Trans>No integrations match this search.</Trans>
          </div>
        ) : (
          <div className="divide-y divide-[var(--hairline)]">
            {props.catalog.apps.map((app) => (
              <div key={app.id} className="flex min-h-14 items-center gap-3 px-3 py-2">
                <ConnectionAppIcon app={app} />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                  {app.name}
                </span>
                <Button
                  size="sm"
                  variant="tertiary"
                  aria-label={t`Connect ${app.name}`}
                  isPending={props.busy === `connect:${app.slug}`}
                  isDisabled={props.busy !== null}
                  onPress={() => props.onConnect(app)}
                >
                  <Trans>Connect</Trans>
                </Button>
              </div>
            ))}
            {props.catalog.nextCursor ? (
              <div className="p-2">
                <Button
                  className="w-full"
                  size="sm"
                  variant="ghost"
                  aria-label={t`Load more integrations`}
                  isPending={props.catalog.loading}
                  onPress={() => props.onLoadMore(props.catalog.nextCursor!)}
                >
                  <ChevronDown className="size-3.5" />
                  <Trans>Load more</Trans>
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </div>
      <p className="px-1 text-[11px] text-muted">
        <Trans>
          {props.catalog.apps.length} of {props.catalog.totalCount} integrations shown
        </Trans>
      </p>
    </div>
  );
}
