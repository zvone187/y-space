import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileBackedCookieImportPairingStore } from "./persistence";

describe("browser cookie-import pairing persistence", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories) {
      rmSync(directory, { force: true, recursive: true });
    }
    temporaryDirectories.length = 0;
  });

  it("starts unpaired when the optional pairing file contains malformed JSON", () => {
    const directory = mkdtempSync(join(tmpdir(), "y-space-cookie-pairings-"));
    temporaryDirectories.push(directory);
    writeFileSync(join(directory, "browser-cookie-import-pairings.json"), "{not-json", {
      encoding: "utf8",
      mode: 0o600,
    });

    const store = createFileBackedCookieImportPairingStore(directory);

    expect(store.listSources()).toEqual([]);
  });

  it("purges the whole pairing file when a revocation rewrite fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "y-space-cookie-pairings-"));
    temporaryDirectories.push(directory);
    const pairingPath = join(directory, "browser-cookie-import-pairings.json");
    const sourceId = "11111111-1111-4111-8111-111111111111";
    writeFileSync(
      pairingPath,
      JSON.stringify({
        version: 1,
        sources: [
          {
            sourceId,
            label: "Chrome profile",
            browserFamily: "chrome",
            extensionVersion: "1.0.0",
            pairedAt: 1,
            tokenHash: "a".repeat(64),
          },
        ],
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    const store = createFileBackedCookieImportPairingStore(directory, {
      writeState: () => {
        throw new Error("simulated rewrite failure");
      },
    });

    expect(() => store.forgetSource(sourceId)).not.toThrow();
    expect(existsSync(pairingPath)).toBe(false);
    expect(createFileBackedCookieImportPairingStore(directory).listSources()).toEqual([]);
  });
});
