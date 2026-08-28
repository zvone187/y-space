import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithI18n as render } from "@/renderer/testUtils/i18n";
import { usePanelStore } from "@/renderer/state/panelStore";
import { SidebarHeaderControls } from "./SidebarHeaderControls";

vi.mock("@/renderer/bridge", () => ({
  readBridge: () => ({
    listWslDistros: vi.fn<() => Promise<string[]>>().mockReturnValue(new Promise(() => undefined)),
  }),
}));

describe("SidebarHeaderControls", () => {
  beforeEach(() => {
    usePanelStore.setState({
      threadSortMode: "updated",
      threadListLayout: "flat",
      browserPanelOpen: false,
    });
  });

  it("keeps only search, add project, and one overflow control in the header", () => {
    render(<SidebarHeaderControls />);

    expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add project" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "List options" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open browser" })).not.toBeInTheDocument();
  });

  it("keeps browser and list preferences in the overflow menu", async () => {
    render(<SidebarHeaderControls />);

    fireEvent.click(screen.getByRole("button", { name: "More" }));

    expect(await screen.findByRole("menuitemcheckbox", { name: "Browser" })).toBeInTheDocument();
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Sort by last updated" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("menuitemcheckbox", { name: "Flat list" })).toBeInTheDocument();
  });
});
