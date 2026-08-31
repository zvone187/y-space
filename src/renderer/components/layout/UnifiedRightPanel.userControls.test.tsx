import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithI18n as render } from "@/renderer/testUtils/i18n";
import type { RightPanelTab } from "@/renderer/state/panelStore";
import { UnifiedRightPanel } from "./UnifiedRightPanel";

describe("UnifiedRightPanel user controls", () => {
  it("keeps a clearly visible hide button in the top-right chrome", () => {
    const onClose = vi.fn<() => void>();

    render(
      <UnifiedRightPanel
        activeTab="files"
        onTabChange={vi.fn<(tab: RightPanelTab) => void>()}
        gitContent={<div>Git</div>}
        filesContent={<div>Files</div>}
        browserContent={<div>Browser</div>}
        projectName="Y Space"
        onClose={onClose}
      />,
    );

    const hide = screen.getByRole("button", { name: "Hide workspace" });
    expect(hide).toBeVisible();
    fireEvent.click(hide);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
