import { type CSSProperties, type ReactNode, useRef } from "react";
import { PanelRightClose, X } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { PanelDockDropZone } from "@/renderer/components/layout/PanelDock/PanelDockDropZone";
import { PanelSectionHeader } from "@/renderer/components/layout/PanelDock/PanelSectionHeader";
import {
  PANEL_TAB_ICONS,
  usePanelTabLabels,
} from "@/renderer/components/layout/PanelDock/panelTabMeta";
import { useSplitPercent } from "@/renderer/components/layout/PanelDock/useSplitPercent";
import { panelHeaderIconButtonClass } from "@/renderer/components/layout/sidebarChrome";
import type { RightPanelTab } from "@/renderer/state/panelStore";
import type { RightWorkspaceTab } from "@/renderer/state/rightWorkspaceTabs";
import {
  RightWorkspaceActionsMenu,
  type RightWorkspaceToolMenuItem,
} from "./RightWorkspaceActionsMenu";
import { RightWorkspaceAddMenu } from "./RightWorkspaceAddMenu";
import { RightWorkspaceTabStrip } from "./RightWorkspaceTabStrip";

export type { RightPanelTab };

export function UnifiedRightPanel(props: {
  activeTab: RightPanelTab;
  onTabChange: (tab: RightPanelTab) => void;
  terminalContent?: ReactNode;
  gitContent: ReactNode;
  filesContent: ReactNode;
  browserContent: ReactNode;
  usageContent?: ReactNode;
  notesContent?: ReactNode;
  portsContent?: ReactNode;
  planContent?: ReactNode;
  subagentContent?: ReactNode;
  subagentModel?: ReactNode;
  subagentTitle?: ReactNode;
  /** Tab-specific action buttons rendered in the workspace strip when the usage tab is active. */
  usageHeaderActions?: ReactNode;
  showTerminalTab?: boolean;
  showFilesTab?: boolean;
  showGitTab?: boolean;
  showUsageTab?: boolean;
  showNotesTab?: boolean;
  showPortsTab?: boolean;
  showPlanTab?: boolean;
  showSubagentTab?: boolean;
  showBrowserTab?: boolean;
  onCloseSubagent?: () => void;
  projectName: string | undefined;
  onExpandGitToOverlay?: () => void;
  onExpandFilesToOverlay?: () => void;
  onExpandBrowserToOverlay?: () => void;
  onOpenGit?: () => void;
  onOpenTerminal?: () => void;
  onOpenFiles?: () => void;
  onOpenBrowser?: () => void;
  onOpenUsage?: () => void;
  onOpenNotes?: () => void;
  onOpenPorts?: () => void;
  onCreateBrowserTab?: () => void;
  onImportBrowserCookies?: () => void;
  /** Whether the panel re-scopes itself to whichever thread is open. */
  followsThread?: boolean;
  onToggleFollowsThread?: () => void;
  /** Second tab rendered stacked with the active one (drag-and-drop split). */
  splitTab?: RightPanelTab;
  /** Which half of the panel the split tab occupies. */
  splitPlacement?: "top" | "bottom";
  onCloseSplit?: () => void;
  /** Tabs painted in the bottom row; their icons stay lit even though this panel skips them. */
  dockedTabs?: readonly RightPanelTab[];
  /** Ordered global tabs for tools and documents in this workspace. */
  workspaceTabs?: readonly RightWorkspaceTab[];
  activeWorkspaceTabId?: string | null;
  documentContent?: ReactNode;
  onWorkspaceTabActivate?: (tabId: string) => void;
  onWorkspaceTabClose?: (tabId: string) => void;
  onWorkspaceTabReorder?: (tabId: string, toIndex: number) => void;
  onClose: () => void;
}) {
  const {
    activeTab,
    onTabChange,
    terminalContent,
    gitContent,
    filesContent,
    browserContent,
    usageContent,
    notesContent,
    portsContent,
    planContent,
    subagentContent,
    subagentModel,
    subagentTitle,
    usageHeaderActions,
    showTerminalTab = true,
    showFilesTab = true,
    showGitTab = true,
    showUsageTab = true,
    showNotesTab = true,
    showPortsTab = false,
    showPlanTab = false,
    showSubagentTab = false,
    showBrowserTab = true,
    onCloseSubagent,
    onExpandGitToOverlay,
    onExpandFilesToOverlay,
    onExpandBrowserToOverlay,
    onOpenGit,
    onOpenTerminal,
    onOpenFiles,
    onOpenBrowser,
    onOpenUsage,
    onOpenNotes,
    onOpenPorts,
    onCreateBrowserTab,
    onImportBrowserCookies,
    followsThread = false,
    onToggleFollowsThread,
    splitTab,
    splitPlacement = "bottom",
    onCloseSplit,
    dockedTabs = [],
    workspaceTabs = [],
    activeWorkspaceTabId = null,
    documentContent,
    onWorkspaceTabActivate,
    onWorkspaceTabClose,
    onWorkspaceTabReorder,
    onClose,
  } = props;
  const { t } = useLingui();
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const splitFirstPaneRef = useRef<HTMLDivElement>(null);
  const {
    percent: splitPercent,
    minPercent: splitMinPercent,
    maxPercent: splitMaxPercent,
    handleResizeStart: handleSplitResizeStart,
    handleResizeKeyDown: handleSplitResizeKeyDown,
  } = useSplitPercent({
    storageKey: "poracode-right-panel-split-percent",
    orientation: "column",
    containerRef: splitContainerRef,
    paneRef: splitFirstPaneRef,
    defaultPercent: 50,
    minPercent: 20,
  });
  const activeWorkspaceTab = workspaceTabs.find((tab) => tab.id === activeWorkspaceTabId);
  const workspaceDocumentActive = activeWorkspaceTab?.kind === "file";
  const hasSubagentModel =
    !workspaceDocumentActive && activeTab === "subagent" && subagentModel !== undefined;
  const hasSubagentTitle =
    !workspaceDocumentActive && activeTab === "subagent" && subagentTitle !== undefined;

  /** Inline opacity/transition so animation is not dropped if Tailwind misses dynamic class strings. */
  const tabLayerStyle = (tab: RightPanelTab): CSSProperties => {
    const on = !workspaceDocumentActive && activeTab === tab;
    return {
      opacity: on ? 1 : 0,
      zIndex: on ? 10 : 0,
      pointerEvents: on ? "auto" : "none",
      transition: "opacity 120ms ease-out",
    };
  };

  const dragCtl = "poracode-overlay-header__controls";
  const labels = usePanelTabLabels();
  const tabs: readonly (RightWorkspaceToolMenuItem & { content: ReactNode | undefined })[] = [
    {
      id: "plan",
      label: labels.plan,
      icon: PANEL_TAB_ICONS.plan,
      content: planContent,
      visible: showPlanTab,
    },
    {
      id: "subagent",
      label: labels.subagent,
      icon: PANEL_TAB_ICONS.subagent,
      content: subagentContent,
      visible: showSubagentTab,
    },
    {
      id: "terminal",
      label: labels.terminal,
      icon: PANEL_TAB_ICONS.terminal,
      content: terminalContent,
      visible: showTerminalTab,
      onOpen: onOpenTerminal,
    },
    {
      id: "files",
      label: labels.files,
      icon: PANEL_TAB_ICONS.files,
      content: filesContent,
      visible: showFilesTab,
      onOpen: onOpenFiles,
    },
    {
      id: "git",
      label: labels.git,
      icon: PANEL_TAB_ICONS.git,
      content: gitContent,
      visible: showGitTab,
      onOpen: onOpenGit,
    },
    {
      id: "usage",
      label: labels.usage,
      icon: PANEL_TAB_ICONS.usage,
      content: usageContent,
      visible: showUsageTab,
      onOpen: onOpenUsage,
    },
    {
      id: "notes",
      label: labels.notes,
      icon: PANEL_TAB_ICONS.notes,
      content: notesContent,
      visible: showNotesTab,
      onOpen: onOpenNotes,
    },
    {
      id: "ports",
      label: labels.ports,
      icon: PANEL_TAB_ICONS.ports,
      content: portsContent,
      visible: showPortsTab,
      onOpen: onOpenPorts,
    },
    {
      id: "browser",
      label: labels.browser,
      icon: PANEL_TAB_ICONS.browser,
      content: browserContent,
      visible: showBrowserTab,
      onOpen: onOpenBrowser,
    },
  ] as const;

  const splitEntry =
    splitTab && (splitTab !== activeTab || workspaceDocumentActive)
      ? tabs.find((tab) => tab.id === splitTab && tab.visible && tab.content !== undefined)
      : undefined;
  const maximizeActiveTool = workspaceDocumentActive
    ? undefined
    : activeTab === "git"
      ? onExpandGitToOverlay
      : activeTab === "files"
        ? onExpandFilesToOverlay
        : activeTab === "browser"
          ? onExpandBrowserToOverlay
          : undefined;

  return (
    <div
      data-poracode-panel=""
      data-y-space-workspace=""
      data-active-tab={workspaceDocumentActive ? "document" : activeTab}
      className="flex h-full min-h-0 flex-col bg-[var(--content-background)]"
    >
      <RightWorkspaceTabStrip
        tabs={workspaceTabs}
        activeTabId={activeWorkspaceTabId}
        onActivate={(tabId) => onWorkspaceTabActivate?.(tabId)}
        onClose={(tabId) => onWorkspaceTabClose?.(tabId)}
        {...(onWorkspaceTabReorder ? { onReorder: onWorkspaceTabReorder } : {})}
        actions={
          <>
            <RightWorkspaceAddMenu
              tools={tabs}
              activeTool={workspaceDocumentActive ? null : activeTab}
              onToolChange={onTabChange}
              onCreateBrowserTab={onCreateBrowserTab ?? (() => onTabChange("browser"))}
              onImportCookies={onImportBrowserCookies ?? (() => undefined)}
            />
            {hasSubagentModel ? (
              <div className="min-w-0 max-w-40 truncate">{subagentModel}</div>
            ) : null}
            {!workspaceDocumentActive && activeTab === "usage" ? usageHeaderActions : null}
            <button
              type="button"
              aria-label={t`Hide workspace`}
              title={t`Hide workspace`}
              onClick={onClose}
              className="poracode-overlay-header__controls flex size-7 shrink-0 items-center justify-center rounded-lg text-muted outline-none hover:bg-foreground/8 hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus"
            >
              <PanelRightClose className="size-4" aria-hidden="true" />
            </button>
            <RightWorkspaceActionsMenu
              tools={tabs}
              activeTool={workspaceDocumentActive ? null : activeTab}
              {...(splitEntry ? { splitTool: splitEntry.id } : {})}
              dockedTools={dockedTabs}
              onToolChange={onTabChange}
              {...(maximizeActiveTool ? { onMaximize: maximizeActiveTool } : {})}
              followsThread={followsThread}
              {...(onToggleFollowsThread ? { onToggleFollowsThread } : {})}
              onHide={onClose}
            />
          </>
        }
      />
      {hasSubagentTitle ? (
        <div className="poracode-right-panel-subagent-meta flex h-6 shrink-0 items-center gap-2 border-b border-[color:var(--border)] px-3">
          <div className="min-w-0 flex-1">{subagentTitle}</div>
          {onCloseSubagent ? (
            <button
              type="button"
              className={`${dragCtl} ${panelHeaderIconButtonClass}`}
              title={t`Close subagent`}
              onClick={onCloseSubagent}
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Content — stacked layers cross-fade on tab change; a dropped panel-tab
          splits this area into two stacked sections. */}
      <PanelDockDropZone
        zone="right-panel"
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        {(() => {
          const layerStack = (
            <div className="relative min-h-0 flex-1 overflow-hidden">
              {tabs.map((tab) => {
                if (!tab.visible || tab.id === splitEntry?.id) return null;
                const layerActive = !workspaceDocumentActive && activeTab === tab.id;
                return (
                  <div
                    key={tab.id}
                    className="absolute inset-0 flex min-h-0 flex-col overflow-hidden"
                    style={tabLayerStyle(tab.id)}
                    aria-hidden={!layerActive}
                    inert={!layerActive}
                  >
                    {tab.content}
                  </div>
                );
              })}
              {workspaceDocumentActive ? (
                <div className="absolute inset-0 z-10 flex min-h-0 flex-col overflow-hidden">
                  {documentContent}
                </div>
              ) : null}
            </div>
          );

          if (!splitEntry) return layerStack;

          const splitSection = (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <PanelSectionHeader
                tab={splitEntry.id}
                label={splitEntry.label}
                icon={splitEntry.icon}
                {...(onCloseSplit ? { onClose: onCloseSplit } : {})}
              />
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                {splitEntry.content}
              </div>
            </div>
          );

          return (
            <div ref={splitContainerRef} className="flex h-full min-h-0 flex-col">
              <div
                ref={splitFirstPaneRef}
                className="flex min-h-0 flex-col overflow-hidden"
                style={{ flexBasis: `${splitPercent}%`, flexGrow: 0, flexShrink: 0 }}
              >
                {splitPlacement === "top" ? splitSection : layerStack}
              </div>
              <div
                className="poracode-pane-divider-horizontal"
                onPointerDown={handleSplitResizeStart}
                onKeyDown={handleSplitResizeKeyDown}
                role="separator"
                tabIndex={0}
                aria-orientation="horizontal"
                aria-label={t`Resize split`}
                aria-valuenow={Math.round(splitPercent)}
                aria-valuemin={splitMinPercent}
                aria-valuemax={splitMaxPercent}
              />
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                {splitPlacement === "top" ? layerStack : splitSection}
              </div>
            </div>
          );
        })()}
      </PanelDockDropZone>
    </div>
  );
}
