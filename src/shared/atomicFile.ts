import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { FileDurability } from "./fileDurability";

/**
 * Write a file atomically: serialize to a sibling temp file, then `rename` it
 * into place. A same-volume rename prevents readers and ordinary process
 * crashes from observing a truncated/partial file. Callers that require
 * power-loss ordering must supply `durability`; the temp inode is then flushed
 * before rename and the parent directory is flushed afterward. A durability
 * backend that cannot commit directory entries must reject the operation before
 * the target namespace is changed.
 *
 * The temp name is unguessable and opened exclusively so an untrusted sibling
 * process cannot preplant a symlink/hardlink target before a credential write.
 */
export function writeFileAtomic(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
  options?: { encoding?: BufferEncoding; mode?: number; durability?: FileDurability },
): void {
  const { durability, ...writeOptions } = options ?? {};
  const directoryPath = dirname(filePath);
  durability?.assertDirectorySyncSupported?.(directoryPath);
  mkdirSync(directoryPath, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, data, { ...writeOptions, flag: "wx" });
    durability?.syncFile(tmp);
    renameAtomic(filePath, tmp);
    durability?.syncRenamedFile?.(filePath);
    durability?.syncDirectory(directoryPath);
  } catch (error) {
    // Best-effort cleanup of the temp file; ignore if it never got created.
    try {
      rmSync(tmp, { force: true });
    } catch {
      // ignore cleanup failure
    }
    throw error;
  }
}

/**
 * Rename `tmp` onto `filePath`, retrying transient lock failures. On Windows,
 * `renameSync` (MoveFileEx with MOVEFILE_REPLACE_EXISTING) fails with EPERM
 * when the destination is momentarily open by another process — real-time
 * antivirus scanning, Windows Search/Indexing, or a second app instance. These
 * locks clear within milliseconds, so a short bounded retry rides them out
 * without giving up atomic writes. Note: the retries are only hit on the rare
 * lock path; the writes already block synchronously, so a few ms of sleep is
 * consistent with the existing design.
 */
function renameAtomic(filePath: string, tmp: string): void {
  const RETRYABLE_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
  const MAX_RETRIES = 5;
  const RETRY_DELAY_MS = 10;

  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, filePath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= MAX_RETRIES || !code || !RETRYABLE_CODES.has(code)) throw error;
      // Block the loop synchronously so the caller's sync contract is kept.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_DELAY_MS);
    }
  }
}
