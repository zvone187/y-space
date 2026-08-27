import { describe, expect, it, vi } from "vitest";
import { PipedreamMainService } from "./PipedreamMainService";

describe("PipedreamMainService", () => {
  it("opens the one-use link only in the embedded browser and returns a renderer-safe acknowledgement", async () => {
    const privateLink =
      "https://pipedream.com/_static/connect.html?token=connect-token-private&connectLink=true&app=slack";
    const openConnectUrl = vi.fn<(url: string) => Promise<void>>(async () => undefined);
    const service = new PipedreamMainService({
      createConnectLink: vi.fn<
        (appSlug: string) => Promise<{ connectLinkUrl: string; expiresAt: string }>
      >(async () => ({
        connectLinkUrl: privateLink,
        expiresAt: "2026-08-27T12:10:00.000Z",
      })),
      openConnectUrl,
    });

    const result = await service.beginConnect({ appSlug: "slack" });

    expect(openConnectUrl).toHaveBeenCalledExactlyOnceWith(privateLink);
    expect(result).toEqual({ opened: true, expiresAt: "2026-08-27T12:10:00.000Z" });
    expect(JSON.stringify(result)).not.toMatch(/connect-token-private|connectLinkUrl|token=/i);
  });

  it("rejects any non-Pipedream or non-app-scoped link before opening it", async () => {
    const openConnectUrl = vi.fn<(url: string) => Promise<void>>(async () => undefined);
    const service = new PipedreamMainService({
      createConnectLink: async () => ({
        connectLinkUrl: "https://attacker.invalid/connect?token=private",
        expiresAt: "2026-08-27T12:10:00.000Z",
      }),
      openConnectUrl,
    });

    await expect(service.beginConnect({ appSlug: "slack" })).rejects.toThrow(/invalid/i);
    expect(openConnectUrl).not.toHaveBeenCalled();
  });
});
