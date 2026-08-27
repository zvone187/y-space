import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithI18n as render } from "@/renderer/testUtils/i18n";

const sharedSettingsState = vi.hoisted(() => ({
  browser: {
    allowEval: false,
    allowDataAccess: false,
    linkOpenTarget: "internal",
    linkPresentationMode: "panel",
  },
  setBrowserSetting: vi.fn<(key: string, value: unknown) => void>(),
}));

vi.mock("@/renderer/state/sharedSettingsStore", () => ({
  useSharedSettings: (selector: (state: typeof sharedSettingsState) => unknown) =>
    selector(sharedSettingsState),
}));

vi.mock("./BrowserCookieImportSettings", () => ({
  BrowserCookieImportSettings: () => <div>Cookie import settings</div>,
}));

import { BrowserSettings } from "./BrowserSettings";

describe("BrowserSettings", () => {
  it("includes the cookie import flow alongside embedded-browser controls", () => {
    render(<BrowserSettings />);

    expect(screen.getByText("Browser")).toBeInTheDocument();
    expect(screen.getByText("Cookie import settings")).toBeInTheDocument();
    expect(screen.getByText("Show opened links in")).toBeInTheDocument();
    expect(screen.queryByText("System Browser")).not.toBeInTheDocument();
  });
});
