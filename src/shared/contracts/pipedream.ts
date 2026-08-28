import { z } from "zod";

const pipedreamAppSlugSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9_-]*$/);
const pipedreamAccountIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^apn_[a-zA-Z0-9]+$/);

export const pipedreamEnvironmentSchema = z.enum(["development", "production"]);
export type PipedreamEnvironment = z.infer<typeof pipedreamEnvironmentSchema>;

export const pipedreamCredentialSourceSchema = z.enum(["environment", "secure-storage"]);
export type PipedreamCredentialSource = z.infer<typeof pipedreamCredentialSourceSchema>;

export const pipedreamAppSummarySchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^app_[a-zA-Z0-9]+$/),
    slug: pipedreamAppSlugSchema,
    name: z.string().min(1).max(200),
    iconUrl: z.string().url().max(2_048).startsWith("https://").optional(),
  })
  .strict();
export type PipedreamAppSummary = z.infer<typeof pipedreamAppSummarySchema>;

export const pipedreamAccountSummarySchema = z
  .object({
    id: pipedreamAccountIdSchema,
    name: z.string().min(1).max(200),
    healthy: z.boolean(),
    connectedAt: z.iso.datetime(),
    agentAccess: z.boolean(),
    app: pipedreamAppSummarySchema,
  })
  .strict();
export type PipedreamAccountSummary = z.infer<typeof pipedreamAccountSummarySchema>;

export const pipedreamPersonalMcpSnapshotSchema = z
  .object({
    enabled: z.boolean(),
    authenticated: z.boolean(),
    serverName: z.literal("pd"),
  })
  .strict();

export const pipedreamConnectSnapshotSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("absent") }).strict(),
  z
    .object({
      state: z.literal("partial"),
      missingKeys: z.array(
        z.enum([
          "PIPEDREAM_CLIENT_ID",
          "PIPEDREAM_CLIENT_SECRET",
          "PIPEDREAM_PROJECT_ID",
          "PIPEDREAM_ENVIRONMENT",
        ]),
      ),
    })
    .strict(),
  z
    .object({
      state: z.literal("ready"),
      credentialSource: pipedreamCredentialSourceSchema,
      environment: pipedreamEnvironmentSchema,
      projectIdHint: z.string().min(1).max(64),
      projectName: z.string().min(1).max(200),
      accounts: z.array(pipedreamAccountSummarySchema).max(1_000),
    })
    .strict(),
  z
    .object({
      state: z.literal("error"),
      code: z.enum(["authentication-failed", "configuration-invalid", "request-failed"]),
    })
    .strict(),
]);

/** Public snapshot safe to send over IPC and persist in renderer state. */
export const pipedreamSnapshotSchema = z
  .object({
    personalMcp: pipedreamPersonalMcpSnapshotSchema,
    connect: pipedreamConnectSnapshotSchema,
  })
  .strict();
export type PipedreamSnapshot = z.infer<typeof pipedreamSnapshotSchema>;

export const pipedreamChooseEnvFilePayloadSchema = z
  .object({
    dialogTitle: z.string().trim().min(1).max(200),
  })
  .strict();
export type PipedreamChooseEnvFilePayload = z.infer<typeof pipedreamChooseEnvFilePayloadSchema>;

export const pipedreamEnvFileInvalidReasonSchema = z.enum([
  "unreadable",
  "too-large",
  "no-supported-values",
]);
export type PipedreamEnvFileInvalidReason = z.infer<typeof pipedreamEnvFileInvalidReasonSchema>;

/** Renderer-safe result: no selected path or credential value crosses IPC. */
export const pipedreamEnvFileImportResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("configured"), snapshot: pipedreamSnapshotSchema }).strict(),
  z.object({ status: z.literal("invalid"), reason: pipedreamEnvFileInvalidReasonSchema }).strict(),
]);
export type PipedreamEnvFileImportResult = z.infer<typeof pipedreamEnvFileImportResultSchema>;

export const pipedreamListAppsPayloadSchema = z
  .object({
    query: z.string().trim().max(200).optional(),
    cursor: z.string().min(1).max(2_048).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
export type PipedreamListAppsPayload = z.infer<typeof pipedreamListAppsPayloadSchema>;

export const pipedreamBeginConnectPayloadSchema = z
  .object({ appSlug: pipedreamAppSlugSchema })
  .strict();
export type PipedreamBeginConnectPayload = z.infer<typeof pipedreamBeginConnectPayloadSchema>;

export const pipedreamDisconnectAccountPayloadSchema = z
  .object({ accountId: pipedreamAccountIdSchema })
  .strict();
export type PipedreamDisconnectAccountPayload = z.infer<
  typeof pipedreamDisconnectAccountPayloadSchema
>;

export const pipedreamSetAccountAgentAccessPayloadSchema = z
  .object({
    accountId: pipedreamAccountIdSchema,
    enabled: z.boolean(),
  })
  .strict();
export type PipedreamSetAccountAgentAccessPayload = z.infer<
  typeof pipedreamSetAccountAgentAccessPayloadSchema
>;

export const pipedreamListAppsResultSchema = z
  .object({
    apps: z.array(pipedreamAppSummarySchema).max(100),
    nextCursor: z.string().min(1).max(2_048).optional(),
    totalCount: z.number().int().min(0),
  })
  .strict();
export type PipedreamListAppsResult = z.infer<typeof pipedreamListAppsResultSchema>;

/** Safe acknowledgement from main after it opens the one-use Connect Link. */
export const pipedreamBeginConnectResultSchema = z
  .object({
    opened: z.boolean(),
    expiresAt: z.iso.datetime(),
  })
  .strict();
export type PipedreamBeginConnectResult = z.infer<typeof pipedreamBeginConnectResultSchema>;
