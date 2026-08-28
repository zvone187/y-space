import { afterEach, describe, expect, it } from "vitest";
import { useCommandPaletteStore } from "@/renderer/commands/commandPaletteStore";
import { useAppStore } from "@/renderer/state/appStore";
import { usePanelStore } from "@/renderer/state/panelStore";
import { useRightWorkspaceTabsStore } from "@/renderer/state/rightWorkspaceTabsStore";
import { resolveFindTarget } from "./findController";

function resetFindRoutingState(): void {
  document.body.innerHTML = "";
  useCommandPaletteStore.setState({ isOpen: false });
  usePanelStore.setState({
    settingsOpen: false,
    projectSettingsId: null,
    gitOverlayOpen: false,
    prReviewContext: null,
    threadSearchOpen: false,
    createProjectModalOpen: false,
    cloneProjectModalOpen: false,
  });
  useAppStore.setState({ view: { kind: "home" } });
  useRightWorkspaceTabsStore.getState().reset();
}

describe("resolveFindTarget", () => {
  afterEach(() => {
    resetFindRoutingState();
  });

  it("falls back to chat in a thread view", () => {
    useAppStore.setState({ view: { kind: "thread", panes: ["thread-1"] } });

    expect(resolveFindTarget()).toBe("chat");
  });

  it("does not route browser chrome focus to chat find", () => {
    useAppStore.setState({ view: { kind: "thread", panes: ["thread-1"] } });
    document.body.innerHTML = `<div data-poracode-browser=""><input id="address" /></div>`;
    document.getElementById("address")?.focus();

    expect(resolveFindTarget()).toBeNull();
  });

  it("lets the command palette keep Ctrl+F", () => {
    useAppStore.setState({ view: { kind: "thread", panes: ["thread-1"] } });
    useCommandPaletteStore.setState({ isOpen: true });

    expect(resolveFindTarget()).toBeNull();
  });

  it("routes a focused global document header to editor find", () => {
    useRightWorkspaceTabsStore
      .getState()
      .openFile({ projectId: "p1", worktreePath: "", path: "src/main.ts" }, "main.ts", false);
    document.body.innerHTML = `<div data-poracode-panel=""><button id="tab">main.ts</button></div>`;
    document.getElementById("tab")?.focus();

    expect(resolveFindTarget()).toBe("editor");
  });

  it.each([
    ["files", "tree"],
    ["git", "git"],
    ["terminal", "terminal"],
  ] as const)("routes a focused %s workspace header to %s find", (tool, expected) => {
    useRightWorkspaceTabsStore.getState().openTool(tool);
    document.body.innerHTML = `<div data-poracode-panel=""><button id="tab">tool</button></div>`;
    document.getElementById("tab")?.focus();

    expect(resolveFindTarget()).toBe(expected);
  });

  it("leaves find inside a focused global browser page to the website", () => {
    useRightWorkspaceTabsStore.getState().openBrowserPage({
      browserTabId: "page-1",
      url: "https://example.test",
      title: "Example",
    });
    document.body.innerHTML = `<div data-poracode-panel=""><button id="tab">Example</button></div>`;
    document.getElementById("tab")?.focus();

    expect(resolveFindTarget()).toBeNull();
  });
});
