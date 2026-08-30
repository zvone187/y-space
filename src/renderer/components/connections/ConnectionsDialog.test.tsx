import { useEffect } from "react";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pushEscapeHandler } from "@/renderer/components/layout/overlayEscapeStack";
import { renderWithI18n as render } from "@/renderer/testUtils/i18n";
import type {
  PipedreamAccountSummary,
  PipedreamBeginConnectPayload,
  PipedreamBeginConnectResult,
  PipedreamChooseEnvFilePayload,
  PipedreamDisconnectAccountPayload,
  PipedreamEnvFileImportResult,
  PipedreamListAppsPayload,
  PipedreamListAppsResult,
  PipedreamSetAccountAgentAccessPayload,
  PipedreamSnapshot,
} from "@/shared/contracts";

const bridgeMock = vi.hoisted(() => ({
  pipedreamGetSnapshot: vi.fn<() => Promise<PipedreamSnapshot>>(),
  pipedreamListApps:
    vi.fn<(payload: PipedreamListAppsPayload) => Promise<PipedreamListAppsResult>>(),
  pipedreamRefreshAccounts: vi.fn<() => Promise<PipedreamSnapshot>>(),
  pipedreamBeginConnect:
    vi.fn<(payload: PipedreamBeginConnectPayload) => Promise<PipedreamBeginConnectResult>>(),
  pipedreamGetConnectFlowStatus:
    vi.fn<
      (payload: {
        flowId: string;
      }) => Promise<{ state: "open" | "closed" | "succeeded" | "failed" }>
    >(),
  pipedreamFinishConnect: vi.fn<(payload: { flowId: string }) => Promise<void>>(),
  pipedreamCancelConnect: vi.fn<(payload: { flowId: string }) => Promise<void>>(),
  pipedreamChooseEnvFile:
    vi.fn<
      (payload: PipedreamChooseEnvFilePayload) => Promise<PipedreamEnvFileImportResult | null>
    >(),
  pipedreamDisconnectAccount:
    vi.fn<(payload: PipedreamDisconnectAccountPayload) => Promise<PipedreamSnapshot>>(),
  pipedreamSetAccountAgentAccess:
    vi.fn<(payload: PipedreamSetAccountAgentAccessPayload) => Promise<PipedreamSnapshot>>(),
}));

vi.mock("@/renderer/bridge", () => ({ readBridge: () => bridgeMock }));

import { ConnectionsDialogHost } from "./ConnectionsDialog";
import { useBrowserPanelStore } from "@/renderer/state/browserPanelStore";
import { useConnectionsDialogStore } from "@/renderer/state/connectionsDialogStore";
import { registerSensitiveNativeViewPresenter } from "@/renderer/state/sensitiveNativeViewObstruction";

const GMAIL_APP = {
  id: "app_Gmail123",
  slug: "gmail",
  name: "Gmail",
  iconUrl: "https://assets.pipedream.net/gmail.png",
} as const;
const SLACK_APP = {
  id: "app_Slack123",
  slug: "slack",
  name: "Slack",
  iconUrl: "https://assets.pipedream.net/slack.png",
} as const;
const NOTION_APP = {
  id: "app_Notion123",
  slug: "notion",
  name: "Notion",
  iconUrl: "https://assets.pipedream.net/notion.png",
} as const;

const SLACK_ACCOUNT: PipedreamAccountSummary = {
  id: "apn_SlackAccount123",
  name: "Workspace Slack",
  healthy: true,
  connectedAt: "2026-08-28T18:00:00.000Z",
  agentAccess: true,
  app: SLACK_APP,
};
const GMAIL_ACCOUNT: PipedreamAccountSummary = {
  id: "apn_GmailAccount123",
  name: "Work Gmail",
  healthy: true,
  connectedAt: "2026-08-28T19:00:00.000Z",
  agentAccess: false,
  app: GMAIL_APP,
};

function readySnapshot(accounts: readonly PipedreamAccountSummary[] = []): PipedreamSnapshot {
  return {
    personalMcp: { enabled: false, authenticated: false, serverName: "pd" },
    connect: {
      state: "ready",
      credentialSource: "environment",
      environment: "development",
      projectIdHint: "proj_…0123",
      projectName: "Y Space Connect",
      accounts: [...accounts],
    },
  };
}

function readySnapshotWithAgentReload(
  state: "applied" | "restart-required" | "failed-pending",
  accounts: readonly PipedreamAccountSummary[] = [],
): PipedreamSnapshot {
  return {
    ...readySnapshot(accounts),
    agentReload: { state },
  };
}

function appsPage(
  apps: PipedreamListAppsResult["apps"],
  options: { nextCursor?: string; totalCount?: number } = {},
): PipedreamListAppsResult {
  return {
    apps: [...apps],
    totalCount: options.totalCount ?? apps.length,
    ...(options.nextCursor ? { nextCursor: options.nextCursor } : {}),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function openDialog(source: "composer" | "settings" = "composer") {
  render(<ConnectionsDialogHost />);
  act(() => useConnectionsDialogStore.getState().openDialog(source));
  return screen.findByRole("dialog", { name: "Integrations" });
}

function SettingsConnectionsHarness(props: { readonly onSettingsEscape: () => void }) {
  useEffect(() => pushEscapeHandler(props.onSettingsEscape), [props.onSettingsEscape]);

  return (
    <>
      <button
        type="button"
        onClick={() => useConnectionsDialogStore.getState().openDialog("settings")}
      >
        Manage integrations
      </button>
      <ConnectionsDialogHost />
    </>
  );
}

function submitSearch(input: HTMLElement, query: string) {
  fireEvent.change(input, { target: { value: query } });
  fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
}

describe("ConnectionsDialogHost", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    useConnectionsDialogStore.setState({ isOpen: false, source: null });
    useBrowserPanelStore.setState({ tabs: [], activeTabId: null });
    bridgeMock.pipedreamGetSnapshot.mockResolvedValue(readySnapshot());
    bridgeMock.pipedreamRefreshAccounts.mockResolvedValue(readySnapshot());
    bridgeMock.pipedreamListApps.mockResolvedValue(appsPage([GMAIL_APP, SLACK_APP]));
    bridgeMock.pipedreamBeginConnect.mockResolvedValue({
      opened: true,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      flowId: "11111111-1111-4111-8111-111111111111",
    });
    bridgeMock.pipedreamGetConnectFlowStatus.mockResolvedValue({ state: "open" });
    bridgeMock.pipedreamFinishConnect.mockResolvedValue(undefined);
    bridgeMock.pipedreamCancelConnect.mockResolvedValue(undefined);
    bridgeMock.pipedreamChooseEnvFile.mockResolvedValue(null);
    bridgeMock.pipedreamDisconnectAccount.mockResolvedValue(readySnapshot());
    bridgeMock.pipedreamSetAccountAgentAccess.mockResolvedValue(
      readySnapshot([{ ...GMAIL_ACCOUNT, agentAccess: true }]),
    );
  });

  afterEach(() => {
    act(() => useConnectionsDialogStore.getState().closeDialog());
    act(() => useBrowserPanelStore.setState({ tabs: [], activeTabId: null }));
    vi.useRealTimers();
  });

  it("opens one accessible glass dialog from the shared host and reconciles accounts before showing the initial catalog", async () => {
    bridgeMock.pipedreamRefreshAccounts.mockResolvedValue(readySnapshot([SLACK_ACCOUNT]));

    const dialog = await openDialog("settings");

    expect(screen.getAllByRole("dialog", { name: "Integrations" })).toHaveLength(1);
    expect(dialog).toHaveClass("poracode-glass-chrome");
    await waitFor(() => expect(bridgeMock.pipedreamRefreshAccounts).toHaveBeenCalledOnce());
    await waitFor(() => expect(bridgeMock.pipedreamListApps).toHaveBeenCalledOnce());
    const initialCatalogRequest = bridgeMock.pipedreamListApps.mock.calls[0]?.[0];
    expect(initialCatalogRequest).toEqual(
      expect.objectContaining({ limit: expect.any(Number) as number }),
    );
    expect(initialCatalogRequest).not.toHaveProperty("query");
    expect(initialCatalogRequest).not.toHaveProperty("cursor");
    expect(within(dialog).getByText("Workspace Slack")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Connect Gmail" })).toBeInTheDocument();
  });

  it("does not paint Connections until the sensitive native view hide is acknowledged", async () => {
    const hide = deferred<void>();
    const presenter = vi.fn<(obstructed: boolean) => Promise<void>>((obstructed) =>
      obstructed ? hide.promise : Promise.resolve(),
    );
    const unregister = registerSensitiveNativeViewPresenter(presenter);
    render(<ConnectionsDialogHost />);

    try {
      act(() => useConnectionsDialogStore.getState().openDialog("composer"));

      expect(presenter).toHaveBeenCalledWith(true);
      expect(screen.queryByRole("dialog", { name: "Integrations" })).not.toBeInTheDocument();

      await act(async () => {
        hide.resolve();
        await hide.promise;
        await Promise.resolve();
      });

      expect(await screen.findByRole("dialog", { name: "Integrations" })).toBeInTheDocument();
    } finally {
      unregister(Promise.resolve());
    }
  });

  it("retains the Ready account surface and normal retry when opening reconciliation is offline", async () => {
    bridgeMock.pipedreamGetSnapshot.mockResolvedValue(readySnapshot([SLACK_ACCOUNT]));
    bridgeMock.pipedreamRefreshAccounts
      .mockRejectedValueOnce(new Error("simulated offline refresh"))
      .mockResolvedValueOnce(readySnapshot([SLACK_ACCOUNT]));

    const dialog = await openDialog();

    expect(await within(dialog).findByText("Workspace Slack")).toBeVisible();
    expect(within(dialog).queryByText("Set up integrations")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Could not load integrations. Try again.",
    );

    fireEvent.click(within(dialog).getByRole("button", { name: "Refresh accounts" }));
    await waitFor(() => expect(bridgeMock.pipedreamRefreshAccounts).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument());
    expect(within(dialog).getByText("Workspace Slack")).toBeVisible();
  });

  it("peels Integrations before Settings on Escape and restores focus to the Settings trigger", async () => {
    const onSettingsEscape = vi.fn<() => void>();
    render(<SettingsConnectionsHarness onSettingsEscape={onSettingsEscape} />);
    const trigger = screen.getByRole("button", { name: "Manage integrations" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Integrations" });

    fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });

    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(onSettingsEscape).not.toHaveBeenCalled();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("configures Pipedream from a local environment file without rendering its path or values", async () => {
    const configured = readySnapshot();
    bridgeMock.pipedreamGetSnapshot.mockResolvedValue({
      personalMcp: { enabled: false, authenticated: false, serverName: "pd" },
      connect: { state: "absent" },
    });
    bridgeMock.pipedreamChooseEnvFile.mockResolvedValue({
      status: "configured",
      snapshot: configured,
    });
    const dialog = await openDialog();

    fireEvent.click(await within(dialog).findByRole("button", { name: "Choose setup file" }));

    await waitFor(() => expect(bridgeMock.pipedreamChooseEnvFile).toHaveBeenCalledOnce());
    expect(bridgeMock.pipedreamChooseEnvFile).toHaveBeenCalledWith({
      dialogTitle: "Choose Pipedream environment file",
    });
    expect(
      await within(dialog).findByRole("textbox", { name: "Search integrations" }),
    ).toBeVisible();
    expect(document.body.textContent).not.toContain(".env.pipedream");
    expect(document.body.textContent).not.toContain("PIPEDREAM_CLIENT_SECRET");
  });

  it.each([
    ["applied", "Gmail is available to agents.", "text-success"],
    [
      "restart-required",
      "Gmail access changed. Restart running agents to apply the update.",
      "text-warning",
    ],
    [
      "failed-pending",
      "Gmail access changed, but running agents could not be updated. Restart them before using the integration.",
      "text-danger",
    ],
  ] as const)(
    "reports an agent access mutation with the %s reload outcome",
    async (state, expectedNotice, expectedClass) => {
      bridgeMock.pipedreamRefreshAccounts.mockResolvedValue(readySnapshot([GMAIL_ACCOUNT]));
      bridgeMock.pipedreamSetAccountAgentAccess.mockResolvedValue(
        readySnapshotWithAgentReload(state, [{ ...GMAIL_ACCOUNT, agentAccess: true }]),
      );
      const dialog = await openDialog();

      fireEvent.click(
        await within(dialog).findByRole("switch", { name: "Allow agents to use Work Gmail" }),
      );

      await waitFor(() =>
        expect(bridgeMock.pipedreamSetAccountAgentAccess).toHaveBeenCalledExactlyOnceWith({
          accountId: GMAIL_ACCOUNT.id,
          enabled: true,
        }),
      );
      const status = await within(dialog).findByRole("status");
      expect(status).toHaveTextContent(expectedNotice);
      expect(status).toHaveClass(expectedClass);
    },
  );

  it("searches Gmail from the full catalog and resets results and pagination when cleared", async () => {
    bridgeMock.pipedreamListApps
      .mockResolvedValueOnce(appsPage([SLACK_APP], { nextCursor: "initial-page-2", totalCount: 3 }))
      .mockResolvedValueOnce(appsPage([GMAIL_APP], { totalCount: 1 }))
      .mockResolvedValueOnce(appsPage([SLACK_APP], { totalCount: 1 }));
    const dialog = await openDialog();
    const input = await within(dialog).findByRole("textbox", { name: "Search integrations" });

    submitSearch(input, "gmail");

    await waitFor(() => expect(bridgeMock.pipedreamListApps).toHaveBeenCalledTimes(2));
    expect(bridgeMock.pipedreamListApps.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ query: "gmail", limit: expect.any(Number) as number }),
    );
    expect(bridgeMock.pipedreamListApps.mock.calls[1]?.[0]).not.toHaveProperty("cursor");
    expect(
      await within(dialog).findByRole("button", { name: "Connect Gmail" }),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText("Slack")).not.toBeInTheDocument();

    submitSearch(input, "");

    await waitFor(() => expect(bridgeMock.pipedreamListApps).toHaveBeenCalledTimes(3));
    expect(bridgeMock.pipedreamListApps.mock.calls[2]?.[0]).not.toHaveProperty("query");
    expect(bridgeMock.pipedreamListApps.mock.calls[2]?.[0]).not.toHaveProperty("cursor");
    expect(
      await within(dialog).findByRole("button", { name: "Connect Slack" }),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText("Gmail")).not.toBeInTheDocument();
  });

  it("loads every cursor page, appends unique integrations, and removes load-more at the end", async () => {
    bridgeMock.pipedreamListApps
      .mockResolvedValueOnce(
        appsPage([GMAIL_APP, SLACK_APP], { nextCursor: "catalog-page-2", totalCount: 3 }),
      )
      .mockResolvedValueOnce(appsPage([GMAIL_APP, NOTION_APP], { totalCount: 3 }));
    const dialog = await openDialog();
    const loadMore = await within(dialog).findByRole("button", {
      name: "Load more integrations",
    });

    fireEvent.click(loadMore);

    await waitFor(() => expect(bridgeMock.pipedreamListApps).toHaveBeenCalledTimes(2));
    expect(bridgeMock.pipedreamListApps.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ cursor: "catalog-page-2", limit: expect.any(Number) as number }),
    );
    expect(within(dialog).getAllByText("Gmail")).toHaveLength(1);
    expect(within(dialog).getByText("Slack")).toBeInTheDocument();
    expect(within(dialog).getByText("Notion")).toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: "Load more integrations" }),
    ).not.toBeInTheDocument();
  });

  it("coalesces duplicate requests for the same in-flight catalog cursor", async () => {
    const secondPage = deferred<PipedreamListAppsResult>();
    bridgeMock.pipedreamListApps
      .mockResolvedValueOnce(appsPage([GMAIL_APP], { nextCursor: "catalog-page-2", totalCount: 2 }))
      .mockReturnValue(secondPage.promise);
    const dialog = await openDialog();
    const loadMore = await within(dialog).findByRole("button", {
      name: "Load more integrations",
    });

    act(() => {
      loadMore.click();
      loadMore.click();
    });

    await waitFor(() => expect(bridgeMock.pipedreamListApps).toHaveBeenCalledTimes(2));
    await act(async () => secondPage.resolve(appsPage([NOTION_APP], { totalCount: 2 })));
    expect(await within(dialog).findByText("Notion")).toBeInTheDocument();
  });

  it("allows a failed catalog cursor request to be retried", async () => {
    bridgeMock.pipedreamListApps
      .mockResolvedValueOnce(appsPage([GMAIL_APP], { nextCursor: "catalog-page-2", totalCount: 2 }))
      .mockRejectedValueOnce(new Error("temporary catalog failure"))
      .mockResolvedValueOnce(appsPage([NOTION_APP], { totalCount: 2 }));
    const dialog = await openDialog();

    fireEvent.click(await within(dialog).findByRole("button", { name: "Load more integrations" }));
    await waitFor(() => expect(bridgeMock.pipedreamListApps).toHaveBeenCalledTimes(2));
    const retry = within(dialog).getByRole("button", { name: "Load more integrations" });
    await waitFor(() => expect(retry).toBeEnabled());
    fireEvent.click(retry);

    await waitFor(() => expect(bridgeMock.pipedreamListApps).toHaveBeenCalledTimes(3));
    expect(await within(dialog).findByText("Notion")).toBeInTheDocument();
  });

  it("stops pagination when the provider loops to a previously requested cursor", async () => {
    bridgeMock.pipedreamListApps
      .mockResolvedValueOnce(appsPage([GMAIL_APP], { nextCursor: "catalog-page-2", totalCount: 3 }))
      .mockResolvedValueOnce(appsPage([SLACK_APP], { nextCursor: "catalog-page-3", totalCount: 3 }))
      .mockResolvedValueOnce(
        appsPage([NOTION_APP], { nextCursor: "catalog-page-2", totalCount: 3 }),
      );
    const dialog = await openDialog();

    fireEvent.click(await within(dialog).findByRole("button", { name: "Load more integrations" }));
    await waitFor(() => expect(bridgeMock.pipedreamListApps).toHaveBeenCalledTimes(2));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Load more integrations" }));
    await waitFor(() => expect(bridgeMock.pipedreamListApps).toHaveBeenCalledTimes(3));

    expect(bridgeMock.pipedreamListApps.mock.calls.map(([payload]) => payload.cursor)).toEqual([
      undefined,
      "catalog-page-2",
      "catalog-page-3",
    ]);
    expect(await within(dialog).findByText("Notion")).toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: "Load more integrations" }),
    ).not.toBeInTheDocument();
  });

  it("ignores a stale search response that settles after a newer Gmail response", async () => {
    const staleSlack = deferred<PipedreamListAppsResult>();
    const currentGmail = deferred<PipedreamListAppsResult>();
    bridgeMock.pipedreamListApps
      .mockResolvedValueOnce(appsPage([NOTION_APP]))
      .mockReturnValueOnce(staleSlack.promise)
      .mockReturnValueOnce(currentGmail.promise);
    const dialog = await openDialog();
    const input = await within(dialog).findByRole("textbox", { name: "Search integrations" });

    submitSearch(input, "slack");
    await waitFor(() => expect(bridgeMock.pipedreamListApps).toHaveBeenCalledTimes(2));
    submitSearch(input, "gmail");
    await waitFor(() => expect(bridgeMock.pipedreamListApps).toHaveBeenCalledTimes(3));
    await act(async () => currentGmail.resolve(appsPage([GMAIL_APP])));
    expect(
      await within(dialog).findByRole("button", { name: "Connect Gmail" }),
    ).toBeInTheDocument();

    await act(async () => staleSlack.resolve(appsPage([SLACK_APP])));

    expect(within(dialog).getByRole("button", { name: "Connect Gmail" })).toBeInTheDocument();
    expect(within(dialog).queryByText("Slack")).not.toBeInTheDocument();
  });

  it("refreshes after trusted Connect success but requires an explicit per-account agent grant", async () => {
    bridgeMock.pipedreamListApps.mockResolvedValue(appsPage([GMAIL_APP]));
    bridgeMock.pipedreamRefreshAccounts
      .mockResolvedValueOnce(readySnapshot([SLACK_ACCOUNT]))
      .mockResolvedValueOnce(readySnapshot([SLACK_ACCOUNT, GMAIL_ACCOUNT]));
    bridgeMock.pipedreamSetAccountAgentAccess.mockResolvedValue(
      readySnapshot([SLACK_ACCOUNT, { ...GMAIL_ACCOUNT, agentAccess: true }]),
    );
    bridgeMock.pipedreamGetConnectFlowStatus.mockResolvedValue({ state: "succeeded" });
    const dialog = await openDialog();
    const connect = await within(dialog).findByRole("button", { name: "Connect Gmail" });

    vi.useFakeTimers();
    fireEvent.click(connect);
    await act(async () => vi.advanceTimersByTimeAsync(0));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    await act(async () => Promise.resolve());

    expect(bridgeMock.pipedreamBeginConnect).toHaveBeenCalledExactlyOnceWith({ appSlug: "gmail" });
    expect(bridgeMock.pipedreamSetAccountAgentAccess).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/Gmail.*connected.*turn on agent access/i)).toBeInTheDocument();
    expect(within(dialog).getByText("Work Gmail")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("switch", { name: "Allow agents to use Work Gmail" }));
    await act(async () => Promise.resolve());
    expect(bridgeMock.pipedreamSetAccountAgentAccess).toHaveBeenCalledExactlyOnceWith({
      accountId: GMAIL_ACCOUNT.id,
      enabled: true,
    });
    expect(bridgeMock.pipedreamFinishConnect).toHaveBeenCalledExactlyOnceWith({
      flowId: "11111111-1111-4111-8111-111111111111",
    });
    expect(bridgeMock.pipedreamRefreshAccounts.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("does not treat mutable changes to an existing same-app account as OAuth completion or grant it to agents", async () => {
    const existingGmail = {
      ...GMAIL_ACCOUNT,
      name: "Existing Gmail",
      connectedAt: "2026-08-28T17:00:00.000Z",
    };
    const mutatedExistingGmail = {
      ...existingGmail,
      name: "Renamed Existing Gmail",
      connectedAt: "2026-08-29T17:00:00.000Z",
    };
    bridgeMock.pipedreamListApps.mockResolvedValue(appsPage([GMAIL_APP]));
    bridgeMock.pipedreamRefreshAccounts
      .mockResolvedValueOnce(readySnapshot([existingGmail]))
      .mockResolvedValue(readySnapshot([mutatedExistingGmail]));
    bridgeMock.pipedreamSetAccountAgentAccess.mockResolvedValue(
      readySnapshot([{ ...mutatedExistingGmail, agentAccess: true }]),
    );
    const dialog = await openDialog();
    const connect = await within(dialog).findByRole("button", { name: "Connect Gmail" });

    vi.useFakeTimers();
    fireEvent.click(connect);
    await act(async () => vi.advanceTimersByTimeAsync(0));

    expect(bridgeMock.pipedreamSetAccountAgentAccess).not.toHaveBeenCalled();
    expect(within(dialog).getByText("Connecting Gmail")).toBeInTheDocument();
    expect(
      within(dialog).queryByText(/Gmail.*connected.*available to agents/i),
    ).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel Gmail connection" }));
  });

  it("does not auto-grant a newly observed same-app account while the flow is still open", async () => {
    bridgeMock.pipedreamListApps.mockResolvedValue(appsPage([GMAIL_APP]));
    bridgeMock.pipedreamRefreshAccounts
      .mockResolvedValueOnce(readySnapshot([SLACK_ACCOUNT]))
      .mockResolvedValue(readySnapshot([SLACK_ACCOUNT, GMAIL_ACCOUNT]));
    bridgeMock.pipedreamGetConnectFlowStatus.mockResolvedValue({ state: "open" });
    const dialog = await openDialog();
    const connect = await within(dialog).findByRole("button", { name: "Connect Gmail" });

    vi.useFakeTimers();
    fireEvent.click(connect);
    await act(async () => vi.advanceTimersByTimeAsync(4_000));

    expect(bridgeMock.pipedreamSetAccountAgentAccess).not.toHaveBeenCalled();
    expect(within(dialog).getByText("Connecting Gmail")).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        /Your provider will show the requested permissions.*optional permissions.*required permissions still apply/i,
      ),
    ).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel Gmail connection" }));
  });

  it("suspends the waiting card while its sensitive auth tab is active and restores it on deactivation", async () => {
    bridgeMock.pipedreamListApps.mockResolvedValue(appsPage([GMAIL_APP]));
    const dialog = await openDialog();
    fireEvent.click(await within(dialog).findByRole("button", { name: "Connect Gmail" }));
    await waitFor(() => expect(bridgeMock.pipedreamBeginConnect).toHaveBeenCalledOnce());

    act(() => {
      useBrowserPanelStore.setState({
        tabs: [
          {
            tabId: "tab-auth",
            url: "about:blank",
            title: "Secure connection",
            loading: true,
            canGoBack: false,
            canGoForward: false,
            sensitiveIntegration: true,
            sensitiveViewGeneration: 3,
          },
        ],
        activeTabId: "tab-auth",
      });
    });

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Integrations" })).not.toBeInTheDocument(),
    );

    act(() => useBrowserPanelStore.getState().setActive(null));

    const restored = await screen.findByRole("dialog", { name: "Integrations" });
    expect(within(restored).getByText("Connecting Gmail")).toBeInTheDocument();
    fireEvent.click(within(restored).getByRole("button", { name: "Cancel Gmail connection" }));
  });

  it("never auto-grants a delayed same-app account after a successful flow", async () => {
    bridgeMock.pipedreamListApps.mockResolvedValue(appsPage([GMAIL_APP]));
    bridgeMock.pipedreamRefreshAccounts
      .mockResolvedValueOnce(readySnapshot([SLACK_ACCOUNT]))
      .mockResolvedValueOnce(readySnapshot([SLACK_ACCOUNT]));
    bridgeMock.pipedreamGetConnectFlowStatus.mockResolvedValue({ state: "succeeded" });
    const dialog = await openDialog();
    const connect = await within(dialog).findByRole("button", { name: "Connect Gmail" });

    vi.useFakeTimers();
    fireEvent.click(connect);
    await act(async () => vi.advanceTimersByTimeAsync(0));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    await act(async () => Promise.resolve());

    expect(bridgeMock.pipedreamGetConnectFlowStatus).toHaveBeenCalled();
    expect(bridgeMock.pipedreamSetAccountAgentAccess).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/Gmail.*connected.*turn on agent access/i)).toBeInTheDocument();
    expect(within(dialog).queryByText(/Gmail connection cancelled/i)).not.toBeInTheDocument();

    bridgeMock.pipedreamRefreshAccounts.mockResolvedValue(
      readySnapshot([SLACK_ACCOUNT, GMAIL_ACCOUNT]),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Refresh accounts" }));
    await act(async () => Promise.resolve());

    expect(within(dialog).getByText("Work Gmail")).toBeInTheDocument();
    expect(bridgeMock.pipedreamSetAccountAgentAccess).not.toHaveBeenCalled();
  });

  it("never auto-grants a same-app account observed after a closed flow", async () => {
    bridgeMock.pipedreamListApps.mockResolvedValue(appsPage([GMAIL_APP]));
    bridgeMock.pipedreamRefreshAccounts
      .mockResolvedValueOnce(readySnapshot([SLACK_ACCOUNT]))
      .mockResolvedValue(readySnapshot([SLACK_ACCOUNT, GMAIL_ACCOUNT]));
    bridgeMock.pipedreamGetConnectFlowStatus.mockResolvedValue({ state: "closed" });
    const dialog = await openDialog();
    const connect = await within(dialog).findByRole("button", { name: "Connect Gmail" });

    vi.useFakeTimers();
    fireEvent.click(connect);
    await act(async () => vi.advanceTimersByTimeAsync(0));

    expect(within(dialog).getByText(/Gmail connection cancelled/i)).toBeInTheDocument();
    expect(bridgeMock.pipedreamSetAccountAgentAccess).not.toHaveBeenCalled();
  });

  it("reports trusted success without auto-granting ambiguous same-app accounts", async () => {
    const secondGmail = {
      ...GMAIL_ACCOUNT,
      id: "apn_GmailAccount456",
      name: "Personal Gmail",
    };
    bridgeMock.pipedreamListApps.mockResolvedValue(appsPage([GMAIL_APP]));
    bridgeMock.pipedreamRefreshAccounts
      .mockResolvedValueOnce(readySnapshot([SLACK_ACCOUNT]))
      .mockResolvedValueOnce(readySnapshot([SLACK_ACCOUNT, GMAIL_ACCOUNT, secondGmail]));
    bridgeMock.pipedreamGetConnectFlowStatus.mockResolvedValue({ state: "succeeded" });
    const dialog = await openDialog();
    const connect = await within(dialog).findByRole("button", { name: "Connect Gmail" });

    vi.useFakeTimers();
    fireEvent.click(connect);
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    await act(async () => Promise.resolve());

    expect(within(dialog).getByText(/Gmail.*connected.*turn on agent access/i)).toBeInTheDocument();
    expect(within(dialog).getByText("Work Gmail")).toBeInTheDocument();
    expect(within(dialog).getByText("Personal Gmail")).toBeInTheDocument();
    expect(bridgeMock.pipedreamSetAccountAgentAccess).not.toHaveBeenCalled();
  });

  it("settles a closed OAuth flow promptly as cancellation", async () => {
    bridgeMock.pipedreamListApps.mockResolvedValue(appsPage([GMAIL_APP]));
    bridgeMock.pipedreamRefreshAccounts.mockResolvedValue(readySnapshot([SLACK_ACCOUNT]));
    bridgeMock.pipedreamGetConnectFlowStatus.mockResolvedValue({ state: "closed" });
    const dialog = await openDialog();
    const connect = await within(dialog).findByRole("button", { name: "Connect Gmail" });

    vi.useFakeTimers();
    fireEvent.click(connect);
    await act(async () => vi.advanceTimersByTimeAsync(0));

    expect(within(dialog).getByText(/Gmail connection cancelled/i)).toBeInTheDocument();
    expect(bridgeMock.pipedreamSetAccountAgentAccess).not.toHaveBeenCalled();
  });

  it("settles an OAuth error promptly with only a generic failed state", async () => {
    bridgeMock.pipedreamListApps.mockResolvedValue(appsPage([GMAIL_APP]));
    bridgeMock.pipedreamRefreshAccounts
      .mockResolvedValueOnce(readySnapshot())
      .mockReturnValue(new Promise<PipedreamSnapshot>(() => undefined));
    bridgeMock.pipedreamGetConnectFlowStatus.mockResolvedValue({ state: "failed" });
    const dialog = await openDialog();
    const connect = await within(dialog).findByRole("button", { name: "Connect Gmail" });

    vi.useFakeTimers();
    fireEvent.click(connect);
    await act(async () => vi.advanceTimersByTimeAsync(0));

    expect(within(dialog).getByText(/Gmail connection failed/i)).toBeInTheDocument();
    expect(bridgeMock.pipedreamSetAccountAgentAccess).not.toHaveBeenCalled();
  });

  it("requires confirmation before disconnecting an account and removes it from the shared snapshot", async () => {
    bridgeMock.pipedreamRefreshAccounts.mockResolvedValue(readySnapshot([SLACK_ACCOUNT]));
    bridgeMock.pipedreamDisconnectAccount.mockResolvedValue(readySnapshot());
    const dialog = await openDialog();

    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Disconnect Workspace Slack" }),
    );
    expect(
      within(dialog).getByText(/Disconnect Workspace Slack and revoke agent access/i),
    ).toBeVisible();
    expect(bridgeMock.pipedreamDisconnectAccount).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm disconnect" }));

    await waitFor(() =>
      expect(bridgeMock.pipedreamDisconnectAccount).toHaveBeenCalledExactlyOnceWith({
        accountId: SLACK_ACCOUNT.id,
      }),
    );
    expect(within(dialog).queryByText("Workspace Slack")).not.toBeInTheDocument();
    expect(within(dialog).getByText(/Slack disconnected/i)).toBeVisible();
  });

  it("keeps a failed remote disconnect retryable while showing agent access revoked", async () => {
    const revokedAccount = { ...SLACK_ACCOUNT, agentAccess: false };
    bridgeMock.pipedreamGetSnapshot.mockResolvedValue(readySnapshot([revokedAccount]));
    bridgeMock.pipedreamRefreshAccounts.mockResolvedValue(readySnapshot([SLACK_ACCOUNT]));
    bridgeMock.pipedreamDisconnectAccount.mockRejectedValue(
      new Error("simulated remote disconnect failure"),
    );
    const dialog = await openDialog();

    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Disconnect Workspace Slack" }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm disconnect" }));

    expect(
      await within(dialog).findByText("Could not disconnect Slack. Agent access has been revoked."),
    ).toBeVisible();
    expect(within(dialog).getByText("Agent access off")).toBeVisible();
    const retryDisconnect = within(dialog).getByRole("button", {
      name: "Disconnect Workspace Slack",
    });
    expect(retryDisconnect).toBeEnabled();
    fireEvent.click(retryDisconnect);
    expect(
      within(dialog).getByText(/Disconnect Workspace Slack and revoke agent access/i),
    ).toBeVisible();
  });

  it("stops polling at the Connect Link expiry and offers a finite retry", async () => {
    bridgeMock.pipedreamListApps.mockResolvedValue(appsPage([GMAIL_APP]));
    bridgeMock.pipedreamRefreshAccounts.mockResolvedValue(readySnapshot([SLACK_ACCOUNT]));
    bridgeMock.pipedreamBeginConnect.mockResolvedValue({
      opened: true,
      expiresAt: new Date(Date.now() + 5_000).toISOString(),
      flowId: "22222222-2222-4222-8222-222222222222",
    });
    const dialog = await openDialog();
    const connect = await within(dialog).findByRole("button", { name: "Connect Gmail" });

    vi.useFakeTimers();
    fireEvent.click(connect);
    await act(async () => vi.advanceTimersByTimeAsync(0));

    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    const refreshesAtTimeout = bridgeMock.pipedreamRefreshAccounts.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(60_000));

    expect(within(dialog).getByText(/Gmail connection timed out/i)).toBeInTheDocument();
    expect(bridgeMock.pipedreamFinishConnect).toHaveBeenCalledExactlyOnceWith({
      flowId: "22222222-2222-4222-8222-222222222222",
    });
    expect(bridgeMock.pipedreamRefreshAccounts).toHaveBeenCalledTimes(refreshesAtTimeout);
    expect(refreshesAtTimeout).toBeLessThanOrEqual(10);
    expect(within(dialog).getByRole("button", { name: "Retry Gmail connection" })).toBeEnabled();
    expect(bridgeMock.pipedreamSetAccountAgentAccess).not.toHaveBeenCalled();
  });

  it("cancels an in-flight connection without leaving a background poll running", async () => {
    bridgeMock.pipedreamListApps.mockResolvedValue(appsPage([GMAIL_APP]));
    bridgeMock.pipedreamRefreshAccounts.mockResolvedValue(readySnapshot());
    const dialog = await openDialog();
    const connect = await within(dialog).findByRole("button", { name: "Connect Gmail" });

    vi.useFakeTimers();
    fireEvent.click(connect);
    await act(async () => vi.advanceTimersByTimeAsync(0));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel Gmail connection" }));
    const refreshesAtCancel = bridgeMock.pipedreamRefreshAccounts.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(60_000));

    expect(within(dialog).getByText(/Gmail connection cancelled/i)).toBeInTheDocument();
    expect(bridgeMock.pipedreamCancelConnect).toHaveBeenCalledExactlyOnceWith({
      flowId: "11111111-1111-4111-8111-111111111111",
    });
    expect(bridgeMock.pipedreamRefreshAccounts).toHaveBeenCalledTimes(refreshesAtCancel);
    expect(bridgeMock.pipedreamSetAccountAgentAccess).not.toHaveBeenCalled();
  });

  it("renders only bounded generic errors when upstream failures contain secrets or Connect Links", async () => {
    const privateFailure =
      "client-secret=SENTINEL-PRIVATE https://pipedream.com/_static/connect.html?token=ctok_private";
    bridgeMock.pipedreamListApps.mockResolvedValue(appsPage([GMAIL_APP]));
    bridgeMock.pipedreamBeginConnect.mockRejectedValue(new Error(privateFailure));
    const dialog = await openDialog();

    fireEvent.click(await within(dialog).findByRole("button", { name: "Connect Gmail" }));

    expect(
      await within(dialog).findByText(/Could not start Gmail connection/i),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("SENTINEL-PRIVATE");
    expect(document.body.textContent).not.toContain("ctok_private");
    expect(document.body.textContent).not.toContain("pipedream.com/_static/connect.html");
    expect(document.body.textContent).not.toContain(GMAIL_ACCOUNT.id);
  });
});
