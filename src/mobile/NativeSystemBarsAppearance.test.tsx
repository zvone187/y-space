// @vitest-environment jsdom
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  appearance: "light" as "light" | "dark",
  native: true,
  setStyle: vi.fn<(options: { style: "LIGHT" | "DARK" }) => Promise<void>>(async () => {}),
}));

vi.mock("@capacitor/core", () => ({
  SystemBars: { setStyle: runtime.setStyle },
  SystemBarsStyle: { Light: "LIGHT", Dark: "DARK" },
}));

vi.mock("@/renderer/components/ui/provider", () => ({
  useResolvedAppearance: () => runtime.appearance,
}));

vi.mock("./pwaInstall", () => ({
  isNativeApp: () => runtime.native,
}));

import { NativeSystemBarsAppearance } from "./NativeSystemBarsAppearance";

describe("NativeSystemBarsAppearance", () => {
  beforeEach(() => {
    runtime.appearance = "light";
    runtime.native = true;
    runtime.setStyle.mockClear();
    runtime.setStyle.mockResolvedValue(undefined);
  });

  it("keeps native system-bar icons legible as the app appearance changes", async () => {
    const view = render(<NativeSystemBarsAppearance />);

    await waitFor(() => {
      expect(runtime.setStyle).toHaveBeenLastCalledWith({ style: "LIGHT" });
    });

    runtime.appearance = "dark";
    view.rerender(<NativeSystemBarsAppearance />);

    await waitFor(() => {
      expect(runtime.setStyle).toHaveBeenLastCalledWith({ style: "DARK" });
    });
    expect(runtime.setStyle).toHaveBeenCalledTimes(2);
  });

  it("leaves the browser and installed PWA untouched", async () => {
    runtime.native = false;

    render(<NativeSystemBarsAppearance />);

    await Promise.resolve();
    expect(runtime.setStyle).not.toHaveBeenCalled();
  });
});
