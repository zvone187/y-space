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

describe("sidebar glass tint", () => {
  beforeEach(() => {
    platform.mac = true;
    platform.windows = false;
    document.documentElement.style.removeProperty("--sidebar-glass-tint");
  });

  it("keeps the macOS material frosted behind a contrast-safe theme scrim", () => {
    expect(sidebarGlassTintDefault("light")).toBe(98);
    expect(sidebarGlassTintDefault("dark")).toBe(82);
    expect(sidebarGlassTintMinimum("light")).toBe(98);
    expect(sidebarGlassTintMinimum("dark")).toBe(80);
    expect(sidebarGlassTintExpr(98)).toBe(
      "color-mix(in oklab, var(--content-background) 98%, transparent)",
    );
  });

  it("uses denser defaults for Windows acrylic", () => {
    platform.mac = false;
    platform.windows = true;

    expect(sidebarGlassTintDefault("light")).toBe(98);
    expect(sidebarGlassTintDefault("dark")).toBe(88);
  });

  it("applies an enabled native override and clears every fallback state", () => {
    const root = document.documentElement;

    applySidebarGlassTint(root, 82, true, "light");
    expect(root.style.getPropertyValue("--sidebar-glass-tint")).toContain("98%");

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
