import { Button, Dropdown, Label, Separator } from "@heroui/react";
import { Globe2, Plus, ShieldCheck } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { useState } from "react";
import type { RightPanelTab } from "@/renderer/state/panelStore";
import { useSensitiveNativeViewOverlayGate } from "@/renderer/state/sensitiveNativeViewObstruction";
import type { RightWorkspaceToolMenuItem } from "./RightWorkspaceActionsMenu";

export function RightWorkspaceAddMenu(props: {
  tools: readonly RightWorkspaceToolMenuItem[];
  activeTool: RightPanelTab | null;
  onToolChange: (tab: RightPanelTab) => void;
  onCreateBrowserTab: () => void;
  onImportCookies: () => void;
}) {
  const { t } = useLingui();
  const [menuRequested, setMenuRequested] = useState(false);
  const menuReady = useSensitiveNativeViewOverlayGate(menuRequested);
  const visibleTools = props.tools.filter((tool) => tool.visible && tool.id !== "browser");
  const label = t`Add tab`;

  const handleAction = (key: string) => {
    if (key === "browser:new") {
      props.onCreateBrowserTab();
      return;
    }
    if (key === "browser:import-cookies") {
      props.onImportCookies();
      return;
    }
    if (!key.startsWith("tool:")) return;
    const tool = visibleTools.find((candidate) => `tool:${candidate.id}` === key);
    if (!tool) return;
    if (tool.onOpen) tool.onOpen();
    else props.onToolChange(tool.id);
  };

  return (
    <Dropdown isOpen={menuRequested && menuReady} onOpenChange={setMenuRequested}>
      <Button
        isIconOnly
        aria-label={label}
        size="sm"
        variant="ghost"
        className="poracode-overlay-header__controls size-7 min-w-0 rounded-lg text-muted hover:bg-foreground/8 hover:text-foreground"
      >
        <Plus className="size-4" aria-hidden="true" />
      </Button>
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu
          aria-label={label}
          className="poracode-menu min-w-52"
          onAction={(key) => handleAction(String(key))}
        >
          <Dropdown.Item id="browser:new" textValue={t`New browser tab`}>
            <Globe2 className="size-4 shrink-0 text-accent-text" aria-hidden="true" />
            <Label>{t`New browser tab`}</Label>
          </Dropdown.Item>
          {visibleTools.map((tool) => {
            const Icon = tool.icon;
            return (
              <Dropdown.Item key={tool.id} id={`tool:${tool.id}`} textValue={tool.label}>
                <Icon
                  className={`size-4 shrink-0 ${props.activeTool === tool.id ? "text-accent-text" : "text-muted"}`}
                  aria-hidden="true"
                />
                <Label>{tool.label}</Label>
              </Dropdown.Item>
            );
          })}
          <Separator />
          <Dropdown.Item id="browser:import-cookies" textValue={t`Import browser cookies`}>
            <ShieldCheck className="size-4 shrink-0 text-muted" aria-hidden="true" />
            <Label>{t`Import browser cookies`}</Label>
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
