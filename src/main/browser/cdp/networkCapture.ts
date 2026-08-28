import type { CdpClient } from "./cdpClient";
import { truncateUtf8, utf8ByteLength } from "../boundedText";

const NETWORK_BUFFER_SIZE = 500;
const MAX_NETWORK_REQUEST_ID_BYTES = 1024;
const MAX_NETWORK_METHOD_BYTES = 64;
const MAX_NETWORK_URL_BYTES = 64 * 1024;
const MAX_NETWORK_RESOURCE_TYPE_BYTES = 128;
const MAX_NETWORK_STATUS_TEXT_BYTES = 1024;
const MAX_NETWORK_MIME_TYPE_BYTES = 1024;
const MAX_NETWORK_ERROR_BYTES = 8 * 1024;
export const MAX_NETWORK_CAPTURE_TOTAL_BYTES = 2 * 1024 * 1024;

export interface NetworkRequestEntry {
  requestId: string;
  ts: number;
  method: string;
  url: string;
  resourceType?: string;
  fromCache?: boolean;
  status?: number;
  statusText?: string;
  mimeType?: string;
  durationMs?: number;
  responseSize?: number;
  error?: string;
  ended: boolean;
}

interface RequestWillBeSent {
  requestId: string;
  request: { url: string; method: string; headers?: Record<string, string> };
  type?: string;
  timestamp: number;
  wallTime?: number;
}

interface ResponseReceived {
  requestId: string;
  response: {
    status: number;
    statusText: string;
    mimeType: string;
    fromDiskCache?: boolean;
    fromServiceWorker?: boolean;
    encodedDataLength?: number;
  };
  timestamp: number;
  type?: string;
}

interface LoadingFinished {
  requestId: string;
  timestamp: number;
  encodedDataLength?: number;
}

interface LoadingFailed {
  requestId: string;
  timestamp: number;
  errorText?: string;
  canceled?: boolean;
}

/**
 * Captures CDP Network events into a per-tab ring buffer. Lazily enabled
 * the first time the agent asks for network data, so non-MCP browsing has
 * zero overhead.
 */
export class NetworkCapture {
  private entries: NetworkRequestEntry[] = [];
  private byId = new Map<string, NetworkRequestEntry>();
  private unsubs: Array<() => void> = [];
  private cdp: CdpClient | null = null;
  private enablePromise: Promise<void> | null = null;
  private bindingGeneration = 0;
  private enabled = false;
  private startWallSeconds = 0;

  async enable(cdp: CdpClient): Promise<void> {
    if (this.enabled && this.cdp === cdp) return;
    if (this.cdp === cdp && this.enablePromise) {
      await this.enablePromise;
      return;
    }

    this.releaseTransport();
    const bindingGeneration = this.bindingGeneration;
    this.cdp = cdp;
    const enabling = this.enableOnClient(cdp, bindingGeneration);
    this.enablePromise = enabling;
    try {
      await enabling;
    } catch (error) {
      if (this.cdp === cdp && this.bindingGeneration === bindingGeneration) {
        this.releaseTransport();
      }
      throw error;
    } finally {
      if (this.enablePromise === enabling) this.enablePromise = null;
    }
  }

  private async enableOnClient(cdp: CdpClient, bindingGeneration: number): Promise<void> {
    await cdp.send("Network.enable");
    if (this.cdp !== cdp || this.bindingGeneration !== bindingGeneration) return;

    const unsubs = [
      cdp.on("Network.requestWillBeSent", (params) => {
        const p = params as RequestWillBeSent;
        if (this.startWallSeconds === 0 && typeof p.wallTime === "number") {
          this.startWallSeconds = p.wallTime - p.timestamp;
        }
        const entry: NetworkRequestEntry = {
          requestId: truncateUtf8(String(p.requestId ?? ""), MAX_NETWORK_REQUEST_ID_BYTES),
          ts: this.tsMs(p.timestamp, p.wallTime),
          method: truncateUtf8(String(p.request.method ?? ""), MAX_NETWORK_METHOD_BYTES),
          url: truncateUtf8(String(p.request.url ?? ""), MAX_NETWORK_URL_BYTES),
          ended: false,
          ...(p.type
            ? { resourceType: truncateUtf8(String(p.type), MAX_NETWORK_RESOURCE_TYPE_BYTES) }
            : {}),
        };
        this.push(entry);
      }),
      cdp.on("Network.responseReceived", (params) => {
        const p = params as ResponseReceived;
        const e = this.byId.get(
          truncateUtf8(String(p.requestId ?? ""), MAX_NETWORK_REQUEST_ID_BYTES),
        );
        if (!e) return;
        e.status = p.response.status;
        e.statusText = truncateUtf8(
          String(p.response.statusText ?? ""),
          MAX_NETWORK_STATUS_TEXT_BYTES,
        );
        e.mimeType = truncateUtf8(String(p.response.mimeType ?? ""), MAX_NETWORK_MIME_TYPE_BYTES);
        e.fromCache = Boolean(p.response.fromDiskCache || p.response.fromServiceWorker);
        if (typeof p.response.encodedDataLength === "number") {
          e.responseSize = p.response.encodedDataLength;
        }
        this.enforceBufferLimits();
      }),
      cdp.on("Network.loadingFinished", (params) => {
        const p = params as LoadingFinished;
        const e = this.byId.get(
          truncateUtf8(String(p.requestId ?? ""), MAX_NETWORK_REQUEST_ID_BYTES),
        );
        if (!e) return;
        e.ended = true;
        e.durationMs = this.tsMs(p.timestamp, undefined) - e.ts;
        if (typeof p.encodedDataLength === "number") {
          e.responseSize = p.encodedDataLength;
        }
      }),
      cdp.on("Network.loadingFailed", (params) => {
        const p = params as LoadingFailed;
        const e = this.byId.get(
          truncateUtf8(String(p.requestId ?? ""), MAX_NETWORK_REQUEST_ID_BYTES),
        );
        if (!e) return;
        e.ended = true;
        e.error = truncateUtf8(
          p.canceled ? "canceled" : String(p.errorText ?? "failed"),
          MAX_NETWORK_ERROR_BYTES,
        );
        e.durationMs = this.tsMs(p.timestamp, undefined) - e.ts;
        this.enforceBufferLimits();
      }),
    ];
    this.unsubs.push(...unsubs);
    this.enabled = true;
  }

  private tsMs(monotonicSec: number, wallSec?: number): number {
    if (typeof wallSec === "number" && wallSec > 0) return Math.round(wallSec * 1000);
    if (this.startWallSeconds > 0) {
      return Math.round((monotonicSec + this.startWallSeconds) * 1000);
    }
    return Math.round(monotonicSec * 1000);
  }

  private push(entry: NetworkRequestEntry): void {
    this.entries.push(entry);
    this.byId.set(entry.requestId, entry);
    this.enforceBufferLimits();
  }

  private enforceBufferLimits(): void {
    let totalBytes = this.entries.reduce((total, entry) => total + networkEntryBytes(entry), 0);
    while (
      this.entries.length > 0 &&
      (this.entries.length > NETWORK_BUFFER_SIZE || totalBytes > MAX_NETWORK_CAPTURE_TOTAL_BYTES)
    ) {
      const evicted = this.entries.shift();
      if (!evicted) break;
      totalBytes = Math.max(0, totalBytes - networkEntryBytes(evicted));
      if (this.byId.get(evicted.requestId) === evicted) {
        this.byId.delete(evicted.requestId);
      }
    }
  }

  list(options: { filter?: string; limit?: number } = {}): NetworkRequestEntry[] {
    const limit = Math.max(1, Math.min(NETWORK_BUFFER_SIZE, options.limit ?? 100));
    const filter = options.filter;
    let arr = this.entries;
    if (filter) {
      const lower = filter.toLowerCase();
      const asRegex = filter.startsWith("/") && filter.lastIndexOf("/") > 0;
      let re: RegExp | null = null;
      if (asRegex) {
        const last = filter.lastIndexOf("/");
        try {
          re = new RegExp(filter.slice(1, last), filter.slice(last + 1));
        } catch {
          re = null;
        }
      }
      arr = arr.filter((e) => (re ? re.test(e.url) : e.url.toLowerCase().includes(lower)));
    }
    return arr.slice(Math.max(0, arr.length - limit));
  }

  clear(): void {
    this.entries = [];
    this.byId.clear();
  }

  private releaseTransport(): void {
    this.bindingGeneration += 1;
    for (const u of this.unsubs) {
      try {
        u();
      } catch {}
    }
    this.unsubs = [];
    this.cdp = null;
    this.enablePromise = null;
    this.enabled = false;
    this.startWallSeconds = 0;
  }

  /** Drop references to a suspended webview's CDP client without losing history. */
  suspend(): void {
    this.releaseTransport();
  }

  dispose(): void {
    this.releaseTransport();
    this.entries = [];
    this.byId.clear();
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}

function networkEntryBytes(entry: NetworkRequestEntry): number {
  return utf8ByteLength(
    entry.requestId,
    entry.method,
    entry.url,
    entry.resourceType,
    entry.statusText,
    entry.mimeType,
    entry.error,
  );
}
