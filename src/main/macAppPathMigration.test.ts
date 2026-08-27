import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { repairLegacyMacAppPath } from "./macAppPathMigration";

describe("repairLegacyMacAppPath", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "poracode-mac-app-path-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function packagedExecutable(appName: string): string {
    const executablePath = join(root, appName, "Contents", "MacOS", appName.replace(/\.app$/u, ""));
    mkdirSync(join(root, appName, "Contents", "MacOS"), { recursive: true });
    writeFileSync(executablePath, "executable");
    return executablePath;
  }

  it("restores both legacy Nightly paths as relative symlinks", () => {
    const executablePath = packagedExecutable("Y Space Nightly.app");

    expect(
      repairLegacyMacAppPath("nightly", {
        platform: "darwin",
        isPackaged: true,
        executablePath,
      }),
    ).toBe("created");

    for (const legacyName of ["Poracode Nightly.app", "Lightcode Nightly.app"]) {
      const legacyPath = join(root, legacyName);
      expect(lstatSync(legacyPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(legacyPath)).toBe("Y Space Nightly.app");
    }
  });

  it("restores both legacy Stable paths", () => {
    const executablePath = packagedExecutable("Y Space.app");

    expect(
      repairLegacyMacAppPath("stable", {
        platform: "darwin",
        isPackaged: true,
        executablePath,
      }),
    ).toBe("created");
    expect(readlinkSync(join(root, "Poracode.app"))).toBe("Y Space.app");
    expect(readlinkSync(join(root, "Lightcode.app"))).toBe("Y Space.app");
  });

  it("never replaces an existing legacy app", () => {
    const executablePath = packagedExecutable("Y Space Nightly.app");
    const legacyPath = join(root, "Poracode Nightly.app");
    mkdirSync(legacyPath);

    expect(
      repairLegacyMacAppPath("nightly", {
        platform: "darwin",
        isPackaged: true,
        executablePath,
      }),
    ).toBe("created");
    expect(lstatSync(legacyPath).isDirectory()).toBe(true);
    expect(readlinkSync(join(root, "Lightcode Nightly.app"))).toBe("Y Space Nightly.app");
  });

  it("skips unpackaged, non-macOS, and unexpectedly named bundles", () => {
    const executablePath = packagedExecutable("Y Space Nightly.app");
    const otherExecutablePath = packagedExecutable("Renamed.app");

    expect(
      repairLegacyMacAppPath("nightly", {
        platform: "linux",
        isPackaged: true,
        executablePath,
      }),
    ).toBe("skipped");
    expect(
      repairLegacyMacAppPath("nightly", {
        platform: "darwin",
        isPackaged: false,
        executablePath,
      }),
    ).toBe("skipped");
    expect(
      repairLegacyMacAppPath("nightly", {
        platform: "darwin",
        isPackaged: true,
        executablePath: otherExecutablePath,
      }),
    ).toBe("skipped");
  });
});
