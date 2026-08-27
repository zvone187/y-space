import { describe, expect, it } from "vitest";
import { buildBrowserUserAgent } from "./userAgent";

describe("buildBrowserUserAgent", () => {
  it("removes the Electron product token", () => {
    expect(
      buildBrowserUserAgent(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Electron/41.7.0 Safari/537.36",
      ),
    ).toBe(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
    );
  });

  it("rebrands the legacy packaged app token before Chrome without changing the crypto identity timing", () => {
    expect(
      buildBrowserUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Lightcode/1.6.6 Chrome/146.0.0.0 Electron/41.7.0 Safari/537.36",
        {
          currentProductName: "Lightcode",
          brandedProductName: "Y Space",
          appVersion: "1.6.6",
        },
      ),
    ).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Y Space/1.6.6 Chrome/146.0.0.0 Safari/537.36",
    );
  });

  it("rebrands a channel-suffixed packaged app token", () => {
    expect(
      buildBrowserUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Lightcode Nightly/1.6.6 Chrome/146.0.0.0 Electron/41.7.0 Safari/537.36",
        {
          currentProductName: "Lightcode Nightly",
          brandedProductName: "Y Space Nightly",
          appVersion: "1.6.6",
        },
      ),
    ).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Y Space Nightly/1.6.6 Chrome/146.0.0.0 Safari/537.36",
    );
  });
});
