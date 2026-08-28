import { Buffer } from "node:buffer";
import { z } from "zod";

export const COOKIE_IMPORT_PROTOCOL_VERSION = 1 as const;
export const COOKIE_IMPORT_MAX_COOKIES = 750;
export const COOKIE_IMPORT_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
export const COOKIE_IMPORT_MAX_TARGETS = 12;

const protocolVersionSchema = z.literal(COOKIE_IMPORT_PROTOCOL_VERSION);
const identifierSchema = z.string().uuid();
const nonceSchema = z.string().regex(/^[A-Za-z\d_-]{43}$/);
const proofSchema = z.string().regex(/^[A-Za-z\d_-]{43}$/);
const publicKeySchema = z.string().regex(/^[A-Za-z\d_-]{87}$/);
const ivSchema = z.string().regex(/^[A-Za-z\d_-]{16}$/);
const ciphertextSchema = z.string().min(22).max(COOKIE_IMPORT_MAX_PAYLOAD_BYTES);
export const cookieImportBrowserFamilySchema = z.enum(["chrome", "chromium", "brave", "edge"]);

export const cookieImportTargetUrlSchema = z
  .string()
  .url()
  .superRefine((value, context) => {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      context.addIssue({ code: "custom", message: "Target URL must use HTTP or HTTPS." });
    }
    if (url.username || url.password) {
      context.addIssue({ code: "custom", message: "Target URL must not contain credentials." });
    }
    if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
      context.addIssue({ code: "custom", message: "Target must be an exact origin." });
    }
  });

export const cookieImportTargetUrlsSchema = z
  .array(cookieImportTargetUrlSchema)
  .min(1)
  .max(COOKIE_IMPORT_MAX_TARGETS);

export const cookieImportDomainSummarySchema = z
  .object({
    domain: z.string().min(1).max(253),
    cookieCount: z.number().int().nonnegative().max(COOKIE_IMPORT_MAX_COOKIES),
    unsupportedCount: z.number().int().nonnegative().max(COOKIE_IMPORT_MAX_COOKIES),
  })
  .strict();

export const cookieImportWireCookieSchema = z
  .object({
    name: z.string().min(1).max(4096),
    value: z.string().max(COOKIE_IMPORT_MAX_PAYLOAD_BYTES),
    domain: z.string().min(1).max(253),
    hostOnly: z.boolean(),
    path: z.string().min(1).max(4096),
    secure: z.boolean(),
    httpOnly: z.boolean(),
    sameSite: z.enum(["unspecified", "no_restriction", "lax", "strict"]),
    session: z.boolean(),
    expirationDate: z.number().finite().positive().optional(),
    storeId: z.string().max(512).optional(),
    partitionKey: z
      .object({
        topLevelSite: z.string().min(1),
        hasCrossSiteAncestor: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const cookieImportPreviewResultPayloadSchema = z
  .object({
    requestId: identifierSchema,
    domains: z.array(cookieImportDomainSummarySchema).max(COOKIE_IMPORT_MAX_COOKIES),
  })
  .strict();

export const cookieImportCommitResultPayloadSchema = z
  .object({
    requestId: identifierSchema,
    cookies: z.array(cookieImportWireCookieSchema).max(COOKIE_IMPORT_MAX_COOKIES),
  })
  .strict();

const helloMessageSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    type: z.literal("hello"),
    sourceId: identifierSchema,
    clientNonce: nonceSchema,
    clientPublicKey: publicKeySchema,
    proof: proofSchema,
    extensionVersion: z.string().min(1).max(64),
    browserFamily: cookieImportBrowserFamilySchema,
    label: z.string().min(1).max(120),
  })
  .strict();

const pairRequestMessageSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    type: z.literal("pair.request"),
    pairingId: identifierSchema,
    sourceId: identifierSchema,
    clientNonce: nonceSchema,
    clientPublicKey: publicKeySchema,
    proof: proofSchema,
    extensionVersion: z.string().min(1).max(64),
    browserFamily: cookieImportBrowserFamilySchema,
    label: z.string().min(1).max(120),
  })
  .strict();

const previewResultMessageSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    type: z.literal("preview.result"),
    requestId: identifierSchema,
    domains: z.array(cookieImportDomainSummarySchema).max(COOKIE_IMPORT_MAX_COOKIES),
  })
  .strict();

const commitResultMessageSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    type: z.literal("commit.result"),
    requestId: identifierSchema,
    iv: ivSchema,
    ciphertext: ciphertextSchema,
  })
  .strict();

const requestErrorMessageSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    type: z.literal("request.error"),
    requestId: identifierSchema.optional(),
    code: z.string().min(1).max(64),
    message: z.string().min(1).max(512),
  })
  .strict();

const pingMessageSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    type: z.literal("ping"),
  })
  .strict();

export const cookieImportClientMessageSchema = z.discriminatedUnion("type", [
  helloMessageSchema,
  pairRequestMessageSchema,
  previewResultMessageSchema,
  commitResultMessageSchema,
  requestErrorMessageSchema,
  pingMessageSchema,
]);

const connectionChallengeMessageSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    type: z.literal("connection.challenge"),
    challenge: nonceSchema,
  })
  .strict();

const pairingChallengeMessageSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    type: z.literal("pairing.challenge"),
    pairingId: identifierSchema,
    expiresAt: z.number().int().positive(),
  })
  .strict();

const pairResultMessageSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    type: z.literal("pair.result"),
    sourceId: identifierSchema,
    serverPublicKey: publicKeySchema,
    proof: proofSchema,
    iv: ivSchema,
    ciphertext: ciphertextSchema,
  })
  .strict();

const helloResultMessageSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    type: z.literal("hello.result"),
    sourceId: identifierSchema,
    serverPublicKey: publicKeySchema,
    proof: proofSchema,
  })
  .strict();

const previewRequestMessageSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    type: z.literal("preview.request"),
    requestId: identifierSchema,
    targetUrls: cookieImportTargetUrlsSchema,
    expiresAt: z.number().int().positive(),
  })
  .strict();

const commitRequestMessageSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    type: z.literal("commit.request"),
    requestId: identifierSchema,
    targetUrls: cookieImportTargetUrlsSchema,
    selectedDomains: z.array(z.string().min(1).max(253)).max(COOKIE_IMPORT_MAX_COOKIES),
    expiresAt: z.number().int().positive(),
  })
  .strict();

const cancelRequestMessageSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    type: z.literal("cancel.request"),
    requestId: identifierSchema,
  })
  .strict();

const serverErrorMessageSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    type: z.literal("error"),
    code: z.string().min(1).max(64),
    message: z.string().min(1).max(512),
  })
  .strict();

const pongMessageSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    type: z.literal("pong"),
  })
  .strict();

export const cookieImportServerMessageSchema = z.discriminatedUnion("type", [
  connectionChallengeMessageSchema,
  pairingChallengeMessageSchema,
  pairResultMessageSchema,
  helloResultMessageSchema,
  previewRequestMessageSchema,
  commitRequestMessageSchema,
  cancelRequestMessageSchema,
  serverErrorMessageSchema,
  pongMessageSchema,
]);

export type CookieImportClientMessage = z.infer<typeof cookieImportClientMessageSchema>;
export type CookieImportServerMessage = z.infer<typeof cookieImportServerMessageSchema>;
export type CookieImportBrowserFamily = z.infer<typeof cookieImportBrowserFamilySchema>;
export type CookieImportWireCookie = z.infer<typeof cookieImportWireCookieSchema>;
export type CookieImportDomainSummary = z.infer<typeof cookieImportDomainSummarySchema>;
export type CookieImportPreviewResult = z.infer<typeof cookieImportPreviewResultPayloadSchema>;
export type CookieImportCommitResult = z.infer<typeof cookieImportCommitResultPayloadSchema>;

export function assertCookieImportPayloadSize(payload: string | Buffer): void {
  const byteLength =
    typeof payload === "string" ? Buffer.byteLength(payload, "utf8") : payload.byteLength;
  if (byteLength > COOKIE_IMPORT_MAX_PAYLOAD_BYTES) {
    throw new Error(`Cookie-import payload is too large (${byteLength} bytes).`);
  }
}

export function validateCookieImportTargetUrls(targetUrls: readonly string[]): string[] {
  return cookieImportTargetUrlsSchema.parse([...targetUrls]);
}
