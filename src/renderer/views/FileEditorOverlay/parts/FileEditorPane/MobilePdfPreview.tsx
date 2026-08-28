import { useMemo } from "react";
import { Trans } from "@lingui/react/macro";
import { PdfDocumentPreview } from "@/renderer/components/files/PdfDocumentPreview";
import type { ProjectFileReadStatus } from "@/shared/contracts";
import { PROJECT_FILE_PREVIEW_DEFAULT_MAX_BYTES } from "@/shared/contracts";

function decodeBoundedBase64(value: string, maxBytes: number): Uint8Array | null {
  const encoded = value.trim();
  if (encoded.length === 0 || encoded.length % 4 !== 0) return null;
  if (encoded.length > Math.ceil(maxBytes / 3) * 4) return null;

  // Reject malformed or oversized input before atob allocates its decoded
  // string. ProjectTreeService applies the same byte ceiling before sending
  // the payload, but the renderer treats every bridge response defensively.
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    return null;
  }
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const decodedLength = (encoded.length / 4) * 3 - padding;
  if (decodedLength <= 0 || decodedLength > maxBytes) return null;

  try {
    const decoded = globalThis.atob(encoded);
    if (decoded.length !== decodedLength || decoded.length > maxBytes) return null;
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) {
      bytes[index] = decoded.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

export function MobilePdfPreview(props: {
  path: string;
  status: ProjectFileReadStatus;
  contentBase64?: string;
}) {
  const bytes = useMemo(
    () =>
      props.status === "binary" && props.contentBase64
        ? decodeBoundedBase64(props.contentBase64, PROJECT_FILE_PREVIEW_DEFAULT_MAX_BYTES)
        : null,
    [props.contentBase64, props.status],
  );

  if (props.status === "too_large") {
    return (
      <div
        role="alert"
        className="m-4 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger"
      >
        <Trans>This PDF is too large for the built-in preview.</Trans>
      </div>
    );
  }

  if (!bytes) {
    return (
      <div
        role="alert"
        className="m-4 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger"
      >
        <Trans>This PDF could not be loaded in the built-in preview.</Trans>
      </div>
    );
  }

  return (
    <PdfDocumentPreview
      path={props.path}
      bytes={bytes}
      maxBytes={PROJECT_FILE_PREVIEW_DEFAULT_MAX_BYTES}
    />
  );
}
