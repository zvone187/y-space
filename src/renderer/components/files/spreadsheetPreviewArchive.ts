const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP64_END_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_DIRECTORY_ENTRY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_DIGITAL_SIGNATURE = 0x05054b50;
const ZIP64_EXTRA_FIELD_ID = 0x0001;
const ZIP_ENCRYPTION_FLAGS = 0x2041;

export const SPREADSHEET_PREVIEW_MAX_ARCHIVE_ENTRIES = 1_024;
export const SPREADSHEET_PREVIEW_MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
export const SPREADSHEET_PREVIEW_MAX_ENTRY_EXPANDED_BYTES = 32 * 1024 * 1024;
export const SPREADSHEET_PREVIEW_MAX_COMPRESSION_RATIO = 200;

export type SpreadsheetArchivePreflightResult =
  | {
      readonly status: "ready";
      readonly entryCount: number;
      readonly compressedBytes: number;
      readonly expandedBytes: number;
    }
  | { readonly status: "error"; readonly message: string };

class InvalidArchiveError extends Error {}

function invalidArchive(message: string): never {
  throw new InvalidArchiveError(message);
}

function ensureRange(bytes: Uint8Array, offset: number, length: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > bytes.byteLength
  ) {
    invalidArchive("Invalid spreadsheet archive: directory metadata is malformed.");
  }
}

function readUint16(bytes: Uint8Array, offset: number): number {
  ensureRange(bytes, offset, 2);
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  ensureRange(bytes, offset, 4);
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  if (bytes.byteLength < 22) {
    invalidArchive("Invalid spreadsheet archive: end-of-directory record is missing.");
  }

  const minimumOffset = Math.max(0, bytes.byteLength - 22 - 0xffff);
  for (let offset = bytes.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (readUint32(bytes, offset) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
    const commentLength = readUint16(bytes, offset + 20);
    if (offset + 22 + commentLength === bytes.byteLength) return offset;
  }

  invalidArchive("Invalid spreadsheet archive: end-of-directory record is missing.");
}

function rejectZip64ExtraField(bytes: Uint8Array, offset: number, length: number): void {
  ensureRange(bytes, offset, length);
  const end = offset + length;
  let cursor = offset;
  while (cursor < end) {
    if (cursor + 4 > end) {
      invalidArchive("Invalid spreadsheet archive: extra-field metadata is malformed.");
    }
    const id = readUint16(bytes, cursor);
    const size = readUint16(bytes, cursor + 2);
    cursor += 4;
    if (cursor + size > end) {
      invalidArchive("Invalid spreadsheet archive: extra-field metadata is malformed.");
    }
    if (id === ZIP64_EXTRA_FIELD_ID) {
      invalidArchive("This spreadsheet uses ZIP64, which is not supported for safe previews.");
    }
    cursor += size;
  }
}

function rejectEncryption(flags: number): void {
  if ((flags & ZIP_ENCRYPTION_FLAGS) !== 0) {
    invalidArchive("Encrypted spreadsheets cannot be previewed safely.");
  }
}

function rejectUnsafeCompression(
  compressedBytes: number,
  expandedBytes: number,
  method: number,
): void {
  if (method !== 0 && method !== 8) {
    invalidArchive("This spreadsheet uses an unsupported archive compression method.");
  }
  if (expandedBytes > SPREADSHEET_PREVIEW_MAX_ENTRY_EXPANDED_BYTES) {
    invalidArchive("This spreadsheet expands beyond the safe preview limit.");
  }
  if (
    expandedBytes > 0 &&
    (compressedBytes === 0 ||
      expandedBytes / compressedBytes > SPREADSHEET_PREVIEW_MAX_COMPRESSION_RATIO)
  ) {
    invalidArchive("This spreadsheet has an unsafe archive compression ratio.");
  }
}

function validateLocalHeader(
  bytes: Uint8Array,
  centralDirectoryOffset: number,
  localHeaderOffset: number,
  centralFlags: number,
  centralMethod: number,
  compressedBytes: number,
  expandedBytes: number,
): void {
  ensureRange(bytes, localHeaderOffset, 30);
  if (readUint32(bytes, localHeaderOffset) !== LOCAL_FILE_HEADER_SIGNATURE) {
    invalidArchive("Invalid spreadsheet archive: a local file header is missing.");
  }

  const localFlags = readUint16(bytes, localHeaderOffset + 6);
  const localMethod = readUint16(bytes, localHeaderOffset + 8);
  const localCompressedBytes = readUint32(bytes, localHeaderOffset + 18);
  const localExpandedBytes = readUint32(bytes, localHeaderOffset + 22);
  const fileNameLength = readUint16(bytes, localHeaderOffset + 26);
  const extraLength = readUint16(bytes, localHeaderOffset + 28);
  rejectEncryption(localFlags);
  if (localMethod !== centralMethod || (localFlags & ZIP_ENCRYPTION_FLAGS) !== 0) {
    invalidArchive("Invalid spreadsheet archive: local and directory metadata disagree.");
  }
  if ((localFlags & 0x0008) !== (centralFlags & 0x0008)) {
    invalidArchive("Invalid spreadsheet archive: local and directory metadata disagree.");
  }
  if (localCompressedBytes === 0xffffffff || localExpandedBytes === 0xffffffff) {
    invalidArchive("This spreadsheet uses ZIP64, which is not supported for safe previews.");
  }

  const extraOffset = localHeaderOffset + 30 + fileNameLength;
  rejectZip64ExtraField(bytes, extraOffset, extraLength);
  const dataOffset = extraOffset + extraLength;
  ensureRange(bytes, dataOffset, compressedBytes);
  if (dataOffset + compressedBytes > centralDirectoryOffset) {
    invalidArchive("Invalid spreadsheet archive: file data overlaps its directory.");
  }

  // Bit 3 indicates a trailing data descriptor, in which case zero local sizes
  // are normal and the central-directory sizes are authoritative.
  if (
    (localFlags & 0x0008) === 0 &&
    (localCompressedBytes !== compressedBytes || localExpandedBytes !== expandedBytes)
  ) {
    invalidArchive("Invalid spreadsheet archive: local and directory sizes disagree.");
  }
}

/**
 * Inspect OOXML ZIP metadata without inflating any entry. SheetJS eagerly
 * expands archive entries, so this must succeed before untrusted bytes reach it.
 */
export function preflightSpreadsheetArchive(bytes: Uint8Array): SpreadsheetArchivePreflightResult {
  try {
    const eocdOffset = findEndOfCentralDirectory(bytes);
    if (eocdOffset >= 20 && readUint32(bytes, eocdOffset - 20) === ZIP64_END_LOCATOR_SIGNATURE) {
      invalidArchive("This spreadsheet uses ZIP64, which is not supported for safe previews.");
    }

    const diskNumber = readUint16(bytes, eocdOffset + 4);
    const centralDirectoryDisk = readUint16(bytes, eocdOffset + 6);
    const entriesOnDisk = readUint16(bytes, eocdOffset + 8);
    const entryCount = readUint16(bytes, eocdOffset + 10);
    const centralDirectorySize = readUint32(bytes, eocdOffset + 12);
    const centralDirectoryOffset = readUint32(bytes, eocdOffset + 16);
    if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entryCount) {
      invalidArchive("Multi-disk spreadsheets cannot be previewed safely.");
    }
    if (
      entriesOnDisk === 0xffff ||
      entryCount === 0xffff ||
      centralDirectorySize === 0xffffffff ||
      centralDirectoryOffset === 0xffffffff
    ) {
      invalidArchive("This spreadsheet uses ZIP64, which is not supported for safe previews.");
    }
    if (entryCount === 0 || entryCount > SPREADSHEET_PREVIEW_MAX_ARCHIVE_ENTRIES) {
      invalidArchive("This spreadsheet contains too many archive entries to preview safely.");
    }

    ensureRange(bytes, centralDirectoryOffset, centralDirectorySize);
    const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
    if (centralDirectoryEnd > eocdOffset) {
      invalidArchive("Invalid spreadsheet archive: directory bounds are malformed.");
    }

    let cursor = centralDirectoryOffset;
    let compressedTotal = 0;
    let expandedTotal = 0;
    for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
      ensureRange(bytes, cursor, 46);
      if (readUint32(bytes, cursor) !== CENTRAL_DIRECTORY_ENTRY_SIGNATURE) {
        invalidArchive("Invalid spreadsheet archive: directory entry is missing.");
      }

      const flags = readUint16(bytes, cursor + 8);
      const method = readUint16(bytes, cursor + 10);
      const compressedBytes = readUint32(bytes, cursor + 20);
      const expandedBytes = readUint32(bytes, cursor + 24);
      const fileNameLength = readUint16(bytes, cursor + 28);
      const extraLength = readUint16(bytes, cursor + 30);
      const commentLength = readUint16(bytes, cursor + 32);
      const diskStart = readUint16(bytes, cursor + 34);
      const localHeaderOffset = readUint32(bytes, cursor + 42);
      if (
        compressedBytes === 0xffffffff ||
        expandedBytes === 0xffffffff ||
        localHeaderOffset === 0xffffffff ||
        diskStart === 0xffff
      ) {
        invalidArchive("This spreadsheet uses ZIP64, which is not supported for safe previews.");
      }
      if (diskStart !== 0) {
        invalidArchive("Multi-disk spreadsheets cannot be previewed safely.");
      }
      rejectEncryption(flags);
      rejectUnsafeCompression(compressedBytes, expandedBytes, method);

      const extraOffset = cursor + 46 + fileNameLength;
      rejectZip64ExtraField(bytes, extraOffset, extraLength);
      const entryLength = 46 + fileNameLength + extraLength + commentLength;
      ensureRange(bytes, cursor, entryLength);
      if (cursor + entryLength > centralDirectoryEnd) {
        invalidArchive("Invalid spreadsheet archive: directory entry exceeds its bounds.");
      }

      validateLocalHeader(
        bytes,
        centralDirectoryOffset,
        localHeaderOffset,
        flags,
        method,
        compressedBytes,
        expandedBytes,
      );

      compressedTotal += compressedBytes;
      expandedTotal += expandedBytes;
      if (
        !Number.isSafeInteger(compressedTotal) ||
        !Number.isSafeInteger(expandedTotal) ||
        expandedTotal > SPREADSHEET_PREVIEW_MAX_EXPANDED_BYTES
      ) {
        invalidArchive("This spreadsheet expands beyond the safe preview limit.");
      }
      cursor += entryLength;
    }

    if (cursor !== centralDirectoryEnd) {
      // Permit the optional PKZIP central-directory digital-signature record,
      // but no unknown trailing metadata.
      ensureRange(bytes, cursor, 6);
      const signatureLength = readUint16(bytes, cursor + 4);
      if (
        readUint32(bytes, cursor) !== CENTRAL_DIRECTORY_DIGITAL_SIGNATURE ||
        cursor + 6 + signatureLength !== centralDirectoryEnd
      ) {
        invalidArchive("Invalid spreadsheet archive: directory size is inconsistent.");
      }
    }
    if (
      expandedTotal > 0 &&
      (compressedTotal === 0 ||
        expandedTotal / compressedTotal > SPREADSHEET_PREVIEW_MAX_COMPRESSION_RATIO)
    ) {
      invalidArchive("This spreadsheet has an unsafe archive compression ratio.");
    }

    return {
      status: "ready",
      entryCount,
      compressedBytes: compressedTotal,
      expandedBytes: expandedTotal,
    };
  } catch (error: unknown) {
    return {
      status: "error",
      message:
        error instanceof InvalidArchiveError
          ? error.message
          : "Invalid spreadsheet archive: metadata could not be inspected safely.",
    };
  }
}
