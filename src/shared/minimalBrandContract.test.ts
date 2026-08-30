import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_THEME_PRESETS, THEME_SPECS } from "@/renderer/theme/themePresets";
import { contrastRatio } from "@/renderer/theme/colorMath";
import { defaultSharedSettings } from "./settings";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
const readBytes = (path: string) => readFileSync(join(root, path));

describe("Y Space minimal brand contract", () => {
  it("starts fresh profiles in the light, quiet appearance", () => {
    expect(defaultSharedSettings.themeMode).toBe("light");
    expect(defaultSharedSettings.themePreset).toBe("default");
    expect(defaultSharedSettings.usage.showInSidebar).toBe(false);
    expect(defaultSharedSettings.sidebarTranslucency).toBe(true);
    expect(defaultSharedSettings.sidebarGlassTint).toEqual({ light: null, dark: null });
  });

  it("uses the native product typeface while reserving monospace for technical content", () => {
    const styles = read("src/renderer/styles.css");
    const bodyRule = styles.match(/body\s*\{[\s\S]*?font-family:([\s\S]*?);/);

    expect(bodyRule?.[1]).toContain("-apple-system");
    expect(bodyRule?.[1]).toContain("BlinkMacSystemFont");
    expect(bodyRule?.[1]).not.toContain('"Geist"');
    expect(styles).toContain('font-family: "Geist Mono"');
  });

  it("uses the white, warm-neutral, orange default palette", () => {
    const defaultTheme = THEME_SPECS.find((theme) => theme.id === "default");

    expect(defaultTheme?.light).toEqual({
      bg: "#ffffff",
      surface: "#fbfbfa",
      fg: "#181816",
      accent: "#ff5a1f",
      accentText: "#b43f00",
      accentFg: "#181816",
      border: "#eeede9",
      sidebar: "#fbfbfa",
      content: "#ffffff",
    });
    expect(defaultTheme?.dark.accent).toBe("#ff7a45");
  });

  it("separates decorative orange from readable accent text", () => {
    const defaultTheme = APP_THEME_PRESETS.find((theme) => theme.id === "default");

    expect(defaultTheme?.light["--accent"]).toBe("#ff5a1f");
    expect(defaultTheme?.light["--accent-text"]).toBe("#b43f00");
    expect(defaultTheme?.dark["--accent-text"]).toBe("#ff9b73");

    expect(
      contrastRatio(
        defaultTheme?.light["--accent-foreground"] ?? "#000000",
        defaultTheme?.light["--accent"] ?? "#ffffff",
      ),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(
        defaultTheme?.light["--accent"] ?? "#ffffff",
        defaultTheme?.light["--content-background"] ?? "#ffffff",
      ),
    ).toBeGreaterThanOrEqual(3);

    const failures: string[] = [];
    for (const preset of APP_THEME_PRESETS) {
      for (const mode of ["light", "dark"] as const) {
        const variant = preset[mode];
        const accentText = variant["--accent-text"]!;
        for (const surface of [
          "--background",
          "--surface",
          "--sidebar-background",
          "--content-background",
        ] as const) {
          const ratio = contrastRatio(accentText, variant[surface]!);
          if (ratio < 4.5) {
            failures.push(`${preset.id}/${mode}/${surface}: ${ratio.toFixed(2)}`);
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("paints a fresh document light before React mounts", () => {
    const index = read("index.html");

    expect(index).toContain('<html lang="en" class="light" data-theme="light">');
    expect(index).toContain(
      'mode === "system"\n                    ? prefersDark\n                      ? "dark"\n                      : "light"\n                    : "light"',
    );
    expect(index).toContain("themeDefaultVersion");
    expect(index).toContain("bootIsCurrent");
  });

  it("ships orange-on-white stable brand sources without the legacy indigo", () => {
    const stableBrandFiles = [
      "branding/assets/poracode-glyph.svg",
      "branding/assets/poracode-icon.svg",
      "branding/assets/poracode-icon-light.svg",
      "branding/assets/poracode-wordmark.svg",
      "branding/assets/build-icons.mjs",
      "branding/assets/build-native-assets.mjs",
      "branding/assets/build-social-assets.mjs",
      "branding/assets/social/x/avatar.svg",
      "branding/assets/social/x/avatar-tight.svg",
      "branding/assets/social/x/header.svg",
      "branding/BRAND.md",
      "public/app-icon.svg",
      "public/manifest.webmanifest",
    ];
    const sources = stableBrandFiles.map(read);

    for (const source of sources) {
      expect(source.toLowerCase()).not.toContain("#8b7bff");
    }
    expect(read("branding/assets/poracode-icon.svg").toLowerCase()).toContain("#ffffff");
    expect(read("branding/assets/poracode-icon.svg").toLowerCase()).toContain("#ff5a1f");
    expect(read("public/manifest.webmanifest")).toContain('"background_color": "#ffffff"');
    expect(read("public/manifest.webmanifest")).toContain('"theme_color": "#ff5a1f"');
  });

  it("keeps staged icon renders identical to every production copy", () => {
    const destinations = [
      {
        staged: "branding/assets/out/build",
        production: "build",
        files: [
          "icon.png",
          "icon-mac.png",
          "icon.ico",
          "icon.icns",
          "icon-nightly.png",
          "icon-nightly-mac.png",
          "icon-nightly.ico",
          "icon-nightly.icns",
          "tray-icon.ico",
          "tray-icon-dark.ico",
          "tray-icon-nightly.ico",
          "tray-icon-nightly-dark.ico",
          "tray-icon-mac.png",
          "tray-icon-mac@2x.png",
        ],
      },
      {
        staged: "branding/assets/out/pwa",
        production: "public/icons",
        files: [
          "apple-touch-icon.png",
          "apple-touch-icon-nightly.png",
          "icon-192.png",
          "icon-512.png",
          "icon-maskable-512.png",
          "icon-nightly-192.png",
          "icon-nightly-512.png",
          "icon-nightly-maskable-512.png",
        ],
      },
      {
        staged: "branding/assets/out/website",
        production: "website/public",
        files: [
          "favicon-48x48.png",
          "favicon-96x96.png",
          "favicon.ico",
          "icon-192.png",
          "icon-512.png",
          "icon.png",
        ],
      },
    ];

    const mismatches: string[] = [];
    for (const destination of destinations) {
      for (const file of destination.files) {
        const staged = readBytes(`${destination.staged}/${file}`);
        const production = readBytes(`${destination.production}/${file}`);
        if (!staged.equals(production)) mismatches.push(`${destination.production}/${file}`);
      }
    }

    expect(mismatches).toEqual([]);
  });

  it("uses restrained rounded rectangles for primary sidebar navigation", () => {
    const sidebarSources = [
      "src/renderer/components/common/SidebarButton.tsx",
      "src/renderer/views/MainView/parts/Sidebar/parts/NewThreadButton.tsx",
    ].map(read);

    for (const source of sidebarSources) {
      expect(source).toContain("rounded-lg");
      expect(source).not.toContain("rounded-3xl");
    }
  });

  it("consolidates secondary sidebar destinations into one More menu", () => {
    const footer = read("src/renderer/views/MainView/parts/Sidebar/parts/SidebarFooterNav.tsx");

    expect(footer).toContain("SidebarFooterMenu");
    expect(footer).toContain("aria-label={t`More`}");
    expect(footer).not.toContain("SidebarWorkspaceSwitcher");
    expect(footer).not.toContain("UpdateButtons");
    expect(footer).not.toContain("WhatsNewButton");
  });

  it("keeps first-run onboarding quiet and free of developer decoration", () => {
    const welcome = read("src/renderer/views/WelcomeOverlay.tsx");

    expect(welcome).not.toContain("WELCOME_BACKGROUND_CODE");
    expect(welcome).not.toContain("poracode-welcome-code-wall");
    expect(welcome).not.toContain("poracode-welcome-comet");
    expect(welcome).not.toContain("onMouseMove");
    expect(welcome).toContain('variant="primary"');
    expect(welcome).toContain('variant="secondary"');
  });
});
