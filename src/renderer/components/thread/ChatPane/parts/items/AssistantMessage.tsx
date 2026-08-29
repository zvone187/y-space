import { memo, useMemo } from "react";
import { Surface } from "@heroui/react";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { BadgeCheck, CircleAlert } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import type { MessageItemPayload } from "@/shared/contracts";
import { PixelLoader } from "@/renderer/components/common/PixelLoader";
import { useAppStore } from "@/renderer/state/appStore";
import {
  getRuntimeItemPayload,
  type RuntimeChatItem,
} from "@/renderer/state/slices/runtimeEventSlice";
import { chatMessageSurfaceClass } from "./chatMessageSurface";
import { useChatPaneActions } from "../../chatPaneActionsContext";
import { CopyTextButton } from "./CopyTextButton";
import { ImageCard } from "./ImageCard";
import { imageViewSourceFromImageBlock } from "./imageViewSource";
import { SmoothItemMarkdown } from "./ItemMarkdown";
import {
  isAppOwnedBrowserEvidenceItem,
  resolveBrowserVerificationBadge,
  type BrowserVerificationBadgeState,
} from "./browserVerification";

interface AssistantMessageProps {
  threadId: string;
  item: RuntimeChatItem;
  isTurnActive: boolean;
}

export const AssistantMessage = memo(function AssistantMessage({
  threadId,
  item,
  isTurnActive,
}: AssistantMessageProps) {
  const { t } = useLingui();
  // The copy action only appears under a turn's *final* answer: the message
  // must be the last top-level item of its turn — any trailing item (another
  // message, a tool call, an error from a failed turn) means the text was an
  // intermediate status note, not the answer. Every turn keeps its button, not
  // just the most recent one. Sub-agent messages (those nested under a tool
  // call) are ignored so they neither qualify nor cancel a top-level answer's
  // terminal status. A completed item at the live tail is still an
  // intermediate update until the turn itself settles, so it must not expose
  // a copy action yet.
  const finalAnswerStatus = useFinalAnswerStatus(
    threadId,
    item.id,
    item.parentItemId !== undefined,
    isTurnActive,
  );
  const rawText = getAssistantMessageText(item);
  const isStreaming = item.state !== "completed";
  const showCopyButton = finalAnswerStatus === "confirmed" && !isStreaming && rawText.length > 0;
  const browserVerification = useBrowserVerificationBadge(
    threadId,
    [item.id],
    rawText,
    finalAnswerStatus === "confirmed" && !isStreaming,
  );
  // The tail answer's copy action becomes available only once its turn
  // settles. Reserve the same strip while the answer is still a candidate so
  // revealing the button cannot grow the virtual row and move the transcript
  // past the pinned bottom edge.
  const reserveCopyButtonSpace = finalAnswerStatus !== "none" && rawText.length > 0;
  return (
    <Surface variant="transparent" className={chatMessageSurfaceClass}>
      <div className="min-w-0 leading-snug">
        <AssistantMessageContent item={item} />
      </div>
      <BrowserVerificationBadge state={browserVerification} />
      {reserveCopyButtonSpace ? (
        <div className="poracode-message-action-strip mt-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/checkpoint:opacity-100 focus-within:opacity-100">
          {showCopyButton ? (
            <CopyTextButton text={rawText} label={t`Copy message`} />
          ) : (
            <span aria-hidden="true" className="block size-5" />
          )}
        </div>
      ) : null}
    </Surface>
  );
});

interface AssistantMessageGroupProps {
  threadId: string;
  itemIds: readonly string[];
  isTurnActive: boolean;
}

/** One response surface for consecutive assistant parts at a turn's visible tail. */
export function AssistantMessageGroup({
  threadId,
  itemIds,
  isTurnActive,
}: AssistantMessageGroupProps) {
  const { t } = useLingui();
  const items = useAppStore(
    useShallow((state) =>
      itemIds
        .map((itemId) => state.runtimeItemsByIdByThread[threadId]?.[itemId])
        .filter(
          (item): item is RuntimeChatItem =>
            item !== undefined && item.type === "assistant_message",
        ),
    ),
  );
  const anchor = items.at(-1);
  const finalAnswerStatus = useFinalAnswerStatus(
    threadId,
    anchor?.id ?? null,
    anchor?.parentItemId !== undefined,
    isTurnActive,
  );
  const copyText = items
    .map(getAssistantMessageText)
    .filter((text) => text.length > 0)
    .join("\n\n");
  const isStreaming = items.some((entry) => entry.state !== "completed");
  const showCopyButton = finalAnswerStatus === "confirmed" && !isStreaming && copyText.length > 0;
  const browserVerification = useBrowserVerificationBadge(
    threadId,
    itemIds,
    copyText,
    finalAnswerStatus === "confirmed" && !isStreaming,
  );
  const reserveCopyButtonSpace = finalAnswerStatus !== "none" && copyText.length > 0;

  if (items.length === 0) return null;
  return (
    <Surface
      variant="transparent"
      className={chatMessageSurfaceClass}
      data-assistant-message-group="true"
    >
      <div className="min-w-0 leading-snug">
        {items.map((entry) => (
          <div key={entry.id} data-item-id={entry.id}>
            <AssistantMessageContent item={entry} />
          </div>
        ))}
      </div>
      <BrowserVerificationBadge state={browserVerification} />
      {reserveCopyButtonSpace ? (
        <div className="poracode-message-action-strip mt-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/checkpoint:opacity-100 focus-within:opacity-100">
          {showCopyButton ? (
            <CopyTextButton text={copyText} label={t`Copy message`} />
          ) : (
            <span aria-hidden="true" className="block size-5" />
          )}
        </div>
      ) : null}
    </Surface>
  );
}

function useBrowserVerificationBadge(
  threadId: string,
  finalItemIds: readonly string[],
  finalText: string,
  isConfirmedFinal: boolean,
): BrowserVerificationBadgeState {
  return useAppStore(
    useShallow((state) => {
      if (!isConfirmedFinal) return null;
      return resolveBrowserVerificationBadge(
        state.runtimeItemsByIdByThread[threadId],
        state.runtimeItemIdsByThread[threadId],
        finalItemIds,
        finalText,
      );
    }),
  );
}

function BrowserVerificationBadge({ state }: { state: BrowserVerificationBadgeState }) {
  if (!state) return null;
  if (state.kind === "verified") {
    return (
      <div
        data-browser-verification="verified"
        className="mt-2 inline-flex w-fit items-center gap-1 rounded-full border border-accent/20 bg-accent/5 px-2 py-0.5 text-[11px] leading-4 text-accent-text"
      >
        <BadgeCheck className="size-3" aria-hidden="true" />
        <Plural
          value={state.actionCount}
          one="Browser verified · # action"
          other="Browser verified · # actions"
        />
      </div>
    );
  }
  return (
    <div
      data-browser-verification="unverified"
      className="mt-2 inline-flex w-fit items-center gap-1 rounded-full border border-border/70 bg-foreground/[0.025] px-2 py-0.5 text-[11px] leading-4 text-muted"
    >
      <CircleAlert className="size-3" aria-hidden="true" />
      <Trans>Browser not verified</Trans>
    </div>
  );
}

function AssistantMessageContent({ item }: { item: RuntimeChatItem }) {
  const actions = useChatPaneActions();
  const payload = getRuntimeItemPayload<MessageItemPayload>(item, "assistant_message");
  const rawText = getAssistantMessageText(item);
  const isStreaming = item.state !== "completed";
  // Agents (e.g. ACP providers) can embed images directly in a message as image
  // content blocks; render them inline beneath any text.
  const imageSources = useMemo(
    () =>
      (payload?.content ?? [])
        .filter((block) => block.kind === "image")
        .map((block) => imageViewSourceFromImageBlock(block, actions?.remoteImageRefUrl))
        .filter((source): source is NonNullable<typeof source> => source !== null),
    [actions?.remoteImageRefUrl, payload?.content],
  );

  return (
    <>
      {rawText.length > 0 ? <SmoothItemMarkdown text={rawText} isStreaming={isStreaming} /> : null}
      {imageSources.length > 0 ? (
        <div className="mt-1 flex flex-col gap-2">
          {imageSources.map((source, index) => (
            <ImageCard key={`${source.src.slice(0, 64)}:${index}`} source={source} />
          ))}
        </div>
      ) : null}
      {isStreaming && rawText.length === 0 && imageSources.length === 0 ? (
        <div className="text-foreground-muted">
          <PixelLoader size="xxs" />
        </div>
      ) : null}
    </>
  );
}

function getAssistantMessageText(item: RuntimeChatItem): string {
  const stream = item.streams.assistant_text ?? "";
  if (stream.length > 0) return stream;
  const payload = getRuntimeItemPayload<MessageItemPayload>(item, "assistant_message");
  return (
    payload?.content
      ?.map((block) => (block.kind === "text" ? block.text : ""))
      .filter(Boolean)
      .join("\n") ?? ""
  );
}

function useFinalAnswerStatus(
  threadId: string,
  itemId: string | null,
  isNested: boolean,
  isTurnActive: boolean,
): "confirmed" | "candidate" | "none" {
  return useAppStore((state): "confirmed" | "candidate" | "none" => {
    if (!itemId || isNested) return "none";
    const ids = state.runtimeItemIdsByThread[threadId];
    const byId = state.runtimeItemsByIdByThread[threadId];
    if (!ids || !byId) return "none";
    const index = ids.indexOf(itemId);
    if (index < 0) return "none";
    for (let i = index + 1; i < ids.length; i += 1) {
      const next = byId[ids[i]!];
      if (!next || next.parentItemId) continue;
      if (isAppOwnedBrowserEvidenceItem(next)) continue;
      return next.type === "user_message" ? "confirmed" : "none";
    }
    return isTurnActive ? "candidate" : "confirmed";
  });
}
