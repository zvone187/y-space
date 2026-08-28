import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEditorRootContext } from "@/renderer/state/fileEditorStore";
import { ProjectFilesPanel } from "./ProjectFilesPanel";

const openWorkspaceFile = vi.hoisted(() =>
  vi.fn<(request: Record<string, unknown>) => Promise<void>>(async () => undefined),
);

vi.mock("@/renderer/actions/openWorkspaceFile", () => ({ openWorkspaceFile }));

vi.mock("@/renderer/views/FileEditorOverlay/parts/ProjectTreeView/ProjectTreeView", () => ({
  ProjectTreeView: (props: { onSelectFile: (path: string) => void }) => (
    <button type="button" onClick={() => props.onSelectFile("src/main.ts")}>
      Open source file
    </button>
  ),
}));

const rootContext = {
  projectId: "project-1",
  projectName: "Y Space",
  projectLocation: { kind: "posix", path: "/repo/y-space" },
  rootLabel: "Y Space",
} satisfies FileEditorRootContext;

describe("ProjectFilesPanel", () => {
  beforeEach(() => {
    openWorkspaceFile.mockClear();
  });

  it("opens a workspace tree file as a permanent global tab on the first click", async () => {
    render(<ProjectFilesPanel rootContext={rootContext} presentation="workspace" />);

    fireEvent.click(screen.getByRole("button", { name: "Open source file" }));

    await waitFor(() =>
      expect(openWorkspaceFile).toHaveBeenCalledWith({
        path: "src/main.ts",
        rootContext,
        preview: false,
        source: "tree",
      }),
    );
  });
});
