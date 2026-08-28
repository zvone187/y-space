import { describe, expect, it } from "vitest";
import { preflightSpreadsheetArchive } from "./spreadsheetPreviewArchive";

interface SyntheticZipOptions {
  compressedBytes?: number;
  expandedBytes?: number;
  encrypted?: boolean;
  zip64?: boolean;
}

function writeUint16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

function writeUint32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, true);
}

function syntheticZip(options: SyntheticZipOptions = {}): Uint8Array {
  const name = new TextEncoder().encode("xl/workbook.xml");
  const compressedBytes = options.compressedBytes ?? 8;
  const expandedBytes = options.expandedBytes ?? compressedBytes;
  const flags = options.encrypted ? 1 : 0;
  const localLength = 30 + name.byteLength + compressedBytes;
  const centralLength = 46 + name.byteLength;
  const bytes = new Uint8Array(localLength + centralLength + 22);
  const view = new DataView(bytes.buffer);

  writeUint32(view, 0, 0x04034b50);
  writeUint16(view, 4, 20);
  writeUint16(view, 6, flags);
  writeUint16(view, 8, 8);
  writeUint32(view, 18, compressedBytes);
  writeUint32(view, 22, expandedBytes);
  writeUint16(view, 26, name.byteLength);
  bytes.set(name, 30);

  const centralOffset = localLength;
  writeUint32(view, centralOffset, 0x02014b50);
  writeUint16(view, centralOffset + 4, 20);
  writeUint16(view, centralOffset + 6, 20);
  writeUint16(view, centralOffset + 8, flags);
  writeUint16(view, centralOffset + 10, 8);
  writeUint32(view, centralOffset + 20, compressedBytes);
  writeUint32(view, centralOffset + 24, expandedBytes);
  writeUint16(view, centralOffset + 28, name.byteLength);
  bytes.set(name, centralOffset + 46);

  const eocdOffset = centralOffset + centralLength;
  writeUint32(view, eocdOffset, 0x06054b50);
  writeUint16(view, eocdOffset + 8, options.zip64 ? 0xffff : 1);
  writeUint16(view, eocdOffset + 10, options.zip64 ? 0xffff : 1);
  writeUint32(view, eocdOffset + 12, centralLength);
  writeUint32(view, eocdOffset + 16, centralOffset);
  return bytes;
}

describe("preflightSpreadsheetArchive", () => {
  it("accepts a bounded single-disk OOXML-style archive", () => {
    expect(preflightSpreadsheetArchive(syntheticZip())).toMatchObject({
      status: "ready",
      entryCount: 1,
      compressedBytes: 8,
      expandedBytes: 8,
    });
  });

  it("rejects a ZIP bomb by compression ratio before SheetJS sees its bytes", () => {
    const result = preflightSpreadsheetArchive(
      syntheticZip({ compressedBytes: 1, expandedBytes: 10_000 }),
    );
    expect(result).toMatchObject({ status: "error" });
    expect((result as Extract<typeof result, { status: "error" }>).message).toMatch(
      /compression ratio|expands/i,
    );
  });

  it("rejects encrypted and ZIP64 archives", () => {
    const encrypted = preflightSpreadsheetArchive(syntheticZip({ encrypted: true }));
    expect(encrypted).toMatchObject({ status: "error" });
    expect((encrypted as Extract<typeof encrypted, { status: "error" }>).message).toMatch(
      /encrypted/i,
    );

    const zip64 = preflightSpreadsheetArchive(syntheticZip({ zip64: true }));
    expect(zip64).toMatchObject({ status: "error" });
    expect((zip64 as Extract<typeof zip64, { status: "error" }>).message).toMatch(/zip64/i);
  });
});
