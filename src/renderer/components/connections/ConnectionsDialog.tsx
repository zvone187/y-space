import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Blocks, ExternalLink, X } from "lucide-react";
import { readBridge } from "@/renderer/bridge";
import { Button } from "@/renderer/components/common/Button";
import { pushEscapeHandler } from "@/renderer/components/layout/overlayEscapeStack";
import { PixelLoader } from "@/renderer/components/common/PixelLoader";
import { useBrowserPanelStore } from "@/renderer/state/browserPanelStore";
import { useConnectionsDialogStore } from "@/renderer/state/connectionsDialogStore";
import { usePanelStore } from "@/renderer/state/panelStore";
import { useSensitiveNativeViewOverlayGate } from "@/renderer/state/sensitiveNativeViewObstruction";
import type {
  PipedreamAccountSummary,
  PipedreamAppSummary,
  PipedreamSnapshot,
} from "@/shared/contracts";
import { ConnectedAccountsPanel } from "./ConnectedAccountsPanel";
import { ConnectionsCatalogPanel } from "./ConnectionsCatalogPanel";
import { ConnectionsConfigurationState } from "./ConnectionsConfigurationState";
import {
  CATALOG_PAGE_SIZE,
  CONNECT_MAX_DURATION_MS,
  CONNECT_POLL_INTERVAL_MS,
  EMPTY_CATALOG,
  mergeApps,
  type CatalogState,
  type ConnectAttempt,
} from "./connectionsDialogModel";

interface ConnectionsNotice {
  readonly message: string;
  readonly tone: "danger" | "success" | "warning";
}

/** Query-local guard against repeated cursor pages and same-tick duplicate presses. */
interface CatalogRequestCycle {
  readonly query: string;
  readonly inFlight: Set<string>;
  readonly requestedCursors: Set<string>;
}

/**
 * The sole renderer owner for Pipedream catalog, account, and OAuth progress.
 * The catalog is modeless, but its DOM surface is suspended while sensitive
 * OAuth is waiting. Electron native views always paint above renderer DOM, so
 * the auth browser must own that space until it closes or deactivates.
 */
export function ConnectionsDialogHost() {
  const { t } = useLingui();
  const titleId = useId();
  const searchRef = useRef<HTMLInputElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const catalogRequestRef = useRef(0);
  const catalogRequestCycleRef = useRef<CatalogRequestCycle | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isOpen = useConnectionsDialogStore((state) => state.isOpen);
  const source = useConnectionsDialogStore((state) => state.source);
  const closeDialog = useConnectionsDialogStore((state) => state.closeDialog);
  const bumpRevision = useConnectionsDialogStore((state) => state.bumpRevision);
  const [snapshot, setSnapshot] = useState<PipedreamSnapshot | null>(null);
  const [catalog, setCatalog] = useState<CatalogState>(EMPTY_CATALOG);
  const [query, setQuery] = useState("");
  const [loadingSnapshot, setLoadingSnapshot] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<ConnectionsNotice | null>(null);
  const [attempt, setAttempt] = useState<ConnectAttempt | null>(null);
  const [disconnectCandidate, setDisconnectCandidate] = useState<PipedreamAccountSummary | null>(
    null,
  );
  const waiting = attempt?.status === "waiting";
  const sensitiveAuthActive = useBrowserPanelStore((state) => {
    const activeTab = state.tabs.find((tab) => tab.tabId === state.activeTabId);
    return activeTab?.sensitiveIntegration === true;
  });
  const dialogRequested = isOpen && !(waiting && sensitiveAuthActive);
  const overlayReady = useSensitiveNativeViewOverlayGate(dialogRequested);

  const publishSnapshot = useCallback(
    (next: PipedreamSnapshot, appName?: string): boolean => {
      setSnapshot(next);
      bumpRevision();

      if (next.agentReload?.state === "restart-required") {
        setNotice({
          message: appName
            ? t`${appName} access changed. Restart running agents to apply the update.`
            : t`Integration access changed. Restart running agents to apply the update.`,
          tone: "warning",
        });
        return true;
      }
      if (next.agentReload?.state === "failed-pending") {
        setNotice({
          message: appName
            ? t`${appName} access changed, but running agents could not be updated. Restart them before using the integration.`
            : t`Integration access changed, but running agents could not be updated. Restart them before using integrations.`,
          tone: "danger",
        });
        return true;
      }
      return false;
    },
    [bumpRevision, t],
  );

  const loadCatalog = useCallback(async (searchQuery: string, cursor?: string) => {
    const append = cursor !== undefined;
    const requestKey = cursor ?? "";
    const currentCycle = catalogRequestCycleRef.current;
    let cycle: CatalogRequestCycle;
    if (append) {
      if (
        !currentCycle ||
        currentCycle.query !== searchQuery ||
        currentCycle.inFlight.has(requestKey) ||
        currentCycle.requestedCursors.has(requestKey)
      ) {
        return;
      }
      cycle = currentCycle;
    } else {
      if (currentCycle?.query === searchQuery && currentCycle.inFlight.has(requestKey)) return;
      cycle = {
        query: searchQuery,
        inFlight: new Set(),
        requestedCursors: new Set(),
      };
      catalogRequestCycleRef.current = cycle;
    }
    cycle.inFlight.add(requestKey);
    const requestId = ++catalogRequestRef.current;
    setCatalog((current) => ({
      ...(append ? current : EMPTY_CATALOG),
      error: false,
      loading: true,
    }));
    try {
      const result = await readBridge().pipedreamListApps({
        ...(searchQuery ? { query: searchQuery } : {}),
        ...(cursor ? { cursor } : {}),
        limit: CATALOG_PAGE_SIZE,
      });
      if (catalogRequestRef.current !== requestId || catalogRequestCycleRef.current !== cycle)
        return;
      if (append) cycle.requestedCursors.add(requestKey);
      const nextCursor =
        result.nextCursor &&
        !cycle.requestedCursors.has(result.nextCursor) &&
        !cycle.inFlight.has(result.nextCursor)
          ? result.nextCursor
          : undefined;
      setCatalog((current) => ({
        apps: append ? mergeApps(current.apps, result.apps) : [...result.apps],
        totalCount: result.totalCount,
        ...(nextCursor ? { nextCursor } : {}),
        error: false,
        loading: false,
      }));
    } catch {
      if (catalogRequestRef.current !== requestId || catalogRequestCycleRef.current !== cycle)
        return;
      setCatalog((current) => ({ ...current, error: true, loading: false }));
    } finally {
      cycle.inFlight.delete(requestKey);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    setLoadingSnapshot(true);
    setError(null);
    void (async () => {
      try {
        let next = await readBridge().pipedreamGetSnapshot();
        if (!active) return;
        // Publish the configured, locally cached state before the remote
        // reconciliation. A transient Pipedream outage must leave the normal
        // Ready surface (including its Refresh action) available for retry.
        publishSnapshot(next);
        if (next.connect.state === "ready") {
          next = await readBridge().pipedreamRefreshAccounts();
        }
        if (!active) return;
        publishSnapshot(next);
        if (next.connect.state === "ready") await loadCatalog(query.trim());
      } catch {
        if (!active) return;
        setError(t`Could not load integrations. Try again.`);
      } finally {
        if (active) setLoadingSnapshot(false);
      }
    })();
    return () => {
      active = false;
    };
    // Opening is the reconciliation boundary. Query changes are handled by the
    // explicit debounced/Enter search path below, not by remounting this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, loadCatalog, publishSnapshot, t]);

  useEffect(() => {
    if (!dialogRequested || !overlayReady) return;
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [dialogRequested, overlayReady]);

  useEffect(
    () => () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    },
    [],
  );

  const restoreSettingsSurface = useCallback((flowSource: ConnectAttempt["source"]) => {
    if (flowSource === "settings") {
      usePanelStore.getState().openSettingsSection("connections");
    }
  }, []);

  useEffect(() => {
    if (!attempt || attempt.status !== "waiting") return;
    const current = attempt;
    let stopped = false;
    let settled = false;
    let completionClaimed = false;
    let pollInFlight = false;

    const finishPrivateFlow = async () => {
      await readBridge()
        .pipedreamFinishConnect({ flowId: current.flowId })
        .catch(() => undefined);
    };

    const settle = (status: "timed-out" | "cancelled" | "failed") => {
      if (stopped || settled || completionClaimed) return;
      settled = true;
      setAttempt((candidate) =>
        candidate?.startedAt === current.startedAt ? { ...candidate, status } : candidate,
      );
      setError(null);
      restoreSettingsSurface(current.source);
      void finishPrivateFlow();
    };

    const reconcileTrustedSuccess = async () => {
      if (stopped || settled || completionClaimed) return;
      // The unguessable main-owned callback proves this Connect flow completed,
      // but Pipedream's current redirect carries no account identity. Claim the
      // terminal result before refreshing, and never infer authorization from
      // same-app account deltas in renderer state.
      completionClaimed = true;
      let refreshed: PipedreamSnapshot;
      try {
        refreshed = await readBridge().pipedreamRefreshAccounts();
      } catch {
        completionClaimed = false;
        if (Date.now() >= current.deadline) settle("timed-out");
        return;
      }
      if (stopped || settled) return;
      settled = true;
      await finishPrivateFlow();
      if (stopped) return;
      const hasReloadNotice = publishSnapshot(refreshed);
      setAttempt(null);
      setError(null);
      if (!hasReloadNotice) {
        setNotice({
          message: t`${current.app.name} connected. Turn on agent access for the account you want agents to use.`,
          tone: "success",
        });
      }
      restoreSettingsSurface(current.source);
    };

    const poll = async () => {
      if (stopped || settled || completionClaimed || pollInFlight) return;
      if (Date.now() >= current.deadline) {
        settle("timed-out");
        return;
      }
      pollInFlight = true;
      try {
        const flowStatus = await readBridge().pipedreamGetConnectFlowStatus({
          flowId: current.flowId,
        });
        if (stopped || settled) return;
        if (flowStatus.state === "failed") {
          settle("failed");
          return;
        }
        if (flowStatus.state === "open") {
          return;
        }
        if (flowStatus.state === "closed") {
          settle("cancelled");
          return;
        }
        await reconcileTrustedSuccess();
      } catch {
        // OAuth propagation and short network outages are retried only until
        // the bounded Connect expiry. Upstream details never reach renderer UI.
      } finally {
        pollInFlight = false;
      }
    };

    const interval = setInterval(() => void poll(), CONNECT_POLL_INTERVAL_MS);
    const expiry = setTimeout(
      () => settle("timed-out"),
      Math.max(0, current.deadline - Date.now()),
    );
    void poll();
    return () => {
      stopped = true;
      clearInterval(interval);
      clearTimeout(expiry);
    };
  }, [attempt, publishSnapshot, restoreSettingsSurface, t]);

  const refresh = async () => {
    if (busy) return;
    setBusy("refresh");
    setError(null);
    try {
      publishSnapshot(await readBridge().pipedreamRefreshAccounts());
    } catch {
      setError(t`Could not refresh connected accounts. Try again.`);
    } finally {
      setBusy(null);
    }
  };

  const executeSearch = (nextQuery = query.trim()) => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = null;
    void loadCatalog(nextQuery);
  };

  const changeSearch = (value: string) => {
    setQuery(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      searchTimerRef.current = null;
      void loadCatalog(value.trim());
    }, 300);
  };

  const startConnect = async (app: PipedreamAppSummary) => {
    if (busy || attempt?.status === "waiting") return;
    const flowSource = source ?? "composer";
    setBusy(`connect:${app.slug}`);
    setError(null);
    setNotice(null);
    try {
      const result = await readBridge().pipedreamBeginConnect({ appSlug: app.slug });
      const parsedExpiry = Date.parse(result.expiresAt);
      const startedAt = Date.now();
      const deadline = Math.min(
        Number.isFinite(parsedExpiry) ? parsedExpiry : startedAt + CONNECT_MAX_DURATION_MS,
        startedAt + CONNECT_MAX_DURATION_MS,
      );
      setAttempt({
        app,
        deadline,
        flowId: result.flowId,
        source: flowSource,
        startedAt,
        status: "waiting",
      });
      if (flowSource === "settings") usePanelStore.getState().closeSettings();
    } catch {
      setError(t`Could not start ${app.name} connection. Try again.`);
    } finally {
      setBusy(null);
    }
  };

  const cancelConnect = () => {
    const current = attempt;
    if (!current || current.status !== "waiting") return;
    setAttempt({ ...current, status: "cancelled" });
    setError(null);
    restoreSettingsSurface(current.source);
    void readBridge()
      .pipedreamCancelConnect({ flowId: current.flowId })
      .catch(() => undefined);
  };

  const chooseEnvironmentFile = async () => {
    if (busy) return;
    setBusy("environment");
    setError(null);
    try {
      const result = await readBridge().pipedreamChooseEnvFile({
        dialogTitle: t`Choose Pipedream environment file`,
      });
      if (!result) return;
      if (result.status === "invalid") {
        setError(
          result.reason === "too-large"
            ? t`The selected file is too large.`
            : result.reason === "unreadable"
              ? t`The selected file could not be read.`
              : t`The selected file does not contain Pipedream credentials.`,
        );
        return;
      }
      const hasReloadNotice = publishSnapshot(result.snapshot);
      if (!hasReloadNotice) {
        setNotice({
          message: t`Pipedream is ready. You can now connect integrations.`,
          tone: "success",
        });
      }
      if (result.snapshot.connect.state === "ready") await loadCatalog("");
    } catch {
      setError(t`Could not configure Pipedream. Try again.`);
    } finally {
      setBusy(null);
    }
  };

  const setAgentAccess = async (account: PipedreamAccountSummary, enabled: boolean) => {
    if (busy) return;
    setBusy(`access:${account.id}`);
    setError(null);
    try {
      const next = await readBridge().pipedreamSetAccountAgentAccess({
        accountId: account.id,
        enabled,
      });
      const hasReloadNotice = publishSnapshot(next, account.app.name);
      if (!hasReloadNotice) {
        setNotice({
          message: enabled
            ? t`${account.app.name} is available to agents.`
            : t`${account.app.name} agent access is off.`,
          tone: "success",
        });
      }
    } catch {
      setError(t`Could not update ${account.app.name} agent access. Try again.`);
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async (account: PipedreamAccountSummary) => {
    if (busy) return;
    setBusy(`disconnect:${account.id}`);
    setDisconnectCandidate(null);
    setError(null);
    try {
      const next = await readBridge().pipedreamDisconnectAccount({ accountId: account.id });
      const hasReloadNotice = publishSnapshot(next, account.app.name);
      if (!hasReloadNotice) {
        setNotice({ message: t`${account.app.name} disconnected.`, tone: "success" });
      }
    } catch {
      setError(t`Could not disconnect ${account.app.name}. Agent access has been revoked.`);
      try {
        publishSnapshot(await readBridge().pipedreamGetSnapshot());
      } catch {
        // Keep the last renderer-safe snapshot; the supervisor remains the
        // authorization boundary even when its follow-up snapshot is offline.
      }
    } finally {
      setBusy(null);
    }
  };

  const close = useCallback(() => {
    closeDialog();
    const previous = previousFocusRef.current;
    requestAnimationFrame(() => previous?.focus());
  }, [closeDialog]);

  useEffect(() => {
    if (!isOpen) return;
    return pushEscapeHandler(close);
  }, [close, isOpen]);

  if (!dialogRequested || !overlayReady) return null;

  const connect = snapshot?.connect;
  const accounts = connect?.state === "ready" ? connect.accounts : [];

  return (
    <div className="pointer-events-none fixed inset-0 z-[120] flex items-center justify-center p-3 sm:p-6">
      <section
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        className={`poracode-connections-dialog poracode-glass-chrome pointer-events-auto flex max-h-[min(760px,calc(100vh-32px))] flex-col overflow-hidden transition-[width] ${
          waiting ? "w-[min(420px,calc(100vw-24px))]" : "w-[min(760px,calc(100vw-24px))]"
        }`}
      >
        <header className="flex items-center gap-3 border-b border-[var(--hairline)] px-4 py-3.5 sm:px-5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-soft-foreground">
            <Blocks className="size-4.5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-base font-semibold text-foreground">
              <Trans>Integrations</Trans>
            </h2>
            <p className="truncate text-xs text-muted">
              {waiting ? (
                <Trans>Finish the secure connection in the embedded browser.</Trans>
              ) : (
                <Trans>Connect your tools and make them available to your agents.</Trans>
              )}
            </p>
          </div>
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label={t`Close integrations`}
            onPress={close}
          >
            <X className="size-4" />
          </Button>
        </header>

        {waiting && attempt ? (
          <div className="flex flex-col gap-4 p-5">
            <div className="flex items-center gap-3 rounded-2xl border border-accent/15 bg-accent/5 p-4">
              <PixelLoader size="sm" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">
                  <Trans>Connecting {attempt.app.name}</Trans>
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  <Trans>This card will update automatically when authorization finishes.</Trans>
                </p>
                <p className="mt-1.5 text-xs text-muted">
                  <Trans>
                    Your provider will show the requested permissions. You can choose which optional
                    permissions to approve; required permissions still apply.
                  </Trans>
                </p>
              </div>
              <ExternalLink className="size-4 shrink-0 text-accent" aria-hidden />
            </div>
            <Button
              variant="ghost"
              aria-label={t`Cancel ${attempt.app.name} connection`}
              onPress={cancelConnect}
            >
              <Trans>Cancel</Trans>
            </Button>
          </div>
        ) : (
          <div className="min-h-0 overflow-y-auto p-4 sm:p-5">
            {loadingSnapshot && snapshot === null ? (
              <div className="flex min-h-80 items-center justify-center gap-2 text-sm text-muted">
                <PixelLoader size="sm" />
                <Trans>Loading integrations…</Trans>
              </div>
            ) : connect?.state !== "ready" ? (
              <ConnectionsConfigurationState
                snapshot={snapshot}
                busy={busy === "environment"}
                onChoose={() => void chooseEnvironmentFile()}
              />
            ) : (
              <div className="grid min-h-0 gap-5 lg:grid-cols-[minmax(0,1fr)_260px]">
                <ConnectionsCatalogPanel
                  busy={busy}
                  catalog={catalog}
                  query={query}
                  searchRef={searchRef}
                  onConnect={(app) => void startConnect(app)}
                  onLoadMore={(cursor) => void loadCatalog(query.trim(), cursor)}
                  onQueryChange={changeSearch}
                  onSearch={() => executeSearch()}
                />
                <ConnectedAccountsPanel
                  accounts={accounts}
                  busy={busy}
                  onAgentAccessChange={(account, enabled) => void setAgentAccess(account, enabled)}
                  onRefresh={() => void refresh()}
                  onRequestDisconnect={setDisconnectCandidate}
                />
              </div>
            )}

            {attempt && attempt.status !== "waiting" ? (
              <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-warning/20 bg-warning/5 px-3 py-2">
                <p className="text-xs text-warning">
                  {attempt.status === "timed-out" ? (
                    <Trans>{attempt.app.name} connection timed out.</Trans>
                  ) : attempt.status === "failed" ? (
                    <Trans>{attempt.app.name} connection failed.</Trans>
                  ) : (
                    <Trans>{attempt.app.name} connection cancelled.</Trans>
                  )}
                </p>
                <Button
                  size="sm"
                  variant="tertiary"
                  aria-label={t`Retry ${attempt.app.name} connection`}
                  onPress={() => void startConnect(attempt.app)}
                >
                  <Trans>Retry</Trans>
                </Button>
              </div>
            ) : null}
            {notice ? (
              <p
                role="status"
                className={`mt-4 rounded-xl px-3 py-2 text-xs ${
                  notice.tone === "danger"
                    ? "bg-danger/8 text-danger"
                    : notice.tone === "warning"
                      ? "bg-warning/8 text-warning"
                      : "bg-success/8 text-success"
                }`}
              >
                {notice.message}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="mt-4 rounded-xl bg-danger/8 px-3 py-2 text-xs text-danger">
                {error}
              </p>
            ) : null}
          </div>
        )}

        {disconnectCandidate ? (
          <div className="border-t border-[var(--hairline)] bg-surface-secondary/70 px-4 py-3 sm:px-5">
            <div className="flex flex-wrap items-center gap-3">
              <p className="min-w-48 flex-1 text-xs text-foreground">
                <Trans>Disconnect {disconnectCandidate.name} and revoke agent access?</Trans>
              </p>
              <Button size="sm" variant="ghost" onPress={() => setDisconnectCandidate(null)}>
                <Trans>Cancel</Trans>
              </Button>
              <Button
                size="sm"
                variant="danger"
                aria-label={t`Confirm disconnect`}
                onPress={() => void disconnect(disconnectCandidate)}
              >
                <Trans>Disconnect</Trans>
              </Button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
