import { Trans, useLingui } from "@lingui/react/macro";
import { CheckCircle2, FolderOpen, Puzzle, ShieldCheck } from "lucide-react";
import { Button } from "@/renderer/components/common";
import { useBrowserCookieImport } from "./useBrowserCookieImport";

function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)} ${code.slice(4)}`;
}

function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function browserFamilyLabel(browserFamily: string): string {
  switch (browserFamily) {
    case "chrome":
      return "Chrome";
    case "brave":
      return "Brave";
    case "edge":
      return "Edge";
    default:
      return "Chromium";
  }
}

export function BrowserCookieImportSettings() {
  const { t } = useLingui();
  const model = useBrowserCookieImport();
  const activeRequest = model.state.activeRequest;
  const selectedSource = model.state.sources.find(
    (source) => source.sourceId === model.selectedSourceId,
  );
  const hasBlockingRequest =
    activeRequest !== null &&
    activeRequest.status !== "completed" &&
    activeRequest.status !== "cancelled" &&
    activeRequest.status !== "failed";
  const isLoading = model.operation === "loading";
  const isBusy = model.operation !== null;
  const totalCookieCount =
    activeRequest?.domains.reduce((total, domain) => total + domain.cookieCount, 0) ?? 0;
  const totalUnsupportedCount =
    (activeRequest?.domains.reduce((total, domain) => total + domain.unsupportedCount, 0) ?? 0) +
    (activeRequest?.unscopedUnsupportedCount ?? 0);
  const completedCounts =
    model.completion ??
    (activeRequest?.status === "completed" &&
    activeRequest.importedCount !== undefined &&
    activeRequest.skippedCount !== undefined
      ? {
          requestId: activeRequest.requestId,
          importedCount: activeRequest.importedCount,
          skippedCount: activeRequest.skippedCount,
        }
      : null);

  return (
    <section
      id="browser.cookieImport"
      data-settings-anchor="browser.cookieImport"
      className="scroll-mt-4 border-t border-border/15 pt-5"
    >
      <div className="mb-4 flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
          <ShieldCheck className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">
            <Trans>Import browser cookies</Trans>
          </h2>
          <p className="mt-0.5 text-xs leading-relaxed text-muted">
            <Trans>
              Copy selected sign-in cookies into Y Space&apos;s embedded browser. The extension is
              import-only and cannot navigate, inspect, or control your other browser.
            </Trans>
          </p>
        </div>
      </div>

      <div className="space-y-3">
        <div className="rounded-xl border border-border/15 bg-surface-secondary/25 p-3">
          <div className="flex items-center gap-2">
            <Puzzle className="size-4 text-muted" aria-hidden="true" />
            <h3 className="text-xs font-semibold text-foreground">
              <Trans>Install Y Space Cookie Import</Trans>
            </h3>
          </div>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs leading-relaxed text-muted">
            <li>
              <Trans>
                Open <code>chrome://extensions</code> in Chrome, Brave, Edge, Arc, or Chromium.
              </Trans>
            </li>
            <li>
              <Trans>Enable Developer mode.</Trans>
            </li>
            <li>
              <Trans>
                Choose <strong>Load unpacked</strong> and select the folder that opens below.
              </Trans>
            </li>
            <li>
              <Trans>Start pairing below, then enter the code in the extension popup.</Trans>
            </li>
          </ol>
          <Button
            size="sm"
            variant="tertiary"
            className="mt-3"
            isPending={model.operation === "opening-extension"}
            isDisabled={isBusy}
            onPress={() => void model.openExtensionFolder()}
          >
            <FolderOpen className="size-3.5" aria-hidden="true" />
            <Trans>Open extension folder</Trans>
          </Button>
        </div>

        <div className="rounded-xl border border-border/15 bg-surface-secondary/25 p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-xs font-semibold text-foreground">
                <Trans>Pair a browser profile</Trans>
              </h3>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted">
                <Trans>Each one-time code expires quickly and works only on this computer.</Trans>
              </p>
            </div>
            {!isLoading && !model.pairing ? (
              <Button
                size="sm"
                variant="tertiary"
                isPending={model.operation === "pairing"}
                isDisabled={isBusy || hasBlockingRequest}
                onPress={() => void model.beginPairing()}
              >
                <Trans>Pair browser profile</Trans>
              </Button>
            ) : null}
          </div>

          {isLoading ? (
            <p className="mt-3 text-xs text-muted">
              <Trans>Loading browser profiles…</Trans>
            </p>
          ) : model.pairing ? (
            <div className="mt-3 flex flex-wrap items-end justify-between gap-3 rounded-lg border border-accent/20 bg-accent/5 p-3">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted">
                  <Trans>Pairing code</Trans>
                </p>
                <output
                  aria-label={t`Pairing code`}
                  className="mt-1 block font-mono text-xl font-semibold tracking-[0.16em] text-foreground"
                >
                  {formatPairingCode(model.pairing.code)}
                </output>
                <p className="mt-1 text-[11px] tabular-nums text-muted">
                  <Trans>Expires in {formatCountdown(model.pairingRemainingMs)}</Trans>
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                isPending={model.operation === "cancelling-pairing"}
                isDisabled={isBusy}
                onPress={() => void model.cancelPairing()}
              >
                <Trans>Cancel pairing</Trans>
              </Button>
            </div>
          ) : null}
        </div>

        {!isLoading ? (
          <div className="rounded-xl border border-border/15 bg-surface-secondary/25 p-3">
            <h3 className="text-xs font-semibold text-foreground">
              <Trans>Paired browser profiles</Trans>
            </h3>
            {model.state.sources.length === 0 ? (
              <p className="mt-2 text-xs text-muted">
                <Trans>No browser profiles paired yet.</Trans>
              </p>
            ) : (
              <ul className="mt-2 space-y-2">
                {model.state.sources.map((source) => (
                  <li
                    key={source.sourceId}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border/10 bg-background/30 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium text-foreground">{source.label}</p>
                      <p className="mt-0.5 text-[11px] text-muted">
                        {browserFamilyLabel(source.browserFamily)} · v{source.extensionVersion} ·{" "}
                        <span className={source.connected ? "text-success" : "text-muted"}>
                          {source.connected ? t`Connected` : t`Disconnected`}
                        </span>
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={t`Forget ${source.label}`}
                      isDisabled={isBusy || Boolean(model.pairing) || hasBlockingRequest}
                      isPending={
                        model.operation === "forgetting-source" &&
                        model.selectedSourceId === source.sourceId
                      }
                      onPress={() => void model.forgetSource(source.sourceId)}
                    >
                      <Trans>Forget</Trans>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}

        {!isLoading ? (
          <div className="rounded-xl border border-border/15 bg-surface-secondary/25 p-3">
            <h3 className="text-xs font-semibold text-foreground">
              <Trans>Choose what to import</Trans>
            </h3>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted">
              <Trans>
                Preview shows domain-level counts only. Nothing is copied until you confirm the
                final selection. Firefox and Safari exports can use Cookie-Editor JSON or Netscape
                cookies.txt.
              </Trans>
            </p>

            <div
              className={`mt-3 grid gap-3 ${model.state.sources.length > 0 ? "sm:grid-cols-[minmax(0,180px)_minmax(0,1fr)]" : ""}`}
            >
              {model.state.sources.length > 0 ? (
                <label className="block text-[11px] font-medium text-muted">
                  <span>
                    <Trans>Source browser profile</Trans>
                  </span>
                  <select
                    aria-label={t`Source browser profile`}
                    value={model.selectedSourceId}
                    disabled={isBusy || Boolean(model.pairing) || hasBlockingRequest}
                    className="mt-1 h-9 w-full rounded-lg border border-border/25 bg-background/50 px-2 text-xs text-foreground outline-none focus:border-accent/60 disabled:opacity-50"
                    onChange={(event) => model.setSelectedSourceId(event.currentTarget.value)}
                  >
                    {model.state.sources.map((source) => (
                      <option key={source.sourceId} value={source.sourceId}>
                        {source.label} {source.connected ? "" : t`(disconnected)`}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              <label className="block text-[11px] font-medium text-muted">
                <span>
                  <Trans>Sites to import cookies for</Trans>
                </span>
                <textarea
                  aria-label={t`Sites to import cookies for`}
                  value={model.targetInput}
                  rows={2}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  disabled={isBusy || Boolean(model.pairing) || hasBlockingRequest}
                  placeholder="https://example.com"
                  className="mt-1 block w-full resize-y rounded-lg border border-border/25 bg-background/50 px-2.5 py-2 font-mono text-xs text-foreground outline-none placeholder:text-muted/40 focus:border-accent/60 disabled:opacity-50"
                  onChange={(event) => model.setTargetInput(event.currentTarget.value)}
                />
                <span className="mt-1 flex flex-wrap items-center justify-between gap-2 font-normal text-muted/75">
                  <span>
                    <Trans>One exact HTTP(S) origin per line, up to 12.</Trans>
                  </span>
                  {model.activeOrigin &&
                  model.targetInput !== model.activeOrigin &&
                  !hasBlockingRequest ? (
                    <button
                      type="button"
                      className="text-accent hover:underline disabled:opacity-50"
                      disabled={isBusy}
                      onClick={model.useActiveOrigin}
                    >
                      <Trans>Use active embedded tab</Trans>
                    </button>
                  ) : null}
                </span>
              </label>
            </div>

            {!hasBlockingRequest ? (
              <div className="mt-3 flex flex-wrap justify-end gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  isPending={model.operation === "choosing-file"}
                  isDisabled={isBusy || Boolean(model.pairing) || !model.targetInput.trim()}
                  onPress={() => void model.chooseFile()}
                >
                  <Trans>Choose cookie file</Trans>
                </Button>
                {model.state.sources.length > 0 ? (
                  <Button
                    size="sm"
                    variant="tertiary"
                    isPending={model.operation === "previewing"}
                    isDisabled={
                      isBusy ||
                      Boolean(model.pairing) ||
                      !selectedSource?.connected ||
                      !model.targetInput.trim()
                    }
                    onPress={() => void model.preview()}
                  >
                    <Trans>Preview extension cookies</Trans>
                  </Button>
                ) : null}
              </div>
            ) : null}

            {activeRequest?.status === "requesting-preview" ? (
              <p className="mt-3 text-xs text-muted">
                <Trans>
                  Open the Y Space Cookie Import popup in your browser and approve these origins.
                </Trans>
              </p>
            ) : null}

            {activeRequest?.status === "failed" ? (
              <p className="mt-3 text-xs text-danger" role="alert">
                <Trans>The preview failed. Reconnect the extension and try again.</Trans>
              </p>
            ) : null}

            {activeRequest?.status === "ready" ? (
              <div className="mt-3 rounded-lg border border-border/15 bg-background/25 p-3">
                {activeRequest.sourceKind === "file" && activeRequest.sourceLabel ? (
                  <p className="mb-2 text-[11px] text-muted">
                    <Trans>Cookie file:</Trans>{" "}
                    <span className="font-mono">{activeRequest.sourceLabel}</span>
                  </p>
                ) : null}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-medium text-foreground">
                    {t`${totalCookieCount} cookies across ${activeRequest.domains.length} domains`}
                  </p>
                  <p className="text-[11px] text-muted">
                    {t`${totalUnsupportedCount} unsupported`}
                  </p>
                </div>

                {activeRequest.domains.length === 0 ? (
                  <p className="mt-2 text-xs text-muted">
                    <Trans>No supported cookies were found for these origins.</Trans>
                  </p>
                ) : (
                  <ul className="mt-2 divide-y divide-border/10">
                    {activeRequest.domains.map((domain) => (
                      <li key={domain.domain} className="flex items-center gap-2 py-2">
                        <input
                          type="checkbox"
                          aria-label={t`Import cookies for ${domain.domain}`}
                          checked={model.selectedDomains.has(domain.domain)}
                          disabled={isBusy || domain.cookieCount === 0}
                          className="size-3.5 accent-accent"
                          onChange={() => model.toggleDomain(domain.domain)}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-mono text-xs text-foreground">
                            {domain.domain}
                          </p>
                          <p className="text-[11px] text-muted">
                            {t`${domain.cookieCount} cookies · ${domain.unsupportedCount} unsupported`}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : null}

            {hasBlockingRequest ? (
              <div className="mt-3 flex flex-wrap justify-end gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  isPending={model.operation === "cancelling-import"}
                  isDisabled={isBusy && model.operation !== "previewing"}
                  onPress={() => void model.cancelImport()}
                >
                  <Trans>Cancel cookie import</Trans>
                </Button>
                {activeRequest.status === "ready" ? (
                  <Button
                    size="sm"
                    variant="tertiary"
                    isPending={model.operation === "committing"}
                    isDisabled={isBusy || model.selectedDomains.size === 0}
                    onPress={() => void model.commit()}
                  >
                    <Trans>Import selected cookies</Trans>
                  </Button>
                ) : null}
              </div>
            ) : null}

            {completedCounts ? (
              <div
                className="mt-3 flex items-center gap-2 rounded-lg border border-success/20 bg-success/5 px-3 py-2 text-xs text-foreground"
                aria-live="polite"
              >
                <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden="true" />
                <p>
                  <Trans>
                    Imported {completedCounts.importedCount} cookies; skipped{" "}
                    {completedCounts.skippedCount}.
                  </Trans>{" "}
                  {completedCounts.flushFailed ? (
                    <Trans>The browser accepted them, but disk flush must be retried.</Trans>
                  ) : null}
                </p>
              </div>
            ) : null}

            {model.error ? (
              <p className="mt-3 text-xs text-danger" role="alert">
                {model.error}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
