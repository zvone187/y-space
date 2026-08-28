import * as XLSX from "xlsx";
import { preflightSpreadsheetArchive } from "./spreadsheetPreviewArchive";
import {
  classifySpreadsheetFile,
  SPREADSHEET_PREVIEW_DEFAULT_MAX_BYTES,
  SPREADSHEET_PREVIEW_MAX_CELL_CHARACTERS,
  SPREADSHEET_PREVIEW_MAX_CELLS,
  SPREADSHEET_PREVIEW_MAX_COLUMNS,
  SPREADSHEET_PREVIEW_MAX_ROWS,
  SPREADSHEET_PREVIEW_MAX_SHEETS,
  type SpreadsheetPreviewWorkerRequest,
  type SpreadsheetPreviewWorkerResult,
} from "./spreadsheetPreviewProtocol";

function hasPrefix(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function looksLikeXls(bytes: Uint8Array): boolean {
  if (hasPrefix(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return true;
  if (bytes[0] === 0x09 && [0x00, 0x02, 0x04, 0x08].includes(bytes[1] ?? -1)) return true;

  const prefix = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.byteLength, 512)));
  return /^\s*<\?xml\b/i.test(prefix) && /(?:Workbook|spreadsheet)/i.test(prefix);
}

function normalizeCell(value: unknown): string {
  let text: string;
  if (value === null || value === undefined) text = "";
  else if (typeof value === "string") text = value;
  else if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    text = String(value);
  } else if (value instanceof Date) text = value.toISOString();
  else text = "[Unsupported value]";

  return text.length > SPREADSHEET_PREVIEW_MAX_CELL_CHARACTERS
    ? `${text.slice(0, SPREADSHEET_PREVIEW_MAX_CELL_CHARACTERS - 1)}…`
    : text;
}

function parseError(message: string): SpreadsheetPreviewWorkerResult {
  return { status: "error", message };
}

export function parseSpreadsheetPreview(
  request: SpreadsheetPreviewWorkerRequest,
): SpreadsheetPreviewWorkerResult {
  const { path, bytes, selectedSheet } = request;
  const maxBytes = Number.isSafeInteger(request.maxBytes)
    ? Math.min(request.maxBytes, SPREADSHEET_PREVIEW_DEFAULT_MAX_BYTES)
    : SPREADSHEET_PREVIEW_DEFAULT_MAX_BYTES;
  if (bytes.byteLength > maxBytes) {
    return parseError("This spreadsheet is too large to preview safely (size limit exceeded).");
  }
  if (bytes.byteLength === 0) {
    return parseError("This spreadsheet is empty and could not be previewed.");
  }

  const kind = classifySpreadsheetFile(path);
  if (!kind) return parseError("This file is not a supported spreadsheet.");
  if (kind === "xlsx") {
    const preflight = preflightSpreadsheetArchive(bytes);
    if (preflight.status === "error") return parseError(preflight.message);
  } else if (kind === "xls" && !looksLikeXls(bytes)) {
    return parseError("Invalid spreadsheet: the workbook could not be previewed.");
  }

  try {
    // `sheets` keeps SheetJS from parsing worksheet XML for every workbook tab.
    // Sheet names remain available so the UI can request another sheet later.
    const workbook = XLSX.read(bytes, {
      type: "array",
      dense: true,
      sheets: selectedSheet ?? 0,
      sheetRows: SPREADSHEET_PREVIEW_MAX_ROWS + 1,
      cellFormula: false,
      cellHTML: false,
      cellStyles: false,
      bookDeps: false,
      bookVBA: false,
      ...(kind === "csv" ? { FS: "," } : {}),
      ...(kind === "tsv" ? { FS: "\t" } : {}),
    });

    if (workbook.SheetNames.length === 0) {
      return parseError("Invalid spreadsheet: no worksheets were found.");
    }

    const sheetNames = workbook.SheetNames.slice(0, SPREADSHEET_PREVIEW_MAX_SHEETS);
    const matchingSelection = selectedSheet
      ? sheetNames.find((name) => name.toLowerCase() === selectedSheet.toLowerCase())
      : undefined;
    const activeSheet = matchingSelection ?? sheetNames[0];
    if (!activeSheet) return parseError("Invalid spreadsheet: no readable worksheets were found.");

    // A caller can only select names returned by the preceding bounded result.
    // Fail closed if an arbitrary hidden sheet name reaches this worker.
    if (selectedSheet && !matchingSelection) {
      return parseError("This worksheet is outside the safe preview sheet limit.");
    }

    const worksheet = workbook.Sheets[activeSheet];
    if (!worksheet) {
      return parseError("Invalid spreadsheet: the selected worksheet could not be read.");
    }

    const rawRows = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
      header: 1,
      raw: false,
      defval: "",
      blankrows: true,
    });
    let wasTruncated =
      workbook.SheetNames.length > SPREADSHEET_PREVIEW_MAX_SHEETS ||
      rawRows.length > SPREADSHEET_PREVIEW_MAX_ROWS;

    const rows = rawRows.slice(0, SPREADSHEET_PREVIEW_MAX_ROWS).map((row) => {
      if (row.length > SPREADSHEET_PREVIEW_MAX_COLUMNS) wasTruncated = true;
      return row.slice(0, SPREADSHEET_PREVIEW_MAX_COLUMNS).map(normalizeCell);
    });
    const renderedColumnCount = rows.reduce((largest, row) => Math.max(largest, row.length), 0);
    if (rows.length * renderedColumnCount > SPREADSHEET_PREVIEW_MAX_CELLS) {
      // Constants are deliberately chosen so this should remain unreachable,
      // but keep the invariant local if one dimension changes in the future.
      const safeRowCount = Math.floor(SPREADSHEET_PREVIEW_MAX_CELLS / renderedColumnCount);
      rows.splice(Math.max(0, safeRowCount));
      wasTruncated = true;
    }

    return {
      status: "ready",
      spreadsheet: { sheetNames, activeSheet, rows, wasTruncated },
    };
  } catch {
    return parseError(
      "This spreadsheet could not be previewed because the file is invalid or unsupported.",
    );
  }
}
