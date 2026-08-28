import { describe, expect, it, vi } from "vitest";
import type { CdpClient } from "./cdpClient";
import { NetworkCapture } from "./networkCapture";

function createCdp() {
  const handlers = new Map<string, (params: unknown) => void>();
  const unsubs: Array<ReturnType<typeof vi.fn<() => void>>> = [];
  const cdp = {
    send: vi
      .fn<(method: string, params?: Record<string, unknown>) => Promise<void>>()
      .mockResolvedValue(undefined),
    on: vi.fn<(method: string, handler: (params: unknown) => void) => () => void>(
      (method, handler) => {
        handlers.set(method, handler);
        const unsub = vi.fn<() => void>(() => {
          if (handlers.get(method) === handler) handlers.delete(method);
        });
        unsubs.push(unsub);
        return unsub;
      },
    ),
  };
  return {
    cdp: cdp as unknown as CdpClient,
    rawCdp: cdp,
    handlers,
    unsubs,
    emit(method: string, params: unknown) {
      handlers.get(method)?.(params);
    },
  };
}

describe("NetworkCapture suspension", () => {
  it("bounds page-controlled network fields and aggregate UTF-8 bytes", async () => {
    const { MAX_NETWORK_CAPTURE_TOTAL_BYTES } = await import("./networkCapture");
    const capture = new NetworkCapture();
    const target = createCdp();
    await capture.enable(target.cdp);

    for (let index = 0; index < 200; index += 1) {
      const requestId = `request-${index}`;
      target.emit("Network.requestWillBeSent", {
        requestId,
        request: {
          url: `https://example.test/${index}?payload=${"🚀".repeat(40_000)}`,
          method: `GET${"M".repeat(10_000)}`,
        },
        type: `Fetch${"T".repeat(10_000)}`,
        timestamp: index + 1,
        wallTime: index + 100,
      });
      target.emit("Network.responseReceived", {
        requestId,
        response: {
          status: 200,
          statusText: "S".repeat(20_000),
          mimeType: "M".repeat(20_000),
        },
        timestamp: index + 1.5,
      });
    }

    const entries = capture.list({ limit: 500 });
    const retainedBytes = entries.reduce(
      (total, entry) =>
        total +
        [
          entry.requestId,
          entry.method,
          entry.url,
          entry.resourceType,
          entry.statusText,
          entry.mimeType,
          entry.error,
        ].reduce((sum, value) => sum + Buffer.byteLength(value ?? "", "utf8"), 0),
      0,
    );

    expect(retainedBytes).toBeLessThanOrEqual(MAX_NETWORK_CAPTURE_TOTAL_BYTES);
    expect(entries.every((entry) => Buffer.byteLength(entry.url, "utf8") <= 64 * 1024)).toBe(true);
  });

  it("unbinds the destroyed CDP client, preserves bounded history, and binds the replacement", async () => {
    const capture = new NetworkCapture();
    const first = createCdp();
    const second = createCdp();

    await capture.enable(first.cdp);
    first.emit("Network.requestWillBeSent", {
      requestId: "first-request",
      request: { url: "https://first.test/", method: "GET" },
      timestamp: 1,
      wallTime: 100,
    });

    capture.suspend();

    expect(capture.isEnabled()).toBe(false);
    expect(first.unsubs).toHaveLength(4);
    expect(first.unsubs.every((unsub) => unsub.mock.calls.length === 1)).toBe(true);

    await capture.enable(second.cdp);
    second.emit("Network.requestWillBeSent", {
      requestId: "second-request",
      request: { url: "https://second.test/", method: "POST" },
      timestamp: 2,
      wallTime: 200,
    });

    expect(capture.isEnabled()).toBe(true);
    expect(capture.list({ limit: 10 }).map((entry) => entry.url)).toEqual([
      "https://first.test/",
      "https://second.test/",
    ]);
  });

  it("does not install listeners from an enable that finishes after suspension", async () => {
    const capture = new NetworkCapture();
    const first = createCdp();
    const second = createCdp();
    let resolveFirst!: () => void;
    first.rawCdp.send = vi.fn<(method: string, params?: Record<string, unknown>) => Promise<void>>(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
    );

    const staleEnable = capture.enable(first.cdp);
    capture.suspend();
    await capture.enable(second.cdp);
    resolveFirst();
    await staleEnable;

    expect(first.rawCdp.on).not.toHaveBeenCalled();
    expect(second.rawCdp.on).toHaveBeenCalledTimes(4);
    expect(capture.isEnabled()).toBe(true);
  });
});
