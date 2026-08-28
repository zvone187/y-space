import { fireEvent, screen } from "@testing-library/react";
import { FileDiff, FolderOpen, ListChecks, NotebookPen } from "lucide-react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RightPanelTab } from "@/renderer/state/panelStore";
import { renderWithI18n as render } from "@/renderer/testUtils/i18n";
import { RightWorkspaceActionsMenu } from "./RightWorkspaceActionsMenu";

const { useDraggableMock } = vi.hoisted(() => ({
  useDraggableMock: vi.fn<(options: { id: string; type: string; data: unknown }) => void>(),
}));

vi.mock("@dnd-kit/react", () => ({ useDraggable: useDraggableMock }));

describe("RightWorkspaceActionsMenu", () => {
  beforeEach(() => useDraggableMock.mockClear());

  it("opens visible tools without exposing unavailable conditional tools", async () => {
    const onOpenFiles = vi.fn<() => void>();
    const onToolChange = vi.fn<(tab: RightPanelTab) => void>();

    render(
      <RightWorkspaceActionsMenu
        tools={[
          {
            id: "files",
            label: "Files",
            icon: FolderOpen,
            visible: true,
            onOpen: onOpenFiles,
          },
          { id: "git", label: "Git", icon: FileDiff, visible: true },
          { id: "plan", label: "Plan", icon: ListChecks, visible: false },
        ]}
        activeTool="git"
        onToolChange={onToolChange}
        onHide={vi.fn<() => void>()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Right panel" }));
    expect(await screen.findByRole("menuitemcheckbox", { name: "Files" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemcheckbox", { name: "Git" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitemcheckbox", { name: "Plan" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Files" }));
    expect(onOpenFiles).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Right panel" }));
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Git" }));
    expect(onToolChange).toHaveBeenCalledWith("git");
  });

  it("reports every simultaneously visible tool as selected", async () => {
    render(
      <RightWorkspaceActionsMenu
        tools={[
          { id: "files", label: "Files", icon: FolderOpen, visible: true },
          { id: "git", label: "Git", icon: FileDiff, visible: true },
          { id: "notes", label: "Notes", icon: NotebookPen, visible: true },
          { id: "plan", label: "Plan", icon: ListChecks, visible: false },
        ]}
        activeTool="files"
        splitTool="git"
        dockedTools={["notes", "plan"]}
        onToolChange={vi.fn<(tab: RightPanelTab) => void>()}
        onHide={vi.fn<() => void>()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Right panel" }));

    for (const name of ["Files", "Git", "Notes"]) {
      expect(await screen.findByRole("menuitemcheckbox", { name })).toHaveAttribute(
        "aria-checked",
        "true",
      );
    }
    expect(screen.queryByRole("menuitemcheckbox", { name: "Plan" })).not.toBeInTheDocument();
  });

  it("keeps compact drag sources for visible dockable tools", async () => {
    render(
      <RightWorkspaceActionsMenu
        tools={[
          { id: "files", label: "Files", icon: FolderOpen, visible: true },
          { id: "notes", label: "Notes", icon: NotebookPen, visible: true },
          { id: "browser", label: "Browser", icon: ListChecks, visible: true },
          { id: "git", label: "Git", icon: FileDiff, visible: false },
        ]}
        activeTool="files"
        onToolChange={vi.fn<(tab: RightPanelTab) => void>()}
        onHide={vi.fn<() => void>()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Right panel" }));
    await screen.findByRole("menuitemcheckbox", { name: "Files" });

    expect(document.querySelector('[data-panel-tool-drag-handle="files"]')).not.toBeNull();
    expect(document.querySelector('[data-panel-tool-drag-handle="notes"]')).not.toBeNull();
    expect(document.querySelector('[data-panel-tool-drag-handle="browser"]')).toBeNull();
    expect(document.querySelector('[data-panel-tool-drag-handle="git"]')).toBeNull();
    expect(useDraggableMock.mock.calls.map(([options]) => options.data)).toEqual([
      { type: "panel-tab", tab: "files" },
      { type: "panel-tab", tab: "notes" },
    ]);
  });

  it("keeps maximize, panel lock, and hide actions in the compact menu", async () => {
    const onMaximize = vi.fn<() => void>();
    const onToggleFollowsThread = vi.fn<() => void>();
    const onHide = vi.fn<() => void>();

    render(
      <RightWorkspaceActionsMenu
        tools={[]}
        activeTool={null}
        onToolChange={vi.fn<(tab: RightPanelTab) => void>()}
        onMaximize={onMaximize}
        followsThread={false}
        onToggleFollowsThread={onToggleFollowsThread}
        onHide={onHide}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Right panel" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Maximize" }));
    expect(onMaximize).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Right panel" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Lock panel to the open thread" }));
    expect(onToggleFollowsThread).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Right panel" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Hide panel" }));
    expect(onHide).toHaveBeenCalledOnce();
  });
});
