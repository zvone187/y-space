import { fireEvent } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { renderWithI18n as render } from "@/renderer/testUtils/i18n";
import { BrowserDockSlot } from "./BrowserDockSlot";

it("offers only the recovery action when an older session left the browser extracted", () => {
  const onBringBack = vi.fn<() => void>();
  const view = render(<BrowserDockSlot extracted onBringBack={onBringBack} />);

  expect(view.queryByRole("button", { name: "Focus window" })).not.toBeInTheDocument();
  fireEvent.click(view.getByRole("button", { name: "Bring back to panel" }));
  expect(onBringBack).toHaveBeenCalledOnce();
});
