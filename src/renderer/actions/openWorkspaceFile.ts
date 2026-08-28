import { getBasename } from "@/shared/pathUtils";
import {
  resolvePathForFileOpen,
  useFileEditorStore,
  type FileEditorRootContext,
} from "@/renderer/state/fileEditorStore";
import { useRightWorkspaceTabsStore } from "@/renderer/state/rightWorkspaceTabsStore";
import { rightWorkspaceFileTabId } from "@/renderer/state/rightWorkspaceTabs";
import { switchFileEditorRoot } from "./fileEditorRootActions";

export type WorkspaceFileOpenSource = "tree" | "chat" | "git" | "command";

export interface OpenWorkspaceFileRequest {
  path: string;
  rootContext: FileEditorRootContext;
  preview: boolean;
  source: WorkspaceFileOpenSource;
  editorOptions?: {
    lineNumber?: number;
    markdownPreview?: boolean;
    gitDiff?: { diff: string };
  };
}

export interface OpenWorkspaceFileAdapters {
  setRootContext: (context: FileEditorRootContext) => boolean;
  openEditorFile: (
    path: string,
    mode: null,
    preview: boolean,
    options?: OpenWorkspaceFileRequest["editorOptions"],
  ) => Promise<unknown>;
  activateWorkspaceTab: (tabId: string) => void;
  closeWorkspaceTab?: (tabId: string) => void;
  /** Retained only as a negative contract: global document opens never call it. */
  openLegacyModal?: (path: string) => void;
  /** Retained only as a negative contract: PDFs never leave the document tab. */
  openBrowserPreview?: (path: string) => void;
}

function fileKeyFromContext(
  rootContext: FileEditorRootContext,
  path: string,
): { projectId: string; worktreePath: string; path: string } {
  return {
    projectId: rootContext.projectId,
    worktreePath: rootContext.worktreePath ?? "",
    path,
  };
}

function defaultAdapters(
  request: OpenWorkspaceFileRequest,
  canonicalPath: string,
): OpenWorkspaceFileAdapters {
  const fileKey = fileKeyFromContext(request.rootContext, canonicalPath);
  return {
    setRootContext: switchFileEditorRoot,
    openEditorFile: (path, mode, preview, options) =>
      useFileEditorStore.getState().openFile(path, mode, preview, options),
    activateWorkspaceTab: () => {
      useRightWorkspaceTabsStore
        .getState()
        .openFile(fileKey, getBasename(canonicalPath), request.preview);
    },
    closeWorkspaceTab: () => {
      useRightWorkspaceTabsStore.getState().closeTab(rightWorkspaceFileTabId(fileKey));
    },
  };
}

/**
 * Route every user file-open gesture into the right workspace. The `file:path`
 * token is an adapter-facing alias kept intentionally simple; the production
 * workspace store upgrades it to the collision-safe project/worktree identity.
 */
export async function openWorkspaceFile(
  request: OpenWorkspaceFileRequest,
  adapters?: OpenWorkspaceFileAdapters,
): Promise<void> {
  const canonicalPath = resolvePathForFileOpen(request.rootContext, request.path);
  const target = adapters ?? defaultAdapters(request, canonicalPath);
  if (!target.setRootContext(request.rootContext)) return;

  // Open/focus the outer loading tab synchronously. This preserves invocation
  // order when two reads complete out of order; the later user gesture remains
  // selected instead of an older promise stealing focus on completion.
  const tabId = `file:${canonicalPath}`;
  target.activateWorkspaceTab(tabId);
  try {
    if (request.editorOptions) {
      await target.openEditorFile(canonicalPath, null, request.preview, request.editorOptions);
    } else {
      await target.openEditorFile(canonicalPath, null, request.preview);
    }
  } catch (error) {
    target.closeWorkspaceTab?.(tabId);
    throw error;
  }
}
