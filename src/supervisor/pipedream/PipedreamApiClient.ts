import {
  parsePipedreamAppSlug,
  type PipedreamAppSummary,
  type PipedreamEnvironment,
} from "@/shared/contracts/pipedream";

export const PIPEDREAM_API_BASE_URL = "https://api.pipedream.com/v1";
export const PIPEDREAM_API_OPERATION_TIMEOUT_MS = 30_000;
export const PIPEDREAM_CONNECT_TOKEN_SCOPE = "connect:accounts:read connect:accounts:write";
export const PIPEDREAM_CONNECT_TOKEN_TTL_SECONDS = 600;

const PROJECT_ID_PATTERN = /^proj_[a-zA-Z0-9]+$/;
const ACCOUNT_ID_PATTERN = /^apn_[a-zA-Z0-9]+$/;

export interface PipedreamApiClientOptions {
  readonly projectId: string;
  readonly environment: PipedreamEnvironment;
  readonly externalUserId: string;
  readonly getAccessToken: () => Promise<string>;
  readonly invalidateAccessToken?: () => void;
  readonly fetch?: typeof globalThis.fetch;
}

export interface PipedreamListAppsInput {
  readonly query?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface PipedreamListAccountsInput {
  readonly appSlug?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface PipedreamConnectRedirects {
  readonly successRedirectUrl: string;
  readonly errorRedirectUrl: string;
}

export interface PipedreamPageInfo {
  readonly nextCursor?: string;
  readonly totalCount: number;
}

export interface PipedreamListAppsResult extends PipedreamPageInfo {
  readonly apps: readonly PipedreamAppSummary[];
}

export interface PipedreamRemoteAccountSummary {
  readonly id: string;
  readonly name: string;
  readonly healthy: boolean;
  readonly connectedAt: string;
  readonly app: PipedreamAppSummary;
}

export interface PipedreamListAccountsResult extends PipedreamPageInfo {
  readonly accounts: readonly PipedreamRemoteAccountSummary[];
}

export interface PipedreamConnectTokenResult {
  /** A short-lived, one-use URL. Keep it transient and never persist it. */
  readonly connectLinkUrl: string;
  readonly expiresAt: string;
}

export interface PipedreamProjectSummary {
  readonly name: string;
}

/** Fixed-surface Pipedream Connect client; callers cannot supply URLs or auth headers. */
export class PipedreamApiClient {
  readonly #projectId: string;
  readonly #environment: PipedreamEnvironment;
  readonly #externalUserId: string;
  readonly #getAccessToken: () => Promise<string>;
  readonly #invalidateAccessToken: (() => void) | undefined;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: PipedreamApiClientOptions) {
    this.#projectId = requirePattern(options.projectId, PROJECT_ID_PATTERN, "project id");
    this.#environment = requireEnvironment(options.environment);
    this.#externalUserId = requireExternalUserId(options.externalUserId);
    this.#getAccessToken = options.getAccessToken;
    this.#invalidateAccessToken = options.invalidateAccessToken;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async listApps(input: PipedreamListAppsInput = {}): Promise<PipedreamListAppsResult> {
    const url = new URL(`${PIPEDREAM_API_BASE_URL}/connect/apps`);
    if (input.query !== undefined) url.searchParams.set("q", requireQuery(input.query));
    if (input.cursor !== undefined) url.searchParams.set("after", requireCursor(input.cursor));
    if (input.limit !== undefined) url.searchParams.set("limit", String(requireLimit(input.limit)));

    const payload = await this.#requestJson(url, "GET");
    const apps = readData(payload).flatMap((item) => {
      const app = mapAppSummary(item);
      return app ? [app] : [];
    });
    return withPageInfo({ apps }, payload);
  }

  async listAccounts(input: PipedreamListAccountsInput = {}): Promise<PipedreamListAccountsResult> {
    const url = new URL(`${PIPEDREAM_API_BASE_URL}/connect/${this.#projectId}/accounts`);
    url.searchParams.set("external_user_id", this.#externalUserId);
    url.searchParams.set("include_credentials", "false");
    if (input.appSlug !== undefined) {
      url.searchParams.set("app", requireAppSlug(input.appSlug));
    }
    if (input.cursor !== undefined) url.searchParams.set("after", requireCursor(input.cursor));
    if (input.limit !== undefined) url.searchParams.set("limit", String(requireLimit(input.limit)));

    const payload = await this.#requestJson(url, "GET");
    const accounts = readData(payload).flatMap((item) => {
      const account = mapAccountSummary(item);
      return account ? [account] : [];
    });
    return withPageInfo({ accounts }, payload);
  }

  async createConnectToken(
    redirects: PipedreamConnectRedirects,
  ): Promise<PipedreamConnectTokenResult> {
    const url = new URL(`${PIPEDREAM_API_BASE_URL}/connect/${this.#projectId}/tokens`);
    const payload = await this.#requestJson(url, "POST", {
      allow_progressive_scopes: true,
      external_user_id: this.#externalUserId,
      expires_in: PIPEDREAM_CONNECT_TOKEN_TTL_SECONDS,
      scope: PIPEDREAM_CONNECT_TOKEN_SCOPE,
      success_redirect_uri: redirects.successRedirectUrl,
      error_redirect_uri: redirects.errorRedirectUrl,
    });
    if (!isRecord(payload)) throw new Error("Pipedream request returned an invalid response.");

    const connectLinkUrl = readTrustedConnectLink(payload.connect_link_url);
    const expiresAt = readIsoDate(payload.expires_at);
    if (!connectLinkUrl || !expiresAt) {
      throw new Error("Pipedream request returned an invalid response.");
    }
    return { connectLinkUrl, expiresAt };
  }

  async getProject(): Promise<PipedreamProjectSummary> {
    const url = new URL(`${PIPEDREAM_API_BASE_URL}/connect/projects/${this.#projectId}`);
    const payload = await this.#requestJson(url, "GET");
    if (!isRecord(payload) || payload.id !== this.#projectId) {
      throw new Error("Pipedream request returned an invalid response.");
    }
    const name = readNonEmptyString(payload.name, 200);
    if (!name) throw new Error("Pipedream request returned an invalid response.");
    return { name };
  }

  async disconnectAccount(accountId: string): Promise<void> {
    const safeAccountId = requirePattern(accountId, ACCOUNT_ID_PATTERN, "account id");
    const url = new URL(
      `${PIPEDREAM_API_BASE_URL}/connect/${this.#projectId}/accounts/${safeAccountId}`,
    );
    await this.#request(url, "DELETE");
  }

  async #requestJson(url: URL, method: "GET" | "POST", body?: unknown): Promise<unknown> {
    return this.#withOperationTimeout(async (signal) => {
      const response = await this.#sendRequest(url, method, signal, body);
      try {
        return await response.json();
      } catch {
        throw new Error("Pipedream request returned an invalid response.");
      }
    });
  }

  async #request(url: URL, method: "GET" | "POST" | "DELETE", body?: unknown): Promise<void> {
    await this.#withOperationTimeout(async (signal) => {
      const response = await this.#sendRequest(url, method, signal, body);
      await response.body?.cancel().catch(() => undefined);
    });
  }

  async #sendRequest(
    url: URL,
    method: "GET" | "POST" | "DELETE",
    signal: AbortSignal,
    body?: unknown,
  ): Promise<Response> {
    let accessToken: string;
    try {
      accessToken = (await this.#getAccessToken()).trim();
    } catch {
      throw new Error("Pipedream request failed.");
    }
    if (!accessToken) throw new Error("Pipedream request failed.");

    const headers = new Headers({
      authorization: `Bearer ${accessToken}`,
      "x-pd-environment": this.#environment,
    });
    const init: RequestInit = { method, headers, signal };
    if (body !== undefined) {
      headers.set("content-type", "application/json");
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await this.#fetch(url, init);
    } catch {
      throw new Error("Pipedream request failed.");
    }
    if (!response.ok) {
      if (response.status === 401) this.#invalidateAccessToken?.();
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Pipedream request failed (HTTP ${response.status}).`);
    }
    return response;
  }

  async #withOperationTimeout<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error("Pipedream request failed."));
      }, PIPEDREAM_API_OPERATION_TIMEOUT_MS);
      timeout.unref?.();
    });

    try {
      return await Promise.race([operation(controller.signal), timedOut]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}

function mapAppSummary(value: unknown): PipedreamAppSummary | undefined {
  if (!isRecord(value)) return undefined;
  const id = readPattern(value.id, /^app_[a-zA-Z0-9]+$/);
  const slug = parsePipedreamAppSlug(value.name_slug);
  const name = readNonEmptyString(value.name, 200);
  if (!id || !slug || !name) return undefined;
  const iconUrl = readHttpsUrl(value.img_src);
  return { id, slug, name, ...(iconUrl ? { iconUrl } : {}) };
}

function mapAccountSummary(value: unknown): PipedreamRemoteAccountSummary | undefined {
  if (!isRecord(value)) return undefined;
  const id = readPattern(value.id, ACCOUNT_ID_PATTERN);
  const app = mapAppSummary(value.app);
  const connectedAt = readIsoDate(value.created_at);
  if (!id || !app || !connectedAt) return undefined;
  const name = readNonEmptyString(value.name, 200) ?? app.name;
  return {
    id,
    name,
    healthy: value.healthy === true && value.dead !== true,
    connectedAt,
    app,
  };
}

function withPageInfo<T extends object>(value: T, payload: unknown): T & PipedreamPageInfo {
  const pageInfo = isRecord(payload) && isRecord(payload.page_info) ? payload.page_info : undefined;
  const nextCursor = pageInfo ? readNonEmptyString(pageInfo.end_cursor, 2_048) : undefined;
  const totalCount =
    pageInfo && typeof pageInfo.total_count === "number" && Number.isFinite(pageInfo.total_count)
      ? Math.max(0, Math.trunc(pageInfo.total_count))
      : 0;
  return { ...value, totalCount, ...(nextCursor ? { nextCursor } : {}) };
}

function readData(payload: unknown): readonly unknown[] {
  return isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
}

function readTrustedConnectLink(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    const trustedHost = url.hostname === "pipedream.com" || url.hostname.endsWith(".pipedream.com");
    return url.protocol === "https:" && trustedHost ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function readHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function readIsoDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return undefined;
  return value;
}

function readPattern(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

function readNonEmptyString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : undefined;
}

function requirePattern(value: string, pattern: RegExp, label: string): string {
  const normalized = value.trim();
  if (!pattern.test(normalized)) throw new Error(`Invalid Pipedream ${label}.`);
  return normalized;
}

function requireAppSlug(value: string): string {
  const slug = parsePipedreamAppSlug(value);
  if (!slug) throw new Error("Invalid Pipedream app slug.");
  return slug;
}

function requireExternalUserId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 250)
    throw new Error("Invalid Pipedream external user id.");
  return normalized;
}

function requireEnvironment(value: string): PipedreamEnvironment {
  if (value !== "development" && value !== "production") {
    throw new Error("Invalid Pipedream environment.");
  }
  return value;
}

function requireQuery(value: string): string {
  const normalized = value.trim();
  if (normalized.length > 200) throw new Error("Invalid Pipedream app query.");
  return normalized;
}

function requireCursor(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 2_048) throw new Error("Invalid Pipedream cursor.");
  return normalized;
}

function requireLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("Invalid Pipedream result limit.");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
