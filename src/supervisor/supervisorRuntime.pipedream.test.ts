import { describe, expect, it, vi } from "vitest";
import type { PipedreamAgentReloadOutcome, PipedreamSnapshot } from "@/shared/contracts";
import type { PipedreamPrivilegedBootstrapPayload } from "@/shared/pipedreamPrivilegedIpc";
import { SupervisorRuntime } from "./supervisorRuntime";

const PAYLOAD: PipedreamPrivilegedBootstrapPayload = {
  bootstrap: { state: "absent" },
  externalUserId: "y-space-test-user",
};

describe("SupervisorRuntime Pipedream configuration", () => {
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
