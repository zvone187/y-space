import { Button, Dropdown, Label, Separator } from "@heroui/react";
import {
  Ellipsis,
  GripVertical,
  Lock,
  LockOpen,
  Maximize2,
  PanelRightClose,
  type LucideIcon,
} from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { PanelTabDragButton } from "@/renderer/components/layout/PanelDock/PanelTabDragButton";
import { DOCKABLE_PANEL_TABS, type RightPanelTab } from "@/renderer/state/panelStore";
import { useSensitiveNativeViewOverlayGate } from "@/renderer/state/sensitiveNativeViewObstruction";

export interface RightWorkspaceToolMenuItem {
  id: RightPanelTab;
  label: string;
  icon: LucideIcon;
  visible: boolean;
  onOpen?: (() => void) | undefined;
}

/**
 * Compact pointer drag source for tools that can still move into a split or
 * bottom dock. Keeping the handle inside the menu preserves that advanced
 * layout path without restoring the old always-visible developer toolbar.
 */
function ToolDragHandle(props: { tool: RightWorkspaceToolMenuItem }) {
  const { t } = useLingui();

  return (
    <PanelTabDragButton
      tab={props.tool.id}
      label={t`Move panel`}
      variant="handle"
      className="ml-auto flex size-5 shrink-0 cursor-grab items-center justify-center rounded text-muted opacity-55 transition-opacity hover:opacity-100 active:cursor-grabbing"
    >
      <GripVertical className="size-3" />
    </PanelTabDragButton>
  );
}

export function RightWorkspaceActionsMenu(props: {
  tools: readonly RightWorkspaceToolMenuItem[];
  activeTool: RightPanelTab | null;
  splitTool?: RightPanelTab;
  dockedTools?: readonly RightPanelTab[];
  onToolChange: (tab: RightPanelTab) => void;
  onMaximize?: () => void;
  followsThread?: boolean;
  onToggleFollowsThread?: () => void;
  onHide: () => void;
}) {
  const { t } = useLingui();
  const [menuRequested, setMenuRequested] = useState(false);
  const menuReady = useSensitiveNativeViewOverlayGate(menuRequested);
  const visibleTools = props.tools.filter((tool) => tool.visible);
  const visibleToolIds = new Set(visibleTools.map((tool) => tool.id));
  const selectedTools = new Set([
    ...(props.activeTool ? [props.activeTool] : []),
    ...(props.splitTool ? [props.splitTool] : []),
    ...(props.dockedTools ?? []),
  ]);
  const selectedKeys = [...selectedTools]
    .filter((tool) => visibleToolIds.has(tool))
    .map((tool) => `tool:${tool}`);
  const label = t`Right panel`;

  const handleAction = (key: string) => {
    if (key.startsWith("tool:")) {
      const tool = visibleTools.find((candidate) => `tool:${candidate.id}` === key);
      if (!tool) return;
      if (tool.onOpen) tool.onOpen();
      else props.onToolChange(tool.id);
      return;
    }

    switch (key) {
      case "panel:maximize":
        props.onMaximize?.();
        return;
      case "panel:scope":
        props.onToggleFollowsThread?.();
        return;
      case "panel:hide":
        props.onHide();
    }
  };

  return (
    <Dropdown isOpen={menuRequested && menuReady} onOpenChange={(open) => setMenuRequested(open)}>
      <Button
        isIconOnly
        aria-label={label}
        size="sm"
        variant="ghost"
        className="poracode-overlay-header__controls size-6 min-w-0 text-muted hover:text-foreground"
      >
        <Ellipsis className="size-3.5" aria-hidden="true" />
      </Button>
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu
          aria-label={label}
          className="poracode-menu min-w-48"
          selectionMode="multiple"
          selectedKeys={selectedKeys}
          onAction={(key) => handleAction(String(key))}
        >
          {visibleTools.map((tool) => {
            const Icon = tool.icon;
            const active = selectedTools.has(tool.id);
            return (
              <Dropdown.Item
                key={tool.id}
                id={`tool:${tool.id}`}
                textValue={tool.label}
                shouldCloseOnSelect
              >
                <Icon
                  className={`size-4 shrink-0 ${active ? "text-accent-text" : "text-muted"}`}
                  aria-hidden="true"
                />
                <Label>{tool.label}</Label>
                {DOCKABLE_PANEL_TABS.has(tool.id) ? <ToolDragHandle tool={tool} /> : null}
                <Dropdown.ItemIndicator />
              </Dropdown.Item>
            );
          })}
          {visibleTools.length > 0 ? <Separator /> : null}
          <Dropdown.Section selectionMode="none">
            {props.onMaximize ? (
              <Dropdown.Item id="panel:maximize" textValue={t`Maximize`}>
                <Maximize2 className="size-4 shrink-0 text-muted" aria-hidden="true" />
                <Label>{t`Maximize`}</Label>
              </Dropdown.Item>
            ) : null}
            {props.onToggleFollowsThread ? (
              <Dropdown.Item
                id="panel:scope"
                textValue={
                  props.followsThread
                    ? t`Unlock panel from the open thread`
                    : t`Lock panel to the open thread`
                }
              >
                {props.followsThread ? (
                  <Lock className="size-4 shrink-0 text-muted" aria-hidden="true" />
                ) : (
                  <LockOpen className="size-4 shrink-0 text-muted" aria-hidden="true" />
                )}
                <Label>
                  {props.followsThread
                    ? t`Unlock panel from the open thread`
                    : t`Lock panel to the open thread`}
                </Label>
              </Dropdown.Item>
            ) : null}
            <Dropdown.Item id="panel:hide" textValue={t`Hide panel`}>
              <PanelRightClose className="size-4 shrink-0 text-muted" aria-hidden="true" />
              <Label>{t`Hide panel`}</Label>
            </Dropdown.Item>
          </Dropdown.Section>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
