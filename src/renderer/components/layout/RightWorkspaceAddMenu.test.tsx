import { fireEvent, screen } from "@testing-library/react";
import { Files, GitBranch, Terminal } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { renderWithI18n as render } from "@/renderer/testUtils/i18n";
import type { RightPanelTab } from "@/renderer/state/panelStore";
import { RightWorkspaceAddMenu } from "./RightWorkspaceAddMenu";

describe("RightWorkspaceAddMenu", () => {
  it("places one add button beside the global tabs and exposes every addable surface", async () => {
    const onToolChange = vi.fn<(tab: RightPanelTab) => void>();
    const onCreateBrowserTab = vi.fn<() => void>();
    const onImportCookies = vi.fn<() => void>();

    render(
      <RightWorkspaceAddMenu
        tools={[
          { id: "files", label: "Files", icon: Files, visible: true },
          { id: "git", label: "Git", icon: GitBranch, visible: true },
          { id: "terminal", label: "Terminal", icon: Terminal, visible: true },
        ]}
        activeTool="files"
        onToolChange={onToolChange}
        onCreateBrowserTab={onCreateBrowserTab}
        onImportCookies={onImportCookies}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add tab" }));

    expect(await screen.findByRole("menu", { name: "Add tab" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "New browser tab" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Files" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Git" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Terminal" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Import browser cookies" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: "New browser tab" }));
    expect(onCreateBrowserTab).toHaveBeenCalledOnce();
    expect(onToolChange).not.toHaveBeenCalled();
  });

  it("focuses singleton tools and keeps hidden tools out of the menu", async () => {
    const onToolChange = vi.fn<(tab: RightPanelTab) => void>();

    render(
      <RightWorkspaceAddMenu
        tools={[
          { id: "files", label: "Files", icon: Files, visible: true },
          { id: "git", label: "Git", icon: GitBranch, visible: false },
        ]}
        activeTool={null}
        onToolChange={onToolChange}
        onCreateBrowserTab={vi.fn<() => void>()}
        onImportCookies={vi.fn<() => void>()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add tab" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Files" }));

    expect(onToolChange).toHaveBeenCalledWith("files");
    expect(screen.queryByRole("menuitem", { name: "Git" })).not.toBeInTheDocument();
  });
});
