import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  appIdFor,
  artifactPrefixFor,
  PORACODE_CHANNELS,
  productNameFor,
  updaterChannelFor,
  userDataDirNameFor,
} from "./channel";

const requireFromHere = createRequire(import.meta.url);
const cjs = requireFromHere("../../scripts/electron-builder.shared.cjs") as {
  CHANNELS: readonly string[];
  githubPublishOwner: string;
  githubPublishRepo: string;
  normalizeChannel: (v: unknown) => string;
  productNameFor: (channel: string) => string;
  appIdFor: (channel: string) => string;
  userDataDirNameFor: (channel: string) => string;
  updaterChannelFor: (channel: string) => string | undefined;
  artifactPrefixFor: (channel: string) => string;
  macExecutableNameFor: (channel: string, artifactKind: "branded" | "updater") => string;
};

describe("electron-builder.shared.cjs mirrors src/shared/channel.ts", () => {
  it("exposes the same channel list", () => {
    expect([...cjs.CHANNELS]).toEqual([...PORACODE_CHANNELS]);
  });

  for (const channel of PORACODE_CHANNELS) {
    it(`agrees on every value for "${channel}"`, () => {
      expect(cjs.productNameFor(channel)).toBe(productNameFor(channel));
      expect(cjs.appIdFor(channel)).toBe(appIdFor(channel));
      expect(cjs.userDataDirNameFor(channel)).toBe(userDataDirNameFor(channel));
      expect(cjs.updaterChannelFor(channel)).toBe(updaterChannelFor(channel));
      expect(cjs.artifactPrefixFor(channel)).toBe(artifactPrefixFor(channel));
    });
  }

  it("normalizes any unknown value to stable", () => {
    expect(cjs.normalizeChannel("nightly")).toBe("nightly");
    expect(cjs.normalizeChannel("stable")).toBe("stable");
    expect(cjs.normalizeChannel(undefined)).toBe("stable");
    expect(cjs.normalizeChannel("beta")).toBe("stable");
  });

  it("keeps macOS updater ZIPs on the legacy technical executable name", () => {
    expect(cjs.macExecutableNameFor("stable", "updater")).toBe("Lightcode");
    expect(cjs.macExecutableNameFor("nightly", "updater")).toBe("Lightcode Nightly");
    expect(cjs.macExecutableNameFor("stable", "branded")).toBe("Y Space");
    expect(cjs.macExecutableNameFor("nightly", "branded")).toBe("Y Space Nightly");
  });

  it("publishes updates and release artifacts only under the Y Space fork", () => {
    expect(cjs.githubPublishOwner).toBe("zvone187");
    expect(cjs.githubPublishRepo).toBe("y-space");

    const builder = readFileSync(
      new URL("../../scripts/build-desktop-artifact.mjs", import.meta.url),
      "utf8",
    );
    expect(builder).toContain("owner: ${channelTable.githubPublishOwner}");
    expect(builder).toContain("repo: ${channelTable.githubPublishRepo}${publishChannelLine}");
    expect(builder).not.toContain("owner: SDSLeon");

    const buildWorkflow = readFileSync(
      new URL("../../.github/workflows/_build.yml", import.meta.url),
      "utf8",
    );
    expect(buildWorkflow).toContain("apps=(release/mac*/Y\\ Space*.app)");
    for (const extension of ["exe", "dmg", "zip", "AppImage", "deb"]) {
      expect(buildWorkflow).toContain(`release/Y-Space-*.${extension}`);
    }
    expect(buildWorkflow).not.toContain("release/Poracode-");

    const stableWorkflow = readFileSync(
      new URL("../../.github/workflows/release.yml", import.meta.url),
      "utf8",
    );
    expect(stableWorkflow).toContain("name: Y Space ${{ needs.prepare.outputs.tag }}");
    expect(stableWorkflow).not.toContain("name: Poracode ");

    const nightlyWorkflow = readFileSync(
      new URL("../../.github/workflows/release-nightly.yml", import.meta.url),
      "utf8",
    );
    expect(nightlyWorkflow).toContain("name: Y Space Nightly ${{ needs.prepare.outputs.tag }}");
    expect(nightlyWorkflow).not.toContain("name: Poracode Nightly ");

    const extensionWorkflow = readFileSync(
      new URL("../../.github/workflows/release-chrome-extension.yml", import.meta.url),
      "utf8",
    );
    expect(extensionWorkflow).toContain("y-space-cookie-import-v${version}.zip");
    expect(extensionWorkflow).toContain(
      "name: Y Space Cookie Import ${{ needs.prepare.outputs.tag }}",
    );
    expect(extensionWorkflow).not.toContain("poracode-chrome-extension");
    expect(extensionWorkflow).not.toContain("Poracode Chrome Extension");

    const mobileWorkflow = readFileSync(
      new URL("../../.github/workflows/release-mobile.yml", import.meta.url),
      "utf8",
    );
    expect(mobileWorkflow).toContain("name: y-space-android-");
    expect(mobileWorkflow).toContain("name: y-space-ios-");
    expect(mobileWorkflow).not.toMatch(/name: poracode-(?:android|ios)-/u);
  });
});
