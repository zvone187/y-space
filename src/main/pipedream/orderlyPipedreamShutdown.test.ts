import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOrderlyPipedreamShutdown,
  ORDERLY_PIPEDREAM_DISPOSE_TIMEOUT_MS,
} from "./orderlyPipedreamShutdown";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("createOrderlyPipedreamShutdown", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for Pipedream disposal before disposing the browser manager and finalizing quit", async () => {
    const pipedreamDisposal = deferred<void>();
    const order: string[] = [];
    const handler = createOrderlyPipedreamShutdown({
      beginShutdown: () => order.push("begin"),
      disposePipedream: () => {
        order.push("pipedream");
        return pipedreamDisposal.promise;
      },
      disposeBrowserManager: () => order.push("browser"),
      reportPipedreamDisposeError: () => order.push("error"),
      requestFinalQuit: () => order.push("quit"),
    });
    const firstEvent = { preventDefault: vi.fn<() => void>() };
    const repeatedEvent = { preventDefault: vi.fn<() => void>() };

    handler(firstEvent);
    handler(repeatedEvent);

    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    expect(repeatedEvent.preventDefault).toHaveBeenCalledOnce();
    expect(order).toEqual(["begin", "pipedream"]);

    pipedreamDisposal.resolve();
    await vi.waitFor(() => expect(order).toEqual(["begin", "pipedream", "browser", "quit"]));

    const finalEvent = { preventDefault: vi.fn<() => void>() };
    handler(finalEvent);
    expect(finalEvent.preventDefault).not.toHaveBeenCalled();
  });

  it("catches Pipedream disposal rejection and still completes browser disposal and quit", async () => {
    const disposeBrowserManager = vi.fn<() => void>();
    const reportPipedreamDisposeError = vi.fn<() => void>();
    const requestFinalQuit = vi.fn<() => void>();
    const handler = createOrderlyPipedreamShutdown({
      beginShutdown: vi.fn<() => void>(),
      disposePipedream: async () => {
        throw new Error("secret-bearing cleanup detail");
      },
      disposeBrowserManager,
      reportPipedreamDisposeError,
      requestFinalQuit,
    });

    handler({ preventDefault: vi.fn<() => void>() });

    await vi.waitFor(() => expect(requestFinalQuit).toHaveBeenCalledOnce());
    expect(reportPipedreamDisposeError).toHaveBeenCalledOnce();
    expect(disposeBrowserManager).toHaveBeenCalledBefore(requestFinalQuit);
  });

  it("reaches final quit when the complete Pipedream disposal never settles", async () => {
    vi.useFakeTimers();
    const disposeBrowserManager = vi.fn<() => void>();
    const reportPipedreamDisposeError = vi.fn<() => void>();
    const requestFinalQuit = vi.fn<() => void>();
    const handler = createOrderlyPipedreamShutdown({
      beginShutdown: vi.fn<() => void>(),
      disposePipedream: () => new Promise<void>(() => undefined),
      disposeBrowserManager,
      reportPipedreamDisposeError,
      requestFinalQuit,
    });

    handler({ preventDefault: vi.fn<() => void>() });
    await vi.advanceTimersByTimeAsync(ORDERLY_PIPEDREAM_DISPOSE_TIMEOUT_MS);
    await Promise.resolve();

    expect(reportPipedreamDisposeError).toHaveBeenCalledOnce();
    expect(disposeBrowserManager).toHaveBeenCalledBefore(requestFinalQuit);
    expect(requestFinalQuit).toHaveBeenCalledOnce();
  });

  it("observes a late disposal rejection after the deadline without reporting or quitting twice", async () => {
    vi.useFakeTimers();
    const pipedreamDisposal = deferred<void>();
    const disposeBrowserManager = vi.fn<() => void>();
    const reportPipedreamDisposeError = vi.fn<() => void>();
    const requestFinalQuit = vi.fn<() => void>();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const handler = createOrderlyPipedreamShutdown({
      beginShutdown: vi.fn<() => void>(),
      disposePipedream: () => pipedreamDisposal.promise,
      disposeBrowserManager,
      reportPipedreamDisposeError,
      requestFinalQuit,
    });

    try {
      handler({ preventDefault: vi.fn<() => void>() });
      await vi.advanceTimersByTimeAsync(ORDERLY_PIPEDREAM_DISPOSE_TIMEOUT_MS);
      await Promise.resolve();

      expect(reportPipedreamDisposeError).toHaveBeenCalledOnce();
      expect(disposeBrowserManager).toHaveBeenCalledOnce();
      expect(requestFinalQuit).toHaveBeenCalledOnce();

      pipedreamDisposal.reject(new Error("late sensitive guest destruction failure"));
      await Promise.resolve();
      await Promise.resolve();

      expect(unhandled).toEqual([]);
      expect(reportPipedreamDisposeError).toHaveBeenCalledOnce();
      expect(disposeBrowserManager).toHaveBeenCalledOnce();
      expect(requestFinalQuit).toHaveBeenCalledOnce();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
