import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpLaunchContextToken, type McpLaunchContext } from "@/shared/mcpLaunchContext";
import { BrowserMcpIngress } from "./BrowserMcpIngress";
import type { BrowserPanelManager } from "./BrowserPanelManager";

let ingress: BrowserMcpIngress | null = null;

afterEach(() => {
  ingress?.dispose();
  ingress = null;
});

describe("BrowserMcpIngress", () => {
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
    expect(body.result.instructions).toContain("Use the browser MCP server");
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
    const send = vi.fn<(method: string, params?: Record<string, unknown>) => Promise<unknown>>(
      async (method) => {
        if (method === "Runtime.evaluate") {
          return { result: { type: "boolean", value: true } };
        }
        return {};
      },
    );
    const revealPanel = vi.fn<() => void>();
    const tab = {
      tabId: "tab-1",
      snapshot: () => ({ url: "https://example.test/page", title: "Example Page" }),
      webContents: {
        focus: vi.fn<() => void>(),
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
          revealPanel,
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
          setAutomationSession: vi.fn<() => boolean>().mockReturnValue(true),
          touchAutomationSession: vi.fn<() => void>(),
          recordAutomationTarget: vi.fn<() => void>(),
          showAutomationCursor: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
          reload: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
        }) as unknown as BrowserPanelManager,
    );
    const info = await ingress.start();
    const launchToken = createMcpLaunchContextToken(info.token, "browser", {
      threadId: "thread-browser-test",
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
    const fill = await callTool("fill", { selector: "input", text: "hello", submit: true });
    expect(fill.result.isError).toBeUndefined();
    const click = await callTool("click", { selector: "button" });
    expect(click.result.isError).toBeUndefined();
    const type = await callTool("type", { selector: "input", text: "hello" });
    expect(type.result.isError).toBeUndefined();
    const press = await callTool("press", { selector: "input", key: "Enter" });
    expect(press.result.isError).toBeUndefined();

    // Agent tool calls run headless: they must NOT force the browser panel
    // open (the tab's <webview> stays alive off-screen instead).
    expect(revealPanel).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalledWith("Input.insertText", { text: "hello" });
    expect(send.mock.calls.some(([method]) => String(method).startsWith("Input."))).toBe(false);
    expect(tab.webContents.executeJavaScript).toHaveBeenCalled();
    expect(
      tab.webContents.executeJavaScript.mock.calls.some(([script]) =>
        String(script).includes('press("Enter", "input", false)'),
      ),
    ).toBe(true);
    expect(tab.webContents.focus).not.toHaveBeenCalled();
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
