import { describe, expect, it } from "vitest";
import {
  CONTENT_MIN_WIDTH,
  GLOBAL_WORKSPACE_WIDTH_STORAGE_KEY,
  resolveInitialRightPanelWidth,
} from "./useResizablePanels";

describe("right workspace equal split sizing", () => {
  it.each([
    [1_280, 640],
    [1_920, 960],
    [500, 320],
    [3_000, 1_100],
  ])("starts at half of a %dpx window, clamped to safe bounds", (viewportWidth, expected) => {
    expect(resolveInitialRightPanelWidth(viewportWidth)).toBe(expected);
  });

  it("lets the chat remain usable while a right workspace reaches half of a desktop window", () => {
    expect(CONTENT_MIN_WIDTH).toBeLessThanOrEqual(360);
  });

  it("uses a versioned persistence key for the visible global workspace slot", () => {
    expect(GLOBAL_WORKSPACE_WIDTH_STORAGE_KEY).toBe("poracode-git-panel-width-v2");
  });
});
