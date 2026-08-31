import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptChromiumCookieValue, LocalBrowserCookieReader } from "./localBrowserProfiles";

const temporaryDirectories: string[] = [];
const nodeNativeBinding = join(process.cwd(), "dist", "server-native", "better_sqlite3.node");

function temporaryHome(): string {
  const directory = mkdtempSync(join(tmpdir(), "y-space-local-browser-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createFirefoxCookieDatabase(home: string): string {
  const profile = join(
    home,
    "Library",
    "Application Support",
    "Firefox",
    "Profiles",
    "work.default-release",
  );
  mkdirSync(profile, { recursive: true });
  const database = new Database(join(profile, "cookies.sqlite"), {
    nativeBinding: nodeNativeBinding,
  });
  database.exec(
    "CREATE TABLE moz_cookies (host TEXT, name TEXT, value TEXT, path TEXT, expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER)",
  );
  const insert = database.prepare(
    "INSERT INTO moz_cookies (host, name, value, path, expiry, isSecure, isHttpOnly, sameSite) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  insert.run(".example.com", "session", "firefox-secret", "/", 2_000_000_000, 1, 1, 1);
  insert.run(".outside.test", "outside", "never-read", "/", 2_000_000_000, 1, 1, 0);
  database.close();
  return profile;
}

function encryptedChromiumValue(password: string, host: string, value: string): Buffer {
  const key = pbkdf2Sync(password, "saltysalt", 1_003, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([
    Buffer.from("v10"),
    cipher.update(Buffer.concat([createHash("sha256").update(host).digest(), Buffer.from(value)])),
    cipher.final(),
  ]);
}

function createChromiumCookieDatabase(home: string, password: string): void {
  const network = join(
    home,
    "Library",
    "Application Support",
    "Google",
    "Chrome",
    "Default",
    "Network",
  );
  mkdirSync(network, { recursive: true });
  const database = new Database(join(network, "Cookies"), { nativeBinding: nodeNativeBinding });
  database.exec(
    "CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, has_expires INTEGER, is_persistent INTEGER)",
  );
  database
    .prepare(
      "INSERT INTO cookies (host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite, has_expires, is_persistent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      ".example.com",
      "chrome-session",
      "",
      encryptedChromiumValue(password, ".example.com", "chrome-secret"),
      "/",
      0,
      1,
      1,
      1,
      0,
      0,
    );
  database.close();
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("LocalBrowserCookieReader", () => {
  it("discovers installed profiles without exposing filesystem paths to the renderer", () => {
    const home = temporaryHome();
    createFirefoxCookieDatabase(home);
    const reader = new LocalBrowserCookieReader({
      platform: "darwin",
      homeDirectory: home,
      readSafeStoragePassword: vi.fn<(service: string) => Promise<string>>(),
      nativeBinding: nodeNativeBinding,
    });

    const profiles = reader.listProfiles();

    expect(profiles).toEqual([
      expect.objectContaining({
        sourceId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        ),
        label: "Firefox — work",
        browserFamily: "firefox",
      }),
    ]);
    expect(JSON.stringify(profiles)).not.toContain(home);
    expect(JSON.stringify(profiles)).not.toMatch(/profilePath|cookiePath|keychain/i);
  });

  it("reads only cookies matching the explicitly approved target origins", async () => {
    const home = temporaryHome();
    createFirefoxCookieDatabase(home);
    const reader = new LocalBrowserCookieReader({
      platform: "darwin",
      homeDirectory: home,
      readSafeStoragePassword: vi.fn<(service: string) => Promise<string>>(),
      nativeBinding: nodeNativeBinding,
    });
    const [profile] = reader.listProfiles();

    const result = await reader.readProfile({
      sourceId: profile!.sourceId,
      targetUrls: ["https://app.example.com"],
    });

    expect(result.cookies).toEqual([
      expect.objectContaining({
        name: "session",
        value: "firefox-secret",
        domain: ".example.com",
        secure: true,
        httpOnly: true,
        sameSite: "lax",
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("never-read");
  });

  it("decrypts a Chromium v10 cookie and verifies its host digest", () => {
    const password = "fixture-safe-storage-password";
    const host = ".example.com";
    const value = "chromium-secret";
    const key = pbkdf2Sync(password, "saltysalt", 1_003, 16, "sha1");
    const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    const encrypted = Buffer.concat([
      Buffer.from("v10"),
      cipher.update(
        Buffer.concat([createHash("sha256").update(host).digest(), Buffer.from(value)]),
      ),
      cipher.final(),
    ]);

    expect(
      decryptChromiumCookieValue({
        encryptedValue: encrypted,
        fallbackValue: "",
        hostKey: host,
        safeStoragePassword: password,
      }),
    ).toBe(value);
    expect(
      decryptChromiumCookieValue({
        encryptedValue: encrypted,
        fallbackValue: "",
        hostKey: ".attacker.test",
        safeStoragePassword: password,
      }),
    ).toBeNull();
  });

  it("reads a synthetic Chromium profile through its fixed Safe Storage service", async () => {
    const home = temporaryHome();
    const password = "fixture-safe-storage-password";
    createChromiumCookieDatabase(home, password);
    const readSafeStoragePassword = vi.fn<(service: string) => Promise<string>>(async () =>
      Promise.resolve(password),
    );
    const reader = new LocalBrowserCookieReader({
      platform: "darwin",
      homeDirectory: home,
      readSafeStoragePassword,
      nativeBinding: nodeNativeBinding,
    });
    const profile = reader.listProfiles().find((candidate) => candidate.browserFamily === "chrome");

    await expect(
      reader.readProfile({
        sourceId: profile!.sourceId,
        targetUrls: ["https://app.example.com"],
      }),
    ).resolves.toMatchObject({
      cookies: [{ name: "chrome-session", value: "chrome-secret", domain: ".example.com" }],
      invalidCount: 0,
    });
    expect(readSafeStoragePassword).toHaveBeenCalledExactlyOnceWith("Chrome Safe Storage");
  });
});
