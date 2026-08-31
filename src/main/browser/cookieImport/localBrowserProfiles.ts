import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { createDecipheriv, createHash, pbkdf2Sync, randomUUID, timingSafeEqual } from "node:crypto";
import Database from "better-sqlite3";
import type { CookieImportWireCookie } from "./protocol";

const execFileAsync = promisify(execFile);
const CHROMIUM_EPOCH_OFFSET_SECONDS = 11_644_473_600;
const MAX_IMPORTED_COOKIES = 750;

export type LocalBrowserFamily = "chrome" | "chromium" | "brave" | "edge" | "arc" | "firefox";

export interface LocalBrowserProfileInfo {
  sourceId: string;
  label: string;
  browserFamily: LocalBrowserFamily;
}

interface LocalBrowserProfile extends LocalBrowserProfileInfo {
  cookiePath: string;
  safeStorageService?: string;
}

interface LocalBrowserCookieReaderOptions {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  readSafeStoragePassword?: (service: string) => Promise<string>;
  /** Node-ABI test/headless override; Electron releases use their packaged binding. */
  nativeBinding?: string;
}

interface CookieRow {
  host: string;
  name: string;
  value: string;
  encryptedValue?: Buffer;
  path: string;
  expires: number;
  secure: number;
  httpOnly: number;
  sameSite: number;
  hasExpires?: number;
  persistent?: number;
}

const CHROMIUM_BROWSERS: readonly {
  family: Exclude<LocalBrowserFamily, "firefox">;
  name: string;
  relativeRoot: string[];
  safeStorageService: string;
}[] = [
  {
    family: "chrome",
    name: "Chrome",
    relativeRoot: ["Google", "Chrome"],
    safeStorageService: "Chrome Safe Storage",
  },
  {
    family: "brave",
    name: "Brave",
    relativeRoot: ["BraveSoftware", "Brave-Browser"],
    safeStorageService: "Brave Safe Storage",
  },
  {
    family: "edge",
    name: "Edge",
    relativeRoot: ["Microsoft Edge"],
    safeStorageService: "Microsoft Edge Safe Storage",
  },
  {
    family: "chromium",
    name: "Chromium",
    relativeRoot: ["Chromium"],
    safeStorageService: "Chromium Safe Storage",
  },
  {
    family: "arc",
    name: "Arc",
    relativeRoot: ["Arc", "User Data"],
    safeStorageService: "Arc Safe Storage",
  },
] as const;

function defaultSafeStoragePassword(service: string): Promise<string> {
  return execFileAsync("/usr/bin/security", ["find-generic-password", "-w", "-s", service], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  }).then(({ stdout }) => stdout.trimEnd());
}

function profileDisplayName(directoryName: string): string {
  if (directoryName === "Default") return "Default";
  const firefoxName = directoryName.replace(/\.(?:default(?:-release)?|release)$/u, "");
  return firefoxName || directoryName;
}

function findCookieDatabase(profilePath: string): string | null {
  const networkPath = join(profilePath, "Network", "Cookies");
  if (existsSync(networkPath)) return networkPath;
  const legacyPath = join(profilePath, "Cookies");
  return existsSync(legacyPath) ? legacyPath : null;
}

function targetHostCandidates(targetUrls: readonly string[]): string[] {
  const candidates = new Set<string>();
  for (const value of targetUrls) {
    const hostname = new URL(value).hostname.toLowerCase().replace(/^\.+/u, "");
    const labels = hostname.split(".").filter(Boolean);
    candidates.add(hostname);
    candidates.add(`.${hostname}`);
    for (let index = 1; index < labels.length - 1; index += 1) {
      const suffix = labels.slice(index).join(".");
      candidates.add(suffix);
      candidates.add(`.${suffix}`);
    }
  }
  return [...candidates].slice(0, 500);
}

function cookieMatchesTargets(domain: string, hostOnly: boolean, targetUrls: readonly string[]) {
  const normalized = domain.toLowerCase().replace(/^\.+/u, "");
  return targetUrls.some((value) => {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostOnly
      ? hostname === normalized
      : hostname === normalized || hostname.endsWith(`.${normalized}`);
  });
}

function copyDatabaseForRead(source: string): { databasePath: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "y-space-cookie-import-"));
  const databasePath = join(directory, basename(source));
  copyFileSync(source, databasePath);
  for (const suffix of ["-wal", "-shm"] as const) {
    const companion = `${source}${suffix}`;
    if (existsSync(companion)) copyFileSync(companion, `${databasePath}${suffix}`);
  }
  return {
    databasePath,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function mapFirefoxSameSite(value: number): CookieImportWireCookie["sameSite"] {
  if (value === 1) return "lax";
  if (value === 2) return "strict";
  if (value === 3) return "no_restriction";
  return "unspecified";
}

function mapChromiumSameSite(value: number): CookieImportWireCookie["sameSite"] {
  if (value === 0) return "no_restriction";
  if (value === 1) return "lax";
  if (value === 2) return "strict";
  return "unspecified";
}

export function decryptChromiumCookieValue(input: {
  encryptedValue: Buffer;
  fallbackValue: string;
  hostKey: string;
  safeStoragePassword: string;
}): string | null {
  if (input.fallbackValue) return input.fallbackValue;
  const prefix = input.encryptedValue.subarray(0, 3).toString("ascii");
  if (prefix !== "v10" && prefix !== "v11") return null;
  const key = pbkdf2Sync(input.safeStoragePassword, "saltysalt", 1_003, 16, "sha1");
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    const plaintext = Buffer.concat([
      decipher.update(input.encryptedValue.subarray(3)),
      decipher.final(),
    ]);
    if (plaintext.length < 32) return null;
    const expectedHostDigest = createHash("sha256").update(input.hostKey).digest();
    const actualHostDigest = plaintext.subarray(0, 32);
    if (!timingSafeEqual(actualHostDigest, expectedHostDigest)) return null;
    return plaintext.subarray(32).toString("utf8");
  } catch {
    return null;
  } finally {
    key.fill(0);
  }
}

export class LocalBrowserCookieReader {
  private profiles: Map<string, LocalBrowserProfile> | null = null;
  private readonly platform: NodeJS.Platform;
  private readonly homeDirectory: string;
  private readonly readSafeStoragePassword: (service: string) => Promise<string>;
  private readonly nativeBinding: string | undefined;

  constructor(options: LocalBrowserCookieReaderOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.homeDirectory = options.homeDirectory ?? homedir();
    this.readSafeStoragePassword = options.readSafeStoragePassword ?? defaultSafeStoragePassword;
    this.nativeBinding = options.nativeBinding;
  }

  listProfiles(): LocalBrowserProfileInfo[] {
    return [...this.discoverProfiles().values()].map(({ sourceId, label, browserFamily }) => ({
      sourceId,
      label,
      browserFamily,
    }));
  }

  async readProfile(input: {
    sourceId: string;
    targetUrls: string[];
  }): Promise<{ cookies: CookieImportWireCookie[]; invalidCount: number }> {
    const profile = this.discoverProfiles().get(input.sourceId);
    if (!profile) throw new Error("Installed browser profile is unavailable.");
    return profile.browserFamily === "firefox"
      ? this.readFirefox(profile, input.targetUrls)
      : this.readChromium(profile, input.targetUrls);
  }

  private discoverProfiles(): Map<string, LocalBrowserProfile> {
    if (this.profiles) return this.profiles;
    const profiles = new Map<string, LocalBrowserProfile>();
    if (this.platform !== "darwin") {
      this.profiles = profiles;
      return profiles;
    }

    const applicationSupport = join(this.homeDirectory, "Library", "Application Support");
    for (const browser of CHROMIUM_BROWSERS) {
      const root = join(applicationSupport, ...browser.relativeRoot);
      if (!existsSync(root)) continue;
      let directoryNames: string[];
      try {
        directoryNames = readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        continue;
      }
      for (const directoryName of directoryNames) {
        const cookiePath = findCookieDatabase(join(root, directoryName));
        if (!cookiePath) continue;
        const sourceId = randomUUID();
        profiles.set(sourceId, {
          sourceId,
          label: `${browser.name} — ${profileDisplayName(directoryName)}`,
          browserFamily: browser.family,
          cookiePath,
          safeStorageService: browser.safeStorageService,
        });
      }
    }

    const firefoxRoot = join(applicationSupport, "Firefox", "Profiles");
    if (existsSync(firefoxRoot)) {
      try {
        for (const entry of readdirSync(firefoxRoot, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const cookiePath = join(firefoxRoot, entry.name, "cookies.sqlite");
          if (!existsSync(cookiePath)) continue;
          const sourceId = randomUUID();
          profiles.set(sourceId, {
            sourceId,
            label: `Firefox — ${profileDisplayName(entry.name)}`,
            browserFamily: "firefox",
            cookiePath,
          });
        }
      } catch {
        // An unreadable browser profile is omitted instead of weakening the
        // importer's origin and renderer boundaries.
      }
    }
    this.profiles = profiles;
    return profiles;
  }

  private readFirefox(profile: LocalBrowserProfile, targetUrls: string[]) {
    const copied = copyDatabaseForRead(profile.cookiePath);
    try {
      const database = new Database(copied.databasePath, {
        readonly: true,
        fileMustExist: true,
        ...(this.nativeBinding ? { nativeBinding: this.nativeBinding } : {}),
      });
      try {
        const candidates = targetHostCandidates(targetUrls);
        if (candidates.length === 0) return { cookies: [], invalidCount: 0 };
        const placeholders = candidates.map(() => "?").join(",");
        const rows = database
          .prepare(
            `SELECT host, name, value, path, expiry AS expires, isSecure AS secure, isHttpOnly AS httpOnly, sameSite FROM moz_cookies WHERE host IN (${placeholders}) LIMIT ${MAX_IMPORTED_COOKIES + 1}`,
          )
          .all(...candidates) as CookieRow[];
        const nowSeconds = Date.now() / 1_000;
        const cookies = rows
          .filter((row) => row.expires <= 0 || row.expires > nowSeconds)
          .filter((row) => cookieMatchesTargets(row.host, !row.host.startsWith("."), targetUrls))
          .slice(0, MAX_IMPORTED_COOKIES)
          .map(
            (row): CookieImportWireCookie => ({
              name: row.name,
              value: row.value,
              domain: row.host,
              hostOnly: !row.host.startsWith("."),
              path: row.path || "/",
              secure: Boolean(row.secure),
              httpOnly: Boolean(row.httpOnly),
              sameSite: mapFirefoxSameSite(row.sameSite),
              session: row.expires <= 0,
              ...(row.expires > 0 ? { expirationDate: row.expires } : {}),
            }),
          );
        return { cookies, invalidCount: Math.max(0, rows.length - cookies.length) };
      } finally {
        database.close();
      }
    } finally {
      copied.cleanup();
    }
  }

  private async readChromium(profile: LocalBrowserProfile, targetUrls: string[]) {
    const copied = copyDatabaseForRead(profile.cookiePath);
    try {
      const database = new Database(copied.databasePath, {
        readonly: true,
        fileMustExist: true,
        ...(this.nativeBinding ? { nativeBinding: this.nativeBinding } : {}),
      });
      try {
        const columns = new Set(
          (database.prepare("PRAGMA table_info(cookies)").all() as { name: string }[]).map(
            ({ name }) => name,
          ),
        );
        const candidates = targetHostCandidates(targetUrls);
        if (candidates.length === 0) return { cookies: [], invalidCount: 0 };
        const select = (column: string, fallback: string, alias = column) =>
          `${columns.has(column) ? column : fallback} AS ${alias}`;
        const placeholders = candidates.map(() => "?").join(",");
        const rows = database
          .prepare(
            `SELECT host_key AS host, name, ${select("value", "''")}, ${select("encrypted_value", "X''", "encryptedValue")}, path, ${select("expires_utc", "0", "expires")}, ${select("is_secure", "0", "secure")}, ${select("is_httponly", "0", "httpOnly")}, ${select("samesite", "-1", "sameSite")}, ${select("has_expires", "0", "hasExpires")}, ${select("is_persistent", "0", "persistent")} FROM cookies WHERE host_key IN (${placeholders}) LIMIT ${MAX_IMPORTED_COOKIES + 1}`,
          )
          .all(...candidates) as CookieRow[];
        const safeStoragePassword = await this.readSafeStoragePassword(
          profile.safeStorageService ?? "Chromium Safe Storage",
        );
        const nowSeconds = Date.now() / 1_000;
        const cookies: CookieImportWireCookie[] = [];
        let invalidCount = 0;
        for (const row of rows) {
          const expirationDate =
            row.expires > 0 ? row.expires / 1_000_000 - CHROMIUM_EPOCH_OFFSET_SECONDS : 0;
          if (expirationDate > 0 && expirationDate <= nowSeconds) continue;
          const hostOnly = !row.host.startsWith(".");
          if (!cookieMatchesTargets(row.host, hostOnly, targetUrls)) continue;
          const value = decryptChromiumCookieValue({
            encryptedValue: Buffer.from(row.encryptedValue ?? []),
            fallbackValue: row.value ?? "",
            hostKey: row.host,
            safeStoragePassword,
          });
          if (value === null) {
            invalidCount += 1;
            continue;
          }
          cookies.push({
            name: row.name,
            value,
            domain: row.host,
            hostOnly,
            path: row.path || "/",
            secure: Boolean(row.secure),
            httpOnly: Boolean(row.httpOnly),
            sameSite: mapChromiumSameSite(row.sameSite),
            session: !(row.hasExpires || row.persistent) || expirationDate <= 0,
            ...(expirationDate > 0 ? { expirationDate } : {}),
          });
          if (cookies.length >= MAX_IMPORTED_COOKIES) break;
        }
        return { cookies, invalidCount };
      } finally {
        database.close();
      }
    } finally {
      copied.cleanup();
    }
  }
}
