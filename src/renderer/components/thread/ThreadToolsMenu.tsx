import { Dropdown, Label } from "@heroui/react";
import type { LucideIcon } from "lucide-react";
import { Ellipsis, FileDiff, FolderOpen, NotebookPen, TerminalSquare } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { isHomeProjectId } from "@/shared/homeScope";
import {
  closeGitPanel,
  openFilesPanel,
  openNotesPanel,
  showGitReviewPanel,
} from "@/renderer/actions/panelActions";
import { openTerminal, openWorktreeTerminal } from "@/renderer/actions/terminalActions";
import { useDevTerminalStore } from "@/renderer/state/devTerminalStore";
import { useBottomDockedTabs } from "@/renderer/state/panelDockSelectors";
import { usePanelStore } from "@/renderer/state/panelStore";
import { useSharedSettings } from "@/renderer/state/sharedSettingsStore";
import { useRightWorkspaceTabsStore } from "@/renderer/state/rightWorkspaceTabsStore";
import { rightWorkspaceToolTabId } from "@/renderer/state/rightWorkspaceTabs";

interface ThreadTool {
  id: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
  activate: () => void;
}

/**
 * Thread-scoped workspace destinations live behind one conventional menu.
 * This keeps the conversation unobstructed at every pane width while retaining
 * direct access to Git, files, terminal, and notes for the selected thread.
 */
export function ThreadToolsMenu(props: { projectId: string; worktreePath?: string | undefined }) {
  const { t } = useLingui();
  const { projectId, worktreePath } = props;
  const gitScoped = usePanelStore(
    (s) =>
      s.gitReviewAsPanel &&
      s.gitReviewContext?.projectId === projectId &&
      s.gitReviewContext?.worktreePath === worktreePath,
  );
  const filesScoped = usePanelStore(
    (s) =>
      s.filesPanelContext?.projectId === projectId &&
      s.filesPanelContext?.worktreePath === worktreePath,
  );
  const notesPanelOpen = usePanelStore((s) => s.notesPanelOpen);
  const splitTool = usePanelStore((s) => s.rightPanelSplit?.tab);
  const dockedTools = useBottomDockedTabs();
  const terminalScoped = useDevTerminalStore(
    (s) =>
      s.isOpen &&
      s.activeProjectId === projectId &&
      (s.activeWorktreePath ?? undefined) === worktreePath,
  );
  const terminalOnRight = useSharedSettings((s) => s.terminalPosition === "right");
  const activeWorkspaceTabId = useRightWorkspaceTabsStore((s) => s.activeTabId);
  const toolOnScreen = (tool: "git" | "files" | "terminal" | "notes") =>
    activeWorkspaceTabId === rightWorkspaceToolTabId(tool) ||
    splitTool === tool ||
    dockedTools.left === tool ||
    dockedTools.right === tool;
  const gitActive = gitScoped && toolOnScreen("git");
  const terminalActive = terminalScoped && (!terminalOnRight || toolOnScreen("terminal"));

  const tools: ThreadTool[] = [
    ...(isHomeProjectId(projectId)
      ? []
      : [
          {
            id: "git",
            label: t`Git`,
            icon: FileDiff,
            active: gitActive,
            activate: () => {
              if (gitActive) {
                closeGitPanel();
                return;
              }
              showGitReviewPanel(projectId, worktreePath);
            },
          },
          {
            id: "files",
            label: t`Files`,
            icon: FolderOpen,
            active: filesScoped && toolOnScreen("files"),
            activate: () => openFilesPanel(projectId, worktreePath),
          },
        ]),
    {
      id: "terminal",
      label: t`Terminal`,
      icon: TerminalSquare,
      active: terminalActive,
      activate: () => {
        if (worktreePath) {
          openWorktreeTerminal(projectId, worktreePath);
          return;
        }
        openTerminal(projectId);
      },
    },
    {
      id: "notes",
      label: t`Notes`,
      icon: NotebookPen,
      active: notesPanelOpen && toolOnScreen("notes"),
      activate: openNotesPanel,
    },
  ];

  return (
    <Dropdown>
      <Dropdown.Trigger
        aria-label={t`Show thread tools`}
        className="poracode-overlay-header__controls inline-flex size-6 shrink-0 items-center justify-center rounded text-muted outline-none transition-colors hover:bg-[var(--row-hover)] hover:text-foreground focus-visible:focus-ring"
      >
        <Ellipsis className="size-3.5" />
      </Dropdown.Trigger>
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu
          aria-label={t`Show thread tools`}
          className="poracode-menu min-w-44"
          selectionMode="multiple"
          selectedKeys={tools.filter((tool) => tool.active).map((tool) => tool.id)}
          onAction={(key) => tools.find((tool) => tool.id === String(key))?.activate()}
        >
          {tools.map((tool) => {
            const Icon = tool.icon;
            return (
              <Dropdown.Item
                key={tool.id}
                id={tool.id}
                textValue={tool.label}
                shouldCloseOnSelect
                {...(tool.active ? { className: "text-foreground" } : {})}
              >
                <Icon
                  className={`size-4 shrink-0 ${tool.active ? "text-accent-text" : "text-muted"}`}
                />
                <Label>{tool.label}</Label>
                <Dropdown.ItemIndicator />
              </Dropdown.Item>
            );
          })}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
