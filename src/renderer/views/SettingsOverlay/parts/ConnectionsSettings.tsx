import { useEffect, useState } from "react";
import { Button } from "@heroui/react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Blocks, LogIn, LogOut } from "lucide-react";
import { readBridge } from "@/renderer/bridge";
import { useConnectionsDialogStore } from "@/renderer/state/connectionsDialogStore";
import {
  useSharedSettings,
  waitForPendingSharedSettings,
} from "@/renderer/state/sharedSettingsStore";
import {
  PIPEDREAM_PERSONAL_MCP_SERVER_ID,
  PIPEDREAM_PERSONAL_MCP_SERVER_NAME,
  PIPEDREAM_PERSONAL_MCP_URL,
  type McpServer,
  type PipedreamSnapshot,
} from "@/shared/contracts";
import { SettingsPage } from "./SettingsForm";

const PERSONAL_MCP_OAUTH_POLL_MS = 250;
const PERSONAL_MCP_OAUTH_MAX_MS = 5 * 60_000;

function personalMcpServer(description: string): McpServer {
  return {
    id: PIPEDREAM_PERSONAL_MCP_SERVER_ID,
    name: PIPEDREAM_PERSONAL_MCP_SERVER_NAME,
    description,
    enabled: true,
    timeoutMs: 30_000,
    transport: { type: "http", url: PIPEDREAM_PERSONAL_MCP_URL, headers: {} },
  };
}

function withPersonalMcpServer(
  servers: readonly McpServer[],
  description: string,
): {
  server: McpServer;
  servers: McpServer[];
} {
  const collision = servers.find(
    (server) =>
      server.name.toLowerCase() === "pd" &&
      !(
        (server.transport.type === "http" || server.transport.type === "sse") &&
        server.transport.url === PIPEDREAM_PERSONAL_MCP_URL
      ),
  );
  if (collision) throw new Error("The MCP server name pd is already in use.");

  const canonical = personalMcpServer(description);
  const next = servers.filter((server) => {
    if (server.id === PIPEDREAM_PERSONAL_MCP_SERVER_ID) return false;
    return !(
      (server.transport.type === "http" || server.transport.type === "sse") &&
      server.transport.url === PIPEDREAM_PERSONAL_MCP_URL
    );
  });
  return { server: canonical, servers: [...next, canonical] };
}

export function ConnectionsSettings() {
  const { t } = useLingui();
  const revision = useConnectionsDialogStore((state) => state.revision);
  const [snapshot, setSnapshot] = useState<PipedreamSnapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mcpServers = useSharedSettings((state) => state.mcpServers);
  const setMcpServers = useSharedSettings((state) => state.setMcpServers);

  useEffect(() => {
    let active = true;
    void readBridge()
      .pipedreamGetSnapshot()
      .then((next) => {
        if (active) {
          setSnapshot(next);
          setError(null);
        }
      })
      .catch(() => {
        if (active) setError(t`Could not load connections.`);
      });
    return () => {
      active = false;
    };
  }, [revision, t]);

  const run = async (key: string, operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      await operation();
    } catch {
      setError(t`The Pipedream request failed. Check your connection and configuration.`);
    } finally {
      setBusy(null);
    }
  };

  const signInPersonalMcp = () =>
    run("personal-mcp", async () => {
      const managed = withPersonalMcpServer(mcpServers, t`Personal Pipedream tools`);
      setMcpServers(managed.servers);
      await waitForPendingSharedSettings();
      const authenticated = await authenticatePersonalPipedream();
      if (!authenticated) {
        setError(t`Personal MCP sign-in did not complete.`);
        return;
      }
      setSnapshot(await readBridge().pipedreamGetSnapshot());
    });

  const signOutPersonalMcp = () =>
    run("personal-mcp", async () => {
      await readBridge().pipedreamClearPersonalMcpOauth();
      setSnapshot(await readBridge().pipedreamGetSnapshot());
    });

  const connect = snapshot?.connect;
  const connectedCount = connect?.state === "ready" ? connect.accounts.length : 0;
  const agentCount =
    connect?.state === "ready"
      ? connect.accounts.filter((account) => account.healthy && account.agentAccess).length
      : 0;
  const integrationSummary =
    connect?.state === "ready"
      ? connectedCount === 0
        ? t`No integrations connected yet.`
        : t`${connectedCount} connected · ${agentCount} available to agents`
      : connect?.state === "partial"
        ? t`Finish setup to connect your tools.`
        : connect?.state === "error"
          ? t`Integrations need attention.`
          : t`Connect your first tool when you are ready.`;

  return (
    <SettingsPage
      title={t`Connections`}
      description={t`Connect your tools to Y Space and choose what agents can use.`}
      bodyClassName="space-y-4"
    >
      <section className="rounded-xl border border-[var(--hairline)] p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              <Trans>Personal Pipedream</Trans>
            </h2>
            <p className="mt-1 text-xs text-muted">
              <Trans>Use tools already connected to your Pipedream account.</Trans>
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
        <div className="mt-3 flex justify-end">
          {snapshot?.personalMcp.authenticated ? (
            <Button
              variant="ghost"
              size="sm"
              isDisabled={busy !== null}
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
              isDisabled={snapshot === null || busy !== null}
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

      <section className="rounded-xl border border-[var(--hairline)] p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent-text">
              <Blocks className="size-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-foreground">
                <Trans>Y Space integrations</Trans>
              </h2>
              <p className="mt-1 text-xs text-muted">
                <Trans>Connect apps once, then decide which ones agents can use.</Trans>
              </p>
            </div>
          </div>
          <StatusBadge
            label={
              connect?.state === "ready"
                ? t`Ready`
                : connect?.state === "partial"
                  ? t`Setup needed`
                  : connect?.state === "error"
                    ? t`Needs attention`
                    : t`Not configured`
            }
            active={connect?.state === "ready"}
          />
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted">{integrationSummary}</p>
          <Button
            variant="tertiary"
            size="sm"
            onPress={() => useConnectionsDialogStore.getState().openDialog("settings")}
          >
            <Blocks className="size-3.5" aria-hidden />
            <Trans>Manage integrations</Trans>
          </Button>
        </div>
      </section>

      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </SettingsPage>
  );
}

async function authenticatePersonalPipedream(): Promise<boolean> {
  const bridge = readBridge();
  const begin = await bridge.pipedreamBeginPersonalMcpOauth();
  if (begin.state === "authorized") return true;
  if (begin.state !== "open") return false;

  const deadline = Date.now() + PERSONAL_MCP_OAUTH_MAX_MS;
  try {
    while (Date.now() < deadline) {
      const status = await bridge.pipedreamGetPersonalMcpOauthFlowStatus({
        flowId: begin.flowId,
      });
      if (status.state === "authorized") return true;
      if (status.state !== "open") return false;
      await new Promise<void>((resolve) => setTimeout(resolve, PERSONAL_MCP_OAUTH_POLL_MS));
    }
    return false;
  } finally {
    await bridge.pipedreamCancelPersonalMcpOauth({ flowId: begin.flowId }).catch(() => undefined);
  }
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
