import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { renderWithI18n as render } from "@/renderer/testUtils/i18n";
import { useDevTerminalStore } from "@/renderer/state/devTerminalStore";
import { usePanelStore } from "@/renderer/state/panelStore";
import { useRightWorkspaceTabsStore } from "@/renderer/state/rightWorkspaceTabsStore";
import { useSharedSettings } from "@/renderer/state/sharedSettingsStore";
import { ThreadToolsMenu } from "./ThreadToolsMenu";

describe("ThreadToolsMenu", () => {
  beforeEach(() => {
    useRightWorkspaceTabsStore.getState().reset();
    usePanelStore.setState({
      gitReviewAsPanel: false,
      gitReviewContext: null,
      filesPanelContext: null,
      notesPanelOpen: false,
      rightPanelTab: "files",
      rightPanelSplit: null,
      bottomPanelDocks: { left: null, right: null },
    });
    useDevTerminalStore.setState({
      isOpen: false,
      activeProjectId: null,
      activeWorktreePath: null,
    });
    useSharedSettings.setState({ terminalPosition: "bottom" });
  });

  it("reports active, split, and bottom-docked thread tools as selected", async () => {
    usePanelStore.setState({
      gitReviewAsPanel: true,
      gitReviewContext: { projectId: "project-1", worktreePath: "/tmp/project-1" },
      filesPanelContext: {
        projectId: "project-1",
        projectName: "Project 1",
        worktreePath: "/tmp/project-1",
        rootLabel: "Project 1",
      },
      notesPanelOpen: true,
      rightPanelTab: "files",
      rightPanelSplit: { tab: "git", placement: "bottom" },
      bottomPanelDocks: { left: "notes", right: null },
    });
    useRightWorkspaceTabsStore.getState().openTool("files");

    render(<ThreadToolsMenu projectId="project-1" worktreePath="/tmp/project-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Show thread tools" }));

    for (const name of ["Git", "Files", "Notes"]) {
      expect(await screen.findByRole("menuitemcheckbox", { name })).toHaveAttribute(
        "aria-checked",
        "true",
      );
    }
    expect(screen.getByRole("menuitemcheckbox", { name: "Terminal" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });
});
