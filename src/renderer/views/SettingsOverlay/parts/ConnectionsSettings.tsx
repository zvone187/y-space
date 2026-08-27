import { useEffect, useState } from "react";
import { Button, Input, Modal } from "@heroui/react";
import { Trans, useLingui } from "@lingui/react/macro";
import { LogIn, LogOut, RefreshCw, Search, Unplug } from "lucide-react";
import { readBridge } from "@/renderer/bridge";
import { ToggleSwitch } from "@/renderer/components/common";
import { useMcpServerOauth } from "@/renderer/components/mcp/useMcpServerOauth";
import {
  useSharedSettings,
  waitForPendingSharedSettings,
} from "@/renderer/state/sharedSettingsStore";
import type {
  McpServer,
  PipedreamAccountSummary,
  PipedreamAppSummary,
  PipedreamListAppsResult,
  PipedreamSnapshot,
} from "@/shared/contracts";
import { SettingsPage } from "./SettingsForm";

const EMPTY_APPS: PipedreamListAppsResult = { apps: [], totalCount: 0 };
const PERSONAL_MCP_URL = "https://mcp.pipedream.net/v2";
const PERSONAL_MCP_ID = "pipedream-personal-mcp";

function personalMcpServer(): McpServer {
  return {
    id: PERSONAL_MCP_ID,
    name: "pd",
    description: "Personal Pipedream tools",
    enabled: true,
    timeoutMs: 30_000,
    transport: { type: "http", url: PERSONAL_MCP_URL, headers: {} },
  };
}

function withPersonalMcpServer(servers: readonly McpServer[]): {
  server: McpServer;
  servers: McpServer[];
} {
  const collision = servers.find(
    (server) =>
      server.name.toLowerCase() === "pd" &&
      !(
        (server.transport.type === "http" || server.transport.type === "sse") &&
        server.transport.url === PERSONAL_MCP_URL
      ),
  );
  if (collision) throw new Error("The MCP server name pd is already in use.");

  const canonical = personalMcpServer();
  const next = servers.filter((server) => {
    if (server.id === PERSONAL_MCP_ID) return false;
    return !(
      (server.transport.type === "http" || server.transport.type === "sse") &&
      server.transport.url === PERSONAL_MCP_URL
    );
  });
  return { server: canonical, servers: [...next, canonical] };
}

export function ConnectionsSettings() {
  const { t } = useLingui();
  const [snapshot, setSnapshot] = useState<PipedreamSnapshot | null>(null);
  const [apps, setApps] = useState<PipedreamListAppsResult>(EMPTY_APPS);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [disconnectCandidate, setDisconnectCandidate] = useState<PipedreamAccountSummary | null>(
    null,
  );
  const mcpServers = useSharedSettings((state) => state.mcpServers);
  const setMcpServers = useSharedSettings((state) => state.setMcpServers);
  const personalOauth = useMcpServerOauth();

  useEffect(() => {
    let active = true;
    void readBridge()
      .pipedreamGetSnapshot()
      .then((next) => {
        if (active) setSnapshot(next);
      })
      .catch(() => {
        if (active) setError(t`Could not load connections.`);
      });
    return () => {
      active = false;
    };
  }, [t]);

  const run = async (key: string, operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await operation();
    } catch {
      setError(t`The Pipedream request failed. Check your connection and configuration.`);
    } finally {
      setBusy(null);
    }
  };

  const searchApps = () =>
    run("search", async () => {
      setApps(
        await readBridge().pipedreamListApps({
          ...(query.trim() ? { query: query.trim() } : {}),
          limit: 20,
        }),
      );
    });

  const connectApp = (app: PipedreamAppSummary) =>
    run(`connect:${app.slug}`, async () => {
      await readBridge().pipedreamBeginConnect({ appSlug: app.slug });
      setNotice(t`Finish connecting in the new embedded browser tab, then refresh accounts.`);
    });

  const signInPersonalMcp = () =>
    run("personal-mcp", async () => {
      const managed = withPersonalMcpServer(mcpServers);
      setMcpServers(managed.servers);
      await waitForPendingSharedSettings();
      const authenticated = await personalOauth.authenticate(managed.server);
      if (!authenticated) {
        setError(t`Personal MCP sign-in did not complete.`);
        return;
      }
      setSnapshot(await readBridge().pipedreamGetSnapshot());
    });

  const signOutPersonalMcp = () =>
    run("personal-mcp", async () => {
      const managed = withPersonalMcpServer(mcpServers);
      await personalOauth.signOut(managed.server);
      setSnapshot(await readBridge().pipedreamGetSnapshot());
    });

  const connect = snapshot?.connect;
  return (
    <SettingsPage
      title={t`Connections`}
      description={t`Use Personal MCP for your own Pipedream tools or BYO Connect to grant selected app accounts to local agents.`}
      bodyClassName="space-y-5"
    >
      <section className="rounded-xl border border-[var(--hairline)] p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              <Trans>Personal MCP</Trans>
            </h2>
            <p className="mt-1 text-xs text-muted">
              <Trans>End-user Pipedream MCP server named pd.</Trans>
            </p>
          </div>
          <StatusBadge
            label={
              snapshot?.personalMcp.authenticated
                ? t`Authenticated`
                : snapshot?.personalMcp.enabled
                  ? t`Authentication required`
                  : t`Not configured`
            }
            active={snapshot?.personalMcp.authenticated === true}
          />
        </div>
        <div className="mt-4 flex justify-end">
          {snapshot?.personalMcp.authenticated ? (
            <Button
              variant="ghost"
              size="sm"
              isDisabled={busy !== null || personalOauth.busyServerIds.has(PERSONAL_MCP_ID)}
              onPress={() => void signOutPersonalMcp()}
            >
              <LogOut className="size-3.5" />
              <Trans>Sign out</Trans>
            </Button>
          ) : (
            <Button
              variant="tertiary"
              size="sm"
              aria-label={snapshot?.personalMcp.enabled ? t`Sign in` : t`Add and sign in`}
              isDisabled={
                snapshot === null ||
                busy !== null ||
                personalOauth.busyServerIds.has(PERSONAL_MCP_ID)
              }
              onPress={() => void signInPersonalMcp()}
            >
              <LogIn className="size-3.5" />
              {snapshot?.personalMcp.enabled ? (
                <Trans>Sign in</Trans>
              ) : (
                <Trans>Add and sign in</Trans>
              )}
            </Button>
          )}
        </div>
      </section>

      <section className="space-y-4 rounded-xl border border-[var(--hairline)] p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              <Trans>BYO Connect</Trans>
            </h2>
            <p className="mt-1 text-xs text-muted">
              <Trans>
                Pipedream-managed OAuth accounts available through authenticated local MCP relays.
              </Trans>
            </p>
          </div>
          <StatusBadge
            label={
              connect?.state === "ready"
                ? t`Ready`
                : connect?.state === "partial"
                  ? t`Incomplete setup`
                  : connect?.state === "error"
                    ? t`Needs attention`
                    : t`Not configured`
            }
            active={connect?.state === "ready"}
          />
        </div>

        {connect?.state === "partial" ? (
          <p className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
            <Trans>Missing configuration:</Trans> {connect.missingKeys.join(", ")}
          </p>
        ) : null}
        {connect?.state === "error" ? (
          <p className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
            <Trans>Pipedream Connect could not be initialized.</Trans>
          </p>
        ) : null}

        {connect?.state === "ready" ? (
          <>
            <div className="flex items-center gap-2 text-xs text-muted">
              <span>{connect.projectName}</span>
              <span aria-hidden="true">·</span>
              <span>{connect.environment}</span>
              <span aria-hidden="true">·</span>
              <span>{connect.projectIdHint}</span>
            </div>

            <div className="flex items-center gap-2">
              <Input
                aria-label={t`Search apps`}
                value={query}
                placeholder={t`Search Pipedream apps`}
                onChange={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void searchApps();
                }}
              />
              <Button
                variant="tertiary"
                size="sm"
                isDisabled={busy !== null}
                onPress={() => void searchApps()}
              >
                <Search className="size-3.5" />
                <Trans>Search</Trans>
              </Button>
            </div>

            {apps.apps.length > 0 ? (
              <div className="divide-y divide-[var(--hairline)] rounded-lg border border-[var(--hairline)]">
                {apps.apps.map((app) => (
                  <div key={app.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="truncate text-sm text-foreground">{app.name}</span>
                    <Button
                      variant="tertiary"
                      size="sm"
                      aria-label={t`Connect ${app.name}`}
                      isDisabled={busy !== null}
                      onPress={() => void connectApp(app)}
                    >
                      <Trans>Connect</Trans>
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="flex items-center justify-between gap-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
                <Trans>Connected accounts</Trans>
              </h3>
              <Button
                variant="ghost"
                size="sm"
                aria-label={t`Refresh accounts`}
                isDisabled={busy !== null}
                onPress={() =>
                  void run("refresh", async () => {
                    setSnapshot(await readBridge().pipedreamRefreshAccounts());
                  })
                }
              >
                <RefreshCw className={`size-3.5 ${busy === "refresh" ? "animate-spin" : ""}`} />
                <Trans>Refresh</Trans>
              </Button>
            </div>

            {connect.accounts.length === 0 ? (
              <p className="text-xs text-muted">
                <Trans>No connected accounts yet.</Trans>
              </p>
            ) : (
              <div className="divide-y divide-[var(--hairline)] rounded-lg border border-[var(--hairline)]">
                {connect.accounts.map((account) => (
                  <div key={account.id} className="flex items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-foreground">{account.name}</p>
                      <p className="text-xs text-muted">
                        {account.app.name} · {account.healthy ? t`Healthy` : t`Needs attention`}
                      </p>
                    </div>
                    <ToggleSwitch
                      aria-label={t`Allow agents to use ${account.name}`}
                      isSelected={account.agentAccess}
                      isDisabled={busy !== null || !account.healthy}
                      onChange={(enabled) =>
                        void run(`access:${account.id}`, async () => {
                          setSnapshot(
                            await readBridge().pipedreamSetAccountAgentAccess({
                              accountId: account.id,
                              enabled,
                            }),
                          );
                        })
                      }
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      isIconOnly
                      aria-label={t`Disconnect ${account.name}`}
                      isDisabled={busy !== null}
                      onPress={() => setDisconnectCandidate(account)}
                    >
                      <Unplug className="size-3.5 text-danger" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : null}
      </section>

      {notice ? <p className="text-xs text-success">{notice}</p> : null}
      {error ? <p className="text-xs text-danger">{error}</p> : null}

      <Modal.Backdrop
        isOpen={disconnectCandidate !== null}
        onOpenChange={(open) => !open && setDisconnectCandidate(null)}
      >
        <Modal.Container placement="center" size="sm">
          <Modal.Dialog className="sm:max-w-md">
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>
                <Trans>Disconnect account?</Trans>
              </Modal.Heading>
            </Modal.Header>
            <Modal.Body className="p-4 text-sm text-muted">
              <Trans>
                This removes the Pipedream account and immediately revokes agent access through Y
                Space.
              </Trans>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="ghost" onPress={() => setDisconnectCandidate(null)}>
                <Trans>Cancel</Trans>
              </Button>
              <Button
                variant="danger"
                aria-label={t`Confirm disconnect`}
                isDisabled={busy !== null}
                onPress={() => {
                  const account = disconnectCandidate;
                  if (!account) return;
                  setDisconnectCandidate(null);
                  void run(`disconnect:${account.id}`, async () => {
                    setSnapshot(
                      await readBridge().pipedreamDisconnectAccount({ accountId: account.id }),
                    );
                  });
                }}
              >
                <Unplug className="size-3.5" />
                <Trans>Disconnect</Trans>
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </SettingsPage>
  );
}

function StatusBadge(props: { label: string; active: boolean }) {
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-medium ${
        props.active ? "bg-success/10 text-success" : "bg-default-100 text-muted"
      }`}
    >
      {props.label}
    </span>
  );
}
