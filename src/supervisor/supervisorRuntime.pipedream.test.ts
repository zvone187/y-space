import { describe, expect, it, vi } from "vitest";
import {
  PIPEDREAM_PERSONAL_MCP_URL,
  type PipedreamAgentReloadOutcome,
  type PipedreamSnapshot,
  type ResolvedMcpServer,
} from "@/shared/contracts";
import type { PipedreamPrivilegedBootstrapPayload } from "@/shared/pipedreamPrivilegedIpc";
import { resolveRuntimePipedreamMcpServers, SupervisorRuntime } from "./supervisorRuntime";

const PAYLOAD: PipedreamPrivilegedBootstrapPayload = {
  bootstrap: { state: "absent" },
  externalUserId: "y-space-test-user",
};

describe("SupervisorRuntime Pipedream configuration", () => {
  it.each(["missing", "rejected"] as const)(
    "revokes the exact Personal provider binding when WSL reachability is %s",
    async (failure) => {
      const personal: ResolvedMcpServer = {
        id: "pipedream-personal-mcp",
        name: "pd",
        timeoutMs: 30_000,
        transport: { type: "http", url: PIPEDREAM_PERSONAL_MCP_URL, headers: {} },
      };
      const connect: ResolvedMcpServer = {
        id: "pipedream-connect-gmail",
        name: "gmail",
        timeoutMs: 30_000,
        transport: {
          type: "http",
          url: "http://127.0.0.1:43123/mcp",
          headers: { authorization: "Bearer connect-local" },
        },
      };
      const resolvePersonal = vi.fn<
        Parameters<typeof resolveRuntimePipedreamMcpServers>[1]["resolvePersonal"]
      >(async () => [] as ResolvedMcpServer[]);

      await expect(
        resolveRuntimePipedreamMcpServers(
          {
            threadId: "thread-wsl-personal",
            providerBindingId: "thread:thread-wsl-personal:launch:live",
            projectLocation: {
              kind: "wsl",
              distro: "Ubuntu",
              linuxPath: "/repo",
              uncPath: "\\\\wsl.localhost\\Ubuntu\\repo",
            },
            personalMcpServers: [personal],
          },
          {
            resolveConnect: async () => [connect],
            resolvePersonal,
            resolveWslHostAccess: async () => {
              if (failure === "rejected") throw new Error("WSL reachability failed");
              return undefined;
            },
          },
        ),
      ).resolves.toEqual([connect]);
      expect(resolvePersonal).toHaveBeenCalledExactlyOnceWith({
        servers: [],
        threadId: "thread-wsl-personal",
        providerBindingId: "thread:thread-wsl-personal:launch:live",
      });
    },
  );

  it("reports every Personal URL alias accepted by the launch boundary", () => {
    const personalAlias = "https://ignored:ignored@mcp.pipedream.net./v2/?legacy=1";
    const runtime = Object.assign(Object.create(SupervisorRuntime.prototype) as SupervisorRuntime, {
      sharedSettingsCache: {
        readFresh: () => ({
          mcpServers: [
            {
              id: "pipedream-personal-alias",
              name: "pd",
              description: "Personal Pipedream tools",
              enabled: true,
              timeoutMs: 30_000,
              transport: { type: "http" as const, url: personalAlias, headers: {} },
            },
          ],
        }),
      },
      mcpOAuthService: {
        status: () => ({ authenticatedUrls: [personalAlias] }),
      },
    });

    expect(
      (
        runtime as unknown as {
          readPipedreamPersonalMcpStatus(): { enabled: boolean; authenticated: boolean };
        }
      ).readPipedreamPersonalMcpStatus(),
    ).toEqual({ enabled: true, authenticated: true });
  });

  it.each(["applied", "restart-required", "failed-pending"] as const)(
    "acknowledges privileged configuration only after the %s live-agent reload outcome",
    async (state) => {
      const configure = vi.fn<(payload: PipedreamPrivilegedBootstrapPayload) => void>();
      const getSnapshot = vi.fn<() => PipedreamSnapshot>(() => ({
        personalMcp: { enabled: false, authenticated: false, serverName: "pd" },
        connect: { state: "absent" },
      }));
      const reloadPipedreamMcpServers = vi.fn<() => Promise<PipedreamAgentReloadOutcome>>(
        async () => ({ state }),
      );
      const runtime = Object.assign(
        Object.create(SupervisorRuntime.prototype) as SupervisorRuntime,
        {
          pipedreamService: { configure, getSnapshot },
          threadSessionManager: { reloadPipedreamMcpServers },
        },
      );

      await expect(runtime.configurePipedream(PAYLOAD)).resolves.toEqual({
        personalMcp: { enabled: false, authenticated: false, serverName: "pd" },
        connect: { state: "absent" },
        agentReload: { state },
      });

      expect(configure).toHaveBeenCalledExactlyOnceWith(PAYLOAD);
      expect(reloadPipedreamMcpServers).toHaveBeenCalledOnce();
      expect(getSnapshot).toHaveBeenCalledOnce();
    },
  );

  it("returns failed-pending when the live-agent reload rejects", async () => {
    const runtime = Object.assign(Object.create(SupervisorRuntime.prototype) as SupervisorRuntime, {
      pipedreamService: {
        configure: vi.fn<(payload: PipedreamPrivilegedBootstrapPayload) => void>(),
        getSnapshot: () => ({
          personalMcp: { enabled: false, authenticated: false, serverName: "pd" as const },
          connect: { state: "absent" as const },
        }),
      },
      threadSessionManager: {
        reloadPipedreamMcpServers: vi.fn<() => Promise<PipedreamAgentReloadOutcome>>(async () => {
          throw new Error("reload failed");
        }),
      },
    });

    await expect(runtime.configurePipedream(PAYLOAD)).resolves.toMatchObject({
      agentReload: { state: "failed-pending" },
    });
  });
});
