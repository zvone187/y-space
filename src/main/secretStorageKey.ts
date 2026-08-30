import { lstatSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { safeStorage } from "electron";
import { writeFileAtomic } from "@/shared/atomicFile";
import {
  durableFileSystem,
  FileDurabilityUnavailableError,
  type FileDurability,
} from "@/shared/fileDurability";
import { isCanonicalSecretStorageKey } from "@/shared/supervisorSecretBootstrap";

const SAFE_STORAGE_KEY_FILE = "secret-key.safe";
let sessionOnlyKey: string | undefined;

export interface SecretStorageKeyMaterial {
  readonly key: string;
  readonly persistent: boolean;
}

export class SecretStorageKeyUnavailableError extends Error {
  constructor(reason: "read-failed" | "decrypt-failed" | "invalid-key") {
    super("Y Space credential storage is locked.");
    this.name = "SecretStorageKeyUnavailableError";
    this.reason = reason;
  }

  readonly reason: "read-failed" | "decrypt-failed" | "invalid-key";
}

function keyFilePath(baseDir: string): string {
  return join(baseDir, SAFE_STORAGE_KEY_FILE);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}

function createPersistentKey(path: string, durability: FileDurability): string {
  const key = randomBytes(32).toString("base64");
  let encrypted: Buffer;
  try {
    encrypted = safeStorage.encryptString(key);
  } catch {
    throw new Error("Unable to encrypt the Y Space secret storage key.");
  }
  try {
    writeFileAtomic(path, encrypted.toString("base64"), {
      encoding: "utf8",
      mode: 0o600,
      durability,
    });
  } catch {
    throw new Error("Unable to persist the encrypted Y Space secret storage key.");
  }
  return key;
}

export function readOrCreateSafeStorageSecretKey(
  baseDir: string,
  platform: NodeJS.Platform = process.platform,
  durability: FileDurability = durableFileSystem,
): SecretStorageKeyMaterial {
  const path = keyFilePath(baseDir);
  let encryptionAvailable: boolean;
  try {
    encryptionAvailable = safeStorage.isEncryptionAvailable();
    if (
      encryptionAvailable &&
      platform === "linux" &&
      safeStorage.getSelectedStorageBackend() === "basic_text"
    ) {
      encryptionAvailable = false;
    }
  } catch {
    throw new Error("Unable to inspect OS-backed secret storage.");
  }
  let namespaceDurabilityAvailable = true;
  try {
    durability.assertDirectorySyncSupported?.(baseDir);
  } catch (error) {
    if (!(error instanceof FileDurabilityUnavailableError)) throw error;
    namespaceDurabilityAvailable = false;
  }
  if (!encryptionAvailable) {
    try {
      lstatSync(path);
      // A persisted master blob already exists. A transient Keychain/libsecret
      // outage must not rotate to a session key beside encrypted credentials.
      throw new SecretStorageKeyUnavailableError("decrypt-failed");
    } catch (error) {
      if (error instanceof SecretStorageKeyUnavailableError) throw error;
      if (!hasErrorCode(error, "ENOENT")) {
        throw new SecretStorageKeyUnavailableError("read-failed");
      }
    }
    console.warn(
      "[credential-storage] secure OS encryption is unavailable; credentials are session-only.",
    );
    sessionOnlyKey ??= randomBytes(32).toString("base64");
    return { key: sessionOnlyKey, persistent: false };
  }

  let serialized: string;
  try {
    serialized = readFileSync(path, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      if (!namespaceDurabilityAvailable) {
        console.warn(
          "[credential-storage] durable namespace commits are unavailable; credentials are session-only.",
        );
        sessionOnlyKey ??= randomBytes(32).toString("base64");
        return { key: sessionOnlyKey, persistent: false };
      }
      return { key: createPersistentKey(path, durability), persistent: true };
    }
    throw new SecretStorageKeyUnavailableError("read-failed");
  }

  // A previous launch can observe the renamed key and still fail its final
  // parent-directory fsync. Repair that uncertain namespace commit before we
  // trust the blob as the durable master key for this launch.
  if (namespaceDurabilityAvailable) {
    try {
      durability.syncRenamedFile?.(path);
      durability.syncDirectory(baseDir);
    } catch {
      throw new SecretStorageKeyUnavailableError("read-failed");
    }
  }

  let key: string;
  try {
    const canonical = serialized.trim();
    const encrypted = Buffer.from(canonical, "base64");
    if (!canonical || encrypted.toString("base64") !== canonical) {
      throw new SecretStorageKeyUnavailableError("invalid-key");
    }
    key = safeStorage.decryptString(encrypted);
  } catch (error) {
    if (error instanceof SecretStorageKeyUnavailableError) throw error;
    // Keychain denial and temporary unavailability must never rotate the sole
    // master key. Preserve the old blob so restoring OS-key access can recover
    // every sealed credential on the next launch.
    throw new SecretStorageKeyUnavailableError("decrypt-failed");
  }
  if (!isCanonicalSecretStorageKey(key)) {
    throw new SecretStorageKeyUnavailableError("invalid-key");
  }
  if (!namespaceDurabilityAvailable) {
    console.warn(
      "[credential-storage] durable namespace commits are unavailable; credentials are session-only.",
    );
  }
  return { key, persistent: namespaceDurabilityAvailable };
}
