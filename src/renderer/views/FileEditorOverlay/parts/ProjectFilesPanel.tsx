import { toast } from "@heroui/react";
import { overlaySidebarColumnClass } from "@/renderer/components/layout/sidebarChrome";
import { useFileEditorStore, type FileEditorRootContext } from "@/renderer/state/fileEditorStore";
import { openWorkspaceFile } from "@/renderer/actions/openWorkspaceFile";
import { useRightWorkspaceTabsStore } from "@/renderer/state/rightWorkspaceTabsStore";
import { switchFileEditorRoot } from "@/renderer/actions/fileEditorRootActions";
import { ProjectTreeView } from "@/renderer/views/FileEditorOverlay/parts/ProjectTreeView/ProjectTreeView";

export function ProjectFilesPanel(props: {
  rootContext: FileEditorRootContext;
  presentation?: "workspace" | "legacy-modal";
}) {
  const pinTab = useFileEditorStore((state) => state.pinTab);

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
      preview: true,
      source: "tree",
    }).catch((error) => toast.danger(error instanceof Error ? error.message : String(error)));
  }

  function handlePinFile(path: string) {
    pinTab(path);
    const workspace = useRightWorkspaceTabsStore.getState();
    const tab = workspace.tabs.find(
      (candidate) => candidate.kind === "file" && candidate.file.path === path,
    );
    if (tab) workspace.pinPreview(tab.id);
  }

  return (
    <div className={overlaySidebarColumnClass}>
      <ProjectTreeView
        rootContext={props.rootContext}
        onSelectFile={handleSelectFile}
        onPinFile={handlePinFile}
      />
    </div>
  );
}
