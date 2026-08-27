import { z } from "zod";
import { defineNoArgProcedure, definePayloadProcedure } from "../core";

const MAX_TARGETS = 12;
const MAX_COOKIES = 750;

const targetUrlSchema = z
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

export const browserCookieImportSourceSchema = z
  .object({
    sourceId: z.string().uuid(),
    label: z.string().min(1).max(120),
    browserFamily: z.enum(["chrome", "chromium", "brave", "edge"]),
    extensionVersion: z.string().min(1).max(64),
    pairedAt: z.number().int().nonnegative(),
    connected: z.boolean(),
  })
  .strict();

export const browserCookieImportDomainSummarySchema = z
  .object({
    domain: z.string().min(1).max(253),
    cookieCount: z.number().int().nonnegative().max(MAX_COOKIES),
    unsupportedCount: z.number().int().nonnegative().max(MAX_COOKIES),
  })
  .strict();

export const browserCookieImportActiveRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    sourceId: z.string().uuid(),
    sourceKind: z.enum(["extension", "file"]),
    sourceLabel: z.string().min(1).max(120).optional(),
    status: z.enum([
      "requesting-preview",
      "ready",
      "committing",
      "completed",
      "cancelled",
      "failed",
    ]),
    targetUrls: z.array(targetUrlSchema).min(1).max(MAX_TARGETS),
    domains: z.array(browserCookieImportDomainSummarySchema).max(MAX_COOKIES),
    expiresAt: z.number().int().positive(),
    unscopedUnsupportedCount: z.number().int().nonnegative().max(MAX_COOKIES).optional(),
    importedCount: z.number().int().nonnegative().max(MAX_COOKIES).optional(),
    skippedCount: z.number().int().nonnegative().max(MAX_COOKIES).optional(),
    error: z.string().min(1).max(256).optional(),
  })
  .strict();

export const browserCookieImportStateSchema = z
  .object({
    sources: z.array(browserCookieImportSourceSchema),
    activeRequest: browserCookieImportActiveRequestSchema.nullable(),
  })
  .strict();

export const browserCookieImportPreviewPayloadSchema = z
  .object({
    sourceId: z.string().uuid(),
    targetUrls: z.array(targetUrlSchema).min(1).max(MAX_TARGETS),
  })
  .strict();

export const browserCookieImportChooseFilePayloadSchema = z
  .object({
    targetUrls: z.array(targetUrlSchema).min(1).max(MAX_TARGETS),
    dialogTitle: z.string().trim().min(1).max(160),
    cookieExportsFilterName: z.string().trim().min(1).max(80),
    allFilesFilterName: z.string().trim().min(1).max(80),
  })
  .strict();

export const browserCookieImportCommitPayloadSchema = z
  .object({
    requestId: z.string().uuid(),
    selectedDomains: z.array(z.string().min(1).max(253)).max(MAX_COOKIES),
  })
  .strict();

export const browserCookieImportPairingIdPayloadSchema = z
  .object({ pairingId: z.string().uuid() })
  .strict();
export const browserCookieImportSourceIdPayloadSchema = z
  .object({ sourceId: z.string().uuid() })
  .strict();
export const browserCookieImportRequestIdPayloadSchema = z
  .object({ requestId: z.string().uuid() })
  .strict();

export const browserCookieImportPairingChallengeSchema = z
  .object({
    pairingId: z.string().uuid(),
    code: z.string().regex(/^\d{8}$/),
    expiresAt: z.number().int().positive(),
  })
  .strict();

export const browserCookieImportCompletionSchema = z
  .object({
    requestId: z.string().uuid(),
    importedCount: z.number().int().nonnegative().max(MAX_COOKIES),
    skippedCount: z.number().int().nonnegative().max(MAX_COOKIES),
    skippedByReason: z.record(z.string(), z.number().int().nonnegative()).optional(),
    flushFailed: z.boolean().optional(),
  })
  .strict();

export type BrowserCookieImportSource = z.infer<typeof browserCookieImportSourceSchema>;
export type BrowserCookieImportState = z.infer<typeof browserCookieImportStateSchema>;
export type BrowserCookieImportPairingChallenge = z.infer<
  typeof browserCookieImportPairingChallengeSchema
>;
export type BrowserCookieImportCompletion = z.infer<typeof browserCookieImportCompletionSchema>;

export const browserCookieImportProcedures = {
  browserCookieImportOpenExtensionFolder: defineNoArgProcedure<void, "main-local">(
    "browserCookieImportOpenExtensionFolder",
    "main-local",
  ),
  browserCookieImportGetState: defineNoArgProcedure<BrowserCookieImportState, "main-local">(
    "browserCookieImportGetState",
    "main-local",
  ),
  browserCookieImportChooseFile: definePayloadProcedure<
    z.infer<typeof browserCookieImportChooseFilePayloadSchema>,
    z.infer<typeof browserCookieImportActiveRequestSchema> | null,
    "main-local"
  >("browserCookieImportChooseFile", "main-local", browserCookieImportChooseFilePayloadSchema),
  browserCookieImportBeginPairing: defineNoArgProcedure<
    BrowserCookieImportPairingChallenge,
    "main-local"
  >("browserCookieImportBeginPairing", "main-local"),
  browserCookieImportCancelPairing: definePayloadProcedure<
    z.infer<typeof browserCookieImportPairingIdPayloadSchema>,
    void,
    "main-local"
  >("browserCookieImportCancelPairing", "main-local", browserCookieImportPairingIdPayloadSchema),
  browserCookieImportForgetSource: definePayloadProcedure<
    z.infer<typeof browserCookieImportSourceIdPayloadSchema>,
    void,
    "main-local"
  >("browserCookieImportForgetSource", "main-local", browserCookieImportSourceIdPayloadSchema),
  browserCookieImportPreview: definePayloadProcedure<
    z.infer<typeof browserCookieImportPreviewPayloadSchema>,
    z.infer<typeof browserCookieImportActiveRequestSchema>,
    "main-local"
  >("browserCookieImportPreview", "main-local", browserCookieImportPreviewPayloadSchema),
  browserCookieImportCommit: definePayloadProcedure<
    z.infer<typeof browserCookieImportCommitPayloadSchema>,
    BrowserCookieImportCompletion,
    "main-local"
  >("browserCookieImportCommit", "main-local", browserCookieImportCommitPayloadSchema),
  browserCookieImportCancel: definePayloadProcedure<
    z.infer<typeof browserCookieImportRequestIdPayloadSchema>,
    void,
    "main-local"
  >("browserCookieImportCancel", "main-local", browserCookieImportRequestIdPayloadSchema),
} as const;
