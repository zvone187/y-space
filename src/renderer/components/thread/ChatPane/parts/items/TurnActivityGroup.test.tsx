import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppProvider } from "@/renderer/components/ui/provider";
import { useAppStore } from "@/renderer/state/appStore";
import type { ChatTimelineEntry } from "../../chatPaneSelectors";
import { TurnActivityGroup } from "./TurnActivityGroup";

vi.mock("./ChatItemRow", () => ({
  ChatItemRow: ({ entry }: { entry: ChatTimelineEntry }) => (
    <div data-testid={`activity-body-${entry.id}`}>{entry.id}</div>
  ),
}));

describe("TurnActivityGroup", () => {
  beforeEach(() => {
    useAppStore.setState({
      runtimeItemIdsByThread: {},
      runtimeItemsByIdByThread: {},
      runtimeRequestsByThread: {},
      runtimeStructuralVersionByThread: {},
    });
  });

  it("uses one closed disclosure for the whole turn, preserves a manual live expansion, and closes when settled", () => {
    const firstEntries = [itemEntry("status-1")];
    const allEntries = [...firstEntries, itemEntry("tool-1")];
    const view = renderGroup(firstEntries, true);

    const trigger = screen.getByRole("button");
    expect(trigger).toHaveTextContent("Working…");
    expect(trigger.querySelector(".font-mono")).toBeNull();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("activity-body-status-1")).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("activity-body-status-1")).toBeInTheDocument();

    view.rerender(groupElement(allEntries, true));
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("activity-body-status-1")).toBeInTheDocument();
    expect(screen.getByTestId("activity-body-tool-1")).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);

    view.rerender(groupElement(allEntries, false));
    expect(screen.getByRole("button")).toHaveTextContent("Worked · 2 steps");
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("activity-body-status-1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("activity-body-tool-1")).not.toBeInTheDocument();
  });

  it("temporarily reveals a nested item selected by Find", () => {
    const entries = [itemEntry("status-1")];
    const view = render(
      <AppProvider>
        <TurnActivityGroup threadId="thread-1" entries={entries} revealedItemId="status-1" />
      </AppProvider>,
    );

    expect(screen.getByRole("button")).toHaveTextContent("Worked · 1 step");
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("activity-body-status-1")).toBeInTheDocument();

    view.rerender(groupElement(entries, false));
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("activity-body-status-1")).not.toBeInTheDocument();
  });
});

function itemEntry(id: string): ChatTimelineEntry {
  return { kind: "item", id };
}

function groupElement(entries: readonly ChatTimelineEntry[], isLive: boolean) {
  return (
    <AppProvider>
      <TurnActivityGroup threadId="thread-1" entries={entries} isLive={isLive} />
    </AppProvider>
  );
}

function renderGroup(entries: readonly ChatTimelineEntry[], isLive: boolean) {
  return render(groupElement(entries, isLive));
}
