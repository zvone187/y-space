import { describe, expect, it } from "vitest";
import { decideNativeWindowMaterial } from "./windowMaterial";

describe("decideNativeWindowMaterial", () => {
  it.each([
    {
      name: "enabled macOS",
      input: {
        platform: "darwin" as const,
        release: "25.2.0",
        requested: true,
        reducedTransparency: false,
      },
      expected: {
        supported: true,
        active: true,
        macVibrancy: "sidebar",
        windowsMaterial: "none",
      },
    },
    {
      name: "disabled macOS",
      input: {
        platform: "darwin" as const,
        release: "25.2.0",
        requested: false,
        reducedTransparency: false,
      },
      expected: {
        supported: true,
        active: false,
        macVibrancy: null,
        windowsMaterial: "none",
      },
    },
    {
      name: "reduced-transparency macOS",
      input: {
        platform: "darwin" as const,
        release: "25.2.0",
        requested: true,
        reducedTransparency: true,
      },
      expected: {
        supported: true,
        active: false,
        macVibrancy: null,
        windowsMaterial: "none",
      },
    },
    {
      name: "supported Windows acrylic",
      input: {
        platform: "win32" as const,
        release: "10.0.22621",
        requested: true,
        reducedTransparency: false,
      },
      expected: {
        supported: true,
        active: true,
        macVibrancy: null,
        windowsMaterial: "acrylic",
      },
    },
    {
      name: "older Windows",
      input: {
        platform: "win32" as const,
        release: "10.0.19045",
        requested: true,
        reducedTransparency: false,
      },
      expected: {
        supported: false,
        active: false,
        macVibrancy: null,
        windowsMaterial: "none",
      },
    },
    {
      name: "Linux fallback",
      input: {
        platform: "linux" as const,
        release: "6.8.0",
        requested: true,
        reducedTransparency: false,
      },
      expected: {
        supported: false,
        active: false,
        macVibrancy: null,
        windowsMaterial: "none",
      },
    },
  ])("resolves $name", ({ input, expected }) => {
    expect(decideNativeWindowMaterial(input)).toEqual(expected);
  });
});
