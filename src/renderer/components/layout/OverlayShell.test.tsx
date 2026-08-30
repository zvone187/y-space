import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { registerSensitiveNativeViewPresenter } from "@/renderer/state/sensitiveNativeViewObstruction";
import { OverlayShell } from "./OverlayShell";

function surface(container: HTMLElement) {
  return container.querySelector("[data-overlay-surface]")!;
}

async function flushFadeIn() {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
}

describe("OverlayShell", () => {
  it("does not paint Settings until a sensitive native view confirms it is hidden", async () => {
    let finishHide!: () => void;
    const hidden = new Promise<void>((resolve) => {
      finishHide = resolve;
    });
    const presenter = vi.fn<(obstructed: boolean) => Promise<void>>((obstructed) =>
      obstructed ? hidden : Promise.resolve(),
    );
    const unregister = registerSensitiveNativeViewPresenter(presenter);

    try {
      render(
        <OverlayShell open instantEnter>
          <div>Settings</div>
        </OverlayShell>,
      );

      expect(presenter).toHaveBeenCalledWith(true);
      expect(screen.queryByText("Settings")).not.toBeInTheDocument();

      await act(async () => {
        finishHide();
        await hidden;
        await Promise.resolve();
      });

      expect(screen.getByText("Settings")).toBeInTheDocument();
    } finally {
      unregister(Promise.resolve());
    }
  });

  it("retains the open content until the exit transition finishes", async () => {
    const onExited = vi.fn<() => void>();
    const { container, rerender } = render(
      <OverlayShell open onExited={onExited}>
        <div>GitHub Actions</div>
      </OverlayShell>,
    );
    await act(async () => Promise.resolve());

    // The GitHub Actions overlay clears its own context on close, so `open` and
    // `children` drop in the same render — the content must survive the fade.
    rerender(
      <OverlayShell open={false} onExited={onExited}>
        {null}
      </OverlayShell>,
    );

    expect(screen.getByText("GitHub Actions")).toBeInTheDocument();

    fireEvent.transitionEnd(surface(container), { propertyName: "opacity" });

    expect(screen.queryByText("GitHub Actions")).not.toBeInTheDocument();
    expect(onExited).toHaveBeenCalledOnce();

    rerender(
      <OverlayShell open onExited={onExited}>
        <div>GitHub Actions reopened</div>
      </OverlayShell>,
    );
    await act(async () => Promise.resolve());

    expect(screen.getByText("GitHub Actions reopened")).toBeInTheDocument();
  });

  it("ignores transitionEnd from content that bubbles up to the surface", async () => {
    const onExited = vi.fn<() => void>();
    const { container, rerender } = render(
      <OverlayShell open onExited={onExited}>
        <div data-testid="content">GitHub Actions</div>
      </OverlayShell>,
    );

    await act(async () => Promise.resolve());
    await flushFadeIn();
    rerender(
      <OverlayShell open={false} onExited={onExited}>
        <div data-testid="content">GitHub Actions</div>
      </OverlayShell>,
    );

    // A child's own fade bubbles to the surface — it must not cut the exit short.
    fireEvent.transitionEnd(screen.getByTestId("content"), { propertyName: "opacity" });
    expect(onExited).not.toHaveBeenCalled();
    // Neither may a non-opacity transition on the surface itself.
    fireEvent.transitionEnd(surface(container), { propertyName: "transform" });
    expect(onExited).not.toHaveBeenCalled();

    fireEvent.transitionEnd(surface(container), { propertyName: "opacity" });
    expect(onExited).toHaveBeenCalledOnce();
  });

  it("fades in by default", async () => {
    const { container } = render(
      <OverlayShell open>
        <div>Settings</div>
      </OverlayShell>,
    );
    await act(async () => Promise.resolve());

    expect(surface(container).className).toContain("opacity-0");

    await flushFadeIn();

    expect(surface(container).className).toContain("opacity-100");
  });

  it("appears fully opaque with instantEnter, and still fades out", async () => {
    const onExited = vi.fn<() => void>();
    const { container, rerender } = render(
      <OverlayShell open instantEnter onExited={onExited}>
        <div>GitHub Actions</div>
      </OverlayShell>,
    );
    await act(async () => Promise.resolve());

    // Opaque on the first painted frame — no opacity-0 pass, so no frame
    // composites the overlay against bare desktop material.
    expect(surface(container).className).toContain("opacity-100");
    expect(surface(container).hasAttribute("data-overlay-visible")).toBe(true);

    rerender(
      <OverlayShell open={false} instantEnter onExited={onExited}>
        {null}
      </OverlayShell>,
    );

    expect(surface(container).className).toContain("opacity-0");
    expect(screen.getByText("GitHub Actions")).toBeInTheDocument();

    fireEvent.transitionEnd(surface(container), { propertyName: "opacity" });
    expect(onExited).toHaveBeenCalledOnce();
  });
});
