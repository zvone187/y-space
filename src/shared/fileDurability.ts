import { closeSync, fsyncSync, openSync } from "node:fs";

export interface FileDurability {
  /** Fail before an atomic write mutates the namespace when no durable commit is available. */
  assertDirectorySyncSupported?(directoryPath: string): void;
  syncFile(filePath: string): void;
  syncDirectory(directoryPath: string): void;
  /** Optional file-content flush after the atomic rename; this does not commit the new name. */
  syncRenamedFile?(targetPath: string): void;
}

export class FileDurabilityUnavailableError extends Error {
  constructor() {
    super("Durable filesystem namespace commits are unavailable on this platform.");
    this.name = "FileDurabilityUnavailableError";
  }
}

export interface FileDurabilityOperations {
  open(path: string, flags: "r" | "r+"): number;
  sync(descriptor: number): void;
  close(descriptor: number): void;
}

const nodeFileDurabilityOperations: FileDurabilityOperations = {
  open: (path, flags) => openSync(path, flags),
  sync: (descriptor) => fsyncSync(descriptor),
  close: (descriptor) => closeSync(descriptor),
};

export function createFileDurability(
  platform: NodeJS.Platform = process.platform,
  operations: FileDurabilityOperations = nodeFileDurabilityOperations,
): FileDurability {
  const assertDirectorySyncSupported = (_directoryPath: string): void => {
    if (platform === "win32") throw new FileDurabilityUnavailableError();
  };

  return Object.freeze({
    assertDirectorySyncSupported,
    // FlushFileBuffers on Windows requires a write-capable handle. `r+` is
    // non-truncating and works for the sibling temp files we just created.
    syncFile: (filePath: string) => fsyncPath(filePath, "r+", operations),
    syncDirectory: (directoryPath: string) => {
      // Node's Windows rename uses MoveFileExW without MOVEFILE_WRITE_THROUGH,
      // and FlushFileBuffers cannot provide a POSIX-style directory-entry
      // barrier. Never silently turn a requested durable namespace commit into
      // best effort: callers must fail closed or supply a native-capable backend.
      assertDirectorySyncSupported(directoryPath);
      fsyncPath(directoryPath, "r", operations);
    },
    // A Windows file-handle flush can persist the renamed target's contents,
    // but it does not commit that target's directory entry. The preflight above
    // therefore rejects built-in durable atomic writes before they reach this.
    ...(platform === "win32"
      ? { syncRenamedFile: (targetPath: string) => fsyncPath(targetPath, "r+", operations) }
      : {}),
  });
}

export const durableFileSystem = createFileDurability();

function fsyncPath(path: string, flags: "r" | "r+", operations: FileDurabilityOperations): void {
  const descriptor = operations.open(path, flags);
  try {
    operations.sync(descriptor);
  } finally {
    operations.close(descriptor);
  }
}
