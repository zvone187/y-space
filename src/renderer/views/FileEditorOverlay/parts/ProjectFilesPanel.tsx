import { toast } from "@heroui/react";
import { overlaySidebarColumnClass } from "@/renderer/components/layout/sidebarChrome";
import { useFileEditorStore, type FileEditorRootContext } from "@/renderer/state/fileEditorStore";
import { openWorkspaceFile } from "@/renderer/actions/openWorkspaceFile";
import { switchFileEditorRoot } from "@/renderer/actions/fileEditorRootActions";
import { ProjectTreeView } from "@/renderer/views/FileEditorOverlay/parts/ProjectTreeView/ProjectTreeView";

export function ProjectFilesPanel(props: {
  rootContext: FileEditorRootContext;
  presentation?: "workspace" | "legacy-modal";
}) {
  function handleSelectFile(path: string) {
    if (props.presentation === "legacy-modal") {
      if (!switchFileEditorRoot(props.rootContext)) return;
      void useFileEditorStore
        .getState()
        .openFile(path, "modal", true)
        .catch((error) => toast.danger(error instanceof Error ? error.message : String(error)));
      return;
    }
    void openWorkspaceFile({
      path,
      rootContext: props.rootContext,
      preview: false,
      source: "tree",
    }).catch((error) => toast.danger(error instanceof Error ? error.message : String(error)));
  }

  return (
    <div className={overlaySidebarColumnClass}>
      <ProjectTreeView rootContext={props.rootContext} onSelectFile={handleSelectFile} />
    </div>
  );
}
