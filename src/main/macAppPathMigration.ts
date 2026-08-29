import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync, symlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { PoracodeChannel } from "@/shared/channel";

interface MacAppPathMigrationOptions {
  platform?: NodeJS.Platform;
  isPackaged?: boolean;
  executablePath?: string;
  dockPreferencesXml?: string | null;
}

type MacAppPathMigrationResult = "created" | "skipped" | "failed";

function appNamesFor(channel: PoracodeChannel): { current: string; legacy: string[] } {
  return channel === "nightly"
    ? {
        current: "Y Space Nightly.app",
        legacy: ["Poracode Nightly.app", "Lightcode Nightly.app"],
      }
    : { current: "Y Space.app", legacy: ["Poracode.app", "Lightcode.app"] };
}

function bundlePathFromExecutable(executablePath: string): string {
  return dirname(dirname(dirname(executablePath)));
}

function readDockPreferences(): string | null {
  try {
    return execFileSync("/usr/bin/defaults", ["export", "com.apple.dock", "-"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function dockReferencesApp(dockPreferencesXml: string, appName: string): boolean {
  return (
    dockPreferencesXml.includes(`/${appName}/`) ||
    dockPreferencesXml.includes(`/${encodeURIComponent(appName)}/`)
  );
}

/**
 * Keep a proven pre-rebrand Dock path usable after Squirrel renames the
 * installed bundle. Fresh installs must not create legacy-branded aliases.
 *
 * The relative symlink is deliberately best-effort and never replaces an
 * existing file. Squirrel resolves the running application's canonical path
 * before preparing later updates, so installs continue targeting Y Space.
 */
export function repairLegacyMacAppPath(
  channel: PoracodeChannel,
  options: MacAppPathMigrationOptions = {},
): MacAppPathMigrationResult {
  const platform = options.platform ?? process.platform;
  const isPackaged = options.isPackaged ?? false;
  if (platform !== "darwin" || !isPackaged) return "skipped";

  try {
    const executablePath = realpathSync(options.executablePath ?? process.execPath);
    const currentBundlePath = bundlePathFromExecutable(executablePath);
    const names = appNamesFor(channel);
    if (basename(currentBundlePath) !== names.current) return "skipped";

    const dockPreferencesXml = options.dockPreferencesXml ?? readDockPreferences();
    if (!dockPreferencesXml) return "skipped";

    let created = false;
    for (const legacyName of names.legacy) {
      if (!dockReferencesApp(dockPreferencesXml, legacyName)) continue;
      const legacyBundlePath = join(dirname(currentBundlePath), legacyName);
      try {
        lstatSync(legacyBundlePath);
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }

      symlinkSync(names.current, legacyBundlePath, "dir");
      created = true;
      console.info(`[poracode] restored legacy macOS app path at ${legacyBundlePath}`);
    }
    return created ? "created" : "skipped";
  } catch (error) {
    // The app remains launchable from its canonical Y Space path if the
    // install directory is read-only or a filesystem policy rejects symlinks.
    console.warn("[poracode] failed to restore legacy macOS app path", error);
    return "failed";
  }
}
