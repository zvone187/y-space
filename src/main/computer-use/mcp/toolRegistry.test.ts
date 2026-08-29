import { describe, expect, it, vi } from "vitest";
import type { ComputerUseDriver } from "./types";
import { dispatchTool, isInteractiveToolName, TOOLS } from "./toolRegistry";

function createDriver(overrides: Partial<ComputerUseDriver> = {}): ComputerUseDriver {
  const driver: ComputerUseDriver = {
    activateWindow: vi.fn<ComputerUseDriver["activateWindow"]>(),
    click: vi.fn<ComputerUseDriver["click"]>(),
    dispose: vi.fn<ComputerUseDriver["dispose"]>(),
    drag: vi.fn<ComputerUseDriver["drag"]>(),
    getWindow: vi.fn<ComputerUseDriver["getWindow"]>(),
    getWindowState: vi.fn<ComputerUseDriver["getWindowState"]>(),
    launchApp: vi.fn<ComputerUseDriver["launchApp"]>(),
    listApps: vi.fn<ComputerUseDriver["listApps"]>(),
    listWindows: vi.fn<ComputerUseDriver["listWindows"]>(),
    pressKey: vi.fn<ComputerUseDriver["pressKey"]>(),
    scroll: vi.fn<ComputerUseDriver["scroll"]>(),
    typeText: vi.fn<ComputerUseDriver["typeText"]>(),
    ...overrides,
  };
  return driver;
}

describe("computer-use toolRegistry", () => {
  it("does not advertise unsupported accessibility action tools", () => {
    expect(TOOLS.map((tool) => tool.name)).not.toContain("set_value");
    expect(TOOLS.map((tool) => tool.name)).not.toContain("perform_secondary_action");
  });

  it("distinguishes takeover tools from passive inspection", () => {
    expect(isInteractiveToolName("click")).toBe(true);
    expect(isInteractiveToolName("type")).toBe(true);
    expect(isInteractiveToolName("get_window_state")).toBe(false);
    expect(isInteractiveToolName("list_windows")).toBe(false);
    expect(TOOLS.find((tool) => tool.name === "get_window_state")?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(TOOLS.find((tool) => tool.name === "click")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
  });

  it("preserves the refreshed window returned by interactive driver actions", async () => {
    const inputWindow = { app: "calc", id: 1 };
    const refreshedWindow = { app: "calc", id: 2, title: "Calculator" };
    const driver = createDriver({
      click: vi.fn<ComputerUseDriver["click"]>().mockResolvedValue({
        ok: true,
        mode: "interactive",
        window: refreshedWindow,
      }),
    });

    await expect(
      dispatchTool("click", { window: inputWindow, x: 10, y: 20 }, { driver }),
    ).resolves.toEqual({
      ok: true,
      mode: "interactive",
      window: refreshedWindow,
    });
    expect(driver.click).toHaveBeenCalledWith({ window: inputWindow, x: 10, y: 20 });
  });

  it("rejects malformed click options instead of silently left-clicking", async () => {
    const driver = createDriver();
    const window = { app: "calc", id: 1 };

    await expect(
      dispatchTool("click", { window, x: 10, y: 20, mouse_button: "primary" }, { driver }),
    ).rejects.toThrow("mouse_button must be left, right, or middle");
    await expect(
      dispatchTool("click", { window, x: 10, y: 20, click_count: 100 }, { driver }),
    ).rejects.toThrow("click_count must be 1 or 2");
    expect(driver.click).not.toHaveBeenCalled();
  });

  it.each([
    ["launch_app", { app: "Google Chrome" }, "launchApp"],
    ["activate_window", { window: { app: "Safari", id: 1 } }, "activateWindow"],
    ["click", { window: { app: "Brave Browser", id: 2 }, x: 10, y: 20 }, "click"],
    ["click", { window: { app: "Y Space", id: 3 }, x: 10, y: 20 }, "click"],
  ] as const)(
    "rejects %s for a native browser while managed Y Space Browser is connected",
    async (tool, args, driverMethod) => {
      const driver = createDriver();

      await expect(
        dispatchTool(tool, args, { driver, managedBrowserConnected: true }),
      ).rejects.toThrow(/Y Space Browser/iu);
      expect(driver[driverMethod]).not.toHaveBeenCalled();
    },
  );

  it.each([
    "https://example.test",
    "http://localhost:3000",
    "file:///tmp/browser-bypass.html",
    "ftp://example.test/browser-bypass.html",
    "about:blank",
    "data:text/html,<h1>browser bypass</h1>",
    "/tmp/page.html",
    "C:\\tmp\\page.html",
    "/tmp/page.HTM?preview=1#section",
    "C:\\tmp\\page.XHTML#section",
    "/tmp/page.mhtml",
    "C:\\tmp\\page.WEBARCHIVE?preview=1",
    "/usr/bin/google-chrome",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "/Applications/Safari.app",
  ])("rejects browser-capable launch_app input %s before calling the driver", async (app) => {
    const driver = createDriver();

    await expect(
      dispatchTool("launch_app", { app }, { driver, managedBrowserConnected: true }),
    ).rejects.toThrow(/Y Space Browser/iu);
    expect(driver.launchApp).not.toHaveBeenCalled();
  });

  it.each(["/Applications/Calculator.app", "C:\\Windows\\System32\\notepad.exe"])(
    "allows explicit non-browser app path %s under browser exclusivity",
    async (app) => {
      const launchApp = vi.fn<ComputerUseDriver["launchApp"]>().mockResolvedValue({ ok: true });
      const driver = createDriver({ launchApp });

      await expect(
        dispatchTool("launch_app", { app }, { driver, managedBrowserConnected: true }),
      ).resolves.toEqual({ ok: true });
      expect(launchApp).toHaveBeenCalledWith({ app });
    },
  );

  it("preserves non-browser Computer Use control under browser exclusivity", async () => {
    const driver = createDriver({
      launchApp: vi.fn<ComputerUseDriver["launchApp"]>().mockResolvedValue({ ok: true }),
      click: vi.fn<ComputerUseDriver["click"]>().mockResolvedValue({
        ok: true,
        mode: "interactive",
      }),
    });
    const ctx = { driver, managedBrowserConnected: true };

    await expect(dispatchTool("launch_app", { app: "Calculator" }, ctx)).resolves.toEqual({
      ok: true,
    });
    await expect(
      dispatchTool("click", { window: { app: "Calculator", id: 1 }, x: 10, y: 20 }, ctx),
    ).resolves.toMatchObject({ ok: true });
  });

  it("hides external browsers and the Y Space host window from passive listings", async () => {
    const driver = createDriver({
      listApps: vi.fn<ComputerUseDriver["listApps"]>().mockResolvedValue([
        {
          id: "com.google.Chrome",
          displayName: "Google Chrome",
          windows: [{ app: "Google Chrome", id: 1 }],
        },
        {
          id: "calculator",
          displayName: "Calculator",
          windows: [
            { app: "Calculator", id: 2 },
            { app: "Y Space", id: 3 },
          ],
        },
      ]),
      listWindows: vi.fn<ComputerUseDriver["listWindows"]>().mockResolvedValue([
        { app: "Safari", id: 4 },
        { app: "Y Space", id: 5 },
        { app: "Calculator", id: 6 },
      ]),
    });
    const ctx = { driver, managedBrowserConnected: true };

    await expect(dispatchTool("list_apps", {}, ctx)).resolves.toEqual([
      {
        id: "calculator",
        displayName: "Calculator",
        windows: [{ app: "Calculator", id: 2 }],
      },
    ]);
    await expect(dispatchTool("list_windows", {}, ctx)).resolves.toEqual([
      { app: "Calculator", id: 6 },
    ]);
  });

  it("post-validates an id-only get_window result", async () => {
    const driver = createDriver({
      getWindow: vi.fn<ComputerUseDriver["getWindow"]>().mockResolvedValue({
        app: "Microsoft Edge",
        id: 7,
      }),
    });

    await expect(
      dispatchTool("get_window", { id: 7 }, { driver, managedBrowserConnected: true }),
    ).rejects.toThrow(/Y Space Browser/iu);
  });
});
