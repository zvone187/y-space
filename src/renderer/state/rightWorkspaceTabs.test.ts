import { describe, expect, it } from "vitest";
import {
  RIGHT_WORKSPACE_BROWSER_PAGE_RESIDENT_LIMIT,
  createRightWorkspaceTabsState,
  getRightWorkspaceBrowserPageOverview,
  rightWorkspaceBrowserPageTabId,
  rightWorkspaceFileTabId,
  rightWorkspaceTabsReducer,
  rightWorkspaceToolTabId,
  type RightWorkspaceFileKey,
  type RightWorkspaceTabsAction,
  type RightWorkspaceTabsState,
} from "./rightWorkspaceTabs";

const root = {
  projectId: "project-1",
  worktreePath: "/workspace/project-1",
} as const;

function fileKey(path: string): RightWorkspaceFileKey {
  return { ...root, path };
}

function apply(
  state: RightWorkspaceTabsState,
  ...actions: RightWorkspaceTabsAction[]
): RightWorkspaceTabsState {
  return actions.reduce(rightWorkspaceTabsReducer, state);
}

function openTool(tool: "files" | "git" | "usage", title: string): RightWorkspaceTabsAction {
  return { type: "open-tool", tool, title };
}

function openFile(
  path: string,
  options: { preview: boolean } = { preview: false },
): RightWorkspaceTabsAction {
  return {
    type: "open-file",
    file: fileKey(path),
    title: path.split("/").at(-1) ?? path,
    preview: options.preview,
  };
}

describe("rightWorkspaceTabs IDs", () => {
  it("keeps tool IDs separate from file IDs and encodes file identity without delimiter collisions", () => {
    const toolId = rightWorkspaceToolTabId("git");
    const fileId = rightWorkspaceFileTabId({
      projectId: "tool",
      worktreePath: "/git",
      path: "git",
    });
    const ambiguousLeft = rightWorkspaceFileTabId({
      projectId: "project::worktree",
      worktreePath: "/one",
      path: "src/index.ts",
    });
    const ambiguousRight = rightWorkspaceFileTabId({
      projectId: "project",
      worktreePath: "worktree::/one",
      path: "src/index.ts",
    });

    expect(toolId).not.toBe(fileId);
    expect(ambiguousLeft).not.toBe(ambiguousRight);
    expect(rightWorkspaceFileTabId(fileKey("src/index.ts"))).toBe(
      rightWorkspaceFileTabId(fileKey("src/index.ts")),
    );
  });

  it("gives every backend browser page its own injective top-level identity", () => {
    expect(rightWorkspaceBrowserPageTabId("tab:1")).toBe("browser:tab:1");
    expect(rightWorkspaceBrowserPageTabId("tab:1")).not.toBe(rightWorkspaceBrowserPageTabId("tab"));
    expect(rightWorkspaceBrowserPageTabId("tool:browser")).not.toBe(
      rightWorkspaceToolTabId("files"),
    );
  });
});

describe("rightWorkspaceTabsReducer", () => {
  it("opens singleton tools idempotently and focuses the existing tab", () => {
    const once = apply(createRightWorkspaceTabsState(), openTool("git", "Git"));
    const withFilesActive = apply(once, openTool("files", "Files"));
    const reopened = apply(withFilesActive, openTool("git", "Git"));

    expect(reopened.tabs.map((tab) => tab.id)).toEqual([
      rightWorkspaceToolTabId("git"),
      rightWorkspaceToolTabId("files"),
    ]);
    expect(reopened.activeTabId).toBe(rightWorkspaceToolTabId("git"));
    expect(reopened.tabs.filter((tab) => tab.id === rightWorkspaceToolTabId("git"))).toHaveLength(
      1,
    );
  });

  it("ensures a scoped tool exists without stealing the active document", () => {
    const documentId = rightWorkspaceFileTabId(fileKey("src/main.ts"));
    const state = apply(createRightWorkspaceTabsState(), openFile("src/main.ts"), {
      type: "ensure-tool",
      tool: "git",
      title: "Git",
    });

    expect(state.tabs.map((tab) => tab.id)).toEqual([documentId, rightWorkspaceToolTabId("git")]);
    expect(state.activeTabId).toBe(documentId);
  });

  it("replaces one unpinned preview in place and keeps a pinned preview when another opens", () => {
    const firstPreviewId = rightWorkspaceFileTabId(fileKey("src/preview-a.ts"));
    const replacementId = rightWorkspaceFileTabId(fileKey("src/preview-b.ts"));
    const nextPreviewId = rightWorkspaceFileTabId(fileKey("src/preview-c.ts"));
    const permanentId = rightWorkspaceFileTabId(fileKey("src/permanent.ts"));

    const withPreview = apply(
      createRightWorkspaceTabsState(),
      openFile("src/permanent.ts"),
      openFile("src/preview-a.ts", { preview: true }),
    );
    const replaced = apply(withPreview, openFile("src/preview-b.ts", { preview: true }));

    expect(replaced.tabs.map((tab) => tab.id)).toEqual([permanentId, replacementId]);
    expect(replaced.tabs.some((tab) => tab.id === firstPreviewId)).toBe(false);
    expect(replaced.previewTabId).toBe(replacementId);
    expect(replaced.activeTabId).toBe(replacementId);

    const pinnedThenOpened = apply(
      replaced,
      { type: "pin-preview", tabId: replacementId },
      openFile("src/preview-c.ts", { preview: true }),
    );

    expect(pinnedThenOpened.tabs.map((tab) => tab.id)).toEqual([
      permanentId,
      replacementId,
      nextPreviewId,
    ]);
    expect(pinnedThenOpened.previewTabId).toBe(nextPreviewId);
    expect(pinnedThenOpened.tabs.find((tab) => tab.id === replacementId)).toMatchObject({
      kind: "file",
      preview: false,
    });
  });

  it("selects the next adjacent tab on close, then falls back to the previous tab", () => {
    const filesId = rightWorkspaceToolTabId("files");
    const gitId = rightWorkspaceToolTabId("git");
    const usageId = rightWorkspaceToolTabId("usage");
    const state = apply(
      createRightWorkspaceTabsState(),
      openTool("files", "Files"),
      openTool("git", "Git"),
      openTool("usage", "Usage"),
      { type: "activate", tabId: gitId },
    );

    const closedMiddle = apply(state, { type: "close", tabId: gitId });
    expect(closedMiddle.tabs.map((tab) => tab.id)).toEqual([filesId, usageId]);
    expect(closedMiddle.activeTabId).toBe(usageId);

    const closedLast = apply(closedMiddle, { type: "close", tabId: usageId });
    expect(closedLast.tabs.map((tab) => tab.id)).toEqual([filesId]);
    expect(closedLast.activeTabId).toBe(filesId);
  });

  it("reorders by stable tab ID without changing the active selection", () => {
    const filesId = rightWorkspaceToolTabId("files");
    const gitId = rightWorkspaceToolTabId("git");
    const usageId = rightWorkspaceToolTabId("usage");
    const state = apply(
      createRightWorkspaceTabsState(),
      openTool("files", "Files"),
      openTool("git", "Git"),
      openTool("usage", "Usage"),
      { type: "activate", tabId: gitId },
    );

    const reordered = apply(state, { type: "reorder", tabId: usageId, toIndex: 0 });

    expect(reordered.tabs.map((tab) => tab.id)).toEqual([usageId, filesId, gitId]);
    expect(reordered.activeTabId).toBe(gitId);
  });

  it("opens each browser page as a peer tab even when pages share a URL", () => {
    const state = apply(
      createRightWorkspaceTabsState(),
      {
        type: "open-browser-page",
        browserTabId: "page-1",
        url: "https://example.com",
        title: "Example one",
      },
      {
        type: "open-browser-page",
        browserTabId: "page-2",
        url: "https://example.com",
        title: "Example two",
      },
    );

    expect(state.tabs).toMatchObject([
      {
        id: "browser:page-1",
        kind: "browser-page",
        browserTabId: "page-1",
        url: "https://example.com",
        title: "Example one",
        resident: true,
      },
      {
        id: "browser:page-2",
        kind: "browser-page",
        browserTabId: "page-2",
        url: "https://example.com",
        title: "Example two",
        resident: true,
      },
    ]);
    expect(state.activeTabId).toBe("browser:page-2");
  });

  it("syncs authoritative backend pages without stealing focus from a document", () => {
    const initial = apply(
      createRightWorkspaceTabsState(),
      {
        type: "sync-browser-pages",
        pages: [
          { browserTabId: "page-1", url: "https://one.test", title: "One" },
          { browserTabId: "page-2", url: "https://two.test", title: "Two" },
        ],
        selectedBrowserTabId: "page-1",
      },
      openFile("src/main.ts"),
    );
    const synced = apply(initial, {
      type: "sync-browser-pages",
      pages: [
        { browserTabId: "page-2", url: "https://two.test/updated", title: "Two updated" },
        { browserTabId: "page-3", url: "about:blank", title: "New tab" },
      ],
      selectedBrowserTabId: "page-3",
    });

    expect(synced.activeTabId).toBe(rightWorkspaceFileTabId(fileKey("src/main.ts")));
    expect(synced.tabs.filter((tab) => tab.kind === "browser-page")).toMatchObject([
      {
        id: "browser:page-2",
        url: "https://two.test/updated",
        title: "Two updated",
      },
      { id: "browser:page-3", url: "about:blank", title: "New tab" },
    ]);
    expect(synced.tabs.some((tab) => tab.id === "browser:page-1")).toBe(false);
  });

  it("follows backend page selection when browser content already owns global focus", () => {
    const initial = apply(createRightWorkspaceTabsState(), {
      type: "sync-browser-pages",
      pages: [
        { browserTabId: "page-1", url: "https://one.test", title: "One" },
        { browserTabId: "page-2", url: "https://two.test", title: "Two" },
      ],
      selectedBrowserTabId: "page-1",
    });
    const focused = apply(initial, { type: "select-browser-page", browserTabId: "page-1" });
    const selected = apply(focused, {
      type: "sync-browser-pages",
      pages: [
        { browserTabId: "page-1", url: "https://one.test", title: "One" },
        { browserTabId: "page-2", url: "https://two.test", title: "Two" },
      ],
      selectedBrowserTabId: "page-2",
    });

    expect(selected.activeTabId).toBe("browser:page-2");
    expect(selected.tabs.find((tab) => tab.id === "browser:page-2")).toMatchObject({
      lastActivatedSequence: 3,
    });
  });

  it("uses mixed global peer order when the backend closes the selected browser page", () => {
    const fileId = rightWorkspaceFileTabId(fileKey("src/main.ts"));
    const initial = apply(
      createRightWorkspaceTabsState(),
      {
        type: "open-browser-page",
        browserTabId: "page-1",
        url: "https://one.test",
        title: "One",
      },
      openFile("src/main.ts"),
      {
        type: "open-browser-page",
        browserTabId: "page-2",
        url: "https://two.test",
        title: "Two",
      },
      { type: "select-browser-page", browserTabId: "page-1" },
    );

    const afterGuestClose = apply(initial, {
      type: "sync-browser-pages",
      pages: [{ browserTabId: "page-2", url: "https://two.test", title: "Two" }],
      selectedBrowserTabId: "page-2",
    });

    expect(afterGuestClose.tabs.map((tab) => tab.id)).toEqual([fileId, "browser:page-2"]);
    expect(afterGuestClose.activeTabId).toBe(fileId);
  });

  it("keeps six LRU browser webviews resident and suspends older metadata-only tabs", () => {
    const actions: RightWorkspaceTabsAction[] = Array.from(
      { length: RIGHT_WORKSPACE_BROWSER_PAGE_RESIDENT_LIMIT + 2 },
      (_, index) => ({
        type: "open-browser-page",
        browserTabId: `page-${index + 1}`,
        url: `https://example.test/${index + 1}`,
        title: `Page ${index + 1}`,
      }),
    );
    const state = apply(createRightWorkspaceTabsState(), ...actions, {
      type: "activate",
      tabId: "browser:page-1",
    });
    const overview = getRightWorkspaceBrowserPageOverview(state);

    expect(overview).toHaveLength(RIGHT_WORKSPACE_BROWSER_PAGE_RESIDENT_LIMIT + 2);
    expect(overview.find((page) => page.browserTabId === "page-1")).toMatchObject({
      active: true,
      resident: true,
    });
    expect(overview.filter((page) => page.resident)).toHaveLength(
      RIGHT_WORKSPACE_BROWSER_PAGE_RESIDENT_LIMIT,
    );
    expect(overview.filter((page) => !page.resident).map((page) => page.browserTabId)).toEqual([
      "page-2",
      "page-3",
    ]);
  });

  it("never suspends a sensitive integration page mid-auth", () => {
    const actions: RightWorkspaceTabsAction[] = [
      {
        type: "open-browser-page",
        browserTabId: "oauth",
        url: "https://connect.example.test/oauth",
        title: "Connect account",
        sensitiveIntegration: true,
      },
      ...Array.from(
        { length: RIGHT_WORKSPACE_BROWSER_PAGE_RESIDENT_LIMIT + 1 },
        (_, index): RightWorkspaceTabsAction => ({
          type: "open-browser-page",
          browserTabId: `ordinary-${index + 1}`,
          url: `https://example.test/${index + 1}`,
          title: `Ordinary ${index + 1}`,
        }),
      ),
    ];
    const overview = getRightWorkspaceBrowserPageOverview(
      apply(createRightWorkspaceTabsState(), ...actions),
    );

    expect(overview.find((page) => page.browserTabId === "oauth")).toMatchObject({
      sensitiveIntegration: true,
      resident: true,
    });
    expect(overview.filter((page) => !page.sensitiveIntegration && page.resident)).toHaveLength(
      RIGHT_WORKSPACE_BROWSER_PAGE_RESIDENT_LIMIT,
    );
  });

  it("closes and reorders browser pages with the same peer-tab semantics as files", () => {
    const initial = apply(
      createRightWorkspaceTabsState(),
      {
        type: "open-browser-page",
        browserTabId: "page-1",
        url: "https://one.test",
        title: "One",
      },
      openFile("src/main.ts"),
      {
        type: "open-browser-page",
        browserTabId: "page-2",
        url: "https://two.test",
        title: "Two",
      },
    );
    const reordered = apply(initial, {
      type: "reorder",
      tabId: "browser:page-2",
      toIndex: 0,
    });
    const closed = apply(reordered, { type: "close", tabId: "browser:page-2" });

    expect(reordered.tabs.map((tab) => tab.id)).toEqual([
      "browser:page-2",
      "browser:page-1",
      rightWorkspaceFileTabId(fileKey("src/main.ts")),
    ]);
    expect(closed.activeTabId).toBe("browser:page-1");
    expect(closed.tabs.map((tab) => tab.id)).toEqual([
      "browser:page-1",
      rightWorkspaceFileTabId(fileKey("src/main.ts")),
    ]);
  });

  it("remaps renamed folders and removes deleted paths only inside the matching root", () => {
    const otherRoot = { projectId: "project-2", worktreePath: "/workspace/project-2" };
    const state = apply(
      createRightWorkspaceTabsState(),
      openFile("src/a.ts"),
      openFile("src/nested/b.ts"),
      {
        type: "open-file",
        file: { ...otherRoot, path: "src/a.ts" },
        title: "a.ts",
        preview: false,
      },
    );

    const renamed = apply(state, {
      type: "rename-file-path",
      root,
      path: "src",
      nextPath: "app",
    });
    expect(renamed.tabs.filter((tab) => tab.kind === "file").map((tab) => tab.file.path)).toEqual([
      "app/a.ts",
      "app/nested/b.ts",
      "src/a.ts",
    ]);
    expect(renamed.activeTabId).toBe(rightWorkspaceFileTabId({ ...otherRoot, path: "src/a.ts" }));

    const removed = apply(renamed, {
      type: "remove-file-path",
      root,
      path: "app",
    });
    expect(removed.tabs).toHaveLength(1);
    expect(removed.tabs[0]).toMatchObject({
      kind: "file",
      file: { projectId: "project-2", path: "src/a.ts" },
    });
  });
});
