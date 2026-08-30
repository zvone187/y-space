import { describe, expect, it, vi } from "vitest";
import {
  PIPEDREAM_DEVELOPER_SCOPE,
  PIPEDREAM_OAUTH_TOKEN_TIMEOUT_MS,
  PIPEDREAM_OAUTH_TOKEN_URL,
  PipedreamTokenBroker,
} from "./PipedreamTokenBroker";

const CLIENT_ID = "client-id-for-tests";
const CLIENT_SECRET = "client-secret-that-must-not-leak";

function tokenResponse(accessToken: string): Response {
  return new Response(
    JSON.stringify({ access_token: accessToken, token_type: "Bearer", expires_in: 3600 }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function makeBroker(fetchMock: typeof fetch): PipedreamTokenBroker {
  return new PipedreamTokenBroker({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    fetch: fetchMock,
    now: () => 1_800_000_000_000,
  });
}

describe("PipedreamTokenBroker", () => {
  it("uses the fixed OAuth endpoint and the least-privileged Connect scope", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => tokenResponse("developer-token"));
    const broker = makeBroker(fetchMock);

    expect(PIPEDREAM_OAUTH_TOKEN_URL).toBe("https://api.pipedream.com/v1/oauth/token");
    expect(PIPEDREAM_DEVELOPER_SCOPE).toBe("connect:*");
    expect(await broker.getAccessToken()).toBe("developer-token");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0]!;
    expect(String(input)).toBe(PIPEDREAM_OAUTH_TOKEN_URL);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: "connect:*",
    });
  });

  it("deduplicates concurrent refreshes and caches the resulting token", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const broker = makeBroker(fetchMock);

    const first = broker.getAccessToken();
    const second = broker.getAccessToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch(tokenResponse("shared-token"));
    expect(await Promise.all([first, second])).toEqual(["shared-token", "shared-token"]);
    expect(await broker.getAccessToken()).toBe("shared-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("invalidates a cached token after an upstream 401", async () => {
    let serial = 0;
    const fetchMock = vi.fn<typeof fetch>(async () => tokenResponse(`developer-token-${++serial}`));
    const broker = makeBroker(fetchMock);

    expect(await broker.getAccessToken()).toBe("developer-token-1");
    broker.invalidate();
    expect(await broker.getAccessToken()).toBe("developer-token-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("aborts a hung token exchange at the operation-local deadline", async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | null | undefined;
      const fetchMock = vi.fn<typeof fetch>(
        (_input, init) =>
          new Promise<Response>(() => {
            requestSignal = init?.signal;
          }),
      );
      const broker = makeBroker(fetchMock);

      const token = broker.getAccessToken();
      const outcome = token.then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      expect(requestSignal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(PIPEDREAM_OAUTH_TOKEN_TIMEOUT_MS);

      const result = await outcome;
      if (result.status !== "rejected") throw new Error("Expected token exchange to time out.");
      expect(result.error).toEqual(new Error("Pipedream authentication failed."));
      expect(requestSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the exchange deadline after either success or failure", async () => {
    vi.useFakeTimers();
    try {
      const successful = makeBroker(vi.fn<typeof fetch>(async () => tokenResponse("fast-token")));
      expect(await successful.getAccessToken()).toBe("fast-token");
      expect(vi.getTimerCount()).toBe(0);

      const failed = makeBroker(
        vi.fn<typeof fetch>(async () => {
          throw new Error("network unavailable");
        }),
      );
      await expect(failed.getAccessToken()).rejects.toThrow("Pipedream authentication failed.");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never copies credentials or provider response bodies into thrown errors", async () => {
    const upstreamToken = "upstream-token-that-must-not-leak";
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            error: "invalid_client",
            error_description: `rejected ${CLIENT_SECRET}; stale ${upstreamToken}`,
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
    );
    const broker = makeBroker(fetchMock);

    await broker.getAccessToken().then(
      () => expect.fail("expected token exchange to fail"),
      (error: unknown) => {
        const rendered = `${String(error)} ${JSON.stringify(error)}`;
        expect(rendered).not.toContain(CLIENT_ID);
        expect(rendered).not.toContain(CLIENT_SECRET);
        expect(rendered).not.toContain(upstreamToken);
      },
    );
  });
});
