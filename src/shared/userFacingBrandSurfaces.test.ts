import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildLocalPairingIconSvg, buildLocalPairingPageHtml } from "@/main/remote/pairingPage";

const read = (path: string) => readFileSync(path, "utf8");

const LEGACY_BRAND_COLORS = ["#8b7bff", "#8892ef", "#5f6cd9", "#b6acff", "rgba(139,123,255"];

describe("user-facing Y Space brand surfaces", () => {
  it("uses the orange accent in the website, mobile shell, and cookie importer", () => {
    const sources = [
      "website/src/app/globals.css",
      "website/src/app/global-error.tsx",
      "website/src/app/home-content.tsx",
      "website/src/app/(default)/about/page.tsx",
      "website/src/components/BrandMark.tsx",
      "website/src/components/WindowFrame.tsx",
      "website/scripts/regenerate-brand-showcase.mjs",
      "mobile.html",
      "chrome-extension/popup.html",
      "src/renderer/views/ProjectSettingsOverlay/parts/ProjectIconSources.tsx",
    ].map((path) => read(path).toLowerCase());

    expect(sources.join("\n")).toContain("#ff5a1f");
    expect(sources.join("\n")).toContain("rgba(255,90,31");

    for (const source of sources) {
      for (const legacyColor of LEGACY_BRAND_COLORS) {
        expect(source).not.toContain(legacyColor);
      }
    }
  });

  it("uses the orange accent in local pairing pages and icons", () => {
    const page = buildLocalPairingPageHtml({ httpBaseUrl: "http://127.0.0.1:4000" });

    expect(page.toLowerCase()).toContain("--accent: #ff5a1f");
    expect(buildLocalPairingIconSvg("stable").toLowerCase()).toContain("#ff5a1f");
    expect(buildLocalPairingIconSvg("nightly").toLowerCase()).toContain("#ff5a1f");

    for (const source of [page, buildLocalPairingIconSvg("stable")]) {
      for (const legacyColor of LEGACY_BRAND_COLORS) {
        expect(source.toLowerCase()).not.toContain(legacyColor);
      }
    }
  });

  it("keeps the native and mobile first paint on the same light default", () => {
    const mobile = read("mobile.html");
    const capacitor = read("capacitor.config.json");
    const capacitorConfig = JSON.parse(capacitor) as {
      plugins: { SystemBars: { style: string } };
    };

    expect(mobile).toContain('<html lang="en" class="light" data-theme="light">');
    expect(mobile).toContain('<meta name="theme-color" content="#ffffff" />');
    expect(mobile).toContain("--mobile-boot-bg: #ffffff");
    expect(mobile).toContain('localStorage.getItem("poracode-boot")');
    expect(mobile).toContain('localStorage.getItem("poracode-shared-settings")');
    expect(mobile).not.toContain("background: #000000");
    expect(capacitor).toContain('"backgroundColor": "#FFFFFF"');
    expect(capacitorConfig.plugins.SystemBars.style).toBe("LIGHT");
  });

  it("advertises the real Y Space MCP server name without legacy branding", () => {
    const marketing = read("website/src/app/home-content.tsx");

    expect(marketing).toContain('server: "y_space"');
    expect(marketing).not.toContain('server: "poracode"');
  });

  it("uses dedicated accessible orange tokens for small accent text", () => {
    const websiteGlobals = read("website/src/app/globals.css");
    const websiteTextSurfaces = [
      "website/src/app/home-content.tsx",
      "website/src/app/landing-faq.tsx",
      "website/src/app/(default)/about/page.tsx",
    ].map(read);
    const appStyles = read("src/renderer/styles.css");
    const cursorRuntimeCard = read(
      "src/renderer/views/SettingsOverlay/parts/CursorRuntimeCard.tsx",
    );

    expect(websiteGlobals).toContain("--color-accent-text-light: #b43f00");
    expect(websiteGlobals).toContain("--color-accent-text-dark: #ff9b73");
    for (const source of websiteTextSurfaces) {
      expect(source).toContain("text-accent-text");
      expect(source).not.toMatch(/(?:^|\s)text-accent(?:\s|["'])/m);
    }
    expect(appStyles).toContain("--accent-text: #b43f00");
    expect(appStyles).toContain("--link: var(--accent-text)");
    expect(cursorRuntimeCard).toContain("text-accent-text");
    expect(cursorRuntimeCard).not.toMatch(/(?:^|\s)text-accent(?:\s|["'])/m);
  });

  it("keeps owned extension controls and dev-only copy on the accessible Y Space brand", () => {
    const popup = read("chrome-extension/popup.html");
    const devSettings = read("src/renderer/views/SettingsOverlay/parts/DevSettings.tsx");
    const globalError = read("website/src/app/global-error.tsx");

    expect(popup).toMatch(/button\s*\{[^}]*background:\s*var\(--accent\);[^}]*color:\s*#181816;/s);
    expect(popup).not.toMatch(
      /button\s*\{[^}]*background:\s*var\(--accent\);[^}]*color:\s*#(?:fff|ffffff);/s,
    );
    expect(devSettings).toContain("Y Space Dev builds");
    expect(devSettings).not.toContain("PORACODE DEV");
    expect(globalError).toContain('color: "#181816"');
    expect(globalError).not.toContain('color: "#ffffff"');
  });
});
