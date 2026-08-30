import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { Input } from "@heroui/react";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChevronDown, ChevronLeft, ChevronRight, CircleAlert, Search } from "lucide-react";
import { Button } from "@/renderer/components/common/Button";
import { PixelLoader } from "@/renderer/components/common/PixelLoader";
import type { PipedreamAppSummary } from "@/shared/contracts";
import { ConnectionAppIcon } from "./ConnectionAppIcon";
import { CATALOG_PAGE_SIZE, type CatalogState } from "./connectionsDialogModel";

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
  const listId = useId();
  const nextButtonId = useId();
  const loadMoreButtonId = useId();
  const restoreFocusAfterLoadMore = useRef(false);
  const [pageIndex, setPageIndex] = useState(0);
  const pageCount = Math.max(1, Math.ceil(props.catalog.apps.length / CATALOG_PAGE_SIZE));
  const visiblePageIndex = Math.min(pageIndex, pageCount - 1);
  const visibleStartIndex = visiblePageIndex * CATALOG_PAGE_SIZE;
  const visibleApps = props.catalog.apps.slice(
    visibleStartIndex,
    visibleStartIndex + CATALOG_PAGE_SIZE,
  );
  const visibleEndIndex = visibleStartIndex + visibleApps.length;
  const hasPreviousPage = visiblePageIndex > 0;
  const hasNextLoadedPage = visibleEndIndex < props.catalog.apps.length;

  useEffect(() => setPageIndex(0), [props.query]);
  useEffect(() => {
    setPageIndex((current) => Math.min(current, pageCount - 1));
  }, [pageCount]);
  useEffect(() => {
    if (!restoreFocusAfterLoadMore.current || props.catalog.loading) return;
    restoreFocusAfterLoadMore.current = false;
    queueMicrotask(() => {
      const preferred = hasNextLoadedPage
        ? document.getElementById(nextButtonId)
        : props.catalog.nextCursor
          ? document.getElementById(loadMoreButtonId)
          : null;
      (preferred instanceof HTMLElement ? preferred : props.searchRef.current)?.focus();
    });
  }, [
    hasNextLoadedPage,
    loadMoreButtonId,
    nextButtonId,
    props.catalog.loading,
    props.catalog.nextCursor,
    props.searchRef,
  ]);

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
          <>
            <div
              id={listId}
              role="list"
              aria-label={t`Integrations`}
              className="divide-y divide-[var(--hairline)]"
            >
              {visibleApps.map((app, index) => (
                <div
                  key={app.id}
                  role="listitem"
                  aria-posinset={visibleStartIndex + index + 1}
                  aria-setsize={props.catalog.apps.length}
                  className="flex min-h-14 items-center gap-3 px-3 py-2"
                >
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
            </div>
            {pageCount > 1 || props.catalog.nextCursor ? (
              <div className="flex items-center justify-end gap-2 border-t border-[var(--hairline)] p-2">
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t`Previous integrations`}
                  aria-controls={listId}
                  isDisabled={!hasPreviousPage}
                  onPress={() => setPageIndex((current) => Math.max(0, current - 1))}
                >
                  <ChevronLeft className="size-3.5" />
                  <Trans>Previous</Trans>
                </Button>
                <Button
                  id={nextButtonId}
                  size="sm"
                  variant="ghost"
                  aria-label={t`Next integrations`}
                  aria-controls={listId}
                  isDisabled={!hasNextLoadedPage}
                  onPress={() => setPageIndex((current) => Math.min(pageCount - 1, current + 1))}
                >
                  <Trans>Next</Trans>
                  <ChevronRight className="size-3.5" />
                </Button>
                {props.catalog.nextCursor && !hasNextLoadedPage ? (
                  <Button
                    id={loadMoreButtonId}
                    size="sm"
                    variant="ghost"
                    aria-label={t`Load more integrations`}
                    aria-controls={listId}
                    isPending={props.catalog.loading}
                    onPress={() => {
                      restoreFocusAfterLoadMore.current = true;
                      props.onLoadMore(props.catalog.nextCursor!);
                    }}
                  >
                    <ChevronDown className="size-3.5" />
                    <Trans>Load more</Trans>
                  </Button>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
      <p aria-live="polite" aria-atomic="true" className="px-1 text-[11px] text-muted">
        <Trans>
          Showing {visibleApps.length === 0 ? 0 : visibleStartIndex + 1}–{visibleEndIndex} of{" "}
          {props.catalog.apps.length} loaded integrations · {props.catalog.totalCount} total
        </Trans>
      </p>
    </div>
  );
}
