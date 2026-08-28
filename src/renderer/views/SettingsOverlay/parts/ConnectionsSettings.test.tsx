import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithI18n as render } from "@/renderer/testUtils/i18n";
import type {
  PipedreamBeginConnectPayload,
  PipedreamBeginConnectResult,
  PipedreamChooseEnvFilePayload,
  PipedreamDisconnectAccountPayload,
  PipedreamEnvFileImportResult,
  PipedreamListAppsPayload,
  PipedreamListAppsResult,
  PipedreamSetAccountAgentAccessPayload,
  PipedreamSnapshot,
  McpServer,
} from "@/shared/contracts";

const bridgeMock = vi.hoisted(() => ({
  pipedreamGetSnapshot: vi.fn<() => Promise<PipedreamSnapshot>>(),
  pipedreamListApps:
    vi.fn<(payload: PipedreamListAppsPayload) => Promise<PipedreamListAppsResult>>(),
  pipedreamRefreshAccounts: vi.fn<() => Promise<PipedreamSnapshot>>(),
  pipedreamBeginConnect:
    vi.fn<(payload: PipedreamBeginConnectPayload) => Promise<PipedreamBeginConnectResult>>(),
  pipedreamChooseEnvFile:
    vi.fn<
      (payload: PipedreamChooseEnvFilePayload) => Promise<PipedreamEnvFileImportResult | null>
    >(),
  pipedreamClearEnvFile: vi.fn<() => Promise<PipedreamSnapshot>>(),
  pipedreamDisconnectAccount:
    vi.fn<(payload: PipedreamDisconnectAccountPayload) => Promise<PipedreamSnapshot>>(),
  pipedreamSetAccountAgentAccess:
    vi.fn<(payload: PipedreamSetAccountAgentAccessPayload) => Promise<PipedreamSnapshot>>(),
}));
const settingsMock = vi.hoisted(() => ({
  mcpServers: [] as McpServer[],
  setMcpServers: vi.fn<(servers: McpServer[]) => void>(),
}));
const authenticatePersonalMcp = vi.hoisted(() => vi.fn<(server: McpServer) => Promise<boolean>>());
const signOutPersonalMcp = vi.hoisted(() => vi.fn<(server: McpServer) => Promise<void>>());

vi.mock("@/renderer/bridge", () => ({ readBridge: () => bridgeMock }));
vi.mock("@/renderer/state/sharedSettingsStore", () => ({
  useSharedSettings: (selector: (state: typeof settingsMock) => unknown) => selector(settingsMock),
  waitForPendingSharedSettings: () => Promise.resolve(),
}));
vi.mock("@/renderer/components/mcp/useMcpServerOauth", () => ({
  useMcpServerOauth: () => ({
    authenticatedUrls: new Set<string>(),
    busyServerIds: new Set<string>(),
    authenticate: authenticatePersonalMcp,
    signOut: signOutPersonalMcp,
  }),
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
};

describe("ConnectionsSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bridgeMock.pipedreamGetSnapshot.mockResolvedValue(SNAPSHOT);
    bridgeMock.pipedreamListApps.mockResolvedValue({
      apps: [{ id: "app_Github123", slug: "github", name: "GitHub" }],
      totalCount: 1,
    });
    bridgeMock.pipedreamRefreshAccounts.mockResolvedValue(SNAPSHOT);
    bridgeMock.pipedreamBeginConnect.mockResolvedValue({
      opened: true,
      expiresAt: "2026-08-27T12:10:00.000Z",
    });
    bridgeMock.pipedreamChooseEnvFile.mockResolvedValue({
      status: "configured",
      snapshot: SNAPSHOT,
    });
    bridgeMock.pipedreamClearEnvFile.mockResolvedValue({
      personalMcp: { enabled: true, authenticated: true, serverName: "pd" },
      connect: { state: "absent" },
    });
    bridgeMock.pipedreamSetAccountAgentAccess.mockResolvedValue({
      ...SNAPSHOT,
      connect: {
        ...SNAPSHOT.connect,
        accounts: [{ ...SNAPSHOT.connect.accounts[0]!, agentAccess: true }],
      },
    });
    bridgeMock.pipedreamDisconnectAccount.mockResolvedValue({
      ...SNAPSHOT,
      connect: { ...SNAPSHOT.connect, accounts: [] },
    });
    settingsMock.mcpServers = [];
    settingsMock.setMcpServers.mockImplementation((servers) => {
      settingsMock.mcpServers = servers;
    });
    authenticatePersonalMcp.mockResolvedValue(true);
    signOutPersonalMcp.mockResolvedValue(undefined);
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
    expect(authenticatePersonalMcp).toHaveBeenCalledWith(personal);
  });

  it("shows Personal MCP and BYO Connect status without rendering secret material", async () => {
    render(<ConnectionsSettings />);
    expect(await screen.findByText("Personal MCP")).toBeInTheDocument();
    expect(screen.getByText("Authenticated")).toBeInTheDocument();
    expect(screen.getByText("Y Space Slack")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Credentials are managed by the Y Space environment and never exposed to agents.",
      ),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(
      /client[_-]?secret|access[_-]?token|connect[_-]?token/i,
    );
  });

  it("chooses a Pipedream env file through main and applies the redacted snapshot", async () => {
    const notConfigured: PipedreamSnapshot = {
      personalMcp: { enabled: false, authenticated: false, serverName: "pd" },
      connect: { state: "absent" },
    };
    bridgeMock.pipedreamGetSnapshot.mockResolvedValue(notConfigured);
    render(<ConnectionsSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Choose environment file" }));

    await waitFor(() =>
      expect(bridgeMock.pipedreamChooseEnvFile).toHaveBeenCalledExactlyOnceWith({
        dialogTitle: "Choose Pipedream environment file",
      }),
    );
    expect(await screen.findByText("Pipedream Connect")).toBeInTheDocument();
    expect(
      screen.getByText("Pipedream credentials loaded from the selected file."),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(
      /client[_-]?secret|envFilePath|\/private\/config/i,
    );
  });

  it("surfaces a safe validation error for a file without Pipedream values", async () => {
    bridgeMock.pipedreamChooseEnvFile.mockResolvedValue({
      status: "invalid",
      reason: "no-supported-values",
    });
    render(<ConnectionsSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Choose environment file" }));

    expect(
      await screen.findByText("The selected file does not contain Pipedream credentials."),
    ).toBeInTheDocument();
  });

  it("forgets persisted env-file metadata and applies the fallback snapshot", async () => {
    render(<ConnectionsSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Forget environment file" }));

    await waitFor(() => expect(bridgeMock.pipedreamClearEnvFile).toHaveBeenCalledOnce());
    expect(await screen.findByText("Not configured")).toBeInTheDocument();
    expect(screen.getByText("Saved environment file forgotten.")).toBeInTheDocument();
  });

  it("connects an app, toggles agent access, refreshes, and disconnects through safe bridge calls", async () => {
    render(<ConnectionsSettings />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Search apps" }), {
      target: { value: "github" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("GitHub")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect GitHub" }));
    await waitFor(() =>
      expect(bridgeMock.pipedreamBeginConnect).toHaveBeenCalledWith({ appSlug: "github" }),
    );

    fireEvent.click(screen.getByRole("switch", { name: "Allow agents to use Y Space Slack" }));
    await waitFor(() =>
      expect(bridgeMock.pipedreamSetAccountAgentAccess).toHaveBeenCalledWith({
        accountId: "apn_Account123",
        enabled: true,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh accounts" }));
    await waitFor(() => expect(bridgeMock.pipedreamRefreshAccounts).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Y Space Slack" }));
    expect(bridgeMock.pipedreamDisconnectAccount).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Confirm disconnect" }));
    await waitFor(() =>
      expect(bridgeMock.pipedreamDisconnectAccount).toHaveBeenCalledWith({
        accountId: "apn_Account123",
      }),
    );
  });
});
