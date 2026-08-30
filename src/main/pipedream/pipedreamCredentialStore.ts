import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "@/shared/atomicFile";
import type { PipedreamEnvFileInvalidReason } from "@/shared/contracts";
import { durableFileSystem, type FileDurability } from "@/shared/fileDurability";
import {
  capturePipedreamBootstrapEnvText,
  PIPEDREAM_ENV_FILE_MAX_BYTES,
  PIPEDREAM_ENV_KEYS,
  PIPEDREAM_PROJECT_ID_MAX_LENGTH,
  type PipedreamBootstrap,
  type PipedreamBootstrapCredentials,
} from "@/shared/pipedreamBootstrap";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "@/shared/secretStorage";

const PIPEDREAM_CREDENTIAL_STORE_NAME = "pipedream-credentials.json";
const LEGACY_PIPEDREAM_ENV_FILE_SETTINGS_NAME = "pipedream-env-file.json";
const PIPEDREAM_CREDENTIAL_STORE_MAX_BYTES = 256 * 1024;

const credentialsSchema = z
  .object({
    clientId: z.string().trim().min(1).max(4_096),
    clientSecret: z.string().trim().min(1).max(16_384),
    projectId: z
      .string()
      .max(PIPEDREAM_PROJECT_ID_MAX_LENGTH)
      .regex(/^proj_[a-zA-Z0-9]+$/),
    environment: z.enum(["development", "production"]),
  })
  .strict();

const sourceFingerprintSchema = z
  .object({
    device: z.string().regex(/^\d+$/),
    inode: z.string().regex(/^\d+$/),
    size: z.string().regex(/^\d+$/),
    modifiedNanoseconds: z.string().regex(/^\d+$/),
    changedNanoseconds: z.string().regex(/^\d+$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const activePayloadSchema = z
  .object({
    version: z.literal(1),
    state: z.literal("active"),
    credentials: credentialsSchema,
  })
  .strict();

const pendingPayloadSchema = z
  .object({
    version: z.literal(1),
    state: z.literal("pending-source-cleanup"),
    credentials: credentialsSchema,
    source: z
      .object({
        path: z
          .string()
          .min(1)
          .max(4_096)
          .refine((value) => isAbsolute(value)),
        fingerprint: sourceFingerprintSchema,
        phase: z.enum(["source-present", "quarantined", "removed", "resetting"]),
        quarantineDirectory: z
          .string()
          .min(1)
          .max(4_096)
          .refine((value) => isAbsolute(value)),
      })
      .strict(),
  })
  .strict();

const credentialPayloadSchema = z.discriminatedUnion("state", [
  activePayloadSchema,
  pendingPayloadSchema,
]);

const credentialStoreSchema = z
  .object({
    version: z.literal(1),
    sealed: z.string().min(1).max(PIPEDREAM_CREDENTIAL_STORE_MAX_BYTES),
  })
  .strict();

type CredentialPayload = z.infer<typeof credentialPayloadSchema>;
type PendingPayload = z.infer<typeof pendingPayloadSchema>;
type SourceFingerprint = z.infer<typeof sourceFingerprintSchema>;
type ReadyBootstrap = Extract<PipedreamBootstrap, { state: "ready" }>;

export type PipedreamCredentialFileImport =
  | { readonly status: "configured"; readonly bootstrap: ReadyBootstrap }
  | { readonly status: "invalid"; readonly reason: PipedreamEnvFileInvalidReason };

export interface PipedreamCredentialStore {
  importEnvironmentFile(filePath: string): PipedreamCredentialFileImport;
  applyPersisted(startupBootstrap: PipedreamBootstrap): PipedreamBootstrap;
  clear(): void;
  resetAfterConfirmedSourceRemoval(): void;
}

export interface PipedreamCredentialStoreOptions {
  /** True only after the main process verifies an app-isolated persistent key. */
  readonly appIsolatedPersistentKey: boolean;
  readonly durability?: PipedreamCredentialDurability;
}

export type PipedreamCredentialDurability = FileDurability;

export interface PipedreamCredentialImportHooks {
  /** Test seam after the sealed pending record commits, before source inspection. */
  readonly afterPendingPersisted?: () => void;
  /** Test seam for an adversarial source-path swap immediately before rename. */
  readonly beforeQuarantineRename?: () => void;
}

export class PipedreamCredentialStoreUnavailableError extends Error {
  constructor(readonly canResetAfterConfirmedSourceRemoval = false) {
    super("Pipedream secure storage is unavailable.");
    this.name = "PipedreamCredentialStoreUnavailableError";
  }
}

class PipedreamPlaintextRemovalCommittedError extends Error {
  constructor() {
    super("The Pipedream setup file was removed, but cleanup is still pending.");
    this.name = "PipedreamPlaintextRemovalCommittedError";
  }
}

/**
 * A credential-clear failure whose flag records whether the authoritative
 * store unlink already committed. Callers must revoke live authority when it
 * is true even though the final durability confirmation failed.
 */
export class PipedreamCredentialClearError extends Error {
  constructor(readonly credentialsRemoved: boolean) {
    super("Pipedream credentials could not be cleared durably.");
    this.name = "PipedreamCredentialClearError";
  }
}

/**
 * The plaintext source is durably gone and the sealed pending record is now
 * authoritative, but final active promotion/metadata cleanup failed. The main
 * process must install this bootstrap live before surfacing the error.
 */
export class PipedreamCredentialImportCommittedError extends Error {
  constructor(readonly bootstrap: ReadyBootstrap) {
    super("Pipedream credentials were secured, but final storage confirmation failed.");
    this.name = "PipedreamCredentialImportCommittedError";
  }
}

export function createPipedreamCredentialStore(
  baseDir: string,
  options: PipedreamCredentialStoreOptions,
): PipedreamCredentialStore {
  const durability = options.durability ?? durableFileSystem;
  return Object.freeze({
    importEnvironmentFile: (filePath: string): PipedreamCredentialFileImport =>
      options.appIsolatedPersistentKey
        ? importPipedreamCredentialFile(baseDir, filePath, durability)
        : { status: "invalid", reason: "secure-storage-unavailable" },
    applyPersisted: (startupBootstrap: PipedreamBootstrap) => {
      if (!options.appIsolatedPersistentKey) {
        if (credentialStoreExists(baseDir)) throw new PipedreamCredentialStoreUnavailableError();
        removeLegacyPathMetadata(baseDir);
        return startupBootstrap;
      }
      return applyPersistedPipedreamCredentials(baseDir, startupBootstrap, durability);
    },
    clear: () => clearPipedreamCredentials(baseDir, durability),
    resetAfterConfirmedSourceRemoval: () =>
      resetPipedreamCredentialsAfterConfirmedSourceRemoval(baseDir, durability),
  });
}

export function importPipedreamCredentialFile(
  baseDir: string,
  filePath: string,
  durability: PipedreamCredentialDurability = durableFileSystem,
  hooks: PipedreamCredentialImportHooks = {},
): PipedreamCredentialFileImport {
  if (!isAbsolute(filePath) || filePath.length > 4_096) {
    return { status: "invalid", reason: "unreadable" };
  }

  const initial = inspectDedicatedSource(filePath);
  if (initial.status === "invalid") return initial;

  const captured = capturePipedreamBootstrapEnvText(initial.serialized, {});
  if (captured.state === "absent") {
    return { status: "invalid", reason: "no-supported-values" };
  }
  if (captured.state === "partial") {
    return { status: "invalid", reason: "incomplete-values" };
  }

  const validatedCredentials = credentialsSchema.safeParse(captured.credentials);
  if (!validatedCredentials.success) {
    return { status: "invalid", reason: "invalid-values" };
  }

  const bootstrap: ReadyBootstrap = {
    state: "ready",
    source: "secure-storage",
    credentials: validatedCredentials.data,
  };
  const pending: PendingPayload = {
    version: 1,
    state: "pending-source-cleanup",
    credentials: bootstrap.credentials,
    source: {
      path: filePath,
      fingerprint: initial.fingerprint,
      phase: "source-present",
      quarantineDirectory: join(
        dirname(filePath),
        `.y-space-pipedream-${process.pid}-${randomUUID()}.pending`,
      ),
    },
  };

  // Persist the recoverable encrypted value before permanently removing the
  // plaintext source. A crash at any following point resumes this cleanup on
  // the next launch and never activates credentials while the source remains.
  writeCredentialPayload(baseDir, pending, durability);
  hooks.afterPendingPersisted?.();
  try {
    completePendingSourceCleanup(baseDir, pending, durability, hooks);
  } catch (error) {
    if (error instanceof PipedreamPlaintextRemovalCommittedError) {
      throw new PipedreamCredentialImportCommittedError(bootstrap);
    }
    throw error;
  }
  try {
    writeCredentialPayload(baseDir, activePayload(bootstrap.credentials), durability);
    removeLegacyPathMetadata(baseDir);
  } catch {
    throw new PipedreamCredentialImportCommittedError(bootstrap);
  }
  return { status: "configured", bootstrap };
}

export function applyPersistedPipedreamCredentials(
  baseDir: string,
  startupBootstrap: PipedreamBootstrap,
  durability: PipedreamCredentialDurability = durableFileSystem,
): PipedreamBootstrap {
  // Repair/confirm any prior post-rename or post-unlink directory commit
  // before trusting either the visible credential record or its absence.
  try {
    if (credentialStoreExists(baseDir)) durability.syncRenamedFile?.(storePath(baseDir));
    durability.syncDirectory(baseDir);
    removeLegacyPathMetadata(baseDir);
  } catch {
    throw new PipedreamCredentialStoreUnavailableError();
  }
  const stored = readCredentialPayload(baseDir);
  if (!stored) return startupBootstrap;

  const active =
    stored.state === "pending-source-cleanup" ? resumePending(baseDir, stored, durability) : stored;
  if (!active) return startupBootstrap;
  if (startupBootstrap.state !== "absent") return startupBootstrap;
  return readyBootstrap(active.credentials);
}

export function clearPipedreamCredentials(
  baseDir: string,
  durability: PipedreamCredentialDurability = durableFileSystem,
): void {
  let credentialsRemoved = false;
  try {
    const stored = readCredentialPayload(baseDir);
    if (stored?.state === "pending-source-cleanup") {
      throw new Error("Pending Pipedream setup cleanup requires recovery.");
    }
    removeCredentialStore(baseDir, durability);
    credentialsRemoved = true;
  } catch {
    try {
      credentialsRemoved = !credentialStoreExists(baseDir);
    } catch {
      // Preserve the last known commit state.
    }
    throw new PipedreamCredentialClearError(credentialsRemoved);
  }
}

export function resetPipedreamCredentialsAfterConfirmedSourceRemoval(
  baseDir: string,
  durability: PipedreamCredentialDurability = durableFileSystem,
): void {
  let credentialsRemoved = false;
  let stored: CredentialPayload | undefined;
  try {
    stored = readCredentialPayload(baseDir);
  } catch {
    // An unreadable sealed record may be the only authenticated locator for a
    // plaintext file already moved into a hidden quarantine directory. Never
    // forget or archive it: doing so could strand that plaintext forever.
    throw new PipedreamCredentialClearError(false);
  }

  try {
    if (stored?.state === "pending-source-cleanup") {
      if (pathExists(stored.source.path)) {
        throw new Error("The original setup file still exists.");
      }
      const resetting = withPendingPhase(stored, "resetting");
      // Commit revocation intent before touching the quarantined plaintext. A
      // crash or later fsync failure now resumes Reset, never reactivation.
      writeCredentialPayload(baseDir, resetting, durability);
      resolvePendingBeforeReset(resetting, durability, true);
    }
    removeCredentialStore(baseDir, durability);
    credentialsRemoved = true;
  } catch {
    try {
      credentialsRemoved = !credentialStoreExists(baseDir);
    } catch {
      // Preserve the last known commit state.
    }
    throw new PipedreamCredentialClearError(credentialsRemoved);
  }
}

function removeCredentialStore(baseDir: string, durability: PipedreamCredentialDurability): void {
  rmSync(storePath(baseDir), { force: true });
  removeLegacyPathMetadata(baseDir);
  durability.syncDirectory(baseDir);
}

function resolvePendingBeforeReset(
  pending: PendingPayload,
  durability: PipedreamCredentialDurability,
  confirmedSourceRemoval: boolean,
): void {
  const filePath = pending.source.path;
  const quarantineDirectory = pending.source.quarantineDirectory;
  const quarantinedPath = join(quarantineDirectory, "credentials.env");
  if (pathExists(filePath)) {
    throw new Error("Pending Pipedream setup cleanup requires manual recovery.");
  }
  if (pathExists(quarantinedPath)) {
    if (!matchesCapturedSource(quarantinedPath, pending.source.fingerprint)) {
      throw new Error("Pending Pipedream setup cleanup requires manual recovery.");
    }
    unlinkSync(quarantinedPath);
    removeEmptyQuarantineDirectory(quarantineDirectory);
    syncRemovedSourceDirectory(filePath, durability);
    return;
  }
  if (pending.source.phase === "source-present" && !confirmedSourceRemoval) {
    throw new Error("Pending Pipedream setup cleanup requires manual recovery.");
  }
  removeEmptyQuarantineDirectory(quarantineDirectory);
  syncRemovedSourceDirectory(filePath, durability);
}

function resumePending(
  baseDir: string,
  pending: PendingPayload,
  durability: PipedreamCredentialDurability,
): z.infer<typeof activePayloadSchema> | undefined {
  try {
    if (pending.source.phase === "resetting") {
      resolvePendingBeforeReset(pending, durability, true);
      removeCredentialStore(baseDir, durability);
      return undefined;
    }
    completePendingSourceCleanup(baseDir, pending, durability);
    const active = activePayload(pending.credentials);
    writeCredentialPayload(baseDir, active, durability);
    return active;
  } catch {
    // Preserve the sealed pending record and route startup through the explicit
    // native recovery choice. Agents must not start while the original source
    // may still contain developer credentials.
    throw new PipedreamCredentialStoreUnavailableError(true);
  }
}

function inspectDedicatedSource(filePath: string):
  | {
      readonly status: "ready";
      readonly serialized: string;
      readonly fingerprint: SourceFingerprint;
    }
  | { readonly status: "invalid"; readonly reason: PipedreamEnvFileInvalidReason } {
  let before: ReturnType<typeof lstatSync>;
  let serialized: string;
  try {
    before = lstatSync(filePath, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) {
      return { status: "invalid", reason: "unreadable" };
    }
    if (before.size > BigInt(PIPEDREAM_ENV_FILE_MAX_BYTES)) {
      return { status: "invalid", reason: "too-large" };
    }
    serialized = readFileSync(filePath, "utf8");
    if (Buffer.byteLength(serialized, "utf8") > PIPEDREAM_ENV_FILE_MAX_BYTES) {
      return { status: "invalid", reason: "too-large" };
    }
  } catch {
    return { status: "invalid", reason: "unreadable" };
  }

  if (!isDedicatedPipedreamFile(serialized)) {
    return { status: "invalid", reason: "not-dedicated" };
  }

  const fingerprint = fingerprintOf(before, serialized);
  try {
    if (
      !sameFingerprint(
        fingerprint,
        fingerprintOf(lstatSync(filePath, { bigint: true }), serialized),
      )
    ) {
      return { status: "invalid", reason: "unreadable" };
    }
  } catch {
    return { status: "invalid", reason: "unreadable" };
  }
  return { status: "ready", serialized, fingerprint };
}

function isDedicatedPipedreamFile(serialized: string): boolean {
  const supported = new Set<string>(PIPEDREAM_ENV_KEYS);
  const seen = new Set<string>();
  for (const rawLine of serialized.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) return false;
    const key = line.slice(0, separator).trim();
    if (!supported.has(key) || seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function completePendingSourceCleanup(
  baseDir: string,
  pending: PendingPayload,
  durability: PipedreamCredentialDurability,
  hooks: PipedreamCredentialImportHooks = {},
): void {
  const filePath = pending.source.path;
  const quarantineDirectory = pending.source.quarantineDirectory;
  if (
    dirname(quarantineDirectory) !== dirname(filePath) ||
    !basename(quarantineDirectory).startsWith(".y-space-pipedream-")
  ) {
    throw new Error("Unable to securely remove the Pipedream setup file.");
  }
  const quarantinedPath = join(quarantineDirectory, "credentials.env");

  let phase = pending.source.phase;
  let quarantineExists = pathExists(quarantinedPath);
  let sourceExists = pathExists(filePath);

  if (phase === "source-present" && !quarantineExists && !sourceExists) {
    // The pending record alone does not prove Y Space removed this pathname.
    // A sibling process may have moved the plaintext elsewhere after commit.
    throw new Error("The Pipedream setup file changed before it could be securely removed.");
  }
  if (phase === "source-present" && !quarantineExists) {
    try {
      if (!pathExists(quarantineDirectory)) {
        mkdirSync(quarantineDirectory, { recursive: false, mode: 0o700 });
      }
      hooks.beforeQuarantineRename?.();
      renameSync(filePath, quarantinedPath);
    } catch {
      throw new Error("Unable to securely remove the Pipedream setup file.");
    }
    quarantineExists = true;
    sourceExists = pathExists(filePath);
  }

  if (phase === "source-present") {
    if (!quarantineExists || !matchesCapturedSource(quarantinedPath, pending.source.fingerprint)) {
      restoreChangedQuarantine(quarantinedPath, filePath, quarantineDirectory);
      throw new Error("The Pipedream setup file changed before it could be securely removed.");
    }
    if (sourceExists) {
      throw new Error("The Pipedream setup file changed before it could be securely removed.");
    }
    const quarantined = withPendingPhase(pending, "quarantined");
    try {
      writeCredentialPayload(baseDir, quarantined, durability);
    } catch {
      throw new Error("Unable to durably remove the Pipedream setup file.");
    }
    pending = quarantined;
    phase = "quarantined";
  }

  if (phase === "quarantined") {
    quarantineExists = pathExists(quarantinedPath);
    sourceExists = pathExists(filePath);
    if (sourceExists) {
      throw new Error("The Pipedream setup file changed before it could be securely removed.");
    }
    if (quarantineExists) {
      if (!matchesCapturedSource(quarantinedPath, pending.source.fingerprint)) {
        throw new Error("The Pipedream setup file changed before it could be securely removed.");
      }
      try {
        unlinkSync(quarantinedPath);
      } catch {
        throw new Error("Unable to securely remove the Pipedream setup file.");
      }
    }
    removeEmptyQuarantineDirectory(quarantineDirectory);
    if (pathExists(quarantinedPath) || pathExists(filePath)) {
      throw new Error("Unable to verify removal of the Pipedream setup file.");
    }
    syncRemovedSourceDirectory(filePath, durability);
    const removed = withPendingPhase(pending, "removed");
    try {
      writeCredentialPayload(baseDir, removed, durability);
    } catch {
      // The verified plaintext has been unlinked and its parent directory was
      // durably flushed. The sealed quarantined-phase record is authoritative
      // even when persisting the final phase marker fails.
      throw new PipedreamPlaintextRemovalCommittedError();
    }
    pending = removed;
    phase = "removed";
  }

  if (phase !== "removed" || pathExists(quarantinedPath) || pathExists(filePath)) {
    throw new Error("Unable to verify removal of the Pipedream setup file.");
  }
  removeEmptyQuarantineDirectory(quarantineDirectory);
}

function withPendingPhase(
  pending: PendingPayload,
  phase: PendingPayload["source"]["phase"],
): PendingPayload {
  return { ...pending, source: { ...pending.source, phase } };
}

function matchesCapturedSource(path: string, expected: SourceFingerprint): boolean {
  try {
    const current = lstatSync(path, { bigint: true });
    if (!current.isFile() || current.nlink !== 1n) return false;
    const content = readFileSync(path);
    return sameCapturedFile(expected, fingerprintOf(current, content));
  } catch {
    return false;
  }
}

function restoreChangedQuarantine(
  quarantinedPath: string,
  originalPath: string,
  quarantineDirectory: string,
): void {
  try {
    if (!pathExists(originalPath)) renameSync(quarantinedPath, originalPath);
    removeEmptyQuarantineDirectory(quarantineDirectory);
  } catch {
    // Preserve the unverified file in quarantine for explicit user recovery.
  }
}

function removeEmptyQuarantineDirectory(path: string): void {
  try {
    rmdirSync(path);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT") && !hasErrorCode(error, "ENOTEMPTY")) throw error;
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

function syncRemovedSourceDirectory(
  filePath: string,
  durability: PipedreamCredentialDurability,
): void {
  try {
    durability.syncDirectory(dirname(filePath));
  } catch {
    throw new Error("Unable to durably remove the Pipedream setup file.");
  }
}

function readCredentialPayload(baseDir: string): CredentialPayload | undefined {
  const path = storePath(baseDir);
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw new PipedreamCredentialStoreUnavailableError();
  }
  try {
    if (!metadata.isFile() || metadata.size > PIPEDREAM_CREDENTIAL_STORE_MAX_BYTES) {
      throw new Error("Invalid Pipedream credential store.");
    }
    const stored = credentialStoreSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    if (!isEncryptedSecret(stored.sealed)) throw new Error("Invalid Pipedream credential store.");
    return credentialPayloadSchema.parse(JSON.parse(decryptSecret(baseDir, stored.sealed)));
  } catch {
    // A corrupt or undecryptable record might be an interrupted source-cleanup
    // transaction. Fail closed instead of starting agents beside plaintext
    // developer credentials whose path can no longer be authenticated.
    throw new PipedreamCredentialStoreUnavailableError();
  }
}

function writeCredentialPayload(
  baseDir: string,
  payload: CredentialPayload,
  durability: PipedreamCredentialDurability,
): void {
  const stored = credentialStoreSchema.parse({
    version: 1,
    sealed: encryptSecret(baseDir, JSON.stringify(credentialPayloadSchema.parse(payload))),
  });
  const path = storePath(baseDir);
  writeFileAtomic(path, `${JSON.stringify(stored, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    durability,
  });
}

function activePayload(
  credentials: PipedreamBootstrapCredentials,
): z.infer<typeof activePayloadSchema> {
  return { version: 1, state: "active", credentials: credentialsSchema.parse(credentials) };
}

function readyBootstrap(credentials: PipedreamBootstrapCredentials): ReadyBootstrap {
  return {
    state: "ready",
    source: "secure-storage",
    credentials: credentialsSchema.parse(credentials),
  };
}

function storePath(baseDir: string): string {
  return join(baseDir, PIPEDREAM_CREDENTIAL_STORE_NAME);
}

function removeLegacyPathMetadata(baseDir: string): void {
  rmSync(join(baseDir, LEGACY_PIPEDREAM_ENV_FILE_SETTINGS_NAME), { force: true });
}

function fingerprintOf(
  metadata: ReturnType<typeof lstatSync>,
  content: string | Buffer,
): SourceFingerprint {
  const value = metadata as typeof metadata & {
    dev: bigint;
    ino: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
  };
  return {
    device: value.dev.toString(),
    inode: value.ino.toString(),
    size: value.size.toString(),
    modifiedNanoseconds: value.mtimeNs.toString(),
    changedNanoseconds: value.ctimeNs.toString(),
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function sameFingerprint(left: SourceFingerprint, right: SourceFingerprint): boolean {
  return sameCapturedFile(left, right) && left.changedNanoseconds === right.changedNanoseconds;
}

function sameCapturedFile(left: SourceFingerprint, right: SourceFingerprint): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedNanoseconds === right.modifiedNanoseconds &&
    left.sha256 === right.sha256
  );
}

function credentialStoreExists(baseDir: string): boolean {
  try {
    lstatSync(storePath(baseDir));
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw new PipedreamCredentialStoreUnavailableError();
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}
