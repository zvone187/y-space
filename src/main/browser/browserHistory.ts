import { dbGetState, dbSetState } from "../db";
import { stripScheme } from "@/shared/url";
import { truncateUtf8, utf8ByteLength } from "./boundedText";

const HISTORY_KEY = "browser-history-v1";
const MAX_ENTRIES = 2000;
const MAX_HISTORY_URL_BYTES = 64 * 1024;
const MAX_HISTORY_TITLE_BYTES = 8 * 1024;
export const MAX_BROWSER_HISTORY_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_BROWSER_HISTORY_PERSISTED_BYTES = 8 * 1024 * 1024;
const PERSIST_DEBOUNCE_MS = 1000;
const SUGGEST_TIMEOUT_MS = 2500;

export interface BrowserHistoryEntry {
  url: string;
  title: string;
  visitCount: number;
  lastVisitedAt: number;
}

/**
 * Persistent visited-URL history backing the address-bar omnibox. Stored as a
 * JSON blob in app state (same mechanism the tab list uses), keyed by URL so a
 * revisit bumps frequency/recency instead of duplicating.
 */
export class BrowserHistoryStore {
  private entries = new Map<string, BrowserHistoryEntry>();
  private loaded = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = dbGetState(HISTORY_KEY);
      if (!raw) return;
      if (Buffer.byteLength(raw, "utf8") > MAX_BROWSER_HISTORY_PERSISTED_BYTES) return;
      const arr = JSON.parse(raw) as BrowserHistoryEntry[];
      if (!Array.isArray(arr)) return;
      for (const e of arr) {
        if (e && typeof e.url === "string" && typeof e.title === "string") {
          const url = truncateUtf8(e.url, MAX_HISTORY_URL_BYTES);
          if (!/^https?:\/\//i.test(url)) continue;
          this.entries.set(url, {
            url,
            title: truncateUtf8(e.title || url, MAX_HISTORY_TITLE_BYTES),
            visitCount:
              typeof e.visitCount === "number" && Number.isFinite(e.visitCount)
                ? Math.max(1, Math.floor(e.visitCount))
                : 1,
            lastVisitedAt:
              typeof e.lastVisitedAt === "number" && Number.isFinite(e.lastVisitedAt)
                ? e.lastVisitedAt
                : 0,
          });
        }
      }
      this.prune();
    } catch {}
  }

  record(url: string, title: string, now: number): void {
    if (!/^https?:\/\//i.test(url)) return;
    this.load();
    const boundedUrl = truncateUtf8(url, MAX_HISTORY_URL_BYTES);
    const boundedTitle = truncateUtf8(title || boundedUrl, MAX_HISTORY_TITLE_BYTES);
    const existing = this.entries.get(boundedUrl);
    if (existing) {
      existing.visitCount += 1;
      existing.lastVisitedAt = now;
      if (title) existing.title = boundedTitle;
    } else {
      this.entries.set(boundedUrl, {
        url: boundedUrl,
        title: boundedTitle,
        visitCount: 1,
        lastVisitedAt: now,
      });
    }
    this.prune();
    this.schedulePersist();
  }

  query(query: string, limit: number): BrowserHistoryEntry[] {
    this.load();
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const matched: Array<{ entry: BrowserHistoryEntry; score: number }> = [];
    for (const entry of this.entries.values()) {
      const url = entry.url.toLowerCase();
      const title = entry.title.toLowerCase();
      const urlIdx = url.indexOf(q);
      const titleIdx = title.indexOf(q);
      if (urlIdx === -1 && titleIdx === -1) continue;
      // Prefix match on the URL (after the scheme) ranks highest, then frequency
      // and recency. lastVisitedAt is a ms timestamp; scale it down so it acts
      // as a tiebreaker rather than dominating the visit-count signal.
      const startsWith = stripScheme(url).startsWith(q) || url.startsWith(q);
      const score =
        (startsWith ? 1000 : 0) + entry.visitCount * 10 + entry.lastVisitedAt / 1_000_000_000;
      matched.push({ entry, score });
    }
    matched.sort((a, b) => b.score - a.score);
    return matched.slice(0, limit).map((m) => m.entry);
  }

  recent(limit: number): BrowserHistoryEntry[] {
    this.load();
    return [...this.entries.values()]
      .sort((a, b) => b.lastVisitedAt - a.lastVisitedAt)
      .slice(0, limit);
  }

  clear(): void {
    this.loaded = true;
    this.entries.clear();
    this.schedulePersist();
  }

  private prune(): void {
    const sorted = [...this.entries.values()].sort((a, b) => a.lastVisitedAt - b.lastVisitedAt);
    let totalBytes = sorted.reduce((total, entry) => total + historyEntryBytes(entry), 0);
    let index = 0;
    while (
      index < sorted.length &&
      (this.entries.size > MAX_ENTRIES || totalBytes > MAX_BROWSER_HISTORY_TOTAL_BYTES)
    ) {
      const victim = sorted[index++];
      if (!victim || !this.entries.delete(victim.url)) continue;
      totalBytes = Math.max(0, totalBytes - historyEntryBytes(victim));
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      try {
        dbSetState(HISTORY_KEY, JSON.stringify([...this.entries.values()]));
      } catch {}
    }, PERSIST_DEBOUNCE_MS);
  }
}

function historyEntryBytes(entry: BrowserHistoryEntry): number {
  return utf8ByteLength(entry.url, entry.title);
}

/**
 * Fetch search-engine autocomplete suggestions from DuckDuckGo's `ac` endpoint.
 * Runs in the main process (no CORS), returns [] on any failure/timeout so the
 * omnibox degrades gracefully to history-only suggestions.
 */
export async function fetchSearchSuggestions(query: string, userAgent: string): Promise<string[]> {
  const q = query.trim();
  if (!q) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUGGEST_TIMEOUT_MS);
  try {
    const res = await fetch(`https://duckduckgo.com/ac/?q=${encodeURIComponent(q)}&type=list`, {
      signal: controller.signal,
      headers: { "User-Agent": userAgent, Accept: "application/json" },
    });
    if (!res.ok) return [];
    const data: unknown = await res.json();
    // `type=list` → ["query", ["s1", "s2", ...]]; default → [{ phrase }, ...].
    if (Array.isArray(data)) {
      if (Array.isArray(data[1])) {
        return data[1].filter((s): s is string => typeof s === "string");
      }
      return data
        .map((item) =>
          typeof item === "string"
            ? item
            : item && typeof (item as { phrase?: unknown }).phrase === "string"
              ? (item as { phrase: string }).phrase
              : null,
        )
        .filter((s): s is string => s !== null);
    }
    return [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
