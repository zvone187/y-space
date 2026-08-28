// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithI18n as render } from "@/renderer/testUtils/i18n";
import { MobilePdfPreview } from "./MobilePdfPreview";

describe("MobilePdfPreview", () => {
  const createObjectURL = vi.fn<(blob: Blob) => string>();
  const revokeObjectURL = vi.fn<(url: string) => void>();

  beforeEach(() => {
    createObjectURL.mockReset();
    createObjectURL.mockReturnValue("blob:y-space/mobile-pdf");
    revokeObjectURL.mockReset();
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: createObjectURL },
      revokeObjectURL: { configurable: true, value: revokeObjectURL },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("decodes bridge bytes into the embedded PDF viewer", () => {
    const pdf = "%PDF-1.7\nmobile preview\n%%EOF";
    const { unmount } = render(
      <MobilePdfPreview
        path="docs/mobile.pdf"
        status="binary"
        contentBase64={globalThis.btoa(pdf)}
      />,
    );

    expect(screen.getByTitle("PDF preview: mobile.pdf")).toHaveAttribute(
      "src",
      "blob:y-space/mobile-pdf",
    );
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(createObjectURL.mock.calls[0]?.[0].size).toBe(pdf.length);

    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:y-space/mobile-pdf");
  });

  it("fails closed when the bridge response has no valid PDF body", async () => {
    render(<MobilePdfPreview path="docs/missing.pdf" status="binary" contentBase64="not-base64" />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be loaded/i);
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("shows the bounded-read error without allocating a Blob", async () => {
    render(<MobilePdfPreview path="docs/large.pdf" status="too_large" />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/too large/i);
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
