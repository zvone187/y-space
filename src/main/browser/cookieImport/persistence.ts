import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "@/shared/atomicFile";
import { CookieImportPairingStore } from "./CookieImportPairingStore";

const COOKIE_IMPORT_PAIRINGS_FILE = "browser-cookie-import-pairings.json";

interface CookieImportPairingPersistenceOverrides {
  writeState?(path: string, serialized: string): void;
  purgeState?(path: string): void;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}

export function createFileBackedCookieImportPairingStore(
  baseDir: string,
  overrides: CookieImportPairingPersistenceOverrides = {},
): CookieImportPairingStore {
  const path = join(baseDir, COOKIE_IMPORT_PAIRINGS_FILE);
  return new CookieImportPairingStore({
    load: () => {
      try {
        return JSON.parse(readFileSync(path, "utf8")) as unknown;
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) return undefined;
        if (error instanceof SyntaxError) return undefined;
        throw new Error("Unable to read browser-cookie pairings.", { cause: error });
      }
    },
    save: (state) => {
      const serialized = `${JSON.stringify(state, null, 2)}\n`;
      if (overrides.writeState) overrides.writeState(path, serialized);
      else writeFileAtomic(path, serialized, { encoding: "utf8", mode: 0o600 });
    },
    purge: () => {
      if (overrides.purgeState) overrides.purgeState(path);
      else rmSync(path, { force: true });
    },
  });
}
