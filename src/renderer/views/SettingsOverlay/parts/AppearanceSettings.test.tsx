import { readFileSync } from "node:fs";
import { join } from "node:path";
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithI18n as render } from "@/renderer/testUtils/i18n";

const bridgeMock = vi.hoisted(() => ({
  isRemoteSession: vi.fn<() => boolean>(() => false),
}));

vi.mock("@/renderer/bridge", () => ({
  isMac: () => false,
  isRemoteSession: bridgeMock.isRemoteSession,
}));

import { AppearanceSettings } from "./AppearanceSettings";

describe("AppearanceSettings", () => {
  beforeEach(() => {
    bridgeMock.isRemoteSession.mockReturnValue(false);
  });

  it("shows desktop sidebar glass controls in local sessions", () => {
    render(<AppearanceSettings />);

    expect(screen.getByText("Translucent sidebar")).toBeInTheDocument();
  });

  it("hides desktop sidebar glass controls in remote sessions", () => {
    bridgeMock.isRemoteSession.mockReturnValue(true);

    render(<AppearanceSettings />);

    expect(screen.queryByText("Translucent sidebar")).not.toBeInTheDocument();
    expect(screen.getByText("Chat text size")).toBeInTheDocument();
  });

  it("keeps every platform glass default selectable without step snapping", () => {
    const source = readFileSync(
      join(process.cwd(), "src/renderer/views/SettingsOverlay/parts/AppearanceSettings.tsx"),
      "utf8",
    );

    expect(source).toContain("step={1}");
    expect(source).not.toContain('step={appearance === "light" ? 1 : 5}');
  });
});
