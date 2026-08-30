import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpThreadIdentity } from "@/shared/browserMcpThread";
import type { BrowserMcpToolCallReport } from "@/shared/browserMcpEvidence";
import { createMcpLaunchContextToken, type McpLaunchContext } from "@/shared/mcpLaunchContext";
import type { StreamableHttpMcpToolCallOutcome } from "../mcp/StreamableHttpMcpIngress";
import { BrowserMcpIngress, type BrowserMcpIngressOptions } from "./BrowserMcpIngress";
import type { BrowserPanelManager } from "./BrowserPanelManager";
import type { ToolContext } from "./mcp/toolRegistry";

let ingress: BrowserMcpIngress | null = null;

afterEach(() => {
  ingress?.dispose();
  ingress = null;
});

function confirmedCursorOverlayEvaluation(expression: string): unknown {
  if (expression.includes('const phase="session-show"')) {
    return {
      ok: true,
      sessionOwned: false,
      screenshotOwnerCount: 0,
      hostCount: 0,
      hiddenHostCount: 0,
      visibleHostCount: 0,
    };
  }
  if (expression.includes('const phase="hide"')) {
    return { ok: true, tokenOwned: true, hostCount: 0, hiddenHostCount: 0 };
  }
  if (expression.includes('const phase="restore"')) {
    return {
      ok: true,
      tokenOwned: false,
      screenshotOwnerCount: 0,
      sessionOwned: false,
      hostCount: 0,
      visibleHostCount: 0,
    };
  }
  if (expression.includes('const phase="path-verify"')) {
    return { ok: true };
  }
  return true;
}

function createSecureCursorSend() {
  const targetBackendNodeId = 700;
  let queriedSelector = "button";
  return vi.fn<(method: string, params?: Record<string, unknown>) => Promise<unknown>>(
    async (method, params) => {
      if (method === "Runtime.evaluate") {
        const expression = String(params?.expression ?? "");
        if (expression.includes('const phase="move"')) {
          return {
            result: {
              type: "object",
              value: {
                ok: true,
                x: 120,
                y: 80,
                startX: 120,
                startY: 80,
                kind: "element",
                reducedMotion: true,
              },
            },
          };
        }
        return { result: { type: "object", value: confirmedCursorOverlayEvaluation(expression) } };
      }
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") {
        queriedSelector = String(params?.selector ?? queriedSelector);
        return { nodeId: 2 };
      }
      if (method === "DOM.describeNode") {
        return {
          node: {
            nodeId: 2,
            backendNodeId: targetBackendNodeId,
            nodeName: queriedSelector.includes("input") ? "INPUT" : "BUTTON",
          },
        };
      }
      if (method === "Page.getFrameTree") {
        return {
          frameTree: {
            frame: {
              id: "main",
              loaderId: "loader-main-1",
              url: "https://example.test/",
            },
          },
        };
      }
      if (method === "Page.createIsolatedWorld") return { executionContextId: 41 };
      if (method === "DOM.resolveNode") {
        return {
          object: {
            objectId: Number(params?.backendNodeId) === targetBackendNodeId ? "target" : "hit",
          },
        };
      }
      if (method === "Runtime.callFunctionOn") {
        const functionDeclaration = String(params?.functionDeclaration ?? "");
        if (functionDeclaration.includes("actual.endsWith")) {
          return { result: { type: "boolean", value: true } };
        }
        if (functionDeclaration.includes("active:activeMatches,editable:editable")) {
          return {
            result: { type: "object", value: { active: true, editable: true, length: 0 } },
          };
        }
        if (functionDeclaration.includes("shadowActiveDescriptor")) {
          return { result: { type: "boolean", value: true } };
        }
        return {
          result: {
            type: "object",
            value: { connected: true, disabled: false, visible: true },
          },
        };
      }
      if (method === "Runtime.releaseObject") return {};
      if (method === "DOM.scrollIntoViewIfNeeded") return {};
      if (method === "DOM.getBoxModel") {
        return {
          model: {
            border: [80, 60, 160, 60, 160, 100, 80, 100],
            width: 80,
            height: 40,
          },
        };
      }
      if (method === "Page.getLayoutMetrics") {
        return {
          cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 900, clientHeight: 700 },
        };
      }
      if (method === "DOM.getNodeForLocation") {
        return { backendNodeId: targetBackendNodeId, frameId: "main" };
      }
      return {};
    },
  );
}

describe("BrowserMcpIngress", () => {
  it("reports only a bounded authoritative HTTP(S) origin and omits page-controlled titles", async () => {
    const onToolCallReport = vi.fn<(report: BrowserMcpToolCallReport) => Promise<void>>(
      async () => undefined,
    );
    ingress = new BrowserMcpIngress({
      resolveLaunchContextIdentity: async (context) => ({
        ...context.identity,
        browserEvidenceTurnId: "turn-safe-report",
      }),
      onToolCallReport,
    });
    let snapshotUrl =
      "https://alice:password@example.test/reset/password?view=grid&code=oauth-code&access_token=secret&reset_token=reset-secret&session_id=session#private-fragment";
    let snapshotTitle = "Reset link for alice@example.test — private-code";
    const tab = {
      tabId: "tab-safe-report",
      snapshot: () => ({
        url: snapshotUrl,
        title: snapshotTitle,
      }),
    };
    ingress.setManagerAccessor(
      () =>
        ({
          getTab: () => tab,
          getActiveTab: () => tab,
          getActiveTabForThread: () => tab,
          recordAutomationTarget: vi.fn<() => void>(),
          ensureTabReady: vi.fn<() => Promise<void>>(async () => undefined),
          rememberTabForThread: vi.fn<() => boolean>(() => true),
          showAutomationCursor: vi.fn<() => Promise<void>>(async () => undefined),
        }) as unknown as BrowserPanelManager,
    );
    const info = await ingress.start();
    const launchToken = createMcpLaunchContextToken(info.token, "browser", {
      threadId: "thread-safe-report",
      launchId: "launch-safe-report",
    });

    const response = await fetch(`${info.url}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${launchToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "get_url",
          arguments: { privatePageText: "never-forward-this" },
        },
      }),
    });

    expect((await response.json()).result.isError).toBeUndefined();
    expect(onToolCallReport).toHaveBeenCalledWith({
      threadId: "thread-safe-report",
      launchId: "launch-safe-report",
      turnId: "turn-safe-report",
      toolName: "get_url",
      success: true,
      occurredAt: expect.any(Number),
      tabId: "tab-safe-report",
      url: "https://example.test",
    });
    const serialized = JSON.stringify(onToolCallReport.mock.calls[0]?.[0]);
    expect(serialized).not.toContain("never-forward-this");
    expect(serialized).not.toContain("oauth-code");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("private-fragment");
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("reset");
    expect(serialized).not.toContain("alice@example.test");
    expect(serialized).not.toContain("private-code");

    snapshotUrl = "http://127.0.0.1:41739/alpha?fixture=1";
    snapshotTitle = "Local fixture content";
    const localhostResponse = await fetch(`${info.url}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${launchToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_url", arguments: {} },
      }),
    });
    expect((await localhostResponse.json()).result.isError).toBeUndefined();
    expect(onToolCallReport.mock.calls[1]?.[0]).toMatchObject({
      url: "http://127.0.0.1:41739",
    });
    expect(onToolCallReport.mock.calls[1]?.[0]).not.toHaveProperty("title");

    for (const unsafeUrl of [
      "file:///Users/alice/private.env",
      "javascript:alert(document.domain)",
      "data:text/html,private-page-content",
      "custom-browser://account/private?token=secret",
      "about:blank",
      "not a url",
    ]) {
      snapshotUrl = unsafeUrl;
      const unsafeResponse = await fetch(`${info.url}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${launchToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: unsafeUrl,
          method: "tools/call",
          params: { name: "get_url", arguments: {} },
        }),
      });
      expect((await unsafeResponse.json()).result.isError).toBeUndefined();
      const unsafeReport = onToolCallReport.mock.calls.at(-1)?.[0];
      expect(unsafeReport).toMatchObject({ tabId: "tab-safe-report" });
      expect(unsafeReport).not.toHaveProperty("url");
      expect(unsafeReport).not.toHaveProperty("title");
    }
  });

  it("binds overlapping tool proof to each request's resolved tab", async () => {
    const onToolCallReport = vi.fn<(report: BrowserMcpToolCallReport) => Promise<void>>(
      async () => undefined,
    );
    ingress = new BrowserMcpIngress({
      resolveLaunchContextIdentity: async (context) => ({
        ...context.identity,
        browserEvidenceTurnId: "turn-concurrent-tabs",
      }),
      onToolCallReport,
    });
    const tabA = {
      tabId: "tab-concurrent-a",
      snapshot: () => ({ url: "https://a.example.test/private/path", title: "A" }),
    };
    const tabB = {
      tabId: "tab-concurrent-b",
      snapshot: () => ({ url: "https://b.example.test/other/path", title: "B" }),
    };
    let activeTab = tabA;
    const reloadAStarted = deferredVoid();
    const releaseReloadA = deferredVoid();
    ingress.setManagerAccessor(
      () =>
        ({
          getTab: (tabId: string) =>
            tabId === tabA.tabId ? tabA : tabId === tabB.tabId ? tabB : null,
          getActiveTab: () => activeTab,
          getActiveTabForThread: () => activeTab,
          rememberTabForThread: vi.fn<(_threadId: string, tabId: string) => boolean>(
            (_threadId, tabId) => {
              activeTab = tabId === tabA.tabId ? tabA : tabB;
              return true;
            },
          ),
          recordAutomationTarget: vi.fn<() => void>(),
          ensureTabReady: vi.fn<() => Promise<void>>(async () => undefined),
          showAutomationCursor: vi.fn<() => Promise<void>>(async () => undefined),
          reload: vi.fn<(tabId: string) => Promise<void>>(async (tabId) => {
            if (tabId !== tabA.tabId) return;
            reloadAStarted.resolve();
            await releaseReloadA.promise;
          }),
        }) as unknown as BrowserPanelManager,
    );
    const info = await ingress.start();
    const launchToken = createMcpLaunchContextToken(info.token, "browser", {
      threadId: "thread-concurrent-tabs",
      launchId: "launch-concurrent-tabs",
    });
    const callReload = async (tabId: string) => {
      const response = await fetch(`${info.url}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${launchToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: tabId,
          method: "tools/call",
          params: { name: "reload", arguments: { tabId } },
        }),
      });
      return (await response.json()) as { result: { isError?: boolean } };
    };

    const pendingA = callReload(tabA.tabId);
    await reloadAStarted.promise;
    let resultB: Awaited<ReturnType<typeof callReload>>;
    try {
      resultB = await callReload(tabB.tabId);
    } finally {
      releaseReloadA.resolve();
    }
    const resultA = await pendingA;
    expect(resultA.result.isError).toBeUndefined();
    expect(resultB.result.isError).toBeUndefined();
    expect(activeTab).toBe(tabB);

    expect(onToolCallReport).toHaveBeenCalledTimes(2);
    expect(onToolCallReport.mock.calls.map(([report]) => report)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolName: "reload",
          success: true,
          tabId: tabA.tabId,
          url: "https://a.example.test",
        }),
        expect.objectContaining({
          toolName: "reload",
          success: true,
          tabId: tabB.tabId,
          url: "https://b.example.test",
        }),
      ]),
    );
  });

  it("does not mint successful proof for a structured screenshot timeout", async () => {
    const onToolCallReport = vi.fn<(report: BrowserMcpToolCallReport) => Promise<void>>(
      async () => undefined,
    );
    ingress = new BrowserMcpIngress({
      resolveLaunchContextIdentity: async (context) => ({
        ...context.identity,
        browserEvidenceTurnId: "turn-screenshot-timeout",
      }),
      onToolCallReport,
    });
    const tab = {
      tabId: "tab-screenshot-timeout",
      snapshot: () => ({ url: "https://timeout.example.test/private", title: "Timeout" }),
      webContents: {
        capturePage: vi.fn<() => Promise<never>>(() => new Promise<never>(() => undefined)),
      },
      cdp: {
        attach: vi.fn<() => Promise<void>>(async () => undefined),
        send: vi.fn<(method: string, params?: Record<string, unknown>) => Promise<unknown>>(
          async (method, params) => {
            if (method === "Page.getFrameTree") {
              return {
                frameTree: {
                  frame: {
                    id: "main",
                    loaderId: "loader-main-1",
                    url: "https://example.test/",
                  },
                },
              };
            }
            if (method === "Page.createIsolatedWorld") return { executionContextId: 41 };
            if (method === "Runtime.evaluate") {
              return {
                result: {
                  type: "object",
                  value: confirmedCursorOverlayEvaluation(String(params?.expression ?? "")),
                },
              };
            }
            return {};
          },
        ),
      },
    };
    ingress.setManagerAccessor(
      () =>
        ({
          getTab: () => tab,
          getActiveTab: () => tab,
          getActiveTabForThread: () => tab,
          rememberTabForThread: vi.fn<() => boolean>(() => true),
          recordAutomationTarget: vi.fn<() => void>(),
          ensureTabReady: vi.fn<() => Promise<void>>(async () => undefined),
          showAutomationCursor: vi.fn<() => Promise<void>>(async () => undefined),
        }) as unknown as BrowserPanelManager,
    );
    const info = await ingress.start();
    const launchToken = createMcpLaunchContextToken(info.token, "browser", {
      threadId: "thread-screenshot-timeout",
      launchId: "launch-screenshot-timeout",
    });
    const response = await fetch(`${info.url}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${launchToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "screenshot",
          arguments: { tabId: tab.tabId, timeoutMs: 200 },
        },
      }),
    });
    const body = (await response.json()) as {
      result: { content: Array<{ text?: string }>; isError?: boolean };
    };

    expect(body.result.isError).toBeUndefined();
    expect(body.result.content[0]?.text).toContain('"timedOut": true');
    expect(onToolCallReport).toHaveBeenCalledWith({
      threadId: "thread-screenshot-timeout",
      launchId: "launch-screenshot-timeout",
      turnId: "turn-screenshot-timeout",
      toolName: "screenshot",
      success: false,
      occurredAt: expect.any(Number),
    });
  });

  it("does not mint successful proof for an ambiguous native input result", async () => {
    const onToolCallReport = vi.fn<(report: BrowserMcpToolCallReport) => Promise<void>>(
      async () => undefined,
    );
    const options: BrowserMcpIngressOptions = {
      resolveLaunchContextIdentity: async (context) => context.identity,
      onToolCallReport,
    };
    ingress = new BrowserMcpIngress(options);
    const tab = {
      tabId: "tab-ambiguous-input",
      snapshot: () => ({ url: "https://ambiguous.example.test/private", title: "Ambiguous" }),
    };
    const manager = {
      getTab: () => tab,
    } as unknown as BrowserPanelManager;
    const reportToolCall = (
      ingress as unknown as {
        reportToolCall(
          ingressOptions: BrowserMcpIngressOptions,
          outcome: StreamableHttpMcpToolCallOutcome,
          ctx: ToolContext,
          identity: McpThreadIdentity,
        ): Promise<void>;
      }
    ).reportToolCall.bind(ingress);

    await reportToolCall(
      options,
      {
        name: "click",
        occurredAt: 1234,
        success: true,
        rawResult: {
          ok: false,
          ambiguous: true,
          transportRejected: true,
          reason: "pointer-release-rejected",
        },
      },
      {
        manager,
        allowEval: false,
        allowDataAccess: false,
        resolvedTabIdForToolCall: tab.tabId,
      },
      {
        threadId: "thread-ambiguous-input",
        launchId: "launch-ambiguous-input",
        browserEvidenceTurnId: "turn-ambiguous-input",
      },
    );

    expect(onToolCallReport).toHaveBeenCalledWith({
      threadId: "thread-ambiguous-input",
      launchId: "launch-ambiguous-input",
      turnId: "turn-ambiguous-input",
      toolName: "click",
      success: false,
      occurredAt: 1234,
    });
  });

  it("normalizes executed tool aliases before reporting canonical Browser proof", async () => {
    const onToolCallReport = vi.fn<(report: BrowserMcpToolCallReport) => Promise<void>>(
      async () => undefined,
    );
    const options: BrowserMcpIngressOptions = {
      resolveLaunchContextIdentity: async (context) => context.identity,
      onToolCallReport,
    };
    ingress = new BrowserMcpIngress(options);
    const tab = {
      tabId: "tab-alias-proof",
      snapshot: () => ({ url: "https://aliases.example.test/private", title: "Aliases" }),
    };
    const manager = {
      getTab: () => tab,
    } as unknown as BrowserPanelManager;
    const reportToolCall = (
      ingress as unknown as {
        reportToolCall(
          ingressOptions: BrowserMcpIngressOptions,
          outcome: StreamableHttpMcpToolCallOutcome,
          ctx: ToolContext,
          identity: McpThreadIdentity,
        ): Promise<void>;
      }
    ).reportToolCall.bind(ingress);
    const identity = {
      threadId: "thread-alias-proof",
      launchId: "launch-alias-proof",
      browserEvidenceTurnId: "turn-alias-proof",
    };
    const ctx: ToolContext = {
      manager,
      allowEval: false,
      allowDataAccess: false,
      resolvedTabIdForToolCall: tab.tabId,
    };

    for (const [alias, canonical] of [
      ["goto", "navigate"],
      ["key", "press"],
      ["keyboard_type", "type"],
    ] as const) {
      await reportToolCall(
        options,
        { name: alias, occurredAt: 1234, success: true, rawResult: { ok: true } },
        ctx,
        identity,
      );
      expect(onToolCallReport).toHaveBeenLastCalledWith(
        expect.objectContaining({
          toolName: canonical,
          success: true,
          tabId: tab.tabId,
          url: "https://aliases.example.test",
        }),
      );
    }
  });

  it("reports Browser failures without tab metadata", async () => {
    const onToolCallReport = vi.fn<(report: BrowserMcpToolCallReport) => Promise<void>>(
      async () => undefined,
    );
    ingress = new BrowserMcpIngress({
      resolveLaunchContextIdentity: async (context) => ({
        ...context.identity,
        browserEvidenceTurnId: "turn-failed-report",
      }),
      onToolCallReport,
    });
    ingress.setManagerAccessor(
      () =>
        ({
          getActiveTabForThread: () => null,
          getActiveTab: () => null,
          reload: vi.fn<() => Promise<never>>(async () => {
            throw new Error("reload failed");
          }),
          getTab: () => null,
          createTab: vi.fn<() => Promise<{ tabId: string }>>(async () => ({ tabId: "unused" })),
          touchAutomationSession: vi.fn<() => void>(),
          recordAutomationTarget: vi.fn<() => void>(),
          showAutomationCursor: vi.fn<() => Promise<void>>(async () => undefined),
        }) as unknown as BrowserPanelManager,
    );
    const info = await ingress.start();
    const launchToken = createMcpLaunchContextToken(info.token, "browser", {
      threadId: "thread-failed-report",
      launchId: "launch-failed-report",
    });
    const response = await fetch(`${info.url}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${launchToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "reload", arguments: {} },
      }),
    });

    expect((await response.json()).result.isError).toBe(true);
    expect(onToolCallReport).toHaveBeenCalledWith({
      threadId: "thread-failed-report",
      launchId: "launch-failed-report",
      turnId: "turn-failed-report",
      toolName: "reload",
      success: false,
      occurredAt: expect.any(Number),
    });
  });

  it("advertises browser instructions and API discovery on initialize", async () => {
    ingress = new BrowserMcpIngress({
      resolveLaunchContextIdentity: async (context) => context.identity,
    });
    const info = await ingress.start();
    const launchToken = createMcpLaunchContextToken(info.token, "browser", {
      threadId: "thread-initialize",
    });

    const response = await fetch(`${info.url}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${launchToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
    });

    const body = (await response.json()) as {
      result: {
        serverInfo: { name: string };
        instructions: string;
      };
    };

    expect(body.result.serverInfo.name).toBe("browser");
    expect(body.result.instructions).toContain("Y Space Browser is the only browser route");
    expect(body.result.instructions).toContain("Never claim that you verified");
    expect(body.result.instructions).toContain("exact tab id");
    expect(body.result.instructions).toContain("browser.enable");
    expect(body.result.instructions).toContain("browser.disable");
    expect(body.result.instructions).toContain("browser.api");
    expect(body.result.instructions).toContain("@e refs");
  });

  it("keeps signed tab ownership authoritative over a forged provider session id", async () => {
    const resolveLaunchContextIdentity = vi.fn<
      (context: McpLaunchContext) => Promise<McpLaunchContext["identity"] | undefined>
    >(async (context) =>
      context.identity.threadId === "thread-browser" ? context.identity : undefined,
    );
    const RoutedBrowserMcpIngress = BrowserMcpIngress as unknown as new (options: {
      resolveLaunchContextIdentity(
        context: McpLaunchContext,
      ): Promise<{ threadId?: string; title?: string } | undefined>;
    }) => BrowserMcpIngress;
    ingress = new RoutedBrowserMcpIngress({ resolveLaunchContextIdentity });
    const createTab = vi.fn<
      (
        payload: Record<string, unknown>,
        options: Record<string, unknown>,
      ) => Promise<{
        tabId: string;
        url: string;
        title: string;
        loading: boolean;
        canGoBack: boolean;
        canGoForward: boolean;
        devToolsOpen: boolean;
      }>
    >(async () => ({
      tabId: "tab-routed",
      url: "https://example.test",
      title: "Example",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      devToolsOpen: false,
    }));
    ingress.setManagerAccessor(
      () =>
        ({
          createTab,
          getActiveTab: () => null,
          getActiveTabForThread: () => null,
          touchAutomationSession: vi.fn<() => void>(),
          recordAutomationTarget: vi.fn<() => void>(),
          showAutomationCursor: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
        }) as unknown as BrowserPanelManager,
    );
    const info = await ingress.start();
    const launchToken = createMcpLaunchContextToken(info.token, "browser", {
      threadId: "thread-browser",
      title: "Browser caller",
    });

    const response = await fetch(`${info.url}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${launchToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "new_tab",
          arguments: {
            __poracode_provider_session_id: "session-browser",
            url: "https://example.test",
          },
        },
      }),
    });
    const body = (await response.json()) as { result: { isError?: boolean } };

    expect(body.result.isError).toBeUndefined();
    expect(resolveLaunchContextIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: { threadId: "thread-browser", title: "Browser caller" },
      }),
    );
    expect(createTab).toHaveBeenCalledWith(
      { url: "https://example.test", activate: true },
      {
        agent: true,
        threadId: "thread-browser",
        threadTitle: "Browser caller",
      },
    );
  });

  it("routes MCP reload, get_url, and fill through the browser panel tab", async () => {
    ingress = new BrowserMcpIngress({
      resolveLaunchContextIdentity: async (context) => context.identity,
    });
    const send = createSecureCursorSend();
    const presentationLease = {
      requestId: "9a0bdd8c-34c7-4248-85df-f941e3f0de2c",
      tabId: "tab-1",
      surface: "main" as const,
      revision: 1,
    };
    const presentAutomationTarget = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValue(presentationLease);
    const setAutomationSession = vi.fn<() => boolean>().mockReturnValue(true);
    const tab = {
      tabId: "tab-1",
      snapshot: () => ({ url: "https://example.test/page", title: "Example Page" }),
      webContents: {
        focus: vi.fn<() => void>(),
        isFocused: vi.fn<() => boolean>().mockReturnValue(true),
        isDestroyed: vi.fn<() => boolean>().mockReturnValue(false),
        sendInputEvent: vi.fn<(event: Electron.KeyboardInputEvent) => void>(),
        insertText: vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined),
        executeJavaScript: vi
          .fn<(script: string, userGesture?: boolean) => Promise<unknown>>()
          .mockResolvedValue(true),
      },
      cdp: {
        attach: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
        send,
      },
    };
    ingress.setManagerAccessor(
      () =>
        ({
          presentAutomationTarget,
          validateAutomationPresentation: vi.fn<() => boolean>().mockReturnValue(true),
          snapshot: () => ({
            tabs: [
              {
                tabId: "tab-1",
                url: "https://example.test/page",
                title: "Example Page",
                loading: false,
                canGoBack: false,
                canGoForward: false,
                devToolsOpen: false,
              },
            ],
            activeTabId: "tab-1",
          }),
          getActiveTab: () => tab,
          getActiveTabForThread: () => tab,
          rememberTabForThread: vi.fn<() => boolean>().mockReturnValue(true),
          getTab: () => tab,
          ensureTabReady: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
          createTab: vi.fn<() => Promise<unknown>>().mockResolvedValue({ tabId: "tab-1" }),
          setAutomationSession,
          touchAutomationSession: vi.fn<() => void>(),
          recordAutomationTarget: vi.fn<() => void>(),
          showAutomationCursor: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
          reload: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
        }) as unknown as BrowserPanelManager,
    );
    const info = await ingress.start();
    const launchToken = createMcpLaunchContextToken(info.token, "browser", {
      threadId: "thread-browser-test",
      launchId: "launch-browser-test",
    });

    const callTool = async (name: string, args: Record<string, unknown>) => {
      const response = await fetch(`${info.url}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${launchToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: name,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      return (await response.json()) as {
        result: { content: Array<{ type: "text"; text: string }>; isError?: boolean };
      };
    };

    const api = await callTool("api", {});
    expect(api.result.isError).toBeUndefined();

    const reload = await callTool("reload", {});
    expect(reload.result.isError).toBeUndefined();
    await expect(callTool("get_url", {})).resolves.toMatchObject({
      result: { content: [{ type: "text", text: '{\n  "url": "https://example.test/page"\n}' }] },
    });
    expect(presentAutomationTarget).not.toHaveBeenCalled();
    const fill = await callTool("fill", { selector: "input", text: "hello", submit: true });
    expect(fill.result.isError).toBeUndefined();
    const click = await callTool("click", { selector: "button" });
    expect(click.result.isError).toBeUndefined();
    const type = await callTool("type", { selector: "input", text: "hello" });
    expect(type.result.isError).toBeUndefined();
    const press = await callTool("press", { selector: "input", key: "Enter" });
    expect(press.result.isError).toBeUndefined();

    // Passive calls remain headless, while each pointer-bearing action presents
    // the exact first-class Browser page under its launch-scoped lease.
    expect(presentAutomationTarget).toHaveBeenCalledTimes(4);
    expect(presentAutomationTarget).toHaveBeenCalledWith("tab-1");
    expect(setAutomationSession).toHaveBeenCalledWith("launch:launch-browser-test", true);
    expect(
      (presentAutomationTarget as unknown as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
    ).toBeGreaterThan(0);
    expect(tab.webContents.insertText).toHaveBeenCalledWith("hello");
    expect(send.mock.calls.some(([method]) => method === "Input.insertText")).toBe(false);
    expect(send.mock.calls.some(([method]) => method === "Input.dispatchKeyEvent")).toBe(false);
    expect(send).toHaveBeenCalledWith(
      "Input.dispatchMouseEvent",
      expect.objectContaining({ type: "mousePressed", x: 120, y: 80 }),
    );
    expect(send).toHaveBeenCalledWith("DOM.focus", { backendNodeId: 700 });
    expect(send).toHaveBeenCalledWith("Page.createIsolatedWorld", {
      frameId: "main",
      worldName: "y-space-agent-cursor-v1",
    });
    expect(send.mock.calls.some(([method]) => method === "Runtime.callFunctionOn")).toBe(true);
    expect(send.mock.calls.some(([method]) => method === "Runtime.releaseObject")).toBe(true);
    expect(send.mock.calls.some(([method]) => method === "DOM.getNodeForLocation")).toBe(true);
    expect(
      send.mock.calls.some(
        ([method, params]) =>
          method === "Runtime.evaluate" &&
          String(params?.expression ?? "").includes("elementFromPoint"),
      ),
    ).toBe(false);
    expect(tab.webContents.executeJavaScript).not.toHaveBeenCalled();
    expect(tab.webContents.focus).toHaveBeenCalledTimes(3);
    expect(tab.webContents.isFocused).toHaveBeenCalled();
    expect(tab.webContents.sendInputEvent).toHaveBeenCalled();
  });

  it("keeps implicit targets per thread and can find or focus existing tabs", async () => {
    ingress = new BrowserMcpIngress({
      resolveLaunchContextIdentity: async (context) => context.identity,
    });
    const threadTab = {
      tabId: "tab-thread",
      snapshot: () => ({ url: "https://example.test/thread", title: "Thread workspace" }),
    };
    const visibleTab = {
      tabId: "tab-visible",
      snapshot: () => ({ url: "https://other.test/", title: "Other agent" }),
    };
    const setActiveTab = vi.fn<(tabId: string) => void>();
    const rememberTabForThread = vi.fn<() => boolean>(() => true);
    const createTab = vi.fn<() => Promise<Record<string, unknown>>>(async () => ({
      tabId: "tab-created",
      url: "https://new.test/",
      title: "",
    }));
    ingress.setManagerAccessor(
      () =>
        ({
          snapshot: () => ({
            tabs: [
              {
                tabId: "tab-thread",
                url: "https://example.test/thread",
                title: "Thread workspace",
                loading: false,
              },
              {
                tabId: "tab-visible",
                url: "https://other.test/",
                title: "Other agent",
                loading: false,
              },
            ],
            activeTabId: "tab-visible",
            groups: [],
          }),
          getActiveTab: () => visibleTab,
          getActiveTabForThread: () => threadTab,
          getTab: (tabId: string) => (tabId === "tab-thread" ? threadTab : visibleTab),
          ensureTabReady: vi.fn<() => Promise<void>>(async () => undefined),
          touchAutomationSession: vi.fn<() => void>(),
          recordAutomationTarget: vi.fn<() => void>(),
          showAutomationCursor: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
          setActiveTab,
          rememberTabForThread,
          createTab,
        }) as unknown as BrowserPanelManager,
    );
    const info = await ingress.start();
    const launchToken = createMcpLaunchContextToken(info.token, "browser", {
      threadId: "thread-1",
    });
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await fetch(`${info.url}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${launchToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: name,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      return (await response.json()) as {
        result: { isError?: boolean; content: Array<{ text: string }> };
      };
    };

    await expect(call("get_url", {})).resolves.toMatchObject({
      result: { content: [{ text: '{\n  "url": "https://example.test/thread"\n}' }] },
    });
    await expect(call("find_tabs", { query: "workspace" })).resolves.toMatchObject({
      result: {
        content: [expect.objectContaining({ text: expect.stringContaining("tab-thread") })],
      },
    });
    const focused = await call("open_or_focus_tab", { url: "https://example.test/thread" });
    expect(focused.result.isError).toBeUndefined();
    expect(setActiveTab).toHaveBeenCalledWith("tab-thread");
    expect(rememberTabForThread).toHaveBeenCalledWith("thread-1", "tab-thread");
    expect(createTab).not.toHaveBeenCalled();

    const created = await call("open_or_focus_tab", { url: "https://new.test/" });
    expect(created.result.isError).toBeUndefined();
    expect(createTab).toHaveBeenCalledWith(
      { url: "https://new.test/", activate: true },
      expect.objectContaining({ agent: true, threadId: "thread-1" }),
    );
  });
});

function deferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
