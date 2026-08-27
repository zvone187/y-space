import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "@/shared/atomicFile";
import { CookieImportPairingStore } from "./CookieImportPairingStore";

const COOKIE_IMPORT_PAIRINGS_FILE = "browser-cookie-import-pairings.json";

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}

export function createFileBackedCookieImportPairingStore(
  baseDir: string,
): CookieImportPairingStore {
  const path = join(baseDir, COOKIE_IMPORT_PAIRINGS_FILE);
  return new CookieImportPairingStore({
    load: () => {
      try {
        return JSON.parse(readFileSync(path, "utf8")) as unknown;
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) return undefined;
        throw new Error("Unable to read browser-cookie pairings.", { cause: error });
      }
    },
    save: (state) => {
      writeFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    },
  });
}
