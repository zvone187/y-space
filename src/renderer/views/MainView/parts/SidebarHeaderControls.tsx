import { Ellipsis, FolderPlus, Globe, Search } from "lucide-react";
import { Button, Dropdown, Label, Separator, Tooltip } from "@heroui/react";
import { Trans, useLingui } from "@lingui/react/macro";
import { useIsPanelTabVisible } from "@/renderer/state/panelDockSelectors";
import { usePanelStore } from "@/renderer/state/panelStore";
import { toggleBrowserPanel } from "@/renderer/actions/panelActions";
import {
  type ThreadSortMode,
  listLayoutIcon,
  listLayoutLabel,
  listLayoutOrder,
  sortModeOrder,
  sortModeIcon,
  sortModeLabel,
} from "@/renderer/views/MainView/parts/Sidebar/parts/sortMode";
import { CreateProjectMenu } from "@/renderer/views/MainView/parts/CreateProject/CreateProjectMenu";

export function SidebarHeaderControls() {
  const { t } = useLingui();
  const threadSortMode = usePanelStore((s) => s.threadSortMode);
  const threadListLayout = usePanelStore((s) => s.threadListLayout);
  const browserPanelOpen = usePanelStore((s) => s.browserPanelOpen);
  const browserOnScreen = useIsPanelTabVisible("browser");
  const browserVisible = browserPanelOpen && browserOnScreen;

  return (
    <div className="poracode-overlay-header__controls flex items-center gap-1.5">
      <Tooltip delay={150}>
        <Tooltip.Trigger>
          <Button
            isIconOnly
            aria-label={t`Search`}
            size="sm"
            variant="ghost"
            className="size-6 min-w-0 text-muted hover:text-foreground"
            onPress={() => usePanelStore.getState().openThreadSearch()}
          >
            <Search className="size-3.5" />
          </Button>
        </Tooltip.Trigger>
        <Tooltip.Content placement="bottom">
          <Trans>Search</Trans>
        </Tooltip.Content>
      </Tooltip>
      <CreateProjectMenu>
        <Button
          isIconOnly
          aria-label={t`Add project`}
          size="sm"
          variant="ghost"
          className="size-6 min-w-0 text-muted hover:text-foreground"
        >
          <FolderPlus className="size-3.5" />
        </Button>
      </CreateProjectMenu>
      <Dropdown>
        <Button
          isIconOnly
          aria-label={t`More`}
          size="sm"
          variant="ghost"
          className="size-6 min-w-0 text-muted hover:text-foreground"
        >
          <Ellipsis className="size-3.5" />
        </Button>
        <Dropdown.Popover>
          <Dropdown.Menu
            aria-label={t`Thread list options`}
            selectionMode="multiple"
            selectedKeys={[
              ...(browserVisible ? ["browser"] : []),
              threadSortMode,
              threadListLayout,
            ]}
            onAction={(key) => {
              const state = usePanelStore.getState();
              if (key === "browser") toggleBrowserPanel();
              else if (key === "grouped" || key === "flat") state.setThreadListLayout(key);
              else state.setThreadSortMode(key as ThreadSortMode);
            }}
          >
            <Dropdown.Item id="browser" textValue={t`Browser`}>
              <Globe className="size-4 shrink-0 text-muted" />
              <Label>
                <Trans>Browser</Trans>
              </Label>
              <Dropdown.ItemIndicator />
            </Dropdown.Item>
            <Separator />
            {sortModeOrder.map((mode) => {
              const Icon = sortModeIcon[mode];
              const label = t(sortModeLabel[mode]);
              return (
                <Dropdown.Item key={mode} id={mode} textValue={label}>
                  <Icon className="size-4 shrink-0 text-muted" />
                  <Label>{label}</Label>
                  <Dropdown.ItemIndicator />
                </Dropdown.Item>
              );
            })}
            <Separator />
            {listLayoutOrder.map((layout) => {
              const Icon = listLayoutIcon[layout];
              const label = t(listLayoutLabel[layout]);
              return (
                <Dropdown.Item key={layout} id={layout} textValue={label}>
                  <Icon className="size-4 shrink-0 text-muted" />
                  <Label>{label}</Label>
                  <Dropdown.ItemIndicator />
                </Dropdown.Item>
              );
            })}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    </div>
  );
}
