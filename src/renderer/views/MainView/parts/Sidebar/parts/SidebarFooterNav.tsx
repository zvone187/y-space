import { Dropdown, Label, Separator } from "@heroui/react";
import {
  Download,
  Ellipsis,
  Gauge,
  Megaphone,
  PanelLeft,
  PanelLeftClose,
  RefreshCw,
  Settings2,
} from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import {
  openRemoteAccessSettings,
  openSettings,
  openUsagePanel,
} from "@/renderer/actions/panelActions";
import { readBridge } from "@/renderer/bridge";
import { sidebarIconButtonClass } from "@/renderer/components/common/SidebarButton";
import { sidebarFooterNavClass } from "@/renderer/components/layout/sidebarChrome";
import { WorkspaceIcon } from "@/renderer/components/workspace/WorkspaceIcon";
import {
  parseWorkspaceMenuKey,
  workspaceMenuKey,
} from "@/renderer/components/workspace/workspaceMenuKeys";
import { DeferredSettingsOverlay } from "@/renderer/deferredFeatures";
import { useChangelogStore, useHasUnseenChangelog } from "@/renderer/state/changelogStore";
import { usePanelStore } from "@/renderer/state/panelStore";
import { useSharedSettings } from "@/renderer/state/sharedSettingsStore";
import { useUpdateStore } from "@/renderer/state/updateStore";
import { useActiveWorkspaceId, useWorkspaceStore } from "@/renderer/state/workspaceStore";
import { useSidebar } from "@/renderer/views/MainView/parts/AppShell/AppShell";
import {
  RemoteAccessSidebarIcon,
  type RemoteAccessSidebarStatus,
} from "@/renderer/views/MainView/parts/Sidebar/parts/RemoteAccessSidebarIcon";
import { useSidebarShortcuts } from "@/renderer/views/MainView/parts/Sidebar/parts/sidebarShortcuts";

function prewarmSettings(): void {
  void DeferredSettingsOverlay.preload();
}

/**
 * The sidebar's one compact destination menu. It is shared by the expanded
 * footer and collapsed icon rail so neither mode grows a second action cluster.
 */
export function SidebarFooterMenu(props: {
  remoteAccessStatus: RemoteAccessSidebarStatus;
  placement?: "top start" | "right bottom";
  sidebarVisibility?: "hide" | "show";
  onSidebarVisibility?: () => void;
}) {
  const { remoteAccessStatus, placement = "top start" } = props;
  const { t } = useLingui();
  const settingsOpen = usePanelStore((state) => state.settingsOpen);
  const settingsSection = usePanelStore((state) => state.settingsSection);
  const usagePanelOpen = usePanelStore((state) => state.usagePanelOpen);
  const remoteAccessSettingsActive = settingsOpen && settingsSection === "remoteAccess";
  const otherSettingsActive = settingsOpen && !remoteAccessSettingsActive;
  const sidebarShortcuts = useSidebarShortcuts();
  const workspaces = useSharedSettings((state) => state.workspaces);
  const activeWorkspaceId = useActiveWorkspaceId();
  const activeWorkspace =
    workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? workspaces[0];
  const updatePhase = useUpdateStore((state) => state.phase);
  const updateVersion = useUpdateStore((state) => state.version);
  const downloadPercent = useUpdateStore((state) => state.downloadPercent);
  const hasUnseenChangelog = useHasUnseenChangelog();
  const whatsNewOpen = useChangelogStore((state) => state.whatsNewOpen);

  const statusLabel =
    remoteAccessStatus === "online"
      ? t`Online`
      : remoteAccessStatus === "starting"
        ? t`Starting`
        : t`Off`;
  const selectedKeys = [
    ...sidebarShortcuts.filter((shortcut) => shortcut.isActive).map((shortcut) => shortcut.id),
    ...(remoteAccessSettingsActive ? ["remoteAccess"] : []),
    ...(otherSettingsActive ? ["settings"] : []),
  ];
  const hasActiveDestination = selectedKeys.length > 0;
  const hasAttention = hasUnseenChangelog || updatePhase === "downloaded";

  function handleAction(key: string): void {
    const shortcut = sidebarShortcuts.find((item) => item.id === key);
    if (shortcut) {
      shortcut.onPress();
      return;
    }
    switch (key) {
      case "usage":
        openUsagePanel();
        break;
      case "whatsNew":
        useChangelogStore.getState().openWhatsNew();
        break;
      case "installUpdate":
        void readBridge().installUpdate();
        break;
      case "remoteAccess":
        openRemoteAccessSettings();
        break;
      case "settings":
        openSettings();
        break;
      case "sidebarVisibility":
        props.onSidebarVisibility?.();
        break;
    }
  }

  return (
    <Dropdown onOpenChange={(open) => open && prewarmSettings()}>
      <Dropdown.Trigger
        aria-label={t`More`}
        className={sidebarIconButtonClass({ isActive: hasActiveDestination })}
      >
        <span className="relative flex size-4 items-center justify-center">
          <Ellipsis className="size-4" />
          {hasAttention ? (
            <span
              aria-hidden="true"
              className="absolute -right-1 -top-1 size-1.5 rounded-full bg-accent"
            />
          ) : null}
        </span>
      </Dropdown.Trigger>
      <Dropdown.Popover placement={placement}>
        <Dropdown.Menu
          aria-label={t`More`}
          className="poracode-menu min-w-56"
          selectionMode="multiple"
          selectedKeys={selectedKeys}
          onAction={(key) => handleAction(String(key))}
        >
          <Dropdown.Section selectionMode="none">
            {workspaces.length >= 2 && activeWorkspace ? (
              <Dropdown.SubmenuTrigger>
                <Dropdown.Item id="workspaceMenu" textValue={t`Workspace`}>
                  <WorkspaceIcon
                    icon={activeWorkspace.icon}
                    className="size-4 shrink-0 text-muted"
                  />
                  <Label>{t`Workspace`}</Label>
                  <span className="ml-auto max-w-28 truncate text-xs text-muted">
                    {activeWorkspace.name}
                  </span>
                  <Dropdown.SubmenuIndicator />
                </Dropdown.Item>
                <Dropdown.Popover>
                  <Dropdown.Menu
                    aria-label={t`Workspaces`}
                    className="poracode-menu min-w-52"
                    selectionMode="single"
                    selectedKeys={[workspaceMenuKey(activeWorkspace.id)]}
                    onAction={(key) => {
                      const selection = parseWorkspaceMenuKey(String(key));
                      if (selection?.kind === "workspace") {
                        useWorkspaceStore.getState().setActiveWorkspaceId(selection.workspaceId);
                      }
                    }}
                  >
                    {workspaces.map((workspace) => (
                      <Dropdown.Item
                        key={workspace.id}
                        id={workspaceMenuKey(workspace.id)}
                        textValue={workspace.name}
                      >
                        <WorkspaceIcon
                          icon={workspace.icon}
                          className="size-4 shrink-0 text-muted"
                        />
                        <Label>{workspace.name}</Label>
                        <Dropdown.ItemIndicator />
                      </Dropdown.Item>
                    ))}
                  </Dropdown.Menu>
                </Dropdown.Popover>
              </Dropdown.SubmenuTrigger>
            ) : null}
            <Dropdown.Item id="usage" textValue={t`Usage`} shouldCloseOnSelect>
              <Gauge
                className={`size-4 shrink-0 ${usagePanelOpen ? "text-accent-text" : "text-muted"}`}
              />
              <Label>{t`Usage`}</Label>
            </Dropdown.Item>
          </Dropdown.Section>

          {sidebarShortcuts.map((shortcut) => (
            <Dropdown.Item
              key={shortcut.id}
              id={shortcut.id}
              textValue={shortcut.label}
              shouldCloseOnSelect
            >
              <span
                className={`flex size-4 shrink-0 items-center justify-center ${shortcut.isActive ? "text-accent-text" : "text-muted"}`}
              >
                {shortcut.icon}
              </span>
              <Label>{shortcut.label}</Label>
              <Dropdown.ItemIndicator />
            </Dropdown.Item>
          ))}

          <Separator />
          <Dropdown.Section selectionMode="none">
            <Dropdown.Item id="whatsNew" textValue={t`What's New`} shouldCloseOnSelect>
              <span className="relative flex size-4 shrink-0 items-center justify-center text-muted">
                <Megaphone className="size-4" />
                {hasUnseenChangelog ? (
                  <span
                    aria-hidden="true"
                    className="absolute -right-1 -top-1 size-1.5 rounded-full bg-accent"
                  />
                ) : null}
              </span>
              <Label className={whatsNewOpen ? "text-accent-text" : undefined}>
                {t`What's New`}
              </Label>
            </Dropdown.Item>
            {updatePhase === "downloading" ? (
              <Dropdown.Item id="downloadingUpdate" textValue={t`Downloading update`} isDisabled>
                <Download className="size-4 shrink-0 animate-pulse text-muted" />
                <Label>{t`Downloading update`}</Label>
                <span className="ml-auto text-xs tabular-nums text-muted">
                  {Math.min(100, Math.max(0, Math.round(downloadPercent)))}%
                </span>
              </Dropdown.Item>
            ) : updatePhase === "downloaded" ? (
              <Dropdown.Item
                id="installUpdate"
                textValue={updateVersion ? t`Install v${updateVersion}` : t`Install update`}
                shouldCloseOnSelect
              >
                <RefreshCw className="size-4 shrink-0 text-accent-text" />
                <Label>{updateVersion ? t`Install v${updateVersion}` : t`Install update`}</Label>
              </Dropdown.Item>
            ) : null}
          </Dropdown.Section>

          <Separator />
          <Dropdown.Item id="remoteAccess" textValue={t`Remote Access`} shouldCloseOnSelect>
            <span
              className={`flex size-4 shrink-0 items-center justify-center ${remoteAccessSettingsActive ? "text-accent-text" : "text-muted"}`}
            >
              <RemoteAccessSidebarIcon status={remoteAccessStatus} />
            </span>
            <Label>{t`Remote Access`}</Label>
            <span className="ml-auto text-xs text-muted">{statusLabel}</span>
            <Dropdown.ItemIndicator />
          </Dropdown.Item>
          <Dropdown.Item id="settings" textValue={t`Settings`} shouldCloseOnSelect>
            <Settings2
              className={`size-4 shrink-0 ${otherSettingsActive ? "text-accent-text" : "text-muted"}`}
            />
            <Label>{t`Settings`}</Label>
            <Dropdown.ItemIndicator />
          </Dropdown.Item>
          {props.sidebarVisibility && props.onSidebarVisibility ? (
            <>
              <Separator />
              <Dropdown.Section selectionMode="none">
                <Dropdown.Item
                  id="sidebarVisibility"
                  textValue={props.sidebarVisibility === "hide" ? t`Hide sidebar` : t`Show sidebar`}
                  shouldCloseOnSelect
                >
                  {props.sidebarVisibility === "hide" ? (
                    <PanelLeftClose className="size-4 shrink-0 text-muted" />
                  ) : (
                    <PanelLeft className="size-4 shrink-0 text-muted" />
                  )}
                  <Label>
                    {props.sidebarVisibility === "hide" ? t`Hide sidebar` : t`Show sidebar`}
                  </Label>
                </Dropdown.Item>
              </Dropdown.Section>
            </>
          ) : null}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

/** The expanded footer is deliberately one control: every action lives in More. */
export function SidebarFooterNav(props: { remoteAccessStatus: RemoteAccessSidebarStatus }) {
  const { collapse } = useSidebar();

  return (
    <div className={sidebarFooterNavClass}>
      <SidebarFooterMenu
        remoteAccessStatus={props.remoteAccessStatus}
        sidebarVisibility="hide"
        onSidebarVisibility={collapse}
      />
    </div>
  );
}
