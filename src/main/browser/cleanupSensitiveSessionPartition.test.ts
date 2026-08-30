import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const closeAllConnections = vi.hoisted(() => vi.fn<() => Promise<void>>());
const clearStorageData = vi.hoisted(() => vi.fn<() => Promise<void>>());
const clearCache = vi.hoisted(() => vi.fn<() => Promise<void>>());
const clearAuthCache = vi.hoisted(() => vi.fn<() => Promise<void>>());
const fromPartition = vi.hoisted(() =>
  vi.fn<(partition: string) => object>(() => ({
    closeAllConnections,
    clearStorageData,
    clearCache,
    clearAuthCache,
  })),
);

vi.mock("electron", () => ({ session: { fromPartition } }));

import {
  cleanupSensitiveSessionPartition,
  SENSITIVE_SESSION_CLEANUP_TIMEOUT_MS,
} from "./cleanupSensitiveSessionPartition";

describe("cleanupSensitiveSessionPartition", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    closeAllConnections.mockResolvedValue(undefined);
    clearStorageData.mockResolvedValue(undefined);
    clearCache.mockResolvedValue(undefined);
    clearAuthCache.mockResolvedValue(undefined);
  });

  it("clears connections, storage, cache, and HTTP auth before succeeding", async () => {
    await cleanupSensitiveSessionPartition("sensitive-oauth-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

    expect(fromPartition).toHaveBeenCalledExactlyOnceWith(
      "sensitive-oauth-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(closeAllConnections).toHaveBeenCalledTimes(2);
    expect(clearStorageData).toHaveBeenCalledTimes(2);
    expect(clearCache).toHaveBeenCalledTimes(2);
    expect(clearAuthCache).toHaveBeenCalledTimes(2);
    const firstClose = closeAllConnections.mock.invocationCallOrder[0]!;
    const secondClose = closeAllConnections.mock.invocationCallOrder[1]!;
    const firstStorageClear = clearStorageData.mock.invocationCallOrder[0]!;
    const secondStorageClear = clearStorageData.mock.invocationCallOrder[1]!;
    expect(firstClose).toBeLessThan(firstStorageClear);
    expect(firstStorageClear).toBeLessThan(secondClose);
    expect(secondClose).toBeLessThan(secondStorageClear);
  });

  it("reports partial failure after attempting every cleanup operation", async () => {
    clearAuthCache.mockImplementation(() => {
      throw new Error("auth cache unavailable");
    });

    await expect(
      cleanupSensitiveSessionPartition("sensitive-oauth-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
    ).rejects.toThrow(/cleanup failed/i);
    expect(closeAllConnections).toHaveBeenCalledTimes(2);
    expect(clearStorageData).toHaveBeenCalledTimes(2);
    expect(clearCache).toHaveBeenCalledTimes(2);
    expect(clearAuthCache).toHaveBeenCalledTimes(2);
  });

  it("fails within the hard cap when an Electron cleanup operation never settles", async () => {
    vi.useFakeTimers();
    let rejectLate!: (reason?: unknown) => void;
    closeAllConnections.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectLate = reject;
        }),
    );

    const cleanup = cleanupSensitiveSessionPartition(
      "sensitive-oauth-cccccccccccccccccccccccccccccccc",
    );
    const outcome = cleanup.then(
      () => "resolved" as const,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(SENSITIVE_SESSION_CLEANUP_TIMEOUT_MS);

    await expect(outcome).resolves.toEqual(
      expect.objectContaining({ message: expect.stringMatching(/cleanup timed out/i) }),
    );

    // A timeout cannot cancel Electron's promise. Its eventual rejection must
    // remain observed instead of becoming an unhandled process rejection.
    rejectLate(new Error("late Electron cleanup failure"));
    await vi.runAllTimersAsync();
    await Promise.resolve();
  });
});
