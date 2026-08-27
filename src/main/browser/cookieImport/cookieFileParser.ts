import {
  cookieImportWireCookieSchema,
  COOKIE_IMPORT_MAX_COOKIES,
  type CookieImportDomainSummary,
  type CookieImportWireCookie,
} from "./protocol";

export type CookieImportFileFormat = "cookie-editor-json" | "netscape";

export interface ParsedCookieImportFile {
  format: CookieImportFileFormat;
  cookies: CookieImportWireCookie[];
  domains: CookieImportDomainSummary[];
  invalidCount: number;
}

function normalizeDomain(domain: string): string {
  return domain.trim().replace(/^\.+/, "").toLowerCase();
}

function sameSite(value: unknown): CookieImportWireCookie["sameSite"] {
  if (typeof value !== "string") return "unspecified";
  switch (value.trim().toLowerCase().replaceAll("-", "_")) {
    case "none":
    case "no_restriction":
      return "no_restriction";
    case "lax":
      return "lax";
    case "strict":
      return "strict";
    default:
      return "unspecified";
  }
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function jsonCookie(value: unknown): CookieImportWireCookie | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.name !== "string" || typeof raw.value !== "string") return null;
  if (typeof raw.domain !== "string" || typeof raw.path !== "string") return null;
  const expirationDate = optionalNumber(raw.expirationDate ?? raw.expiration);
  const session = typeof raw.session === "boolean" ? raw.session : expirationDate === undefined;
  const parsed = cookieImportWireCookieSchema.safeParse({
    name: raw.name,
    value: raw.value,
    domain: raw.domain,
    hostOnly: typeof raw.hostOnly === "boolean" ? raw.hostOnly : !raw.domain.trim().startsWith("."),
    path: raw.path || "/",
    secure: raw.secure === true,
    httpOnly: raw.httpOnly === true,
    sameSite: sameSite(raw.sameSite),
    session,
    ...(!session && expirationDate !== undefined ? { expirationDate } : {}),
    ...(typeof raw.storeId === "string" ? { storeId: raw.storeId } : {}),
    ...(raw.partitionKey && typeof raw.partitionKey === "object"
      ? { partitionKey: raw.partitionKey }
      : {}),
  });
  return parsed.success ? parsed.data : null;
}

function parseJson(serialized: string): {
  cookies: CookieImportWireCookie[];
  invalidCount: number;
} {
  let decoded: unknown;
  try {
    decoded = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error("Cookie JSON is malformed.");
  }
  const entries = Array.isArray(decoded)
    ? decoded
    : decoded &&
        typeof decoded === "object" &&
        Array.isArray((decoded as { cookies?: unknown }).cookies)
      ? ((decoded as { cookies: unknown[] }).cookies ?? [])
      : null;
  if (!entries) throw new Error("Cookie JSON must contain an array of cookies.");
  if (entries.length > COOKIE_IMPORT_MAX_COOKIES) {
    throw new Error(`Cookie file contains more than ${COOKIE_IMPORT_MAX_COOKIES} entries.`);
  }
  const cookies: CookieImportWireCookie[] = [];
  let invalidCount = 0;
  for (const entry of entries) {
    const cookie = jsonCookie(entry);
    if (cookie) cookies.push(cookie);
    else invalidCount += 1;
  }
  return { cookies, invalidCount };
}

function parseNetscape(serialized: string): {
  cookies: CookieImportWireCookie[];
  invalidCount: number;
} {
  const entries = serialized
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && (!line.startsWith("#") || line.startsWith("#HttpOnly_")));
  if (entries.length > COOKIE_IMPORT_MAX_COOKIES) {
    throw new Error(`Cookie file contains more than ${COOKIE_IMPORT_MAX_COOKIES} entries.`);
  }
  const cookies: CookieImportWireCookie[] = [];
  let invalidCount = 0;
  for (const line of entries) {
    const fields = line.split("\t");
    if (fields.length < 7) {
      invalidCount += 1;
      continue;
    }
    let domain = fields[0] ?? "";
    const httpOnly = domain.startsWith("#HttpOnly_");
    if (httpOnly) domain = domain.slice("#HttpOnly_".length);
    const includeSubdomains = (fields[1] ?? "").toUpperCase() === "TRUE";
    const path = fields[2] || "/";
    const secure = (fields[3] ?? "").toUpperCase() === "TRUE";
    const expires = optionalNumber(fields[4]);
    const name = fields[5] ?? "";
    const value = fields.slice(6).join("\t");
    const session = !expires || expires <= 0;
    const parsed = cookieImportWireCookieSchema.safeParse({
      name,
      value,
      domain,
      hostOnly: !includeSubdomains,
      path,
      secure,
      httpOnly,
      sameSite: "unspecified",
      session,
      ...(!session && expires ? { expirationDate: expires } : {}),
    });
    if (parsed.success) cookies.push(parsed.data);
    else invalidCount += 1;
  }
  return { cookies, invalidCount };
}

function summarize(cookies: readonly CookieImportWireCookie[]): CookieImportDomainSummary[] {
  const byDomain = new Map<string, CookieImportDomainSummary>();
  for (const cookie of cookies) {
    const domain = normalizeDomain(cookie.domain);
    if (!domain) continue;
    const summary = byDomain.get(domain) ?? { domain, cookieCount: 0, unsupportedCount: 0 };
    if (cookie.partitionKey) summary.unsupportedCount += 1;
    else summary.cookieCount += 1;
    byDomain.set(domain, summary);
  }
  return [...byDomain.values()].sort((left, right) => left.domain.localeCompare(right.domain));
}

export function parseCookieImportFile(
  serialized: string,
  fileName: string,
): ParsedCookieImportFile {
  const trimmed = serialized.trimStart();
  const parsed =
    fileName.toLowerCase().endsWith(".json") || trimmed.startsWith("[") || trimmed.startsWith("{")
      ? { format: "cookie-editor-json" as const, ...parseJson(serialized) }
      : { format: "netscape" as const, ...parseNetscape(serialized) };
  return { ...parsed, domains: summarize(parsed.cookies) };
}
