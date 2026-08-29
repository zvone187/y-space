import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppProvider } from "@/renderer/components/ui/provider";
import { useAppStore } from "@/renderer/state/appStore";
import type { RuntimeChatItem } from "@/renderer/state/slices/runtimeEventSlice";
import { AssistantMessage, AssistantMessageGroup } from "./AssistantMessage";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("AssistantMessage", () => {
  it("renders embedded image content blocks inline alongside text", () => {
    const item: RuntimeChatItem = {
      id: "asst_1",
      type: "assistant_message",
      state: "completed",
      payload: {
        content: [
          { kind: "text", text: "Here is your image:" },
          {
            kind: "image",
            mimeType: "image/png",
            dataUrl: `data:image/png;base64,${PNG_BASE64}`,
            name: "result",
          },
        ],
      },
      streams: {},
    };

    render(
      <AppProvider>
        <AssistantMessage threadId="thread-1" item={item} isTurnActive={false} />
      </AppProvider>,
    );

    const img = screen.getByAltText("result") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(`data:image/png;base64,${PNG_BASE64}`);
    expect(screen.getByText("Here is your image:")).toBeTruthy();
  });

  it("ignores non-image content blocks", () => {
    const item: RuntimeChatItem = {
      id: "asst_2",
      type: "assistant_message",
      state: "completed",
      payload: { content: [{ kind: "text", text: "Just text." }] },
      streams: {},
    };

    render(
      <AppProvider>
        <AssistantMessage threadId="thread-1" item={item} isTurnActive={false} />
      </AppProvider>,
    );

    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("Just text.")).toBeTruthy();
  });

  it("renders and copies multipart final content as one response surface", async () => {
    const first: RuntimeChatItem = {
      id: "asst_first",
      type: "assistant_message",
      state: "completed",
      streams: { assistant_text: "First final section." },
    };
    const second: RuntimeChatItem = {
      id: "asst_second",
      type: "assistant_message",
      state: "completed",
      payload: {
        content: [
          { kind: "text", text: "Second final section." },
          {
            kind: "image",
            mimeType: "image/png",
            dataUrl: `data:image/png;base64,${PNG_BASE64}`,
            name: "multipart result",
          },
        ],
      },
      streams: {},
    };
    useAppStore.setState({
      runtimeItemIdsByThread: { "thread-1": [first.id, second.id] },
      runtimeItemsByIdByThread: { "thread-1": { [first.id]: first, [second.id]: second } },
    });
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const { container } = render(
      <AppProvider>
        <AssistantMessageGroup
          threadId="thread-1"
          itemIds={[first.id, second.id]}
          isTurnActive={false}
        />
      </AppProvider>,
    );

    expect(container.querySelectorAll("[data-assistant-message-group='true']")).toHaveLength(1);
    expect(container.querySelector("[data-item-id='asst_first']")).toHaveTextContent(
      "First final section.",
    );
    expect(container.querySelector("[data-item-id='asst_second']")).toHaveTextContent(
      "Second final section.",
    );
    expect(screen.getByAltText("multipart result")).toBeTruthy();
    expect(screen.getAllByLabelText("Copy message")).toHaveLength(1);

    fireEvent.click(screen.getByLabelText("Copy message"));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("First final section.\n\nSecond final section."),
    );
  });

  it("shows app-owned Browser proof on the final response", () => {
    const user: RuntimeChatItem = {
      id: "user_browser",
      type: "user_message",
      state: "completed",
      streams: {},
    };
    const proof: RuntimeChatItem = {
      id: "browser_proof",
      type: "mcp_tool_call",
      state: "completed",
      streams: {},
      payload: {
        name: "snapshot",
        serverId: "browser",
        status: "success",
        browserEvidence: { source: "y-space-browser-mcp", occurredAt: 1 },
      },
    };
    const answer: RuntimeChatItem = {
      id: "browser_answer",
      type: "assistant_message",
      state: "completed",
      streams: { assistant_text: "I verified the web page." },
    };
    useAppStore.setState({
      runtimeItemIdsByThread: { "thread-browser": [user.id, proof.id, answer.id] },
      runtimeItemsByIdByThread: {
        "thread-browser": { [user.id]: user, [proof.id]: proof, [answer.id]: answer },
      },
    });

    render(
      <AppProvider>
        <AssistantMessage threadId="thread-browser" item={answer} isTurnActive={false} />
      </AppProvider>,
    );

    expect(screen.getByText("Browser verified · 1 action")).toBeTruthy();
  });

  it("keeps the settled final controls and proof when app-owned Browser evidence reports late", () => {
    const user: RuntimeChatItem = {
      id: "user_browser_late",
      type: "user_message",
      state: "completed",
      streams: {},
    };
    const answer: RuntimeChatItem = {
      id: "browser_answer_late",
      type: "assistant_message",
      state: "completed",
      streams: { assistant_text: "I verified the website." },
    };
    const proof: RuntimeChatItem = {
      id: "browser_proof_late",
      type: "mcp_tool_call",
      state: "completed",
      streams: {},
      payload: {
        name: "snapshot",
        serverId: "browser",
        status: "success",
        browserEvidence: { source: "y-space-browser-mcp", occurredAt: 1 },
      },
    };
    useAppStore.setState({
      runtimeItemIdsByThread: { "thread-browser-late": [user.id, answer.id, proof.id] },
      runtimeItemsByIdByThread: {
        "thread-browser-late": { [user.id]: user, [answer.id]: answer, [proof.id]: proof },
      },
    });

    render(
      <AppProvider>
        <AssistantMessage threadId="thread-browser-late" item={answer} isTurnActive={false} />
      </AppProvider>,
    );

    expect(screen.getByLabelText("Copy message")).toBeTruthy();
    expect(screen.getByText("Browser verified · 1 action")).toBeTruthy();
  });

  it("labels an unsupported Browser verification claim but ignores a PDF tab claim", () => {
    const unsupported: RuntimeChatItem = {
      id: "unsupported_answer",
      type: "assistant_message",
      state: "completed",
      streams: { assistant_text: "I checked the website in the browser." },
    };
    useAppStore.setState({
      runtimeItemIdsByThread: { "thread-browser": [unsupported.id] },
      runtimeItemsByIdByThread: { "thread-browser": { [unsupported.id]: unsupported } },
    });
    const { rerender } = render(
      <AppProvider>
        <AssistantMessage threadId="thread-browser" item={unsupported} isTurnActive={false} />
      </AppProvider>,
    );
    expect(screen.getByText("Browser not verified")).toBeTruthy();

    const pdfAnswer: RuntimeChatItem = {
      id: "pdf_answer",
      type: "assistant_message",
      state: "completed",
      streams: { assistant_text: "I opened the PDF in a new tab." },
    };
    act(() => {
      useAppStore.setState({
        runtimeItemIdsByThread: { "thread-browser": [pdfAnswer.id] },
        runtimeItemsByIdByThread: { "thread-browser": { [pdfAnswer.id]: pdfAnswer } },
      });
    });
    rerender(
      <AppProvider>
        <AssistantMessage threadId="thread-browser" item={pdfAnswer} isTurnActive={false} />
      </AppProvider>,
    );
    expect(screen.queryByText("Browser not verified")).toBeNull();
  });

  describe("copy action gating", () => {
    const answer: RuntimeChatItem = {
      id: "asst_answer",
      type: "assistant_message",
      state: "completed",
      payload: { content: [{ kind: "text", text: "All done." }] },
      streams: {},
    };

    function seed(items: RuntimeChatItem[]) {
      useAppStore.setState({
        runtimeItemIdsByThread: { "thread-1": items.map((entry) => entry.id) },
        runtimeItemsByIdByThread: {
          "thread-1": Object.fromEntries(items.map((entry) => [entry.id, entry])),
        },
      });
    }

    beforeEach(() => {
      useAppStore.setState({ runtimeItemIdsByThread: {}, runtimeItemsByIdByThread: {} });
    });

    it("shows the copy action when the message is the turn's last item", () => {
      seed([answer]);
      render(
        <AppProvider>
          <AssistantMessage threadId="thread-1" item={answer} isTurnActive={false} />
        </AppProvider>,
      );
      expect(screen.getByLabelText("Copy message")).toBeTruthy();
    });

    it("shows the copy action when the next top-level item is the next user message", () => {
      seed([
        answer,
        { id: "user_2", type: "user_message", state: "completed", payload: {}, streams: {} },
      ]);
      render(
        <AppProvider>
          <AssistantMessage threadId="thread-1" item={answer} isTurnActive={true} />
        </AppProvider>,
      );
      expect(screen.getByLabelText("Copy message")).toBeTruthy();
    });

    it("hides the copy action when tool calls follow the message in the same turn", () => {
      seed([
        answer,
        { id: "tool_1", type: "tool_call", state: "completed", payload: {}, streams: {} },
      ]);
      render(
        <AppProvider>
          <AssistantMessage threadId="thread-1" item={answer} isTurnActive={false} />
        </AppProvider>,
      );
      expect(screen.queryByLabelText("Copy message")).toBeNull();
    });

    it("ignores nested sub-agent items when locating the turn's last item", () => {
      seed([
        answer,
        {
          id: "child_1",
          type: "tool_call",
          state: "completed",
          payload: {},
          streams: {},
          parentItemId: "tool_parent",
        },
      ]);
      render(
        <AppProvider>
          <AssistantMessage threadId="thread-1" item={answer} isTurnActive={false} />
        </AppProvider>,
      );
      expect(screen.getByLabelText("Copy message")).toBeTruthy();
    });

    it("reserves the copy strip without exposing its action while the turn is active", () => {
      seed([answer]);
      const { container, rerender } = render(
        <AppProvider>
          <AssistantMessage threadId="thread-1" item={answer} isTurnActive={true} />
        </AppProvider>,
      );
      expect(screen.queryByLabelText("Copy message")).toBeNull();
      const reservedStrip = container.querySelector(".poracode-message-action-strip");
      expect(reservedStrip).not.toBeNull();

      rerender(
        <AppProvider>
          <AssistantMessage threadId="thread-1" item={answer} isTurnActive={false} />
        </AppProvider>,
      );

      expect(screen.getByLabelText("Copy message")).toBeTruthy();
      expect(container.querySelector(".poracode-message-action-strip")).toBe(reservedStrip);
    });
  });
});
