import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFileDurability,
  type FileDurability,
  type FileDurabilityOperations,
} from "@/shared/fileDurability";

const safeStorageMock = vi.hoisted(() => ({
  decryptString: vi.fn<(value: Buffer) => string>(),
  encryptString: vi.fn<(value: string) => Buffer>(),
  getSelectedStorageBackend: vi.fn<() => string>(),
  isEncryptionAvailable: vi.fn<() => boolean>(),
}));

vi.mock("electron", () => ({ safeStorage: safeStorageMock }));

import {
  readOrCreateSafeStorageSecretKey,
  SecretStorageKeyUnavailableError,
} from "./secretStorageKey";

describe("readOrCreateSafeStorageSecretKey", () => {
  let dir: string;
  let consoleWarn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "poracode-safe-storage-"));
    consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    safeStorageMock.decryptString.mockReset();
    safeStorageMock.encryptString.mockReset().mockImplementation((value) => Buffer.from(value));
    safeStorageMock.getSelectedStorageBackend.mockReset().mockReturnValue("gnome_libsecret");
    safeStorageMock.isEncryptionAvailable.mockReset().mockReturnValue(true);
  });

  afterEach(() => {
    consoleWarn.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    { available: false, backend: "gnome_libsecret" },
    { available: true, backend: "basic_text" },
  ])(
    "uses a session-only key when secure Linux storage is unavailable",
    ({ available, backend }) => {
      safeStorageMock.isEncryptionAvailable.mockReturnValue(available);
      safeStorageMock.getSelectedStorageBackend.mockReturnValue(backend);

      const first = readOrCreateSafeStorageSecretKey(dir, "linux");
      const second = readOrCreateSafeStorageSecretKey(dir, "linux");

      expect(Buffer.from(first.key, "base64")).toHaveLength(32);
      expect(Buffer.from(second.key, "base64")).toHaveLength(32);
      expect(second).toEqual(first);
      expect(first.persistent).toBe(false);
      expect(safeStorageMock.encryptString).not.toHaveBeenCalled();
      expect(safeStorageMock.decryptString).not.toHaveBeenCalled();
      expect(() => readFileSync(join(dir, "secret-key.safe"))).toThrow(/ENOENT|no such file/i);
      expect(consoleWarn).toHaveBeenCalledWith(
        "[credential-storage] secure OS encryption is unavailable; credentials are session-only.",
      );
    },
  );

  it("starts Windows with a session-only key when namespace durability is unavailable", () => {
    const operations: FileDurabilityOperations = {
      open: vi.fn<(path: string, flags: "r" | "r+") => number>(),
      sync: vi.fn<(descriptor: number) => void>(),
      close: vi.fn<(descriptor: number) => void>(),
    };
    const durability = createFileDurability("win32", operations);

    const key = readOrCreateSafeStorageSecretKey(dir, "win32", durability);

    expect(Buffer.from(key.key, "base64")).toHaveLength(32);
    expect(key.persistent).toBe(false);
    expect(safeStorageMock.encryptString).not.toHaveBeenCalled();
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled();
    expect(() => readFileSync(join(dir, "secret-key.safe"))).toThrow(/ENOENT|no such file/i);
    expect(operations.open).not.toHaveBeenCalled();
    expect(operations.sync).not.toHaveBeenCalled();
    expect(operations.close).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalledWith(
      "[credential-storage] durable namespace commits are unavailable; credentials are session-only.",
    );
  });

  it("can use an existing Windows key for the session without claiming persistence", () => {
    const path = join(dir, "secret-key.safe");
    const canonicalKey = Buffer.alloc(32, 9).toString("base64");
    const serialized = Buffer.from("existing-windows-sealed-key").toString("base64");
    writeFileSync(path, serialized);
    safeStorageMock.decryptString.mockReturnValue(canonicalKey);
    const operations: FileDurabilityOperations = {
      open: vi.fn<(path: string, flags: "r" | "r+") => number>(),
      sync: vi.fn<(descriptor: number) => void>(),
      close: vi.fn<(descriptor: number) => void>(),
    };

    const key = readOrCreateSafeStorageSecretKey(
      dir,
      "win32",
      createFileDurability("win32", operations),
    );

    expect(key).toEqual({ key: canonicalKey, persistent: false });
    expect(safeStorageMock.decryptString).toHaveBeenCalledExactlyOnceWith(
      Buffer.from("existing-windows-sealed-key"),
    );
    expect(safeStorageMock.encryptString).not.toHaveBeenCalled();
    expect(readFileSync(path, "utf8")).toBe(serialized);
    expect(operations.open).not.toHaveBeenCalled();
    expect(operations.sync).not.toHaveBeenCalled();
    expect(operations.close).not.toHaveBeenCalled();
  });

  it.each([
    { available: false, backend: "gnome_libsecret" },
    { available: true, backend: "basic_text" },
  ])(
    "fails closed when secure storage is unavailable beside an existing master blob",
    ({ available, backend }) => {
      const path = join(dir, "secret-key.safe");
      const serialized = Buffer.from("existing-sealed-master-key").toString("base64");
      writeFileSync(path, serialized);
      safeStorageMock.isEncryptionAvailable.mockReturnValue(available);
      safeStorageMock.getSelectedStorageBackend.mockReturnValue(backend);

      expect(() => readOrCreateSafeStorageSecretKey(dir, "linux")).toThrow(
        SecretStorageKeyUnavailableError,
      );
      expect(readFileSync(path, "utf8")).toBe(serialized);
      expect(safeStorageMock.encryptString).not.toHaveBeenCalled();
      expect(consoleWarn).not.toHaveBeenCalled();
    },
  );

  it("persists a newly generated key only through safeStorage encryption", () => {
    safeStorageMock.encryptString.mockImplementation(() => Buffer.from("sealed-key"));

    const key = readOrCreateSafeStorageSecretKey(dir, "linux");

    expect(Buffer.from(key.key, "base64")).toHaveLength(32);
    expect(key.persistent).toBe(true);
    expect(safeStorageMock.encryptString).toHaveBeenCalledWith(key.key);
    expect(readFileSync(join(dir, "secret-key.safe"), "utf8")).toBe(
      Buffer.from("sealed-key").toString("base64"),
    );
  });

  it("flushes the encrypted key file and its directory before reporting persistence", () => {
    safeStorageMock.encryptString.mockImplementation(() => Buffer.from("sealed-key"));
    const order: string[] = [];
    const durability: FileDurability = {
      syncFile: (path) => {
        expect(readFileSync(path, "utf8")).toBe(Buffer.from("sealed-key").toString("base64"));
        order.push(`file:${path}`);
      },
      syncDirectory: (path) => order.push(`directory:${path}`),
    };

    expect(readOrCreateSafeStorageSecretKey(dir, "linux", durability).persistent).toBe(true);
    expect(order).toEqual([
      expect.stringMatching(
        new RegExp(`^file:${join(dir, `secret-key\\.safe\\.${process.pid}\\.`)}.+\\.tmp$`),
      ),
      `directory:${dir}`,
    ]);
  });

  it("does not report a key as persistent when its durable flush fails", () => {
    safeStorageMock.encryptString.mockImplementation(() => Buffer.from("sealed-key"));
    const syncDirectory = vi.fn<(path: string) => void>();
    const durability: FileDurability = {
      syncFile: () => {
        throw new Error("simulated key flush failure");
      },
      syncDirectory,
    };

    expect(() => readOrCreateSafeStorageSecretKey(dir, "linux", durability)).toThrow(
      "Unable to persist the encrypted Y Space secret storage key.",
    );
    expect(syncDirectory).not.toHaveBeenCalled();
  });

  it("repairs a prior post-rename directory flush before trusting the key on relaunch", () => {
    safeStorageMock.encryptString.mockImplementation((value) => Buffer.from(value, "utf8"));
    safeStorageMock.decryptString.mockImplementation((value) => value.toString("utf8"));
    const firstDurability: FileDurability = {
      syncFile: () => undefined,
      syncDirectory: () => {
        throw new Error("simulated post-rename directory flush failure");
      },
    };

    expect(() => readOrCreateSafeStorageSecretKey(dir, "linux", firstDurability)).toThrow(
      "Unable to persist the encrypted Y Space secret storage key.",
    );
    expect(readFileSync(join(dir, "secret-key.safe"), "utf8")).not.toBe("");

    const repairedDirectories: string[] = [];
    const secondDurability: FileDurability = {
      syncFile: () => undefined,
      syncDirectory: (path) => repairedDirectories.push(path),
    };
    const relaunched = readOrCreateSafeStorageSecretKey(dir, "linux", secondDurability);

    expect(relaunched.persistent).toBe(true);
    expect(repairedDirectories).toEqual([dir]);
  });

  it("preserves an undecryptable stored key and fails closed", () => {
    const serialized = Buffer.from("old-sealed-key").toString("base64");
    writeFileSync(join(dir, "secret-key.safe"), serialized);
    safeStorageMock.decryptString.mockImplementation(() => {
      throw new Error("unexpected crypto details");
    });

    expect(() => readOrCreateSafeStorageSecretKey(dir, "linux")).toThrow(
      SecretStorageKeyUnavailableError,
    );
    expect(() => readOrCreateSafeStorageSecretKey(dir, "linux")).toThrow(
      "Y Space credential storage is locked.",
    );
    expect(readFileSync(join(dir, "secret-key.safe"), "utf8")).toBe(serialized);
    expect(safeStorageMock.encryptString).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalledWith(expect.stringContaining("unexpected crypto"));
  });

  it("preserves a stored blob whose decrypted key is invalid", () => {
    const serialized = Buffer.from("old-sealed-key").toString("base64");
    writeFileSync(join(dir, "secret-key.safe"), serialized);
    safeStorageMock.decryptString.mockReturnValue(Buffer.alloc(16).toString("base64"));

    expect(() => readOrCreateSafeStorageSecretKey(dir, "linux")).toThrow(
      SecretStorageKeyUnavailableError,
    );
    expect(readFileSync(join(dir, "secret-key.safe"), "utf8")).toBe(serialized);
    expect(safeStorageMock.encryptString).not.toHaveBeenCalled();
  });

  it("rejects a noncanonical decrypted key before starting the supervisor", () => {
    const serialized = Buffer.from("old-sealed-key").toString("base64");
    const canonicalKey = Buffer.alloc(32, 7).toString("base64");
    writeFileSync(join(dir, "secret-key.safe"), serialized);
    safeStorageMock.decryptString.mockReturnValue(`${canonicalKey}\n`);

    expect(() => readOrCreateSafeStorageSecretKey(dir, "linux")).toThrow(
      SecretStorageKeyUnavailableError,
    );
    expect(readFileSync(join(dir, "secret-key.safe"), "utf8")).toBe(serialized);
    expect(safeStorageMock.encryptString).not.toHaveBeenCalled();
  });

  it("keeps unexpected encryption failures observable without leaking the key", () => {
    safeStorageMock.encryptString.mockImplementation(() => {
      throw new Error("crypto backend details");
    });

    expect(() => readOrCreateSafeStorageSecretKey(dir, "linux")).toThrow(
      "Unable to encrypt the Y Space secret storage key.",
    );
    expect(() => readFileSync(join(dir, "secret-key.safe"))).toThrow(/ENOENT|no such file/i);
  });
});
