import { describe, expect, it, vi } from "vitest";
import {
  BROWSER_MCP_INSTRUCTIONS,
  TOOLS,
  dispatchTool,
  formatToolResult,
  isKnownToolName,
  type ToolContext,
} from "./toolRegistry";

type TestCaptureImage = {
  toPNG: () => Buffer;
  toJPEG: (quality: number) => Buffer;
  getSize: () => { width: number; height: number };
  resize: () => unknown;
};
type CapturePageMock = ReturnType<typeof vi.fn<() => Promise<TestCaptureImage>>>;

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
  if (expression.includes('const phase="session-hide"')) {
    return {
      ok: true,
      sessionOwned: true,
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

function createContext(): ToolContext {
  return {
    allowDataAccess: false,
    allowEval: false,
    manager: {
      snapshot: () => ({
        tabs: [
          {
            tabId: "tab-1",
            url: "https://example.com/",
            title: "Example",
            loading: false,
            canGoBack: false,
            canGoForward: false,
            devToolsOpen: false,
          },
        ],
        activeTabId: "tab-1",
      }),
      getTab: () => ({ tabId: "tab-1" }),
      getActiveTab: () => ({ tabId: "tab-1" }),
    } as unknown as ToolContext["manager"],
  };
}

function createDispatchContext(send: ReturnType<typeof vi.fn>): ToolContext {
  const presentationLease = {
    requestId: "1b74121a-44ed-4ec0-aa75-68a5f4fb03ed",
    tabId: "tab-1",
    surface: "main" as const,
    revision: 1,
  };
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
      capturePage: vi.fn<() => Promise<TestCaptureImage>>().mockResolvedValue({
        toPNG: () => Buffer.from("png"),
        toJPEG: () => Buffer.from("jpg"),
        getSize: () => ({ width: 800, height: 600 }),
        resize() {
          return this;
        },
      }),
    },
    cdp: {
      attach: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      send,
    },
    network: {
      isEnabled: () => true,
      enable: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      list: () => [],
      clear: vi.fn<() => void>(),
    },
    dialogs: {
      recent: () => [],
      setNextDisposition: vi.fn<() => void>(),
      waitForNext: vi.fn<() => Promise<null>>().mockResolvedValue(null),
    },
    getConsoleEntries: () => [],
    clearConsole: vi.fn<() => void>(),
    addInitScript: vi
      .fn<(source: string) => Promise<{ identifier: string }>>()
      .mockResolvedValue({ identifier: "ys-init-script" }),
    addInitStyle: vi
      .fn<(css: string) => Promise<{ identifier: string }>>()
      .mockResolvedValue({ identifier: "ys-init-style" }),
    removeInitScript: vi.fn<(identifier: string) => Promise<void>>().mockResolvedValue(undefined),
    removeAllInitScripts: vi.fn<() => Promise<number>>().mockResolvedValue(1),
    listInitScripts: () => ["script-1"],
  };
  return {
    allowDataAccess: true,
    allowEval: true,
    manager: {
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
      getTab: () => tab,
      ensureTabReady: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      createTab: vi.fn<() => Promise<unknown>>().mockResolvedValue({ tabId: "tab-1" }),
      setAutomationSession: vi.fn<() => boolean>().mockReturnValue(true),
      touchAutomationSession: vi.fn<() => void>(),
      recordAutomationTarget: vi.fn<() => void>(),
      showAutomationCursor: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      presentAutomationTarget: vi.fn<() => Promise<unknown>>().mockResolvedValue(presentationLease),
      validateAutomationPresentation: vi.fn<() => boolean>().mockReturnValue(true),
      setActiveTab: vi.fn<() => void>(),
      rememberTabForThread: vi.fn<() => boolean>().mockReturnValue(true),
      closeTab: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      navigate: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      reload: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    } as unknown as ToolContext["manager"],
  };
}

interface SecureRoutingSendOptions {
  x?: number;
  y?: number;
  viewportWidth?: number;
  viewportHeight?: number;
  hitBackendNodeId?: number;
  hitIsDescendant?: boolean;
  disconnectAfterPointerMove?: boolean;
  invalidateOverlayAfterPointerMove?: boolean;
  loaderId?: string | (() => string);
}

function nodeNameForSelector(selector: string): string {
  if (selector.includes("select") || selector.includes("plan")) return "SELECT";
  if (
    selector.includes("input") ||
    selector.includes("email") ||
    selector.includes("remember") ||
    selector === ":focus"
  ) {
    return "INPUT";
  }
  return "BUTTON";
}

function cursorCoordinate(expression: string, name: "x" | "y", fallback: number): number {
  const matched = new RegExp(`const ${name}=(-?\\d+(?:\\.\\d+)?);`, "u").exec(expression)?.[1];
  const parsed = matched === undefined ? Number.NaN : Number(matched);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cursorBoxModel(x: number, y: number): Record<string, unknown> {
  const border = [x - 40, y - 20, x + 40, y - 20, x + 40, y + 20, x - 40, y + 20];
  return {
    model: {
      border,
      content: border,
      padding: border,
      margin: border,
      width: 80,
      height: 40,
    },
  };
}

function createRoutingSend(options: SecureRoutingSendOptions = {}) {
  const targetBackendNodeId = 700;
  const hitBackendNodeId = options.hitBackendNodeId ?? targetBackendNodeId;
  const targetX = options.x ?? 120;
  const targetY = options.y ?? 80;
  const viewportWidth = options.viewportWidth ?? 900;
  const viewportHeight = options.viewportHeight ?? 700;
  let queriedSelector = "button";
  let checkedReads = 0;
  let pointerMoved = false;
  return vi.fn<(method: string, params?: Record<string, unknown>) => Promise<unknown>>(
    async (method, params) => {
      if (method === "Runtime.evaluate") {
        const expression = String(params?.expression ?? "");
        if (expression.includes('const phase="move"')) {
          const x = cursorCoordinate(expression, "x", targetX);
          const y = cursorCoordinate(expression, "y", targetY);
          return {
            result: {
              type: "object",
              value: {
                ok: true,
                x,
                y,
                startX: x,
                startY: y,
                kind: expression.includes('const kind="viewport"') ? "viewport" : "element",
                reducedMotion: true,
              },
            },
          };
        }
        if (expression === "location.href") {
          return { result: { type: "string", value: "https://example.test/page" } };
        }
        if (
          expression.includes('const phase="path-verify"') &&
          options.invalidateOverlayAfterPointerMove === true &&
          pointerMoved
        ) {
          return { result: { type: "object", value: { ok: false } } };
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
            nodeName: nodeNameForSelector(queriedSelector),
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
        const args = Array.isArray(params?.arguments) ? params.arguments : [];
        if (functionDeclaration.includes("actual.endsWith")) {
          return { result: { type: "boolean", value: true } };
        }
        if (functionDeclaration.includes("active:activeMatches,editable:editable")) {
          return {
            result: { type: "object", value: { active: true, editable: true, length: 0 } },
          };
        }
        if (functionDeclaration.includes("checked:!!")) {
          return {
            result: {
              type: "object",
              value: { ok: true, checked: checkedReads++ > 0 },
            },
          };
        }
        if (functionDeclaration.includes("enabledSteps:enabledSteps")) {
          return {
            result: {
              type: "object",
              value: {
                ok: true,
                currentIndex: 0,
                targetIndex: 1,
                enabledSteps: 1,
                targetValue: "pro",
                targetText: "Pro",
              },
            },
          };
        }
        if (functionDeclaration.includes('":open"')) {
          return { result: { type: "boolean", value: true } };
        }
        if (functionDeclaration.includes("actualValue===targetValue")) {
          return { result: { type: "boolean", value: true } };
        }
        if (functionDeclaration.includes("Number(Reflect.apply(descriptor.get,this,[]))")) {
          return { result: { type: "boolean", value: true } };
        }
        if (functionDeclaration.includes("shadowActiveDescriptor")) {
          return { result: { type: "boolean", value: true } };
        }
        if (args.some((argument) => "objectId" in Object(argument))) {
          return {
            result: { type: "boolean", value: options.hitIsDescendant === true },
          };
        }
        return {
          result: {
            type: "object",
            value: {
              connected: !(options.disconnectAfterPointerMove && pointerMoved),
              disabled: false,
              visible: true,
            },
          },
        };
      }
      if (method === "Runtime.releaseObject") return {};
      if (method === "DOM.scrollIntoViewIfNeeded") return {};
      if (method === "DOM.getBoxModel") return cursorBoxModel(targetX, targetY);
      if (method === "DOM.getNodeForLocation") {
        return { backendNodeId: hitBackendNodeId, frameId: "main" };
      }
      if (method === "Page.getNavigationHistory") {
        return {
          currentIndex: 1,
          entries: [
            { id: 1, url: "https://example.test/one", title: "One" },
            { id: 2, url: "https://example.test/two", title: "Two" },
            { id: 3, url: "https://example.test/three", title: "Three" },
          ],
        };
      }
      if (method === "Page.captureScreenshot") {
        return { data: Buffer.from("png").toString("base64") };
      }
      if (method === "Page.getLayoutMetrics") {
        return {
          cssLayoutViewport: {
            pageX: 0,
            pageY: 0,
            clientWidth: viewportWidth,
            clientHeight: viewportHeight,
          },
          cssContentSize: { x: 0, y: 0, width: viewportWidth, height: viewportHeight },
        };
      }
      if (method === "Network.getCookies") {
        return { cookies: [] };
      }
      if (method === "Network.setCookie") {
        return { success: true };
      }
      if (method === "Page.getFrameTree") {
        const loaderId =
          typeof options.loaderId === "function"
            ? options.loaderId()
            : (options.loaderId ?? "loader-main-1");
        return {
          frameTree: {
            frame: {
              id: "main",
              loaderId,
              url: "https://example.test/",
            },
          },
        };
      }
      if (method === "Page.addScriptToEvaluateOnNewDocument") {
        return { identifier: "script-1" };
      }
      if (method === "Input.dispatchMouseEvent" && params?.type === "mouseMoved") {
        pointerMoved = true;
      }
      return {};
    },
  );
}

function agentCursorExpressions(send: ReturnType<typeof vi.fn>): string[] {
  return send.mock.calls.flatMap(([method, params]) => {
    if (method !== "Runtime.evaluate") return [];
    const expression = String(params?.expression ?? "");
    return expression.includes('const phase="move"') ||
      expression.includes('const phase="complete"')
      ? [expression]
      : [];
  });
}

const ROUTING_ARGS: Record<string, Record<string, unknown>> = {
  api: {},
  enable: {},
  disable: {},
  list_tabs: {},
  find_tabs: { query: "example" },
  new_tab: { url: "https://example.test/", activate: true },
  open: { url: "https://example.test/open" },
  activate_tab: { tabId: "tab-1" },
  open_or_focus_tab: { url: "https://example.test/focused" },
  close_tab: { tabId: "tab-1" },
  navigate: { url: "https://example.test/nav" },
  back: {},
  forward: {},
  reload: {},
  get_url: {},
  get_title: {},
  screenshot: {},
  query: { selector: "input" },
  wait_for: { selector: "input", timeoutMs: 50 },
  click: { selector: "button" },
  dblclick: { selector: "button" },
  focus: { selector: "input" },
  type: { selector: "input", text: "abc" },
  fill: { selector: "input", text: "abc" },
  check: { selector: "input[type=checkbox]" },
  uncheck: { selector: "input[type=checkbox]" },
  select: { selector: "select", value: "pro" },
  eval: { js: "true" },
  snapshot: {},
  inspect: {},
  get: { selector: "input", fields: ["text"] },
  is: { selector: "input" },
  find: { text: "Example" },
  hover: { selector: "button" },
  press: { selector: "input", key: "Enter" },
  wait: { selector: "input", timeoutMs: 50 },
  scroll: { y: 100 },
  wait_for_url: { pattern: "example.test", timeoutMs: 50 },
  wait_for_text: { text: "Example", timeoutMs: 50 },
  wait_for_js: { js: "true", timeoutMs: 50 },
  console: {},
  requests: {},
  cookies: { op: "get" },
  storage: { kind: "local", op: "getAll" },
  dialog: { op: "recent" },
  frames: {},
  addscript: { op: "add", source: "window.__ok = true" },
  addstyle: { op: "oneshot", css: "body { color: red; }" },
};

describe("browser MCP tool registry", () => {
  it("hides sensitive integration tabs and rejects agent mutations against them", async () => {
    const safeTab = {
      tabId: "safe-tab",
      url: "https://example.test/",
      title: "Example",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      devToolsOpen: false,
    };
    const privatePartition = "pipedream-oauth-11111111111111111111111111111111";
    const sensitiveTab = {
      ...safeTab,
      tabId: "oauth-tab",
      url: "about:blank",
      title: "Connecting…",
      loading: true,
      sensitiveIntegration: true as const,
      sensitiveViewGeneration: 0,
    };
    const manager = {
      snapshot: () => ({
        tabs: [safeTab, sensitiveTab],
        activeTabId: sensitiveTab.tabId,
      }),
      getTab: (tabId: string) => (tabId === safeTab.tabId ? safeTab : null),
      getActiveTab: () => null,
      ensureTabReady: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      setActiveTab: vi.fn<() => void>(),
      closeTab: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      navigate: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      reload: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    } as unknown as ToolContext["manager"];
    const ctx = { allowDataAccess: false, allowEval: false, manager };

    await expect(dispatchTool("list_tabs", {}, ctx)).resolves.toMatchObject({
      tabs: [{ tabId: "safe-tab" }],
      activeTabId: null,
      implicitTabId: null,
    });
    await expect(dispatchTool("find_tabs", { query: "connecting" }, ctx)).resolves.toMatchObject({
      tabs: [],
    });
    expect(JSON.stringify(await dispatchTool("list_tabs", {}, ctx))).not.toContain(
      privatePartition,
    );
    await expect(dispatchTool("activate_tab", { tabId: sensitiveTab.tabId }, ctx)).rejects.toThrow(
      "unknown tab oauth-tab",
    );
    await expect(dispatchTool("close_tab", { tabId: sensitiveTab.tabId }, ctx)).rejects.toThrow(
      "unknown tab oauth-tab",
    );
    await expect(
      dispatchTool(
        "navigate",
        { tabId: sensitiveTab.tabId, url: "https://attacker.example/" },
        ctx,
      ),
    ).rejects.toThrow("unknown tab oauth-tab");
    await expect(dispatchTool("reload", { tabId: sensitiveTab.tabId }, ctx)).rejects.toThrow(
      "unknown tab oauth-tab",
    );
    expect(manager.setActiveTab).not.toHaveBeenCalled();
    expect(manager.closeTab).not.toHaveBeenCalled();
    expect(manager.navigate).not.toHaveBeenCalled();
    expect(manager.reload).not.toHaveBeenCalled();
  });

  it("surfaces an API map as the first tool", async () => {
    expect(TOOLS[0]?.name).toBe("api");
    expect(isKnownToolName("api")).toBe(true);

    const result = (await dispatchTool("api", {}, createContext())) as {
      guidance: string[];
      workflows: Record<string, string[]>;
      tools: Array<{ name: string }>;
      tabs: { activeTabId: string | null };
    };

    expect(result.guidance.join(" ")).toContain("Prefer this MCP server");
    expect(result.guidance.join(" ")).toContain("@e refs");
    expect(result.guidance.join(" ")).toContain("exact global browser tab");
    expect(result.guidance.join(" ")).toContain("orange Y Space cursor");
    expect(result.workflows.inspect).toContain("snapshot");
    expect(result.workflows.interact).toEqual(
      expect.arrayContaining(["fill", "focus", "check", "uncheck", "select", "wait"]),
    );
    expect(result.tools.map((tool) => tool.name)).toContain("click");
    expect(result.tools.map((tool) => tool.name)).toContain("fill");
    expect(result.tabs.activeTabId).toBe("tab-1");
  });

  it("formats the API result for MCP clients", async () => {
    const result = await dispatchTool("api", {}, createContext());
    const formatted = formatToolResult("api", result);

    expect(BROWSER_MCP_INSTRUCTIONS).toContain("call browser.api");
    expect(BROWSER_MCP_INSTRUCTIONS).toContain("browser.enable");
    expect(BROWSER_MCP_INSTRUCTIONS).toContain("browser.disable");
    expect(BROWSER_MCP_INSTRUCTIONS).toContain("visible orange cursor");
    expect(BROWSER_MCP_INSTRUCTIONS).toContain("passive inspection to remain in the background");
    expect(BROWSER_MCP_INSTRUCTIONS).toContain("current turn");
    expect(BROWSER_MCP_INSTRUCTIONS).toContain("exact tab id");
    expect(BROWSER_MCP_INSTRUCTIONS).toContain("URL or title");
    expect(BROWSER_MCP_INSTRUCTIONS).toContain("page result you observed");
    expect(formatted.content[0]?.type).toBe("text");
    expect(formatted.content[0]?.text).toContain('"workflows"');
    expect(formatted.content[0]?.text).toContain('"args"');
    expect(formatted.content[0]?.text).not.toContain('"inputSchema"');
    expect(formatted.content[0]?.text?.length).toBeLessThan(20_000);
  });

  it("advertises passive and state-changing tool annotations", () => {
    expect(TOOLS.find((tool) => tool.name === "snapshot")?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(TOOLS.find((tool) => tool.name === "click")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
  });

  it("recognizes agent-browser-style aliases", () => {
    expect(isKnownToolName("goto")).toBe(true);
    expect(isKnownToolName("key")).toBe(true);
    expect(isKnownToolName("keyboard_type")).toBe(true);
  });

  it("dispatches optimized form and interaction commands", async () => {
    const send = createRoutingSend();
    const ctx = createDispatchContext(send);

    await expect(
      dispatchTool("fill", { selector: "#email", text: "test@example.com" }, ctx),
    ).resolves.toEqual({ ok: true });
    await expect(dispatchTool("focus", { selector: "#email" }, ctx)).resolves.toEqual({
      ok: true,
    });
    await expect(dispatchTool("click", { selector: "#submit" }, ctx)).resolves.toEqual({
      ok: true,
    });
    await expect(dispatchTool("type", { selector: "#email", text: "abc" }, ctx)).resolves.toEqual({
      ok: true,
    });
    await expect(dispatchTool("press", { selector: "#email", key: "Enter" }, ctx)).resolves.toEqual(
      {
        ok: true,
      },
    );
    await expect(dispatchTool("check", { selector: "#remember" }, ctx)).resolves.toEqual({
      ok: true,
    });
    await expect(dispatchTool("select", { selector: "#plan", value: "pro" }, ctx)).resolves.toEqual(
      { ok: true },
    );

    const activeTab = ctx.manager.getActiveTab() as unknown as {
      webContents: {
        executeJavaScript: ReturnType<typeof vi.fn>;
        focus: ReturnType<typeof vi.fn>;
        insertText: ReturnType<typeof vi.fn>;
        sendInputEvent: ReturnType<typeof vi.fn>;
      };
      cdp: { attach: ReturnType<typeof vi.fn> };
    };
    expect(activeTab.webContents.insertText).toHaveBeenCalledWith("test@example.com");
    expect(send.mock.calls.some(([method]) => method === "Input.insertText")).toBe(false);
    expect(send.mock.calls.some(([method]) => method === "Input.dispatchKeyEvent")).toBe(false);
    expect(send).toHaveBeenCalledWith("DOM.focus", { backendNodeId: 700 });
    const nativeEvents = activeTab.webContents.sendInputEvent.mock.calls.map(([event]) => event);
    expect(nativeEvents.length).toBeGreaterThan(0);
    expect(nativeEvents.some((event) => event.type === "char" && event.keyCode === "p")).toBe(
      process.platform === "darwin",
    );
    expect(
      nativeEvents.some((event) => event.type === "rawKeyDown" && event.keyCode === "Home"),
    ).toBe(process.platform !== "darwin");
    const isolatedFunctions = send.mock.calls.flatMap(([method, params]) =>
      method === "Runtime.callFunctionOn" ? [String(params?.functionDeclaration ?? "")] : [],
    );
    expect(
      isolatedFunctions.some((declaration) => declaration.includes("length:typeof content")),
    ).toBe(true);
    expect(isolatedFunctions.some((declaration) => declaration.includes("actual.endsWith"))).toBe(
      true,
    );
    expect(isolatedFunctions.some((declaration) => declaration.includes("checked:!!"))).toBe(true);
    expect(
      isolatedFunctions.some((declaration) => declaration.includes("enabledSteps:enabledSteps")),
    ).toBe(true);
    expect(
      isolatedFunctions.some((declaration) => declaration.includes("actualValue===targetValue")),
    ).toBe(true);
    expect(activeTab.webContents.executeJavaScript).not.toHaveBeenCalled();
    expect(activeTab.webContents.focus).toHaveBeenCalled();
  });

  it("focuses the exact presented guest before a targeted native key", async () => {
    const trace: string[] = [];
    const routedSend = createRoutingSend();
    const send = vi.fn<(method: string, params?: Record<string, unknown>) => Promise<unknown>>(
      async (method, params) => {
        trace.push(method);
        return await routedSend(method, params);
      },
    );
    const ctx = createDispatchContext(send);
    const activeTab = ctx.manager.getActiveTab() as unknown as {
      webContents: {
        focus: ReturnType<typeof vi.fn>;
        isFocused: ReturnType<typeof vi.fn>;
      };
    };
    activeTab.webContents.focus.mockImplementation(() => trace.push("WebContents.focus"));
    const nativeSend = activeTab.webContents as unknown as {
      sendInputEvent: ReturnType<typeof vi.fn>;
    };
    nativeSend.sendInputEvent.mockImplementation(() => trace.push("WebContents.sendInputEvent"));

    await expect(dispatchTool("press", { selector: "#plan", key: "s" }, ctx)).resolves.toEqual({
      ok: true,
    });

    const firstKey = trace.indexOf("WebContents.sendInputEvent");
    expect(activeTab.webContents.focus).toHaveBeenCalledOnce();
    expect(activeTab.webContents.isFocused).toHaveBeenCalled();
    expect(trace.indexOf("WebContents.focus")).toBeGreaterThanOrEqual(0);
    expect(firstKey).toBeGreaterThan(trace.indexOf("WebContents.focus"));
  });

  it("preserves the completed pointer move when the presented guest cannot take focus", async () => {
    const send = createRoutingSend();
    const ctx = createDispatchContext(send);
    const activeTab = ctx.manager.getActiveTab() as unknown as {
      webContents: {
        focus: ReturnType<typeof vi.fn>;
        isFocused: ReturnType<typeof vi.fn>;
      };
    };
    activeTab.webContents.isFocused.mockReturnValue(false);

    await expect(dispatchTool("press", { selector: "#plan", key: "s" }, ctx)).resolves.toEqual({
      ok: false,
      ambiguous: true,
      reason: "guest-focus-did-not-apply",
      partial: "pointer-move",
      clickDispatched: false,
      hint: "Trusted pointer movement reached Chromium and page hover/mousemove handlers may have run. No click was dispatched. Inspect page state before any retry.",
    });
    expect(activeTab.webContents.focus).toHaveBeenCalledOnce();
    expect(send.mock.calls.some(([method]) => method === "Input.dispatchKeyEvent")).toBe(false);
  });

  it("reports an ambiguous native key when the exact guest is replaced after key-down", async () => {
    const send = createRoutingSend();
    const ctx = createDispatchContext(send);
    const tab = ctx.manager.getActiveTab() as unknown as {
      webContents: {
        focus: ReturnType<typeof vi.fn>;
        insertText: ReturnType<typeof vi.fn>;
        isDestroyed: ReturnType<typeof vi.fn>;
        isFocused: ReturnType<typeof vi.fn>;
        sendInputEvent: ReturnType<typeof vi.fn>;
      };
    };
    const originalWebContents = tab.webContents;
    const replacementWebContents = {
      focus: vi.fn<() => void>(),
      insertText: vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined),
      isDestroyed: vi.fn<() => boolean>().mockReturnValue(false),
      isFocused: vi.fn<() => boolean>().mockReturnValue(true),
      sendInputEvent: vi.fn<(event: Electron.KeyboardInputEvent) => void>(),
    };
    originalWebContents.sendInputEvent.mockImplementation((event: Electron.KeyboardInputEvent) => {
      if (event.type === "keyDown" && event.keyCode === "S") {
        tab.webContents = replacementWebContents;
      }
    });

    await expect(
      dispatchTool("press", { selector: "#plan", key: "s" }, ctx),
    ).resolves.toMatchObject({
      ok: false,
      ambiguous: true,
      reason: "guest-target-replaced",
    });
    expect(originalWebContents.sendInputEvent.mock.calls).toEqual([
      [{ type: "keyDown", keyCode: "S" }],
      [{ type: "keyUp", keyCode: "S" }],
    ]);
    expect(replacementWebContents.sendInputEvent).not.toHaveBeenCalled();
    expect(send.mock.calls.some(([method]) => method === "Input.dispatchKeyEvent")).toBe(false);
  });

  it("does not release a native key into a replacement document on a detached guest", async () => {
    let loaderId = "loader-main-1";
    const send = createRoutingSend({ loaderId: () => loaderId });
    const ctx = createDispatchContext(send);
    const tab = ctx.manager.getActiveTab() as unknown as {
      webContents: {
        focus: ReturnType<typeof vi.fn>;
        insertText: ReturnType<typeof vi.fn>;
        isDestroyed: ReturnType<typeof vi.fn>;
        isFocused: ReturnType<typeof vi.fn>;
        sendInputEvent: ReturnType<typeof vi.fn>;
      };
    };
    const originalWebContents = tab.webContents;
    const replacementWebContents = {
      focus: vi.fn<() => void>(),
      insertText: vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined),
      isDestroyed: vi.fn<() => boolean>().mockReturnValue(false),
      isFocused: vi.fn<() => boolean>().mockReturnValue(true),
      sendInputEvent: vi.fn<(event: Electron.KeyboardInputEvent) => void>(),
    };
    originalWebContents.sendInputEvent.mockImplementation((event: Electron.KeyboardInputEvent) => {
      if (event.type === "keyDown" && event.keyCode === "S") {
        tab.webContents = replacementWebContents;
        loaderId = "loader-main-2";
      }
    });

    await expect(
      dispatchTool("press", { selector: "#plan", key: "s" }, ctx),
    ).resolves.toMatchObject({
      ok: false,
      ambiguous: true,
      reason: "guest-target-replaced",
    });
    expect(originalWebContents.sendInputEvent.mock.calls).toEqual([
      [{ type: "keyDown", keyCode: "S" }],
    ]);
    expect(replacementWebContents.sendInputEvent).not.toHaveBeenCalled();
  });

  it("does not replay a printable char after native guest focus is lost", async () => {
    const send = createRoutingSend();
    const ctx = createDispatchContext(send);
    const tab = ctx.manager.getActiveTab() as unknown as {
      webContents: {
        isFocused: ReturnType<typeof vi.fn>;
        sendInputEvent: ReturnType<typeof vi.fn>;
      };
    };
    tab.webContents.sendInputEvent.mockImplementation((event: Electron.KeyboardInputEvent) => {
      if (event.type === "char") tab.webContents.isFocused.mockReturnValue(false);
    });

    await expect(
      dispatchTool("press", { selector: "#plan", key: "s" }, ctx),
    ).resolves.toMatchObject({
      ok: false,
      ambiguous: true,
      reason: "guest-focus-lost",
    });
    expect(tab.webContents.sendInputEvent.mock.calls).toEqual([
      [{ type: "keyDown", keyCode: "S" }],
      [{ type: "char", keyCode: "s" }],
      [{ type: "keyUp", keyCode: "S" }],
    ]);
    expect(send.mock.calls.some(([method]) => method === "Input.dispatchKeyEvent")).toBe(false);
  });

  it("reports an ambiguous native select when its exact guest is replaced after key-down", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const send = createRoutingSend();
    const ctx = createDispatchContext(send);
    const tab = ctx.manager.getActiveTab() as unknown as {
      webContents: {
        isDestroyed: ReturnType<typeof vi.fn>;
        sendInputEvent: ReturnType<typeof vi.fn>;
      };
    };
    const originalWebContents = tab.webContents;
    const replacementWebContents = {
      isDestroyed: vi.fn<() => boolean>().mockReturnValue(false),
      sendInputEvent: vi.fn<(event: Electron.KeyboardInputEvent) => void>(),
    };
    originalWebContents.sendInputEvent.mockImplementation((event: Electron.KeyboardInputEvent) => {
      if (event.type === "rawKeyDown" && event.keyCode === "Home") {
        tab.webContents = replacementWebContents;
      }
    });

    await expect(
      dispatchTool("select", { selector: "#plan", value: "pro" }, ctx),
    ).resolves.toMatchObject({
      ok: false,
      ambiguous: true,
      reason: "select-native-menu-target-replaced",
    });
    expect(originalWebContents.sendInputEvent.mock.calls).toEqual([
      [{ type: "rawKeyDown", keyCode: "Home" }],
      [{ type: "keyUp", keyCode: "Home" }],
    ]);
    expect(replacementWebContents.sendInputEvent).not.toHaveBeenCalled();
    expect(send.mock.calls.some(([method]) => method === "Input.dispatchKeyEvent")).toBe(false);
    platform.mockRestore();
  });

  it("does not release a native select key into a replacement document on a detached guest", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    let loaderId = "loader-main-1";
    const send = createRoutingSend({ loaderId: () => loaderId });
    const ctx = createDispatchContext(send);
    const tab = ctx.manager.getActiveTab() as unknown as {
      webContents: {
        isDestroyed: ReturnType<typeof vi.fn>;
        sendInputEvent: ReturnType<typeof vi.fn>;
      };
    };
    const originalWebContents = tab.webContents;
    const replacementWebContents = {
      isDestroyed: vi.fn<() => boolean>().mockReturnValue(false),
      sendInputEvent: vi.fn<(event: Electron.KeyboardInputEvent) => void>(),
    };
    originalWebContents.sendInputEvent.mockImplementation((event: Electron.KeyboardInputEvent) => {
      if (event.type === "rawKeyDown" && event.keyCode === "Home") {
        tab.webContents = replacementWebContents;
        loaderId = "loader-main-2";
      }
    });

    try {
      await expect(
        dispatchTool("select", { selector: "#plan", value: "pro" }, ctx),
      ).resolves.toMatchObject({
        ok: false,
        ambiguous: true,
        reason: "select-native-menu-target-replaced",
      });
      expect(originalWebContents.sendInputEvent.mock.calls).toEqual([
        [{ type: "rawKeyDown", keyCode: "Home" }],
      ]);
      expect(replacementWebContents.sendInputEvent).not.toHaveBeenCalled();
    } finally {
      platform.mockRestore();
    }
  });

  it("does not send a printable char or key-up into a replacement document on the same guest", async () => {
    let loaderId = "loader-main-1";
    const send = createRoutingSend({ loaderId: () => loaderId });
    const ctx = createDispatchContext(send);
    const tab = ctx.manager.getActiveTab() as unknown as {
      webContents: {
        sendInputEvent: ReturnType<typeof vi.fn>;
      };
    };
    tab.webContents.sendInputEvent.mockImplementation((event: Electron.KeyboardInputEvent) => {
      if (event.type === "keyDown" && event.keyCode === "S") loaderId = "loader-main-2";
    });

    await expect(
      dispatchTool("press", { selector: "#plan", key: "s" }, ctx),
    ).resolves.toMatchObject({
      ok: false,
      ambiguous: true,
      reason: "guest-target-replaced",
    });
    expect(tab.webContents.sendInputEvent.mock.calls).toEqual([
      [{ type: "keyDown", keyCode: "S" }],
    ]);
  });

  it("does not send key-up or cleanup Escape into a replacement document on the same select guest", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    let loaderId = "loader-main-1";
    const send = createRoutingSend({ loaderId: () => loaderId });
    const ctx = createDispatchContext(send);
    const tab = ctx.manager.getActiveTab() as unknown as {
      webContents: {
        sendInputEvent: ReturnType<typeof vi.fn>;
      };
    };
    tab.webContents.sendInputEvent.mockImplementation((event: Electron.KeyboardInputEvent) => {
      if (event.type === "rawKeyDown" && event.keyCode === "Home") {
        loaderId = "loader-main-2";
      }
    });

    try {
      await expect(
        dispatchTool("select", { selector: "#plan", value: "pro" }, ctx),
      ).resolves.toMatchObject({
        ok: false,
        ambiguous: true,
        reason: "select-native-menu-target-replaced",
      });
      expect(tab.webContents.sendInputEvent.mock.calls).toEqual([
        [{ type: "rawKeyDown", keyCode: "Home" }],
      ]);
    } finally {
      platform.mockRestore();
    }
  });

  it("preserves the completed pointer move when presentation authorization throws after guest focus", async () => {
    const send = createRoutingSend();
    const ctx = createDispatchContext(send);
    const tab = ctx.manager.getActiveTab() as unknown as {
      webContents: {
        focus: ReturnType<typeof vi.fn>;
        sendInputEvent: ReturnType<typeof vi.fn>;
      };
    };
    let focused = false;
    tab.webContents.focus.mockImplementation(() => {
      focused = true;
    });
    const validates = ctx.manager.validateAutomationPresentation as unknown as ReturnType<
      typeof vi.fn
    >;
    validates.mockImplementation(() => {
      if (focused) throw new Error("authorization callback failed");
      return true;
    });

    await expect(dispatchTool("press", { selector: "#plan", key: "s" }, ctx)).resolves.toEqual({
      ok: false,
      ambiguous: true,
      reason: "presentation-authorization-revoked",
      partial: "pointer-move",
      clickDispatched: false,
      hint: "Trusted pointer movement reached Chromium and page hover/mousemove handlers may have run. No click was dispatched. Inspect page state before any retry.",
    });
    expect(tab.webContents.sendInputEvent).not.toHaveBeenCalled();
  });

  it("releases a native select key best-effort and reports ambiguity when authorization throws after key-down", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const send = createRoutingSend();
    const ctx = createDispatchContext(send);
    const tab = ctx.manager.getActiveTab() as unknown as {
      webContents: {
        sendInputEvent: ReturnType<typeof vi.fn>;
      };
    };
    let keyDownDispatched = false;
    tab.webContents.sendInputEvent.mockImplementation((event: Electron.KeyboardInputEvent) => {
      if (event.type === "rawKeyDown" && event.keyCode === "Home") keyDownDispatched = true;
    });
    const validates = ctx.manager.validateAutomationPresentation as unknown as ReturnType<
      typeof vi.fn
    >;
    validates.mockImplementation(() => {
      if (keyDownDispatched) throw new Error("authorization callback failed");
      return true;
    });

    try {
      await expect(
        dispatchTool("select", { selector: "#plan", value: "pro" }, ctx),
      ).resolves.toMatchObject({
        ok: false,
        ambiguous: true,
        reason: "presentation-authorization-revoked",
      });
      expect(tab.webContents.sendInputEvent.mock.calls).toEqual([
        [{ type: "rawKeyDown", keyCode: "Home" }],
        [{ type: "keyUp", keyCode: "Home" }],
        [{ type: "rawKeyDown", keyCode: "Escape" }],
        [{ type: "keyUp", keyCode: "Escape" }],
      ]);
    } finally {
      platform.mockRestore();
    }
  });

  it("clears the bounded native insertText timer after text input settles", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const ctx = createDispatchContext(createRoutingSend());
    let nativeTextTimer: ReturnType<typeof setTimeout> | undefined;

    try {
      await expect(
        dispatchTool("type", { selector: "#email", text: "settled" }, ctx),
      ).resolves.toEqual({ ok: true });
      const timerCallIndex = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 2_000);
      expect(timerCallIndex).toBeGreaterThanOrEqual(0);
      nativeTextTimer = setTimeoutSpy.mock.results[timerCallIndex]?.value as
        | ReturnType<typeof setTimeout>
        | undefined;
      expect(nativeTextTimer).toBeDefined();
      expect(clearTimeoutSpy.mock.calls.some(([timer]) => timer === nativeTextTimer)).toBe(true);
    } finally {
      if (nativeTextTimer) clearTimeout(nativeTextTimer);
      clearTimeoutSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
  });

  it("emits truthful action-specific cursor phases and no presence for inspection", async () => {
    const clickSend = createRoutingSend();
    await dispatchTool("click", { selector: "#submit" }, createDispatchContext(clickSend));
    const clickExpressions = agentCursorExpressions(clickSend);
    expect(clickExpressions).toHaveLength(2);
    expect(clickExpressions[0]).toContain('const phase="move"');
    expect(clickExpressions[0]).toContain('const action="click"');
    expect(clickExpressions[1]).toContain('const phase="complete"');
    expect(clickExpressions[1]).toContain('const action="click"');
    expect(
      clickSend.mock.calls
        .filter(
          ([method, params]) =>
            method === "Runtime.evaluate" &&
            String(params?.expression ?? "").includes("const phase="),
        )
        .every(([, params]) => params?.contextId === 41),
    ).toBe(true);

    const hoverSend = createRoutingSend();
    await dispatchTool("hover", { selector: "#target" }, createDispatchContext(hoverSend));
    const hoverExpressions = agentCursorExpressions(hoverSend);
    expect(hoverExpressions).toHaveLength(1);
    expect(hoverExpressions[0]).toContain('const action="hover"');
    expect(hoverExpressions.join(" ")).not.toContain('const phase="complete"');

    const textSend = createRoutingSend();
    await dispatchTool(
      "fill",
      { selector: "#email", text: "test@example.com" },
      createDispatchContext(textSend),
    );
    const textExpressions = agentCursorExpressions(textSend);
    expect(textExpressions).toHaveLength(2);
    expect(textExpressions[0]).toContain('const action="text"');
    expect(textExpressions[1]).toContain('const phase="complete"');

    const scrollSend = createRoutingSend();
    await dispatchTool("scroll", { y: 240 }, createDispatchContext(scrollSend));
    const scrollExpressions = agentCursorExpressions(scrollSend);
    expect(scrollExpressions).toHaveLength(2);
    expect(scrollExpressions[0]).toContain('const action="scroll"');
    expect(scrollExpressions[1]).toContain("const deltaY=240");

    const inspectSend = createRoutingSend();
    await dispatchTool("snapshot", {}, createDispatchContext(inspectSend));
    expect(agentCursorExpressions(inspectSend)).toEqual([]);
  });

  it.each([
    ["hover", { selector: "#target" }],
    ["click", { selector: "#submit" }],
  ] as const)(
    "reports accepted pointer movement without claiming the %s follow-up happened",
    async (tool, args) => {
      const send = createRoutingSend({ disconnectAfterPointerMove: true });

      await expect(dispatchTool(tool, args, createDispatchContext(send))).resolves.toMatchObject({
        ok: false,
        ambiguous: true,
        reason: "target-removed",
        partial: "pointer-move",
        clickDispatched: false,
        hint: expect.stringContaining("No click was dispatched"),
      });
      expect(
        send.mock.calls
          .filter(([method]) => method === "Input.dispatchMouseEvent")
          .map(([, params]) => params?.type),
      ).toEqual(["mouseMoved"]);
    },
  );

  it("preserves a failed hover guard when presentation changes after the trusted move", async () => {
    let pointerMoved = false;
    const routedSend = createRoutingSend({ invalidateOverlayAfterPointerMove: true });
    const send = vi.fn<(method: string, params?: Record<string, unknown>) => Promise<unknown>>(
      async (method, params) => {
        const result = await routedSend(method, params);
        if (method === "Input.dispatchMouseEvent" && params?.type === "mouseMoved") {
          pointerMoved = true;
        }
        return result;
      },
    );
    const ctx = createDispatchContext(send);
    const validates = ctx.manager.validateAutomationPresentation as unknown as ReturnType<
      typeof vi.fn
    >;
    validates.mockImplementation(() => !pointerMoved);

    await expect(dispatchTool("click", { selector: "#submit" }, ctx)).resolves.toMatchObject({
      ok: false,
      ambiguous: true,
      reason: "cursor-overlay-unavailable",
      partial: "pointer-move",
      clickDispatched: false,
    });
    expect(
      send.mock.calls.filter(
        ([method, params]) =>
          method === "Input.dispatchMouseEvent" && params?.type === "mousePressed",
      ),
    ).toHaveLength(0);
  });

  it("presents the exact tab and reuses the resolved point for native click input", async () => {
    const send = createRoutingSend({ x: 137.5, y: 248.25 });
    const ctx = createDispatchContext(send);

    await expect(dispatchTool("click", { selector: "#submit" }, ctx)).resolves.toEqual({
      ok: true,
    });

    expect(ctx.manager.setAutomationSession).toHaveBeenCalledWith("unscoped", true);
    expect(ctx.manager.presentAutomationTarget).toHaveBeenCalledWith("tab-1");
    const expressions = agentCursorExpressions(send);
    expect(expressions).toHaveLength(2);
    expect(expressions[0]).toContain('const phase="move"');
    expect(expressions[1]).toContain('const phase="complete"');
    expect(send).toHaveBeenCalledWith("DOM.describeNode", {
      nodeId: 2,
      depth: 0,
      pierce: true,
    });
    expect(send).toHaveBeenCalledWith("Page.createIsolatedWorld", {
      frameId: "main",
      worldName: "y-space-agent-cursor-v1",
    });
    expect(send).toHaveBeenCalledWith("DOM.getNodeForLocation", {
      x: 137,
      y: 248,
      includeUserAgentShadowDOM: false,
      ignorePointerEventsNone: false,
    });
    expect(send.mock.calls.some(([method]) => method === "Runtime.callFunctionOn")).toBe(true);
    expect(send.mock.calls.some(([method]) => method === "Runtime.releaseObject")).toBe(true);

    const pointerEvents = send.mock.calls.filter(
      ([method]) => method === "Input.dispatchMouseEvent",
    );
    expect(pointerEvents.map(([, params]) => params?.type)).toEqual([
      "mouseMoved",
      "mousePressed",
      "mouseReleased",
    ]);
    expect(pointerEvents.every(([, params]) => params?.x === 137.5 && params?.y === 248.25)).toBe(
      true,
    );
    const activeTab = ctx.manager.getActiveTab() as unknown as {
      webContents: { executeJavaScript: ReturnType<typeof vi.fn> };
    };
    expect(activeTab.webContents.executeJavaScript).not.toHaveBeenCalled();
  });

  it("owns implicit interactive presence by authenticated launch and releases the same lease", async () => {
    const ctx = createDispatchContext(createRoutingSend());
    ctx.threadId = "thread-stable";
    ctx.launchId = "launch-current";

    await expect(dispatchTool("hover", { selector: "#target" }, ctx)).resolves.toEqual({
      ok: true,
    });
    await expect(dispatchTool("disable", {}, ctx)).resolves.toEqual({ enabled: false });

    expect(ctx.manager.setAutomationSession).toHaveBeenNthCalledWith(
      1,
      "launch:launch-current",
      true,
    );
    expect(ctx.manager.recordAutomationTarget).toHaveBeenCalledWith(
      "launch:launch-current",
      "tab-1",
    );
    expect(ctx.manager.showAutomationCursor).toHaveBeenCalledWith("launch:launch-current", "tab-1");
    expect(ctx.manager.setAutomationSession).toHaveBeenLastCalledWith(
      "launch:launch-current",
      false,
    );
  });

  it("serializes overlapping native input sequences on one browser tab", async () => {
    let releaseFirstPress!: () => void;
    const firstPressGate = new Promise<void>((resolve) => {
      releaseFirstPress = resolve;
    });
    let pressCount = 0;
    let glideCount = 0;
    const fallbackSend = createRoutingSend();
    const send = vi.fn<(method: string, params?: Record<string, unknown>) => Promise<unknown>>(
      async (method, params) => {
        if (method === "Runtime.evaluate") {
          const expression = String(params?.expression ?? "");
          if (expression.includes('const phase="move"')) {
            glideCount += 1;
          }
        }
        if (method === "Input.dispatchMouseEvent" && params?.type === "mousePressed") {
          pressCount += 1;
          if (pressCount === 1) await firstPressGate;
        }
        return await fallbackSend(method, params);
      },
    );
    const firstContext = createDispatchContext(send);
    const secondContext = { ...firstContext };

    const first = dispatchTool("click", { selector: "#first" }, firstContext);
    const second = dispatchTool("click", { selector: "#second" }, secondContext);
    await vi.waitFor(() => expect(pressCount).toBe(1));
    expect(glideCount).toBe(1);

    releaseFirstPress();
    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(glideCount).toBe(2);
    expect(pressCount).toBe(2);
  });

  it("serializes native input manager-wide across different browser tabs", async () => {
    let releaseFirstPress!: () => void;
    const firstPressGate = new Promise<void>((resolve) => {
      releaseFirstPress = resolve;
    });
    let pressCount = 0;
    const fallbackSend = createRoutingSend();
    const send = vi.fn<(method: string, params?: Record<string, unknown>) => Promise<unknown>>(
      async (method, params) => {
        if (method === "Input.dispatchMouseEvent" && params?.type === "mousePressed") {
          pressCount += 1;
          if (pressCount === 1) await firstPressGate;
        }
        return await fallbackSend(method, params);
      },
    );
    const ctx = createDispatchContext(send);
    const firstTab = ctx.manager.getActiveTab();
    expect(firstTab).not.toBeNull();
    const secondTab = Object.assign(
      Object.create(Object.getPrototypeOf(firstTab!)) as NonNullable<typeof firstTab>,
      firstTab,
      { tabId: "tab-2" },
    );
    Object.assign(ctx.manager, {
      getTab: (tabId: string) =>
        tabId === firstTab!.tabId ? firstTab : tabId === secondTab.tabId ? secondTab : null,
    });

    const first = dispatchTool("click", { tabId: firstTab!.tabId, selector: "#first" }, ctx);
    await vi.waitFor(() => expect(pressCount).toBe(1));
    const second = dispatchTool("click", { tabId: secondTab.tabId, selector: "#second" }, ctx);
    await Promise.resolve();

    expect(ctx.manager.presentAutomationTarget).toHaveBeenCalledTimes(1);
    expect(ctx.manager.presentAutomationTarget).toHaveBeenCalledWith(firstTab!.tabId);

    releaseFirstPress();
    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(ctx.manager.presentAutomationTarget).toHaveBeenNthCalledWith(2, secondTab.tabId);
  });

  it("fails closed when the exact presented tab changes while the cursor is gliding", async () => {
    let releaseGlide!: () => void;
    const glideGate = new Promise<void>((resolve) => {
      releaseGlide = resolve;
    });
    let glideStarted = false;
    const fallbackSend = createRoutingSend();
    const send = vi.fn<(method: string, params?: Record<string, unknown>) => Promise<unknown>>(
      async (method, params) => {
        if (method === "Input.dispatchMouseEvent" && params?.type === "mouseMoved") {
          glideStarted = true;
          await glideGate;
        }
        return await fallbackSend(method, params);
      },
    );
    const ctx = createDispatchContext(send);
    const validates = ctx.manager.validateAutomationPresentation as unknown as ReturnType<
      typeof vi.fn
    >;

    const click = dispatchTool("click", { selector: "#target" }, ctx);
    await vi.waitFor(() => expect(glideStarted).toBe(true));
    validates.mockReturnValue(false);
    releaseGlide();

    await expect(click).resolves.toMatchObject({
      ok: false,
      ambiguous: true,
      reason: "presentation-changed",
      partial: "pointer-move",
      clickDispatched: false,
      hint: expect.stringContaining("No click was dispatched"),
    });
    expect(validates).toHaveBeenCalledTimes(2);
    expect(
      send.mock.calls.filter(
        ([method, params]) =>
          method === "Input.dispatchMouseEvent" && params?.type === "mousePressed",
      ),
    ).toHaveLength(0);
  });

  it("reports a presentation rejection without mislabeling the live tab as missing", async () => {
    const ctx = createDispatchContext(createRoutingSend());
    const present = ctx.manager.presentAutomationTarget as unknown as ReturnType<typeof vi.fn>;
    present.mockResolvedValue(null);

    await expect(dispatchTool("click", { selector: "#target" }, ctx)).rejects.toThrow(
      "Native browser input failed: presentation-unavailable for tab tab-1",
    );
  });

  it("rechecks presentation authorization after target validation and before the first press", async () => {
    const send = createRoutingSend();
    const ctx = createDispatchContext(send);
    const validates = ctx.manager.validateAutomationPresentation as unknown as ReturnType<
      typeof vi.fn
    >;
    let checks = 0;
    validates.mockImplementation(() => {
      checks += 1;
      // Glide and the dispatch-level check pass. Revoke while the cursor helper
      // is validating the target, before its first native mouse press.
      return checks < 3;
    });

    await expect(dispatchTool("click", { selector: "#target" }, ctx)).resolves.toEqual({
      ok: false,
      ambiguous: true,
      reason: "presentation-authorization-revoked",
      partial: "pointer-move",
      clickDispatched: false,
      hint: "Trusted pointer movement reached Chromium and page hover/mousemove handlers may have run. No click was dispatched. Inspect page state before any retry.",
    });
    expect(checks).toBe(3);
    expect(
      send.mock.calls.filter(
        ([method, params]) =>
          method === "Input.dispatchMouseEvent" && params?.type === "mousePressed",
      ),
    ).toHaveLength(0);
  });

  it("rechecks presentation authorization before the second press of a double-click", async () => {
    const fallbackSend = createRoutingSend();
    let firstReleaseObserved = false;
    const send = vi.fn<(method: string, params?: Record<string, unknown>) => Promise<unknown>>(
      async (method, params) => {
        const result = await fallbackSend(method, params);
        if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") {
          firstReleaseObserved = true;
        }
        return result;
      },
    );
    const ctx = createDispatchContext(send);
    const validates = ctx.manager.validateAutomationPresentation as unknown as ReturnType<
      typeof vi.fn
    >;
    validates.mockImplementation(() => !firstReleaseObserved);

    await expect(dispatchTool("dblclick", { selector: "#target" }, ctx)).resolves.toEqual({
      ok: false,
      ambiguous: true,
      reason: "presentation-authorization-revoked",
      partial: "single-click",
      clickDispatched: true,
      hint: "One trusted click completed, but the requested double-click did not. Inspect page state before any retry.",
    });
    expect(
      send.mock.calls.filter(
        ([method, params]) =>
          method === "Input.dispatchMouseEvent" && params?.type === "mousePressed",
      ),
    ).toHaveLength(1);
    expect(
      send.mock.calls.filter(
        ([method, params]) =>
          method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased",
      ),
    ).toHaveLength(1);
  });

  it("orders disable behind an in-flight native input sequence", async () => {
    let releasePress!: () => void;
    const pressGate = new Promise<void>((resolve) => {
      releasePress = resolve;
    });
    let pressStarted = false;
    const fallbackSend = createRoutingSend();
    const send = vi.fn<(method: string, params?: Record<string, unknown>) => Promise<unknown>>(
      async (method, params) => {
        if (method === "Input.dispatchMouseEvent" && params?.type === "mousePressed") {
          pressStarted = true;
          await pressGate;
        }
        return await fallbackSend(method, params);
      },
    );
    const ctx = createDispatchContext(send);

    const click = dispatchTool("click", { selector: "#target" }, ctx);
    await vi.waitFor(() => expect(pressStarted).toBe(true));
    const disable = dispatchTool("disable", {}, ctx);
    await Promise.resolve();

    expect(ctx.manager.setAutomationSession).not.toHaveBeenCalledWith("unscoped", false);

    releasePress();
    await expect(Promise.all([click, disable])).resolves.toEqual([
      { ok: true },
      { enabled: false },
    ]);
    expect(ctx.manager.setAutomationSession).toHaveBeenNthCalledWith(1, "unscoped", true);
    expect(ctx.manager.setAutomationSession).toHaveBeenNthCalledWith(2, "unscoped", false);
  });

  it("orders a tab mutation behind in-flight input on another tab", async () => {
    let releasePress!: () => void;
    const pressGate = new Promise<void>((resolve) => {
      releasePress = resolve;
    });
    let pressStarted = false;
    const fallbackSend = createRoutingSend();
    const send = vi.fn<(method: string, params?: Record<string, unknown>) => Promise<unknown>>(
      async (method, params) => {
        if (method === "Input.dispatchMouseEvent" && params?.type === "mousePressed") {
          pressStarted = true;
          await pressGate;
        }
        return await fallbackSend(method, params);
      },
    );
    const ctx = createDispatchContext(send);
    const firstTab = ctx.manager.getActiveTab();
    expect(firstTab).not.toBeNull();
    const secondTab = Object.assign(
      Object.create(Object.getPrototypeOf(firstTab!)) as NonNullable<typeof firstTab>,
      firstTab,
      { tabId: "tab-2" },
    );
    Object.assign(ctx.manager, {
      getTab: (tabId: string) =>
        tabId === firstTab!.tabId ? firstTab : tabId === secondTab.tabId ? secondTab : null,
    });

    const click = dispatchTool("click", { tabId: firstTab!.tabId, selector: "#target" }, ctx);
    await vi.waitFor(() => expect(pressStarted).toBe(true));
    const close = dispatchTool("close_tab", { tabId: secondTab.tabId }, ctx);
    await Promise.resolve();

    expect(ctx.manager.closeTab).not.toHaveBeenCalled();

    releasePress();
    await expect(Promise.all([click, close])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(ctx.manager.closeTab).toHaveBeenCalledWith(secondTab.tabId);
  });

  it("keeps screenshot hiding and capture behind an in-flight native gesture", async () => {
    let releasePress!: () => void;
    const pressGate = new Promise<void>((resolve) => {
      releasePress = resolve;
    });
    let pressStarted = false;
    const fallbackSend = createRoutingSend();
    const send = vi.fn<(method: string, params?: Record<string, unknown>) => Promise<unknown>>(
      async (method, params) => {
        if (method === "Input.dispatchMouseEvent" && params?.type === "mousePressed") {
          pressStarted = true;
          await pressGate;
        }
        return await fallbackSend(method, params);
      },
    );
    const ctx = createDispatchContext(send);
    const tab = ctx.manager.getActiveTab() as unknown as {
      webContents: { capturePage: CapturePageMock };
    };

    const click = dispatchTool("click", { selector: "#target" }, ctx);
    await vi.waitFor(() => expect(pressStarted).toBe(true));
    const screenshot = dispatchTool("screenshot", {}, ctx);
    await Promise.resolve();

    expect(tab.webContents.capturePage).not.toHaveBeenCalled();

    releasePress();
    await expect(Promise.all([click, screenshot])).resolves.toEqual([
      { ok: true },
      expect.objectContaining({ mimeType: "image/png" }),
    ]);
    expect(tab.webContents.capturePage).toHaveBeenCalledOnce();
  });

  it("keeps native input behind screenshot hide, capture, and restore", async () => {
    let releaseCapture!: () => void;
    const captureGate = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    let captureStarted = false;
    const send = createRoutingSend();
    const ctx = createDispatchContext(send);
    const tab = ctx.manager.getActiveTab() as unknown as {
      webContents: { capturePage: CapturePageMock };
    };
    const image = await tab.webContents.capturePage();
    tab.webContents.capturePage.mockClear();
    tab.webContents.capturePage.mockImplementationOnce(async () => {
      captureStarted = true;
      await captureGate;
      return image;
    });

    const screenshot = dispatchTool("screenshot", {}, ctx);
    await vi.waitFor(() => expect(captureStarted).toBe(true));
    const click = dispatchTool("click", { selector: "#target" }, ctx);
    await Promise.resolve();

    expect(
      send.mock.calls.filter(([method]) => method === "Input.dispatchMouseEvent"),
    ).toHaveLength(0);

    releaseCapture();
    await expect(Promise.all([screenshot, click])).resolves.toEqual([
      expect.objectContaining({ mimeType: "image/png" }),
      { ok: true },
    ]);
    expect(send.mock.calls.some(([method]) => method === "Input.dispatchMouseEvent")).toBe(true);
  });

  it("distinguishes an ambiguous native transport rejection from a timeout", async () => {
    const fallbackSend = createRoutingSend();
    const send = vi.fn<(method: string, params?: Record<string, unknown>) => Promise<unknown>>(
      async (method, params) => {
        if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") {
          throw new Error("transport rejected release");
        }
        return await fallbackSend(method, params);
      },
    );
    const ctx = createDispatchContext(send);

    const result = await dispatchTool("click", { selector: "#target" }, ctx);

    expect(result).toMatchObject({
      ok: false,
      ambiguous: true,
      transportRejected: true,
      reason: "pointer-release-rejected",
    });
    expect(result).not.toHaveProperty("timedOut");
  });

  it("uses a native wheel at the visible cursor point for page scrolling", async () => {
    const send = createRoutingSend({ viewportWidth: 801, viewportHeight: 601 });
    const ctx = createDispatchContext(send);

    await expect(dispatchTool("scroll", { x: -12, y: 240 }, ctx)).resolves.toEqual({
      ok: true,
    });

    expect(send).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 400,
      y: 300,
      deltaX: -12,
      deltaY: 240,
    });
    const activeTab = ctx.manager.getActiveTab() as unknown as {
      webContents: { executeJavaScript: ReturnType<typeof vi.fn> };
    };
    expect(activeTab.webContents.executeJavaScript).not.toHaveBeenCalled();
  });

  it("keeps browser automation presence active between enable and disable", async () => {
    const ctx = createDispatchContext(createRoutingSend());

    await expect(dispatchTool("enable", {}, ctx)).resolves.toEqual({ enabled: true });
    await expect(dispatchTool("disable", {}, ctx)).resolves.toEqual({ enabled: false });

    expect(ctx.manager.setAutomationSession).toHaveBeenNthCalledWith(1, "unscoped", true);
    expect(ctx.manager.setAutomationSession).toHaveBeenNthCalledWith(2, "unscoped", false);
  });

  it("awaits residency and attachment when explicitly activating a browser page", async () => {
    const ctx = { ...createDispatchContext(createRoutingSend()), threadId: "thread-1" };

    await expect(dispatchTool("activate_tab", { tabId: "tab-1" }, ctx)).resolves.toEqual({
      ok: true,
    });

    expect(ctx.manager.setActiveTab).toHaveBeenCalledWith("tab-1");
    expect(ctx.manager.recordAutomationTarget).toHaveBeenCalledWith("thread-1", "tab-1");
    expect(ctx.manager.ensureTabReady).toHaveBeenCalledWith("tab-1");
    expect(ctx.manager.showAutomationCursor).toHaveBeenCalledWith("thread-1", "tab-1");
    expect(
      (ctx.manager.recordAutomationTarget as unknown as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      (ctx.manager.ensureTabReady as unknown as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("dispatches every advertised browser tool through the browser context", async () => {
    const toolNames = TOOLS.map((tool) => tool.name);
    expect(Object.keys(ROUTING_ARGS).sort()).toEqual([...toolNames].sort());

    for (const toolName of toolNames) {
      const send = createRoutingSend();
      const ctx = createDispatchContext(send);
      await expect(dispatchTool(toolName, ROUTING_ARGS[toolName] ?? {}, ctx)).resolves.toBeTruthy();
    }
  });

  it("routes reload, get_url, and fill to the active browser tab", async () => {
    const send = createRoutingSend();
    const ctx = createDispatchContext(send);

    await expect(dispatchTool("reload", {}, ctx)).resolves.toEqual({ ok: true });
    await expect(dispatchTool("get_url", {}, ctx)).resolves.toEqual({
      url: "https://example.test/page",
    });
    await expect(
      dispatchTool("fill", { selector: "input", text: "hello", submit: true }, ctx),
    ).resolves.toEqual({ ok: true });

    expect(ctx.manager.reload).toHaveBeenCalledWith("tab-1");
    const webContents = ctx.manager.getActiveTab()?.webContents as unknown as {
      focus: ReturnType<typeof vi.fn>;
      insertText: ReturnType<typeof vi.fn>;
      sendInputEvent: ReturnType<typeof vi.fn>;
    };
    expect(webContents.insertText).toHaveBeenCalledWith("hello");
    expect(send.mock.calls.some(([method]) => method === "Input.insertText")).toBe(false);
    expect(send.mock.calls.some(([method]) => method === "Input.dispatchKeyEvent")).toBe(false);
    expect(webContents.sendInputEvent).toHaveBeenCalledWith({
      type: "keyDown",
      keyCode: "Enter",
    });
    expect(webContents.focus).toHaveBeenCalledOnce();
  });

  it("falls back to jpeg for oversized full-page screenshots", async () => {
    let screenshots = 0;
    const fallbackSend = createRoutingSend();
    const send = vi.fn<(method: string, params?: Record<string, unknown>) => Promise<unknown>>(
      async (method, params) => {
        if (method === "Page.getLayoutMetrics") {
          return { cssContentSize: { x: 0, y: 0, width: 800, height: 600 } };
        }
        if (method === "Page.captureScreenshot") {
          screenshots++;
          return {
            data: Buffer.alloc(screenshots === 1 ? 3000 : 20).toString("base64"),
          };
        }
        return await fallbackSend(method, params);
      },
    );
    const ctx = createDispatchContext(send);

    await expect(
      dispatchTool("screenshot", { fullPage: true, maxBytes: 2000 }, ctx),
    ).resolves.toMatchObject({
      mimeType: "image/jpeg",
      format: "jpeg",
      fallback: true,
    });
    expect(screenshots).toBeGreaterThan(1);
  });

  it("returns structured timeout metadata for a stuck viewport screenshot capture", async () => {
    vi.useFakeTimers();
    const send = createRoutingSend();
    const ctx = createDispatchContext(send);
    const tab = ctx.manager.getActiveTab() as unknown as {
      webContents: {
        capturePage: ReturnType<typeof vi.fn>;
      };
    };
    tab.webContents.capturePage.mockReturnValueOnce(new Promise(() => {}));

    try {
      const result = dispatchTool("screenshot", { timeoutMs: 200 }, ctx);
      await vi.advanceTimersByTimeAsync(200);
      await expect(result).resolves.toMatchObject({
        timedOut: true,
        reason: "timeout",
        operation: "viewport screenshot",
        timeoutMs: 200,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("can hard-fail on screenshot timeout", async () => {
    vi.useFakeTimers();
    const send = createRoutingSend();
    const ctx = createDispatchContext(send);
    const tab = ctx.manager.getActiveTab() as unknown as {
      webContents: {
        capturePage: ReturnType<typeof vi.fn>;
      };
    };
    tab.webContents.capturePage.mockReturnValueOnce(new Promise(() => {}));

    try {
      const result = dispatchTool("screenshot", { timeoutMs: 200, failOnTimeout: true }, ctx);
      const rejection = result.catch((cause: unknown) => cause);
      await vi.advanceTimersByTimeAsync(200);
      const error = await rejection;
      expect(error).toBeInstanceOf(Error);
      expect(error).toHaveProperty("message", "viewport screenshot timed out after 200ms");
    } finally {
      vi.useRealTimers();
    }
  });

  it("includes screenshot metadata next to image content", async () => {
    const send = createRoutingSend();
    const ctx = createDispatchContext(send);
    const raw = await dispatchTool("screenshot", {}, ctx);
    const formatted = formatToolResult("screenshot", raw);

    expect(formatted.content[0]?.type).toBe("text");
    expect(formatted.content[0]?.text).toContain('"timedOut": false');
    expect(formatted.content[1]?.type).toBe("image");
  });

  it("passes compact snapshot options through to the page snapshot", async () => {
    const send = createRoutingSend();
    const ctx = createDispatchContext(send);

    await dispatchTool("snapshot", { mode: "compact", maxTextLength: 40 }, ctx);

    expect(
      send.mock.calls.some(
        ([method, params]) =>
          method === "Runtime.evaluate" &&
          String(params?.expression).includes('const mode = "compact"') &&
          String(params?.expression).includes("const maxTextLength = 40"),
      ),
    ).toBe(true);
  });

  it("passes ranked find options through to accessibility search", async () => {
    const send = createRoutingSend();
    const ctx = createDispatchContext(send);

    await dispatchTool(
      "find",
      { text: "Submit", limit: 3, visibleOnly: false, interactiveOnly: true, within: "form" },
      ctx,
    );

    expect(
      send.mock.calls.some(
        ([method, params]) =>
          method === "Runtime.evaluate" &&
          String(params?.expression).includes('"limit":3') &&
          String(params?.expression).includes('"visibleOnly":false') &&
          String(params?.expression).includes('"interactiveOnly":true') &&
          String(params?.expression).includes('"within":"form"'),
      ),
    ).toBe(true);
  });
});
