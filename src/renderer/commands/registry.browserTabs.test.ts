// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildCommandRegistry } from "./registry";

const bridge = vi.hoisted(() => ({
  browserCreateTab: vi.fn<(payload: { url?: string; activate?: boolean }) => Promise<unknown>>(),
}));

vi.mock("@/renderer/bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/renderer/bridge")>()),
  readBridge: () => bridge,
}));

describe("browser tab commands", () => {
  beforeEach(() => {
    bridge.browserCreateTab.mockReset().mockResolvedValue(undefined);
  });

  it("opens the shared embedded-browser home page", () => {
    const command = buildCommandRegistry().find((candidate) => candidate.id === "browser.tab.new");

    void command?.run();

    expect(bridge.browserCreateTab).toHaveBeenCalledWith({
      url: "https://duckduckgo.com",
      activate: true,
    });
  });
});
