import type { CookiesSetDetails } from "electron";
import type { CookieImportWireCookie } from "./protocol";

export type CookieImportSkipReason =
  | "expired"
  | "partitioned"
  | "out-of-scope"
  | "invalid-cookie"
  | "invalid-prefix"
  | "insecure-samesite-none"
  | "secure-cookie-over-http";

export type CookieImportMappingResult =
  | { ok: true; details: CookiesSetDetails }
  | { ok: false; reason: CookieImportSkipReason };

function normalizeDomain(domain: string): string {
  return domain.trim().replace(/^\.+/, "").toLowerCase();
}

function hostnameMatchesDomain(hostname: string, domain: string): boolean {
  const normalizedHostname = hostname.toLowerCase();
  return normalizedHostname === domain || normalizedHostname.endsWith(`.${domain}`);
}

function validCookiePrefix(cookie: CookieImportWireCookie): boolean {
  if (cookie.name.startsWith("__Host-")) {
    return cookie.secure && cookie.hostOnly && cookie.path === "/";
  }
  if (cookie.name.startsWith("__Secure-")) return cookie.secure;
  return true;
}

export function mapImportedCookie(input: {
  cookie: CookieImportWireCookie;
  targetUrls: string[];
  nowSeconds?: number;
}): CookieImportMappingResult {
  const { cookie } = input;
  if (cookie.partitionKey) return { ok: false, reason: "partitioned" };
  if (!validCookiePrefix(cookie)) return { ok: false, reason: "invalid-prefix" };
  if (!cookie.name || !cookie.path.startsWith("/")) {
    return { ok: false, reason: "invalid-cookie" };
  }
  if (!cookie.session) {
    const nowSeconds = input.nowSeconds ?? Date.now() / 1000;
    if (!cookie.expirationDate || cookie.expirationDate <= nowSeconds) {
      return { ok: false, reason: "expired" };
    }
  }
  if (cookie.sameSite === "no_restriction" && !cookie.secure) {
    return { ok: false, reason: "insecure-samesite-none" };
  }

  const cookieDomain = normalizeDomain(cookie.domain);
  if (!cookieDomain) return { ok: false, reason: "invalid-cookie" };
  let domainMatchingTarget: string | undefined;
  let matchingTarget: string | undefined;
  for (const targetUrl of input.targetUrls) {
    let url: URL;
    try {
      url = new URL(targetUrl);
    } catch {
      continue;
    }
    const domainMatches = cookie.hostOnly
      ? url.hostname.toLowerCase() === cookieDomain
      : hostnameMatchesDomain(url.hostname, cookieDomain);
    if (!domainMatches) continue;
    domainMatchingTarget ??= targetUrl;
    if (!cookie.secure || url.protocol === "https:") {
      matchingTarget = targetUrl;
      break;
    }
  }
  if (!domainMatchingTarget) return { ok: false, reason: "out-of-scope" };
  if (!matchingTarget) return { ok: false, reason: "secure-cookie-over-http" };

  const details: CookiesSetDetails = {
    url: matchingTarget,
    name: cookie.name,
    value: cookie.value,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
    ...(!cookie.session && cookie.expirationDate ? { expirationDate: cookie.expirationDate } : {}),
  };
  return { ok: true, details };
}
