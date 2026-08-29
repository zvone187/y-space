/**
 * Assistant / reasoning text-item lifecycle helpers for the OpenCode mapper.
 *
 * Tracks per-part emitted text so interleaved incremental deltas and full
 * snapshot updates don't double-emit, and closes any open content items at
 * turn boundaries.
 */

import type { RuntimeEvent } from "@/shared/contracts";
import { newItemId } from "../../contextUsage";
import type { OpenCodeMapperState } from "../sdkCanonicalMappingState";
import { suffixPrefixOverlap } from "./readers";

export function ensureAssistantItemForPart(
  state: OpenCodeMapperState,
  partID: string,
  messageID: string,
  events: RuntimeEvent[],
): string {
  const messageItems = state.assistantItems.get(messageID);
  const existing = messageItems?.get(partID);
  if (existing) return existing;
  const itemId = newItemId("asst");
  if (messageItems) {
    messageItems.set(partID, itemId);
  } else {
    state.assistantItems.set(messageID, new Map([[partID, itemId]]));
  }
  events.push({
    type: "item.started",
    threadId: state.threadId,
    itemId,
    itemType: "assistant_message",
  });
  return itemId;
}

export function completeAssistantItem(
  state: OpenCodeMapperState,
  messageID: string,
  partID: string,
  events: RuntimeEvent[],
): void {
  const messageItems = state.assistantItems.get(messageID);
  const itemId = messageItems?.get(partID);
  if (!messageItems || !itemId) return;
  events.push({ type: "item.completed", threadId: state.threadId, itemId });
  messageItems.delete(partID);
  if (messageItems.size === 0) state.assistantItems.delete(messageID);
}

export function completeAssistantItemsForMessage(
  state: OpenCodeMapperState,
  messageID: string,
  events: RuntimeEvent[],
): void {
  const messageItems = state.assistantItems.get(messageID);
  if (!messageItems) return;
  for (const [partID, itemId] of messageItems) {
    events.push({ type: "item.completed", threadId: state.threadId, itemId });
    state.emittedText.delete(partID);
    state.partTypes.delete(partID);
  }
  state.assistantItems.delete(messageID);
}

export function ensureReasoningItemForPart(
  state: OpenCodeMapperState,
  partID: string,
  messageID: string,
  events: RuntimeEvent[],
): string {
  const existing = state.reasoningItems.get(partID);
  if (existing) return existing.itemId;
  const itemId = newItemId("reason");
  state.reasoningItems.set(partID, { itemId, messageID });
  events.push({
    type: "item.started",
    threadId: state.threadId,
    itemId,
    itemType: "reasoning",
  });
  return itemId;
}

export function completeReasoningItem(
  state: OpenCodeMapperState,
  partID: string,
  events: RuntimeEvent[],
): void {
  const entry = state.reasoningItems.get(partID);
  if (!entry) return;
  events.push({ type: "item.completed", threadId: state.threadId, itemId: entry.itemId });
  state.reasoningItems.delete(partID);
}

export function emitTextDelta(
  state: OpenCodeMapperState,
  partID: string,
  itemId: string,
  full: string,
  stream: "assistant_text" | "reasoning_text",
  events: RuntimeEvent[],
): void {
  const emitted = state.emittedText.get(partID) ?? "";
  if (emitted === full) return;
  if (full.startsWith(emitted)) {
    const tail = full.slice(emitted.length);
    if (tail.length === 0) return;
    state.emittedText.set(partID, full);
    events.push({
      type: "content.delta",
      threadId: state.threadId,
      itemId,
      stream,
      delta: tail,
    });
    return;
  }
  // Snapshot diverged — use overlap to find the new tail.
  const overlap = suffixPrefixOverlap(emitted, full);
  const tail = full.slice(overlap);
  state.emittedText.set(partID, emitted + tail);
  if (tail.length > 0) {
    events.push({
      type: "content.delta",
      threadId: state.threadId,
      itemId,
      stream,
      delta: tail,
    });
  }
}

export function appendDelta(
  state: OpenCodeMapperState,
  partID: string,
  itemId: string,
  delta: string,
  stream: "assistant_text" | "reasoning_text",
  events: RuntimeEvent[],
): void {
  if (delta.length === 0) return;
  const emitted = state.emittedText.get(partID) ?? "";
  state.emittedText.set(partID, emitted + delta);
  events.push({
    type: "content.delta",
    threadId: state.threadId,
    itemId,
    stream,
    delta,
  });
}

/** Close any open content items at turn boundaries. */
export function closeOpenItems(state: OpenCodeMapperState): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  for (const [, messageItems] of state.assistantItems) {
    for (const [, itemId] of messageItems) {
      events.push({ type: "item.completed", threadId: state.threadId, itemId });
    }
  }
  state.assistantItems.clear();
  for (const [, entry] of state.reasoningItems) {
    events.push({ type: "item.completed", threadId: state.threadId, itemId: entry.itemId });
  }
  state.reasoningItems.clear();
  for (const [, value] of state.toolItems) {
    if (value.completed) continue;
    events.push({ type: "item.completed", threadId: state.threadId, itemId: value.itemId });
  }
  state.toolItems.clear();
  for (const [, itemId] of state.userItems) {
    events.push({ type: "item.completed", threadId: state.threadId, itemId });
  }
  state.userItems.clear();
  state.nonOptimisticUserMessages.clear();
  state.userMessageTextParts.clear();
  state.partTypes.clear();
  state.emittedText.clear();
  state.messageRoles.clear();
  state.pendingUserMessageItemIds.length = 0;
  return events;
}
