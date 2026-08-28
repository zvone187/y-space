import { describe, expect, it, vi } from "vitest";
import type {
  McpLaunchSnapshot,
  ProjectLocation,
  ResolvedMcpServer,
  ThreadConfig,
} from "@/shared/contracts";
import { verifyMcpLaunchContextToken } from "@/shared/mcpLaunchContext";
import type { AgentAdapter } from "@/supervisor/agents/base";
import {
  applyAgentSettingsMcpFlags,
  composeResolvedMcpServers,
  effectiveLaunchConfig,
  SpawnPipeline,
  usesProviderSessionCrossagentRouting,
  workspaceLaunchConfig,
} from "./spawnPipeline";

const baseConfig: ThreadConfig = {
  model: "test-model",
  browserMcp: true,
  crossagentMcp: true,
  computerUse: true,
};

describe("effectiveLaunchConfig — single gate for built-in MCP disables", () => {
  it("defaults the embedded Browser on when a launch omits browserMcp", () => {
    expect(effectiveLaunchConfig({ model: "test-model" }, [])).toMatchObject({
      browserMcp: true,
    });
  });

  it("preserves an explicit Browser opt-out", () => {
    expect(effectiveLaunchConfig({ model: "test-model", browserMcp: false }, [])).toMatchObject({
      browserMcp: false,
    });
  });

  it("lets the global Browser hard-disable override the default", () => {
    expect(effectiveLaunchConfig({ model: "test-model" }, ["browser"])).toMatchObject({
      browserMcp: false,
    });
  });

  it("returns the config unchanged when nothing is disabled", () => {
    expect(effectiveLaunchConfig(baseConfig, [])).toBe(baseConfig);
  });

  it("clears only the flags whose built-in server is disabled", () => {
    const result = effectiveLaunchConfig(baseConfig, ["browser", "computer-use"]);
    expect(result).toEqual({
      ...baseConfig,
      browserMcp: false,
      computerUse: false,
    });
  });

  it("clears every flag-mapped server when all are disabled", () => {
    const result = effectiveLaunchConfig(baseConfig, [
      "browser",
      "crossagents",
      "computer-use",
      "app-controls",
    ]);
    expect(result).toEqual({
      ...baseConfig,
      browserMcp: false,
      crossagentMcp: false,
      computerUse: false,
    });
  });

  it("does not mutate the original config", () => {
    effectiveLaunchConfig(baseConfig, ["browser"]);
    expect(baseConfig.browserMcp).toBe(true);
  });

  it("enables MCPs bundled by installed plugins while global disables still win", () => {
    const config = {
      ...baseConfig,
      browserMcp: false,
      crossagentMcp: false,
      computerUse: false,
    };

    expect(
      effectiveLaunchConfig(config, ["computer-use"], ["browser", "crossagents", "computer-use"]),
    ).toEqual({
      ...config,
      browserMcp: true,
      crossagentMcp: true,
      computerUse: false,
    });
  });
});

describe("workspaceLaunchConfig — Home scope unrestricted for every agent", () => {
  const adapter = {
    capabilities: {
      approvalPolicies: [
        { id: "default", label: "Default" },
        { id: "bypassPermissions", label: "Bypass" },
      ],
      sandboxModes: [
        { id: "workspace-write", label: "Workspace" },
        { id: "danger-full-access", label: "Full" },
      ],
      bypassPermissions: { approvalPolicy: "bypassPermissions", sandboxMode: "danger-full-access" },
    },
  };

  it("leaves a repo workspace config unchanged", () => {
    const config = { ...baseConfig, approvalPolicy: "default", sandboxMode: "workspace-write" };
    expect(
      workspaceLaunchConfig({ kind: "windows", path: "C:\\repo" }, config, adapter, []),
    ).toEqual(config);
  });

  it("forces each provider's unrestricted posture in Home", () => {
    const config = { ...baseConfig, approvalPolicy: "default", sandboxMode: "workspace-write" };
    expect(
      workspaceLaunchConfig({ kind: "windows", path: "C:\\Users\\me" }, config, adapter, []),
    ).toEqual({
      ...config,
      approvalPolicy: "bypassPermissions",
      sandboxMode: "danger-full-access",
    });
  });
});

describe("applyAgentSettingsMcpFlags", () => {
  it("maps agentSettings booleans and keeps Crossagents off without trusted routing", () => {
    const result = applyAgentSettingsMcpFlags(baseConfig, { browserMcp: true }, [], false);
    expect(result).toEqual({
      ...baseConfig,
      browserMcp: true,
      computerUse: false,
      crossagentMcp: false,
    });
  });

  it("enables provider-level Crossagents when trusted routing is available", () => {
    const result = applyAgentSettingsMcpFlags(baseConfig, { crossagentMcp: true }, [], true);
    expect(result.crossagentMcp).toBe(true);
  });

  it("keeps globally disabled servers off when provider settings enable them", () => {
    const result = applyAgentSettingsMcpFlags(
      baseConfig,
      { browserMcp: true, crossagentMcp: true, computerUse: true },
      ["browser", "crossagents", "computer-use"],
      true,
    );
    expect(result).toEqual({
      ...baseConfig,
      browserMcp: false,
      computerUse: false,
      crossagentMcp: false,
    });
  });
});

describe("usesProviderSessionCrossagentRouting", () => {
  const adapter = {
    kind: "codex",
    capabilities: {
      presentationMode: "terminal",
      crossagentMcpRouting: "provider-session",
    },
  } as const;

  it("retains provider-session routing for providers with a trusted native caller id", () => {
    expect(usesProviderSessionCrossagentRouting(adapter, "gui", "thread-1")).toBe(true);
  });

  it("keeps isolated OpenCode GUI tasks on their direct thread token", () => {
    expect(
      usesProviderSessionCrossagentRouting(
        {
          kind: "opencode",
          capabilities: {
            presentationMode: "gui",
            crossagentMcpRouting: "thread-token",
          },
        },
        "gui",
        "thread-1",
      ),
    ).toBe(false);
  });

  it("keeps terminal threads on direct routing", () => {
    expect(usesProviderSessionCrossagentRouting(adapter, "terminal", "thread-1")).toBe(false);
    expect(usesProviderSessionCrossagentRouting(adapter, undefined, "thread-1")).toBe(false);
  });

  it("requires a thread id and provider support", () => {
    expect(usesProviderSessionCrossagentRouting(adapter, "gui", undefined)).toBe(false);
    expect(
      usesProviderSessionCrossagentRouting(
        { capabilities: { presentationMode: "gui" } },
        "gui",
        "thread-1",
      ),
    ).toBe(false);
  });
});

describe("resolveMcpServersForLaunch — provider-owned MCP identity", () => {
  it("keeps OpenCode terminal Browser calls bound to their concrete thread", async () => {
    const previousUrl = process.env.PORACODE_BROWSER_MCP_URL;
    const previousToken = process.env.PORACODE_BROWSER_MCP_TOKEN;
    process.env.PORACODE_BROWSER_MCP_URL = "http://127.0.0.1:43210";
    process.env.PORACODE_BROWSER_MCP_TOKEN = "browser-token";

    try {
      const pipeline = new SpawnPipeline({
        options: {},
        resolveAgentSettings: () => ({ browserMcp: true }),
      } as unknown as ConstructorParameters<typeof SpawnPipeline>[0]);
      const adapter = {
        kind: "opencode",
        capabilities: {
          presentationMode: "terminal",
          mcpConfigSource: "agentSettings",
          crossagentMcpRouting: "thread-token",
        },
      } as unknown as AgentAdapter;

      const servers = await pipeline.resolveMcpServersForLaunch({
        location: { kind: "posix", path: "/repo" },
        config: { model: "opencode/big-pickle" },
        mcpLaunchSnapshot: { mcpServers: [], disabledBuiltInMcpServerIds: [] },
        identity: { threadId: "thread-terminal", title: "Terminal caller" },
        crossagentThreadId: "thread-terminal",
        adapter,
        presentationMode: "terminal",
      });

      const browser = servers.find((server) => server.id === "browser");
      expect(browser?.transport.type).toBe("http");
      if (browser?.transport.type !== "http") throw new Error("Browser MCP was not resolved.");
      const url = new URL(browser.transport.url);
      expect(url.searchParams.get("thread")).toBeNull();
      expect(url.searchParams.get("title")).toBeNull();
      const authorization = browser.transport.headers.Authorization;
      expect(authorization).toMatch(/^Bearer /u);
      expect(
        verifyMcpLaunchContextToken(
          "browser-token",
          "browser",
          authorization?.replace(/^Bearer /u, "") ?? "",
        ),
      ).toEqual({
        routing: "thread",
        identity: { threadId: "thread-terminal", title: "Terminal caller" },
      });
    } finally {
      if (previousUrl === undefined) delete process.env.PORACODE_BROWSER_MCP_URL;
      else process.env.PORACODE_BROWSER_MCP_URL = previousUrl;
      if (previousToken === undefined) delete process.env.PORACODE_BROWSER_MCP_TOKEN;
      else process.env.PORACODE_BROWSER_MCP_TOKEN = previousToken;
    }
  });

  it("keeps OpenCode GUI Browser calls bound to their concrete Y Space task", async () => {
    const previousUrl = process.env.PORACODE_BROWSER_MCP_URL;
    const previousToken = process.env.PORACODE_BROWSER_MCP_TOKEN;
    process.env.PORACODE_BROWSER_MCP_URL = "http://127.0.0.1:43211";
    process.env.PORACODE_BROWSER_MCP_TOKEN = "browser-gui-token";

    try {
      const pipeline = new SpawnPipeline({
        options: {},
        resolveAgentSettings: () => ({ browserMcp: true }),
      } as unknown as ConstructorParameters<typeof SpawnPipeline>[0]);
      const adapter = {
        kind: "opencode",
        capabilities: {
          presentationMode: "gui",
          mcpConfigSource: "agentSettings",
          crossagentMcpRouting: "thread-token",
        },
      } as unknown as AgentAdapter;

      const servers = await pipeline.resolveMcpServersForLaunch({
        location: { kind: "posix", path: "/repo/shared" },
        config: { model: "opencode/big-pickle" },
        mcpLaunchSnapshot: { mcpServers: [], disabledBuiltInMcpServerIds: [] },
        identity: { threadId: "thread-gui", title: "GUI caller" },
        crossagentThreadId: "thread-gui",
        adapter,
        presentationMode: "gui",
      });

      const browser = servers.find((server) => server.id === "browser");
      if (browser?.transport.type !== "http") throw new Error("Browser MCP was not resolved.");
      expect(
        verifyMcpLaunchContextToken(
          "browser-gui-token",
          "browser",
          browser.transport.headers.Authorization?.replace(/^Bearer /u, "") ?? "",
        ),
      ).toEqual({
        routing: "thread",
        identity: { threadId: "thread-gui", title: "GUI caller" },
      });
    } finally {
      if (previousUrl === undefined) delete process.env.PORACODE_BROWSER_MCP_URL;
      else process.env.PORACODE_BROWSER_MCP_URL = previousUrl;
      if (previousToken === undefined) delete process.env.PORACODE_BROWSER_MCP_TOKEN;
      else process.env.PORACODE_BROWSER_MCP_TOKEN = previousToken;
    }
  });

  it("registers isolated OpenCode GUI Crossagents with a direct thread token", async () => {
    const register = vi.fn<
      (
        threadId: string,
        disabledTools: readonly string[],
      ) => {
        url: string;
        token: string;
        headers: Record<string, string>;
        disabledTools: string[];
      }
    >(() => ({
      url: "http://127.0.0.1:43212/mcp",
      token: "thread-crossagents-token",
      headers: { Authorization: "Bearer thread-crossagents-token" },
      disabledTools: [],
    }));
    const registerProviderSession =
      vi.fn<(threadId: string, disabledTools: readonly string[]) => undefined>();
    const pipeline = new SpawnPipeline({
      options: {
        crossagentMcp: {
          register,
          registerProviderSession,
          unregister: vi.fn<(threadId: string) => void>(),
        },
      },
      resolveAgentSettings: () => ({ crossagentMcp: true }),
    } as unknown as ConstructorParameters<typeof SpawnPipeline>[0]);
    const adapter = {
      kind: "opencode",
      capabilities: {
        presentationMode: "gui",
        mcpConfigSource: "agentSettings",
        crossagentMcpRouting: "thread-token",
      },
    } as unknown as AgentAdapter;

    const servers = await pipeline.resolveMcpServersForLaunch({
      location: { kind: "posix", path: "/repo/shared" },
      config: { model: "opencode/big-pickle" },
      mcpLaunchSnapshot: { mcpServers: [], disabledBuiltInMcpServerIds: [] },
      identity: { threadId: "thread-gui", title: "GUI caller" },
      crossagentThreadId: "thread-gui",
      adapter,
      presentationMode: "gui",
    });

    expect(register).toHaveBeenCalledWith("thread-gui", []);
    expect(registerProviderSession).not.toHaveBeenCalled();
    expect(servers.find((server) => server.id === "crossagents")?.transport).toEqual({
      type: "http",
      url: "http://127.0.0.1:43212/mcp",
      headers: { Authorization: "Bearer thread-crossagents-token" },
    });
  });

  it("uses a stable same-directory Pipedream binding for OpenCode GUI reloads", async () => {
    const resolvePipedreamMcpServers = vi.fn<
      (input: {
        threadId: string;
        providerBindingId?: string;
        projectLocation: ProjectLocation;
      }) => Promise<ResolvedMcpServer[]>
    >(async () => []);
    const pipeline = new SpawnPipeline({
      options: { resolvePipedreamMcpServers },
      resolveAgentSettings: () => ({}),
    } as unknown as ConstructorParameters<typeof SpawnPipeline>[0]);
    const adapter = {
      kind: "opencode",
      capabilities: {
        presentationMode: "gui",
        mcpConfigSource: "agentSettings",
        crossagentMcpRouting: "thread-token",
      },
    } as unknown as AgentAdapter;
    const location = { kind: "posix" as const, path: "/repo" };
    const input = {
      location,
      config: { model: "opencode/model" },
      mcpLaunchSnapshot: {
        mcpServers: [],
        disabledBuiltInMcpServerIds: ["browser", "crossagents", "computer-use", "app-controls"],
      } satisfies McpLaunchSnapshot,
      crossagentThreadId: "thread-a",
      adapter,
      presentationMode: "gui" as const,
    };

    await pipeline.resolveMcpServersForLaunch({
      ...input,
      identity: { threadId: "thread-a" },
    });
    await pipeline.resolveMcpServersForLaunch({
      ...input,
      crossagentThreadId: "thread-b",
      identity: { threadId: "thread-b" },
    });

    const first = resolvePipedreamMcpServers.mock.calls[0]?.[0];
    const second = resolvePipedreamMcpServers.mock.calls[1]?.[0];
    expect(first).toMatchObject({ threadId: "thread-a", projectLocation: location });
    expect(second).toMatchObject({ threadId: "thread-b", projectLocation: location });
    expect(first?.providerBindingId).toMatch(/^opencode-gui:/u);
    expect(second?.providerBindingId).toBe(first?.providerBindingId);
  });
});

describe("composeResolvedMcpServers", () => {
  it("combines custom and built-in servers before the provider boundary", () => {
    const servers = composeResolvedMcpServers(
      {
        mcpServers: [
          {
            id: "custom",
            name: "custom",
            description: "",
            enabled: true,
            timeoutMs: 15_000,
            transport: { type: "stdio", command: "custom", args: [], env: {} },
          },
        ],
        disabledBuiltInMcpServerIds: [],
      },
      { url: "http://browser/mcp", token: "b", headers: { Authorization: "Bearer b" } },
      { url: "http://agents/mcp", token: "a", headers: { Authorization: "Bearer a" } },
      undefined,
      undefined,
    );

    expect(servers.map((server) => server.name)).toEqual(["custom", "browser", "crossagents"]);
    expect(servers[2]).toMatchObject({ timeoutMs: 300_000, approvalMode: "approve" });
  });
});
