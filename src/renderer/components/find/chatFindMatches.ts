import type { RuntimeChatItem } from "@/renderer/state/slices/runtimeEventSlice";
import type { ChatDisplayTimelineEntry } from "@/renderer/components/thread/ChatPane/chatPaneSelectors";
import { countOccurrences } from "./findText";

/** One match within the chat transcript: which timeline row, and which
 * occurrence inside that row's text (so the active-match highlight can target
 * the Nth hit within the rendered row). */
export interface ChatFindMatch {
  itemId: string;
  /** Index of the entry in the timeline (for `virtualizer.scrollToIndex`). */
  itemIndex: number;
  /** Zero-based occurrence within the item's searchable text. */
  occurrence: number;
}

function blocksToText(payload: unknown): string {
  const blocks = Array.isArray(payload)
    ? payload
    : payload &&
        typeof payload === "object" &&
        Array.isArray((payload as { content?: unknown }).content)
      ? (payload as { content: unknown[] }).content
      : null;
  if (!blocks) return "";
  let out = "";
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const record = block as {
      kind?: unknown;
      text?: unknown;
      path?: unknown;
      source?: unknown;
      name?: unknown;
    };
    if (record.kind === "text" && typeof record.text === "string") {
      out += record.text;
    } else if (
      record.kind === "file" &&
      typeof record.path === "string" &&
      record.source !== "attachment"
    ) {
      out += record.path;
    } else if (record.kind === "mcp" && typeof record.name === "string") {
      // Keep the badge's `@Name` directive findable in the transcript.
      out += `@${record.name}`;
    }
  }
  return out;
}

/**
 * Searchable text for a chat item. Mirrors what the conversation surfaces show:
 * user prompts, assistant replies, and reasoning. Tool output / diffs are not
 * searched here (they live in collapsed groups and have their own surfaces).
 */
export function getChatItemSearchText(item: RuntimeChatItem): string {
  switch (item.type) {
    case "assistant_message":
      return item.streams.assistant_text ?? blocksToText(item.payload);
    case "reasoning":
      return item.streams.reasoning_text ?? "";
    case "user_message":
      return blocksToText(item.payload);
    default:
      return "";
  }
}

/**
 * Flatten the displayed thread timeline into an ordered match list. Activity
 * groups keep their outer virtual-row index while matches retain the nested item
 * id, allowing Find to open the disclosure and highlight the exact message.
 * Tool output itself remains outside the searchable conversation scope.
 */
export function collectChatMatches(
  itemsById: Record<string, RuntimeChatItem> | undefined,
  entries: readonly ChatDisplayTimelineEntry[],
  query: string,
  caseSensitive: boolean,
): ChatFindMatch[] {
  if (!query || !itemsById) return [];
  const matches: ChatFindMatch[] = [];
  entries.forEach((entry, itemIndex) => {
    if (entry.kind === "turn_activity_group") {
      for (const activityEntry of entry.entries) {
        collectEntryMatches(itemsById, activityEntry, itemIndex, query, caseSensitive, matches);
      }
      return;
    }
    collectEntryMatches(itemsById, entry, itemIndex, query, caseSensitive, matches);
  });
  return matches;
}

function collectEntryMatches(
  itemsById: Record<string, RuntimeChatItem>,
  entry: Exclude<ChatDisplayTimelineEntry, { kind: "turn_activity_group" }>,
  itemIndex: number,
  query: string,
  caseSensitive: boolean,
  matches: ChatFindMatch[],
): void {
  const itemIds = entry.kind === "item" ? [entry.id] : entry.itemIds;
  for (const itemId of itemIds) {
    const item = itemsById[itemId];
    if (!item) continue;
    const text = getChatItemSearchText(item);
    if (!text) continue;
    const count = countOccurrences(text, query, caseSensitive);
    for (let occurrence = 0; occurrence < count; occurrence += 1) {
      matches.push({ itemId, itemIndex, occurrence });
    }
  }
}
