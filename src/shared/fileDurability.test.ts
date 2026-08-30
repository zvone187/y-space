import { describe, expect, it, vi } from "vitest";
import {
  createFileDurability,
  FileDurabilityUnavailableError,
  type FileDurabilityOperations,
} from "./fileDurability";

function operations() {
  const open = vi.fn<(path: string, flags: "r" | "r+") => number>().mockReturnValue(42);
  const sync = vi.fn<(descriptor: number) => void>();
  const close = vi.fn<(descriptor: number) => void>();
  return {
    value: { open, sync, close } satisfies FileDurabilityOperations,
    open,
    sync,
    close,
  };
}

describe("createFileDurability", () => {
  it("fails closed instead of claiming Windows directory-entry durability", () => {
    const calls = operations();
    const durability = createFileDurability("win32", calls.value);

    expect(() => durability.assertDirectorySyncSupported?.("C:\\data")).toThrow(
      FileDurabilityUnavailableError,
    );
    expect(() => durability.syncDirectory("C:\\data")).toThrow(FileDurabilityUnavailableError);

    durability.syncFile("C:\\data\\secret.tmp");
    durability.syncRenamedFile?.("C:\\data\\secret");

    expect(calls.open.mock.calls).toEqual([
      ["C:\\data\\secret.tmp", "r+"],
      ["C:\\data\\secret", "r+"],
    ]);
    expect(calls.sync).toHaveBeenCalledTimes(2);
    expect(calls.close).toHaveBeenCalledTimes(2);
  });

  it("does not expose the rejected Windows directory path in its error", () => {
    const durability = createFileDurability("win32", operations().value);
    const sensitivePath = "C:\\Users\\person\\AppData\\secret-account";

    expect(() => durability.syncDirectory(sensitivePath)).toThrow(
      "Durable filesystem namespace commits are unavailable on this platform.",
    );
    let thrown: unknown;
    try {
      durability.syncDirectory(sensitivePath);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(FileDurabilityUnavailableError);
    expect((thrown as Error).message).not.toContain(sensitivePath);
  });

  it("flushes POSIX files with r+ and directories with a read handle", () => {
    const calls = operations();
    const durability = createFileDurability("darwin", calls.value);

    durability.syncFile("/data/secret.tmp");
    durability.syncDirectory("/data");

    expect(calls.open.mock.calls).toEqual([
      ["/data/secret.tmp", "r+"],
      ["/data", "r"],
    ]);
    expect(calls.sync).toHaveBeenCalledTimes(2);
    expect(calls.close).toHaveBeenCalledTimes(2);
    expect(durability.syncRenamedFile).toBeUndefined();
    expect(() => durability.assertDirectorySyncSupported?.("/data")).not.toThrow();
  });

  it("always closes the descriptor when a flush fails", () => {
    const calls = operations();
    calls.sync.mockImplementation(() => {
      throw new Error("flush failed");
    });

    expect(() => createFileDurability("linux", calls.value).syncFile("/data/file")).toThrow(
      "flush failed",
    );
    expect(calls.close).toHaveBeenCalledExactlyOnceWith(42);
  });
});
