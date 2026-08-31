import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { renderWithI18n as render } from "@/renderer/testUtils/i18n";
import { usePanelStore } from "@/renderer/state/panelStore";
import { WELCOME_SEEN_STORAGE_KEY } from "@/renderer/state/welcomeGateStore";
import { COOKIE_IMPORT_PROMPT_STORAGE_KEY, CookieImportPrompt } from "./CookieImportPrompt";

describe("CookieImportPrompt", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(WELCOME_SEEN_STORAGE_KEY, "true");
    usePanelStore.setState({
      settingsOpen: false,
      settingsSection: null,
      settingsAnchor: null,
    });
  });

  it("asks once on a returning user's first eligible launch", () => {
    const view = render(<CookieImportPrompt />);

    expect(
      screen.getByRole("heading", { name: "Bring your browser sessions into Y Space?" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));

    expect(localStorage.getItem(COOKIE_IMPORT_PROMPT_STORAGE_KEY)).toBe("true");
    expect(
      screen.queryByRole("heading", { name: "Bring your browser sessions into Y Space?" }),
    ).not.toBeInTheDocument();

    view.unmount();
    render(<CookieImportPrompt />);
    expect(
      screen.queryByRole("heading", { name: "Bring your browser sessions into Y Space?" }),
    ).not.toBeInTheDocument();
  });

  it("deep-links the consent action to the cookie importer", () => {
    render(<CookieImportPrompt />);

    fireEvent.click(screen.getByRole("button", { name: "Choose browsers" }));

    expect(localStorage.getItem(COOKIE_IMPORT_PROMPT_STORAGE_KEY)).toBe("true");
    expect(usePanelStore.getState()).toMatchObject({
      settingsOpen: true,
      settingsSection: "browser",
      settingsAnchor: "browser.cookieImport",
    });
  });
});
