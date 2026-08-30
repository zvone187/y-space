import { beforeEach, describe, expect, it } from "vitest";
import { bootstrapAppThemeFromCache, persistThemeBoot } from "./applyAppTheme";

describe("Y Space theme bootstrap migration", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = "dark";
    document.documentElement.dataset.theme = "dark";
  });

  it("boots the unversioned legacy dark factory theme as light", () => {
    localStorage.setItem(
      "poracode-shared-settings",
      JSON.stringify({ themeMode: "dark", themePreset: "default" }),
    );

    bootstrapAppThemeFromCache();

    expect(document.documentElement.classList.contains("light")).toBe(true);
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("preserves an explicit dark choice made after the light-default migration", () => {
    localStorage.setItem(
      "poracode-shared-settings",
      JSON.stringify({ themeMode: "dark", themePreset: "default", themeDefaultVersion: 1 }),
    );

    bootstrapAppThemeFromCache();

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("versions the derived first-paint cache so legacy dark boot data is not trusted", () => {
    persistThemeBoot("light", "default");

    expect(JSON.parse(localStorage.getItem("poracode-boot") ?? "null")).toMatchObject({
      appearance: "light",
      themeDefaultVersion: 1,
    });
  });
});
