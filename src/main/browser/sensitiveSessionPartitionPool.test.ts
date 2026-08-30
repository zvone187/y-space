import { beforeEach, describe, expect, it } from "vitest";
import {
  allocateSensitiveSessionPartition,
  beginSensitiveSessionPartitionCleanup,
  claimSensitiveSessionPartition,
  completeSensitiveSessionPartitionCleanup,
  inspectSensitiveSessionPartitionPoolForTests,
  releaseUnusedSensitiveSessionPartition,
  resetSensitiveSessionPartitionPoolForTests,
  SENSITIVE_SESSION_PARTITION_POOL_SIZE,
} from "./sensitiveSessionPartitionPool";

describe("sensitiveSessionPartitionPool", () => {
  beforeEach(() => resetSensitiveSessionPartitionPoolForTests());

  it("bounds lifetime partition names across repeated successful flows", () => {
    const observed = new Set<string>();
    for (let index = 0; index < 128; index += 1) {
      const lease = allocateSensitiveSessionPartition();
      observed.add(lease.partition);
      claimSensitiveSessionPartition(lease);
      beginSensitiveSessionPartitionCleanup(lease);
      completeSensitiveSessionPartitionCleanup(lease, true);
    }

    expect(observed.size).toBe(SENSITIVE_SESSION_PARTITION_POOL_SIZE);
    for (const partition of observed) {
      expect(partition).toMatch(/^sensitive-oauth-[a-f0-9]{32}$/u);
      expect(partition).not.toMatch(/^persist:/iu);
    }
  });

  it("does not reuse an active or cleaning slot", () => {
    const first = allocateSensitiveSessionPartition();
    claimSensitiveSessionPartition(first);
    beginSensitiveSessionPartitionCleanup(first);

    const remaining = Array.from({ length: SENSITIVE_SESSION_PARTITION_POOL_SIZE - 1 }, () =>
      allocateSensitiveSessionPartition(),
    );
    expect(remaining.map(({ partition }) => partition)).not.toContain(first.partition);
    expect(() => allocateSensitiveSessionPartition()).toThrow(/pool is exhausted/i);

    completeSensitiveSessionPartitionCleanup(first, true);
    expect(allocateSensitiveSessionPartition().partition).toBe(first.partition);
  });

  it("quarantines a slot when any cleanup operation fails", () => {
    const failed = allocateSensitiveSessionPartition();
    claimSensitiveSessionPartition(failed);
    beginSensitiveSessionPartitionCleanup(failed);
    completeSensitiveSessionPartitionCleanup(failed, false);

    const allocated = Array.from({ length: SENSITIVE_SESSION_PARTITION_POOL_SIZE - 1 }, () =>
      allocateSensitiveSessionPartition(),
    );
    expect(allocated.map(({ partition }) => partition)).not.toContain(failed.partition);
    expect(() => allocateSensitiveSessionPartition()).toThrow(/pool is exhausted/i);
    expect(inspectSensitiveSessionPartitionPoolForTests()).toContainEqual({
      partition: failed.partition,
      state: "quarantined",
    });
  });

  it("releases a reservation only before a BrowserContext is claimed", () => {
    const unused = allocateSensitiveSessionPartition();
    expect(releaseUnusedSensitiveSessionPartition(unused)).toBe(true);

    const active = allocateSensitiveSessionPartition();
    claimSensitiveSessionPartition(active);
    expect(releaseUnusedSensitiveSessionPartition(active)).toBe(false);
  });

  it("does not let a stale generation release a newly reserved reuse", () => {
    const stale = allocateSensitiveSessionPartition();
    claimSensitiveSessionPartition(stale);
    beginSensitiveSessionPartitionCleanup(stale);
    completeSensitiveSessionPartitionCleanup(stale, true);

    for (let index = 1; index < SENSITIVE_SESSION_PARTITION_POOL_SIZE; index += 1) {
      const skipped = allocateSensitiveSessionPartition();
      expect(releaseUnusedSensitiveSessionPartition(skipped)).toBe(true);
    }
    const current = allocateSensitiveSessionPartition();
    expect(current.partition).toBe(stale.partition);

    expect(releaseUnusedSensitiveSessionPartition(stale)).toBe(false);
    claimSensitiveSessionPartition(current);
  });
});
