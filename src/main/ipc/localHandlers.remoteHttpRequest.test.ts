import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalIpcHandlers } from "./localHandlers";

type FetchMock = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

function makeHandlers(
  browserPanelManager: {
    openLink(url: string): Promise<boolean>;
    acknowledgeAutomationPresentation?(payload: unknown): void;
    invalidateAutomationPresentation?(payload: unknown): void;
    createIsolatedSensitiveIntegrationTab?(payload: {
      url: string;
      activate?: boolean;
      reveal?: boolean;
    }): Promise<{ tabId: string }>;
  } | null = null,
  openSystemUrl?: (url: string) => Promise<void>,
  isQuitting?: () => boolean,
) {
  return createLocalIpcHandlers({
    getMainWindow: () => null,
    getBrowserPanelManager: () => browserPanelManager as never,
    ...(isQuitting ? { isQuitting } : {}),
    getRemoteAccessServer: () => null,
    setRemoteAccessEnabled: vi.fn<(enabled: boolean) => Promise<{ status: "disabled" }>>(
      async () => ({ status: "disabled" }),
    ),
    getRemoteAccessTailscaleStatus: vi.fn<() => Promise<never>>(),
    setRemoteAccessTailscaleHttps: vi.fn<(enabled: boolean) => Promise<{ status: "disabled" }>>(
      async () => ({ status: "disabled" }),
    ),
    startTailscale: vi.fn<() => Promise<{ ok: boolean }>>(async () => ({ ok: true })),
    setRemoteAccessAdvertisedUrl: vi.fn<(url: string) => Promise<{ status: "disabled" }>>(
      async () => ({ status: "disabled" }),
    ),
    sshConnectionManager: {
      discoverHosts: vi.fn<() => never[]>(() => []),
      connect: vi.fn<() => Promise<never>>(),
      disconnect: vi.fn<() => Promise<void>>(),
    } as never,
    requirePoracodePaths: () =>
      ({
        baseDir: "/tmp/poracode",
        dbPath: "/tmp/poracode/db.sqlite",
        logsDir: "/tmp/poracode/logs",
        terminalLogsDir: "/tmp/poracode/logs",
        attachmentsDir: "/tmp/poracode/attachments",
        worktreesDir: "/tmp/poracode/worktrees",
        cacheDir: "/tmp/poracode/cache",
        settingsPath: "/tmp/poracode/settings.json",
        keybindingsPath: "/tmp/poracode/keybindings.json",
        statusCachePath: "/tmp/poracode/status-cache.json",
      }) as never,
    updatePowerSaveBlocker: vi.fn<() => void>(),
    autoUpdater: {
      initialize: vi.fn<() => void>(),
      dispose: vi.fn<() => void>(),
      getStatus: vi.fn<() => null>(() => null),
      checkForUpdate: vi.fn<() => Promise<void>>(async () => {}),
      startUpdateDownload: vi.fn<() => Promise<void>>(async () => {}),
      installUpdate: vi.fn<() => void>(),
    },
    extractBrowserToWindow: vi.fn<() => void>(),
    injectBrowserToMain: vi.fn<() => void>(),
    requestRelaunch: vi.fn<() => void>(),
    scheduleService: {} as never,
    prWatchService: {} as never,
    pipedreamMainService: {} as never,
    browserCookieImportService: {} as never,
    cookieImportBridge: {} as never,
    browserCookieImportExtensionDir: "/tmp/y-space-cookie-import",
    ...(openSystemUrl ? { openSystemUrl } : {}),
  });
}

describe("local remoteHttpRequest handler", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("forwards http requests through main-process fetch", async () => {
    const fetchMock = vi.fn<FetchMock>(async (url, init): Promise<Response> => {
      expect(String(url)).toBe("https://remote.example.test/api/snapshot");
      expect(init).toMatchObject({
        method: "POST",
        headers: { authorization: "Bearer token" },
        body: "{}",
      });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response("ok", {
        status: 202,
        headers: { "x-poracode": "remote" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      makeHandlers().remoteHttpRequest({
        url: "https://remote.example.test/api/snapshot",
        method: "POST",
        headers: { authorization: "Bearer token" },
        body: "{}",
      }),
    ).resolves.toEqual({
      status: 202,
      headers: { "content-type": "text/plain;charset=UTF-8", "x-poracode": "remote" },
      body: "ok",
    });
  });

  it("forwards delete requests through main-process fetch", async () => {
    const fetchMock = vi.fn<FetchMock>(async (_url, init): Promise<Response> => {
      expect(init).toMatchObject({ method: "DELETE", body: "{}" });
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      makeHandlers().remoteHttpRequest({
        url: "https://remote.example.test/api/pr-watches",
        method: "DELETE",
        body: "{}",
      }),
    ).resolves.toMatchObject({ status: 204 });
  });

  it("rejects non-http protocols before fetching", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      makeHandlers().remoteHttpRequest({ url: "file:///tmp/poracode.json" }),
    ).rejects.toThrow('remoteHttpRequest only supports http(s), got "file:".');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects oversized remote responses before reading the body", async () => {
    const fetchMock = vi.fn<FetchMock>(async (): Promise<Response> => {
      return new Response("small", {
        headers: { "content-length": String(64 * 1024 * 1024 + 1) },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      makeHandlers().remoteHttpRequest({ url: "http://127.0.0.1:38987/api/snapshot" }),
    ).rejects.toThrow("response body too large");
  });

  it("aborts requests that do not complete", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<FetchMock>(
      (_url, init): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = makeHandlers().remoteHttpRequest({
      url: "http://127.0.0.1:38987/api/snapshot",
    });
    const result = Promise.resolve(request).then(
      () => "resolved",
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(result).resolves.toMatchObject({
      message: "Remote request timed out after 60000ms.",
    });
  });
});

describe("local external-link handlers", () => {
  it("opens an explicitly sensitive OAuth URL through a dedicated embedded-tab handler", async () => {
    const createIsolatedSensitiveIntegrationTab = vi.fn<
      (payload: { url: string; activate?: boolean; reveal?: boolean }) => Promise<{ tabId: string }>
    >(async () => ({ tabId: "oauth-tab" }));
    const handlers = makeHandlers({
      openLink: vi.fn<(url: string) => Promise<boolean>>(async () => true),
      createIsolatedSensitiveIntegrationTab,
    });

    await expect(
      handlers.browserCreateSensitiveTab({
        url: "https://oauth.example.test/authorize?state=private",
        activate: true,
        reveal: true,
      }),
    ).resolves.toMatchObject({ tabId: "oauth-tab" });
    expect(createIsolatedSensitiveIntegrationTab).toHaveBeenCalledWith({
      url: "https://oauth.example.test/authorize?state=private",
      activate: true,
      reveal: true,
    });
  });

  it.each(["openExternal", "openExternalNative"] as const)(
    "routes %s HTTP(S) links into the embedded browser",
    async (handlerName) => {
      const openLink = vi.fn<(url: string) => Promise<boolean>>(async () => true);
      const handlers = makeHandlers({ openLink });

      await handlers[handlerName]("https://example.test/settings?source=y-space");

      expect(openLink).toHaveBeenCalledWith("https://example.test/settings?source=y-space");
    },
  );

  it.each(["openExternal", "openExternalNative"] as const)(
    "fails closed for %s HTTP(S) links before the embedded browser is initialized",
    async (handlerName) => {
      const openSystemUrl = vi.fn<(url: string) => Promise<void>>(async () => undefined);

      await expect(
        makeHandlers(null, openSystemUrl)[handlerName]("https://example.test/early"),
      ).rejects.toThrow("Embedded browser is not initialized");

      expect(openSystemUrl).not.toHaveBeenCalled();
    },
  );

  it.each(["openExternal", "openExternalNative"] as const)(
    "allows %s mail links to use the operating-system mail handler",
    async (handlerName) => {
      const openSystemUrl = vi.fn<(url: string) => Promise<void>>(async () => undefined);

      await makeHandlers(null, openSystemUrl)[handlerName]("mailto:hello@example.test");

      expect(openSystemUrl).toHaveBeenCalledWith("mailto:hello@example.test");
    },
  );
});

describe("local browser presentation lifecycle handlers", () => {
  it("ignores acknowledgements that arrive after the browser manager is disposed", () => {
    const handlers = makeHandlers();

    expect(() =>
      handlers.browserAcknowledgeAutomationPresentation({
        requestId: "1f112f62-968d-41d5-9baa-a1189624ff73",
        tabId: "tab-shutdown",
        surface: "main",
        presented: true,
      }),
    ).not.toThrow();
    expect(() =>
      handlers.browserInvalidateAutomationPresentation({
        requestId: "1f112f62-968d-41d5-9baa-a1189624ff73",
        tabId: "tab-shutdown",
        surface: "main",
        reason: "renderer-unmounted",
      }),
    ).not.toThrow();

    // Actual browser commands retain the strict manager requirement.
    expect(() => handlers.browserGetState({})).toThrow("Browser panel manager is not initialized.");
  });

  it("returns an empty browser snapshot when hydration races browser teardown during quit", () => {
    const handlers = makeHandlers(null, undefined, () => true);

    expect(handlers.browserGetState({})).toEqual({ tabs: [], activeTabId: null });
  });

  it("forwards presentation lifecycle messages while the manager is available", async () => {
    const acknowledgeAutomationPresentation = vi.fn<(payload: unknown) => void>();
    const invalidateAutomationPresentation = vi.fn<(payload: unknown) => void>();
    const handlers = makeHandlers({
      openLink: vi.fn<(url: string) => Promise<boolean>>(async () => true),
      acknowledgeAutomationPresentation,
      invalidateAutomationPresentation,
    });
    const acknowledgement = {
      requestId: "070f7cfb-11c3-4448-a2aa-ee1d8f4346b2",
      tabId: "tab-live",
      surface: "main" as const,
      presented: true,
    };
    const invalidation = {
      requestId: acknowledgement.requestId,
      tabId: acknowledgement.tabId,
      surface: acknowledgement.surface,
      reason: "renderer-unmounted" as const,
    };

    const senderFrame = { processId: 9, routingId: 11 };
    const context = { senderWebContentsId: 7, senderFrame };
    await handlers.browserAcknowledgeAutomationPresentation(acknowledgement, context);
    await handlers.browserInvalidateAutomationPresentation(invalidation, context);

    expect(acknowledgeAutomationPresentation).toHaveBeenCalledExactlyOnceWith(
      acknowledgement,
      7,
      senderFrame,
    );
    expect(invalidateAutomationPresentation).toHaveBeenCalledExactlyOnceWith(
      invalidation,
      7,
      senderFrame,
    );
  });
});
