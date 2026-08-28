import { type KeyboardEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import type { RightWorkspaceTab } from "@/renderer/state/rightWorkspaceTabs";

interface PendingFocus {
  closedTabId: string;
  adjacentTabId: string | null;
}

export interface RightWorkspaceTabStripProps {
  tabs: readonly RightWorkspaceTab[];
  activeTabId: string | null;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onReorder?: (tabId: string, toIndex: number) => void;
}

export function RightWorkspaceTabStrip({
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onReorder,
}: RightWorkspaceTabStripProps) {
  const tabElements = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<PendingFocus | null>(null);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const selectedTabId = useMemo(
    () => (tabs.some((tab) => tab.id === activeTabId) ? activeTabId : (tabs[0]?.id ?? null)),
    [activeTabId, tabs],
  );

  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (!pending || tabs.some((tab) => tab.id === pending.closedTabId)) return;

    const target =
      (pending.adjacentTabId ? tabElements.current.get(pending.adjacentTabId) : undefined) ??
      (selectedTabId ? tabElements.current.get(selectedTabId) : undefined);
    target?.focus();
    pendingFocus.current = null;
  }, [selectedTabId, tabs]);

  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, tabId: string) => {
    const currentIndex = tabs.findIndex((tab) => tab.id === tabId);
    if (currentIndex < 0 || tabs.length === 0) return;

    if (
      onReorder &&
      event.altKey &&
      event.shiftKey &&
      (event.key === "ArrowLeft" || event.key === "ArrowRight")
    ) {
      event.preventDefault();
      const toIndex = event.key === "ArrowLeft" ? currentIndex - 1 : currentIndex + 1;
      if (toIndex >= 0 && toIndex < tabs.length) onReorder(tabId, toIndex);
      return;
    }

    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

    let targetIndex: number;
    switch (event.key) {
      case "ArrowRight":
        targetIndex = (currentIndex + 1) % tabs.length;
        break;
      case "ArrowLeft":
        targetIndex = (currentIndex - 1 + tabs.length) % tabs.length;
        break;
      case "Home":
        targetIndex = 0;
        break;
      case "End":
        targetIndex = tabs.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    const target = tabs[targetIndex];
    if (!target) return;
    tabElements.current.get(target.id)?.focus();
    onActivate(target.id);
  };

  const closeTab = (tabId: string) => {
    const closedIndex = tabs.findIndex((tab) => tab.id === tabId);
    const adjacentTabId = tabs[closedIndex + 1]?.id ?? tabs[closedIndex - 1]?.id ?? null;
    pendingFocus.current = { closedTabId: tabId, adjacentTabId };
    onClose(tabId);
  };

  return (
    <div
      role="tablist"
      aria-label="Workspace tabs"
      aria-orientation="horizontal"
      className="flex h-9 min-w-0 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-border/60 bg-background/70 px-1 pt-1"
    >
      {tabs.map((tab) => {
        const selected = tab.id === selectedTabId;
        const tabIndex = tabs.findIndex((candidate) => candidate.id === tab.id);
        return (
          <div
            key={tab.id}
            draggable={Boolean(onReorder)}
            className={`group flex h-8 max-w-56 min-w-24 shrink-0 items-center rounded-t-md border border-b-0 px-1 transition-colors ${
              selected
                ? "border-border/80 bg-panel text-foreground"
                : "border-transparent bg-transparent text-muted hover:bg-foreground/[0.04] hover:text-foreground"
            } ${draggingTabId === tab.id ? "opacity-50" : ""}`}
            onDragStart={(event) => {
              if (!onReorder) return;
              setDraggingTabId(tab.id);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", tab.id);
            }}
            onDragEnd={() => setDraggingTabId(null)}
            onDragOver={(event) => {
              if (!onReorder || !draggingTabId || draggingTabId === tab.id) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
            }}
            onDrop={(event) => {
              if (!onReorder) return;
              event.preventDefault();
              const sourceTabId = event.dataTransfer.getData("text/plain") || draggingTabId;
              setDraggingTabId(null);
              if (!sourceTabId || sourceTabId === tab.id) return;

              const sourceIndex = tabs.findIndex((candidate) => candidate.id === sourceTabId);
              if (sourceIndex < 0) return;
              const bounds = event.currentTarget.getBoundingClientRect();
              const insertAfter = event.clientX > bounds.left + bounds.width / 2;
              const insertionIndex = tabIndex + (insertAfter ? 1 : 0);
              const toIndex = insertionIndex - (sourceIndex < insertionIndex ? 1 : 0);
              onReorder(sourceTabId, toIndex);
            }}
          >
            <button
              ref={(element) => {
                if (element) tabElements.current.set(tab.id, element);
                else tabElements.current.delete(tab.id);
              }}
              type="button"
              role="tab"
              aria-label={tab.title}
              aria-selected={selected}
              {...(onReorder
                ? { "aria-keyshortcuts": "Alt+Shift+ArrowLeft Alt+Shift+ArrowRight" }
                : {})}
              tabIndex={selected ? 0 : -1}
              title={tab.title}
              onClick={() => onActivate(tab.id)}
              onKeyDown={(event) => moveFocus(event, tab.id)}
              className={`min-w-0 flex-1 truncate px-2 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-focus/50 ${
                tab.kind === "file" && tab.preview ? "italic" : ""
              }`}
            >
              {tab.title}
            </button>
            {tab.closable ? (
              <button
                type="button"
                aria-label={`Close ${tab.title}`}
                title={`Close ${tab.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  closeTab(tab.id);
                }}
                className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted/70 outline-none hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus/50"
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
