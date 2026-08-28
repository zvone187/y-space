import { describe, expect, it } from "vitest";
import { buildApplicationMenuTemplate } from "./applicationMenu";

describe("buildApplicationMenuTemplate", () => {
  it("brands the macOS application menu without changing the technical bundle identity", () => {
    const template = buildApplicationMenuTemplate("Y Space", "darwin");

    expect(template?.[0]).toMatchObject({
      label: "Y Space",
      submenu: expect.arrayContaining([
        expect.objectContaining({ label: "About Y Space", role: "about" }),
        expect.objectContaining({ label: "Hide Y Space", role: "hide" }),
        expect.objectContaining({ label: "Quit Y Space", role: "quit" }),
      ]),
    });
  });

  it("keeps non-macOS application menus disabled", () => {
    expect(buildApplicationMenuTemplate("Y Space", "linux")).toBeNull();
    expect(buildApplicationMenuTemplate("Y Space", "win32")).toBeNull();
  });
});
