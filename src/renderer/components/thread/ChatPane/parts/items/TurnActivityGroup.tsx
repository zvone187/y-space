import { Disclosure } from "@heroui/react";
import { Plural, Trans } from "@lingui/react/macro";
import { Activity } from "lucide-react";
import { memo, useLayoutEffect, useRef, useState } from "react";
import { useChatPaneActions } from "../../chatPaneActionsContext";
import type { ChatTimelineEntry } from "../../chatPaneSelectors";
import {
  chatRowClass,
  chatRowHoverClass,
  chatRowIndicatorClass,
  chatRowRailClass,
  chatRowShellClass,
} from "./chatRow";
import { ChatItemRow } from "./ChatItemRow";

interface TurnActivityGroupProps {
  threadId: string;
  entries: readonly ChatTimelineEntry[];
  isLive?: boolean;
  /** Find opens the containing work disclosure long enough to reveal its row. */
  revealedItemId?: string | null;
  onHeightChange?: () => void;
  onVirtualizerLayoutChange?: () => void;
}

/** One compact disclosure for all non-final work emitted during an agent turn. */
export const TurnActivityGroup = memo(function TurnActivityGroup({
  threadId,
  entries,
  isLive = false,
  revealedItemId = null,
  onHeightChange,
  onVirtualizerLayoutChange,
}: TurnActivityGroupProps) {
  const actions = useChatPaneActions();
  const [manuallyExpanded, setManuallyExpanded] = useState(false);
  const previousLiveRef = useRef(isLive);
  const forceExpanded =
    revealedItemId !== null && entries.some((entry) => entryContainsItem(entry, revealedItemId));
  const isExpanded = manuallyExpanded || forceExpanded;
  const activityCount = entries.reduce(
    (count, entry) => count + (entry.kind === "item" ? 1 : entry.itemIds.length),
    0,
  );
  const previousExpandedRef = useRef(isExpanded);

  // A user-opened live disclosure remains open as entries stream into it. Once
  // that same turn settles, return it to the compact transcript default.
  useLayoutEffect(() => {
    const wasLive = previousLiveRef.current;
    previousLiveRef.current = isLive;
    if (!wasLive || isLive || !manuallyExpanded) return;
    onVirtualizerLayoutChange?.();
    setManuallyExpanded(false);
  }, [isLive, manuallyExpanded, onVirtualizerLayoutChange]);

  useLayoutEffect(() => {
    if (previousExpandedRef.current === isExpanded) return;
    previousExpandedRef.current = isExpanded;
    if (onHeightChange) onHeightChange();
    else actions?.onContentHeightChange();
  }, [actions, isExpanded, onHeightChange]);

  return (
    <div className={chatRowShellClass}>
      <Disclosure
        className="text-[length:var(--lc-chat-font-size-command)] leading-tight"
        isExpanded={isExpanded}
        onExpandedChange={(next) => {
          onVirtualizerLayoutChange?.();
          setManuallyExpanded(next);
        }}
      >
        <Disclosure.Heading>
          <Disclosure.Trigger className={`group ${chatRowClass} gap-2 ${chatRowHoverClass}`}>
            <span className="flex min-w-0 items-center gap-1.5 text-[color:var(--muted)]">
              <Activity className="size-3" />
              <span>
                {isLive ? (
                  <Trans>Working…</Trans>
                ) : (
                  <Plural value={activityCount} one="Worked · # step" other="Worked · # steps" />
                )}
              </span>
            </span>
            <Disclosure.Indicator className={chatRowIndicatorClass} />
          </Disclosure.Trigger>
        </Disclosure.Heading>
        <Disclosure.Content>
          <Disclosure.Body className={`ml-1.5 ${chatRowRailClass} pb-0 pl-2.5 pt-0`}>
            {isExpanded ? (
              <div className="flex flex-col gap-0.5">
                {entries.map((entry) => (
                  <div key={entry.id} data-item-id={entry.id}>
                    <ChatItemRow
                      threadId={threadId}
                      entry={entry}
                      isTurnActive={isLive}
                      revealedItemId={revealedItemId}
                      checkpointRevert={null}
                    />
                  </div>
                ))}
              </div>
            ) : null}
          </Disclosure.Body>
        </Disclosure.Content>
      </Disclosure>
    </div>
  );
});

function entryContainsItem(entry: ChatTimelineEntry, itemId: string): boolean {
  return entry.kind === "item" ? entry.id === itemId : entry.itemIds.includes(itemId);
}
