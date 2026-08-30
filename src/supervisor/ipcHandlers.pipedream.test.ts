import { describe, expect, it, vi } from "vitest";
import type {
  PipedreamAccountSummary,
  PipedreamAgentReloadOutcome,
  PipedreamSnapshot,
} from "@/shared/contracts";
import { createSupervisorIpcHandlers } from "./ipcHandlers";
import type { SupervisorRuntime } from "./supervisorRuntime";

const SNAPSHOT: PipedreamSnapshot = {
  personalMcp: { enabled: false, authenticated: false, serverName: "pd" },
  connect: {
    state: "ready",
    credentialSource: "environment",
    environment: "development",
    projectIdHint: "proj_…t123",
    projectName: "Y Space Project",
    accounts: [],
  },
};

const GRANTED_ACCOUNT: PipedreamAccountSummary = {
  id: "apn_Account123",
  name: "Work Gmail",
  healthy: true,
  connectedAt: "2026-08-28T19:00:00.000Z",
  agentAccess: true,
  app: { id: "app_Gmail123", slug: "gmail", name: "Gmail" },
};

const SNAPSHOT_WITH_GRANTED_ACCOUNT: PipedreamSnapshot = {
  ...SNAPSHOT,
  connect: {
    state: "ready",
    credentialSource: "environment",
    environment: "development",
    projectIdHint: "proj_…t123",
    projectName: "Y Space Project",
    accounts: [GRANTED_ACCOUNT],
  },
};

const SNAPSHOT_WITH_REVOKED_ACCOUNT: PipedreamSnapshot = {
  ...SNAPSHOT,
  connect: {
    state: "ready",
    credentialSource: "environment",
    environment: "development",
    projectIdHint: "proj_…t123",
    projectName: "Y Space Project",
    accounts: [{ ...GRANTED_ACCOUNT, agentAccess: false }],
  },
};

function createRuntime(input: {
  readonly pipedreamService: object;
  readonly reloadPipedreamMcpServers: (options?: {
    revokePersonalOauth?: boolean;
  }) => Promise<PipedreamAgentReloadOutcome>;
  readonly mcpOAuthService?: object;
}): SupervisorRuntime {
  const inertService = new Proxy({}, { get: () => vi.fn<(...args: never[]) => unknown>() });
  return new Proxy(
    {},
    {
      get: (_target, property) => {
        if (property === "pipedreamService") return input.pipedreamService;
        if (property === "mcpOAuthService") return input.mcpOAuthService ?? inertService;
        if (property === "threadSessionManager") {
          return {
            reloadPipedreamMcpServers: input.reloadPipedreamMcpServers,
          };
        }
        return inertService;
      },
    },
  ) as SupervisorRuntime;
}

describe("Pipedream supervisor IPC live MCP reloads", () => {
  it("reserves Personal Pipedream OAuth for internal main-owned procedures", async () => {
    const authorizationUrl =
      "https://pipedream.com/oauth?state=renderer-secret-sentinel&code_challenge=private";
    const begin = vi.fn<
      () => Promise<{
        status: "redirect";
        flowId: string;
        authorizationUrl: string;
      }>
    >(async () => ({
      status: "redirect",
      flowId: "4d73cb38-1566-4e07-bf92-ce6edf1c82e8",
      authorizationUrl,
    }));
    const wait = vi.fn<() => Promise<{ status: "authorized" }>>(async () => ({
      status: "authorized",
    }));
    const cancel = vi.fn<() => void>();
    const clear = vi.fn<() => void>();
    const handlers = createSupervisorIpcHandlers(
      createRuntime({
        pipedreamService: { getSnapshot: () => SNAPSHOT },
        reloadPipedreamMcpServers: async () => ({ state: "applied" }),
        mcpOAuthService: { begin, wait, cancel, clear, status: () => ({ authenticatedUrls: [] }) },
      }),
    );
    for (const url of [
      "https://mcp.pipedream.net/v2",
      "https://mcp.pipedream.net/v2?renderer=bypass",
      "https://mcp.pipedream.net/v2#renderer-bypass",
    ]) {
      expect(
        handlers.beginMcpServerOauth({
          server: {
            id: "attacker-chosen-id",
            name: "attacker-chosen-name",
            description: "Generic server",
            enabled: true,
            timeoutMs: 30_000,
            transport: { type: "http", url, headers: {} },
          },
        }),
      ).toEqual({
        status: "error",
        message: "Personal Pipedream sign-in must be started from Connections.",
      });
    }
    expect(begin).not.toHaveBeenCalled();

    const internal = await handlers.pipedreamInternalBeginPersonalMcpOauth({});
    expect(internal).toEqual({
      status: "redirect",
      flowId: "4d73cb38-1566-4e07-bf92-ce6edf1c82e8",
      authorizationUrl,
    });
    expect(begin).toHaveBeenCalledWith({
      server: expect.objectContaining({
        id: "pipedream-personal-mcp",
        name: "pd",
        transport: expect.objectContaining({ url: "https://mcp.pipedream.net/v2" }),
      }),
    });
  });

  it("reloads live MCP state when Personal OAuth becomes authorized", async () => {
    const order: string[] = [];
    const begin = vi
      .fn<
        () => Promise<
          | { status: "redirect"; flowId: string; authorizationUrl: string }
          | { status: "authorized" }
        >
      >()
      .mockResolvedValueOnce({
        status: "redirect" as const,
        flowId: "personal-flow",
        authorizationUrl: "https://pipedream.com/oauth?state=private",
      })
      .mockResolvedValueOnce({ status: "authorized" as const });
    const wait = vi.fn<() => Promise<{ status: "authorized" }>>(async () => {
      order.push("authorized");
      return { status: "authorized" as const };
    });
    const reloadPipedreamMcpServers = vi.fn<
      (options?: { revokePersonalOauth?: boolean }) => Promise<PipedreamAgentReloadOutcome>
    >(async () => {
      order.push("reload");
      return { state: "applied" as const };
    });
    const handlers = createSupervisorIpcHandlers(
      createRuntime({
        pipedreamService: { getSnapshot: () => SNAPSHOT },
        reloadPipedreamMcpServers,
        mcpOAuthService: {
          begin,
          wait,
          cancel: vi.fn<(payload: { flowId: string }) => void>(),
          clear: vi.fn<(payload: { url: string }) => void>(),
          status: () => ({ authenticatedUrls: [] }),
        },
      }),
    );

    await expect(handlers.pipedreamInternalBeginPersonalMcpOauth({})).resolves.toEqual(
      expect.objectContaining({ status: "redirect", flowId: "personal-flow" }),
    );
    expect(reloadPipedreamMcpServers).not.toHaveBeenCalled();

    await expect(
      handlers.pipedreamInternalWaitPersonalMcpOauth({ flowId: "personal-flow" }),
    ).resolves.toEqual({ status: "authorized" });
    expect(order).toEqual(["authorized", "reload"]);

    await expect(handlers.pipedreamInternalBeginPersonalMcpOauth({})).resolves.toEqual({
      status: "authorized",
    });
    expect(reloadPipedreamMcpServers).toHaveBeenCalledTimes(2);
  });

  it("allows only privileged internal Personal clear and rejects public canonical or alias clears", async () => {
    const order: string[] = [];
    const clear = vi.fn<(payload: { url: string }) => void>((payload) => {
      order.push(`clear:${payload.url}`);
    });
    const reloadPipedreamMcpServers = vi.fn<
      (options?: { revokePersonalOauth?: boolean }) => Promise<PipedreamAgentReloadOutcome>
    >(async () => {
      order.push("reload");
      return { state: "applied" as const };
    });
    const handlers = createSupervisorIpcHandlers(
      createRuntime({
        pipedreamService: { getSnapshot: () => SNAPSHOT },
        reloadPipedreamMcpServers,
        mcpOAuthService: {
          begin: vi.fn<() => never>(),
          wait: vi.fn<() => never>(),
          cancel: vi.fn<(payload: { flowId: string }) => void>(),
          clear,
          status: () => ({ authenticatedUrls: [] }),
        },
      }),
    );

    for (const url of [
      "https://mcp.pipedream.net/v2",
      "https://mcp.pipedream.net/v2?renderer=bypass",
      "https://mcp.pipedream.net/v2#personal-alias",
    ]) {
      await expect(handlers.clearMcpServerOauth({ url })).rejects.toThrow(
        "Personal Pipedream sign-out must be managed from Connections.",
      );
    }
    expect(clear).not.toHaveBeenCalled();
    expect(reloadPipedreamMcpServers).not.toHaveBeenCalled();

    await handlers.clearMcpServerOauth({ url: "https://generic.example.test/mcp" });
    await handlers.pipedreamInternalClearPersonalMcpOauth({});

    expect(order).toEqual([
      "clear:https://generic.example.test/mcp",
      "clear:https://mcp.pipedream.net/v2",
      "reload",
    ]);
    expect(clear).toHaveBeenNthCalledWith(
      2,
      { url: "https://mcp.pipedream.net/v2" },
      {
        strictPersistence: true,
      },
    );
    expect(reloadPipedreamMcpServers).toHaveBeenCalledExactlyOnceWith({
      revokePersonalOauth: true,
    });
  });

  it("surfaces a strict Personal clear failure after revoking live agent access", async () => {
    const persistenceError = new Error("Could not persist the OAuth credential change.");
    const clear = vi.fn<(payload: { url: string }, options?: object) => void>(() => {
      throw persistenceError;
    });
    const reloadPipedreamMcpServers = vi.fn<
      (options?: { revokePersonalOauth?: boolean }) => Promise<PipedreamAgentReloadOutcome>
    >(async () => ({ state: "applied" }));
    const handlers = createSupervisorIpcHandlers(
      createRuntime({
        pipedreamService: { getSnapshot: () => SNAPSHOT },
        reloadPipedreamMcpServers,
        mcpOAuthService: {
          begin: vi.fn<() => never>(),
          wait: vi.fn<() => never>(),
          cancel: vi.fn<(payload: { flowId: string }) => void>(),
          clear,
          status: () => ({ authenticatedUrls: [] }),
        },
      }),
    );

    await expect(handlers.pipedreamInternalClearPersonalMcpOauth({})).rejects.toBe(
      persistenceError,
    );
    expect(clear).toHaveBeenCalledWith(
      { url: "https://mcp.pipedream.net/v2" },
      { strictPersistence: true },
    );
    expect(reloadPipedreamMcpServers).toHaveBeenCalledWith({ revokePersonalOauth: true });
  });

  it("reloads supported live sessions after refresh, access, and disconnect mutations", async () => {
    const order: string[] = [];
    let current = SNAPSHOT;
    const pipedreamService = {
      getSnapshot: vi.fn<() => PipedreamSnapshot>(() => current),
      refreshAccounts: vi.fn<() => Promise<PipedreamSnapshot>>(async () => {
        order.push("refresh");
        current = SNAPSHOT_WITH_GRANTED_ACCOUNT;
        return current;
      }),
      setAccountAgentAccess: vi.fn<
        (payload: { accountId: string; enabled: boolean }) => PipedreamSnapshot
      >(() => {
        order.push("access");
        current = SNAPSHOT;
        return current;
      }),
      disconnectAccount: vi.fn<(payload: { accountId: string }) => Promise<PipedreamSnapshot>>(
        async () => {
          order.push("disconnect");
          current = SNAPSHOT;
          return current;
        },
      ),
    };
    const reloadPipedreamMcpServers = vi.fn<() => Promise<PipedreamAgentReloadOutcome>>(
      async () => {
        order.push("reload");
        return { state: "applied" };
      },
    );
    const handlers = createSupervisorIpcHandlers(
      createRuntime({ pipedreamService, reloadPipedreamMcpServers }),
    );

    await expect(handlers.pipedreamRefreshAccounts({})).resolves.toEqual({
      ...SNAPSHOT_WITH_GRANTED_ACCOUNT,
      agentReload: { state: "applied" },
    });
    await expect(
      handlers.pipedreamSetAccountAgentAccess({ accountId: "apn_Account123", enabled: true }),
    ).resolves.toEqual({ ...SNAPSHOT, agentReload: { state: "applied" } });
    current = SNAPSHOT_WITH_GRANTED_ACCOUNT;
    await expect(
      handlers.pipedreamDisconnectAccount({ accountId: "apn_Account123" }),
    ).resolves.toEqual({ ...SNAPSHOT, agentReload: { state: "applied" } });

    expect(order).toEqual(["refresh", "reload", "access", "reload", "disconnect", "reload"]);
    expect(reloadPipedreamMcpServers).toHaveBeenCalledTimes(3);
  });

  it("reloads after a disconnect failure because local authorization is revoked first", async () => {
    const disconnectError = new Error("Pipedream request failed.");
    let current = SNAPSHOT_WITH_GRANTED_ACCOUNT;
    const pipedreamService = {
      getSnapshot: vi.fn<() => PipedreamSnapshot>(() => current),
      disconnectAccount: vi.fn<(payload: { accountId: string }) => Promise<PipedreamSnapshot>>(
        async () => {
          current = SNAPSHOT_WITH_REVOKED_ACCOUNT;
          throw disconnectError;
        },
      ),
    };
    const reloadPipedreamMcpServers = vi.fn<() => Promise<PipedreamAgentReloadOutcome>>(
      async () => ({ state: "applied" }),
    );
    const handlers = createSupervisorIpcHandlers(
      createRuntime({ pipedreamService, reloadPipedreamMcpServers }),
    );

    await expect(handlers.pipedreamDisconnectAccount({ accountId: "apn_Account123" })).rejects.toBe(
      disconnectError,
    );
    expect(reloadPipedreamMcpServers).toHaveBeenCalledOnce();
    expect(current.connect).toMatchObject({
      state: "ready",
      accounts: [expect.objectContaining({ id: "apn_Account123", agentAccess: false })],
    });
  });

  it("does not churn live provider MCP state when an account refresh is unchanged", async () => {
    const pipedreamService = {
      getSnapshot: vi.fn<() => PipedreamSnapshot>(() => SNAPSHOT),
      refreshAccounts: vi.fn<() => Promise<PipedreamSnapshot>>(async () => SNAPSHOT),
    };
    const reloadPipedreamMcpServers = vi.fn<() => Promise<PipedreamAgentReloadOutcome>>(
      async () => ({ state: "applied" }),
    );
    const handlers = createSupervisorIpcHandlers(
      createRuntime({ pipedreamService, reloadPipedreamMcpServers }),
    );

    await expect(handlers.pipedreamRefreshAccounts({})).resolves.toBe(SNAPSHOT);

    expect(reloadPipedreamMcpServers).not.toHaveBeenCalled();
  });

  it.each(["restart-required", "failed-pending"] as const)(
    "attaches a renderer-safe %s outcome when a grant mutation cannot apply live",
    async (state) => {
      const pipedreamService = {
        getSnapshot: vi
          .fn<() => PipedreamSnapshot>()
          .mockReturnValueOnce(SNAPSHOT)
          .mockReturnValue(SNAPSHOT_WITH_GRANTED_ACCOUNT),
        setAccountAgentAccess: vi
          .fn<(payload: { accountId: string; enabled: boolean }) => PipedreamSnapshot>()
          .mockReturnValue(SNAPSHOT_WITH_GRANTED_ACCOUNT),
      };
      const reloadPipedreamMcpServers = vi.fn<() => Promise<PipedreamAgentReloadOutcome>>(
        async () => ({ state }),
      );
      const handlers = createSupervisorIpcHandlers(
        createRuntime({ pipedreamService, reloadPipedreamMcpServers }),
      );

      await expect(
        handlers.pipedreamSetAccountAgentAccess({ accountId: "apn_Account123", enabled: true }),
      ).resolves.toEqual({
        ...SNAPSHOT_WITH_GRANTED_ACCOUNT,
        agentReload: { state },
      });
    },
  );

  it("returns failed-pending instead of silently claiming success when reload orchestration throws", async () => {
    const pipedreamService = {
      getSnapshot: vi
        .fn<() => PipedreamSnapshot>()
        .mockReturnValueOnce(SNAPSHOT)
        .mockReturnValue(SNAPSHOT_WITH_GRANTED_ACCOUNT),
      setAccountAgentAccess: vi
        .fn<(payload: { accountId: string; enabled: boolean }) => PipedreamSnapshot>()
        .mockReturnValue(SNAPSHOT_WITH_GRANTED_ACCOUNT),
    };
    const reloadPipedreamMcpServers = vi
      .fn<() => Promise<PipedreamAgentReloadOutcome>>()
      .mockRejectedValue(new Error("private thread ses_reload_secret failed"));
    const handlers = createSupervisorIpcHandlers(
      createRuntime({ pipedreamService, reloadPipedreamMcpServers }),
    );

    const result = await handlers.pipedreamSetAccountAgentAccess({
      accountId: "apn_Account123",
      enabled: true,
    });

    expect(result).toEqual({
      ...SNAPSHOT_WITH_GRANTED_ACCOUNT,
      agentReload: { state: "failed-pending" },
    });
    expect(JSON.stringify(result)).not.toMatch(/thread|ses_reload_secret|private/i);
  });
});
