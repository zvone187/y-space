import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import {
  PROJECT_FILE_PREVIEW_DEFAULT_MAX_BYTES,
  PROJECT_FILE_PREVIEW_HARD_MAX_BYTES,
  type ReadProjectFilePreviewPayload,
  type ReadProjectFilePreviewResult,
} from "@/shared/contracts";

export {
  PROJECT_FILE_PREVIEW_DEFAULT_MAX_BYTES,
  PROJECT_FILE_PREVIEW_HARD_MAX_BYTES,
} from "@/shared/contracts";

export type ProjectFilePreviewErrorCode =
  | "invalid_limit"
  | "invalid_path"
  | "outside_root"
  | "missing"
  | "not_file"
  | "too_large"
  | "changed"
  | "unsupported";

const ERROR_MESSAGES = {
  invalid_limit: "The project preview size limit is invalid.",
  invalid_path: "The preview path must identify a file inside the current project.",
  outside_root: "The preview file is outside the current project.",
  missing: "The preview file is unavailable.",
  not_file: "Only project files can be previewed.",
  too_large: "The preview file exceeds the allowed size.",
  changed: "The preview file changed while it was being read.",
  unsupported: "Preview bytes are unavailable for this project.",
} as const satisfies Record<ProjectFilePreviewErrorCode, string>;

const SUPPORTED_PREVIEW_EXTENSION = /\.(?:pdf|xls|xlsx|csv|tsv)$/iu;

/**
 * Deliberately finite, path-free errors: Electron forwards handler messages to
 * the renderer, so raw `fs` errors must never cross this boundary.
 */
export class ProjectFilePreviewError extends Error {
  constructor(readonly code: ProjectFilePreviewErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ProjectFilePreviewError";
  }
}

function previewError(code: ProjectFilePreviewErrorCode): ProjectFilePreviewError {
  return new ProjectFilePreviewError(code);
}

function errnoCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function targetReadError(error: unknown): ProjectFilePreviewError {
  if (error instanceof ProjectFilePreviewError) return error;
  const code = errnoCode(error);
  if (code === "ENOENT" || code === "ENOTDIR") return previewError("missing");
  if (code === "ELOOP") return previewError("outside_root");
  return previewError("unsupported");
}

function normalizePreviewPath(input: string): string {
  if (
    input.length === 0 ||
    input.includes("\0") ||
    isAbsolute(input) ||
    win32.isAbsolute(input) ||
    /^[A-Za-z]:/u.test(input)
  ) {
    throw previewError("invalid_path");
  }

  const parts = input.replaceAll("\\", "/").split("/");
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") throw previewError("invalid_path");
    normalized.push(part);
  }
  if (normalized.length === 0) throw previewError("invalid_path");
  return normalized.join("/");
}

function isContained(rootPath: string, targetPath: string): boolean {
  const relativePath = relative(rootPath, targetPath);
  return relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

function validateRoot(payload: ReadProjectFilePreviewPayload): string {
  const { projectLocation } = payload;
  if (projectLocation.remoteServerId) {
    throw previewError("unsupported");
  }
  if (projectLocation.kind === "wsl") {
    // A local Windows host can securely read its own WSL project through the
    // supplied UNC root. Other platforms cannot resolve that root and fail
    // closed without trying to interpret the Linux path locally.
    if (process.platform !== "win32" || !win32.isAbsolute(projectLocation.uncPath)) {
      throw previewError("unsupported");
    }
    return projectLocation.uncPath;
  }
  if (projectLocation.kind === "windows") {
    if (process.platform !== "win32" || !win32.isAbsolute(projectLocation.path)) {
      throw previewError("unsupported");
    }
  } else if (process.platform === "win32" || !isAbsolute(projectLocation.path)) {
    throw previewError("unsupported");
  }
  return projectLocation.path;
}

function validateLimit(maxBytes: number): void {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > PROJECT_FILE_PREVIEW_HARD_MAX_BYTES
  ) {
    throw previewError("invalid_limit");
  }
}

/**
 * Read one local, project-contained file for a renderer-owned PDF/spreadsheet
 * preview. This path is intentionally separate from the text editor read API:
 * it never accepts absolute files, never follows a symlink out of the root,
 * and never allocates above the caller's bounded limit.
 */
export async function readProjectFilePreview(
  payload: ReadProjectFilePreviewPayload,
): Promise<ReadProjectFilePreviewResult> {
  const maxBytes = payload.maxBytes ?? PROJECT_FILE_PREVIEW_DEFAULT_MAX_BYTES;
  validateLimit(maxBytes);
  const root = validateRoot(payload);
  const path = normalizePreviewPath(payload.path);
  // Defense in depth: renderer call sites select previewable documents, but
  // the privileged main-process byte API independently enforces that narrow
  // contract so it cannot become a general project-file extraction primitive.
  if (!SUPPORTED_PREVIEW_EXTENSION.test(path)) throw previewError("unsupported");

  let resolvedRoot: string;
  try {
    resolvedRoot = await realpath(root);
    if (!(await stat(resolvedRoot)).isDirectory()) throw previewError("unsupported");
  } catch (error: unknown) {
    if (error instanceof ProjectFilePreviewError) throw error;
    throw previewError("unsupported");
  }

  const lexicalTarget = resolve(root, ...path.split("/"));
  if (!isContained(resolve(root), lexicalTarget)) throw previewError("invalid_path");

  let resolvedTarget: string;
  try {
    resolvedTarget = await realpath(lexicalTarget);
  } catch (error: unknown) {
    throw targetReadError(error);
  }
  if (!isContained(resolvedRoot, resolvedTarget)) throw previewError("outside_root");

  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(resolvedTarget, constants.O_RDONLY | noFollow);
  } catch (error: unknown) {
    throw targetReadError(error);
  }

  try {
    const before = await handle.stat();
    if (!before.isFile()) throw previewError("not_file");
    if (!Number.isSafeInteger(before.size) || before.size > maxBytes) {
      throw previewError("too_large");
    }

    // Re-resolve after opening and compare the opened handle's identity with
    // the current contained target. O_NOFOLLOW protects the final component;
    // this second check also catches parent-directory/symlink swaps that occur
    // between the first canonicalization and open on supported filesystems.
    let verifiedTarget: string;
    try {
      verifiedTarget = await realpath(lexicalTarget);
    } catch (error: unknown) {
      throw targetReadError(error);
    }
    if (!isContained(resolvedRoot, verifiedTarget) || verifiedTarget !== resolvedTarget) {
      throw previewError("outside_root");
    }
    const verified = await stat(verifiedTarget);
    if (verified.dev !== before.dev || verified.ino !== before.ino) throw previewError("changed");

    // Allocate exactly the already-validated size and read at most that many
    // bytes. `FileHandle.readFile()` is intentionally avoided because a file
    // that grows after `stat()` could otherwise bypass the memory ceiling.
    const buffer = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }

    const after = await handle.stat();
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw previewError("changed");
    }

    return {
      path,
      bytes: Uint8Array.from(buffer),
      sizeBytes: offset,
      modifiedAtMs: before.mtimeMs,
    };
  } catch (error: unknown) {
    throw targetReadError(error);
  } finally {
    await handle.close().catch(() => undefined);
  }
}
