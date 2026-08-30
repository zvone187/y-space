import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { connect as connectSocket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PipedreamMainService,
  type PipedreamConnectTabOwnership,
  type PipedreamMainServiceOptions,
} from "./PipedreamMainService";
import { resetSensitiveSessionPartitionPoolForTests } from "../browser/sensitiveSessionPartitionPool";

const tempRoots: string[] = [];
const CONNECT_NOW = "2026-08-27T12:00:00.000Z";

beforeEach(() => {
  resetSensitiveSessionPartitionPoolForTests();
  vi.useFakeTimers();
  vi.setSystemTime(CONNECT_NOW);
});

afterEach(() => {
  vi.useRealTimers();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeService(overrides?: {
  persistEnvFilePath?: (filePath: string) => void;
  clearEnvFilePath?: () => void;
  configureBootstrap?: PipedreamMainServiceOptions["configureBootstrap"];
}) {
  return new PipedreamMainService({
    createConnectLink: async () => ({
      connectLinkUrl: "https://pipedream.com/connect?app=slack",
      expiresAt: "2026-08-27T12:10:00.000Z",
    }),
    openConnectUrl: async () => ({ tabId: "sensitive-tab-test" }),
    closeConnectTab: async () => undefined,
    isConnectTabOpen: async () => true,
    persistEnvFilePath: overrides?.persistEnvFilePath ?? (() => undefined),
    clearEnvFilePath: overrides?.clearEnvFilePath ?? (() => undefined),
    fallbackBootstrap: () => ({ state: "absent" }),
    configureBootstrap:
      overrides?.configureBootstrap ??
      (async () =>
        ({
          personalMcp: { enabled: false, authenticated: false, serverName: "pd" },
          connect: {
            state: "ready",
            credentialSource: "environment",
            environment: "development",
            projectIdHint: "proj_…0123",
            projectName: "Pipedream Connect",
            accounts: [],
          },
        }) as never),
  });
}

interface PipedreamConnectLifecycle {
  beginConnect(payload: { appSlug: string }): Promise<{
    opened: true;
    expiresAt: string;
    flowId: string;
  }>;
  getConnectFlowStatus(payload: {
    flowId: string;
  }): Promise<{ state: "open" | "closed" | "succeeded" | "failed" | "expired" }>;
  finishConnect(payload: { flowId: string }): Promise<void>;
  cancelConnect(payload: { flowId: string }): Promise<void>;
  dispose(): Promise<void>;
}

function requestLoopback(
  url: string,
  method = "GET",
  headers?: Readonly<Record<string, string>>,
): Promise<{ body: string; headers: IncomingHttpHeaders; statusCode: number }> {
  return new Promise((resolve, reject) => {
    const omitHost = headers?.host === "";
    const request = httpRequest(
      url,
      { method, headers: omitHost ? undefined : headers, setHost: !omitHost },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers,
            statusCode: response.statusCode ?? 0,
          }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type PipedreamConnectLifecycleOptions = PipedreamMainServiceOptions;

function makeConnectLifecycleService(
  options: PipedreamConnectLifecycleOptions,
): PipedreamConnectLifecycle {
  return new PipedreamMainService(options) as PipedreamConnectLifecycle;
}

describe("PipedreamMainService", () => {
  it("keeps Personal Pipedream OAuth URL, state, PKCE, tab id, and supervisor flow in main", async () => {
    const authorizationUrl =
      "https://pipedream.com/oauth/authorize?state=renderer-secret-sentinel&code_challenge=pkce-private";
    const wait = deferred<{ status: "authorized" }>();
    const openConnectUrl = vi.fn<PipedreamMainServiceOptions["openConnectUrl"]>(
      async (_url, ownership) => {
        ownership.onTabOpened("personal-sensitive-tab");
        return { tabId: "personal-sensitive-tab" };
      },
    );
    const closeConnectTab = vi.fn<(tabId: string) => Promise<void>>(async () => undefined);
    const service = new PipedreamMainService({
      createConnectLink: async () => ({
        connectLinkUrl: "https://pipedream.com/connect?app=slack",
        expiresAt: "2026-08-27T12:10:00.000Z",
      }),
      beginPersonalMcpOauth: async () => ({
        status: "redirect",
        flowId: "supervisor-private-flow",
        authorizationUrl,
      }),
      waitPersonalMcpOauth: async () => wait.promise,
      cancelPersonalMcpOauth: async () => undefined,
      clearPersonalMcpOauth: async () => undefined,
      openConnectUrl,
      closeConnectTab,
      isConnectTabOpen: async () => true,
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap: async () => ({}) as never,
    });

    const begin = await service.beginPersonalMcpOauth();

    expect(openConnectUrl).toHaveBeenCalledWith(authorizationUrl, expect.any(Object));
    expect(begin).toEqual({ state: "open", flowId: expect.any(String) });
    expect(JSON.stringify(begin)).not.toMatch(
      /renderer-secret-sentinel|pkce-private|authorizationUrl|supervisor-private-flow|tabId/i,
    );
    if (begin.state !== "open") throw new Error("expected an open Personal OAuth flow");

    wait.resolve({ status: "authorized" });
    await vi.waitFor(() => expect(closeConnectTab).toHaveBeenCalledWith("personal-sensitive-tab"));
    await expect(service.getPersonalMcpOauthFlowStatus({ flowId: begin.flowId! })).resolves.toEqual(
      { state: "authorized" },
    );
  });

  it("cancels Personal Pipedream OAuth and closes every owned tab without renderer tab authority", async () => {
    const cancelPersonalMcpOauth = vi.fn<(flowId: string) => Promise<void>>(async () => undefined);
    let ownership: PipedreamConnectTabOwnership | undefined;
    const closeConnectTab = vi.fn<(tabId: string) => Promise<void>>(async () => undefined);
    const service = new PipedreamMainService({
      createConnectLink: async () => ({
        connectLinkUrl: "https://pipedream.com/connect?app=slack",
        expiresAt: "2026-08-27T12:10:00.000Z",
      }),
      beginPersonalMcpOauth: async () => ({
        status: "redirect",
        flowId: "supervisor-cancel-flow",
        authorizationUrl: "https://pipedream.com/oauth/authorize?state=private",
      }),
      waitPersonalMcpOauth: () => new Promise(() => undefined),
      cancelPersonalMcpOauth,
      clearPersonalMcpOauth: async () => undefined,
      openConnectUrl: async (_url, nextOwnership) => {
        ownership = nextOwnership;
        nextOwnership.onTabOpened("personal-root");
        nextOwnership.onTabOpened("personal-popup");
        return { tabId: "personal-root" };
      },
      closeConnectTab,
      isConnectTabOpen: async () => true,
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap: async () => ({}) as never,
    });
    const begin = await service.beginPersonalMcpOauth();
    if (begin.state !== "open") throw new Error("expected an open Personal OAuth flow");

    await service.cancelPersonalMcpOauth({ flowId: begin.flowId });

    expect(cancelPersonalMcpOauth).toHaveBeenCalledExactlyOnceWith("supervisor-cancel-flow");
    expect(closeConnectTab).toHaveBeenCalledTimes(2);
    expect(closeConnectTab).toHaveBeenCalledWith("personal-root");
    expect(closeConnectTab).toHaveBeenCalledWith("personal-popup");
    expect(ownership?.canOpenTab()).toBe(false);
  });

  it("finishes and closes Personal OAuth after a renderer reload without a status poll", async () => {
    const wait = deferred<{ status: "error"; message: string }>();
    const closeConnectTab = vi.fn<(tabId: string) => Promise<void>>(async () => undefined);
    const service = new PipedreamMainService({
      createConnectLink: async () => ({
        connectLinkUrl: "https://pipedream.com/connect?app=slack",
        expiresAt: "2026-08-27T12:10:00.000Z",
      }),
      beginPersonalMcpOauth: async () => ({
        status: "redirect",
        flowId: "supervisor-reload-flow",
        authorizationUrl: "https://pipedream.com/oauth/authorize?state=private",
      }),
      waitPersonalMcpOauth: async () => wait.promise,
      cancelPersonalMcpOauth: async () => undefined,
      clearPersonalMcpOauth: async () => undefined,
      openConnectUrl: async (_url, ownership) => {
        ownership.onTabOpened("personal-reload-tab");
        return { tabId: "personal-reload-tab" };
      },
      closeConnectTab,
      isConnectTabOpen: async () => true,
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap: async () => ({}) as never,
    });

    const begin = await service.beginPersonalMcpOauth();
    if (begin.state !== "open") throw new Error("expected an open Personal OAuth flow");
    wait.resolve({ status: "error", message: "upstream private detail" });

    await vi.waitFor(() => expect(closeConnectTab).toHaveBeenCalledWith("personal-reload-tab"));
    await expect(service.getPersonalMcpOauthFlowStatus({ flowId: begin.flowId })).resolves.toEqual({
      state: "error",
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(service.getPersonalMcpOauthFlowStatus({ flowId: begin.flowId })).resolves.toEqual({
      state: "closed",
    });
  });

  it("serializes overlapping Personal OAuth begins so only one owned tab tree exists", async () => {
    const firstBegin = deferred<{
      status: "redirect";
      flowId: string;
      authorizationUrl: string;
    }>();
    const secondBegin = deferred<{
      status: "redirect";
      flowId: string;
      authorizationUrl: string;
    }>();
    const beginPersonalMcpOauth = vi
      .fn<NonNullable<PipedreamMainServiceOptions["beginPersonalMcpOauth"]>>()
      .mockImplementationOnce(async () => firstBegin.promise)
      .mockImplementationOnce(async () => secondBegin.promise);
    const openTabs = new Set<string>();
    let maximumOpenTabs = 0;
    const service = new PipedreamMainService({
      createConnectLink: async () => ({
        connectLinkUrl: "https://pipedream.com/connect?app=slack",
        expiresAt: "2026-08-27T12:10:00.000Z",
      }),
      beginPersonalMcpOauth,
      waitPersonalMcpOauth: () => new Promise(() => undefined),
      cancelPersonalMcpOauth: async () => undefined,
      clearPersonalMcpOauth: async () => undefined,
      openConnectUrl: async (url, ownership) => {
        const tabId = url.includes("first") ? "personal-first" : "personal-second";
        ownership.onTabOpened(tabId);
        openTabs.add(tabId);
        maximumOpenTabs = Math.max(maximumOpenTabs, openTabs.size);
        return { tabId };
      },
      closeConnectTab: async (tabId) => {
        openTabs.delete(tabId);
      },
      isConnectTabOpen: async (tabId) => openTabs.has(tabId),
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap: async () => ({}) as never,
    });

    const firstResult = service.beginPersonalMcpOauth();
    const secondResult = service.beginPersonalMcpOauth();
    await vi.waitFor(() => expect(beginPersonalMcpOauth).toHaveBeenCalledTimes(1));

    firstBegin.resolve({
      status: "redirect",
      flowId: "supervisor-first",
      authorizationUrl: "https://pipedream.com/oauth/authorize?flow=first",
    });
    await expect(firstResult).resolves.toEqual({ state: "open", flowId: expect.any(String) });
    await vi.waitFor(() => expect(beginPersonalMcpOauth).toHaveBeenCalledTimes(2));
    secondBegin.resolve({
      status: "redirect",
      flowId: "supervisor-second",
      authorizationUrl: "https://pipedream.com/oauth/authorize?flow=second",
    });
    await expect(secondResult).resolves.toEqual({ state: "open", flowId: expect.any(String) });

    expect(maximumOpenTabs).toBe(1);
    expect(openTabs).toEqual(new Set(["personal-second"]));
    await service.dispose();
  });

  it("blocks a replacement Personal OAuth flow until failed exact-tab cleanup retries", async () => {
    const retryClose = deferred<void>();
    const openTabs = new Set<string>();
    const beginPersonalMcpOauth = vi
      .fn<NonNullable<PipedreamMainServiceOptions["beginPersonalMcpOauth"]>>()
      .mockResolvedValueOnce({
        status: "redirect",
        flowId: "supervisor-first-cleanup",
        authorizationUrl: "https://pipedream.com/oauth/authorize?flow=first-cleanup",
      })
      .mockResolvedValueOnce({
        status: "redirect",
        flowId: "supervisor-replacement-cleanup",
        authorizationUrl: "https://pipedream.com/oauth/authorize?flow=replacement-cleanup",
      });
    const closeConnectTab = vi
      .fn<(tabId: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("exact sensitive tab is still open"))
      .mockImplementationOnce(async (tabId) => {
        await retryClose.promise;
        openTabs.delete(tabId);
      })
      .mockImplementation(async (tabId) => {
        openTabs.delete(tabId);
      });
    const service = new PipedreamMainService({
      createConnectLink: async () => ({
        connectLinkUrl: "https://pipedream.com/connect?app=slack",
        expiresAt: "2026-08-27T12:10:00.000Z",
      }),
      beginPersonalMcpOauth,
      waitPersonalMcpOauth: () => new Promise(() => undefined),
      cancelPersonalMcpOauth: async () => undefined,
      clearPersonalMcpOauth: async () => undefined,
      openConnectUrl: async (url, ownership) => {
        const tabId = url.includes("replacement") ? "personal-replacement" : "personal-first";
        ownership.onTabOpened(tabId);
        openTabs.add(tabId);
        return { tabId };
      },
      closeConnectTab,
      isConnectTabOpen: async (tabId) => openTabs.has(tabId),
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap: async () => ({}) as never,
    });
    const first = await service.beginPersonalMcpOauth();
    expect(first).toMatchObject({ state: "open" });

    let replacementSettled = false;
    const replacement = service.beginPersonalMcpOauth().finally(() => {
      replacementSettled = true;
    });
    await vi.waitFor(() => expect(closeConnectTab).toHaveBeenCalledOnce());
    expect(beginPersonalMcpOauth).toHaveBeenCalledOnce();
    expect(replacementSettled).toBe(false);
    expect(openTabs).toEqual(new Set(["personal-first"]));

    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(closeConnectTab).toHaveBeenCalledTimes(2));
    expect(beginPersonalMcpOauth).toHaveBeenCalledOnce();
    expect(replacementSettled).toBe(false);

    retryClose.resolve();
    await expect(replacement).resolves.toMatchObject({ state: "open" });
    expect(beginPersonalMcpOauth).toHaveBeenCalledTimes(2);
    expect(openTabs).toEqual(new Set(["personal-replacement"]));
    await service.dispose();
  });

  it("revokes Personal OAuth and returns while exact-tab cleanup retries in quarantine", async () => {
    const retryClose = deferred<void>();
    const openTabs = new Set(["personal-clear-pending"]);
    const clearPersonalMcpOauth = vi.fn<() => Promise<void>>(async () => undefined);
    const closeConnectTab = vi
      .fn<(tabId: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("exact sensitive tab is still open"))
      .mockImplementationOnce(async (tabId) => {
        await retryClose.promise;
        openTabs.delete(tabId);
      });
    const service = new PipedreamMainService({
      createConnectLink: async () => ({
        connectLinkUrl: "https://pipedream.com/connect?app=slack",
        expiresAt: "2026-08-27T12:10:00.000Z",
      }),
      beginPersonalMcpOauth: async () => ({
        status: "redirect",
        flowId: "supervisor-clear-pending",
        authorizationUrl: "https://pipedream.com/oauth/authorize?flow=clear-pending",
      }),
      waitPersonalMcpOauth: () => new Promise(() => undefined),
      cancelPersonalMcpOauth: async () => undefined,
      clearPersonalMcpOauth,
      openConnectUrl: async (_url, ownership) => {
        ownership.onTabOpened("personal-clear-pending");
        return { tabId: "personal-clear-pending" };
      },
      closeConnectTab,
      isConnectTabOpen: async (tabId) => openTabs.has(tabId),
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap: async () => ({}) as never,
    });
    await service.beginPersonalMcpOauth();

    const clear = service.clearPersonalMcpOauth();
    await vi.waitFor(() => expect(closeConnectTab).toHaveBeenCalledOnce());
    await expect(clear).resolves.toBeUndefined();
    expect(clearPersonalMcpOauth).toHaveBeenCalledOnce();
    expect(openTabs).toEqual(new Set(["personal-clear-pending"]));

    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(closeConnectTab).toHaveBeenCalledTimes(2));
    expect(clearPersonalMcpOauth).toHaveBeenCalledOnce();

    retryClose.resolve();
    await vi.waitFor(() => expect(openTabs).toEqual(new Set()));
    expect(clearPersonalMcpOauth).toHaveBeenCalledOnce();
  });

  it("revokes Personal OAuth even while an earlier status inspection is stuck", async () => {
    const inspection = deferred<boolean>();
    const clearPersonalMcpOauth = vi.fn<() => Promise<void>>(async () => undefined);
    const isConnectTabOpen = vi.fn<(tabId: string) => Promise<boolean>>(
      async () => inspection.promise,
    );
    const service = new PipedreamMainService({
      createConnectLink: async () => ({
        connectLinkUrl: "https://pipedream.com/connect?app=slack",
        expiresAt: "2026-08-27T12:10:00.000Z",
      }),
      beginPersonalMcpOauth: async () => ({
        status: "redirect",
        flowId: "supervisor-stuck-status",
        authorizationUrl: "https://pipedream.com/oauth/authorize?flow=stuck-status",
      }),
      waitPersonalMcpOauth: () => new Promise(() => undefined),
      cancelPersonalMcpOauth: async () => undefined,
      clearPersonalMcpOauth,
      openConnectUrl: async (_url, ownership) => {
        ownership.onTabOpened("personal-stuck-status");
        return { tabId: "personal-stuck-status" };
      },
      closeConnectTab: async () => undefined,
      isConnectTabOpen,
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap: async () => ({}) as never,
    });
    const begin = await service.beginPersonalMcpOauth();
    if (begin.state !== "open") throw new Error("expected an open Personal OAuth flow");

    let statusSettled = false;
    const status = service.getPersonalMcpOauthFlowStatus({ flowId: begin.flowId }).finally(() => {
      statusSettled = true;
    });
    await vi.waitFor(() => expect(isConnectTabOpen).toHaveBeenCalledOnce());

    await expect(service.clearPersonalMcpOauth()).resolves.toBeUndefined();
    expect(clearPersonalMcpOauth).toHaveBeenCalledOnce();
    expect(statusSettled).toBe(false);

    inspection.resolve(false);
    await expect(status).resolves.toEqual({ state: "closed" });
  });

  it("allows a new Personal OAuth begin after clear without waiting for a stuck status", async () => {
    const inspection = deferred<boolean>();
    let supervisorBeginCount = 0;
    const beginPersonalMcpOauth = vi.fn<
      NonNullable<PipedreamMainServiceOptions["beginPersonalMcpOauth"]>
    >(async () => {
      supervisorBeginCount += 1;
      return {
        status: "redirect" as const,
        flowId: `supervisor-reconnect-${supervisorBeginCount}`,
        authorizationUrl: `https://pipedream.com/oauth/authorize?flow=reconnect-${supervisorBeginCount}`,
      };
    });
    const service = new PipedreamMainService({
      createConnectLink: async () => ({
        connectLinkUrl: "https://pipedream.com/connect?app=slack",
        expiresAt: "2026-08-27T12:10:00.000Z",
      }),
      beginPersonalMcpOauth,
      waitPersonalMcpOauth: () => new Promise(() => undefined),
      cancelPersonalMcpOauth: async () => undefined,
      clearPersonalMcpOauth: async () => undefined,
      openConnectUrl: async (_url, ownership) => {
        const tabId = `personal-reconnect-${supervisorBeginCount}`;
        ownership.onTabOpened(tabId);
        return { tabId };
      },
      closeConnectTab: async () => undefined,
      isConnectTabOpen: async () => inspection.promise,
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap: async () => ({}) as never,
    });
    const first = await service.beginPersonalMcpOauth();
    if (first.state !== "open") throw new Error("expected first OAuth flow to open");
    const status = service.getPersonalMcpOauthFlowStatus({ flowId: first.flowId });
    await Promise.resolve();

    await service.clearPersonalMcpOauth();
    const reconnect = service.beginPersonalMcpOauth();
    await Promise.resolve();
    await Promise.resolve();
    const reconnectStartedBeforeInspectionSettled = beginPersonalMcpOauth.mock.calls.length === 2;

    inspection.resolve(false);
    void status.catch(() => undefined);
    void reconnect.catch(() => undefined);
    expect(reconnectStartedBeforeInspectionSettled).toBe(true);
  });

  it("lets a Personal OAuth reconnect complete while the revoked flow is still opening its tab", async () => {
    const firstOpen = deferred<{ tabId: string }>();
    let supervisorBeginCount = 0;
    const beginPersonalMcpOauth = vi.fn<
      NonNullable<PipedreamMainServiceOptions["beginPersonalMcpOauth"]>
    >(async () => {
      supervisorBeginCount += 1;
      return {
        status: "redirect" as const,
        flowId: `supervisor-opening-reconnect-${supervisorBeginCount}`,
        authorizationUrl: `https://pipedream.com/oauth/authorize?flow=opening-reconnect-${supervisorBeginCount}`,
      };
    });
    const cancelPersonalMcpOauth = vi.fn<(flowId: string) => Promise<void>>(async () => undefined);
    const clearPersonalMcpOauth = vi.fn<() => Promise<void>>(async () => undefined);
    const openTabs = new Set<string>();
    const openConnectUrl = vi.fn<PipedreamMainServiceOptions["openConnectUrl"]>(
      async (_url, ownership) => {
        if (openConnectUrl.mock.calls.length === 1) return firstOpen.promise;
        const tabId = "personal-opening-reconnect-current";
        ownership.onTabOpened(tabId);
        openTabs.add(tabId);
        return { tabId };
      },
    );
    const closeConnectTab = vi.fn<(tabId: string) => Promise<void>>(async (tabId) => {
      openTabs.delete(tabId);
    });
    const service = new PipedreamMainService({
      createConnectLink: async () => ({
        connectLinkUrl: "https://pipedream.com/connect?app=slack",
        expiresAt: "2026-08-27T12:10:00.000Z",
      }),
      beginPersonalMcpOauth,
      waitPersonalMcpOauth: () => new Promise(() => undefined),
      cancelPersonalMcpOauth,
      clearPersonalMcpOauth,
      openConnectUrl,
      closeConnectTab,
      isConnectTabOpen: async (tabId) => openTabs.has(tabId),
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap: async () => ({}) as never,
    });

    let firstSettled = false;
    const first = service.beginPersonalMcpOauth();
    void first
      .finally(() => {
        firstSettled = true;
      })
      .catch(() => undefined);
    await vi.waitFor(() => expect(openConnectUrl).toHaveBeenCalledOnce());

    await expect(service.clearPersonalMcpOauth()).resolves.toBeUndefined();
    const reconnect = service.beginPersonalMcpOauth();
    await vi.waitFor(() => expect(beginPersonalMcpOauth).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(openConnectUrl).toHaveBeenCalledTimes(2));
    await expect(reconnect).resolves.toMatchObject({ state: "open" });
    expect(firstSettled).toBe(false);
    expect(openTabs).toEqual(new Set(["personal-opening-reconnect-current"]));
    expect(cancelPersonalMcpOauth).toHaveBeenCalledExactlyOnceWith(
      "supervisor-opening-reconnect-1",
    );
    expect(clearPersonalMcpOauth).toHaveBeenCalledOnce();

    openTabs.add("personal-opening-reconnect-stale");
    firstOpen.resolve({ tabId: "personal-opening-reconnect-stale" });
    await expect(first).rejects.toThrow(/superseded/i);
    await vi.waitFor(() =>
      expect(closeConnectTab).toHaveBeenCalledWith("personal-opening-reconnect-stale"),
    );
    expect(openTabs).toEqual(new Set(["personal-opening-reconnect-current"]));
    await service.dispose();
  });

  it("allows a new Personal OAuth begin after cancel without waiting for a stuck status", async () => {
    const inspection = deferred<boolean>();
    let supervisorBeginCount = 0;
    const beginPersonalMcpOauth = vi.fn<
      NonNullable<PipedreamMainServiceOptions["beginPersonalMcpOauth"]>
    >(async () => {
      supervisorBeginCount += 1;
      return {
        status: "redirect" as const,
        flowId: `supervisor-cancel-reconnect-${supervisorBeginCount}`,
        authorizationUrl: `https://pipedream.com/oauth/authorize?flow=cancel-reconnect-${supervisorBeginCount}`,
      };
    });
    const cancelPersonalMcpOauth = vi.fn<(flowId: string) => Promise<void>>(async () => undefined);
    const openTabs = new Set<string>();
    const isConnectTabOpen = vi.fn<(tabId: string) => Promise<boolean>>(
      async () => inspection.promise,
    );
    const service = new PipedreamMainService({
      createConnectLink: async () => ({
        connectLinkUrl: "https://pipedream.com/connect?app=slack",
        expiresAt: "2026-08-27T12:10:00.000Z",
      }),
      beginPersonalMcpOauth,
      waitPersonalMcpOauth: () => new Promise(() => undefined),
      cancelPersonalMcpOauth,
      clearPersonalMcpOauth: async () => undefined,
      openConnectUrl: async (_url, ownership) => {
        const tabId = `personal-cancel-reconnect-${supervisorBeginCount}`;
        ownership.onTabOpened(tabId);
        openTabs.add(tabId);
        return { tabId };
      },
      closeConnectTab: async (tabId) => {
        openTabs.delete(tabId);
      },
      isConnectTabOpen,
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap: async () => ({}) as never,
    });
    const first = await service.beginPersonalMcpOauth();
    if (first.state !== "open") throw new Error("expected first OAuth flow to open");
    let statusSettled = false;
    const status = service.getPersonalMcpOauthFlowStatus({ flowId: first.flowId }).finally(() => {
      statusSettled = true;
    });
    await vi.waitFor(() => expect(isConnectTabOpen).toHaveBeenCalledOnce());

    await expect(service.cancelPersonalMcpOauth({ flowId: first.flowId })).resolves.toBeUndefined();
    expect(cancelPersonalMcpOauth).toHaveBeenCalledExactlyOnceWith("supervisor-cancel-reconnect-1");
    expect(statusSettled).toBe(false);
    const reconnect = service.beginPersonalMcpOauth();
    await Promise.resolve();
    await Promise.resolve();
    const reconnectStartedBeforeInspectionSettled = beginPersonalMcpOauth.mock.calls.length === 2;

    inspection.resolve(false);
    await expect(status).resolves.toEqual({ state: "closed" });
    await expect(reconnect).resolves.toMatchObject({ state: "open" });
    expect(reconnectStartedBeforeInspectionSettled).toBe(true);
    await service.dispose();
  });

  it("reports a strict Personal OAuth clear failure without waiting for tab cleanup", async () => {
    const openTabs = new Set(["personal-clear-failure"]);
    const service = new PipedreamMainService({
      createConnectLink: async () => ({
        connectLinkUrl: "https://pipedream.com/connect?app=slack",
        expiresAt: "2026-08-27T12:10:00.000Z",
      }),
      beginPersonalMcpOauth: async () => ({
        status: "redirect",
        flowId: "supervisor-clear-failure",
        authorizationUrl: "https://pipedream.com/oauth/authorize?flow=clear-failure",
      }),
      waitPersonalMcpOauth: () => new Promise(() => undefined),
      cancelPersonalMcpOauth: async () => undefined,
      clearPersonalMcpOauth: async () => {
        throw new Error("strict credential-store clear failed");
      },
      openConnectUrl: async (_url, ownership) => {
        ownership.onTabOpened("personal-clear-failure");
        return { tabId: "personal-clear-failure" };
      },
      closeConnectTab: async () => {
        throw new Error("exact sensitive tab is still open");
      },
      isConnectTabOpen: async (tabId) => openTabs.has(tabId),
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap: async () => ({}) as never,
    });
    await service.beginPersonalMcpOauth();

    await expect(service.clearPersonalMcpOauth()).rejects.toThrow(
      "strict credential-store clear failed",
    );
    expect(openTabs).toEqual(new Set(["personal-clear-failure"]));
  });

  it.each(["cancel", "dispose"] as const)(
    "lets Personal OAuth %s return while exact-tab cleanup retries in quarantine",
    async (operation) => {
      const retryClose = deferred<void>();
      const openTabs = new Set([`personal-${operation}-pending`]);
      const closeConnectTab = vi
        .fn<(tabId: string) => Promise<void>>()
        .mockRejectedValueOnce(new Error("exact sensitive tab is still open"))
        .mockImplementationOnce(async (tabId) => {
          await retryClose.promise;
          openTabs.delete(tabId);
        });
      const service = new PipedreamMainService({
        createConnectLink: async () => ({
          connectLinkUrl: "https://pipedream.com/connect?app=slack",
          expiresAt: "2026-08-27T12:10:00.000Z",
        }),
        beginPersonalMcpOauth: async () => ({
          status: "redirect",
          flowId: `supervisor-${operation}-pending`,
          authorizationUrl: `https://pipedream.com/oauth/authorize?flow=${operation}-pending`,
        }),
        waitPersonalMcpOauth: () => new Promise(() => undefined),
        cancelPersonalMcpOauth: async () => undefined,
        clearPersonalMcpOauth: async () => undefined,
        openConnectUrl: async (_url, ownership) => {
          const tabId = `personal-${operation}-pending`;
          ownership.onTabOpened(tabId);
          return { tabId };
        },
        closeConnectTab,
        isConnectTabOpen: async (tabId) => openTabs.has(tabId),
        persistEnvFilePath: () => undefined,
        clearEnvFilePath: () => undefined,
        fallbackBootstrap: () => ({ state: "absent" }),
        configureBootstrap: async () => ({}) as never,
      });
      const begin = await service.beginPersonalMcpOauth();
      if (begin.state !== "open") throw new Error("expected an open Personal OAuth flow");

      const lifecycle =
        operation === "cancel"
          ? service.cancelPersonalMcpOauth({ flowId: begin.flowId })
          : service.dispose();
      await vi.waitFor(() => expect(closeConnectTab).toHaveBeenCalledOnce());
      await expect(lifecycle).resolves.toBeUndefined();
      expect(openTabs).toEqual(new Set([`personal-${operation}-pending`]));

      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() => expect(closeConnectTab).toHaveBeenCalledTimes(2));
      retryClose.resolve();
      await vi.waitFor(() => expect(openTabs).toEqual(new Set()));
    },
  );

  it("accepts failed close as terminal only after the exact sensitive tab is confirmed gone", async () => {
    const openTabs = new Set(["personal-confirmed-gone"]);
    const clearPersonalMcpOauth = vi.fn<() => Promise<void>>(async () => undefined);
    const closeConnectTab = vi.fn<(tabId: string) => Promise<void>>(async (tabId) => {
      openTabs.delete(tabId);
      throw new Error("partition cleanup was quarantined after tab destruction");
    });
    const service = new PipedreamMainService({
      createConnectLink: async () => ({
        connectLinkUrl: "https://pipedream.com/connect?app=slack",
        expiresAt: "2026-08-27T12:10:00.000Z",
      }),
      beginPersonalMcpOauth: async () => ({
        status: "redirect",
        flowId: "supervisor-confirmed-gone",
        authorizationUrl: "https://pipedream.com/oauth/authorize?flow=confirmed-gone",
      }),
      waitPersonalMcpOauth: () => new Promise(() => undefined),
      cancelPersonalMcpOauth: async () => undefined,
      clearPersonalMcpOauth,
      openConnectUrl: async (_url, ownership) => {
        ownership.onTabOpened("personal-confirmed-gone");
        return { tabId: "personal-confirmed-gone" };
      },
      closeConnectTab,
      isConnectTabOpen: async (tabId) => openTabs.has(tabId),
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap: async () => ({}) as never,
    });
    await service.beginPersonalMcpOauth();

    await expect(service.clearPersonalMcpOauth()).resolves.toBeUndefined();
    expect(closeConnectTab).toHaveBeenCalledOnce();
    expect(clearPersonalMcpOauth).toHaveBeenCalledOnce();
  });

  it.each(["clear", "dispose"] as const)(
    "lets %s supersede a pending Personal OAuth begin without opening a tab",
    async (operation) => {
      const beginGate = deferred<{
        status: "redirect";
        flowId: string;
        authorizationUrl: string;
      }>();
      const clearPersonalMcpOauth = vi.fn<() => Promise<void>>(async () => undefined);
      const cancelPersonalMcpOauth = vi.fn<(flowId: string) => Promise<void>>(
        async () => undefined,
      );
      const beginPersonalMcpOauth = vi.fn<
        NonNullable<PipedreamMainServiceOptions["beginPersonalMcpOauth"]>
      >(async () => beginGate.promise);
      const openTabs = new Set<string>();
      const service = new PipedreamMainService({
        createConnectLink: async () => ({
          connectLinkUrl: "https://pipedream.com/connect?app=slack",
          expiresAt: "2026-08-27T12:10:00.000Z",
        }),
        beginPersonalMcpOauth,
        waitPersonalMcpOauth: () => new Promise(() => undefined),
        cancelPersonalMcpOauth,
        clearPersonalMcpOauth,
        openConnectUrl: async (_url, ownership) => {
          if (!ownership.canOpenTab()) throw new Error("flow is no longer active");
          ownership.onTabOpened("personal-interleaved");
          openTabs.add("personal-interleaved");
          return { tabId: "personal-interleaved" };
        },
        closeConnectTab: async (tabId) => {
          openTabs.delete(tabId);
        },
        isConnectTabOpen: async (tabId) => openTabs.has(tabId),
        persistEnvFilePath: () => undefined,
        clearEnvFilePath: () => undefined,
        fallbackBootstrap: () => ({ state: "absent" }),
        configureBootstrap: async () => ({}) as never,
      });

      const begin = service.beginPersonalMcpOauth();
      await vi.waitFor(() => expect(beginPersonalMcpOauth).toHaveBeenCalledOnce());
      const lifecycle = operation === "clear" ? service.clearPersonalMcpOauth() : service.dispose();
      await lifecycle;

      beginGate.resolve({
        status: "redirect",
        flowId: `supervisor-${operation}`,
        authorizationUrl: `https://pipedream.com/oauth/authorize?flow=${operation}`,
      });
      await expect(begin).rejects.toThrow(/superseded/i);

      expect(openTabs).toEqual(new Set());
      expect(cancelPersonalMcpOauth).toHaveBeenCalledWith(`supervisor-${operation}`);
      expect(clearPersonalMcpOauth).toHaveBeenCalledTimes(operation === "clear" ? 1 : 0);
    },
  );

  it("opens the one-use link in a retained sensitive tab and returns only an opaque flow id", async () => {
    const privateLink =
      "https://pipedream.com/_static/connect.html?token=connect-token-private&connectLink=true&app=slack";
    const openConnectUrl = vi.fn<(url: string) => Promise<{ tabId: string }>>(async () => ({
      tabId: "sensitive-tab-private",
    }));
    const service = makeConnectLifecycleService({
      createConnectLink: vi.fn<
        (appSlug: string) => Promise<{ connectLinkUrl: string; expiresAt: string }>
      >(async () => ({
        connectLinkUrl: privateLink,
        expiresAt: "2026-08-27T12:10:00.000Z",
      })),
      openConnectUrl,
      closeConnectTab: async () => undefined,
      isConnectTabOpen: async () => true,
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap: async () => ({}) as never,
    });

    const result = await service.beginConnect({ appSlug: "slack" });

    expect(openConnectUrl).toHaveBeenCalledExactlyOnceWith(
      privateLink,
      expect.objectContaining({
        sessionPartition: expect.any(String),
        canOpenTab: expect.any(Function),
        onTabOpened: expect.any(Function),
        onTabClosed: expect.any(Function),
      }),
    );
    expect(result).toMatchObject({
      opened: true,
      expiresAt: "2026-08-27T12:10:00.000Z",
      flowId: expect.any(String),
    });
    expect(Object.keys(result).sort()).toEqual(["expiresAt", "flowId", "opened"]);
    expect(JSON.stringify(result)).not.toMatch(
      /connect-token-private|connectLinkUrl|token=|sensitive-tab-private|tabId/i,
    );
  });

  it("assigns each Connect flow a unique opaque non-persistent session partition", async () => {
    const ownerships: PipedreamConnectTabOwnership[] = [];
    let openedTabSerial = 0;
    const service = makeConnectLifecycleService({
      createConnectLink: async (appSlug) => ({
        connectLinkUrl: `https://pipedream.com/connect?app=${appSlug}&token=super-secret-token`,
        expiresAt: "2026-08-27T12:10:00.000Z",
      }),
      openConnectUrl: async (_url, ownership: PipedreamConnectTabOwnership) => {
        ownerships.push(ownership);
        const tabId = `sensitive-tab-${++openedTabSerial}`;
        ownership.onTabOpened(tabId);
        return { tabId };
      },
      closeConnectTab: async () => undefined,
      isConnectTabOpen: async () => true,
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap: async () => ({}) as never,
    });

    const first = await service.beginConnect({ appSlug: "gmail" });
    await service.cancelConnect({ flowId: first.flowId });
    const second = await service.beginConnect({ appSlug: "slack" });

    const partitions = ownerships.map(({ sessionPartition }) => sessionPartition);
    expect(partitions).toHaveLength(2);
    expect(new Set(partitions).size).toBe(2);
    for (const partition of partitions) {
      expect(partition).toMatch(/^[a-z0-9-]{1,64}$/);
      expect(partition).not.toMatch(/^persist:/i);
      expect(partition).not.toContain("gmail");
      expect(partition).not.toContain("slack");
      expect(partition).not.toContain("super-secret-token");
      expect(partition).not.toContain(first.flowId);
      expect(partition).not.toContain(second.flowId);
    }

    await service.cancelConnect({ flowId: second.flowId });
  });

  it("keeps one session partition for the root tab and every popup descendant", async () => {
    const observedPartitions: string[] = [];
    const service = makeConnectLifecycleService({
      createConnectLink: async () => ({
        connectLinkUrl: "https://pipedream.com/connect?app=gmail&token=private",
        expiresAt: "2026-08-27T12:10:00.000Z",
      }),
      openConnectUrl: async (_url, ownership: PipedreamConnectTabOwnership) => {
        observedPartitions.push(ownership.sessionPartition);
        ownership.onTabOpened("sensitive-root");
        observedPartitions.push(ownership.sessionPartition);
        ownership.onTabOpened("sensitive-popup");
        observedPartitions.push(ownership.sessionPartition);
        ownership.onTabOpened("sensitive-grandchild");
        observedPartitions.push(ownership.sessionPartition);
        return { tabId: "sensitive-root" };
      },
      closeConnectTab: async () => undefined,
      isConnectTabOpen: async () => true,
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap: async () => ({}) as never,
    });

    const flow = await service.beginConnect({ appSlug: "gmail" });

    expect(observedPartitions).toHaveLength(4);
    expect(observedPartitions[0]).toMatch(/^[a-z0-9-]{1,64}$/);
    expect(new Set(observedPartitions).size).toBe(1);
    await service.cancelConnect({ flowId: flow.flowId });
  });

  it("reports retained tab state without exposing the OAuth URL or private tab id", async () => {
    let tabOpen = true;
    const service = makeConnectLifecycleService({
      createConnectLink: async () => ({
        connectLinkUrl:
          "https://pipedream.com/_static/connect.html?token=connect-token-private&connectLink=true&app=gmail",
        expiresAt: "2026-08-27T12:10:00.000Z",
      }),
      openConnectUrl: async () => ({ tabId: "sensitive-tab-private" }),
      closeConnectTab: async () => {
        tabOpen = false;
      },
      isConnectTabOpen: async (tabId) => tabId === "sensitive-tab-private" && tabOpen,
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap: async () => ({}) as never,
    });

    const { flowId } = await service.beginConnect({ appSlug: "gmail" });
    const openStatus = await service.getConnectFlowStatus({ flowId });
    expect(openStatus).toEqual({ state: "open" });

    tabOpen = false;
    const closedStatus = await service.getConnectFlowStatus({ flowId });
    expect(closedStatus).toEqual({ state: "closed" });
    expect(JSON.stringify({ openStatus, closedStatus })).not.toMatch(
      /connect-token-private|sensitive-tab-private|tabId|https?:/i,
    );
  });

  it("uses unguessable exact loopback capabilities and reports success without exposing them", async () => {
    let redirects:
      | { readonly successRedirectUrl: string; readonly errorRedirectUrl: string }
      | undefined;
    const closeConnectTab = vi.fn<(tabId: string) => Promise<void>>(async () => undefined);
    const service = makeConnectLifecycleService({
      createConnectLink: async (_appSlug, receivedRedirects) => {
        redirects = receivedRedirects;
        return {
          connectLinkUrl: "https://pipedream.com/connect?app=gmail&token=private",
          expiresAt: "2026-08-27T12:10:00.000Z",
        };
      },
      openConnectUrl: async () => ({ tabId: "sensitive-success" }),
      closeConnectTab,
      isConnectTabOpen: async () => true,
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap: async () => ({}) as never,
    });

    const { flowId } = await service.beginConnect({ appSlug: "gmail" });
    expect(redirects).toBeDefined();
    const successUrl = new URL(redirects!.successRedirectUrl);
    const errorUrl = new URL(redirects!.errorRedirectUrl);
    expect(successUrl.hostname).toBe("127.0.0.1");
    expect(successUrl.protocol).toBe("http:");
    expect(successUrl.port).not.toBe("");
    expect(successUrl.pathname).toMatch(/^\/success\/[a-f0-9]{64}$/);
    expect(errorUrl.pathname).toMatch(/^\/error\/[a-f0-9]{64}$/);
    expect(errorUrl.origin).toBe(successUrl.origin);

    await expect(requestLoopback(successUrl.toString(), "POST")).resolves.toMatchObject({
      statusCode: 405,
    });
    await expect(
      requestLoopback(`${successUrl.origin}/success/${"0".repeat(64)}`),
    ).resolves.toMatchObject({ statusCode: 404 });
    await expect(service.getConnectFlowStatus({ flowId })).resolves.toEqual({ state: "open" });

    const response = await requestLoopback(
      `${successUrl.toString()}?account_id=apn_UntrustedQuery&ignored=private`,
    );
    expect(response).toMatchObject({
      body: "You may return to Y Space.",
      statusCode: 200,
    });
    expect(response.headers["cache-control"]).toBe("no-store");
    const status = await service.getConnectFlowStatus({ flowId });
    expect(status).toEqual({ state: "succeeded" });
    expect(Object.keys(status)).toEqual(["state"]);
    expect(closeConnectTab).toHaveBeenCalledExactlyOnceWith("sensitive-success");
    expect(JSON.stringify(await service.getConnectFlowStatus({ flowId }))).not.toMatch(
      /127\.0\.0\.1|\/success\/|private|tabId|account/i,
    );
    await service.finishConnect({ flowId });
  });

  it.each([
    ["a forged Host", "attacker.invalid", 404],
    ["a missing Host", "", 400],
  ])("rejects %s without consuming the loopback capability", async (_label, host, statusCode) => {
    let successRedirectUrl = "";
    const service = makeConnectLifecycleService({
      createConnectLink: async (_appSlug, redirects) => {
        successRedirectUrl = redirects.successRedirectUrl;
        return {
          connectLinkUrl: "https://pipedream.com/connect?app=gmail&token=private",
          expiresAt: "2026-08-27T12:10:00.000Z",
        };
      },
      openConnectUrl: async () => ({ tabId: "sensitive-host-check" }),
      closeConnectTab: async () => undefined,
      isConnectTabOpen: async () => true,
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap: async () => ({}) as never,
    });
    const { flowId } = await service.beginConnect({ appSlug: "gmail" });

    await expect(requestLoopback(successRedirectUrl, "GET", { host })).resolves.toMatchObject({
      statusCode,
    });
    await expect(service.getConnectFlowStatus({ flowId })).resolves.toEqual({ state: "open" });
    await service.cancelConnect({ flowId });
  });

  it("settles a Connect error redirect promptly as a generic failed state", async () => {
    let errorRedirectUrl = "";
    const service = makeConnectLifecycleService({
      createConnectLink: async (_appSlug, redirects) => {
        errorRedirectUrl = redirects.errorRedirectUrl;
        return {
          connectLinkUrl: "https://pipedream.com/connect?app=gmail&token=private",
          expiresAt: "2026-08-27T12:10:00.000Z",
        };
      },
      openConnectUrl: async () => ({ tabId: "sensitive-failure" }),
      closeConnectTab: async () => undefined,
      isConnectTabOpen: async () => true,
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap: async () => ({}) as never,
    });
    const { flowId } = await service.beginConnect({ appSlug: "gmail" });

    await expect(requestLoopback(errorRedirectUrl)).resolves.toMatchObject({ statusCode: 200 });

    await expect(service.getConnectFlowStatus({ flowId })).resolves.toEqual({ state: "failed" });
    await service.finishConnect({ flowId });
  });

  it("preserves the first redirect result delivered while Connect Link creation is settling", async () => {
    let ownershipWasOpen = false;
    const closeConnectTab = vi.fn<(tabId: string) => Promise<void>>(async () => undefined);
    const service = makeConnectLifecycleService({
      createConnectLink: async (_appSlug, redirects) => {
        await expect(requestLoopback(redirects.successRedirectUrl)).resolves.toMatchObject({
          statusCode: 200,
        });
        return {
          connectLinkUrl: "https://pipedream.com/connect?app=gmail&token=private",
          expiresAt: "2026-08-27T12:10:00.000Z",
        };
      },
      openConnectUrl: async (_url, ownership) => {
        ownershipWasOpen = ownership.canOpenTab();
        if (!ownershipWasOpen) throw new Error("flow settled before tab ownership began");
        return { tabId: "sensitive-early-result" };
      },
      closeConnectTab,
      isConnectTabOpen: async () => true,
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap: async () => ({}) as never,
    });

    const { flowId } = await service.beginConnect({ appSlug: "gmail" });

    expect(ownershipWasOpen).toBe(true);
    await expect(service.getConnectFlowStatus({ flowId })).resolves.toEqual({
      state: "succeeded",
    });
    expect(closeConnectTab).toHaveBeenCalledExactlyOnceWith("sensitive-early-result");
    await service.finishConnect({ flowId });
  });

  it("returns the safe flow result when a successful callback closes the tab during open attachment", async () => {
    let successRedirectUrl = "";
    const closeConnectTab = vi.fn<(tabId: string) => Promise<void>>(async () => undefined);
    const service = makeConnectLifecycleService({
      createConnectLink: async (_appSlug, redirects) => {
        successRedirectUrl = redirects.successRedirectUrl;
        return {
          connectLinkUrl: "https://pipedream.com/connect?app=gmail&token=private",
          expiresAt: "2026-08-27T12:10:00.000Z",
        };
      },
      openConnectUrl: async (_url, ownership) => {
        ownership.onTabOpened("sensitive-terminal-during-attach");
        await expect(requestLoopback(successRedirectUrl)).resolves.toMatchObject({
          statusCode: 200,
        });
        throw new Error("Browser tab was destroyed while attachment was pending");
      },
      closeConnectTab,
      isConnectTabOpen: async () => true,
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap: async () => ({}) as never,
    });

    const result = await service.beginConnect({ appSlug: "gmail" });

    expect(result).toEqual({
      opened: true,
      expiresAt: "2026-08-27T12:10:00.000Z",
      flowId: expect.any(String),
    });
    expect(Object.keys(result).sort()).toEqual(["expiresAt", "flowId", "opened"]);
    await expect(service.getConnectFlowStatus({ flowId: result.flowId })).resolves.toEqual({
      state: "succeeded",
    });
    expect(closeConnectTab).toHaveBeenCalledExactlyOnceWith("sensitive-terminal-during-attach");
    await service.finishConnect({ flowId: result.flowId });
  });

  it("retries terminal tab cleanup independently after expiry close fails", async () => {
    const closeConnectTab = vi
      .fn<(tabId: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("transient close failure"))
      .mockResolvedValue(undefined);
    const service = makeConnectLifecycleService({
      createConnectLink: async () => ({
        connectLinkUrl: "https://pipedream.com/connect?app=gmail&token=private",
        expiresAt: "2026-08-27T12:00:05.000Z",
      }),
      openConnectUrl: async () => ({ tabId: "sensitive-retry" }),
      closeConnectTab,
      isConnectTabOpen: async () => true,
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap: async () => ({}) as never,
    });
    const { flowId } = await service.beginConnect({ appSlug: "gmail" });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(closeConnectTab).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(250);

    expect(closeConnectTab).toHaveBeenCalledTimes(2);
    await expect(service.getConnectFlowStatus({ flowId })).resolves.toEqual({ state: "expired" });
  });

  it("reports expiry when a status poll reaches the deadline before the timer callback", async () => {
    const closeConnectTab = vi.fn<(tabId: string) => Promise<void>>(async () => undefined);
    const service = makeConnectLifecycleService({
      createConnectLink: async () => ({
        connectLinkUrl: "https://pipedream.com/connect?app=gmail&token=private",
        expiresAt: "2026-08-27T12:00:05.000Z",
      }),
      openConnectUrl: async () => ({ tabId: "sensitive-direct-deadline" }),
      closeConnectTab,
      isConnectTabOpen: async () => true,
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap: async () => ({}) as never,
    });
    const { flowId } = await service.beginConnect({ appSlug: "gmail" });

    // Move wall time without executing the scheduled expiry callback. The
    // status read itself must preserve timeout semantics when it wins the race.
    vi.setSystemTime("2026-08-27T12:00:05.000Z");

    await expect(service.getConnectFlowStatus({ flowId })).resolves.toEqual({ state: "expired" });
    expect(closeConnectTab).toHaveBeenCalledWith("sensitive-direct-deadline");
  });

  it.each(["finishConnect", "cancelConnect"] as const)(
    "%s closes exactly the retained sensitive tab and leaves the flow closed",
    async (operation) => {
      let tabOpen = true;
      const closeConnectTab = vi.fn<(tabId: string) => Promise<void>>(async () => {
        tabOpen = false;
      });
      const service = makeConnectLifecycleService({
        createConnectLink: async () => ({
          connectLinkUrl:
            "https://pipedream.com/_static/connect.html?token=connect-token-private&connectLink=true&app=gmail",
          expiresAt: "2026-08-27T12:10:00.000Z",
        }),
        openConnectUrl: async () => ({ tabId: "sensitive-tab-private" }),
        closeConnectTab,
        isConnectTabOpen: async () => tabOpen,
        persistEnvFilePath: () => undefined,
        clearEnvFilePath: () => undefined,
        fallbackBootstrap: () => ({ state: "absent" }),
        configureBootstrap: async () => ({}) as never,
      });
      const { flowId } = await service.beginConnect({ appSlug: "gmail" });

      await service[operation]({ flowId });

      expect(closeConnectTab).toHaveBeenCalledExactlyOnceWith("sensitive-tab-private");
      await expect(service.getConnectFlowStatus({ flowId })).resolves.toEqual({ state: "closed" });
    },
  );

  it.each(["finishConnect", "cancelConnect"] as const)(
    "%s closes every sensitive tab registered to the flow, including popup descendants",
    async (operation) => {
      const openTabIds = new Set<string>();
      let ownership: PipedreamConnectTabOwnership | undefined;
      const closeConnectTab = vi.fn<(tabId: string) => Promise<void>>(async (tabId) => {
        openTabIds.delete(tabId);
        ownership?.onTabClosed(tabId);
      });
      const service = makeConnectLifecycleService({
        createConnectLink: async () => ({
          connectLinkUrl:
            "https://pipedream.com/_static/connect.html?token=connect-token-private&connectLink=true&app=gmail",
          expiresAt: "2026-08-27T12:10:00.000Z",
        }),
        openConnectUrl: async (_url, tabOwnership: PipedreamConnectTabOwnership) => {
          ownership = tabOwnership;
          for (const tabId of ["sensitive-root", "sensitive-popup", "sensitive-grandchild"]) {
            openTabIds.add(tabId);
            tabOwnership.onTabOpened(tabId);
          }
          return { tabId: "sensitive-root" };
        },
        closeConnectTab,
        isConnectTabOpen: async (tabId) => openTabIds.has(tabId),
        persistEnvFilePath: () => undefined,
        clearEnvFilePath: () => undefined,
        fallbackBootstrap: () => ({ state: "absent" }),
        configureBootstrap: async () => ({}) as never,
      } as PipedreamConnectLifecycleOptions);
      const { flowId } = await service.beginConnect({ appSlug: "gmail" });

      openTabIds.delete("sensitive-root");
      ownership?.onTabClosed("sensitive-root");
      await expect(service.getConnectFlowStatus({ flowId })).resolves.toEqual({ state: "open" });

      await service[operation]({ flowId });

      expect(new Set(closeConnectTab.mock.calls.map(([tabId]) => tabId))).toEqual(
        new Set(["sensitive-popup", "sensitive-grandchild"]),
      );
      expect(ownership?.canOpenTab()).toBe(false);
      await expect(service.getConnectFlowStatus({ flowId })).resolves.toEqual({ state: "closed" });
    },
  );

  it("expires and closes the complete sensitive tab tree from a main-process timer without polling", async () => {
    const openTabIds = new Set<string>();
    let ownership: PipedreamConnectTabOwnership | undefined;
    const closeConnectTab = vi.fn<(tabId: string) => Promise<void>>(async (tabId) => {
      openTabIds.delete(tabId);
      ownership?.onTabClosed(tabId);
    });
    const service = makeConnectLifecycleService({
      createConnectLink: async () => ({
        connectLinkUrl:
          "https://pipedream.com/_static/connect.html?token=connect-token-private&connectLink=true&app=gmail",
        expiresAt: "2026-08-27T12:00:05.000Z",
      }),
      openConnectUrl: async (_url, tabOwnership: PipedreamConnectTabOwnership) => {
        ownership = tabOwnership;
        for (const tabId of ["sensitive-root", "sensitive-popup"]) {
          openTabIds.add(tabId);
          tabOwnership.onTabOpened(tabId);
        }
        return { tabId: "sensitive-root" };
      },
      closeConnectTab,
      isConnectTabOpen: async (tabId) => openTabIds.has(tabId),
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap: async () => ({}) as never,
    } as PipedreamConnectLifecycleOptions);
    const { flowId } = await service.beginConnect({ appSlug: "gmail" });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(closeConnectTab).not.toHaveBeenCalled();
    expect(ownership?.canOpenTab()).toBe(true);

    await vi.advanceTimersByTimeAsync(1);

    expect(new Set(closeConnectTab.mock.calls.map(([tabId]) => tabId))).toEqual(
      new Set(["sensitive-root", "sensitive-popup"]),
    );
    expect(ownership?.canOpenTab()).toBe(false);
    await expect(service.getConnectFlowStatus({ flowId })).resolves.toEqual({ state: "expired" });
  });

  it("caps a far-future upstream expiry at the five-minute main-owned flow lifetime", async () => {
    let ownership: PipedreamConnectTabOwnership | undefined;
    const closeConnectTab = vi.fn<(tabId: string) => Promise<void>>(async (tabId) => {
      ownership?.onTabClosed(tabId);
    });
    const service = makeConnectLifecycleService({
      createConnectLink: async () => ({
        connectLinkUrl:
          "https://pipedream.com/_static/connect.html?token=connect-token-private&connectLink=true&app=gmail",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
      openConnectUrl: async (_url, tabOwnership: PipedreamConnectTabOwnership) => {
        ownership = tabOwnership;
        tabOwnership.onTabOpened("sensitive-root");
        return { tabId: "sensitive-root" };
      },
      closeConnectTab,
      isConnectTabOpen: async () => true,
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap: async () => ({}) as never,
    });
    const result = await service.beginConnect({ appSlug: "gmail" });
    expect(result.expiresAt).toBe("2099-01-01T00:00:00.000Z");

    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(closeConnectTab).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(closeConnectTab).toHaveBeenCalledExactlyOnceWith("sensitive-root");
    expect(ownership?.canOpenTab()).toBe(false);
  });

  it("rejects an already-expired Connect link before a sensitive guest can open", async () => {
    const openConnectUrl = vi.fn<() => Promise<{ tabId: string }>>(async () => ({
      tabId: "sensitive-root",
    }));
    const service = makeConnectLifecycleService({
      createConnectLink: async () => ({
        connectLinkUrl:
          "https://pipedream.com/_static/connect.html?token=connect-token-private&connectLink=true&app=gmail",
        expiresAt: CONNECT_NOW,
      }),
      openConnectUrl,
      closeConnectTab: async () => undefined,
      isConnectTabOpen: async () => true,
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap: async () => ({}) as never,
    });

    await expect(service.beginConnect({ appSlug: "gmail" })).rejects.toThrow(/expired/i);
    expect(openConnectUrl).not.toHaveBeenCalled();
  });

  it("dispose invalidates the flow synchronously and closes every owned sensitive tab", async () => {
    const openTabIds = new Set<string>();
    let ownership: PipedreamConnectTabOwnership | undefined;
    const closeConnectTab = vi.fn<(tabId: string) => Promise<void>>(async (tabId) => {
      openTabIds.delete(tabId);
      ownership?.onTabClosed(tabId);
    });
    const service = makeConnectLifecycleService({
      createConnectLink: async () => ({
        connectLinkUrl:
          "https://pipedream.com/_static/connect.html?token=connect-token-private&connectLink=true&app=gmail",
        expiresAt: "2026-08-27T12:10:00.000Z",
      }),
      openConnectUrl: async (_url, tabOwnership: PipedreamConnectTabOwnership) => {
        ownership = tabOwnership;
        for (const tabId of ["sensitive-root", "sensitive-popup"]) {
          openTabIds.add(tabId);
          tabOwnership.onTabOpened(tabId);
        }
        return { tabId: "sensitive-root" };
      },
      closeConnectTab,
      isConnectTabOpen: async (tabId) => openTabIds.has(tabId),
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap: async () => ({}) as never,
    } as PipedreamConnectLifecycleOptions);
    await service.beginConnect({ appSlug: "gmail" });

    const disposal = service.dispose();
    expect(ownership?.canOpenTab()).toBe(false);
    await disposal;

    expect(new Set(closeConnectTab.mock.calls.map(([tabId]) => tabId))).toEqual(
      new Set(["sensitive-root", "sensitive-popup"]),
    );
    await expect(service.beginConnect({ appSlug: "slack" })).rejects.toThrow(/disposed/i);
  });

  it("dispose does not wait for a superseded tab opener", async () => {
    const releaseOpen = deferred<void>();
    const openTabs = new Set<string>();
    const closeConnectTab = vi.fn<(tabId: string) => Promise<void>>(async (tabId) => {
      openTabs.delete(tabId);
    });
    const service = makeConnectLifecycleService({
      createConnectLink: async () => ({
        connectLinkUrl: "https://pipedream.com/connect?app=gmail&token=private",
        expiresAt: "2026-08-27T12:10:00.000Z",
      }),
      openConnectUrl: async (_url, ownership) => {
        ownership.onTabOpened("sensitive-dispose-stuck-open");
        openTabs.add("sensitive-dispose-stuck-open");
        await releaseOpen.promise;
        return { tabId: "sensitive-dispose-stuck-open" };
      },
      closeConnectTab,
      isConnectTabOpen: async (tabId) => openTabs.has(tabId),
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap: async () => ({}) as never,
    });
    const stale = service.beginConnect({ appSlug: "gmail" });
    const staleOutcome = stale.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(openTabs).toContain("sensitive-dispose-stuck-open"));

    let disposed = false;
    const disposal = service.dispose().then(() => {
      disposed = true;
    });
    try {
      await vi.waitFor(() => expect(disposed).toBe(true));
      expect(openTabs).toEqual(new Set());
      expect(closeConnectTab).toHaveBeenCalledExactlyOnceWith("sensitive-dispose-stuck-open");
    } finally {
      releaseOpen.resolve();
      await disposal;
      await staleOutcome;
    }
  });

  it("dispose destroys idle client sockets held against the ephemeral redirect receiver", async () => {
    let successRedirectUrl = "";
    const service = makeConnectLifecycleService({
      createConnectLink: async (_appSlug, redirects) => {
        successRedirectUrl = redirects.successRedirectUrl;
        return {
          connectLinkUrl: "https://pipedream.com/connect?app=gmail&token=private",
          expiresAt: "2026-08-27T12:10:00.000Z",
        };
      },
      openConnectUrl: async () => ({ tabId: "sensitive-idle-socket" }),
      closeConnectTab: async () => undefined,
      isConnectTabOpen: async () => true,
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap: async () => ({}) as never,
    });
    await service.beginConnect({ appSlug: "gmail" });
    const redirect = new URL(successRedirectUrl);
    const socket = connectSocket(Number(redirect.port), redirect.hostname);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const socketClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()));

    try {
      await service.dispose();
      await socketClosed;
      expect(socket.destroyed).toBe(true);
    } finally {
      socket.destroy();
    }
  });

  it("keeps a failed cleanup flow invalid and retries it before opening a replacement", async () => {
    const openTabIds = new Set<string>();
    const ownerships: PipedreamConnectTabOwnership[] = [];
    let openCount = 0;
    let failPopupClose = true;
    const closeConnectTab = vi.fn<(tabId: string) => Promise<void>>(async (tabId) => {
      if (tabId === "sensitive-popup" && failPopupClose) {
        failPopupClose = false;
        throw new Error("transient close failure");
      }
      openTabIds.delete(tabId);
      for (const ownership of ownerships) ownership.onTabClosed(tabId);
    });
    const openConnectUrl = vi.fn<
      (url: string, ownership: PipedreamConnectTabOwnership) => Promise<{ tabId: string }>
    >(async (_url: string, ownership: PipedreamConnectTabOwnership): Promise<{ tabId: string }> => {
      ownerships.push(ownership);
      openCount += 1;
      const tabIds =
        openCount === 1 ? ["sensitive-root", "sensitive-popup"] : ["sensitive-replacement"];
      for (const tabId of tabIds) {
        openTabIds.add(tabId);
        ownership.onTabOpened(tabId);
      }
      return { tabId: tabIds[0]! };
    });
    const service = makeConnectLifecycleService({
      createConnectLink: async () => ({
        connectLinkUrl:
          "https://pipedream.com/_static/connect.html?token=connect-token-private&connectLink=true&app=gmail",
        expiresAt: "2026-08-27T12:10:00.000Z",
      }),
      openConnectUrl,
      closeConnectTab,
      isConnectTabOpen: async (tabId) => openTabIds.has(tabId),
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap: async () => ({}) as never,
    });
    const first = await service.beginConnect({ appSlug: "gmail" });

    await expect(service.cancelConnect({ flowId: first.flowId })).rejects.toThrow(/close/i);
    expect(ownerships[0]?.canOpenTab()).toBe(false);
    expect(openConnectUrl).toHaveBeenCalledTimes(1);

    const replacement = await service.beginConnect({ appSlug: "gmail" });

    expect(
      closeConnectTab.mock.calls.filter(([tabId]) => tabId === "sensitive-popup"),
    ).toHaveLength(2);
    expect(openConnectUrl).toHaveBeenCalledTimes(2);
    expect(ownerships[1]?.canOpenTab()).toBe(true);
    await service.cancelConnect({ flowId: replacement.flowId });
  });

  it("closes the previous sensitive tab before opening a replacement and cannot close the replacement through the stale flow", async () => {
    let tabSerial = 0;
    const openConnectUrl = vi.fn<(url: string) => Promise<{ tabId: string }>>(async () => ({
      tabId: `sensitive-tab-${++tabSerial}`,
    }));
    const closeConnectTab = vi.fn<(tabId: string) => Promise<void>>(async () => undefined);
    const service = makeConnectLifecycleService({
      createConnectLink: async () => ({
        connectLinkUrl:
          "https://pipedream.com/_static/connect.html?token=connect-token-private&connectLink=true&app=gmail",
        expiresAt: "2026-08-27T12:10:00.000Z",
      }),
      openConnectUrl,
      closeConnectTab,
      isConnectTabOpen: async () => true,
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap: async () => ({}) as never,
    });

    const first = await service.beginConnect({ appSlug: "gmail" });
    const replacement = await service.beginConnect({ appSlug: "gmail" });

    expect(closeConnectTab).toHaveBeenCalledExactlyOnceWith("sensitive-tab-1");
    expect(closeConnectTab.mock.invocationCallOrder[0]).toBeLessThan(
      openConnectUrl.mock.invocationCallOrder[1]!,
    );
    await service.finishConnect({ flowId: first.flowId });
    expect(closeConnectTab).toHaveBeenCalledTimes(1);

    await service.cancelConnect({ flowId: replacement.flowId });
    expect(closeConnectTab).toHaveBeenNthCalledWith(2, "sensitive-tab-2");
  });

  it("expires the active flow while a replacement Connect Link request is stalled", async () => {
    let resolveReplacement:
      | ((result: { connectLinkUrl: string; expiresAt: string }) => void)
      | undefined;
    const replacementLink = new Promise<{ connectLinkUrl: string; expiresAt: string }>(
      (resolve) => {
        resolveReplacement = resolve;
      },
    );
    const createConnectLink = vi
      .fn<(appSlug: string) => Promise<{ connectLinkUrl: string; expiresAt: string }>>()
      .mockResolvedValueOnce({
        connectLinkUrl: "https://pipedream.com/connect?app=gmail&token=first-private",
        expiresAt: "2026-08-27T12:00:05.000Z",
      })
      .mockReturnValueOnce(replacementLink);
    const closeConnectTab = vi.fn<(tabId: string) => Promise<void>>(async () => undefined);
    const service = makeConnectLifecycleService({
      createConnectLink,
      openConnectUrl: async (_url, ownership) => {
        const tabId = `sensitive-${createConnectLink.mock.calls.length}`;
        ownership.onTabOpened(tabId);
        return { tabId };
      },
      closeConnectTab,
      isConnectTabOpen: async () => true,
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap: async () => ({}) as never,
    });
    await service.beginConnect({ appSlug: "gmail" });

    const replacement = service.beginConnect({ appSlug: "slack" });
    await vi.waitFor(() => expect(createConnectLink).toHaveBeenCalledTimes(2));

    await vi.advanceTimersByTimeAsync(5_000);
    expect(closeConnectTab).toHaveBeenCalledExactlyOnceWith("sensitive-1");

    resolveReplacement?.({
      connectLinkUrl: "https://pipedream.com/connect?app=slack&token=replacement-private",
      expiresAt: "2026-08-27T12:10:00.000Z",
    });
    const replacementFlow = await replacement;
    await service.cancelConnect({ flowId: replacementFlow.flowId });
  });

  it("does not let an out-of-order stale Connect Link replace the newest request", async () => {
    let resolveStale: ((result: { connectLinkUrl: string; expiresAt: string }) => void) | undefined;
    const staleLink = new Promise<{ connectLinkUrl: string; expiresAt: string }>((resolve) => {
      resolveStale = resolve;
    });
    const createConnectLink = vi.fn<
      (appSlug: string) => Promise<{ connectLinkUrl: string; expiresAt: string }>
    >(async (appSlug: string): Promise<{ connectLinkUrl: string; expiresAt: string }> => {
      if (appSlug === "gmail") return staleLink;
      return {
        connectLinkUrl: "https://pipedream.com/connect?app=slack&token=newest-private",
        expiresAt: "2026-08-27T12:10:00.000Z",
      };
    });
    const openConnectUrl = vi.fn<
      (url: string, ownership: PipedreamConnectTabOwnership) => Promise<{ tabId: string }>
    >(async (url) => ({
      tabId: url.includes("app=slack") ? "sensitive-newest" : "sensitive-stale",
    }));
    const service = makeConnectLifecycleService({
      createConnectLink,
      openConnectUrl,
      closeConnectTab: async () => undefined,
      isConnectTabOpen: async () => true,
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap: async () => ({}) as never,
    });

    const stale = service.beginConnect({ appSlug: "gmail" });
    const staleOutcome = stale.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(createConnectLink).toHaveBeenCalledTimes(1));
    const newest = service.beginConnect({ appSlug: "slack" });
    await vi.waitFor(() => expect(createConnectLink).toHaveBeenCalledTimes(2));
    const newestFlow = await newest;

    resolveStale?.({
      connectLinkUrl: "https://pipedream.com/connect?app=gmail&token=stale-private",
      expiresAt: "2026-08-27T12:10:00.000Z",
    });
    expect(await staleOutcome).toEqual(
      expect.objectContaining({ message: expect.stringMatching(/superseded/i) }),
    );
    expect(openConnectUrl).toHaveBeenCalledTimes(1);
    expect(openConnectUrl.mock.calls[0]?.[0]).toContain("app=slack");
    await service.cancelConnect({ flowId: newestFlow.flowId });
  });

  it("cleans an active stale Connect flow when its superseding request fails early", async () => {
    const releaseStaleOpen = deferred<void>();
    const openTabs = new Set<string>();
    let staleSuccessRedirectUrl = "";
    const createConnectLink = vi.fn<PipedreamMainServiceOptions["createConnectLink"]>(
      async (appSlug, redirects) => {
        if (appSlug === "gmail") {
          staleSuccessRedirectUrl = redirects.successRedirectUrl;
          return {
            connectLinkUrl:
              "https://pipedream.com/_static/connect.html?token=stale-private&connectLink=true&app=gmail",
            expiresAt: "2026-08-27T12:10:00.000Z",
          };
        }
        return {
          connectLinkUrl: "https://attacker.invalid/connect?app=slack&token=private",
          expiresAt: "2026-08-27T12:10:00.000Z",
        };
      },
    );
    const closeConnectTab = vi.fn<(tabId: string) => Promise<void>>(async (tabId) => {
      openTabs.delete(tabId);
    });
    const service = makeConnectLifecycleService({
      createConnectLink,
      openConnectUrl: async (_url, ownership) => {
        ownership.onTabOpened("sensitive-stale-active");
        openTabs.add("sensitive-stale-active");
        await releaseStaleOpen.promise;
        throw new Error("stale open failed");
      },
      closeConnectTab,
      isConnectTabOpen: async (tabId) => openTabs.has(tabId),
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap: async () => ({}) as never,
    });
    const stale = service.beginConnect({ appSlug: "gmail" });
    const staleOutcome = stale.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(openTabs).toEqual(new Set(["sensitive-stale-active"])));

    await expect(service.beginConnect({ appSlug: "slack" })).rejects.toThrow(
      /invalid Connect Link/i,
    );

    try {
      await vi.waitFor(() =>
        expect(closeConnectTab).toHaveBeenCalledExactlyOnceWith("sensitive-stale-active"),
      );
      expect(openTabs).toEqual(new Set());
      await expect(requestLoopback(staleSuccessRedirectUrl)).rejects.toThrow(/connect|socket/i);

      releaseStaleOpen.resolve();
      expect(await staleOutcome).toEqual(
        expect.objectContaining({ message: expect.stringMatching(/superseded/i) }),
      );
    } finally {
      releaseStaleOpen.resolve();
      await service.dispose();
    }
  });

  it("opens a valid replacement without waiting for the superseded tab opener", async () => {
    const releaseStaleOpen = deferred<void>();
    const openTabs = new Set<string>();
    const openConnectUrl = vi.fn<PipedreamMainServiceOptions["openConnectUrl"]>(
      async (url, ownership) => {
        const appSlug = new URL(url).searchParams.get("app")!;
        const tabId = `sensitive-${appSlug}`;
        ownership.onTabOpened(tabId);
        openTabs.add(tabId);
        if (appSlug === "gmail") await releaseStaleOpen.promise;
        return { tabId };
      },
    );
    const closeConnectTab = vi.fn<(tabId: string) => Promise<void>>(async (tabId) => {
      openTabs.delete(tabId);
    });
    const service = makeConnectLifecycleService({
      createConnectLink: async (appSlug) => ({
        connectLinkUrl: `https://pipedream.com/connect?app=${appSlug}&token=${appSlug}-private`,
        expiresAt: "2026-08-27T12:10:00.000Z",
      }),
      openConnectUrl,
      closeConnectTab,
      isConnectTabOpen: async (tabId) => openTabs.has(tabId),
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap: async () => ({}) as never,
    });
    const stale = service.beginConnect({ appSlug: "gmail" });
    const staleOutcome = stale.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(openTabs).toContain("sensitive-gmail"));

    const replacement = service.beginConnect({ appSlug: "slack" });
    try {
      await vi.waitFor(() =>
        expect(openConnectUrl.mock.calls.some(([url]) => url.includes("app=slack"))).toBe(true),
      );
      const replacementFlow = await replacement;
      expect(openTabs).toEqual(new Set(["sensitive-slack"]));

      releaseStaleOpen.resolve();
      expect(await staleOutcome).toEqual(
        expect.objectContaining({ message: expect.stringMatching(/superseded/i) }),
      );
      expect(openTabs).toEqual(new Set(["sensitive-slack"]));
      await service.cancelConnect({ flowId: replacementFlow.flowId });
    } finally {
      releaseStaleOpen.resolve();
      await service.dispose();
    }
  });

  it("revalidates request generation after asynchronous cleanup before opening a tab", async () => {
    let releaseCleanup: (() => void) | undefined;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const createConnectLink = vi.fn<
      (appSlug: string) => Promise<{ connectLinkUrl: string; expiresAt: string }>
    >(async (appSlug) => ({
      connectLinkUrl: `https://pipedream.com/connect?app=${appSlug}&token=${appSlug}-private`,
      expiresAt: "2026-08-27T12:10:00.000Z",
    }));
    const openedApps: string[] = [];
    const openConnectUrl = vi.fn<
      (url: string, ownership: PipedreamConnectTabOwnership) => Promise<{ tabId: string }>
    >(async (url, ownership) => {
      const appSlug = new URL(url).searchParams.get("app")!;
      openedApps.push(appSlug);
      const tabId = `sensitive-${appSlug}`;
      ownership.onTabOpened(tabId);
      return { tabId };
    });
    const closeConnectTab = vi.fn<(tabId: string) => Promise<void>>(async (tabId) => {
      if (tabId === "sensitive-initial") await cleanupGate;
    });
    const service = makeConnectLifecycleService({
      createConnectLink,
      openConnectUrl,
      closeConnectTab,
      isConnectTabOpen: async () => true,
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap: async () => ({}) as never,
    });
    await service.beginConnect({ appSlug: "initial" });

    const stale = service.beginConnect({ appSlug: "gmail" });
    const staleOutcome = stale.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(createConnectLink).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => {
      expect(closeConnectTab).toHaveBeenCalledWith("sensitive-initial");
    });
    const newest = service.beginConnect({ appSlug: "slack" });
    await vi.waitFor(() => expect(createConnectLink).toHaveBeenCalledTimes(3));

    releaseCleanup?.();
    expect(await staleOutcome).toEqual(
      expect.objectContaining({ message: expect.stringMatching(/superseded/i) }),
    );
    const newestFlow = await newest;
    expect(openedApps).toEqual(["initial", "slack"]);
    await service.cancelConnect({ flowId: newestFlow.flowId });
  });

  it("rejects any non-Pipedream or non-app-scoped link before opening it", async () => {
    const openConnectUrl = vi.fn<(url: string) => Promise<{ tabId: string }>>(async () => ({
      tabId: "sensitive-tab-private",
    }));
    const service = new PipedreamMainService({
      createConnectLink: async () => ({
        connectLinkUrl: "https://attacker.invalid/connect?token=private",
        expiresAt: "2026-08-27T12:10:00.000Z",
      }),
      openConnectUrl,
      closeConnectTab: async () => undefined,
      isConnectTabOpen: async () => true,
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap: async () => ({}) as never,
    });

    await expect(service.beginConnect({ appSlug: "slack" })).rejects.toThrow(/invalid/i);
    expect(openConnectUrl).not.toHaveBeenCalled();
  });

  it("imports a selected env file, persists only its path, and returns a redacted snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "y-space-pipedream-main-"));
    tempRoots.push(root);
    const filePath = join(root, ".env.pipedream");
    writeFileSync(
      filePath,
      [
        "PIPEDREAM_CLIENT_ID=runtime-client-id",
        "PIPEDREAM_CLIENT_SECRET=runtime-client-secret",
        "PIPEDREAM_PROJECT_ID=proj_Runtime123",
        "PIPEDREAM_ENVIRONMENT=development",
      ].join("\n"),
    );
    const persistEnvFilePath = vi.fn<(filePath: string) => void>();
    const configureBootstrap = vi.fn<PipedreamMainServiceOptions["configureBootstrap"]>(
      async () => ({
        personalMcp: { enabled: false, authenticated: false, serverName: "pd" as const },
        connect: {
          state: "ready" as const,
          credentialSource: "environment" as const,
          environment: "development" as const,
          projectIdHint: "proj_…0123",
          projectName: "Pipedream Connect",
          accounts: [],
        },
      }),
    );
    const service = makeService({ persistEnvFilePath, configureBootstrap });

    const result = await service.importEnvironmentFile(filePath);

    expect(result).toMatchObject({
      status: "configured",
      snapshot: { connect: { state: "ready" } },
    });
    expect(persistEnvFilePath).toHaveBeenCalledExactlyOnceWith(filePath);
    expect(configureBootstrap).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ state: "ready", source: "environment" }),
    );
    expect(JSON.stringify(result)).not.toMatch(
      /runtime-client-secret|runtime-client-id|Runtime123/,
    );
  });

  it("returns a safe validation result without replacing config for an unrelated file", async () => {
    const root = mkdtempSync(join(tmpdir(), "y-space-pipedream-main-"));
    tempRoots.push(root);
    const filePath = join(root, ".env.pipedream");
    writeFileSync(filePath, "UNRELATED=value\n");
    const persistEnvFilePath = vi.fn<(filePath: string) => void>();
    const configureBootstrap = vi.fn<PipedreamMainServiceOptions["configureBootstrap"]>();
    const service = makeService({ persistEnvFilePath, configureBootstrap });

    await expect(service.importEnvironmentFile(filePath)).resolves.toEqual({
      status: "invalid",
      reason: "no-supported-values",
    });
    expect(persistEnvFilePath).not.toHaveBeenCalled();
    expect(configureBootstrap).not.toHaveBeenCalled();
  });

  it("does not persist a selected path when live configuration fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "y-space-pipedream-main-"));
    tempRoots.push(root);
    const filePath = join(root, ".env.pipedream");
    writeFileSync(
      filePath,
      [
        "PIPEDREAM_CLIENT_ID=client-id",
        "PIPEDREAM_CLIENT_SECRET=client-secret",
        "PIPEDREAM_PROJECT_ID=proj_Failure123",
        "PIPEDREAM_ENVIRONMENT=development",
      ].join("\n"),
    );
    const persistEnvFilePath = vi.fn<(filePath: string) => void>();
    const configureBootstrap = vi.fn<PipedreamMainServiceOptions["configureBootstrap"]>(
      async () => {
        throw new Error("configuration unavailable");
      },
    );
    const service = makeService({ persistEnvFilePath, configureBootstrap });

    await expect(service.importEnvironmentFile(filePath)).rejects.toThrow(
      "configuration unavailable",
    );
    expect(persistEnvFilePath).not.toHaveBeenCalled();
  });

  it("forgets path metadata and restores the launch-time fallback", async () => {
    const clearEnvFilePath = vi.fn<() => void>();
    const configureBootstrap = vi.fn<PipedreamMainServiceOptions["configureBootstrap"]>(
      async () => ({
        personalMcp: { enabled: false, authenticated: false, serverName: "pd" as const },
        connect: { state: "absent" as const },
      }),
    );
    const service = makeService({ clearEnvFilePath, configureBootstrap });

    await expect(service.clearEnvironmentFile()).resolves.toMatchObject({
      connect: { state: "absent" },
    });
    expect(clearEnvFilePath).toHaveBeenCalledOnce();
    expect(configureBootstrap).toHaveBeenCalledExactlyOnceWith({ state: "absent" });
  });

  it("supersedes a pending Connect request before clearing and reconfiguring the environment", async () => {
    const pendingLink = deferred<{ connectLinkUrl: string; expiresAt: string }>();
    let successRedirectUrl = "";
    const openConnectUrl = vi.fn<PipedreamMainServiceOptions["openConnectUrl"]>();
    const configureBootstrap = vi.fn<PipedreamMainServiceOptions["configureBootstrap"]>(
      async () => {
        await expect(requestLoopback(successRedirectUrl)).rejects.toThrow(/connect|socket/i);
        return {
          personalMcp: { enabled: false, authenticated: false, serverName: "pd" },
          connect: { state: "absent" },
        } as never;
      },
    );
    const service = new PipedreamMainService({
      createConnectLink: async (_appSlug, redirects) => {
        successRedirectUrl = redirects.successRedirectUrl;
        return pendingLink.promise;
      },
      openConnectUrl,
      closeConnectTab: async () => undefined,
      isConnectTabOpen: async () => true,
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap,
    });
    const pending = service.beginConnect({ appSlug: "gmail" });
    const pendingOutcome = pending.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(successRedirectUrl).not.toBe(""));

    await service.clearEnvironmentFile();
    pendingLink.resolve({
      connectLinkUrl: "https://pipedream.com/connect?app=gmail&token=stale-private",
      expiresAt: "2026-08-27T12:10:00.000Z",
    });

    expect(await pendingOutcome).toEqual(
      expect.objectContaining({ message: expect.stringMatching(/superseded/i) }),
    );
    expect(openConnectUrl).not.toHaveBeenCalled();
    expect(configureBootstrap).toHaveBeenCalledExactlyOnceWith({ state: "absent" });
  });

  it("reconfigures without waiting for a superseded active tab opener", async () => {
    const releaseOpen = deferred<void>();
    const openTabs = new Set<string>();
    const configureBootstrap = vi.fn<PipedreamMainServiceOptions["configureBootstrap"]>(
      async () =>
        ({
          personalMcp: { enabled: false, authenticated: false, serverName: "pd" },
          connect: { state: "absent" },
        }) as never,
    );
    const service = new PipedreamMainService({
      createConnectLink: async () => ({
        connectLinkUrl: "https://pipedream.com/connect?app=gmail&token=private",
        expiresAt: "2026-08-27T12:10:00.000Z",
      }),
      openConnectUrl: async (_url, ownership) => {
        ownership.onTabOpened("sensitive-reconfigure-stuck-open");
        openTabs.add("sensitive-reconfigure-stuck-open");
        await releaseOpen.promise;
        return { tabId: "sensitive-reconfigure-stuck-open" };
      },
      closeConnectTab: async (tabId) => {
        openTabs.delete(tabId);
      },
      isConnectTabOpen: async (tabId) => openTabs.has(tabId),
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap,
    });
    const stale = service.beginConnect({ appSlug: "gmail" });
    const staleOutcome = stale.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(openTabs).toContain("sensitive-reconfigure-stuck-open"));

    const reconfiguration = service.clearEnvironmentFile();
    try {
      await vi.waitFor(() => expect(configureBootstrap).toHaveBeenCalledOnce());
      await expect(reconfiguration).resolves.toMatchObject({ connect: { state: "absent" } });
      expect(openTabs).toEqual(new Set());
    } finally {
      releaseOpen.resolve();
      await reconfiguration;
      await staleOutcome;
      await service.dispose();
    }
  });

  it("closes an active Connect tab before importing and reconfiguring the environment", async () => {
    const root = mkdtempSync(join(tmpdir(), "y-space-pipedream-main-"));
    tempRoots.push(root);
    const filePath = join(root, ".env.pipedream");
    writeFileSync(
      filePath,
      [
        "PIPEDREAM_CLIENT_ID=replacement-client-id",
        "PIPEDREAM_CLIENT_SECRET=replacement-client-secret",
        "PIPEDREAM_PROJECT_ID=proj_Replacement456",
        "PIPEDREAM_ENVIRONMENT=development",
      ].join("\n"),
    );
    const order: string[] = [];
    let ownership: PipedreamConnectTabOwnership | undefined;
    const configureBootstrap = vi.fn<PipedreamMainServiceOptions["configureBootstrap"]>(
      async () => {
        order.push("configure");
        return {
          personalMcp: { enabled: false, authenticated: false, serverName: "pd" },
          connect: { state: "absent" },
        } as never;
      },
    );
    const service = new PipedreamMainService({
      createConnectLink: async () => ({
        connectLinkUrl: "https://pipedream.com/connect?app=gmail&token=private",
        expiresAt: "2026-08-27T12:10:00.000Z",
      }),
      openConnectUrl: async (_url, tabOwnership) => {
        ownership = tabOwnership;
        tabOwnership.onTabOpened("sensitive-active-before-import");
        return { tabId: "sensitive-active-before-import" };
      },
      closeConnectTab: async (tabId) => {
        order.push("close");
        ownership?.onTabClosed(tabId);
      },
      isConnectTabOpen: async () => true,
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap,
    });
    const { flowId } = await service.beginConnect({ appSlug: "gmail" });

    await service.importEnvironmentFile(filePath);

    expect(order).toEqual(["close", "configure"]);
    expect(ownership?.canOpenTab()).toBe(false);
    await expect(service.getConnectFlowStatus({ flowId })).resolves.toEqual({ state: "closed" });
  });
});
