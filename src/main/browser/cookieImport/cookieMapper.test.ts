import { describe, expect, it } from "vitest";

interface WireCookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "unspecified" | "no_restriction" | "lax" | "strict";
  session: boolean;
  expirationDate?: number;
  partitionKey?: { topLevelSite: string };
}

type MappingResult = { ok: true; details: Record<string, unknown> } | { ok: false; reason: string };

interface CookieMapperModule {
  mapImportedCookie(input: {
    cookie: WireCookie;
    targetUrls: string[];
    nowSeconds?: number;
  }): MappingResult;
}

async function loadMapper(): Promise<CookieMapperModule> {
  const modulePath = "./cookieMapper";
  return (await import(modulePath)) as CookieMapperModule;
}

const baseCookie = (overrides: Partial<WireCookie> = {}): WireCookie => ({
  name: "session",
  value: "raw-secret",
  domain: "app.example.com",
  hostOnly: true,
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "lax",
  session: true,
  ...overrides,
});

describe("mapImportedCookie", () => {
  it("maps a host-only cookie without broadening it to a Domain cookie", async () => {
    const { mapImportedCookie } = await loadMapper();
    const result = mapImportedCookie({
      cookie: baseCookie(),
      targetUrls: ["https://app.example.com/account"],
    });

    expect(result).toEqual({
      ok: true,
      details: {
        url: "https://app.example.com/account",
        name: "session",
        value: "raw-secret",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "lax",
      },
    });
    if (!result.ok) throw new Error("expected host-only cookie to map");
    expect(result.details).not.toHaveProperty("domain");
  });

  it("maps a valid parent-domain cookie using dot-boundary matching", async () => {
    const { mapImportedCookie } = await loadMapper();
    const result = mapImportedCookie({
      cookie: baseCookie({ domain: ".example.com", hostOnly: false }),
      targetUrls: ["https://app.example.com/account"],
    });

    expect(result).toMatchObject({
      ok: true,
      details: { domain: ".example.com", url: "https://app.example.com/account" },
    });
  });

  it("rejects a domain that is merely a hostname suffix", async () => {
    const { mapImportedCookie } = await loadMapper();
    expect(
      mapImportedCookie({
        cookie: baseCookie({ domain: ".example.com", hostOnly: false }),
        targetUrls: ["https://notexample.com/"],
      }),
    ).toEqual({ ok: false, reason: "out-of-scope" });
  });

  it("chooses a matching HTTPS target for a Secure cookie even when HTTP is listed first", async () => {
    const { mapImportedCookie } = await loadMapper();
    const result = mapImportedCookie({
      cookie: baseCookie({ secure: true }),
      targetUrls: ["http://app.example.com/", "https://app.example.com/"],
    });

    expect(result).toMatchObject({
      ok: true,
      details: { url: "https://app.example.com/", secure: true },
    });
  });

  it.each([
    "http://localhost:41739/",
    "http://app.localhost:41739/",
    "http://127.0.0.1:41739/",
    "http://127.42.0.9:41739/",
    "http://[::1]:41739/",
  ])("maps a Secure cookie for Chromium-trustworthy loopback target %s", async (targetUrl) => {
    const { mapImportedCookie } = await loadMapper();
    const hostname = new URL(targetUrl).hostname.replace(/^\[|\]$/gu, "");
    const result = mapImportedCookie({
      cookie: baseCookie({ domain: hostname, secure: true }),
      targetUrls: [targetUrl],
    });

    expect(result).toMatchObject({
      ok: true,
      details: { url: targetUrl, secure: true, httpOnly: true },
    });
  });

  it.each([
    "http://localhost.example.com/",
    "http://127.0.0.1.example.com/",
    "http://192.168.1.2/",
  ])(
    "does not weaken Secure-cookie rejection for non-loopback HTTP target %s",
    async (targetUrl) => {
      const { mapImportedCookie } = await loadMapper();
      const result = mapImportedCookie({
        cookie: baseCookie({ domain: new URL(targetUrl).hostname, secure: true }),
        targetUrls: [targetUrl],
      });

      expect(result).toEqual({ ok: false, reason: "secure-cookie-over-http" });
    },
  );

  it("omits expirationDate for session cookies and preserves it for persistent cookies", async () => {
    const { mapImportedCookie } = await loadMapper();
    const session = mapImportedCookie({
      cookie: baseCookie({ session: true, expirationDate: 2_000_000_000 }),
      targetUrls: ["https://app.example.com/"],
    });
    const persistent = mapImportedCookie({
      cookie: baseCookie({ session: false, expirationDate: 2_000_000_000 }),
      targetUrls: ["https://app.example.com/"],
      nowSeconds: 1_900_000_000,
    });

    if (!session.ok || !persistent.ok) throw new Error("expected both cookies to map");
    expect(session.details).not.toHaveProperty("expirationDate");
    expect(persistent.details.expirationDate).toBe(2_000_000_000);
  });

  it.each([
    {
      label: "expired",
      cookie: baseCookie({ session: false, expirationDate: 100 }),
      nowSeconds: 101,
      reason: "expired",
    },
    {
      label: "partitioned",
      cookie: baseCookie({ partitionKey: { topLevelSite: "https://example.com" } }),
      reason: "partitioned",
    },
    {
      label: "SameSite=None over an insecure origin",
      cookie: baseCookie({ secure: false, sameSite: "no_restriction" }),
      targetUrls: ["http://app.example.com/"],
      reason: "insecure-samesite-none",
    },
    {
      label: "Secure cookie with only an HTTP target",
      cookie: baseCookie({ secure: true }),
      targetUrls: ["http://app.example.com/"],
      reason: "secure-cookie-over-http",
    },
    {
      label: "invalid __Host- prefix",
      cookie: baseCookie({ name: "__Host-session", path: "/nested" }),
      reason: "invalid-prefix",
    },
    {
      label: "invalid __Secure- prefix",
      cookie: baseCookie({ name: "__Secure-session", secure: false }),
      targetUrls: ["http://app.example.com/"],
      reason: "invalid-prefix",
    },
  ])("rejects $label cookies", async ({ cookie, nowSeconds, targetUrls, reason }) => {
    const { mapImportedCookie } = await loadMapper();
    expect(
      mapImportedCookie({
        cookie,
        targetUrls: targetUrls ?? ["https://app.example.com/"],
        ...(nowSeconds === undefined ? {} : { nowSeconds }),
      }),
    ).toEqual({ ok: false, reason });
  });
});
