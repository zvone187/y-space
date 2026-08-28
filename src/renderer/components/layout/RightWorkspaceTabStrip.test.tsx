import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderWithI18n as render } from "@/renderer/testUtils/i18n";
import type { RightWorkspaceTab } from "@/renderer/state/rightWorkspaceTabs";
import { RightWorkspaceTabStrip } from "./RightWorkspaceTabStrip";

const tabs: RightWorkspaceTab[] = [
  {
    id: "tool:files",
    kind: "tool",
    tool: "files",
    title: "Files",
    closable: true,
  },
  {
    id: "tool:git",
    kind: "tool",
    tool: "git",
    title: "Git",
    closable: true,
  },
  {
    id: "tool:usage",
    kind: "tool",
    tool: "usage",
    title: "Usage",
    closable: true,
  },
];

describe("RightWorkspaceTabStrip", () => {
  it("exposes one selected tab and one roving-tabindex entry", () => {
    render(
      <RightWorkspaceTabStrip
        tabs={tabs}
        activeTabId="tool:git"
        onActivate={vi.fn<(tabId: string) => void>()}
        onClose={vi.fn<(tabId: string) => void>()}
      />,
    );

    expect(screen.getByRole("tablist", { name: "Tabs" })).toBeInTheDocument();
    const renderedTabs = screen.getAllByRole("tab");
    expect(renderedTabs).toHaveLength(3);
    expect(renderedTabs.filter((tab) => tab.getAttribute("aria-selected") === "true")).toEqual([
      screen.getByRole("tab", { name: "Git" }),
    ]);
    expect(renderedTabs.filter((tab) => tab.tabIndex === 0)).toEqual([
      screen.getByRole("tab", { name: "Git" }),
    ]);
    expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tab", { name: "Usage" })).toHaveAttribute("tabindex", "-1");
  });

  it("uses one flat strip with an orange selected indicator and embedded actions", () => {
    render(
      <RightWorkspaceTabStrip
        tabs={tabs}
        activeTabId="tool:git"
        onActivate={vi.fn<(tabId: string) => void>()}
        onClose={vi.fn<(tabId: string) => void>()}
        actions={<button type="button">Open workspace tools</button>}
      />,
    );

    expect(screen.getAllByRole("tablist")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Open workspace tools" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Git" }).parentElement).toHaveClass(
      "border-b-2",
      "border-[var(--accent)]",
      "rounded-none",
    );
    expect(screen.getByRole("tab", { name: "Files" }).parentElement).not.toHaveClass(
      "border-[var(--accent)]",
    );
  });

  it("moves focus and requests activation with Arrow, Home, and End keys", () => {
    const onActivate = vi.fn<(tabId: string) => void>();
    render(
      <RightWorkspaceTabStrip
        tabs={tabs}
        activeTabId="tool:git"
        onActivate={onActivate}
        onClose={vi.fn<(tabId: string) => void>()}
      />,
    );
    const files = screen.getByRole("tab", { name: "Files" });
    const git = screen.getByRole("tab", { name: "Git" });
    const usage = screen.getByRole("tab", { name: "Usage" });
    git.focus();

    fireEvent.keyDown(git, { key: "ArrowRight" });
    expect(document.activeElement).toBe(usage);
    expect(onActivate).toHaveBeenLastCalledWith("tool:usage");

    fireEvent.keyDown(usage, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(git);
    expect(onActivate).toHaveBeenLastCalledWith("tool:git");

    fireEvent.keyDown(git, { key: "Home" });
    expect(document.activeElement).toBe(files);
    expect(onActivate).toHaveBeenLastCalledWith("tool:files");

    fireEvent.keyDown(files, { key: "End" });
    expect(document.activeElement).toBe(usage);
    expect(onActivate).toHaveBeenLastCalledWith("tool:usage");

    fireEvent.keyDown(usage, { key: "ArrowRight" });
    expect(document.activeElement).toBe(files);
    expect(onActivate).toHaveBeenLastCalledWith("tool:files");
  });

  it("restores focus to the next adjacent tab after the focused tab is closed", async () => {
    const onClose = vi.fn<(tabId: string) => void>();

    function ControlledStrip() {
      const [workspace, setWorkspace] = useState({
        tabs,
        activeTabId: "tool:git" as string | null,
      });

      const closeTab = (tabId: string) => {
        onClose(tabId);
        setWorkspace((current) => {
          const closedIndex = current.tabs.findIndex((tab) => tab.id === tabId);
          const remainingTabs = current.tabs.filter((tab) => tab.id !== tabId);
          const adjacent = remainingTabs[closedIndex] ?? remainingTabs[closedIndex - 1];
          return {
            tabs: remainingTabs,
            activeTabId:
              current.activeTabId === tabId ? (adjacent?.id ?? null) : current.activeTabId,
          };
        });
      };

      return (
        <RightWorkspaceTabStrip
          tabs={workspace.tabs}
          activeTabId={workspace.activeTabId}
          onActivate={(tabId) => setWorkspace((current) => ({ ...current, activeTabId: tabId }))}
          onClose={closeTab}
        />
      );
    }

    render(<ControlledStrip />);
    const gitTab = screen.getByRole("tab", { name: "Git" });
    const closeGit = within(gitTab.parentElement!).getByRole("button", { name: /close/i });
    closeGit.focus();

    fireEvent.click(closeGit);

    expect(onClose).toHaveBeenCalledWith("tool:git");
    expect(screen.queryByRole("tab", { name: "Git" })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Usage" })),
    );
    expect(screen.getByRole("tab", { name: "Usage" })).toHaveAttribute("aria-selected", "true");
  });
});
