import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installCookieImportExtension } from "./extensionInstall";

describe("installCookieImportExtension", () => {
  it("copies the packaged extension into a stable user-data folder", () => {
    const root = mkdtempSync(join(tmpdir(), "y-space-cookie-extension-"));
    const source = join(root, "source");
    const baseDir = join(root, "profile");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "manifest.json"), '{"version":"1.2.3"}');
    writeFileSync(join(source, "background.js"), "// extension");

    const installed = installCookieImportExtension({ sourceDir: source, baseDir });

    expect(installed).toBe(join(baseDir, "extensions", "y-space-cookie-import"));
    expect(readFileSync(join(installed, "manifest.json"), "utf8")).toContain("1.2.3");

    writeFileSync(join(installed, "removed-in-next-release.js"), "legacy");
    const installedAgain = installCookieImportExtension({ sourceDir: source, baseDir });
    expect(installedAgain).toBe(installed);
    expect(existsSync(join(installedAgain, "removed-in-next-release.js"))).toBe(false);
  });
});
