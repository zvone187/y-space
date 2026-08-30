import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "@/shared/atomicFile";
import {
  durableFileSystem,
  FileDurabilityUnavailableError,
  type FileDurability,
} from "@/shared/fileDurability";

/**
 * Secret-storage key for the headless server.
 *
 * The desktop derives its key from Electron `safeStorage`
 * (`src/main/secretStorageKey.ts`), which is backed by the OS keychain. A
 * headless server generally has no keychain, so the key is persisted to a
 * file in the data dir instead (mode 0600). This is strictly weaker than the
 * desktop's OS-sealed key — anyone who can read the data dir can read the key —
 * but it matches the server's trust model: the SQLite DB, agent credentials and
 * project files already live in that same dir under the same filesystem
 * permissions.
 *
 * Precedence:
 *   1. `PORACODE_SECRET_STORAGE_KEY` env (base64, 32 bytes) — lets an operator
 *      inject a key from a real secret manager and keep it off disk.
 *   2. the persisted key file.
 *   3. a freshly generated key, persisted for next boot.
 *
 * Sealed secrets are per-install: rotating the key only invalidates previously
 * sealed values (re-auth required), it never corrupts the DB.
 */
const HEADLESS_KEY_FILE = "secret-key.headless";

function keyFilePath(baseDir: string): string {
  return join(baseDir, HEADLESS_KEY_FILE);
}

function normalizeSecretStorageKey(value: string): string | undefined {
  if (!/^[A-Za-z0-9+/_-]{43}=?$/.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32) return undefined;
  const canonical = decoded.toString("base64");
  const comparableInput = value.replace(/-/g, "+").replace(/_/g, "/").replace(/=$/, "");
  return canonical.replace(/=$/, "") === comparableInput ? canonical : undefined;
}

function readExistingSecretKeyWithoutRepair(path: string): string | undefined {
  try {
    return normalizeSecretStorageKey(readFileSync(path, "utf8").trim());
  } catch {
    return undefined;
  }
}

function readOrCreatePersistedSecret(
  path: string,
  options: {
    readonly fromEnv?: string | undefined;
    readonly validateEnv?: (value: string) => void;
    readonly isValid: (value: string) => boolean;
    readonly normalize?: (value: string) => string | undefined;
    readonly generate: () => string;
    readonly durability?: FileDurability;
    readonly failClosedOnInvalidExisting?: boolean;
  },
): string {
  const { fromEnv } = options;
  if (fromEnv) {
    options.validateEnv?.(fromEnv);
    return options.normalize?.(fromEnv) ?? fromEnv;
  }

  if (existsSync(path)) {
    try {
      // Repair a prior post-rename directory-fsync failure before accepting an
      // existing file as the persistent master key for this launch.
      options.durability?.syncRenamedFile?.(path);
      options.durability?.syncDirectory(dirname(path));
      const existing = readFileSync(path, "utf8").trim();
      const normalized = options.normalize?.(existing);
      if (normalized) {
        if (normalized !== existing) {
          try {
            writeFileAtomic(path, normalized, {
              encoding: "utf8",
              mode: 0o600,
              ...(options.durability ? { durability: options.durability } : {}),
            });
          } catch {
            // The canonical value is safe to use for this launch even if its
            // best-effort on-disk migration must be retried next time.
          }
        }
        return normalized;
      }
      if (options.isValid(existing)) return existing;
    } catch {
      if (options.failClosedOnInvalidExisting) {
        throw new Error("The headless secret-storage key is unavailable.");
      }
    }
    if (options.failClosedOnInvalidExisting) {
      // Never rotate over a corrupt legacy master key: it may be the only key
      // capable of decrypting durable OAuth and integration credentials.
      throw new Error("The headless secret-storage key is unavailable.");
    }
  }

  const secret = options.generate();
  writeFileAtomic(path, secret, {
    encoding: "utf8",
    mode: 0o600,
    ...(options.durability ? { durability: options.durability } : {}),
  });
  return secret;
}

export function readOrCreateHeadlessSecretKey(
  baseDir: string,
  durability: FileDurability = durableFileSystem,
): string {
  const path = keyFilePath(baseDir);
  const fromEnv = process.env.PORACODE_SECRET_STORAGE_KEY?.trim();
  const sharedOptions = {
    fromEnv,
    validateEnv: (value: string) => {
      if (!normalizeSecretStorageKey(value)) {
        throw new Error("PORACODE_SECRET_STORAGE_KEY must be a base64-encoded 32-byte key.");
      }
    },
    isValid: (value: string) => Boolean(normalizeSecretStorageKey(value)),
    normalize: normalizeSecretStorageKey,
    generate: () => randomBytes(32).toString("base64"),
    durability,
    failClosedOnInvalidExisting: true,
  } as const;

  // An injected secret never touches the filesystem and remains the preferred
  // Windows headless deployment path.
  if (fromEnv) return readOrCreatePersistedSecret(path, sharedOptions);

  let namespaceDurabilityUnavailable = false;
  try {
    durability.assertDirectorySyncSupported?.(baseDir);
  } catch (error) {
    if (!(error instanceof FileDurabilityUnavailableError)) throw error;
    namespaceDurabilityUnavailable = true;
  }

  if (namespaceDurabilityUnavailable) {
    if (existsSync(path)) {
      // A valid legacy key can remain the in-memory master for this launch.
      // Do not claim to repair or rewrite its namespace on this platform.
      const normalized = readExistingSecretKeyWithoutRepair(path);
      if (normalized) return normalized;
      throw new Error("The headless secret-storage key is unavailable.");
    }
    throw new Error(
      "PORACODE_SECRET_STORAGE_KEY is required because this platform cannot durably persist a generated headless key.",
    );
  }

  return readOrCreatePersistedSecret(path, sharedOptions);
}

const RELAY_SECRET_FILE = "relay-secret";

/**
 * Secret that proves ownership of this server's relay id (its desktopId) to a
 * relay. Persisted so the id stays claimable across restarts; env-overridable
 * via `PORACODE_REMOTE_RELAY_SECRET`. Unlike the storage key this need not be
 * 32 bytes — it's an opaque bearer string between the server and the relay.
 */
export function readOrCreateRelaySecret(baseDir: string): string {
  return readOrCreatePersistedSecret(join(baseDir, RELAY_SECRET_FILE), {
    fromEnv: process.env.PORACODE_REMOTE_RELAY_SECRET?.trim(),
    isValid: (value) => value.length > 0,
    generate: () => randomBytes(32).toString("base64url"),
  });
}
