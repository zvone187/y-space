import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PIPEDREAM_ENV_FILE_MAX_BYTES, type PipedreamBootstrap } from "@/shared/pipedreamBootstrap";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "@/shared/secretStorage";
import {
  applyPersistedPipedreamCredentials,
  clearPipedreamCredentials,
  createPipedreamCredentialStore,
  importPipedreamCredentialFile,
  PipedreamCredentialClearError,
  PipedreamCredentialImportCommittedError,
  type PipedreamCredentialDurability,
  PipedreamCredentialStoreUnavailableError,
  resetPipedreamCredentialsAfterConfirmedSourceRemoval,
} from "./pipedreamCredentialStore";

const tempRoots: string[] = [];
const ENVIRONMENT_FILE = [
  "PIPEDREAM_CLIENT_ID=secure-client-id",
  "PIPEDREAM_CLIENT_SECRET=secure-client-secret",
  "PIPEDREAM_PROJECT_ID=proj_Secure123",
  "PIPEDREAM_ENVIRONMENT=production",
].join("\n");

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "y-space-pipedream-credentials-"));
  tempRoots.push(root);
  return root;
}

function sourceFingerprint(path: string) {
  const metadata = lstatSync(path, { bigint: true });
  const content = readFileSync(path);
  return {
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
    size: metadata.size.toString(),
    modifiedNanoseconds: metadata.mtimeNs.toString(),
    changedNanoseconds: metadata.ctimeNs.toString(),
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Pipedream credential store", () => {
  it("moves a dedicated setup file into sealed owner-only storage and restores it after restart", () => {
    const root = tempRoot();
    const sourcePath = join(root, ".env.pipedream");
    writeFileSync(sourcePath, ENVIRONMENT_FILE, { mode: 0o600 });

    expect(importPipedreamCredentialFile(root, sourcePath)).toMatchObject({
      status: "configured",
      bootstrap: {
        state: "ready",
        source: "secure-storage",
        credentials: { projectId: "proj_Secure123", environment: "production" },
      },
    });

    expect(existsSync(sourcePath)).toBe(false);
    const storePath = join(root, "pipedream-credentials.json");
    const raw = readFileSync(storePath, "utf8");
    const stored = JSON.parse(raw) as { version: number; sealed: string };
    expect(Object.keys(stored).sort()).toEqual(["sealed", "version"]);
    expect(isEncryptedSecret(stored.sealed)).toBe(true);
    expect(raw).not.toMatch(/secure-client|proj_Secure123|\.env\.pipedream/);
    expect(process.platform === "win32" || (statSync(storePath).mode & 0o077) === 0).toBe(true);

    expect(applyPersistedPipedreamCredentials(root, { state: "absent" })).toMatchObject({
      state: "ready",
      source: "secure-storage",
      credentials: { projectId: "proj_Secure123" },
    });
  });

  it("durably orders pending storage, source deletion, and active storage", () => {
    const root = tempRoot();
    const sourcePath = join(root, ".env.pipedream");
    const storePath = join(root, "pipedream-credentials.json");
    writeFileSync(sourcePath, ENVIRONMENT_FILE, { mode: 0o600 });
    const order: string[] = [];
    const storedState = (path = storePath) =>
      (
        JSON.parse(
          decryptSecret(
            root,
            (JSON.parse(readFileSync(path, "utf8")) as { sealed: string }).sealed,
          ),
        ) as { state: string }
      ).state;
    const durability: PipedreamCredentialDurability = {
      syncFile: (path) => {
        order.push(`temp:${storedState(path)}:${existsSync(sourcePath) ? "source" : "removed"}`);
      },
      syncDirectory: () => {
        order.push(`dir:${storedState()}:${existsSync(sourcePath) ? "source" : "removed"}`);
      },
    };

    expect(importPipedreamCredentialFile(root, sourcePath, durability).status).toBe("configured");
    expect(order).toEqual([
      "temp:pending-source-cleanup:source",
      "dir:pending-source-cleanup:source",
      "temp:pending-source-cleanup:removed",
      "dir:pending-source-cleanup:removed",
      "dir:pending-source-cleanup:removed",
      "temp:pending-source-cleanup:removed",
      "dir:pending-source-cleanup:removed",
      "temp:active:removed",
      "dir:active:removed",
    ]);
  });

  it("never deletes the source when the pending record cannot be durably flushed", () => {
    const root = tempRoot();
    const sourcePath = join(root, ".env.pipedream");
    writeFileSync(sourcePath, ENVIRONMENT_FILE, { mode: 0o600 });
    const durability: PipedreamCredentialDurability = {
      syncFile: () => {
        throw new Error("simulated pending flush failure");
      },
      syncDirectory: () => undefined,
    };

    expect(() => importPipedreamCredentialFile(root, sourcePath, durability)).toThrow(
      "simulated pending flush failure",
    );
    expect(readFileSync(sourcePath, "utf8")).toBe(ENVIRONMENT_FILE);
  });

  it("leaves a recoverable pending record when the source-directory flush fails after unlink", () => {
    const root = tempRoot();
    const sourcePath = join(root, ".env.pipedream");
    const storePath = join(root, "pipedream-credentials.json");
    writeFileSync(sourcePath, ENVIRONMENT_FILE, { mode: 0o600 });
    const failingDurability: PipedreamCredentialDurability = {
      syncFile: () => undefined,
      syncDirectory: () => {
        if (!existsSync(sourcePath)) throw new Error("simulated source directory flush failure");
      },
    };

    expect(() => importPipedreamCredentialFile(root, sourcePath, failingDurability)).toThrow(
      "Unable to durably remove the Pipedream setup file.",
    );
    expect(existsSync(sourcePath)).toBe(false);
    const pending = JSON.parse(
      decryptSecret(
        root,
        (JSON.parse(readFileSync(storePath, "utf8")) as { sealed: string }).sealed,
      ),
    ) as { state: string };
    expect(pending.state).toBe("pending-source-cleanup");

    const noOpDurability: PipedreamCredentialDurability = {
      syncFile: () => undefined,
      syncDirectory: () => undefined,
    };
    expect(
      applyPersistedPipedreamCredentials(root, { state: "absent" }, noOpDurability),
    ).toMatchObject({ state: "ready", source: "secure-storage" });
  });

  it("never exposes the selected path or credential values in durability failures", () => {
    const root = tempRoot();
    const sourcePath = join(root, "private-client-secret.env");
    writeFileSync(sourcePath, ENVIRONMENT_FILE, { mode: 0o600 });
    const durability: PipedreamCredentialDurability = {
      syncFile: () => undefined,
      syncDirectory: () => {
        if (!existsSync(sourcePath)) {
          throw new Error(`failed at ${sourcePath}: secure-client-secret`);
        }
      },
    };

    let message = "";
    try {
      importPipedreamCredentialFile(root, sourcePath, durability);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Unable to durably remove the Pipedream setup file.");
    expect(message).not.toContain(sourcePath);
    expect(message).not.toContain("secure-client-secret");
  });

  it("keeps the durable pending record when the active temp flush fails after source removal", () => {
    const root = tempRoot();
    const sourcePath = join(root, ".env.pipedream");
    const storePath = join(root, "pipedream-credentials.json");
    writeFileSync(sourcePath, ENVIRONMENT_FILE, { mode: 0o600 });
    let fileFlushes = 0;
    const durability: PipedreamCredentialDurability = {
      syncFile: (path) => {
        fileFlushes += 1;
        const state = (
          JSON.parse(
            decryptSecret(
              root,
              (JSON.parse(readFileSync(path, "utf8")) as { sealed: string }).sealed,
            ),
          ) as { state: string }
        ).state;
        if (state === "active") throw new Error("simulated active temp flush failure");
      },
      syncDirectory: () => undefined,
    };

    expect(() => importPipedreamCredentialFile(root, sourcePath, durability)).toThrow(
      PipedreamCredentialImportCommittedError,
    );
    expect(existsSync(sourcePath)).toBe(false);
    expect(fileFlushes).toBe(4);
    const persisted = JSON.parse(
      decryptSecret(
        root,
        (JSON.parse(readFileSync(storePath, "utf8")) as { sealed: string }).sealed,
      ),
    ) as { state: string };
    expect(persisted.state).toBe("pending-source-cleanup");

    const noOpDurability: PipedreamCredentialDurability = {
      syncFile: () => undefined,
      syncDirectory: () => undefined,
    };
    expect(
      applyPersistedPipedreamCredentials(root, { state: "absent" }, noOpDurability),
    ).toMatchObject({ state: "ready", source: "secure-storage" });
  });

  it("reports a committed import when the removed-phase marker cannot be flushed", () => {
    const root = tempRoot();
    const sourcePath = join(root, ".env.pipedream");
    const storePath = join(root, "pipedream-credentials.json");
    writeFileSync(sourcePath, ENVIRONMENT_FILE, { mode: 0o600 });
    const durability: PipedreamCredentialDurability = {
      syncFile: (path) => {
        const payload = JSON.parse(
          decryptSecret(
            root,
            (JSON.parse(readFileSync(path, "utf8")) as { sealed: string }).sealed,
          ),
        ) as { state: string; source?: { phase?: string } };
        if (payload.source?.phase === "removed") {
          throw new Error("simulated removed marker flush failure");
        }
      },
      syncDirectory: () => undefined,
    };

    let error: unknown;
    try {
      importPipedreamCredentialFile(root, sourcePath, durability);
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(PipedreamCredentialImportCommittedError);
    expect((error as PipedreamCredentialImportCommittedError).bootstrap).toMatchObject({
      state: "ready",
      credentials: { projectId: "proj_Secure123" },
    });
    expect(existsSync(sourcePath)).toBe(false);
    const persisted = JSON.parse(
      decryptSecret(
        root,
        (JSON.parse(readFileSync(storePath, "utf8")) as { sealed: string }).sealed,
      ),
    ) as { source: { phase: string } };
    expect(persisted.source.phase).toBe("quarantined");

    expect(
      applyPersistedPipedreamCredentials(
        root,
        { state: "absent" },
        {
          syncFile: () => undefined,
          syncDirectory: () => undefined,
        },
      ),
    ).toMatchObject({ state: "ready", source: "secure-storage" });
  });

  it("flushes a missing pending source directory before active promotion", () => {
    const root = tempRoot();
    const sourcePath = join(root, ".env.pipedream");
    writeFileSync(sourcePath, ENVIRONMENT_FILE, { mode: 0o600 });
    const initialDurability: PipedreamCredentialDurability = {
      syncFile: () => undefined,
      syncDirectory: () => {
        if (!existsSync(sourcePath)) throw new Error("leave pending after unlink");
      },
    };
    expect(() => importPipedreamCredentialFile(root, sourcePath, initialDurability)).toThrow(
      "Unable to durably remove the Pipedream setup file.",
    );
    expect(existsSync(sourcePath)).toBe(false);

    const resumedOrder: string[] = [];
    const resumedDurability: PipedreamCredentialDurability = {
      syncFile: () => resumedOrder.push("active-temp"),
      syncDirectory: (path) => resumedOrder.push(`directory:${path}`),
    };
    expect(
      applyPersistedPipedreamCredentials(root, { state: "absent" }, resumedDurability),
    ).toMatchObject({ state: "ready", source: "secure-storage" });
    expect(resumedOrder).toEqual([
      `directory:${root}`,
      `directory:${root}`,
      "active-temp",
      `directory:${root}`,
      "active-temp",
      `directory:${root}`,
    ]);
  });

  it("resumes an encrypted pending cleanup without exposing its source path", () => {
    const root = tempRoot();
    const sourcePath = join(root, ".env.pipedream");
    writeFileSync(sourcePath, ENVIRONMENT_FILE, { mode: 0o600 });
    const pending = {
      version: 1,
      state: "pending-source-cleanup",
      credentials: {
        clientId: "pending-client-id",
        clientSecret: "pending-client-secret",
        projectId: "proj_Pending123",
        environment: "development",
      },
      source: {
        path: sourcePath,
        fingerprint: sourceFingerprint(sourcePath),
        phase: "source-present",
        quarantineDirectory: join(root, ".y-space-pipedream-resume.pending"),
      },
    };
    const storePath = join(root, "pipedream-credentials.json");
    writeFileSync(
      storePath,
      JSON.stringify({ version: 1, sealed: encryptSecret(root, JSON.stringify(pending)) }),
      { mode: 0o600 },
    );

    expect(readFileSync(storePath, "utf8")).not.toContain(sourcePath);
    expect(applyPersistedPipedreamCredentials(root, { state: "absent" })).toMatchObject({
      state: "ready",
      source: "secure-storage",
      credentials: { projectId: "proj_Pending123" },
    });
    expect(existsSync(sourcePath)).toBe(false);
    const active = JSON.parse(
      decryptSecret(
        root,
        (JSON.parse(readFileSync(storePath, "utf8")) as { sealed: string }).sealed,
      ),
    ) as { state: string; source?: unknown };
    expect(active).toMatchObject({ state: "active" });
    expect(active).not.toHaveProperty("source");
  });

  it("fails closed when a pending source changes instead of deleting an unverified file", () => {
    const root = tempRoot();
    const sourcePath = join(root, ".env.pipedream");
    writeFileSync(sourcePath, ENVIRONMENT_FILE, { mode: 0o600 });
    const sealed = encryptSecret(
      root,
      JSON.stringify({
        version: 1,
        state: "pending-source-cleanup",
        credentials: {
          clientId: "pending-client-id",
          clientSecret: "pending-client-secret",
          projectId: "proj_Pending123",
          environment: "development",
        },
        source: {
          path: sourcePath,
          fingerprint: sourceFingerprint(sourcePath),
          phase: "source-present",
          quarantineDirectory: join(root, ".y-space-pipedream-changed.pending"),
        },
      }),
    );
    const storePath = join(root, "pipedream-credentials.json");
    writeFileSync(storePath, JSON.stringify({ version: 1, sealed }), { mode: 0o600 });
    writeFileSync(sourcePath, `${ENVIRONMENT_FILE}\n# changed after staging\n`);

    expect(() => applyPersistedPipedreamCredentials(root, { state: "absent" })).toThrow(
      PipedreamCredentialStoreUnavailableError,
    );
    expect(existsSync(sourcePath)).toBe(true);
    expect(readFileSync(storePath, "utf8")).not.toMatch(
      /pending-client|proj_Pending123|\.env\.pipedream/,
    );
  });

  it("does not delete a pathname replacement raced in immediately before quarantine", () => {
    const root = tempRoot();
    const sourcePath = join(root, ".env.pipedream");
    const originalBackup = join(root, "original-backup.env");
    const replacement = "unrelated replacement file\n";
    writeFileSync(sourcePath, ENVIRONMENT_FILE, { mode: 0o600 });
    const durability: PipedreamCredentialDurability = {
      syncFile: () => undefined,
      syncDirectory: () => undefined,
    };

    expect(() =>
      importPipedreamCredentialFile(root, sourcePath, durability, {
        beforeQuarantineRename: () => {
          renameSync(sourcePath, originalBackup);
          writeFileSync(sourcePath, replacement, { mode: 0o600 });
        },
      }),
    ).toThrow("changed before it could be securely removed");

    expect(readFileSync(sourcePath, "utf8")).toBe(replacement);
    expect(readFileSync(originalBackup, "utf8")).toBe(ENVIRONMENT_FILE);
  });

  it("does not activate when the source disappears after the pending record commits", () => {
    const root = tempRoot();
    const sourcePath = join(root, ".env.pipedream");
    const movedPath = join(root, "moved-by-sibling.env");
    writeFileSync(sourcePath, ENVIRONMENT_FILE, { mode: 0o600 });
    const durability: PipedreamCredentialDurability = {
      syncFile: () => undefined,
      syncDirectory: () => undefined,
    };

    expect(() =>
      importPipedreamCredentialFile(root, sourcePath, durability, {
        afterPendingPersisted: () => renameSync(sourcePath, movedPath),
      }),
    ).toThrow("changed before it could be securely removed");
    expect(readFileSync(movedPath, "utf8")).toBe(ENVIRONMENT_FILE);
    expect(existsSync(sourcePath)).toBe(false);
  });

  it("rejects a same-size rewrite even when its mtime is restored", () => {
    const root = tempRoot();
    const sourcePath = join(root, ".env.pipedream");
    writeFileSync(sourcePath, ENVIRONMENT_FILE, { mode: 0o600 });
    const before = statSync(sourcePath);
    const changed = ENVIRONMENT_FILE.replace("secure-client-id", "alterd-client-id");
    expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(ENVIRONMENT_FILE));
    const durability: PipedreamCredentialDurability = {
      syncFile: () => undefined,
      syncDirectory: () => undefined,
    };

    expect(() =>
      importPipedreamCredentialFile(root, sourcePath, durability, {
        beforeQuarantineRename: () => {
          writeFileSync(sourcePath, changed, { mode: 0o600 });
          utimesSync(sourcePath, before.atime, before.mtime);
        },
      }),
    ).toThrow("changed before it could be securely removed");
    expect(readFileSync(sourcePath, "utf8")).toBe(changed);
  });

  it("rejects partial, mixed-purpose, oversized, symlinked, and hard-linked setup files", () => {
    const root = tempRoot();
    const cases: Array<{ name: string; expected: string; prepare: (path: string) => void }> = [
      {
        name: "partial",
        expected: "incomplete-values",
        prepare: (path) => writeFileSync(path, "PIPEDREAM_CLIENT_ID=only-one\n"),
      },
      {
        name: "mixed",
        expected: "not-dedicated",
        prepare: (path) => writeFileSync(path, `${ENVIRONMENT_FILE}\nOTHER_SECRET=keep-me\n`),
      },
      {
        name: "invalid-values",
        expected: "invalid-values",
        prepare: (path) =>
          writeFileSync(path, ENVIRONMENT_FILE.replace("proj_Secure123", "invalid-project-id")),
      },
      {
        name: "oversized-project-id",
        expected: "invalid-values",
        prepare: (path) =>
          writeFileSync(
            path,
            ENVIRONMENT_FILE.replace("proj_Secure123", `proj_${"a".repeat(200_000)}`),
          ),
      },
      {
        name: "oversized",
        expected: "too-large",
        prepare: (path) => writeFileSync(path, "x".repeat(PIPEDREAM_ENV_FILE_MAX_BYTES + 1)),
      },
      {
        name: "symlink",
        expected: "unreadable",
        prepare: (path) => {
          const target = `${path}.target`;
          writeFileSync(target, ENVIRONMENT_FILE);
          symlinkSync(target, path);
        },
      },
      {
        name: "hardlink",
        expected: "unreadable",
        prepare: (path) => {
          const target = `${path}.target`;
          writeFileSync(target, ENVIRONMENT_FILE);
          linkSync(target, path);
        },
      },
    ];

    for (const entry of cases) {
      const path = join(root, `${entry.name}.env`);
      entry.prepare(path);
      expect(importPipedreamCredentialFile(root, path)).toEqual({
        status: "invalid",
        reason: entry.expected,
      });
      expect(existsSync(path)).toBe(true);
    }
    expect(existsSync(join(root, "pipedream-credentials.json"))).toBe(false);
  });

  it("does not modify or remove a setup file when only a session key is available", () => {
    const root = tempRoot();
    const sourcePath = join(root, ".env.pipedream");
    writeFileSync(sourcePath, ENVIRONMENT_FILE, { mode: 0o600 });
    const store = createPipedreamCredentialStore(root, { appIsolatedPersistentKey: false });

    expect(store.importEnvironmentFile(sourcePath)).toEqual({
      status: "invalid",
      reason: "secure-storage-unavailable",
    });
    expect(readFileSync(sourcePath, "utf8")).toBe(ENVIRONMENT_FILE);
    expect(existsSync(join(root, "pipedream-credentials.json"))).toBe(false);
  });

  it("requires explicit recovery instead of ignoring a store under a new session-only key", () => {
    const root = tempRoot();
    const sourcePath = join(root, ".env.pipedream");
    writeFileSync(sourcePath, ENVIRONMENT_FILE, { mode: 0o600 });
    importPipedreamCredentialFile(root, sourcePath);
    const store = createPipedreamCredentialStore(root, { appIsolatedPersistentKey: false });

    expect(() => store.applyPersisted({ state: "absent" })).toThrow(
      "Pipedream secure storage is unavailable.",
    );
  });

  it("fails closed without rewriting an unreadable secure store", () => {
    const root = tempRoot();
    const storePath = join(root, "pipedream-credentials.json");
    writeFileSync(storePath, JSON.stringify({ version: 1, sealed: "not-encrypted" }), {
      mode: 0o600,
    });
    const before = readFileSync(storePath, "utf8");

    expect(() => applyPersistedPipedreamCredentials(root, { state: "absent" })).toThrow(
      "Pipedream secure storage is unavailable.",
    );
    expect(readFileSync(storePath, "utf8")).toBe(before);
  });

  it("refuses to reset an unreadable store whose hidden plaintext locator cannot be authenticated", () => {
    const root = tempRoot();
    const storePath = join(root, "pipedream-credentials.json");
    const before = JSON.stringify({ version: 1, sealed: "not-encrypted" });
    writeFileSync(storePath, before, { mode: 0o600 });

    let error: unknown;
    try {
      resetPipedreamCredentialsAfterConfirmedSourceRemoval(root);
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(PipedreamCredentialClearError);
    expect((error as PipedreamCredentialClearError).credentialsRemoved).toBe(false);
    expect(readFileSync(storePath, "utf8")).toBe(before);
    expect(existsSync(join(root, "pipedream-credentials.recovery.json"))).toBe(false);
  });

  it("keeps explicit process credentials ahead of an active secure record", () => {
    const root = tempRoot();
    const sourcePath = join(root, ".env.pipedream");
    writeFileSync(sourcePath, ENVIRONMENT_FILE, { mode: 0o600 });
    importPipedreamCredentialFile(root, sourcePath);
    const explicit: PipedreamBootstrap = {
      state: "ready",
      source: "environment",
      credentials: {
        clientId: "explicit-client",
        clientSecret: "explicit-secret",
        projectId: "proj_Explicit123",
        environment: "development",
      },
    };

    expect(applyPersistedPipedreamCredentials(root, explicit)).toBe(explicit);
  });

  it("clears sealed credentials and obsolete path metadata", () => {
    const root = tempRoot();
    const sourcePath = join(root, ".env.pipedream");
    writeFileSync(sourcePath, ENVIRONMENT_FILE, { mode: 0o600 });
    importPipedreamCredentialFile(root, sourcePath);
    const legacyPath = join(root, "pipedream-env-file.json");
    writeFileSync(legacyPath, JSON.stringify({ version: 1, envFilePath: sourcePath }));
    chmodSync(legacyPath, 0o600);

    clearPipedreamCredentials(root);

    expect(existsSync(join(root, "pipedream-credentials.json"))).toBe(false);
    expect(existsSync(legacyPath)).toBe(false);
  });

  it("reports that credentials were removed when the final directory flush fails", () => {
    const root = tempRoot();
    const sourcePath = join(root, ".env.pipedream");
    writeFileSync(sourcePath, ENVIRONMENT_FILE, { mode: 0o600 });
    importPipedreamCredentialFile(root, sourcePath);
    const durability: PipedreamCredentialDurability = {
      syncFile: () => undefined,
      syncDirectory: () => {
        throw new Error("simulated final directory flush failure");
      },
    };

    let error: unknown;
    try {
      clearPipedreamCredentials(root, durability);
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(PipedreamCredentialClearError);
    expect((error as PipedreamCredentialClearError).credentialsRemoved).toBe(true);
    expect(existsSync(join(root, "pipedream-credentials.json"))).toBe(false);
  });

  it("repairs a prior post-unlink directory flush before trusting absence on relaunch", () => {
    const root = tempRoot();
    const sourcePath = join(root, ".env.pipedream");
    writeFileSync(sourcePath, ENVIRONMENT_FILE, { mode: 0o600 });
    importPipedreamCredentialFile(root, sourcePath);
    const firstDurability: PipedreamCredentialDurability = {
      syncFile: () => undefined,
      syncDirectory: () => {
        throw new Error("simulated post-unlink directory flush failure");
      },
    };

    expect(() => clearPipedreamCredentials(root, firstDurability)).toThrow(
      PipedreamCredentialClearError,
    );
    expect(existsSync(join(root, "pipedream-credentials.json"))).toBe(false);

    const repairedDirectories: string[] = [];
    const secondDurability: PipedreamCredentialDurability = {
      syncFile: () => undefined,
      syncDirectory: (path) => repairedDirectories.push(path),
    };
    expect(applyPersistedPipedreamCredentials(root, { state: "absent" }, secondDurability)).toEqual(
      { state: "absent" },
    );
    expect(repairedDirectories).toEqual([root]);
  });

  it("forgets legacy path metadata without silently deleting its source", () => {
    const root = tempRoot();
    const sourcePath = join(root, ".env.pipedream");
    const legacyPath = join(root, "pipedream-env-file.json");
    writeFileSync(sourcePath, ENVIRONMENT_FILE, { mode: 0o600 });
    writeFileSync(legacyPath, JSON.stringify({ version: 1, envFilePath: sourcePath }), {
      mode: 0o600,
    });

    expect(applyPersistedPipedreamCredentials(root, { state: "absent" })).toEqual({
      state: "absent",
    });
    expect(existsSync(legacyPath)).toBe(false);
    expect(readFileSync(sourcePath, "utf8")).toBe(ENVIRONMENT_FILE);
  });
});
