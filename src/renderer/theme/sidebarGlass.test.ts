import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ mac: true, windows: false }));

vi.mock("@/renderer/bridge", () => ({
  isMac: () => platform.mac,
  isWindows: () => platform.windows,
}));

import {
  applySidebarGlassTint,
  sidebarGlassTintDefault,
  sidebarGlassTintExpr,
  sidebarGlassTintMinimum,
} from "./sidebarGlass";

const styles = readFileSync(join(process.cwd(), "src/renderer/styles.css"), "utf8");

describe("sidebar glass tint", () => {
  beforeEach(() => {
    platform.mac = true;
    platform.windows = false;
    document.documentElement.style.removeProperty("--sidebar-glass-tint");
  });

  it("keeps the macOS material visibly frosted behind a contrast-safe theme scrim", () => {
    expect(sidebarGlassTintDefault("light")).toBe(64);
    expect(sidebarGlassTintDefault("dark")).toBe(70);
    expect(sidebarGlassTintMinimum("light")).toBe(60);
    expect(sidebarGlassTintMinimum("dark")).toBe(68);
    expect(sidebarGlassTintExpr(64)).toBe(
      "color-mix(in oklab, var(--content-background) 64%, transparent)",
    );
  });

  it("uses denser defaults for Windows acrylic", () => {
    platform.mac = false;
    platform.windows = true;

    expect(sidebarGlassTintDefault("light")).toBe(78);
    expect(sidebarGlassTintDefault("dark")).toBe(76);
    expect(sidebarGlassTintMinimum("light")).toBe(74);
    expect(sidebarGlassTintMinimum("dark")).toBe(72);
  });

  it("keeps the CSS material defaults synchronized with the slider defaults", () => {
    expect(styles).toContain(
      `--sidebar-glass-tint: ${sidebarGlassTintExpr(sidebarGlassTintDefault("light"))};`,
    );
    expect(styles).toContain(
      `--sidebar-glass-tint: ${sidebarGlassTintExpr(sidebarGlassTintDefault("dark"))};`,
    );

    platform.mac = false;
    platform.windows = true;
    expect(styles).toContain(
      `--sidebar-glass-tint: ${sidebarGlassTintExpr(sidebarGlassTintDefault("light"))};`,
    );
    expect(styles).toContain(
      `--sidebar-glass-tint: ${sidebarGlassTintExpr(sidebarGlassTintDefault("dark"))};`,
    );
  });

  it("applies an enabled native override and clears every fallback state", () => {
    const root = document.documentElement;

    applySidebarGlassTint(root, 82, true, "light");
    expect(root.style.getPropertyValue("--sidebar-glass-tint")).toContain("82%");

    applySidebarGlassTint(root, null, true, "light");
    expect(root.style.getPropertyValue("--sidebar-glass-tint")).toBe("");

    applySidebarGlassTint(root, 82, false, "light");
    expect(root.style.getPropertyValue("--sidebar-glass-tint")).toBe("");

    platform.mac = false;
    platform.windows = false;
    applySidebarGlassTint(root, 82, true, "dark");
    expect(root.style.getPropertyValue("--sidebar-glass-tint")).toBe("");
  });
});
