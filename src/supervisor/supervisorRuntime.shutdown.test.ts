import { describe, expect, it, vi } from "vitest";

vi.mock("./agents/opencode/sdkClient", () => ({
  shutdownSpawnedOpenCodeServers: vi.fn<() => void>(),
}));
vi.mock("./agents/codex/serverPool", () => ({
  shutdownSpawnedCodexAppServers: vi.fn<() => void>(),
}));

import { SupervisorRuntime } from "./supervisorRuntime";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("SupervisorRuntime shutdown", () => {
  it("closes ingress, awaits subagent teardown, then disposes thread authorities idempotently", async () => {
    const order: string[] = [];
    const childTeardown = deferred();
    const syncStep = (name: string) =>
      vi.fn<() => void>(() => {
        order.push(name);
      });
    const asyncStep = (name: string) =>
      vi.fn<() => Promise<void>>(async () => {
        order.push(name);
      });
    const subagentDispose = vi.fn<() => Promise<void>>(async () => {
      order.push("subagents:start");
      await childTeardown.promise;
      order.push("subagents:done");
    });
    const threadDispose = asyncStep("threads");
    const ingressDispose = syncStep("ingress");
    const runtime = Object.create(SupervisorRuntime.prototype) as SupervisorRuntime;
    Object.assign(runtime as object, {
      disposeWindowsPowerShellPreference: syncStep("powershell"),
      disposeWslCredentialProjectScope: syncStep("wsl-credentials"),
      routingOverridePersistence: { dispose: syncStep("routing") },
      usageService: { stop: syncStep("usage") },
      mcpProbeService: { dispose: syncStep("mcp-probe") },
      mcpOAuthService: { dispose: syncStep("mcp-oauth") },
      pipedreamService: { dispose: asyncStep("pipedream") },
      lspManager: { dispose: syncStep("lsp") },
      _projectWatcher: { dispose: asyncStep("watcher") },
      subagentRunManager: { dispose: subagentDispose },
      threadSessionManager: { dispose: threadDispose },
      skillsService: { dispose: asyncStep("skills") },
      crossagentMcpIngress: { dispose: ingressDispose },
      sharedSettingsCache: { dispose: syncStep("settings") },
      cliHookPluginCoordinator: { dispose: asyncStep("hooks") },
    });

    const first = runtime.disposeAsync();
    const second = runtime.disposeAsync();
    await Promise.resolve();

    expect(subagentDispose).toHaveBeenCalledOnce();
    expect(threadDispose).not.toHaveBeenCalled();
    expect(ingressDispose).toHaveBeenCalledOnce();
    expect(order.indexOf("ingress")).toBeLessThan(order.indexOf("subagents:start"));

    childTeardown.resolve();
    await Promise.all([first, second]);

    expect(order.indexOf("subagents:done")).toBeLessThan(order.indexOf("threads"));
    expect(subagentDispose).toHaveBeenCalledOnce();
    expect(threadDispose).toHaveBeenCalledOnce();
    expect(ingressDispose).toHaveBeenCalledOnce();
  });
});
