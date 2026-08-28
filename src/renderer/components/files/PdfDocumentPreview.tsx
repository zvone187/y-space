import { useEffect, useState } from "react";

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const PDF_HEADER_SEARCH_BYTES = 1_024;
const PDF_TRAILER_SEARCH_BYTES = 2_048;

function containsAscii(
  bytes: Uint8Array,
  value: string,
  startIndex: number,
  endIndex: number,
): boolean {
  const pattern = Array.from(value, (character) => character.charCodeAt(0));
  const finalStart = Math.min(bytes.byteLength - pattern.length, endIndex - pattern.length);
  for (let index = Math.max(0, startIndex); index <= finalStart; index += 1) {
    if (pattern.every((character, offset) => bytes[index + offset] === character)) return true;
  }
  return false;
}

function validatePdf(bytes: Uint8Array, maxBytes: number): string | null {
  if (bytes.byteLength > maxBytes) {
    return "This PDF is too large to preview safely (size limit exceeded).";
  }
  if (bytes.byteLength === 0) return "This PDF is empty and could not be previewed.";

  const hasHeader = containsAscii(
    bytes,
    "%PDF-",
    0,
    Math.min(bytes.byteLength, PDF_HEADER_SEARCH_BYTES),
  );
  const hasTrailer = containsAscii(
    bytes,
    "%%EOF",
    Math.max(0, bytes.byteLength - PDF_TRAILER_SEARCH_BYTES),
    bytes.byteLength,
  );
  if (!hasHeader || !hasTrailer) {
    return "Invalid PDF: this document could not be previewed.";
  }

  return null;
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "document.pdf";
}

export function PdfDocumentPreview(props: { path: string; bytes: Uint8Array; maxBytes?: number }) {
  const { path, bytes, maxBytes = DEFAULT_MAX_BYTES } = props;
  const validationError = validatePdf(bytes, Math.max(0, maxBytes));
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [allocationError, setAllocationError] = useState<string | null>(null);

  useEffect(() => {
    if (validationError) {
      setObjectUrl(null);
      setAllocationError(null);
      return;
    }

    let nextUrl: string | null = null;
    try {
      const copy = Uint8Array.from(bytes);
      nextUrl = URL.createObjectURL(new Blob([copy.buffer], { type: "application/pdf" }));
      setObjectUrl(nextUrl);
      setAllocationError(null);
    } catch {
      setObjectUrl(null);
      setAllocationError("This PDF could not be previewed in the embedded viewer.");
    }

    return () => {
      if (nextUrl) URL.revokeObjectURL(nextUrl);
    };
  }, [bytes, validationError]);

  const error = validationError ?? allocationError;
  if (error) {
    return (
      <div
        role="alert"
        className="m-4 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger"
      >
        {error}
      </div>
    );
  }

  if (!objectUrl) {
    return (
      <div role="status" className="flex h-full items-center justify-center text-sm text-muted">
        Preparing PDF preview…
      </div>
    );
  }

  const title = `PDF preview: ${basename(path)}`;
  return (
    // Chromium deliberately blocks its PDF plugin in any sandboxed iframe
    // (`ERR_BLOCKED_BY_CLIENT`). An application/pdf embed keeps the document
    // inside the already-sandboxed Electron renderer while allowing the
    // built-in viewer to consume only this validated, bounded Blob.
    <embed
      title={title}
      src={objectUrl}
      type="application/pdf"
      className="h-full min-h-0 w-full border-0 bg-white"
    />
  );
}
