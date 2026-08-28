import { useEffect, useState } from "react";
import { readBridge } from "@/renderer/bridge";
import { useFileEditorStore } from "@/renderer/state/fileEditorStore";
import type { RightWorkspaceFileTab } from "@/renderer/state/rightWorkspaceTabs";
import { PROJECT_FILE_PREVIEW_DEFAULT_MAX_BYTES } from "@/shared/contracts";
import { isPdfPath } from "@/shared/promptContent";
import { FileEditorPane } from "@/renderer/views/FileEditorOverlay/parts/FileEditorPane/FileEditorPane";
import { PdfDocumentPreview } from "./PdfDocumentPreview";
import { classifySpreadsheetFile, SpreadsheetPreview } from "./SpreadsheetPreview";

type PreviewState =
  | { status: "idle" | "loading" }
  | { status: "ready"; bytes: Uint8Array }
  | { status: "error"; message: string };

const PREVIEW_UNAVAILABLE_MESSAGE =
  "This document cannot be previewed inside Y Space for the current project.";

function isAbsoluteFilePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\\\") || /^[A-Za-z]:[\\/]/u.test(path);
}

function decodeBase64Bytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

export function WorkspaceDocumentPanel(props: { tab: RightWorkspaceFileTab }) {
  const { tab } = props;
  const rootContext = useFileEditorStore((state) => state.rootContext);
  const editorBuffer = useFileEditorStore((state) => state.buffers[tab.file.path]);
  const setActivePath = useFileEditorStore((state) => state.setActivePath);
  const spreadsheetKind = classifySpreadsheetFile(tab.file.path);
  const needsPreviewBytes = isPdfPath(tab.file.path) || spreadsheetKind !== null;
  const [preview, setPreview] = useState<PreviewState>({ status: "idle" });

  useEffect(() => {
    setActivePath(tab.file.path);
  }, [setActivePath, tab.file.path]);

  useEffect(() => {
    if (!needsPreviewBytes) {
      setPreview({ status: "idle" });
      return;
    }
    const matchingRoot =
      rootContext?.projectId === tab.file.projectId &&
      (rootContext.worktreePath ?? "") === tab.file.worktreePath;
    if (!matchingRoot) {
      setPreview({ status: "error", message: PREVIEW_UNAVAILABLE_MESSAGE });
      return;
    }

    const canUseContainedLocalRead =
      rootContext.remoteServerId === undefined && !isAbsoluteFilePath(tab.file.path);
    if (!canUseContainedLocalRead) {
      if (!editorBuffer || editorBuffer.isLoading) {
        setPreview({ status: "loading" });
        return;
      }
      try {
        if (editorBuffer.binaryContentBase64 !== undefined) {
          setPreview({
            status: "ready",
            bytes: decodeBase64Bytes(editorBuffer.binaryContentBase64),
          });
          return;
        }
        if (
          editorBuffer.status === "ready" &&
          (spreadsheetKind === "csv" || spreadsheetKind === "tsv")
        ) {
          setPreview({ status: "ready", bytes: new TextEncoder().encode(editorBuffer.content) });
          return;
        }
      } catch {
        // Fall through to the same finite, path-free preview error.
      }
      setPreview({ status: "error", message: PREVIEW_UNAVAILABLE_MESSAGE });
      return;
    }

    let cancelled = false;
    setPreview({ status: "loading" });
    void readBridge()
      .readProjectFilePreview({
        projectLocation: rootContext.projectLocation,
        path: tab.file.path,
        maxBytes: PROJECT_FILE_PREVIEW_DEFAULT_MAX_BYTES,
      })
      .then((result) => {
        if (!cancelled) setPreview({ status: "ready", bytes: Uint8Array.from(result.bytes) });
      })
      .catch(() => {
        if (!cancelled) {
          setPreview({ status: "error", message: PREVIEW_UNAVAILABLE_MESSAGE });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    editorBuffer,
    needsPreviewBytes,
    rootContext,
    spreadsheetKind,
    tab.file.path,
    tab.file.projectId,
    tab.file.worktreePath,
  ]);

  if (!needsPreviewBytes) {
    return <FileEditorPane presentation="desktop" showTabs={false} handleGlobalShortcuts={false} />;
  }

  if (preview.status === "error") {
    return (
      <div
        role="alert"
        className="m-4 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger"
      >
        {preview.message}
      </div>
    );
  }

  if (preview.status !== "ready") {
    return (
      <div role="status" className="flex h-full items-center justify-center text-sm text-muted">
        Preparing in-app preview…
      </div>
    );
  }

  return isPdfPath(tab.file.path) ? (
    <PdfDocumentPreview path={tab.file.path} bytes={preview.bytes} />
  ) : (
    <SpreadsheetPreview path={tab.file.path} bytes={preview.bytes} />
  );
}
