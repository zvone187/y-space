import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BrandWordmark } from "./BrandWordmark";

describe("BrandWordmark", () => {
  it("renders the Y Space product name for sighted and assistive-technology users", () => {
    render(<BrandWordmark />);

    const wordmark = screen.getByLabelText("Y Space");
    expect(wordmark).toHaveTextContent("YSpace");
    expect(wordmark).not.toHaveTextContent(/Poracode|Lightcode/i);
  });
});
