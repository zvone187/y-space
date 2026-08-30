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

  it("forces the embedded Browser on despite a per-launch opt-out", () => {
    expect(effectiveLaunchConfig({ model: "test-model", browserMcp: false }, [])).toMatchObject({
      browserMcp: true,
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

  it("does not force Browser on for an adapter without exclusive Browser routing", () => {
    const config: ThreadConfig = { model: "cursor/model" };
    expect(workspaceLaunchConfig({ kind: "windows", path: "C:\\repo" }, config, adapter, [])).toBe(
      config,
    );
  });

  it("forces Browser on for adapters that implement exclusive Browser routing", () => {
    const config: ThreadConfig = { model: "codex/model", browserMcp: false };
    const exclusiveAdapter = {
      ...adapter,
      browserRouting: { terminal: "exclusive", gui: "exclusive" },
    } as const;
    expect(
      workspaceLaunchConfig({ kind: "windows", path: "C:\\repo" }, config, exclusiveAdapter, []),
    ).toMatchObject({ browserMcp: true });
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

  it("keeps Browser on when provider settings opt out unless it is globally disabled", () => {
    expect(applyAgentSettingsMcpFlags(baseConfig, { browserMcp: false }, [], false)).toMatchObject({
      browserMcp: true,
    });
    expect(
      applyAgentSettingsMcpFlags(baseConfig, { browserMcp: false }, ["browser"], false),
    ).toMatchObject({ browserMcp: false });
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
  it("fails closed on native and WSL launches when mandatory Browser cannot connect", async () => {
    const previousUrl = process.env.PORACODE_BROWSER_MCP_URL;
    const previousToken = process.env.PORACODE_BROWSER_MCP_TOKEN;
    delete process.env.PORACODE_BROWSER_MCP_URL;
    delete process.env.PORACODE_BROWSER_MCP_TOKEN;
    const pipeline = new SpawnPipeline({
      options: {},
      resolveAgentSettings: () => ({ browserMcp: true }),
    } as unknown as ConstructorParameters<typeof SpawnPipeline>[0]);
    const snapshot: McpLaunchSnapshot = { mcpServers: [], disabledBuiltInMcpServerIds: [] };

    try {
      await expect(
        pipeline.resolveBrowserMcpForLaunch(
          { kind: "posix", path: "/repo" },
          { model: "test-model", browserMcp: true },
          snapshot,
          { threadId: "native-thread" },
        ),
      ).rejects.toThrow(/Y Space Browser.{0,80}(?:required|unavailable)/iu);
      await expect(
        pipeline.resolveBrowserMcpForLaunch(
          {
            kind: "wsl",
            distro: "Ubuntu",
            linuxPath: "/repo",
            uncPath: "\\\\wsl.localhost\\Ubuntu\\repo",
          },
          { model: "test-model", browserMcp: true },
          snapshot,
          { threadId: "wsl-thread" },
        ),
      ).rejects.toThrow(/Y Space Browser.{0,80}(?:required|unavailable)/iu);
    } finally {
      if (previousUrl === undefined) delete process.env.PORACODE_BROWSER_MCP_URL;
      else process.env.PORACODE_BROWSER_MCP_URL = previousUrl;
      if (previousToken === undefined) delete process.env.PORACODE_BROWSER_MCP_TOKEN;
      else process.env.PORACODE_BROWSER_MCP_TOKEN = previousToken;
    }
  });

  it("permits an absent Browser only when explicitly disabled", async () => {
    const pipeline = new SpawnPipeline({
      options: {},
      resolveAgentSettings: () => ({ browserMcp: true }),
    } as unknown as ConstructorParameters<typeof SpawnPipeline>[0]);
    const location = { kind: "posix" as const, path: "/repo" };
    const identity = { threadId: "disabled-browser-thread" };

    await expect(
      pipeline.resolveBrowserMcpForLaunch(
        location,
        { model: "test-model", browserMcp: false },
        { mcpServers: [], disabledBuiltInMcpServerIds: [] },
        identity,
      ),
    ).resolves.toBeUndefined();
    await expect(
      pipeline.resolveBrowserMcpForLaunch(
        location,
        { model: "test-model", browserMcp: true },
        { mcpServers: [], disabledBuiltInMcpServerIds: ["browser"] },
        identity,
      ),
    ).resolves.toBeUndefined();
  });

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
        label: "OpenCode",
        browserRouting: { terminal: "exclusive", gui: "exclusive" },
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
        label: "OpenCode",
        browserRouting: { terminal: "exclusive", gui: "exclusive" },
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
      mcpLaunchSnapshot: { mcpServers: [], disabledBuiltInMcpServerIds: ["browser"] },
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

  it("fails closed before launch resolution when an agent mode is not Browser-exclusive", async () => {
    const pipeline = new SpawnPipeline({
      options: {},
      resolveAgentSettings: () => ({}),
    } as unknown as ConstructorParameters<typeof SpawnPipeline>[0]);
    const unsupported = {
      kind: "cursor",
      label: "Cursor",
      capabilities: { presentationMode: "terminal" },
    } as unknown as AgentAdapter;

    await expect(
      pipeline.resolveMcpServersForLaunch({
        location: { kind: "posix", path: "/repo" },
        config: { model: "cursor/model", browserMcp: true },
        mcpLaunchSnapshot: { mcpServers: [], disabledBuiltInMcpServerIds: [] },
        identity: { threadId: "unsupported-thread" },
        adapter: unsupported,
        presentationMode: "terminal",
      }),
    ).rejects.toThrow(/does not provide an exclusive embedded Browser connection/iu);

    const terminalOnly = {
      ...unsupported,
      browserRouting: { terminal: "exclusive" },
    } as unknown as AgentAdapter;
    await expect(
      pipeline.resolveMcpServersForLaunch({
        location: { kind: "posix", path: "/repo" },
        config: { model: "cursor/model", browserMcp: true },
        mcpLaunchSnapshot: { mcpServers: [], disabledBuiltInMcpServerIds: [] },
        identity: { threadId: "wrong-lane-thread" },
        adapter: terminalOnly,
        presentationMode: "gui",
      }),
    ).rejects.toThrow(/does not provide an exclusive embedded Browser connection/iu);
  });

  it("allows an unsupported agent mode only when Browser is globally disabled", async () => {
    const pipeline = new SpawnPipeline({
      options: {},
      resolveAgentSettings: () => ({}),
    } as unknown as ConstructorParameters<typeof SpawnPipeline>[0]);
    const unsupported = {
      kind: "cursor",
      label: "Cursor",
      capabilities: { presentationMode: "terminal" },
    } as unknown as AgentAdapter;

    await expect(
      pipeline.resolveMcpServersForLaunch({
        location: { kind: "posix", path: "/repo" },
        config: { model: "cursor/model", browserMcp: false },
        mcpLaunchSnapshot: { mcpServers: [], disabledBuiltInMcpServerIds: ["browser"] },
        identity: { threadId: "browser-disabled-thread" },
        adapter: unsupported,
        presentationMode: "terminal",
      }),
    ).resolves.not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "browser" })]));
  });

  it("filters browser-driving Pipedream servers after adding the canonical Y Space Browser", async () => {
    const previousUrl = process.env.PORACODE_BROWSER_MCP_URL;
    const previousToken = process.env.PORACODE_BROWSER_MCP_TOKEN;
    process.env.PORACODE_BROWSER_MCP_URL = "http://127.0.0.1:43213";
    process.env.PORACODE_BROWSER_MCP_TOKEN = "browser-pipedream-token";

    try {
      const resolvePipedreamMcpServers = vi.fn<
        (input: {
          threadId: string;
          providerBindingId?: string;
          projectLocation: ProjectLocation;
        }) => Promise<ResolvedMcpServer[]>
      >(async () => [
        {
          id: "pipedream-playwright",
          name: "playwright",
          timeoutMs: 15_000,
          transport: { type: "http", url: "https://playwright.example/mcp", headers: {} },
        },
        {
          id: "pipedream-slack",
          name: "slack",
          timeoutMs: 15_000,
          transport: { type: "http", url: "https://slack.example/mcp", headers: {} },
        },
      ]);
      const prepareMcpToolFilters = vi.fn<
        (
          servers: McpLaunchSnapshot["mcpServers"],
          location: ProjectLocation,
          browserExclusive?: boolean,
        ) => Promise<McpLaunchSnapshot["mcpServers"]>
      >(async (servers) => servers);
      const pipeline = new SpawnPipeline({
        options: { resolvePipedreamMcpServers, prepareMcpToolFilters },
        resolveAgentSettings: () => ({ browserMcp: true }),
      } as unknown as ConstructorParameters<typeof SpawnPipeline>[0]);

      const servers = await pipeline.resolveMcpServersForLaunch({
        location: { kind: "posix", path: "/repo" },
        config: { model: "test-model", browserMcp: true },
        mcpLaunchSnapshot: {
          mcpServers: [],
          disabledBuiltInMcpServerIds: ["crossagents", "computer-use", "app-controls"],
        },
        identity: { threadId: "thread-pipedream-filter" },
      });

      expect(servers.map(({ id }) => id)).toEqual(["browser", "pipedream-slack"]);
      expect(prepareMcpToolFilters).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            id: "pipedream-slack",
            description: "",
            enabled: true,
          }),
        ],
        { kind: "posix", path: "/repo" },
        true,
      );
    } finally {
      if (previousUrl === undefined) delete process.env.PORACODE_BROWSER_MCP_URL;
      else process.env.PORACODE_BROWSER_MCP_URL = previousUrl;
      if (previousToken === undefined) delete process.env.PORACODE_BROWSER_MCP_TOKEN;
      else process.env.PORACODE_BROWSER_MCP_TOKEN = previousToken;
    }
  });

  it("isolates OpenCode GUI Pipedream bindings by task and launch in the same directory", async () => {
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
      identity: { threadId: "thread-a", launchId: "launch-a" },
    });
    await pipeline.resolveMcpServersForLaunch({
      ...input,
      crossagentThreadId: "thread-b",
      identity: { threadId: "thread-b", launchId: "launch-b" },
    });
    await pipeline.resolveMcpServersForLaunch({
      ...input,
      identity: { threadId: "thread-a", launchId: "launch-a-restarted" },
    });

    const first = resolvePipedreamMcpServers.mock.calls[0]?.[0];
    const second = resolvePipedreamMcpServers.mock.calls[1]?.[0];
    const restarted = resolvePipedreamMcpServers.mock.calls[2]?.[0];
    expect(first).toMatchObject({ threadId: "thread-a", projectLocation: location });
    expect(second).toMatchObject({ threadId: "thread-b", projectLocation: location });
    expect(restarted).toMatchObject({ threadId: "thread-a", projectLocation: location });
    expect(first?.providerBindingId).toBe("thread:thread-a:launch:launch-a");
    expect(second?.providerBindingId).toBe("thread:thread-b:launch:launch-b");
    expect(restarted?.providerBindingId).toBe("thread:thread-a:launch:launch-a-restarted");
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

  it("drops competing external browser servers while retaining unrelated MCPs and Y Space Browser", () => {
    const servers = composeResolvedMcpServers(
      {
        mcpServers: [
          {
            id: "playwright-provider",
            name: "playwright",
            description: "Browser automation",
            enabled: true,
            timeoutMs: 15_000,
            transport: {
              type: "stdio",
              command: "npx",
              args: ["-y", "@playwright/mcp@latest"],
              env: {},
            },
          },
          {
            id: "chrome-devtools",
            name: "chrome_devtools",
            description: "Chrome DevTools",
            enabled: true,
            timeoutMs: 15_000,
            transport: { type: "http", url: "http://chrome-mcp.test/mcp", headers: {} },
          },
          ...[
            "puppeteer",
            "selenium",
            "gstack",
            "stagehand",
            "browserbase",
            "browserstack",
            "browserless",
            "firefox",
            "webkit",
            "node_repl",
          ].map((name) => ({
            id: `${name}-external`,
            name,
            description: "External page automation",
            enabled: true,
            timeoutMs: 15_000,
            transport: {
              type: "http" as const,
              url: `https://${name}.test/mcp`,
              headers: {},
            },
          })),
          {
            id: "github",
            name: "github",
            description: "Source control",
            enabled: true,
            timeoutMs: 15_000,
            transport: { type: "http", url: "https://mcp.github.test", headers: {} },
          },
          {
            id: "pipedream",
            name: "pipedream",
            description: "App integrations for projects that may include browser work",
            enabled: true,
            timeoutMs: 15_000,
            transport: {
              type: "stdio",
              command: "node",
              args: ["pipedream-server.js"],
              cwd: "/repo/y-space-browser-default-collapse",
              env: {},
            },
          },
        ],
        disabledBuiltInMcpServerIds: [],
      },
      { url: "http://browser/mcp", token: "b", headers: { Authorization: "Bearer b" } },
      undefined,
      undefined,
      undefined,
    );

    expect(servers.map(({ name }) => name)).toEqual(["github", "pipedream", "browser"]);
    expect(servers.find(({ id }) => id === "browser")?.transport).toMatchObject({
      type: "http",
      url: "http://browser/mcp",
    });

    const hardDisabled = composeResolvedMcpServers(
      {
        mcpServers: [
          {
            id: "playwright-provider",
            name: "playwright",
            description: "Browser automation",
            enabled: true,
            timeoutMs: 15_000,
            transport: {
              type: "stdio",
              command: "npx",
              args: ["-y", "@playwright/mcp@latest"],
              env: {},
            },
          },
          {
            id: "github",
            name: "github",
            description: "Source control",
            enabled: true,
            timeoutMs: 15_000,
            transport: { type: "http", url: "https://mcp.github.test", headers: {} },
          },
        ],
        disabledBuiltInMcpServerIds: ["browser"],
      },
      { url: "http://browser/mcp", token: "b", headers: { Authorization: "Bearer b" } },
      undefined,
      undefined,
      undefined,
    );
    expect(hardDisabled.map(({ name }) => name)).toEqual(["playwright", "github"]);
  });

  it("preserves user browser MCPs when canonical Y Space Browser is unavailable", () => {
    const externalBrowser: McpLaunchSnapshot["mcpServers"][number] = {
      id: "playwright-provider",
      name: "playwright",
      description: "Browser automation",
      enabled: true,
      timeoutMs: 15_000,
      transport: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@playwright/mcp@latest"],
        env: {},
      },
    };

    expect(
      composeResolvedMcpServers(
        { mcpServers: [externalBrowser], disabledBuiltInMcpServerIds: [] },
        undefined,
        undefined,
        undefined,
        undefined,
      ),
    ).toEqual([externalBrowser]);
  });
});

describe("launch-resource cleanup", () => {
  it("cleans argv-owned resources when hook-extra resolution rejects before spawn", async () => {
    const cleanup = vi.fn<() => void>();
    const hookError = new Error("hook extras failed");
    const adapter = {
      kind: "gemini",
      label: "Gemini",
      capabilities: { presentationMode: "terminal", liveInputMode: "terminal" },
      buildLaunchArgv: () => ({ binary: "gemini", args: [], cleanup }),
      buildResumeArgv: () => ({ binary: "gemini", args: [], cleanup }),
    } as unknown as AgentAdapter;
    const pipeline = new SpawnPipeline({
      options: { adapters: new Map([["gemini", adapter]]) },
      sessions: new Map(),
      pendingStartInterrupts: new Set(),
      pendingStartAborts: new Set(),
      closeThread: vi.fn<() => Promise<void>>(async () => {}),
      resolveAgentSettings: () => ({}),
      beginMcpLaunchAuthorization: vi.fn<() => void>(),
      activateMcpLaunchAuthorization: vi.fn<() => void>(),
      revokeMcpLaunchAuthorization: vi.fn<() => void>(),
      emitOptimisticUserMessage: vi.fn<() => string>(() => "unused"),
      cliHookPlugin: {
        resolveCliHookPluginExtras: vi.fn<() => Promise<never>>(async () => {
          throw hookError;
        }),
      },
    } as unknown as ConstructorParameters<typeof SpawnPipeline>[0]);

    await expect(
      pipeline.startThreadInner({
        threadId: "thread-hook-cleanup",
        agentKind: "gemini",
        projectLocation: { kind: "posix", path: "/work/project" },
        config: { model: "gemini-2.5-pro" },
        prompt: "",
        initialSize: { cols: 120, rows: 30 },
        presentationMode: "terminal",
        disabledBuiltInMcpServerIds: ["browser", "crossagents", "computer-use", "app-controls"],
      }),
    ).rejects.toBe(hookError);

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("rejects a provider-declared non-exclusive root mode before creating a session", async () => {
    const createStructuredSession = vi.fn<NonNullable<AgentAdapter["createStructuredSession"]>>(
      async () => undefined,
    );
    const buildLaunchArgv = vi.fn<AgentAdapter["buildLaunchArgv"]>(() => ({
      binary: "cursor",
      args: [],
    }));
    const buildResumeArgv = vi.fn<AgentAdapter["buildResumeArgv"]>(() => ({
      binary: "cursor",
      args: [],
    }));
    const adapter = {
      kind: "cursor",
      label: "Cursor",
      browserRouting: { gui: "exclusive" },
      capabilities: {
        presentationMode: "terminal",
        liveInputMode: "terminal",
      },
      createStructuredSession,
      buildLaunchArgv,
      buildResumeArgv,
    } as unknown as AgentAdapter;
    const pipeline = new SpawnPipeline({
      options: { adapters: new Map([["cursor", adapter]]) },
      sessions: new Map(),
      pendingStartInterrupts: new Set(),
      pendingStartAborts: new Set(),
      closeThread: vi.fn<() => Promise<void>>(async () => {}),
      resolveAgentSettings: () => ({}),
      beginMcpLaunchAuthorization: vi.fn<() => void>(),
      activateMcpLaunchAuthorization: vi.fn<() => void>(),
      revokeMcpLaunchAuthorization: vi.fn<() => void>(),
      emitOptimisticUserMessage: vi.fn<() => string>(() => "unused"),
    } as unknown as ConstructorParameters<typeof SpawnPipeline>[0]);

    await expect(
      pipeline.startThreadInner({
        threadId: "unsupported-root-launch",
        agentKind: "cursor",
        projectLocation: {
          kind: "wsl",
          distro: "Ubuntu",
          linuxPath: "/work/project",
          uncPath: "\\\\wsl.localhost\\Ubuntu\\work\\project",
        },
        config: { model: "cursor/model" },
        prompt: "",
        initialSize: { cols: 120, rows: 30 },
        presentationMode: "terminal",
        disabledBuiltInMcpServerIds: ["crossagents", "computer-use", "app-controls"],
      }),
    ).rejects.toThrow(/does not provide an exclusive embedded Browser connection/iu);

    expect(createStructuredSession).not.toHaveBeenCalled();
    expect(buildLaunchArgv).not.toHaveBeenCalled();
    expect(buildResumeArgv).not.toHaveBeenCalled();
  });

  it("cleans argv-owned resources when pre-launch structured disposal rejects", async () => {
    const cleanup = vi.fn<() => void>();
    const disposeError = new Error("structured dispose failed");
    const dispose = vi.fn<() => Promise<void>>(async () => {
      throw disposeError;
    });
    const adapter = {
      kind: "claude",
      capabilities: {
        presentationMode: "terminal",
        liveInputMode: "terminal",
      },
      createStructuredSession: async () => ({
        launchOptions: {},
        setListener: () => {},
        dispose,
      }),
      buildLaunchArgv: () => ({ binary: "claude", args: [], cleanup }),
      buildResumeArgv: () => ({ binary: "claude", args: [], cleanup }),
    } as unknown as AgentAdapter;
    const pipeline = new SpawnPipeline({
      options: {
        adapters: new Map([["claude", adapter]]),
      },
      sessions: new Map(),
      pendingStartInterrupts: new Set(),
      pendingStartAborts: new Set(),
      closeThread: vi.fn<() => Promise<void>>(async () => {}),
      resolveAgentSettings: () => ({}),
      beginMcpLaunchAuthorization: vi.fn<() => void>(),
      activateMcpLaunchAuthorization: vi.fn<() => void>(),
      revokeMcpLaunchAuthorization: vi.fn<() => void>(),
      emitOptimisticUserMessage: vi.fn<() => string>(() => "unused"),
      cliHookPlugin: {
        resolveCliHookPluginExtras: vi.fn<
          () => Promise<{ env: Record<string, string>; extraArgs: string[] }>
        >(async () => ({ env: {}, extraArgs: [] })),
      },
    } as unknown as ConstructorParameters<typeof SpawnPipeline>[0]);

    await expect(
      pipeline.startThreadInner({
        threadId: "thread-cleanup",
        agentKind: "claude",
        projectLocation: {
          kind: "wsl",
          distro: "Ubuntu",
          linuxPath: "/work/project",
          uncPath: "\\\\wsl.localhost\\Ubuntu\\work\\project",
        },
        config: { model: "claude-sonnet-4-6" },
        prompt: "",
        initialSize: { cols: 120, rows: 30 },
        presentationMode: "terminal",
        disabledBuiltInMcpServerIds: ["browser", "crossagents", "computer-use", "app-controls"],
      }),
    ).rejects.toBe(disposeError);

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
