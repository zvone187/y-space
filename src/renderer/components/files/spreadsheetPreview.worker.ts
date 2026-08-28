import { parseSpreadsheetPreview } from "./spreadsheetPreviewParser";
import type {
  SpreadsheetPreviewWorkerRequest,
  SpreadsheetPreviewWorkerResult,
} from "./spreadsheetPreviewProtocol";

interface SpreadsheetWorkerScope {
  onmessage: ((event: MessageEvent<SpreadsheetPreviewWorkerRequest>) => void) | null;
  postMessage(message: SpreadsheetPreviewWorkerResult): void;
}

const workerScope = globalThis as unknown as SpreadsheetWorkerScope;
workerScope.onmessage = (event) => {
  workerScope.postMessage(parseSpreadsheetPreview(event.data));
};
