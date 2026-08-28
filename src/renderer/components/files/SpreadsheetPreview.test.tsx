import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SpreadsheetPreview,
  classifySpreadsheetFile,
  type SpreadsheetPreviewProps,
} from "./SpreadsheetPreview";
import {
  SPREADSHEET_PREVIEW_DEFAULT_MAX_BYTES,
  type SpreadsheetPreviewWorkerRequest,
  type SpreadsheetPreviewWorkerResult,
} from "./spreadsheetPreviewProtocol";

const encoder = new TextEncoder();

type WorkerFactory = NonNullable<SpreadsheetPreviewProps["createWorker"]>;

function fakeWorker(
  respond: (request: SpreadsheetPreviewWorkerRequest) => SpreadsheetPreviewWorkerResult | null,
): { createWorker: WorkerFactory; terminate: ReturnType<typeof vi.fn> } {
  const terminate = vi.fn<() => void>();
  const createWorker: WorkerFactory = () => {
    const worker = {
      onmessage: null as ((event: MessageEvent<SpreadsheetPreviewWorkerResult>) => void) | null,
      onerror: null as ((event: ErrorEvent) => void) | null,
      postMessage(request: SpreadsheetPreviewWorkerRequest) {
        const result = respond(request);
        if (!result) return;
        queueMicrotask(() => worker.onmessage?.({ data: result } as MessageEvent));
      },
      terminate,
    };
    return worker;
  };
  return { createWorker, terminate };
}

function workbookResult(request: SpreadsheetPreviewWorkerRequest): SpreadsheetPreviewWorkerResult {
  if (request.selectedSheet === "Details") {
    return {
      status: "ready",
      spreadsheet: {
        sheetNames: ["Summary", "Details"],
        activeSheet: "Details",
        rows: [
          ["Owner", "Status"],
          ["Ada", "Ready"],
        ],
        wasTruncated: false,
      },
    };
  }
  return {
    status: "ready",
    spreadsheet: {
      sheetNames: ["Summary", "Details"],
      activeSheet: "Summary",
      rows: [
        ["Revenue", "4200"],
        ["Seats", "8"],
      ],
      wasTruncated: false,
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("classifySpreadsheetFile", () => {
  it.each([
    ["legacy/report.XLS", "xls"],
    ["reports/quarterly.xlsx", "xlsx"],
    ["exports/customers.CSV", "csv"],
    ["exports/events.tsv", "tsv"],
  ] as const)("classifies %s as %s", (path, expected) => {
    expect(classifySpreadsheetFile(path)).toBe(expected);
  });

  it("does not classify unrelated source files as spreadsheets", () => {
    expect(classifySpreadsheetFile("src/report.ts")).toBeNull();
  });
});

describe("SpreadsheetPreview", () => {
  it("parses in an isolated worker and switches the single visible sheet", async () => {
    const { createWorker, terminate } = fakeWorker(workbookResult);
    render(
      <SpreadsheetPreview
        path="reports/quarterly.xlsx"
        bytes={encoder.encode("worker-owned bytes")}
        createWorker={createWorker}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(/preparing spreadsheet/i);
    const summaryTab = await screen.findByRole("tab", { name: "Summary" });
    const detailsTab = screen.getByRole("tab", { name: "Details" });
    expect(summaryTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Revenue")).toBeInTheDocument();

    fireEvent.click(detailsTab);

    expect(await screen.findByText("Owner")).toBeInTheDocument();
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.queryByText("Revenue")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Details" })).toHaveAttribute("aria-selected", "true");
    expect(terminate).toHaveBeenCalledTimes(2);
  });

  it("uses Arrow, Home, and End keys to activate and focus sheet tabs", async () => {
    const { createWorker } = fakeWorker(workbookResult);
    render(
      <SpreadsheetPreview
        path="reports/quarterly.xlsx"
        bytes={encoder.encode("worker-owned bytes")}
        createWorker={createWorker}
      />,
    );

    const summaryTab = await screen.findByRole("tab", { name: "Summary" });
    fireEvent.keyDown(summaryTab, { key: "ArrowRight" });
    const detailsTab = await screen.findByRole("tab", { name: "Details", selected: true });
    await waitFor(() => expect(detailsTab).toHaveFocus());

    fireEvent.keyDown(detailsTab, { key: "Home" });
    const selectedSummary = await screen.findByRole("tab", { name: "Summary", selected: true });
    await waitFor(() => expect(selectedSummary).toHaveFocus());

    fireEvent.keyDown(selectedSummary, { key: "End" });
    expect(await screen.findByRole("tab", { name: "Details", selected: true })).toBeInTheDocument();
  });

  it("clamps every worker request to the 8 MiB preview ceiling", async () => {
    let observedMaxBytes = 0;
    const { createWorker } = fakeWorker((request) => {
      observedMaxBytes = request.maxBytes;
      return workbookResult(request);
    });
    render(
      <SpreadsheetPreview
        path="exports/customers.csv"
        bytes={encoder.encode("Name,Seats\nY Space,8")}
        maxBytes={32 * 1024 * 1024}
        createWorker={createWorker}
      />,
    );

    const grid = await screen.findByRole("table");
    expect(within(grid).getByText("Revenue")).toBeInTheDocument();
    expect(observedMaxBytes).toBe(SPREADSHEET_PREVIEW_DEFAULT_MAX_BYTES);
  });

  it("hard-terminates a worker that exceeds the parse timeout", async () => {
    vi.useFakeTimers();
    const { createWorker, terminate } = fakeWorker(() => null);
    render(
      <SpreadsheetPreview
        path="reports/stalled.xlsx"
        bytes={encoder.encode("stalled")}
        createWorker={createWorker}
        parseTimeoutMs={25}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(25);
    });

    expect(screen.getByRole("alert")).toHaveTextContent(/time limit/i);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed worker response without rendering arbitrary cells", async () => {
    const { createWorker } = fakeWorker(
      () => ({ status: "ready" }) as unknown as SpreadsheetPreviewWorkerResult,
    );
    render(
      <SpreadsheetPreview
        path="reports/broken.xlsx"
        bytes={encoder.encode("broken")}
        createWorker={createWorker}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(/invalid response/i);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
