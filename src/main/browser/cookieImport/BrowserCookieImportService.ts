import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import type { Cookies, CookiesSetDetails } from "electron";
import { mapImportedCookie } from "./cookieMapper";
import {
  cookieImportCommitResultPayloadSchema,
  cookieImportPreviewResultPayloadSchema,
  type CookieImportBrowserFamily,
  type CookieImportDomainSummary,
  type CookieImportWireCookie,
  validateCookieImportTargetUrls,
  COOKIE_IMPORT_MAX_PAYLOAD_BYTES,
} from "./protocol";
import { parseCookieImportFile } from "./cookieFileParser";
import type { LocalBrowserProfileInfo } from "./localBrowserProfiles";

const IMPORT_SESSION_TTL_MS = 5 * 60 * 1000;

export interface CookieImportRendererSource {
  sourceId: string;
  label: string;
  browserFamily: CookieImportBrowserFamily;
  extensionVersion: string;
  pairedAt: number;
  connected: boolean;
}

export interface CookieImportActiveRequest {
  requestId: string;
  sourceId: string;
  sourceKind: "extension" | "file" | "local-profile";
  sourceLabel?: string;
  status: "requesting-preview" | "ready" | "committing" | "completed" | "cancelled" | "failed";
  targetUrls: string[];
  domains: CookieImportDomainSummary[];
  expiresAt: number;
  unscopedUnsupportedCount?: number;
  importedCount?: number;
  skippedCount?: number;
  error?: string;
}

export interface CookieImportRendererState {
  sources: CookieImportRendererSource[];
  localProfiles: LocalBrowserProfileInfo[];
  activeRequest: CookieImportActiveRequest | null;
}

export interface CookieImportBridge {
  requestPreview(input: {
    requestId: string;
    sourceId: string;
    targetUrls: string[];
    expiresAt: number;
  }): Promise<unknown>;
  requestCommit(input: {
    requestId: string;
    sourceId: string;
    targetUrls: string[];
    selectedDomains: string[];
    expiresAt: number;
  }): Promise<unknown>;
  cancel(input: { requestId: string; sourceId: string }): Promise<void>;
}

interface CookieSession {
  cookies: Pick<Cookies, "get" | "set" | "flushStore">;
}

export interface BrowserCookieImportServiceOptions {
  session: CookieSession;
  bridge: CookieImportBridge;
  emit(state: CookieImportRendererState): void;
  listSources?(): CookieImportRendererSource[];
  listLocalProfiles?(): LocalBrowserProfileInfo[];
  readLocalProfile?(input: {
    sourceId: string;
    targetUrls: string[];
  }): Promise<{ cookies: CookieImportWireCookie[]; invalidCount: number }>;
  now?(): number;
  randomId?(): string;
}

export interface CookieImportCompletion {
  requestId: string;
  importedCount: number;
  skippedCount: number;
  skippedByReason: Record<string, number>;
  flushFailed?: boolean;
}

function normalizeDomain(domain: string): string {
  return domain.trim().replace(/^\.+/, "").toLowerCase();
}

function isSelectedCookie(cookie: CookieImportWireCookie, selectedDomains: Set<string>): boolean {
  return selectedDomains.has(normalizeDomain(cookie.domain));
}

function summarizeCookies(cookies: readonly CookieImportWireCookie[]): CookieImportDomainSummary[] {
  const counts = new Map<string, number>();
  for (const cookie of cookies) counts.set(cookie.domain, (counts.get(cookie.domain) ?? 0) + 1);
  return [...counts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([domain, cookieCount]) => ({ domain, cookieCount, unsupportedCount: 0 }));
}

export class BrowserCookieImportService {
  private activeRequest: CookieImportActiveRequest | null = null;
  private activeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly fileCookies = new Map<
    string,
    { cookies: CookieImportWireCookie[]; invalidCount: number }
  >();
  private readonly now: () => number;
  private readonly randomId: () => string;

  constructor(private readonly options: BrowserCookieImportServiceOptions) {
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? randomUUID;
  }

  getState(): CookieImportRendererState {
    return {
      sources: this.options.listSources?.().map((source) => ({ ...source })) ?? [],
      localProfiles: this.options.listLocalProfiles?.().map((profile) => ({ ...profile })) ?? [],
      activeRequest: this.activeRequest
        ? {
            ...this.activeRequest,
            targetUrls: [...this.activeRequest.targetUrls],
            domains: this.activeRequest.domains.map((domain) => ({ ...domain })),
          }
        : null,
    };
  }

  async previewLocal(input: {
    sourceId: string;
    targetUrls: string[];
  }): Promise<CookieImportActiveRequest> {
    this.ensureNoBlockingRequest();
    const targetUrls = validateCookieImportTargetUrls(input.targetUrls);
    const profile = this.options
      .listLocalProfiles?.()
      .find((candidate) => candidate.sourceId === input.sourceId);
    if (!profile || !this.options.readLocalProfile) {
      throw new Error("Installed browser profile is unavailable.");
    }
    const requestId = this.randomId();
    const expiresAt = this.now() + IMPORT_SESSION_TTL_MS;
    this.activeRequest = {
      requestId,
      sourceId: input.sourceId,
      sourceKind: "local-profile",
      sourceLabel: profile.label,
      status: "requesting-preview",
      targetUrls,
      domains: [],
      expiresAt,
    };
    this.emitState();

    try {
      const result = await this.options.readLocalProfile({
        sourceId: input.sourceId,
        targetUrls,
      });
      this.fileCookies.set(requestId, {
        cookies: result.cookies,
        invalidCount: result.invalidCount,
      });
      this.activeRequest = {
        requestId,
        sourceId: input.sourceId,
        sourceKind: "local-profile",
        sourceLabel: profile.label,
        status: "ready",
        targetUrls,
        domains: summarizeCookies(result.cookies),
        expiresAt,
        ...(result.invalidCount > 0 ? { unscopedUnsupportedCount: result.invalidCount } : {}),
      };
      this.scheduleExpiry(requestId, expiresAt);
      this.emitState();
      return this.getRequiredActiveRequest();
    } catch {
      this.clearRequestResources(requestId);
      this.failActiveRequest("Unable to preview cookies.");
      throw new Error("Unable to preview cookies from the selected browser profile.");
    }
  }

  async preview(input: {
    sourceId: string;
    targetUrls: string[];
  }): Promise<CookieImportActiveRequest> {
    this.ensureNoBlockingRequest();
    const targetUrls = validateCookieImportTargetUrls(input.targetUrls);
    const requestId = this.randomId();
    const expiresAt = this.now() + IMPORT_SESSION_TTL_MS;
    this.activeRequest = {
      requestId,
      sourceId: input.sourceId,
      sourceKind: "extension",
      status: "requesting-preview",
      targetUrls,
      domains: [],
      expiresAt,
    };
    this.emitState();

    try {
      const rawResult = await this.options.bridge.requestPreview({
        requestId,
        sourceId: input.sourceId,
        targetUrls,
        expiresAt,
      });
      const result = cookieImportPreviewResultPayloadSchema.parse(rawResult);
      if (result.requestId !== requestId) throw new Error("Cookie preview request ID mismatch.");
      this.activeRequest = {
        requestId,
        sourceId: input.sourceId,
        sourceKind: "extension",
        status: "ready",
        targetUrls,
        domains: result.domains,
        expiresAt,
      };
      this.scheduleExpiry(requestId, expiresAt);
      this.emitState();
      return this.getRequiredActiveRequest();
    } catch {
      this.failActiveRequest("Unable to preview cookies.");
      throw new Error("Unable to preview cookies from the selected browser.");
    }
  }

  previewFile(input: {
    fileName: string;
    serialized: string;
    targetUrls: string[];
  }): CookieImportActiveRequest {
    this.ensureNoBlockingRequest();
    if (Buffer.byteLength(input.serialized, "utf8") > COOKIE_IMPORT_MAX_PAYLOAD_BYTES) {
      throw new Error("Cookie file exceeds the 4 MiB import limit.");
    }
    const targetUrls = validateCookieImportTargetUrls(input.targetUrls);
    const parsed = parseCookieImportFile(input.serialized, input.fileName);
    const requestId = this.randomId();
    const expiresAt = this.now() + IMPORT_SESSION_TTL_MS;
    this.fileCookies.set(requestId, { cookies: parsed.cookies, invalidCount: parsed.invalidCount });
    this.activeRequest = {
      requestId,
      sourceId: requestId,
      sourceKind: "file",
      sourceLabel: input.fileName.slice(0, 120),
      status: "ready",
      targetUrls,
      domains: parsed.domains,
      expiresAt,
      ...(parsed.invalidCount > 0 ? { unscopedUnsupportedCount: parsed.invalidCount } : {}),
    };
    this.scheduleExpiry(requestId, expiresAt);
    this.emitState();
    return this.getRequiredActiveRequest();
  }

  async commit(input: {
    requestId: string;
    selectedDomains: string[];
  }): Promise<CookieImportCompletion> {
    const request = this.getRequiredActiveRequest();
    if (request.requestId !== input.requestId || request.status !== "ready") {
      throw new Error("Cookie import request is not ready to commit.");
    }
    if (this.now() >= request.expiresAt) {
      await this.cancel(request.requestId);
      throw new Error("Cookie import request has expired.");
    }
    const selectedDomains = new Set(input.selectedDomains.map(normalizeDomain).filter(Boolean));
    const previewDomains = new Set(request.domains.map(({ domain }) => normalizeDomain(domain)));
    for (const domain of selectedDomains) {
      if (!previewDomains.has(domain)) throw new Error("Cookie domain was not present in preview.");
    }
    if (this.activeTimer) clearTimeout(this.activeTimer);
    this.activeTimer = null;
    this.activeRequest = { ...request, status: "committing" };
    this.emitState();

    try {
      const cachedFile = this.fileCookies.get(request.requestId);
      const rawResult = cachedFile
        ? { requestId: request.requestId, cookies: cachedFile.cookies }
        : await this.options.bridge.requestCommit({
            requestId: request.requestId,
            sourceId: request.sourceId,
            targetUrls: request.targetUrls,
            selectedDomains: [...selectedDomains],
            expiresAt: request.expiresAt,
          });
      const result = cookieImportCommitResultPayloadSchema.parse(rawResult);
      if (result.requestId !== request.requestId)
        throw new Error("Cookie commit request ID mismatch.");

      let importedCount = 0;
      let skippedCount = cachedFile?.invalidCount ?? 0;
      const skippedByReason: Record<string, number> = {};
      if (cachedFile?.invalidCount) skippedByReason["invalid-file-entry"] = cachedFile.invalidCount;
      const skip = (reason: string): void => {
        skippedCount += 1;
        skippedByReason[reason] = (skippedByReason[reason] ?? 0) + 1;
      };

      const deduplicated = new Map<string, CookieImportWireCookie>();
      for (const cookie of result.cookies) {
        const identity = JSON.stringify([
          cookie.name,
          normalizeDomain(cookie.domain),
          cookie.hostOnly,
          cookie.path,
        ]);
        if (deduplicated.has(identity)) skip("duplicate");
        deduplicated.set(identity, cookie);
      }

      for (const cookie of deduplicated.values()) {
        if (!isSelectedCookie(cookie, selectedDomains)) {
          skip("not-selected");
          continue;
        }
        const mapped = mapImportedCookie({
          cookie,
          targetUrls: request.targetUrls,
          nowSeconds: this.now() / 1000,
        });
        if (!mapped.ok) {
          skip(mapped.reason);
          continue;
        }
        try {
          await this.setCookie(mapped.details);
          importedCount += 1;
        } catch {
          skip("set-failed");
        }
      }
      let flushFailed = false;
      if (importedCount > 0) {
        try {
          await this.options.session.cookies.flushStore();
        } catch {
          flushFailed = true;
        }
      }

      const completion: CookieImportCompletion = {
        requestId: request.requestId,
        importedCount,
        skippedCount,
        skippedByReason,
        ...(flushFailed ? { flushFailed: true } : {}),
      };
      this.clearRequestResources(request.requestId);
      this.activeRequest = { ...request, status: "completed", importedCount, skippedCount };
      this.emitState();
      return completion;
    } catch {
      this.clearRequestResources(request.requestId);
      this.failActiveRequest("Unable to import cookies.");
      throw new Error("Unable to import cookies from the selected browser.");
    }
  }

  async cancel(requestId: string): Promise<void> {
    const request = this.activeRequest;
    if (!request || request.requestId !== requestId) return;
    if (request.sourceKind === "extension") {
      await this.options.bridge.cancel({ requestId, sourceId: request.sourceId });
    }
    this.clearRequestResources(requestId);
    this.activeRequest = { ...request, status: "cancelled" };
    this.emitState();
  }

  private setCookie(details: CookiesSetDetails): Promise<void> {
    return this.options.session.cookies.set(details);
  }

  private getRequiredActiveRequest(): CookieImportActiveRequest {
    if (!this.activeRequest) throw new Error("Cookie import request is not active.");
    return {
      ...this.activeRequest,
      targetUrls: [...this.activeRequest.targetUrls],
      domains: this.activeRequest.domains.map((domain) => ({ ...domain })),
    };
  }

  private failActiveRequest(error: string): void {
    if (this.activeRequest) this.activeRequest = { ...this.activeRequest, status: "failed", error };
    this.emitState();
  }

  private ensureNoBlockingRequest(): void {
    const request = this.activeRequest;
    if (
      request &&
      request.status !== "completed" &&
      request.status !== "cancelled" &&
      request.status !== "failed"
    ) {
      throw new Error("Finish or cancel the active cookie import first.");
    }
    if (request) this.clearRequestResources(request.requestId);
  }

  private scheduleExpiry(requestId: string, expiresAt: number): void {
    if (this.activeTimer) clearTimeout(this.activeTimer);
    this.activeTimer = setTimeout(
      () => {
        const request = this.activeRequest;
        if (!request || request.requestId !== requestId) return;
        void this.cancel(requestId).catch(() => {
          this.clearRequestResources(requestId);
          this.activeRequest = { ...request, status: "cancelled" };
          this.emitState();
        });
      },
      Math.max(0, expiresAt - this.now()),
    );
  }

  private clearRequestResources(requestId: string): void {
    if (this.activeTimer) clearTimeout(this.activeTimer);
    this.activeTimer = null;
    this.fileCookies.delete(requestId);
  }

  private emitState(): void {
    this.options.emit(this.getState());
  }
}
