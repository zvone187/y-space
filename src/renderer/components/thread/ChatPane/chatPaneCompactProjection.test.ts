import { describe, expect, it } from "vitest";
import type { AppStoreState } from "@/renderer/state/appStore";
import type { RuntimeChatItem } from "@/renderer/state/slices/runtimeEventSlice";
import { selectCompactThreadTimelineEntries } from "./chatPaneSelectors";

describe("selectCompactThreadTimelineEntries", () => {
  it("projects one completed agent turn as the prompt, one work disclosure, and the final answer", () => {
    const threadId = "completed-turn";
    const state = makeState(threadId, [
      makeItem("user-1", "user_message"),
      makeItem("reasoning-1", "reasoning", { reasoning_text: "Inspecting the code." }),
      makeItem("status-1", "assistant_message", {
        assistant_text: "I found the relevant path and am checking it now.",
      }),
      makeTool("tool-1", "Read src/app.ts"),
      makeItem("command-1", "command_execution", {}, { command: "pnpm test" }),
      makeItem("assistant-final", "assistant_message", {
        assistant_text: "Implemented and verified the change.",
      }),
    ]);

    expect(selectCompactThreadTimelineEntries(state, threadId, undefined, false)).toEqual([
      { kind: "item", id: "user-1" },
      {
        kind: "turn_activity_group",
        id: "turn-activity-group:reasoning-1",
        itemIds: ["reasoning-1", "status-1", "tool-1", "command-1"],
        entries: [
          { kind: "item", id: "reasoning-1" },
          { kind: "item", id: "status-1" },
          {
            kind: "tool_call_group",
            id: "tool-call-group:tool-1",
            itemIds: ["tool-1", "command-1"],
          },
        ],
        isCurrentTurn: false,
      },
      { kind: "item", id: "assistant-final" },
    ]);
  });

  it("keeps an active tail assistant visible, then folds it into the same work disclosure when a tool follows", () => {
    const threadId = "streaming-candidate";
    const initialItems = [
      makeItem("user-1", "user_message"),
      makeItem("reasoning-1", "reasoning", { reasoning_text: "Working through it." }),
      makeItem("assistant-candidate", "assistant_message", {
        assistant_text: "The likely cause is the cache key.",
      }),
    ];
    const initialState = makeState(threadId, initialItems, 1);

    expect(selectCompactThreadTimelineEntries(initialState, threadId, undefined, true)).toEqual([
      { kind: "item", id: "user-1" },
      {
        kind: "turn_activity_group",
        id: "turn-activity-group:reasoning-1",
        itemIds: ["reasoning-1"],
        entries: [{ kind: "item", id: "reasoning-1" }],
        isCurrentTurn: true,
      },
      { kind: "item", id: "assistant-candidate" },
    ]);

    const withLaterTool = makeState(
      threadId,
      [...initialItems, makeTool("tool-1", "Read src/cache.ts", "running")],
      2,
    );
    expect(selectCompactThreadTimelineEntries(withLaterTool, threadId, undefined, true)).toEqual([
      { kind: "item", id: "user-1" },
      {
        kind: "turn_activity_group",
        id: "turn-activity-group:reasoning-1",
        itemIds: ["reasoning-1", "assistant-candidate", "tool-1"],
        entries: [
          { kind: "item", id: "reasoning-1" },
          { kind: "item", id: "assistant-candidate" },
          { kind: "item", id: "tool-1" },
        ],
        isCurrentTurn: true,
      },
    ]);
  });

  it("coalesces consecutive trailing assistant parts into one final response row", () => {
    const threadId = "multipart-final-answer";
    const state = makeState(threadId, [
      makeItem("user-1", "user_message"),
      makeItem("assistant-progress", "assistant_message", {
        assistant_text: "I’ll inspect the browser connection first.",
      }),
      makeTool("tool-1", "Inspect browser connection"),
      makeItem("assistant-final-1", "assistant_message", {
        assistant_text: "The embedded browser is connected.",
      }),
      makeItem("assistant-final-2", "assistant_message", {
        assistant_text: "I also verified tab navigation.",
      }),
    ]);

    expect(selectCompactThreadTimelineEntries(state, threadId, undefined, false)).toEqual([
      { kind: "item", id: "user-1" },
      {
        kind: "turn_activity_group",
        id: "turn-activity-group:assistant-progress",
        itemIds: ["assistant-progress", "tool-1"],
        entries: [
          { kind: "item", id: "assistant-progress" },
          { kind: "item", id: "tool-1" },
        ],
        isCurrentTurn: false,
      },
      {
        kind: "assistant_message_group",
        id: "assistant-message-group:assistant-final-1",
        itemIds: ["assistant-final-1", "assistant-final-2"],
      },
    ]);
  });

  it("keeps the settled final visible when app-owned Browser evidence arrives after it", () => {
    const threadId = "late-browser-evidence-after-final";
    const state = makeState(threadId, [
      makeItem("user-1", "user_message"),
      makeItem("reasoning-1", "reasoning", { reasoning_text: "Checking the web page." }),
      makeItem("assistant-final", "assistant_message", {
        assistant_text: "The embedded browser flow works.",
      }),
      makeBrowserEvidence("browser-late-1", "snapshot"),
      makeBrowserEvidence("browser-late-2", "click"),
    ]);

    expect(selectCompactThreadTimelineEntries(state, threadId, undefined, false)).toEqual([
      { kind: "item", id: "user-1" },
      {
        kind: "turn_activity_group",
        id: "turn-activity-group:reasoning-1",
        itemIds: ["reasoning-1", "browser-late-1", "browser-late-2"],
        entries: [
          { kind: "item", id: "reasoning-1" },
          {
            kind: "tool_call_group",
            id: "tool-call-group:browser-late-1",
            itemIds: ["browser-late-1", "browser-late-2"],
          },
        ],
        isCurrentTurn: false,
      },
      { kind: "item", id: "assistant-final" },
    ]);
  });

  it("keeps the settled final visible when app-owned Browser failure evidence arrives after it", () => {
    const threadId = "late-browser-failure-after-final";
    const state = makeState(threadId, [
      makeItem("user-1", "user_message"),
      makeItem("reasoning-1", "reasoning", { reasoning_text: "Checking the web page." }),
      makeItem("assistant-final", "assistant_message", {
        assistant_text: "The embedded browser flow works.",
      }),
      makeBrowserEvidence("browser-late-failure", "snapshot", "error"),
    ]);

    expect(selectCompactThreadTimelineEntries(state, threadId, undefined, false)).toEqual([
      { kind: "item", id: "user-1" },
      {
        kind: "turn_activity_group",
        id: "turn-activity-group:reasoning-1",
        itemIds: ["reasoning-1", "browser-late-failure"],
        entries: [
          { kind: "item", id: "reasoning-1" },
          { kind: "item", id: "browser-late-failure" },
        ],
        isCurrentTurn: false,
      },
      { kind: "item", id: "assistant-final" },
    ]);
  });

  it("still treats a provider-authored tool row after an assistant message as later work", () => {
    const threadId = "provider-tool-after-assistant";
    const state = makeState(threadId, [
      makeItem("user-1", "user_message"),
      makeItem("assistant-progress", "assistant_message", {
        assistant_text: "I found the page and am checking it now.",
      }),
      makeItem(
        "provider-browser-row",
        "mcp_tool_call",
        {},
        {
          name: "snapshot",
          serverId: "browser",
          status: "success",
        },
      ),
    ]);

    expect(selectCompactThreadTimelineEntries(state, threadId, undefined, false)).toEqual([
      { kind: "item", id: "user-1" },
      {
        kind: "turn_activity_group",
        id: "turn-activity-group:assistant-progress",
        itemIds: ["assistant-progress", "provider-browser-row"],
        entries: [
          { kind: "item", id: "assistant-progress" },
          { kind: "item", id: "provider-browser-row" },
        ],
        isCurrentTurn: false,
      },
    ]);
  });

  it("folds assistant progress into activity when a raw terminal error ends the turn", () => {
    const threadId = "failed-after-progress";
    const state = makeState(threadId, [
      makeItem("user-1", "user_message"),
      makeItem("reasoning-1", "reasoning", { reasoning_text: "Checking the connection." }),
      makeItem("assistant-progress", "assistant_message", {
        assistant_text: "I found the browser process and am connecting to it now.",
      }),
      makeItem("error-1", "error", {}, { message: "Browser connection failed." }),
    ]);

    expect(selectCompactThreadTimelineEntries(state, threadId, undefined, false)).toEqual([
      { kind: "item", id: "user-1" },
      {
        kind: "turn_activity_group",
        id: "turn-activity-group:reasoning-1",
        itemIds: ["reasoning-1", "assistant-progress"],
        entries: [
          { kind: "item", id: "reasoning-1" },
          { kind: "item", id: "assistant-progress" },
        ],
        isCurrentTurn: false,
      },
    ]);
  });

  it("does not promote progress to a final answer when cancellation is reported as a raw error", () => {
    const threadId = "cancelled-after-progress";
    const state = makeState(threadId, [
      makeItem("user-1", "user_message"),
      makeItem("assistant-progress", "assistant_message", {
        assistant_text: "I’ll finish checking the remaining tabs.",
      }),
      makeItem("error-1", "error", {}, { message: "Turn cancelled." }),
    ]);

    expect(selectCompactThreadTimelineEntries(state, threadId, undefined, false)).toEqual([
      { kind: "item", id: "user-1" },
      {
        kind: "turn_activity_group",
        id: "turn-activity-group:assistant-progress",
        itemIds: ["assistant-progress"],
        entries: [{ kind: "item", id: "assistant-progress" }],
        isCurrentTurn: false,
      },
    ]);
  });

  it("keeps a live assistant candidate visible until terminal failure is settled", () => {
    const threadId = "live-candidate-before-failure-settles";
    const state = makeState(threadId, [
      makeItem("user-1", "user_message"),
      makeItem("assistant-candidate", "assistant_message", {
        assistant_text: "I’m still checking the active browser tab.",
      }),
      makeItem("error-1", "error", {}, { message: "Connection failed." }),
    ]);

    expect(selectCompactThreadTimelineEntries(state, threadId, undefined, true)).toEqual([
      { kind: "item", id: "user-1" },
      { kind: "item", id: "assistant-candidate" },
    ]);
  });

  it("keeps a completed turn with no final answer as one activity disclosure", () => {
    const threadId = "completed-without-final";
    const state = makeState(threadId, [
      makeItem("user-1", "user_message"),
      makeItem("reasoning-1", "reasoning", { reasoning_text: "Trying the command." }),
      makeItem("command-1", "command_execution", {}, { command: "pnpm test" }),
    ]);

    expect(selectCompactThreadTimelineEntries(state, threadId, undefined, false)).toEqual([
      { kind: "item", id: "user-1" },
      {
        kind: "turn_activity_group",
        id: "turn-activity-group:reasoning-1",
        itemIds: ["reasoning-1", "command-1"],
        entries: [
          {
            kind: "tool_call_group",
            id: "tool-call-group:reasoning-1",
            itemIds: ["reasoning-1", "command-1"],
          },
        ],
        isCurrentTurn: false,
      },
    ]);
  });

  it("never hides question answers or later user prompts inside work disclosures", () => {
    const threadId = "visible-user-boundaries";
    const state = makeState(threadId, [
      makeItem("user-1", "user_message"),
      makeTool("tool-before-question", "Inspect configuration"),
      makeItem("question-1", "question_answer", {}, { questions: [] }),
      makeItem("user-2", "user_message"),
      makeTool("tool-after-user", "Read src/config.ts"),
      makeItem("assistant-final", "assistant_message", { assistant_text: "All set." }),
    ]);

    expect(selectCompactThreadTimelineEntries(state, threadId, undefined, false)).toEqual([
      { kind: "item", id: "user-1" },
      {
        kind: "turn_activity_group",
        id: "turn-activity-group:tool-before-question",
        itemIds: ["tool-before-question"],
        entries: [{ kind: "item", id: "tool-before-question" }],
        isCurrentTurn: false,
      },
      { kind: "item", id: "question-1" },
      { kind: "item", id: "user-2" },
      {
        kind: "turn_activity_group",
        id: "turn-activity-group:tool-after-user",
        itemIds: ["tool-after-user"],
        entries: [{ kind: "item", id: "tool-after-user" }],
        isCurrentTurn: false,
      },
      { kind: "item", id: "assistant-final" },
    ]);
  });
});

function makeState(
  threadId: string,
  items: readonly RuntimeChatItem[],
  structuralVersion = items.length,
): AppStoreState {
  return {
    runtimeItemIdsByThread: { [threadId]: items.map((item) => item.id) },
    runtimeItemsByIdByThread: {
      [threadId]: Object.fromEntries(items.map((item) => [item.id, item])),
    },
    runtimeStructuralVersionByThread: { [threadId]: structuralVersion },
  } as unknown as AppStoreState;
}

function makeItem(
  id: string,
  type: RuntimeChatItem["type"],
  streams: RuntimeChatItem["streams"] = {},
  payload?: RuntimeChatItem["payload"],
): RuntimeChatItem {
  return {
    id,
    type,
    state: "completed",
    ...(payload ? { payload } : {}),
    streams,
  } as RuntimeChatItem;
}

function makeTool(
  id: string,
  name: string,
  status: "running" | "success" = "success",
): RuntimeChatItem {
  return {
    id,
    type: "tool_call",
    state: status === "running" ? "started" : "completed",
    payload: { name, status },
    streams: {},
  };
}

function makeBrowserEvidence(
  id: string,
  name: string,
  status: "success" | "error" = "success",
): RuntimeChatItem {
  return makeItem(
    id,
    "mcp_tool_call",
    {},
    {
      name,
      serverId: "browser",
      status,
      browserEvidence: { source: "y-space-browser-mcp", occurredAt: 1 },
    },
  );
}
