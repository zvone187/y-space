import { describe, expect, it, vi } from "vitest";
import {
  PIPEDREAM_API_BASE_URL,
  PIPEDREAM_CONNECT_TOKEN_SCOPE,
  PIPEDREAM_CONNECT_TOKEN_TTL_SECONDS,
  PipedreamApiClient,
} from "./PipedreamApiClient";

const PROJECT_ID = "proj_Test123";
const EXTERNAL_USER_ID = "y-space-install-private-id";
const DEVELOPER_TOKEN = "developer-token-private";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeClient(fetchMock: typeof fetch): PipedreamApiClient {
  return new PipedreamApiClient({
    projectId: PROJECT_ID,
    environment: "development",
    externalUserId: EXTERNAL_USER_ID,
    getAccessToken: async () => DEVELOPER_TOKEN,
    fetch: fetchMock,
  });
}

function expectPinnedProjectHeaders(init: RequestInit | undefined): void {
  const headers = new Headers(init?.headers);
  expect(headers.get("authorization")).toBe(`Bearer ${DEVELOPER_TOKEN}`);
  expect(headers.get("x-pd-environment")).toBe("development");
}

describe("PipedreamApiClient", () => {
  it("discovers only action-capable apps through the fixed Connect API", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ data: [], page_info: { count: 0, total_count: 0 } }),
    );
    const client = makeClient(fetchMock);

    expect(PIPEDREAM_API_BASE_URL).toBe("https://api.pipedream.com/v1");
    await client.listApps({ query: "slack", cursor: "next-page", limit: 20 });

    const [input, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(input));
    expect(url.origin + url.pathname).toBe(`${PIPEDREAM_API_BASE_URL}/connect/apps`);
    expect(url.searchParams.get("q")).toBe("slack");
    expect(url.searchParams.get("after")).toBe("next-page");
    expect(url.searchParams.get("limit")).toBe("20");
    expect(url.searchParams.get("has_actions")).toBe("true");
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${DEVELOPER_TOKEN}`);
  });

  it("pins account identity and explicitly refuses credential retrieval", async () => {
    const accountCredential = "oauth-access-token-that-must-not-leak";
    const externalAccountId = "provider-private-account-id";
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        data: [
          {
            id: "apn_Account123",
            name: "Y Space Slack",
            external_id: externalAccountId,
            healthy: true,
            dead: false,
            created_at: "2026-08-27T12:00:00.000Z",
            error: `provider error containing ${accountCredential}`,
            credentials: { oauth_access_token: accountCredential },
            app: {
              id: "app_Slack123",
              name_slug: "slack",
              name: "Slack",
              img_src: "https://assets.pipedream.net/slack.png",
            },
          },
        ],
        page_info: { count: 1, total_count: 1 },
      }),
    );
    const client = makeClient(fetchMock);

    const result = await client.listAccounts({ appSlug: "slack" });
    const [input, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(input));

    expect(url.origin + url.pathname).toBe(
      `${PIPEDREAM_API_BASE_URL}/connect/${PROJECT_ID}/accounts`,
    );
    expect(url.searchParams.get("external_user_id")).toBe(EXTERNAL_USER_ID);
    expect(url.searchParams.get("app")).toBe("slack");
    expect(url.searchParams.get("include_credentials")).toBe("false");
    expectPinnedProjectHeaders(init);

    const serialized = JSON.stringify(result);
    expect(serialized).toContain("apn_Account123");
    expect(serialized).not.toContain(accountCredential);
    expect(serialized).not.toContain(externalAccountId);
    expect(serialized).not.toMatch(/credentials|external_id|oauth_access_token|provider error/i);
  });

  it("mints a short-lived account-only Connect token for the pinned user", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        token: "connect-token-private",
        connect_link_url: "https://pipedream.com/_static/connect.html?token=redacted",
        expires_at: "2026-08-27T12:10:00.000Z",
      }),
    );
    const client = makeClient(fetchMock);

    expect(PIPEDREAM_CONNECT_TOKEN_SCOPE).toBe("connect:accounts:read connect:accounts:write");
    expect(PIPEDREAM_CONNECT_TOKEN_TTL_SECONDS).toBe(600);
    await client.createConnectToken();

    const [input, init] = fetchMock.mock.calls[0]!;
    expect(String(input)).toBe(`${PIPEDREAM_API_BASE_URL}/connect/${PROJECT_ID}/tokens`);
    expect(init?.method).toBe("POST");
    expectPinnedProjectHeaders(init);
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({
      external_user_id: EXTERNAL_USER_ID,
      expires_in: 600,
      scope: "connect:accounts:read connect:accounts:write",
    });
  });

  it("disconnects only the selected account under the configured project", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const client = makeClient(fetchMock);

    await client.disconnectAccount("apn_Account123");

    const [input, init] = fetchMock.mock.calls[0]!;
    expect(String(input)).toBe(
      `${PIPEDREAM_API_BASE_URL}/connect/${PROJECT_ID}/accounts/apn_Account123`,
    );
    expect(init?.method).toBe("DELETE");
    expect(init?.body).toBeUndefined();
    expectPinnedProjectHeaders(init);
  });

  it("retrieves only the safe project display name from the fixed project endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        id: PROJECT_ID,
        name: "Y Space Integrations",
        app_name: "Private app metadata",
        support_email: "private@example.test",
      }),
    );
    const client = makeClient(fetchMock);

    await expect(client.getProject()).resolves.toEqual({ name: "Y Space Integrations" });
    const [input, init] = fetchMock.mock.calls[0]!;
    expect(String(input)).toBe(`${PIPEDREAM_API_BASE_URL}/connect/projects/${PROJECT_ID}`);
    expect(init?.method).toBe("GET");
    expectPinnedProjectHeaders(init);
  });
});
