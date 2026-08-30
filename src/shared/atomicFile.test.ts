import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileDurability } from "./fileDurability";
import { writeFileAtomic } from "./atomicFile";

/**
 * Drives `renameSync` failures without touching the ESM namespace (which is
 * non-configurable and can't be `vi.spyOn`'d). `failCodes` is a queue of error
 * codes to throw — one per call, in order — before delegating to the real fs.
 */
const renameControl = vi.hoisted(() => ({
  failCodes: [] as string[],
  realRename: (() => {}) as (from: string, to: string) => void,
}));

const uuidControl = vi.hoisted(() => ({ value: "12345678-1234-4234-9234-123456789abc" }));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomUUID: () => uuidControl.value };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  renameControl.realRename = actual.renameSync;
  return {
    ...actual,
    renameSync: vi.fn<(from: string, to: string) => void>((from, to) => {
      const code = renameControl.failCodes.shift();
      if (code) {
        throw Object.assign(new Error(`${code}: operation on file`), { code });
      }
      return renameControl.realRename(from, to);
    }),
  };
});

describe("writeFileAtomic", () => {
  let dir: string;

  beforeEach(() => {
    renameControl.failCodes = [];
    vi.mocked(renameSync).mockClear();
    dir = mkdtempSync(join(tmpdir(), "atomic-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes content to a new file", () => {
    const target = join(dir, "settings.json");
    writeFileAtomic(target, '{"a":1}', { encoding: "utf8" });
    expect(readFileSync(target, "utf8")).toBe('{"a":1}');
  });

  it("creates parent directories", () => {
    const target = join(dir, "nested", "deep", "file.txt");
    writeFileAtomic(target, "hello", { encoding: "utf8" });
    expect(readFileSync(target, "utf8")).toBe("hello");
  });

  it("overwrites an existing file", () => {
    const target = join(dir, "file.txt");
    writeFileSync(target, "old", "utf8");
    writeFileAtomic(target, "new", { encoding: "utf8" });
    expect(readFileSync(target, "utf8")).toBe("new");
  });

  it("flushes the new temp inode before replacing the old target", () => {
    const target = join(dir, "durable.txt");
    const temp = `${target}.${process.pid}.${uuidControl.value}.tmp`;
    writeFileSync(target, "old", "utf8");
    const order: string[] = [];
    const durability: FileDurability = {
      syncFile: (path) => {
        expect(path).toBe(temp);
        expect(readFileSync(path, "utf8")).toBe("new");
        expect(readFileSync(target, "utf8")).toBe("old");
        order.push("temp");
      },
      syncDirectory: (path) => {
        expect(path).toBe(dir);
        expect(readFileSync(target, "utf8")).toBe("new");
        order.push("directory");
      },
    };

    writeFileAtomic(target, "new", { encoding: "utf8", durability });

    expect(order).toEqual(["temp", "directory"]);
  });

  it("flushes the newly named target between the rename and directory barrier", () => {
    const target = join(dir, "windows-durable.txt");
    const temp = `${target}.${process.pid}.${uuidControl.value}.tmp`;
    writeFileSync(target, "old", "utf8");
    const order: string[] = [];
    const durability: FileDurability = {
      syncFile: () => order.push("temp"),
      syncRenamedFile: (targetPath) => {
        expect(targetPath).toBe(target);
        expect(readFileSync(target, "utf8")).toBe("new");
        order.push("renamed-target");
      },
      syncDirectory: () => order.push("directory"),
    };

    writeFileAtomic(target, "new", { encoding: "utf8", durability });

    expect(order).toEqual(["temp", "renamed-target", "directory"]);
    expect(readFileSync(target, "utf8")).toBe("new");
    expect(vi.mocked(renameSync)).toHaveBeenCalledExactlyOnceWith(temp, target);
  });

  it("fails before replacing the target when namespace durability is unavailable", () => {
    const target = join(dir, "durability-required.txt");
    writeFileSync(target, "old", "utf8");
    const syncFile = vi.fn<(path: string) => void>();
    const durability: FileDurability = {
      assertDirectorySyncSupported: (directoryPath) => {
        expect(directoryPath).toBe(dir);
        throw new Error("namespace durability unavailable");
      },
      syncFile,
      syncDirectory: vi.fn<(path: string) => void>(),
    };

    expect(() => writeFileAtomic(target, "new", { encoding: "utf8", durability })).toThrow(
      "namespace durability unavailable",
    );

    expect(readFileSync(target, "utf8")).toBe("old");
    expect(syncFile).not.toHaveBeenCalled();
    expect(vi.mocked(renameSync)).not.toHaveBeenCalled();
    expect(readdirSync(dir).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("preserves the old target when the temp inode cannot be flushed", () => {
    const target = join(dir, "durable.txt");
    writeFileSync(target, "old", "utf8");
    const syncDirectory = vi.fn<(path: string) => void>();
    const durability: FileDurability = {
      syncFile: () => {
        throw new Error("temp flush failed");
      },
      syncDirectory,
    };

    expect(() => writeFileAtomic(target, "new", { encoding: "utf8", durability })).toThrow(
      "temp flush failed",
    );
    expect(readFileSync(target, "utf8")).toBe("old");
    expect(syncDirectory).not.toHaveBeenCalled();
    expect(readdirSync(dir).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("leaves no temp file behind on success", () => {
    const target = join(dir, "file.txt");
    writeFileAtomic(target, "data", { encoding: "utf8" });
    const leftovers = readdirSync(dir).filter((name) => name.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("preserves the existing target and cleans up the temp file when the rename fails", () => {
    // Renaming a regular file onto an existing directory fails on POSIX and
    // Windows alike (EISDIR/ENOTDIR/EPERM), so this exercises the real failure
    // path without mocking fs internals.
    const target = join(dir, "target-is-a-dir");
    mkdirSync(target);

    // The rename throws an fs error whose code varies by platform
    // (EISDIR/ENOTDIR/EPERM), so assert on the captured error rather than a message.
    let thrown: unknown;
    try {
      writeFileAtomic(target, "replacement", { encoding: "utf8" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);

    // The original entry is untouched (still a directory)…
    expect(statSync(target).isDirectory()).toBe(true);
    // …and the temp file was cleaned up rather than orphaned.
    const leftovers = readdirSync(dir).filter((name) => name.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("rejects a preplanted temp symlink without changing its target", () => {
    const target = join(dir, "credentials.json");
    const victim = join(dir, "do-not-truncate.txt");
    const temp = `${target}.${process.pid}.${uuidControl.value}.tmp`;
    writeFileSync(target, "old", "utf8");
    writeFileSync(victim, "keep", "utf8");
    symlinkSync(victim, temp);

    expect(() => writeFileAtomic(target, "new", { encoding: "utf8" })).toThrow(/EEXIST/);
    expect(readFileSync(target, "utf8")).toBe("old");
    expect(readFileSync(victim, "utf8")).toBe("keep");
    expect(existsSync(temp)).toBe(false);
  });

  it("writes Buffer data (e.g. binary/encoded secrets)", () => {
    const target = join(dir, "key.safe");
    const buf = Buffer.from("c2VjcmV0", "utf8");
    writeFileAtomic(target, buf);
    expect(readFileSync(target).equals(buf)).toBe(true);
    expect(existsSync(`${target}.${process.pid}.${uuidControl.value}.tmp`)).toBe(false);
  });

  it("retries a transient EPERM lock on the rename and succeeds", () => {
    renameControl.failCodes = ["EPERM", "EPERM"];

    const target = join(dir, "settings.json");
    writeFileAtomic(target, '{"a":1}', { encoding: "utf8" });

    // Two failed attempts + one successful call.
    expect(vi.mocked(renameSync)).toHaveBeenCalledTimes(3);
    expect(readFileSync(target, "utf8")).toBe('{"a":1}');
  });

  it("throws and cleans up the temp file when the lock does not clear", () => {
    // Exceed the retry budget so the write still fails.
    renameControl.failCodes = ["EPERM", "EPERM", "EPERM", "EPERM", "EPERM", "EPERM"];

    const target = join(dir, "settings.json");
    expect(() => writeFileAtomic(target, "data", { encoding: "utf8" })).toThrow(/EPERM/);

    // Temp file cleaned up rather than orphaned.
    const leftovers = readdirSync(dir).filter((name) => name.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("does not retry a non-retryable rename error", () => {
    renameControl.failCodes = ["EISDIR"];

    const target = join(dir, "settings.json");
    expect(() => writeFileAtomic(target, "data", { encoding: "utf8" })).toThrow(/EISDIR/);

    // A non-retryable code aborts immediately after a single attempt.
    expect(vi.mocked(renameSync)).toHaveBeenCalledTimes(1);
  });
});
