import { randomBytes } from "node:crypto";

/**
 * Electron retains a native BrowserContext for every partition name for the
 * lifetime of the process. Reusing a small, process-randomized set therefore
 * bounds native memory while keeping names unguessable outside main.
 */
export const SENSITIVE_SESSION_PARTITION_POOL_SIZE = 8;

type SensitiveSessionPartitionSlotState =
  | "available"
  | "reserved"
  | "active"
  | "cleaning"
  | "quarantined";

interface SensitiveSessionPartitionSlot {
  readonly partition: string;
  state: SensitiveSessionPartitionSlotState;
  lease: SensitiveSessionPartitionPoolLease | null;
}

/** Exact main-process generation capability for one reservation. Partition
 * text alone is never sufficient to mutate a slot after it has been reused. */
export interface SensitiveSessionPartitionPoolLease {
  readonly partition: string;
}

// Thirty hex characters plus the two-character slot index preserves the
// existing 128-bit-looking partition contract without creating new names per
// flow. The namespace is generated once and never exposed to the renderer.
const poolNamespace = randomBytes(15).toString("hex");
const slots: SensitiveSessionPartitionSlot[] = Array.from(
  { length: SENSITIVE_SESSION_PARTITION_POOL_SIZE },
  (_, index) => ({
    partition: `sensitive-oauth-${poolNamespace}${index.toString(16).padStart(2, "0")}`,
    state: "available",
    lease: null,
  }),
);
let nextAllocationIndex = 0;

function findSlot(partition: string): SensitiveSessionPartitionSlot | undefined {
  return slots.find((slot) => slot.partition === partition);
}

function requireLeaseSlot(
  lease: SensitiveSessionPartitionPoolLease,
): SensitiveSessionPartitionSlot {
  const slot = findSlot(lease.partition);
  if (!slot || slot.lease !== lease) {
    throw new Error("Sensitive integration session partition lease is stale");
  }
  return slot;
}

/** Reserve a bounded main-only partition for a flow that has not created its
 * first native guest yet. */
export function allocateSensitiveSessionPartition(): SensitiveSessionPartitionPoolLease {
  for (let offset = 0; offset < slots.length; offset += 1) {
    const index = (nextAllocationIndex + offset) % slots.length;
    const slot = slots[index];
    if (!slot || slot.state !== "available") continue;
    const lease = Object.freeze({ partition: slot.partition });
    slot.state = "reserved";
    slot.lease = lease;
    nextAllocationIndex = (index + 1) % slots.length;
    return lease;
  }
  throw new Error(
    "Sensitive integration session pool is exhausted; close a connection page and try again.",
  );
}

/** Transition a reserved pool slot when main is about to instantiate its
 * BrowserContext. Non-pool partitions are main-only legacy/test capabilities
 * and return false without weakening their existing ownership checks. */
export function claimSensitiveSessionPartition(lease: SensitiveSessionPartitionPoolLease): void {
  const slot = requireLeaseSlot(lease);
  if (slot.state !== "reserved") {
    throw new Error("Sensitive integration session partition is not reserved");
  }
  slot.state = "active";
}

/** Mark the last live native guest gone before session cleanup starts. */
export function beginSensitiveSessionPartitionCleanup(
  lease: SensitiveSessionPartitionPoolLease,
): void {
  const slot = requireLeaseSlot(lease);
  if (slot.state !== "active") {
    throw new Error("Sensitive integration session partition is not active");
  }
  slot.state = "cleaning";
}

/** Return a slot only after every cleanup operation succeeds. A failed cleanup
 * is deliberately permanent for this process: reusing possibly retained OAuth
 * state would fail open. */
export function completeSensitiveSessionPartitionCleanup(
  lease: SensitiveSessionPartitionPoolLease,
  succeeded: boolean,
): void {
  const slot = requireLeaseSlot(lease);
  if (slot.state !== "cleaning") {
    throw new Error("Sensitive integration session partition is not being cleaned");
  }
  slot.state = succeeded ? "available" : "quarantined";
  slot.lease = null;
}

/** Cancel an allocation that never reached BrowserPanelManager and therefore
 * never instantiated an Electron Session. */
export function releaseUnusedSensitiveSessionPartition(
  lease: SensitiveSessionPartitionPoolLease,
): boolean {
  const slot = findSlot(lease.partition);
  if (!slot || slot.lease !== lease || slot.state !== "reserved") return false;
  slot.state = "available";
  slot.lease = null;
  return true;
}

export function isPooledSensitiveSessionPartition(partition: string): boolean {
  return findSlot(partition) !== undefined;
}

/** Test-only state reset; it intentionally retains the process namespace so
 * tests exercise bounded reuse rather than manufacturing new BrowserContexts. */
export function resetSensitiveSessionPartitionPoolForTests(): void {
  for (const slot of slots) {
    slot.state = "available";
    slot.lease = null;
  }
  nextAllocationIndex = 0;
}

export function inspectSensitiveSessionPartitionPoolForTests(): ReadonlyArray<{
  partition: string;
  state: SensitiveSessionPartitionSlotState;
}> {
  return slots.map(({ partition, state }) => ({ partition, state }));
}
