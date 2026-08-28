import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { parseSpreadsheetPreview } from "./spreadsheetPreviewParser";
import {
  SPREADSHEET_PREVIEW_DEFAULT_MAX_BYTES,
  SPREADSHEET_PREVIEW_MAX_CELLS,
  SPREADSHEET_PREVIEW_MAX_COLUMNS,
  SPREADSHEET_PREVIEW_MAX_ROWS,
} from "./spreadsheetPreviewProtocol";

const encoder = new TextEncoder();

function parseCsv(text: string) {
  return parseSpreadsheetPreview({
    path: "preview.csv",
    bytes: encoder.encode(text),
    selectedSheet: null,
    maxBytes: SPREADSHEET_PREVIEW_DEFAULT_MAX_BYTES,
  });
}

function workbookBytes(sheetCount = 2): Uint8Array {
  const workbook = XLSX.utils.book_new();
  for (let index = 0; index < sheetCount; index += 1) {
    const name = index === 0 ? "Summary" : index === 1 ? "Details" : `Sheet ${index + 1}`;
    const rows = index === 0 ? [["Revenue", 4_200]] : [["Owner", `Person ${index}`]];
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name);
  }
  const output = XLSX.write(workbook, { type: "array", bookType: "xlsx", compression: true });
  return new Uint8Array(output as ArrayBuffer);
}

describe("parseSpreadsheetPreview", () => {
  it("preflights a real OOXML workbook and materializes only the selected sheet", () => {
    const bytes = workbookBytes();
    const summary = parseSpreadsheetPreview({
      path: "preview.xlsx",
      bytes,
      selectedSheet: null,
      maxBytes: SPREADSHEET_PREVIEW_DEFAULT_MAX_BYTES,
    });
    expect(summary).toMatchObject({
      status: "ready",
      spreadsheet: {
        sheetNames: ["Summary", "Details"],
        activeSheet: "Summary",
        rows: [["Revenue", "4200"]],
      },
    });

    const details = parseSpreadsheetPreview({
      path: "preview.xlsx",
      bytes,
      selectedSheet: "Details",
      maxBytes: SPREADSHEET_PREVIEW_DEFAULT_MAX_BYTES,
    });
    expect(details).toMatchObject({
      status: "ready",
      spreadsheet: {
        sheetNames: ["Summary", "Details"],
        activeSheet: "Details",
        rows: [["Owner", "Person 1"]],
      },
    });
  });

  it("caps the workbook sheet list while keeping the selected sheet bounded", () => {
    const result = parseSpreadsheetPreview({
      path: "many-sheets.xlsx",
      bytes: workbookBytes(35),
      selectedSheet: null,
      maxBytes: SPREADSHEET_PREVIEW_DEFAULT_MAX_BYTES,
    });
    expect(result).toMatchObject({ status: "ready" });
    if (result.status !== "ready") return;
    expect(result.spreadsheet.sheetNames).toHaveLength(32);
    expect(result.spreadsheet.activeSheet).toBe("Summary");
    expect(result.spreadsheet.wasTruncated).toBe(true);
  });

  it("limits the returned grid to at most 50,000 rendered cells", () => {
    const row = Array.from({ length: SPREADSHEET_PREVIEW_MAX_COLUMNS + 25 }, (_, index) =>
      String(index),
    ).join(",");
    const csv = Array.from({ length: SPREADSHEET_PREVIEW_MAX_ROWS + 25 }, () => row).join("\n");
    const result = parseCsv(csv);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    const columnCount = result.spreadsheet.rows.reduce(
      (largest, current) => Math.max(largest, current.length),
      0,
    );
    expect(result.spreadsheet.rows).toHaveLength(SPREADSHEET_PREVIEW_MAX_ROWS);
    expect(columnCount).toBe(SPREADSHEET_PREVIEW_MAX_COLUMNS);
    expect(result.spreadsheet.rows.length * columnCount).toBeLessThanOrEqual(
      SPREADSHEET_PREVIEW_MAX_CELLS,
    );
    expect(result.spreadsheet.wasTruncated).toBe(true);
  });

  it("parses only the requested sheet name and fails closed for hidden selections", () => {
    const initial = parseCsv("Name,Seats\nY Space,8");
    expect(initial.status).toBe("ready");
    if (initial.status !== "ready") return;
    expect(initial.spreadsheet.sheetNames).toEqual(["Sheet1"]);
    expect(initial.spreadsheet.activeSheet).toBe("Sheet1");

    const hidden = parseSpreadsheetPreview({
      path: "preview.csv",
      bytes: encoder.encode("Name,Seats\nY Space,8"),
      selectedSheet: "Not returned by the worker",
      maxBytes: SPREADSHEET_PREVIEW_DEFAULT_MAX_BYTES,
    });
    expect(hidden).toMatchObject({ status: "error" });
  });

  it("rejects payloads above the 8 MiB parser ceiling before SheetJS", () => {
    const result = parseSpreadsheetPreview({
      path: "preview.csv",
      bytes: new Uint8Array(SPREADSHEET_PREVIEW_DEFAULT_MAX_BYTES + 1),
      selectedSheet: null,
      maxBytes: SPREADSHEET_PREVIEW_DEFAULT_MAX_BYTES * 2,
    });
    expect(result).toMatchObject({ status: "error" });
    expect((result as Extract<typeof result, { status: "error" }>).message).toMatch(
      /too large|size limit/i,
    );
  });
});
