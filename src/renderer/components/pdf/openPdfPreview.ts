import { toast } from "@heroui/react";
import type { FileEditorRootContext } from "@/renderer/state/fileEditorStore";
import { openWorkspaceFile } from "@/renderer/actions/openWorkspaceFile";

/** Open a local/project PDF as a global in-app document tab. */
export function openPdfPreview(path: string, rootContext: FileEditorRootContext): void {
  void openWorkspaceFile({
    path,
    rootContext,
    preview: false,
    source: "chat",
  }).catch((error) => toast.danger(error instanceof Error ? error.message : String(error)));
}
