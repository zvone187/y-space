import { describe, expect, it, vi } from "vitest";
import type { AgentKind, ResolvedMcpServer } from "@/shared/contracts";
import type { AgentAdapter } from "../../agents/base";
import { type CliHookPluginContext, CliHookSessionCoordinator } from "./cliHookPlugin";

const ySpaceBrowserMcp: ResolvedMcpServer = {
  id: "browser",
  name: "browser",
  timeoutMs: 30_000,
  transport: {
    type: "http",
    url: "http://127.0.0.1:43199/mcp",
    headers: {},
  },
};

function makeAdapter(kind: AgentKind): AgentAdapter {
  return {
    kind,
    label: kind,
    capabilities: {
      liveInputMode: "terminal",
      presentationMode: "terminal",
    },
  } as AgentAdapter;
}

function makeCoordinator(
  adapter: AgentAdapter,
  resolvePluginEnvForSpawn?: (
    input: Parameters<
      NonNullable<
        ConstructorParameters<
          typeof CliHookSessionCoordinator
        >[0]["options"]["resolvePluginEnvForSpawn"]
      >
    >[0],
  ) => Promise<{ env: Record<string, string>; extraArgs: string[] } | undefined>,
): CliHookSessionCoordinator {
  return new CliHookSessionCoordinator({
    sessions: new Map(),
    sessionsBySessionId: new Map(),
    options: {
      adapters: new Map([[adapter.kind, adapter]]),
      ...(resolvePluginEnvForSpawn ? { resolvePluginEnvForSpawn } : {}),
    },
    outputPipeline: {} as never,
    indexSessionRef: vi.fn<CliHookPluginContext["indexSessionRef"]>(),
  });
}

describe("CliHookSessionCoordinator Browser-exclusive provider launches", () => {
  it("fails closed when no hook resolver is wired", async () => {
    const coordinator = makeCoordinator(makeAdapter("codex"));

    await expect(
      coordinator.resolveCliHookPluginExtras(
        "thread-codex-browser",
        "codex",
        { kind: "posix", path: "/repo" },
        [ySpaceBrowserMcp],
      ),
    ).rejects.toThrow(
      "Y Space Browser cannot start Codex safely because its browser-command hook is unavailable.",
    );
  });

  it("fails closed when the resolver returns no hook transport or launch policy", async () => {
    const coordinator = makeCoordinator(makeAdapter("codex"), async () => undefined);

    await expect(
      coordinator.resolveCliHookPluginExtras(
        "thread-codex-browser",
        "codex",
        { kind: "posix", path: "/repo" },
        [ySpaceBrowserMcp],
      ),
    ).rejects.toThrow(
      "Y Space Browser cannot start Codex safely because its browser-command hook is unavailable.",
    );
  });

  it("redacts resolver failures behind the safe launch error", async () => {
    const coordinator = makeCoordinator(makeAdapter("codex"), async () => {
      throw new Error("private-value-sentinel");
    });

    const launch = coordinator.resolveCliHookPluginExtras(
      "thread-codex-browser",
      "codex",
      { kind: "posix", path: "/repo" },
      [ySpaceBrowserMcp],
    );
    await expect(launch).rejects.toThrow(
      "Y Space Browser cannot start Codex safely because its browser-command hook is unavailable.",
    );
    await expect(launch).rejects.not.toThrow("private-value-sentinel");
  });

  it("accepts only the complete app-owned launch-scoped hook gate", async () => {
    const resolved = {
      env: {
        PORACODE_HOOK_URL: "http://127.0.0.1:49123/v1/agent-event",
        PORACODE_HOOK_SECRET: "safe-test-secret",
        PORACODE_HOOK_NONCE: "safe-test-secret",
        PORACODE_HOOK_PROTOCOL_VERSION: "1",
        PORACODE_THREAD_ID: "thread-codex-browser",
        PORACODE_AGENT_KIND: "codex",
        CODEX_HOME: "/private/y-space/agent-plugins/codex/home",
        CODEX_SQLITE_HOME: "/home/demo/.codex",
      },
      extraArgs: ["--dangerously-bypass-hook-trust", "--enable", "hooks"],
    };
    const coordinator = makeCoordinator(makeAdapter("codex"), async () => resolved);

    await expect(
      coordinator.resolveCliHookPluginExtras(
        "thread-codex-browser",
        "codex",
        { kind: "posix", path: "/repo" },
        [ySpaceBrowserMcp],
      ),
    ).resolves.toEqual(resolved);
  });

  it("fails closed for Claude when no terminal PreToolUse hook is available", async () => {
    const coordinator = makeCoordinator(makeAdapter("claude"));

    await expect(
      coordinator.resolveCliHookPluginExtras(
        "thread-claude-browser",
        "claude",
        { kind: "posix", path: "/repo" },
        [ySpaceBrowserMcp],
      ),
    ).rejects.toThrow(
      "Y Space Browser cannot start Claude safely because its browser-command hook is unavailable.",
    );
  });

  it("fails closed for OpenCode when its Browser-exclusive tool hook is unavailable", async () => {
    const coordinator = makeCoordinator(makeAdapter("opencode"));

    await expect(
      coordinator.resolveCliHookPluginExtras(
        "thread-opencode-browser",
        "opencode",
        { kind: "posix", path: "/repo" },
        [ySpaceBrowserMcp],
      ),
    ).rejects.toThrow(
      "Y Space Browser cannot start OpenCode safely because its browser-command hook is unavailable.",
    );
  });

  it("requires Claude's staged settings file in Browser-exclusive terminal mode", async () => {
    const incomplete = {
      env: {
        PORACODE_HOOK_URL: "http://127.0.0.1:49123/v1/agent-event",
        PORACODE_HOOK_SECRET: "safe-test-secret",
        PORACODE_HOOK_NONCE: "safe-test-secret",
        PORACODE_HOOK_PROTOCOL_VERSION: "1",
        PORACODE_THREAD_ID: "thread-claude-browser",
        PORACODE_AGENT_KIND: "claude",
      },
      extraArgs: [],
    };
    const coordinator = makeCoordinator(makeAdapter("claude"), async () => incomplete);

    await expect(
      coordinator.resolveCliHookPluginExtras(
        "thread-claude-browser",
        "claude",
        { kind: "posix", path: "/repo" },
        [ySpaceBrowserMcp],
      ),
    ).rejects.toThrow(
      "Y Space Browser cannot start Claude safely because its browser-command hook is unavailable.",
    );
  });

  it("accepts Claude's complete app-owned terminal hook gate", async () => {
    const resolved = {
      env: {
        PORACODE_HOOK_URL: "http://127.0.0.1:49123/v1/agent-event",
        PORACODE_HOOK_SECRET: "safe-test-secret",
        PORACODE_HOOK_NONCE: "safe-test-secret",
        PORACODE_HOOK_PROTOCOL_VERSION: "1",
        PORACODE_THREAD_ID: "thread-claude-browser",
        PORACODE_AGENT_KIND: "claude",
      },
      extraArgs: ["--settings", "/private/y-space/agent-plugins/claude/settings.json"],
    };
    const coordinator = makeCoordinator(makeAdapter("claude"), async () => resolved);

    await expect(
      coordinator.resolveCliHookPluginExtras(
        "thread-claude-browser",
        "claude",
        { kind: "posix", path: "/repo" },
        [ySpaceBrowserMcp],
      ),
    ).resolves.toEqual(resolved);
  });

  it("preserves L2 degradation for other agents and Codex without Browser", async () => {
    const gemini = makeCoordinator(makeAdapter("gemini"));
    const codex = makeCoordinator(makeAdapter("codex"));

    await expect(
      gemini.resolveCliHookPluginExtras(
        "thread-gemini-browser",
        "gemini",
        { kind: "posix", path: "/repo" },
        [ySpaceBrowserMcp],
      ),
    ).resolves.toEqual({ env: {}, extraArgs: [] });
    await expect(
      codex.resolveCliHookPluginExtras(
        "thread-codex-no-browser",
        "codex",
        { kind: "posix", path: "/repo" },
        [],
      ),
    ).resolves.toEqual({ env: {}, extraArgs: [] });
  });
});
