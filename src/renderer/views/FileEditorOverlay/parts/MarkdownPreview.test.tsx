import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownPreview } from "./MarkdownPreview";

describe("MarkdownPreview", () => {
  const openExternal = vi.fn<(url: string) => Promise<void>>(async () => undefined);

  beforeEach(() => {
    openExternal.mockClear();
    Object.defineProperty(window, "poracode", {
      configurable: true,
      value: { openExternal },
    });
  });

  it.each([
    ["HTTP(S)", "https://example.test/docs"],
    ["mailto", "mailto:hello@example.test"],
  ])("routes %s links through the app link handler", (_label, href) => {
    render(<MarkdownPreview content={`[Open link](${href})`} />);

    fireEvent.click(screen.getByRole("link", { name: "Open link" }));

    expect(openExternal).toHaveBeenCalledWith(href);
  });
});
