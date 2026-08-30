import { lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { durableFileSystem, type FileDurability } from "@/shared/fileDurability";

const MCP_OAUTH_STORE_FILE_NAME = "mcp-oauth.json";

export interface MalformedMcpOAuthCredentialStoreRecoveryOptions {
  readonly baseDir: string;
  readonly confirmReset: () => Promise<boolean>;
  readonly durability?: FileDurability;
}

/**
 * Keeps the supervisor stopped while a malformed store might contain OAuth
 * tokens or plaintext legacy state. The exact active store is removed only
 * after native confirmation, and its parent directory is flushed before a
 * caller may retry startup.
 */
export async function recoverMalformedMcpOAuthCredentialStore(
  options: MalformedMcpOAuthCredentialStoreRecoveryOptions,
): Promise<"retry" | "stop"> {
  if (!(await options.confirmReset())) return "stop";

  const durability = options.durability ?? durableFileSystem;
  const storePath = join(options.baseDir, MCP_OAUTH_STORE_FILE_NAME);
  try {
    // Some platforms cannot durably commit a namespace deletion with the
    // built-in Node filesystem APIs. Refuse before touching possible token
    // state unless the selected durability backend can provide that barrier.
    durability.assertDirectorySyncSupported?.(options.baseDir);
    let storeExists = true;
    try {
      const metadata = lstatSync(storePath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error("The OAuth credential store is not a regular file.");
      }
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) storeExists = false;
      else throw error;
    }

    if (storeExists) {
      durability.syncFile(storePath);
      unlinkSync(storePath);
    }
    durability.syncDirectory(options.baseDir);
    return "retry";
  } catch (cause) {
    throw new McpOAuthCredentialStoreResetError(cause);
  }
}

export class McpOAuthCredentialStoreResetError extends Error {
  constructor(cause: unknown) {
    super("OAuth credential store reset could not be committed safely.", { cause });
    this.name = "McpOAuthCredentialStoreResetError";
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}
