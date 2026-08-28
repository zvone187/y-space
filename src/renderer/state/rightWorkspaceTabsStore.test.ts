import { beforeEach, describe, expect, it } from "vitest";
import { useRightWorkspaceTabsStore } from "./rightWorkspaceTabsStore";

describe("rightWorkspaceTabsStore cycleTab", () => {
  beforeEach(() => useRightWorkspaceTabsStore.getState().reset());

  it("cycles a mixed document/tool sequence and wraps", () => {
    const workspace = useRightWorkspaceTabsStore.getState();
    workspace.openFile(
      { projectId: "p1", worktreePath: "", path: "src/main.ts" },
      "main.ts",
      false,
    );
    workspace.openTool("git");
    workspace.openBrowserPage({
      browserTabId: "page-1",
      url: "https://example.com",
      title: "Example",
    });

    expect(useRightWorkspaceTabsStore.getState().activeTabId).toBe("browser:page-1");
    workspace.cycleTab("next");
    expect(useRightWorkspaceTabsStore.getState().activeTabId).toContain("src/main.ts");
    workspace.cycleTab("next");
    expect(useRightWorkspaceTabsStore.getState().activeTabId).toBe("tool:git");
    workspace.cycleTab("previous");
    expect(useRightWorkspaceTabsStore.getState().activeTabId).toContain("src/main.ts");
  });

  it("gives agents an overview and stable page-selection methods", () => {
    const workspace = useRightWorkspaceTabsStore.getState();
    workspace.syncBrowserPages(
      [
        { browserTabId: "page-1", url: "https://one.test", title: "One" },
        { browserTabId: "page-2", url: "https://two.test", title: "Two" },
      ],
      "page-1",
    );
    expect(useRightWorkspaceTabsStore.getState().activeTabId).toBeNull();
    workspace.selectBrowserPage("page-1");

    expect(workspace.getBrowserPageOverview()).toMatchObject([
      {
        tabId: "browser:page-1",
        browserTabId: "page-1",
        url: "https://one.test",
        title: "One",
        active: true,
        resident: true,
      },
      {
        tabId: "browser:page-2",
        browserTabId: "page-2",
        url: "https://two.test",
        title: "Two",
        active: false,
        resident: true,
      },
    ]);

    workspace.promoteBrowserPage("page-2");
    expect(useRightWorkspaceTabsStore.getState().activeTabId).toBe("browser:page-1");
    workspace.selectBrowserPage("page-2");
    expect(useRightWorkspaceTabsStore.getState().activeTabId).toBe("browser:page-2");
    workspace.reorderBrowserPage("page-2", 0);
    expect(useRightWorkspaceTabsStore.getState().tabs[0]?.id).toBe("browser:page-2");
    workspace.closeBrowserPage("page-2");
    expect(useRightWorkspaceTabsStore.getState().tabs.map((tab) => tab.id)).toEqual([
      "browser:page-1",
    ]);
  });
});
