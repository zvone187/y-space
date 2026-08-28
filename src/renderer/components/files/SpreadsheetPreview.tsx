import { useEffect, useMemo, useRef, useState } from "react";
import {
  SPREADSHEET_PREVIEW_DEFAULT_MAX_BYTES,
  SPREADSHEET_PREVIEW_MAX_CELLS,
  SPREADSHEET_PREVIEW_MAX_COLUMNS,
  SPREADSHEET_PREVIEW_MAX_ROWS,
  SPREADSHEET_PREVIEW_MAX_SHEETS,
  SPREADSHEET_PREVIEW_PARSE_TIMEOUT_MS,
  type ParsedSpreadsheetSheet,
  type SpreadsheetPreviewWorkerRequest,
  type SpreadsheetPreviewWorkerResult,
} from "./spreadsheetPreviewProtocol";

export { classifySpreadsheetFile } from "./spreadsheetPreviewProtocol";
export type { SpreadsheetFileKind } from "./spreadsheetPreviewProtocol";

interface SpreadsheetWorkerLike {
  onmessage: ((event: MessageEvent<SpreadsheetPreviewWorkerResult>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: SpreadsheetPreviewWorkerRequest, transfer: Transferable[]): void;
  terminate(): void;
}

type PreviewState =
  | { readonly status: "loading"; readonly previous?: ParsedSpreadsheetSheet }
  | { readonly status: "ready"; readonly spreadsheet: ParsedSpreadsheetSheet }
  | { readonly status: "error"; readonly message: string };

export interface SpreadsheetPreviewProps {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly maxBytes?: number;
  /** Test seam; production always uses the isolated Vite worker below. */
  readonly createWorker?: () => SpreadsheetWorkerLike;
  /** Test seam bounded to the same finite production timeout range. */
  readonly parseTimeoutMs?: number;
}

function createSpreadsheetWorker(): SpreadsheetWorkerLike {
  return new Worker(new URL("./spreadsheetPreview.worker.ts", import.meta.url), {
    type: "module",
    name: "y-space-spreadsheet-preview",
  });
}

function boundedMaxBytes(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) < 1) {
    return SPREADSHEET_PREVIEW_DEFAULT_MAX_BYTES;
  }
  return Math.min(value as number, SPREADSHEET_PREVIEW_DEFAULT_MAX_BYTES);
}

function boundedTimeout(value: number | undefined): number {
  if (!Number.isFinite(value) || (value ?? 0) < 1) return SPREADSHEET_PREVIEW_PARSE_TIMEOUT_MS;
  return Math.min(Math.trunc(value as number), SPREADSHEET_PREVIEW_PARSE_TIMEOUT_MS);
}

function workerError(message: string): PreviewState {
  return { status: "error", message };
}

function isWorkerResult(value: unknown): value is SpreadsheetPreviewWorkerResult {
  if (!value || typeof value !== "object" || !("status" in value)) return false;
  if (value.status === "error") {
    return "message" in value && typeof value.message === "string" && value.message.length <= 240;
  }
  if (value.status !== "ready" || !("spreadsheet" in value)) return false;
  const spreadsheet = value.spreadsheet;
  if (!spreadsheet || typeof spreadsheet !== "object") return false;
  if (
    !("sheetNames" in spreadsheet) ||
    !Array.isArray(spreadsheet.sheetNames) ||
    spreadsheet.sheetNames.length < 1 ||
    spreadsheet.sheetNames.length > SPREADSHEET_PREVIEW_MAX_SHEETS ||
    !spreadsheet.sheetNames.every((name) => typeof name === "string") ||
    !("activeSheet" in spreadsheet) ||
    typeof spreadsheet.activeSheet !== "string" ||
    !spreadsheet.sheetNames.includes(spreadsheet.activeSheet) ||
    !("wasTruncated" in spreadsheet) ||
    typeof spreadsheet.wasTruncated !== "boolean" ||
    !("rows" in spreadsheet) ||
    !Array.isArray(spreadsheet.rows) ||
    spreadsheet.rows.length > SPREADSHEET_PREVIEW_MAX_ROWS
  ) {
    return false;
  }

  let largestRow = 0;
  for (const row of spreadsheet.rows) {
    if (
      !Array.isArray(row) ||
      row.length > SPREADSHEET_PREVIEW_MAX_COLUMNS ||
      !row.every((cell) => typeof cell === "string")
    ) {
      return false;
    }
    largestRow = Math.max(largestRow, row.length);
  }
  return spreadsheet.rows.length * largestRow <= SPREADSHEET_PREVIEW_MAX_CELLS;
}

function nextTabIndex(currentIndex: number, key: string, length: number): number | null {
  if (length < 1) return null;
  switch (key) {
    case "ArrowLeft":
      return (currentIndex - 1 + length) % length;
    case "ArrowRight":
      return (currentIndex + 1) % length;
    case "Home":
      return 0;
    case "End":
      return length - 1;
    default:
      return null;
  }
}

export function SpreadsheetPreview(props: SpreadsheetPreviewProps) {
  const { path, bytes, createWorker = createSpreadsheetWorker, maxBytes, parseTimeoutMs } = props;
  const [selection, setSelection] = useState<{
    readonly path: string;
    readonly bytes: Uint8Array;
    readonly sheet: string;
  } | null>(null);
  const [state, setState] = useState<PreviewState>({ status: "loading" });
  const sheetTabRefs = useRef(new Map<string, HTMLButtonElement>());
  const previousRequestRef = useRef<{ readonly path: string; readonly bytes: Uint8Array } | null>(
    null,
  );
  const selectedSheet =
    selection?.path === path && selection.bytes === bytes ? selection.sheet : null;
  const safeMaxBytes = boundedMaxBytes(maxBytes);
  const safeTimeout = boundedTimeout(parseTimeoutMs);

  useEffect(() => {
    let worker: SpreadsheetWorkerLike;
    try {
      worker = createWorker();
    } catch {
      setState(workerError("The isolated spreadsheet preview worker could not be started."));
      return;
    }

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (nextState: PreviewState) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      worker.terminate();
      setState(nextState);
    };

    const previousRequest = previousRequestRef.current;
    const sameDocument = previousRequest?.path === path && previousRequest.bytes === bytes;
    previousRequestRef.current = { path, bytes };
    setState((current) => {
      if (!sameDocument) return { status: "loading" };
      if (current.status === "ready") {
        return { status: "loading", previous: current.spreadsheet };
      }
      return current.status === "loading" && current.previous
        ? { status: "loading", previous: current.previous }
        : { status: "loading" };
    });
    worker.onmessage = (event) => {
      if (!isWorkerResult(event.data)) {
        settle(workerError("The spreadsheet preview worker returned an invalid response."));
        return;
      }
      settle(
        event.data.status === "ready"
          ? { status: "ready", spreadsheet: event.data.spreadsheet }
          : workerError(event.data.message),
      );
    };
    worker.onerror = (event) => {
      event.preventDefault?.();
      settle(workerError("The spreadsheet could not be parsed in the isolated preview worker."));
    };
    timer = setTimeout(() => {
      settle(workerError("Spreadsheet preview stopped because parsing exceeded the time limit."));
    }, safeTimeout);

    const workerBytes = Uint8Array.from(bytes);
    try {
      worker.postMessage({ path, bytes: workerBytes, selectedSheet, maxBytes: safeMaxBytes }, [
        workerBytes.buffer,
      ]);
    } catch {
      settle(workerError("The spreadsheet could not be sent to the isolated preview worker."));
    }

    return () => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      worker.terminate();
    };
  }, [bytes, createWorker, path, safeMaxBytes, safeTimeout, selectedSheet]);

  const readySpreadsheet =
    state.status === "ready"
      ? state.spreadsheet
      : state.status === "loading"
        ? state.previous
        : null;
  const columnCount = useMemo(
    () => readySpreadsheet?.rows.reduce((largest, row) => Math.max(largest, row.length), 0) ?? 0,
    [readySpreadsheet],
  );

  if (state.status === "error") {
    return (
      <div
        role="alert"
        className="m-4 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger"
      >
        {state.message}
      </div>
    );
  }

  if (!readySpreadsheet) {
    return (
      <div role="status" className="flex h-full items-center justify-center text-sm text-muted">
        Preparing spreadsheet preview…
      </div>
    );
  }

  const { sheetNames, activeSheet, rows, wasTruncated } = readySpreadsheet;
  const renderedCellCount = rows.length * columnCount;
  if (renderedCellCount > SPREADSHEET_PREVIEW_MAX_CELLS) {
    return (
      <div role="alert" className="m-4 text-sm text-danger">
        This worksheet exceeds the safe rendered-cell limit.
      </div>
    );
  }

  const selectAndFocusSheet = (sheetName: string) => {
    setSelection({ path, bytes, sheet: sheetName });
    requestAnimationFrame(() => sheetTabRefs.current.get(sheetName)?.focus());
  };

  return (
    <div
      aria-busy={state.status === "loading"}
      className="flex h-full min-h-0 flex-col bg-background text-foreground"
    >
      <div
        role="tablist"
        aria-label="Workbook sheets"
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-border/40 px-2 pt-2"
      >
        {sheetNames.map((sheetName, sheetIndex) => {
          const isActive = sheetName === activeSheet;
          return (
            <button
              key={sheetName}
              ref={(node) => {
                if (node) sheetTabRefs.current.set(sheetName, node);
                else sheetTabRefs.current.delete(sheetName);
              }}
              type="button"
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              className={`max-w-48 shrink-0 truncate rounded-t-md border border-b-0 px-3 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-focus/50 ${
                isActive
                  ? "border-border/60 bg-surface text-foreground"
                  : "border-transparent text-muted hover:bg-default/20 hover:text-foreground"
              }`}
              onClick={() => {
                if (!isActive) setSelection({ path, bytes, sheet: sheetName });
              }}
              onKeyDown={(event) => {
                const nextIndex = nextTabIndex(sheetIndex, event.key, sheetNames.length);
                if (nextIndex === null) return;
                event.preventDefault();
                const nextSheet = sheetNames[nextIndex];
                if (nextSheet) selectAndFocusSheet(nextSheet);
              }}
            >
              {sheetName}
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-max min-w-full border-separate border-spacing-0 text-left text-xs">
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-muted">This worksheet is empty.</td>
              </tr>
            ) : (
              rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {Array.from({ length: columnCount }, (_, columnIndex) => (
                    <td
                      key={columnIndex}
                      className="max-w-96 border-b border-r border-border/30 px-2 py-1.5 align-top whitespace-pre-wrap"
                    >
                      {row[columnIndex] ?? ""}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {wasTruncated ? (
        <p className="shrink-0 border-t border-border/40 px-3 py-1.5 text-xs text-muted">
          Preview truncated to keep the workspace responsive.
        </p>
      ) : null}
    </div>
  );
}
