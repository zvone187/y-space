import { afterEach, describe, expect, it, vi } from "vitest";
import type { CdpClient } from "./cdpClient";
import { DialogController } from "./dialogController";

function createCdp() {
  let handler: ((params: unknown) => void) | null = null;
  const unsub = vi.fn<() => void>();
  const cdp = {
    send: vi
      .fn<(method: string, params?: Record<string, unknown>) => Promise<void>>()
      .mockResolvedValue(undefined),
    on: vi.fn<(method: string, nextHandler: (params: unknown) => void) => () => void>(
      (_method, nextHandler) => {
        handler = nextHandler;
        return unsub;
      },
    ),
  };
  return {
    cdp: cdp as unknown as CdpClient,
    rawCdp: cdp,
    unsub,
    emit(params: unknown) {
      handler?.(params);
    },
  };
}

describe("DialogController suspension", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("unbinds the destroyed CDP client and carries the next disposition to the replacement", async () => {
    const dialogs = new DialogController();
    const first = createCdp();
    const second = createCdp();

    await dialogs.enable(first.cdp);
    dialogs.setNextDisposition({ action: "accept", promptText: "approved" });
    dialogs.suspend();

    expect(first.unsub).toHaveBeenCalledOnce();

    await dialogs.enable(second.cdp);
    second.emit({
      type: "prompt",
      message: "Continue?",
      defaultPrompt: "",
      url: "https://second.test/",
    });
    await vi.waitFor(() =>
      expect(second.rawCdp.send).toHaveBeenCalledWith("Page.handleJavaScriptDialog", {
        accept: true,
        promptText: "approved",
      }),
    );

    expect(second.rawCdp.on).toHaveBeenCalledWith(
      "Page.javascriptDialogOpening",
      expect.any(Function),
    );
    expect(dialogs.recent(1)).toMatchObject([
      { message: "Continue?", decision: "answered", promptText: "approved" },
    ]);
  });

  it("does not bind an obsolete client when Page.enable resolves after remount", async () => {
    const dialogs = new DialogController();
    const first = createCdp();
    const second = createCdp();
    let resolveFirst!: () => void;
    first.rawCdp.send = vi.fn<(method: string, params?: Record<string, unknown>) => Promise<void>>(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
    );

    const staleEnable = dialogs.enable(first.cdp);
    dialogs.suspend();
    await dialogs.enable(second.cdp);
    resolveFirst();
    await staleEnable;

    expect(first.rawCdp.on).not.toHaveBeenCalled();
    expect(second.rawCdp.on).toHaveBeenCalledOnce();
  });

  it("bounds a Page.enable command that never settles", async () => {
    vi.useFakeTimers();
    const dialogs = new DialogController();
    const target = createCdp();
    target.rawCdp.send.mockReturnValue(new Promise<void>(() => {}));

    const enabling = dialogs.enable(target.cdp);
    const observed = enabling.then(
      () => "enabled" as const,
      () => "rejected" as const,
    );

    await vi.advanceTimersByTimeAsync(1_100);

    expect(await Promise.race([observed, Promise.resolve("pending" as const)])).toBe("rejected");
    expect(target.rawCdp.on).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    target.rawCdp.send.mockResolvedValue(undefined);
    await dialogs.enable(target.cdp);
    expect(target.rawCdp.on).toHaveBeenCalledOnce();
    dialogs.dispose();
  });

  it("settles and cancels a pending enable immediately when suspended", async () => {
    vi.useFakeTimers();
    const dialogs = new DialogController();
    const target = createCdp();
    target.rawCdp.send.mockReturnValue(new Promise<void>(() => {}));
    const enabling = dialogs.enable(target.cdp);
    const observed = enabling.then(
      () => "settled" as const,
      () => "rejected" as const,
    );

    dialogs.suspend();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(await Promise.race([observed, Promise.resolve("pending" as const)])).toBe("settled");
    expect(vi.getTimerCount()).toBe(0);
  });
});
