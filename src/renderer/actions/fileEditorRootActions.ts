import { hasDirtyEditorBuffers } from "@/renderer/state/fileEditorSelectors";
import { useFileEditorStore, type FileEditorRootContext } from "@/renderer/state/fileEditorStore";

export function fileEditorRootsMatch(
  left: FileEditorRootContext | null,
  right: FileEditorRootContext,
): boolean {
  return (
    left?.projectId === right.projectId &&
    left.worktreePath === right.worktreePath &&
    left.remoteServerId === right.remoteServerId
  );
}

/**
 * Atomically guard a project/worktree switch before FileEditorStore clears its
 * buffers and the matching outer document tabs. Lifecycle teardown can still
 * call setRootContext/clearSession directly; user-initiated navigation uses
 * this coordinator so a dirty workspace is never silently discarded.
 */
export function switchFileEditorRoot(
  nextRoot: FileEditorRootContext,
  confirmDiscard: (message: string) => boolean = (message) => window.confirm(message),
): boolean {
  const editor = useFileEditorStore.getState();
  if (fileEditorRootsMatch(editor.rootContext, nextRoot)) return true;
  if (hasDirtyEditorBuffers() && !confirmDiscard("Discard unsaved editor changes?")) return false;
  editor.setRootContext(nextRoot);
  return true;
}
