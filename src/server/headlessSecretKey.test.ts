import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFileDurability,
  type FileDurability,
  type FileDurabilityOperations,
} from "@/shared/fileDurability";
import { readOrCreateHeadlessSecretKey } from "./headlessSecretKey";

describe("readOrCreateHeadlessSecretKey", () => {
  let baseDir: string;
  const savedEnv = process.env.PORACODE_SECRET_STORAGE_KEY;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "lc-key-"));
    delete process.env.PORACODE_SECRET_STORAGE_KEY;
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env.PORACODE_SECRET_STORAGE_KEY;
    else process.env.PORACODE_SECRET_STORAGE_KEY = savedEnv;
  });

  it("generates a 32-byte base64 key and persists it for reuse", () => {
    const first = readOrCreateHeadlessSecretKey(baseDir);
    expect(Buffer.from(first, "base64")).toHaveLength(32);

    const onDisk = readFileSync(join(baseDir, "secret-key.headless"), "utf8").trim();
    expect(onDisk).toBe(first);

    // A second call reads the persisted key rather than minting a new one.
    expect(readOrCreateHeadlessSecretKey(baseDir)).toBe(first);
  });

  it("durably flushes a newly generated key before returning it", () => {
    const order: string[] = [];
    const durability: FileDurability = {
      syncFile: (path) => order.push(`file:${path}`),
      syncDirectory: (path) => order.push(`directory:${path}`),
    };

    readOrCreateHeadlessSecretKey(baseDir, durability);

    expect(order).toHaveLength(2);
    expect(order[0]).toMatch(/file:.*secret-key\.headless\..*\.tmp$/);
    expect(order[1]).toBe(`directory:${baseDir}`);
  });

  it("repairs a prior post-rename directory flush before trusting the key on relaunch", () => {
    const firstDurability: FileDurability = {
      syncFile: () => undefined,
      syncDirectory: () => {
        throw new Error("simulated post-rename directory flush failure");
      },
    };
    expect(() => readOrCreateHeadlessSecretKey(baseDir, firstDurability)).toThrow(
      "simulated post-rename directory flush failure",
    );
    const visibleKey = readFileSync(join(baseDir, "secret-key.headless"), "utf8");

    const repairedDirectories: string[] = [];
    const secondDurability: FileDurability = {
      syncFile: () => undefined,
      syncDirectory: (path) => repairedDirectories.push(path),
    };
    expect(readOrCreateHeadlessSecretKey(baseDir, secondDurability)).toBe(visibleKey);
    expect(repairedDirectories).toEqual([baseDir]);
  });

  it("prefers a valid key from the environment over the file", () => {
    const envKey = Buffer.alloc(32, 3).toString("base64");
    process.env.PORACODE_SECRET_STORAGE_KEY = envKey;
    expect(readOrCreateHeadlessSecretKey(baseDir)).toBe(envKey);
  });

  it("canonicalizes legacy unpadded base64url environment keys for supervisor bootstrap", () => {
    const canonical = Buffer.alloc(32, 251).toString("base64");
    const legacy = canonical.replace(/\+/g, "-").replace(/\//g, "_").replace(/=$/, "");
    process.env.PORACODE_SECRET_STORAGE_KEY = legacy;

    expect(readOrCreateHeadlessSecretKey(baseDir)).toBe(canonical);
  });

  it("migrates a legacy unpadded persisted key to canonical base64", () => {
    const canonical = Buffer.alloc(32, 251).toString("base64");
    const legacy = canonical.replace(/\+/g, "-").replace(/\//g, "_").replace(/=$/, "");
    const keyPath = join(baseDir, "secret-key.headless");
    writeFileSync(keyPath, legacy, { mode: 0o600 });

    expect(readOrCreateHeadlessSecretKey(baseDir)).toBe(canonical);
    expect(readFileSync(keyPath, "utf8")).toBe(canonical);
  });

  it("rejects an environment key that is not 32 bytes", () => {
    process.env.PORACODE_SECRET_STORAGE_KEY = Buffer.from("too-short").toString("base64");
    expect(() => readOrCreateHeadlessSecretKey(baseDir)).toThrow(/32-byte/);
  });

  it("fails closed without rotating a corrupt existing master key", () => {
    const keyPath = join(baseDir, "secret-key.headless");
    writeFileSync(keyPath, "corrupt-key", { mode: 0o600 });

    expect(() => readOrCreateHeadlessSecretKey(baseDir)).toThrow(
      "The headless secret-storage key is unavailable.",
    );
    expect(readFileSync(keyPath, "utf8")).toBe("corrupt-key");
  });

  it("uses a valid existing Windows key for the current session without rewriting it", () => {
    const keyPath = join(baseDir, "secret-key.headless");
    const existing = Buffer.alloc(32, 19).toString("base64");
    writeFileSync(keyPath, existing, { mode: 0o600 });
    const operations: FileDurabilityOperations = {
      open: () => {
        throw new Error("Windows durability operations must not run");
      },
      sync: () => {
        throw new Error("Windows durability operations must not run");
      },
      close: () => {
        throw new Error("Windows durability operations must not run");
      },
    };

    expect(readOrCreateHeadlessSecretKey(baseDir, createFileDurability("win32", operations))).toBe(
      existing,
    );
    expect(readFileSync(keyPath, "utf8")).toBe(existing);
  });

  it("requires an injected key before a new Windows headless install mutates disk", () => {
    const keyPath = join(baseDir, "secret-key.headless");
    const operations: FileDurabilityOperations = {
      open: () => {
        throw new Error("Windows durability operations must not run");
      },
      sync: () => {
        throw new Error("Windows durability operations must not run");
      },
      close: () => {
        throw new Error("Windows durability operations must not run");
      },
    };

    expect(() =>
      readOrCreateHeadlessSecretKey(baseDir, createFileDurability("win32", operations)),
    ).toThrow(
      "PORACODE_SECRET_STORAGE_KEY is required because this platform cannot durably persist a generated headless key.",
    );
    expect(() => readFileSync(keyPath, "utf8")).toThrow(/ENOENT/);
  });

  it("accepts an injected Windows key without any durability operations", () => {
    const injected = Buffer.alloc(32, 29).toString("base64");
    process.env.PORACODE_SECRET_STORAGE_KEY = injected;
    const operations: FileDurabilityOperations = {
      open: () => {
        throw new Error("Windows durability operations must not run");
      },
      sync: () => {
        throw new Error("Windows durability operations must not run");
      },
      close: () => {
        throw new Error("Windows durability operations must not run");
      },
    };

    expect(readOrCreateHeadlessSecretKey(baseDir, createFileDurability("win32", operations))).toBe(
      injected,
    );
  });
});
