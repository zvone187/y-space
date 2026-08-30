import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const installSessionPermissions = vi.hoisted(() => vi.fn<() => void>());
const installSensitiveSessionPermissions = vi.hoisted(() => vi.fn<() => void>());
const removeNavigationGuards = vi.hoisted(() => vi.fn<() => void>());
const installNavigationGuards = vi.hoisted(() =>
  vi.fn<() => () => void>(() => removeNavigationGuards),
);
const dialogEnable = vi.hoisted(() => vi.fn<() => Promise<void>>().mockResolvedValue(undefined));
const dialogSuspend = vi.hoisted(() => vi.fn<() => void>());
const networkSuspend = vi.hoisted(() => vi.fn<() => void>());
type CdpSend = ReturnType<
  typeof vi.fn<(method: string, params?: Record<string, unknown>) => Promise<unknown>>
>;
const cdpSends = vi.hoisted(() => [] as CdpSend[]);

vi.mock("electron", () => ({
  webContents: { fromId: vi.fn<() => null>(() => null) },
}));

vi.mock("./cdp/cdpClient", () => ({
  CdpClient: class CdpClient {
    attach = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    detach = vi.fn<() => void>();
    isAttached = vi.fn<() => boolean>().mockReturnValue(true);
    send: CdpSend;

    constructor() {
      const targetNumber = cdpSends.length + 1;
      let scriptNumber = 0;
      this.send = vi.fn<(method: string, params?: Record<string, unknown>) => Promise<unknown>>(
        async (method) => {
          if (method === "Page.addScriptToEvaluateOnNewDocument") {
            scriptNumber += 1;
            return { identifier: `target-${targetNumber}-script-${scriptNumber}` };
          }
          return {};
        },
      );
      cdpSends.push(this.send);
    }
  },
}));

vi.mock("./cdp/dialogController", () => ({
  DialogController: class DialogController {
    enable = dialogEnable;
    suspend = dialogSuspend;
    dispose = vi.fn<() => void>();
  },
}));

vi.mock("./cdp/networkCapture", () => ({
  NetworkCapture: class NetworkCapture {
    suspend = networkSuspend;
    dispose = vi.fn<() => void>();
  },
}));

vi.mock("./permissions", () => ({
  installSensitiveSessionPermissions,
  installSessionPermissions,
  installNavigationGuards,
  isNavigationUrlAllowed: () => true,
}));

function createWebContents(initialUrl = "https://example.com/") {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  let currentUrl = initialUrl;
  return {
    session: {},
    setUserAgent: vi.fn<(userAgent: string) => void>(),
    getURL: vi.fn<() => string>(() => currentUrl),
    getTitle: vi.fn<() => string>(() => "Example"),
    isDestroyed: vi.fn<() => boolean>(() => false),
    isLoadingMainFrame: vi.fn<() => boolean>(() => false),
    on: vi.fn<(event: string, handler: (...args: unknown[]) => void) => void>((event, handler) => {
      handlers.set(event, handler);
    }),
    removeListener: vi.fn<(event: string) => void>((event) => {
      handlers.delete(event);
    }),
    navigationHistory: {
      canGoBack: vi.fn<() => boolean>(() => true),
      canGoForward: vi.fn<() => boolean>(() => true),
      goBack: vi.fn<() => void>(),
      goForward: vi.fn<() => void>(),
      clear: vi.fn<() => void>(),
    },
    reload: vi.fn<() => void>(),
    loadURL: vi.fn<(url: string) => Promise<void>>((url) => {
      currentUrl = url;
      return Promise.resolve();
    }),
    emit(event: string, ...args: unknown[]) {
      handlers.get(event)?.(...args);
    },
  };
}

type SimulatedInput = {
  type: string;
  key: string;
  code?: string;
  control?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
};
type BeforeInputHandler = (event: { preventDefault: () => void }, input: SimulatedInput) => void;

function captureBeforeInput(webContents: ReturnType<typeof createWebContents>): BeforeInputHandler {
  const calls = webContents.on.mock.calls as unknown as Array<[string, BeforeInputHandler]>;
  const handler = calls.find(([event]) => event === "before-input-event")?.[1];
  if (!handler) throw new Error("before-input-event handler not registered");
  return handler;
}

describe("BrowserTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cdpSends.length = 0;
    dialogEnable.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("times out and removes an abandoned attachment waiter", async () => {
    vi.useFakeTimers();
    const { BrowserTab } = await import("./BrowserTab");
    const tab = new BrowserTab({
      tabId: "tab-timeout",
      userAgent: "ua",
      onUpdate: vi.fn<() => void>(),
      onAttention: vi.fn<() => void>(),
      onPopup: vi.fn<() => void>(),
    });

    const pending = tab.whenAttached(250);
    const rejection = pending.catch((error: unknown) => error);
    expect((tab as unknown as { attachmentWaiters: Set<unknown> }).attachmentWaiters.size).toBe(1);

    await vi.advanceTimersByTimeAsync(250);

    expect(await rejection).toEqual(
      expect.objectContaining({ message: expect.stringContaining("attachment timed out") }),
    );
    expect((tab as unknown as { attachmentWaiters: Set<unknown> }).attachmentWaiters.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects generation-bound attachment waiters when a guest disappears", async () => {
    const { BrowserTab } = await import("./BrowserTab");
    const tab = new BrowserTab({
      tabId: "tab-generation",
      userAgent: "ua",
      onUpdate: vi.fn<() => void>(),
      onAttention: vi.fn<() => void>(),
      onPopup: vi.fn<() => void>(),
    });
    const firstWebContents = createWebContents("https://example.com/first");
    const firstReady = tab.whenAttached();
    tab.attach(firstWebContents as never);
    firstWebContents.emit("destroyed");

    await expect(firstReady).rejects.toThrow("attachment target was destroyed");

    const secondReady = tab.whenAttached();
    tab.attach(createWebContents("https://example.com/second") as never);
    await expect(secondReady).resolves.toBeUndefined();
  });

  it("rejects every attachment waiter when the tab is destroyed", async () => {
    const { BrowserTab } = await import("./BrowserTab");
    const tab = new BrowserTab({
      tabId: "tab-destroyed",
      userAgent: "ua",
      onUpdate: vi.fn<() => void>(),
      onAttention: vi.fn<() => void>(),
      onPopup: vi.fn<() => void>(),
    });
    const first = tab.whenAttached();
    const second = tab.whenAttached();
    const firstRejection = first.catch((error: unknown) => error);
    const secondRejection = second.catch((error: unknown) => error);

    await tab.destroy();

    expect(await firstRejection).toEqual(
      expect.objectContaining({ message: expect.stringContaining("was destroyed") }),
    );
    expect(await secondRejection).toEqual(
      expect.objectContaining({ message: expect.stringContaining("was destroyed") }),
    );
    expect((tab as unknown as { attachmentWaiters: Set<unknown> }).attachmentWaiters.size).toBe(0);
  });

  it("becomes ready when best-effort dialog initialization never settles", async () => {
    vi.useFakeTimers();
    dialogEnable.mockReturnValue(new Promise<void>(() => {}));
    const { BrowserTab } = await import("./BrowserTab");
    const tab = new BrowserTab({
      tabId: "tab-dialog-init-timeout",
      userAgent: "ua",
      onUpdate: vi.fn<() => void>(),
      onAttention: vi.fn<() => void>(),
      onPopup: vi.fn<() => void>(),
    });

    tab.attach(createWebContents() as never);
    const ready = tab.whenAttached();
    const observed = ready.then(
      () => "ready" as const,
      () => "rejected" as const,
    );

    await vi.advanceTimersByTimeAsync(1_100);

    expect(await Promise.race([observed, Promise.resolve("pending" as const)])).toBe("ready");
    expect((tab as unknown as { attachmentWaiters: Set<unknown> }).attachmentWaiters.size).toBe(0);
    await tab.destroy();
  });

  it("becomes ready when replacement retained-script restoration never settles", async () => {
    vi.useFakeTimers();
    const { BrowserTab } = await import("./BrowserTab");
    const tab = new BrowserTab({
      tabId: "tab-retained-init-timeout",
      userAgent: "ua",
      onUpdate: vi.fn<() => void>(),
      onAttention: vi.fn<() => void>(),
      onPopup: vi.fn<() => void>(),
    });
    const firstWebContents = createWebContents("https://example.com/first");
    tab.attach(firstWebContents as never);
    await tab.whenAttached();
    await tab.addInitScript("window.__retained = true");

    firstWebContents.emit("destroyed");
    const secondWebContents = createWebContents("https://example.com/second");
    tab.attach(secondWebContents as never);
    cdpSends[1]?.mockImplementation(async (method) => {
      if (method === "Page.addScriptToEvaluateOnNewDocument") {
        return await new Promise<never>(() => {});
      }
      return {};
    });
    const ready = tab.whenAttached();
    const observed = ready.then(
      () => "ready" as const,
      () => "rejected" as const,
    );

    await vi.advanceTimersByTimeAsync(1_100);

    expect(await Promise.race([observed, Promise.resolve("pending" as const)])).toBe("ready");
    expect((tab as unknown as { attachmentWaiters: Set<unknown> }).attachmentWaiters.size).toBe(0);
    await tab.destroy();
  });

  it("becomes ready when retained-script one-shot application never settles", async () => {
    vi.useFakeTimers();
    const { BrowserTab } = await import("./BrowserTab");
    const tab = new BrowserTab({
      tabId: "tab-retained-application-timeout",
      userAgent: "ua",
      onUpdate: vi.fn<() => void>(),
      onAttention: vi.fn<() => void>(),
      onPopup: vi.fn<() => void>(),
    });
    const firstWebContents = createWebContents("https://example.com/first");
    tab.attach(firstWebContents as never);
    await tab.whenAttached();
    await tab.addInitScript("window.__retained = true");

    firstWebContents.emit("destroyed");
    const secondWebContents = createWebContents("https://example.com/second");
    tab.attach(secondWebContents as never);
    let scriptNumber = 0;
    cdpSends[1]?.mockImplementation(async (method) => {
      if (method === "Page.addScriptToEvaluateOnNewDocument") {
        scriptNumber += 1;
        return { identifier: `replacement-script-${scriptNumber}` };
      }
      if (method === "Runtime.evaluate") return await new Promise<never>(() => {});
      return {};
    });
    const ready = tab.whenAttached();
    const observed = ready.then(
      () => "ready" as const,
      () => "rejected" as const,
    );

    await vi.advanceTimersByTimeAsync(1_100);

    expect(await Promise.race([observed, Promise.resolve("pending" as const)])).toBe("ready");
    expect((tab as unknown as { attachmentWaiters: Set<unknown> }).attachmentWaiters.size).toBe(0);
    await tab.destroy();
  });

  it("observes a retained-script rejection when restoration exhausts its deadline", async () => {
    vi.useFakeTimers();
    const { BrowserTab } = await import("./BrowserTab");
    const tab = new BrowserTab({
      tabId: "tab-retained-deadline-rejection",
      userAgent: "ua",
      onUpdate: vi.fn<() => void>(),
      onAttention: vi.fn<() => void>(),
      onPopup: vi.fn<() => void>(),
    });
    const firstWebContents = createWebContents("https://example.com/first");
    tab.attach(firstWebContents as never);
    await tab.whenAttached();
    await tab.addInitScript("window.__retained = true");

    firstWebContents.emit("destroyed");
    const secondWebContents = createWebContents("https://example.com/second");
    tab.attach(secondWebContents as never);
    const lateFailure = new Error("one-shot failed at the restoration deadline");
    cdpSends[1]?.mockImplementation(async (method) => {
      if (method === "Page.addScriptToEvaluateOnNewDocument") {
        return await new Promise<{ identifier: string }>((resolve) => {
          setTimeout(() => resolve({ identifier: "replacement-script" }), 999);
        });
      }
      if (method === "Runtime.evaluate") {
        vi.setSystemTime(Date.now() + 2);
        throw lateFailure;
      }
      return {};
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      const ready = tab.whenAttached();
      await vi.advanceTimersByTimeAsync(1_100);
      await ready;
      await Promise.resolve();

      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await tab.destroy();
    }
  });

  it("permanently disables popup routing when a sensitive tab is destroyed", async () => {
    const { BrowserTab } = await import("./BrowserTab");
    const tab = new BrowserTab({
      tabId: "tab-sensitive-destroy",
      userAgent: "ua",
      permissionProfile: "sensitive",
      onUpdate: vi.fn<() => void>(),
      onAttention: vi.fn<() => void>(),
      onPopup: vi.fn<() => void>(),
    });
    tab.attach(createWebContents("https://accounts.example.test/") as never);

    await tab.destroy();

    expect(removeNavigationGuards).toHaveBeenCalledOnce();
  });

  it("bounds page-controlled title, URL, and console data by UTF-8 bytes", async () => {
    const {
      BrowserTab,
      MAX_BROWSER_CONSOLE_TOTAL_BYTES,
      MAX_BROWSER_TITLE_BYTES,
      MAX_BROWSER_URL_BYTES,
    } = await import("./BrowserTab");
    const tab = new BrowserTab({
      tabId: "tab-bounded-page-data",
      userAgent: "ua",
      onUpdate: vi.fn<() => void>(),
      onAttention: vi.fn<() => void>(),
      onPopup: vi.fn<() => void>(),
    });
    const webContents = createWebContents(`https://example.test/${"u".repeat(100_000)}`);
    tab.attach(webContents as never);
    webContents.emit("page-title-updated", {}, "🚀".repeat(20_000));
    for (let index = 0; index < 100; index += 1) {
      webContents.emit("console-message", {
        level: "error",
        message: `entry-${index}-${"🚀".repeat(20_000)}`,
        sourceId: `source-${"s".repeat(50_000)}`,
        lineNumber: index,
      });
    }

    const snapshot = tab.snapshot();
    const consoleBytes = tab
      .getConsoleEntries()
      .reduce(
        (total, entry) =>
          total +
          Buffer.byteLength(entry.text, "utf8") +
          Buffer.byteLength(entry.source ?? "", "utf8"),
        0,
      );

    expect(Buffer.byteLength(snapshot.url, "utf8")).toBeLessThanOrEqual(MAX_BROWSER_URL_BYTES);
    expect(Buffer.byteLength(snapshot.title, "utf8")).toBeLessThanOrEqual(MAX_BROWSER_TITLE_BYTES);
    expect(consoleBytes).toBeLessThanOrEqual(MAX_BROWSER_CONSOLE_TOTAL_BYTES);
  });

  it("applies the configured browser user agent to attached webContents", async () => {
    const { BrowserTab } = await import("./BrowserTab");
    const userAgent =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
    const tab = new BrowserTab({
      tabId: "tab-1",
      userAgent,
      onUpdate: vi.fn<() => void>(),
      onAttention: vi.fn<() => void>(),
      onPopup: vi.fn<() => void>(),
    });
    const webContents = createWebContents();

    tab.attach(webContents as never);

    expect(webContents.setUserAgent).toHaveBeenCalledWith(userAgent);
    expect(installSessionPermissions).toHaveBeenCalledWith(webContents.session);
    expect(installNavigationGuards).toHaveBeenCalled();
  });

  it("installs only the deny-by-default permission profile for a sensitive session", async () => {
    const { BrowserTab } = await import("./BrowserTab");
    const tab = new BrowserTab({
      tabId: "tab-sensitive",
      userAgent: "ua",
      permissionProfile: "sensitive",
      onUpdate: vi.fn<() => void>(),
      onAttention: vi.fn<() => void>(),
      onPopup: vi.fn<() => void>(),
    });
    const webContents = createWebContents("https://pipedream.com/connect");

    tab.attach(webContents as never);

    expect(installSensitiveSessionPermissions).toHaveBeenCalledExactlyOnceWith(webContents.session);
    expect(installSessionPermissions).not.toHaveBeenCalled();
    expect(installNavigationGuards).toHaveBeenCalledWith(
      webContents,
      expect.any(Function),
      "sensitive",
    );
  });

  it("releases CDP-backed controllers on suspension and rebinds dialogs after remount", async () => {
    const { BrowserTab } = await import("./BrowserTab");
    const tab = new BrowserTab({
      tabId: "tab-remount",
      userAgent: "ua",
      onUpdate: vi.fn<() => void>(),
      onAttention: vi.fn<() => void>(),
      onPopup: vi.fn<() => void>(),
    });
    const firstWebContents = createWebContents("https://example.com/first");
    const secondWebContents = createWebContents("https://example.com/second");

    expect(tab.attach(firstWebContents as never)).toBe(true);
    expect(tab.attach(firstWebContents as never)).toBe(false);
    await vi.waitFor(() => expect(dialogEnable).toHaveBeenCalledTimes(1));

    firstWebContents.emit("destroyed");

    expect(dialogSuspend).toHaveBeenCalledOnce();
    expect(networkSuspend).toHaveBeenCalledOnce();
    expect(tab.isAttached()).toBe(false);

    expect(tab.attach(secondWebContents as never)).toBe(true);

    await vi.waitFor(() => expect(dialogEnable).toHaveBeenCalledTimes(2));
    expect(tab.isAttached()).toBe(true);
  });

  it("reinstalls retained agent scripts and styles before navigating a replacement target", async () => {
    const { BrowserTab } = await import("./BrowserTab");
    const tab = new BrowserTab({
      tabId: "tab-persistent-init",
      userAgent: "ua",
      onUpdate: vi.fn<() => void>(),
      onAttention: vi.fn<() => void>(),
      onPopup: vi.fn<() => void>(),
    });
    const firstWebContents = createWebContents("https://example.com/first");
    tab.attach(firstWebContents as never);
    await vi.waitFor(() => expect(dialogEnable).toHaveBeenCalledTimes(1));

    const script = await tab.addInitScript("window.__agentScript = true");
    const style = await tab.addInitStyle("body { color: rgb(1, 2, 3); }");

    expect(script.identifier).not.toBe("target-1-script-1");
    expect(style.identifier).not.toBe("target-1-script-2");
    expect(tab.listInitScripts()).toEqual([script.identifier, style.identifier]);

    firstWebContents.emit("destroyed");
    const secondWebContents = createWebContents("https://example.com/remounted");
    tab.attach(secondWebContents as never);

    const navigation = tab.loadURL("https://example.com/after-remount");
    await navigation;

    const replacementAdds = cdpSends[1]?.mock.calls.filter(
      ([method]) => method === "Page.addScriptToEvaluateOnNewDocument",
    );
    expect(replacementAdds).toHaveLength(2);
    expect(replacementAdds?.[0]?.[1]).toMatchObject({ source: "window.__agentScript = true" });
    expect(String(replacementAdds?.[1]?.[1]?.source)).toContain("body { color: rgb(1, 2, 3); }");
    expect(cdpSends[1]?.mock.invocationCallOrder[2]).toBeLessThan(
      secondWebContents.loadURL.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );

    await tab.removeInitScript(script.identifier);
    expect(cdpSends[1]).toHaveBeenCalledWith("Page.removeScriptToEvaluateOnNewDocument", {
      identifier: "target-2-script-1",
    });
    expect(tab.listInitScripts()).toEqual([style.identifier]);

    await expect(tab.removeAllInitScripts()).resolves.toBe(1);
    expect(cdpSends[1]).toHaveBeenCalledWith("Page.removeScriptToEvaluateOnNewDocument", {
      identifier: "target-2-script-2",
    });
    expect(tab.listInitScripts()).toEqual([]);
  });

  it("rejects unbounded retained init-script source before installing it", async () => {
    const { BrowserTab } = await import("./BrowserTab");
    const tab = new BrowserTab({
      tabId: "tab-bounded-init",
      userAgent: "ua",
      onUpdate: vi.fn<() => void>(),
      onAttention: vi.fn<() => void>(),
      onPopup: vi.fn<() => void>(),
    });
    tab.attach(createWebContents() as never);
    await vi.waitFor(() => expect(dialogEnable).toHaveBeenCalledTimes(1));

    await expect(tab.addInitScript("x".repeat(1024 * 1024))).rejects.toThrow(
      "retained init-script source limit",
    );
    expect(
      cdpSends[0]?.mock.calls.filter(
        ([method]) => method === "Page.addScriptToEvaluateOnNewDocument",
      ),
    ).toEqual([]);
    expect(tab.listInitScripts()).toEqual([]);
  });

  it("does not clear newly navigated history after initial page cleanup", async () => {
    vi.useFakeTimers();
    try {
      const { BrowserTab } = await import("./BrowserTab");
      const tab = new BrowserTab({
        tabId: "tab-1",
        initialUrl: "data:text/html,first",
        userAgent: "ua",
        onUpdate: vi.fn<() => void>(),
        onAttention: vi.fn<() => void>(),
        onPopup: vi.fn<() => void>(),
      });
      const webContents = createWebContents("data:text/html,first");
      tab.attach(webContents as never);

      expect(webContents.navigationHistory.clear).toHaveBeenCalledTimes(1);

      await tab.loadURL("data:text/html,second");
      webContents.emit("did-navigate", {}, "data:text/html,second");
      webContents.emit("did-stop-loading");
      await webContents.loadURL("data:text/html,first");
      webContents.emit("did-navigate", {}, "data:text/html,first");
      await vi.advanceTimersByTimeAsync(500);

      expect(webContents.navigationHistory.clear).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("navigates back/forward on Ctrl+[ and Ctrl+] keydown", async () => {
    const { BrowserTab } = await import("./BrowserTab");
    const tab = new BrowserTab({
      tabId: "tab-1",
      userAgent: "ua",
      onUpdate: vi.fn<() => void>(),
      onAttention: vi.fn<() => void>(),
      onPopup: vi.fn<() => void>(),
    });
    const webContents = createWebContents();
    tab.attach(webContents as never);

    const handler = captureBeforeInput(webContents);
    const back = { preventDefault: vi.fn<() => void>() };
    handler(back, { type: "keyDown", control: true, key: "[" });
    expect(back.preventDefault).toHaveBeenCalled();
    expect(webContents.navigationHistory.goBack).toHaveBeenCalledTimes(1);
    expect(webContents.navigationHistory.goForward).not.toHaveBeenCalled();

    const forward = { preventDefault: vi.fn<() => void>() };
    handler(forward, { type: "keyDown", meta: true, key: "]" });
    expect(forward.preventDefault).toHaveBeenCalled();
    expect(webContents.navigationHistory.goForward).toHaveBeenCalledTimes(1);
  });

  it("closes the first-class browser page on Cmd/Ctrl+W from its guest", async () => {
    const { BrowserTab } = await import("./BrowserTab");
    const onClose = vi.fn<(tabId: string) => void>();
    const tab = new BrowserTab({
      tabId: "tab-close",
      userAgent: "ua",
      onUpdate: vi.fn<() => void>(),
      onAttention: vi.fn<() => void>(),
      onPopup: vi.fn<() => void>(),
      onClose,
    });
    const webContents = createWebContents();
    tab.attach(webContents as never);

    const event = { preventDefault: vi.fn<() => void>() };
    captureBeforeInput(webContents)(event, { type: "keyDown", meta: true, key: "w" });

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("tab-close");
  });

  it("opens a peer browser page on Cmd/Ctrl+T from its guest", async () => {
    const { BrowserTab } = await import("./BrowserTab");
    const onNewTab = vi.fn<() => void>();
    const tab = new BrowserTab({
      tabId: "tab-current",
      userAgent: "ua",
      onUpdate: vi.fn<() => void>(),
      onAttention: vi.fn<() => void>(),
      onPopup: vi.fn<() => void>(),
      onNewTab,
    });
    const webContents = createWebContents();
    tab.attach(webContents as never);

    const event = { preventDefault: vi.fn<() => void>() };
    captureBeforeInput(webContents)(event, { type: "keyDown", control: true, key: "t" });

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(onNewTab).toHaveBeenCalledOnce();
  });

  it("routes global next/previous shortcuts from the focused guest", async () => {
    const { BrowserTab } = await import("./BrowserTab");
    const onCycle = vi.fn<(tabId: string, direction: "next" | "previous") => void>();
    const tab = new BrowserTab({
      tabId: "tab-current",
      userAgent: "ua",
      onUpdate: vi.fn<() => void>(),
      onAttention: vi.fn<() => void>(),
      onPopup: vi.fn<() => void>(),
      onCycle,
    });
    const webContents = createWebContents();
    tab.attach(webContents as never);
    const handler = captureBeforeInput(webContents);

    const next = { preventDefault: vi.fn<() => void>() };
    handler(next, { type: "keyDown", control: true, key: "Tab" });
    expect(next.preventDefault).toHaveBeenCalledOnce();
    expect(onCycle).toHaveBeenLastCalledWith("tab-current", "next");

    const previous = { preventDefault: vi.fn<() => void>() };
    handler(previous, { type: "keyDown", control: true, shift: true, key: "Tab" });
    expect(previous.preventDefault).toHaveBeenCalledOnce();
    expect(onCycle).toHaveBeenLastCalledWith("tab-current", "previous");

    const nextBracket = { preventDefault: vi.fn<() => void>() };
    handler(nextBracket, { type: "keyDown", meta: true, shift: true, key: "]" });
    expect(nextBracket.preventDefault).toHaveBeenCalledOnce();
    expect(onCycle).toHaveBeenLastCalledWith("tab-current", "next");

    const previousPage = { preventDefault: vi.fn<() => void>() };
    handler(previousPage, { type: "keyDown", meta: true, key: "PageUp" });
    expect(previousPage.preventDefault).toHaveBeenCalledOnce();
    expect(onCycle).toHaveBeenLastCalledWith("tab-current", "previous");
    expect(onCycle).toHaveBeenCalledTimes(4);
  });

  it("does not navigate when the bracket key is pressed without a modifier", async () => {
    const { BrowserTab } = await import("./BrowserTab");
    const tab = new BrowserTab({
      tabId: "tab-1",
      userAgent: "ua",
      onUpdate: vi.fn<() => void>(),
      onAttention: vi.fn<() => void>(),
      onPopup: vi.fn<() => void>(),
    });
    const webContents = createWebContents();
    tab.attach(webContents as never);

    const handler = captureBeforeInput(webContents);
    const event = { preventDefault: vi.fn<() => void>() };
    handler(event, { type: "keyDown", key: "[" });
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(webContents.navigationHistory.goBack).not.toHaveBeenCalled();
  });

  it("cycles instead of navigating on shifted bracket chords", async () => {
    const { BrowserTab } = await import("./BrowserTab");
    const onCycle = vi.fn<(tabId: string, direction: "next" | "previous") => void>();
    const tab = new BrowserTab({
      tabId: "tab-1",
      userAgent: "ua",
      onUpdate: vi.fn<() => void>(),
      onAttention: vi.fn<() => void>(),
      onPopup: vi.fn<() => void>(),
      onCycle,
    });
    const webContents = createWebContents();
    tab.attach(webContents as never);

    const handler = captureBeforeInput(webContents);
    const event = { preventDefault: vi.fn<() => void>() };
    handler(event, { type: "keyDown", control: true, shift: true, key: "[" });
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(onCycle).toHaveBeenCalledWith("tab-1", "previous");
    expect(webContents.navigationHistory.goBack).not.toHaveBeenCalled();
  });
});
