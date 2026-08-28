import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEditorRootContext } from "@/renderer/state/fileEditorStore";

const openWorkspaceFile = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<void>>(() => Promise.resolve()),
);

vi.mock("@/renderer/actions/openWorkspaceFile", () => ({ openWorkspaceFile }));

import { openPdfPreview } from "./openPdfPreview";

describe("openPdfPreview", () => {
  const mainRoot = {
    projectId: "p1",
    projectName: "Y Space",
    projectLocation: { kind: "posix", path: "/repo/y-space" },
    rootLabel: "Y Space",
  } satisfies FileEditorRootContext;

  beforeEach(() => {
    openWorkspaceFile.mockClear();
  });

  it("opens an attachment PDF in a global document tab, never a Browser page tab", () => {
    openPdfPreview("/Users/me/Biometric Reuse.pdf", mainRoot);

    expect(openWorkspaceFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/Users/me/Biometric Reuse.pdf",
        preview: false,
        source: "chat",
        rootContext: expect.objectContaining({ projectId: "p1" }),
      }),
    );
  });

  it("keeps project-relative PDFs relative for the contained preview reader", () => {
    openPdfPreview("docs/a.pdf", mainRoot);

    expect(openWorkspaceFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "docs/a.pdf",
        rootContext: expect.objectContaining({ projectId: "p1" }),
      }),
    );
  });

  it("uses the caller-owned split project/worktree instead of the focused project", () => {
    const splitWorktreeRoot = {
      projectId: "p2",
      projectName: "Other Project",
      projectLocation: { kind: "posix", path: "/repo/other-worktree" },
      rootLabel: "feature/pdf-tabs",
      worktreePath: "/repo/other-worktree",
    } satisfies FileEditorRootContext;

    openPdfPreview("docs/split.pdf", splitWorktreeRoot);

    expect(openWorkspaceFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "docs/split.pdf",
        rootContext: splitWorktreeRoot,
      }),
    );
  });
});
