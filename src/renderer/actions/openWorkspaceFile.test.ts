import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEditorRootContext } from "@/renderer/state/fileEditorStore";
import { openWorkspaceFile } from "./openWorkspaceFile";

const rootContext = {
  projectId: "project-1",
  projectName: "Y Space",
  projectLocation: { kind: "posix", path: "/repo/y-space" },
  rootLabel: "Y Space",
} satisfies FileEditorRootContext;

function makeAdapters() {
  return {
    setRootContext: vi.fn<(context: FileEditorRootContext) => boolean>(() => true),
    openEditorFile: vi.fn<(path: string, mode: null, preview: boolean) => Promise<unknown>>(
      async () => undefined,
    ),
    activateWorkspaceTab: vi.fn<(tabId: string) => void>(),
    closeWorkspaceTab: vi.fn<(tabId: string) => void>(),
    openLegacyModal: vi.fn<(path: string) => void>(),
    openBrowserPreview: vi.fn<(path: string) => void>(),
  };
}

describe("openWorkspaceFile", () => {
  let adapters: ReturnType<typeof makeAdapters>;

  beforeEach(() => {
    adapters = makeAdapters();
  });

  it.each([
    { path: "src/main.ts", source: "tree", preview: true },
    { path: "docs/manual.pdf", source: "chat", preview: false },
    { path: "reports/quarterly.xlsx", source: "git", preview: false },
    { path: "exports/customers.csv", source: "command", preview: false },
  ] as const)(
    "routes $path from $source into its outer document tab",
    async ({ path, source, preview }) => {
      await openWorkspaceFile({ path, rootContext, preview, source }, adapters);

      expect(adapters.setRootContext).toHaveBeenCalledWith(rootContext);
      expect(adapters.openEditorFile).toHaveBeenCalledWith(path, null, preview);
      expect(adapters.activateWorkspaceTab).toHaveBeenCalledWith(`file:${path}`);
      expect(adapters.openLegacyModal).not.toHaveBeenCalled();
      expect(adapters.openBrowserPreview).not.toHaveBeenCalled();
    },
  );

  it("uses one stable outer tab identity when the same PDF is opened again", async () => {
    const request = {
      path: "docs/manual.pdf",
      rootContext,
      preview: false,
      source: "tree" as const,
    };

    await openWorkspaceFile(request, adapters);
    await openWorkspaceFile(request, adapters);

    expect(adapters.activateWorkspaceTab).toHaveBeenNthCalledWith(1, "file:docs/manual.pdf");
    expect(adapters.activateWorkspaceTab).toHaveBeenNthCalledWith(2, "file:docs/manual.pdf");
    expect(new Set(adapters.activateWorkspaceTab.mock.calls.map(([tabId]) => tabId))).toEqual(
      new Set(["file:docs/manual.pdf"]),
    );
    expect(adapters.openBrowserPreview).not.toHaveBeenCalled();
  });

  it("uses one identity for equivalent safe relative path spellings", async () => {
    await openWorkspaceFile(
      { path: "./src//main.ts", rootContext, preview: true, source: "tree" },
      adapters,
    );
    await openWorkspaceFile(
      { path: "src\\main.ts", rootContext, preview: false, source: "tree" },
      adapters,
    );

    expect(adapters.openEditorFile).toHaveBeenNthCalledWith(1, "src/main.ts", null, true);
    expect(adapters.openEditorFile).toHaveBeenNthCalledWith(2, "src/main.ts", null, false);
    expect(adapters.activateWorkspaceTab).toHaveBeenNthCalledWith(1, "file:src/main.ts");
    expect(adapters.activateWorkspaceTab).toHaveBeenNthCalledWith(2, "file:src/main.ts");
  });

  it("forwards a later permanent open while the same preview read is still pending", async () => {
    let resolveFirst: (() => void) | undefined;
    adapters.openEditorFile
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(undefined);

    const preview = openWorkspaceFile(
      { path: "src/main.ts", rootContext, preview: true, source: "tree" },
      adapters,
    );
    const permanent = openWorkspaceFile(
      { path: "src/main.ts", rootContext, preview: false, source: "tree" },
      adapters,
    );

    await permanent;
    expect(adapters.openEditorFile).toHaveBeenNthCalledWith(1, "src/main.ts", null, true);
    expect(adapters.openEditorFile).toHaveBeenNthCalledWith(2, "src/main.ts", null, false);
    resolveFirst?.();
    await preview;
  });

  it("preserves traversal in the absolute IO path so filesystem symlinks resolve correctly", async () => {
    await openWorkspaceFile(
      {
        path: "../shared/report.xlsx",
        rootContext: {
          ...rootContext,
          projectLocation: { kind: "posix", path: "/repo/y-space/worktree" },
          worktreePath: "/repo/y-space/worktree",
        },
        preview: false,
        source: "chat",
      },
      adapters,
    );

    expect(adapters.openEditorFile).toHaveBeenCalledWith(
      "/repo/y-space/worktree/../shared/report.xlsx",
      null,
      false,
    );
    expect(adapters.activateWorkspaceTab).toHaveBeenCalledWith(
      "file:/repo/y-space/worktree/../shared/report.xlsx",
    );
  });

  it("cancels a guarded root switch without opening or discarding a document", async () => {
    adapters.setRootContext.mockReturnValue(false);

    await openWorkspaceFile(
      { path: "src/main.ts", rootContext, preview: false, source: "command" },
      adapters,
    );

    expect(adapters.openEditorFile).not.toHaveBeenCalled();
    expect(adapters.activateWorkspaceTab).not.toHaveBeenCalled();
    expect(adapters.closeWorkspaceTab).not.toHaveBeenCalled();
  });

  it("closes the provisional outer tab when the file read fails", async () => {
    adapters.openEditorFile.mockRejectedValueOnce(new Error("read failed"));

    await expect(
      openWorkspaceFile(
        { path: "missing.pdf", rootContext, preview: false, source: "tree" },
        adapters,
      ),
    ).rejects.toThrow("read failed");

    expect(adapters.closeWorkspaceTab).toHaveBeenCalledWith("file:missing.pdf");
  });
});
