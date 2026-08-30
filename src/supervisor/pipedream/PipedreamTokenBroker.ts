export const PIPEDREAM_OAUTH_TOKEN_URL = "https://api.pipedream.com/v1/oauth/token";
export const PIPEDREAM_DEVELOPER_SCOPE = "connect:*";
export const PIPEDREAM_OAUTH_TOKEN_TIMEOUT_MS = 30_000;

const TOKEN_EXPIRY_SKEW_MS = 60_000;

export interface PipedreamTokenBrokerOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}

interface CachedAccessToken {
  readonly value: string;
  readonly expiresAtMs: number;
}

interface ExchangedAccessToken extends CachedAccessToken {}

/**
 * Exchanges developer credentials server-side and keeps access tokens out of
 * renderer and agent configuration. Concurrent callers share one refresh.
 */
export class PipedreamTokenBroker {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  #cached: CachedAccessToken | undefined;
  #inFlight: Promise<string> | undefined;
  #generation = 0;

  constructor(options: PipedreamTokenBrokerOptions) {
    this.#clientId = requireCredential(options.clientId);
    this.#clientSecret = requireCredential(options.clientSecret);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
  }

  getAccessToken(): Promise<string> {
    const cached = this.#cached;
    if (cached && cached.expiresAtMs - TOKEN_EXPIRY_SKEW_MS > this.#now()) {
      return Promise.resolve(cached.value);
    }
    if (this.#inFlight) return this.#inFlight;

    const generation = this.#generation;
    let request!: Promise<string>;
    request = this.#exchangeAccessToken()
      .then((token) => {
        if (generation === this.#generation) this.#cached = token;
        return token.value;
      })
      .finally(() => {
        if (this.#inFlight === request) this.#inFlight = undefined;
      });
    this.#inFlight = request;
    return request;
  }

  /** Drop a cached or in-flight generation after Pipedream rejects it. */
  invalidate(): void {
    this.#generation += 1;
    this.#cached = undefined;
    this.#inFlight = undefined;
  }

  async #exchangeAccessToken(): Promise<ExchangedAccessToken> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error("Pipedream authentication failed."));
      }, PIPEDREAM_OAUTH_TOKEN_TIMEOUT_MS);
      timeout.unref?.();
    });
    const beforeDeadline = <T>(operation: Promise<T>): Promise<T> =>
      Promise.race([operation, timedOut]);

    try {
      const response = await beforeDeadline(
        this.#fetch(PIPEDREAM_OAUTH_TOKEN_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            grant_type: "client_credentials",
            client_id: this.#clientId,
            client_secret: this.#clientSecret,
            scope: PIPEDREAM_DEVELOPER_SCOPE,
          }),
          signal: controller.signal,
        }),
      );

      if (!response.ok) {
        await beforeDeadline(response.body?.cancel() ?? Promise.resolve()).catch(() => undefined);
        throw new Error("Pipedream authentication failed.");
      }

      const payload = await beforeDeadline(response.json());
      if (!isRecord(payload)) throw new Error("Pipedream authentication failed.");

      const accessToken =
        typeof payload.access_token === "string" ? payload.access_token.trim() : undefined;
      const tokenType = typeof payload.token_type === "string" ? payload.token_type : undefined;
      const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : undefined;
      if (
        !accessToken ||
        tokenType?.toLowerCase() !== "bearer" ||
        !expiresIn ||
        !Number.isFinite(expiresIn) ||
        expiresIn <= 0
      ) {
        throw new Error("Pipedream authentication failed.");
      }

      return {
        value: accessToken,
        expiresAtMs: this.#now() + expiresIn * 1_000,
      };
    } catch {
      throw new Error("Pipedream authentication failed.");
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

function requireCredential(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("Pipedream credentials are incomplete.");
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
