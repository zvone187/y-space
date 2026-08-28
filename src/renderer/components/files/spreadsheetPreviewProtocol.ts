export type SpreadsheetFileKind = "xls" | "xlsx" | "csv" | "tsv";

export const SPREADSHEET_PREVIEW_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
export const SPREADSHEET_PREVIEW_PARSE_TIMEOUT_MS = 5_000;
export const SPREADSHEET_PREVIEW_MAX_SHEETS = 32;
export const SPREADSHEET_PREVIEW_MAX_ROWS = 500;
export const SPREADSHEET_PREVIEW_MAX_COLUMNS = 100;
export const SPREADSHEET_PREVIEW_MAX_CELLS = 50_000;
export const SPREADSHEET_PREVIEW_MAX_CELL_CHARACTERS = 2_000;

export interface SpreadsheetPreviewWorkerRequest {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly selectedSheet: string | null;
  readonly maxBytes: number;
}

export interface ParsedSpreadsheetSheet {
  readonly sheetNames: string[];
  readonly activeSheet: string;
  readonly rows: string[][];
  readonly wasTruncated: boolean;
}

export type SpreadsheetPreviewWorkerResult =
  | { readonly status: "ready"; readonly spreadsheet: ParsedSpreadsheetSheet }
  | { readonly status: "error"; readonly message: string };

export function classifySpreadsheetFile(path: string): SpreadsheetFileKind | null {
  const extension = path.match(/\.([^.\\/]+)$/)?.[1]?.toLowerCase();
  switch (extension) {
    case "xls":
    case "xlsx":
    case "csv":
    case "tsv":
      return extension;
    default:
      return null;
  }
}
