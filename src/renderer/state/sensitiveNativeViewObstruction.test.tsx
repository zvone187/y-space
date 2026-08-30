// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireSensitiveNativeViewObstruction,
  registerSensitiveNativeViewPresenter,
  useSensitiveNativeViewOverlayGate,
} from "./sensitiveNativeViewObstruction";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function GateHarness(props: { active: boolean }) {
  const ready = useSensitiveNativeViewOverlayGate(props.active);
  return ready ? <div>Overlay ready</div> : null;
}

describe("sensitive native-view obstruction", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("presents synchronously when no presenter or automation listener exists", () => {
    const view = render(<GateHarness active />);

    expect(screen.getByText("Overlay ready")).toBeInTheDocument();
    view.unmount();
  });

  it("keeps a retiring presenter authoritative for a newly acquired obstruction", async () => {
    const cleanupHide = deferred();
    const presenter = vi.fn<(obstructed: boolean) => Promise<void>>().mockResolvedValue(undefined);
    const unregister = registerSensitiveNativeViewPresenter(presenter);

    unregister(cleanupHide.promise);
    const lease = acquireSensitiveNativeViewObstruction();
    let hidden = false;
    void lease.hidden.then(() => {
      hidden = true;
    });
    await act(async () => Promise.resolve());

    expect(hidden).toBe(false);
    expect(presenter).not.toHaveBeenCalledWith(true);

    cleanupHide.resolve();
    await act(async () => lease.hidden);
    expect(hidden).toBe(true);
    lease.release();
  });

  it("retains the lease through an exiting surface and reuses it if reopened", async () => {
    vi.useFakeTimers();
    const presenter = vi.fn<(obstructed: boolean) => Promise<void>>().mockResolvedValue(undefined);
    const unregister = registerSensitiveNativeViewPresenter(presenter);
    const view = render(<GateHarness active={false} />);

    view.rerender(<GateHarness active />);
    await act(async () => Promise.resolve());
    expect(screen.getByText("Overlay ready")).toBeInTheDocument();
    expect(presenter).toHaveBeenCalledWith(true);

    presenter.mockClear();
    view.rerender(<GateHarness active={false} />);
    await act(async () => vi.advanceTimersByTimeAsync(249));
    expect(presenter).not.toHaveBeenCalledWith(false);

    view.rerender(<GateHarness active />);
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByText("Overlay ready")).toBeInTheDocument();
    expect(presenter).not.toHaveBeenCalledWith(false);

    view.rerender(<GateHarness active={false} />);
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(presenter).toHaveBeenCalledWith(false);

    view.unmount();
    unregister(Promise.resolve());
  });

  // Keep this last: a failed native hide intentionally poisons the renderer-
  // local registry so every future overlay in that renderer remains closed.
  it("fails closed for every new obstruction after a retiring hide rejects", async () => {
    let rejectCleanupHide!: (error: Error) => void;
    const cleanupHide = new Promise<void>((_resolve, reject) => {
      rejectCleanupHide = reject;
    });
    const presenter = vi.fn<(obstructed: boolean) => Promise<void>>().mockResolvedValue(undefined);
    const unregister = registerSensitiveNativeViewPresenter(presenter);
    unregister(cleanupHide);

    const first = acquireSensitiveNativeViewObstruction();
    const failure = new Error("native hide failed");
    rejectCleanupHide(failure);
    await expect(first.hidden).rejects.toBe(failure);
    first.release();

    const second = acquireSensitiveNativeViewObstruction();
    await expect(second.hidden).rejects.toBe(failure);
    expect(presenter).not.toHaveBeenCalledWith(true);
    second.release();
  });
});
