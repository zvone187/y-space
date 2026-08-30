import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithI18n as render } from "@/renderer/testUtils/i18n";
import { useConnectionsDialogStore } from "@/renderer/state/connectionsDialogStore";
import type { McpServer, PipedreamSnapshot } from "@/shared/contracts";
import type { PoracodeBridge } from "@/shared/ipc";

const bridgeMock = vi.hoisted(() => ({
  pipedreamGetSnapshot: vi.fn<() => Promise<PipedreamSnapshot>>(),
  pipedreamBeginPersonalMcpOauth: vi.fn<PoracodeBridge["pipedreamBeginPersonalMcpOauth"]>(),
  pipedreamGetPersonalMcpOauthFlowStatus:
    vi.fn<PoracodeBridge["pipedreamGetPersonalMcpOauthFlowStatus"]>(),
  pipedreamCancelPersonalMcpOauth: vi.fn<PoracodeBridge["pipedreamCancelPersonalMcpOauth"]>(),
  pipedreamClearPersonalMcpOauth: vi.fn<PoracodeBridge["pipedreamClearPersonalMcpOauth"]>(),
}));
const settingsMock = vi.hoisted(() => ({
  mcpServers: [] as McpServer[],
  setMcpServers: vi.fn<(servers: McpServer[]) => void>(),
}));
vi.mock("@/renderer/bridge", () => ({ readBridge: () => bridgeMock }));
vi.mock("@/renderer/state/sharedSettingsStore", () => ({
  useSharedSettings: (selector: (state: typeof settingsMock) => unknown) => selector(settingsMock),
  waitForPendingSharedSettings: () => Promise.resolve(),
}));
import { ConnectionsSettings } from "./ConnectionsSettings";

const SNAPSHOT = {
  personalMcp: { enabled: true, authenticated: true, serverName: "pd" as const },
  connect: {
    state: "ready" as const,
    credentialSource: "environment" as const,
    environment: "development" as const,
    projectIdHint: "proj_…0123",
    projectName: "Pipedream Connect",
    accounts: [
      {
        id: "apn_Account123",
        name: "Y Space Slack",
        healthy: true,
        connectedAt: "2026-08-27T12:00:00.000Z",
        agentAccess: false,
        app: { id: "app_Slack123", slug: "slack", name: "Slack" },
      },
    ],
  },
} satisfies PipedreamSnapshot;

describe("ConnectionsSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useConnectionsDialogStore.setState({ isOpen: false, source: null, revision: 0 });
    bridgeMock.pipedreamGetSnapshot.mockResolvedValue(SNAPSHOT);
    bridgeMock.pipedreamBeginPersonalMcpOauth.mockResolvedValue({ state: "authorized" });
    bridgeMock.pipedreamCancelPersonalMcpOauth.mockResolvedValue(undefined);
    bridgeMock.pipedreamClearPersonalMcpOauth.mockResolvedValue(undefined);
    settingsMock.mcpServers = [];
    settingsMock.setMcpServers.mockImplementation((servers) => {
      settingsMock.mcpServers = servers;
    });
  });

  it("adds, enables, and authenticates the managed Personal MCP server in one embedded flow", async () => {
    const notConfigured: PipedreamSnapshot = {
      personalMcp: { enabled: false, authenticated: false, serverName: "pd" },
      connect: { state: "absent" },
    };
    bridgeMock.pipedreamGetSnapshot.mockResolvedValueOnce(notConfigured).mockResolvedValue({
      ...notConfigured,
      personalMcp: { enabled: true, authenticated: true, serverName: "pd" },
    });

    render(<ConnectionsSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Add and sign in" }));

    await waitFor(() => expect(settingsMock.setMcpServers).toHaveBeenCalledOnce());
    const personal = settingsMock.setMcpServers.mock.calls[0]?.[0]?.[0];
    expect(personal).toMatchObject({
      name: "pd",
      enabled: true,
      transport: { type: "http", url: "https://mcp.pipedream.net/v2" },
    });
    expect(bridgeMock.pipedreamBeginPersonalMcpOauth).toHaveBeenCalledOnce();
  });

  it("routes managed Personal Pipedream sign-in through the URL-free main coordinator", async () => {
    const notConfigured: PipedreamSnapshot = {
      personalMcp: { enabled: false, authenticated: false, serverName: "pd" },
      connect: { state: "absent" },
    };
    bridgeMock.pipedreamGetSnapshot.mockResolvedValueOnce(notConfigured).mockResolvedValue({
      ...notConfigured,
      personalMcp: { enabled: true, authenticated: true, serverName: "pd" },
    });

    render(<ConnectionsSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Add and sign in" }));

    await waitFor(() => expect(bridgeMock.pipedreamBeginPersonalMcpOauth).toHaveBeenCalledOnce());
    expect(JSON.stringify(bridgeMock.pipedreamBeginPersonalMcpOauth.mock.results)).not.toMatch(
      /authorizationUrl|state=|code_challenge/i,
    );
  });

  it("preserves Personal MCP sign-out behavior", async () => {
    render(<ConnectionsSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(bridgeMock.pipedreamClearPersonalMcpOauth).toHaveBeenCalledOnce());
  });

  it("shows compact Personal MCP and Y Space integration summaries without duplicate controls or secrets", async () => {
    render(<ConnectionsSettings />);

    expect(await screen.findByText("Personal Pipedream")).toBeInTheDocument();
    expect(screen.getByText("Authenticated")).toBeInTheDocument();
    expect(screen.getByText("Y Space integrations")).toBeInTheDocument();
    expect(screen.getByText("1 connected · 0 available to agents")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manage integrations" })).toBeInTheDocument();
    expect(screen.queryByText("Y Space Slack")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Search apps" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Disconnect/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Choose environment file" }),
    ).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(
      /client[_-]?secret|access[_-]?token|connect[_-]?token|apn_Account123/i,
    );
  });

  it("opens the shared Integrations dialog from Settings", async () => {
    render(<ConnectionsSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Manage integrations" }));

    expect(useConnectionsDialogStore.getState()).toMatchObject({
      isOpen: true,
      source: "settings",
    });
  });

  it("refetches its compact summary when the shared dialog revision changes", async () => {
    const updated = {
      ...SNAPSHOT,
      connect: {
        ...SNAPSHOT.connect,
        accounts: [
          { ...SNAPSHOT.connect.accounts[0]!, agentAccess: true },
          {
            id: "apn_Gmail456",
            name: "Work Gmail",
            healthy: true,
            connectedAt: "2026-08-28T12:00:00.000Z",
            agentAccess: false,
            app: { id: "app_Gmail456", slug: "gmail", name: "Gmail" },
          },
        ],
      },
    } satisfies PipedreamSnapshot;
    bridgeMock.pipedreamGetSnapshot.mockResolvedValueOnce(SNAPSHOT).mockResolvedValue(updated);
    render(<ConnectionsSettings />);
    expect(await screen.findByText("1 connected · 0 available to agents")).toBeInTheDocument();

    act(() => useConnectionsDialogStore.getState().bumpRevision());

    expect(await screen.findByText("2 connected · 1 available to agents")).toBeInTheDocument();
    expect(bridgeMock.pipedreamGetSnapshot).toHaveBeenCalledTimes(2);
  });
});
