import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

export function installCookieImportExtension(input: {
  sourceDir: string;
  baseDir: string;
}): string {
  const manifest = join(input.sourceDir, "manifest.json");
  if (!existsSync(manifest)) throw new Error("Y Space Cookie Import source is missing.");
  const extensionsDir = join(input.baseDir, "extensions");
  const destination = join(extensionsDir, "y-space-cookie-import");
  const staging = join(extensionsDir, ".y-space-cookie-import.staging");
  const backup = join(extensionsDir, ".y-space-cookie-import.backup");
  mkdirSync(extensionsDir, { recursive: true });
  if (!existsSync(destination) && existsSync(backup)) renameSync(backup, destination);
  rmSync(staging, { recursive: true, force: true });
  cpSync(input.sourceDir, staging, { recursive: true, force: true });
  if (!existsSync(join(staging, "manifest.json"))) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error("Y Space Cookie Import could not be staged.");
  }
  rmSync(backup, { recursive: true, force: true });
  if (existsSync(destination)) renameSync(destination, backup);
  try {
    renameSync(staging, destination);
  } catch (error) {
    if (!existsSync(destination) && existsSync(backup)) renameSync(backup, destination);
    throw error;
  }
  rmSync(backup, { recursive: true, force: true });
  if (!existsSync(join(destination, "manifest.json"))) {
    throw new Error("Y Space Cookie Import could not be installed.");
  }
  return destination;
}
