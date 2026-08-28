import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfDocumentPreview } from "./PdfDocumentPreview";

const encoder = new TextEncoder();
const FIRST_PDF = encoder.encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF");
const SECOND_PDF = encoder.encode("%PDF-1.7\n2 0 obj\n<<>>\nendobj\n%%EOF");

describe("PdfDocumentPreview", () => {
  const createObjectURL = vi.fn<(blob: Blob) => string>();
  const revokeObjectURL = vi.fn<(url: string) => void>();

  beforeEach(() => {
    createObjectURL.mockReset();
    createObjectURL
      .mockReturnValueOnce("blob:y-space/first")
      .mockReturnValueOnce("blob:y-space/second");
    revokeObjectURL.mockReset();
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: createObjectURL },
      revokeObjectURL: { configurable: true, value: revokeObjectURL },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses Chromium's PDF embed and revokes every Blob URL it replaces", () => {
    const { rerender, unmount } = render(
      <PdfDocumentPreview path="docs/manual.pdf" bytes={FIRST_PDF} />,
    );

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const firstBlob = createObjectURL.mock.calls[0]?.[0];
    expect(firstBlob).toBeInstanceOf(Blob);
    expect(firstBlob?.type).toBe("application/pdf");
    expect(firstBlob?.size).toBe(FIRST_PDF.byteLength);
    expect(screen.getAllByTitle("PDF preview: manual.pdf")).toHaveLength(1);
    expect(screen.getByTitle("PDF preview: manual.pdf")).toHaveAttribute(
      "src",
      "blob:y-space/first",
    );
    expect(screen.getByTitle("PDF preview: manual.pdf").tagName).toBe("EMBED");
    expect(screen.getByTitle("PDF preview: manual.pdf")).toHaveAttribute("type", "application/pdf");
    expect(screen.getByTitle("PDF preview: manual.pdf")).not.toHaveAttribute("sandbox");

    rerender(<PdfDocumentPreview path="docs/manual.pdf" bytes={FIRST_PDF} />);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTitle("PDF preview: manual.pdf")).toHaveLength(1);

    rerender(<PdfDocumentPreview path="docs/revised.pdf" bytes={SECOND_PDF} />);
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:y-space/first");
    expect(screen.getAllByTitle("PDF preview: revised.pdf")).toHaveLength(1);
    expect(screen.getByTitle("PDF preview: revised.pdf")).toHaveAttribute(
      "src",
      "blob:y-space/second",
    );

    unmount();
    expect(revokeObjectURL).toHaveBeenLastCalledWith("blob:y-space/second");
  });

  it("rejects malformed PDF bytes without creating a Blob URL", async () => {
    render(<PdfDocumentPreview path="docs/broken.pdf" bytes={encoder.encode("not a pdf")} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/could not preview|invalid pdf/i);
    expect(alert.textContent?.length).toBeLessThan(240);
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("rejects oversized PDFs before allocating a Blob URL", async () => {
    render(
      <PdfDocumentPreview path="docs/oversized.pdf" bytes={new Uint8Array(65)} maxBytes={64} />,
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/too large|size limit/i);
    expect(alert.textContent?.length).toBeLessThan(240);
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
