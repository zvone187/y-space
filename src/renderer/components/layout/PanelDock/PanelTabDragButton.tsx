import { type ReactNode, useId, useRef } from "react";
import { useDraggable } from "@dnd-kit/react";
import type { DragSourceData } from "@/renderer/dnd";
import type { RightPanelTab } from "@/renderer/state/panelStore";

/**
 * Shared right-panel drag source. The default button form activates its tool;
 * `variant="handle"` supplies a non-interactive grip inside another accessible
 * control such as the compact workspace menu.
 */
export function PanelTabDragButton(props: {
  tab: RightPanelTab;
  label: string;
  className: string;
  "aria-pressed"?: boolean;
  onPress?: () => void;
  variant?: "button" | "handle";
  children: ReactNode;
}) {
  const elementRef = useRef<HTMLDivElement>(null);
  const dragId = useId();
  useDraggable({
    id: `panel-tab:${props.tab}:${dragId}`,
    type: "panel-tab",
    data: { type: "panel-tab", tab: props.tab } satisfies DragSourceData,
    element: elementRef,
  });

  if (props.variant === "handle") {
    return (
      <div
        ref={elementRef}
        aria-hidden="true"
        data-panel-tool-drag-handle={props.tab}
        title={props.label}
        className={props.className}
      >
        {props.children}
      </div>
    );
  }

  return (
    <div
      ref={elementRef}
      role="button"
      tabIndex={0}
      aria-label={props.label}
      {...(props["aria-pressed"] === undefined ? {} : { "aria-pressed": props["aria-pressed"] })}
      title={props.label}
      className={props.className}
      onClick={(event) => {
        event.stopPropagation();
        props.onPress?.();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          props.onPress?.();
        }
      }}
    >
      {props.children}
    </div>
  );
}
