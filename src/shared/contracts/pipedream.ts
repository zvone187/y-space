import { z } from "zod";

export const PIPEDREAM_PERSONAL_MCP_SERVER_ID = "pipedream-personal-mcp";
export const PIPEDREAM_PERSONAL_MCP_SERVER_NAME = "pd";
export const PIPEDREAM_PERSONAL_MCP_URL = "https://mcp.pipedream.net/v2";

export function isPipedreamPersonalMcpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/\.+$/, "");
    const pathname = decodeURIComponent(url.pathname);
    return (
      url.protocol === "https:" &&
      hostname === "mcp.pipedream.net" &&
      url.port === "" &&
      (pathname === "/v2" || pathname === "/v2/")
    );
  } catch {
    return false;
  }
}

export const pipedreamAppSlugSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\p{L}\p{N}_][\p{L}\p{N}\p{M}._-]*$/u);

/** Parses the public Pipedream name slug without exposing Zod errors to transport callers. */
export function parsePipedreamAppSlug(value: unknown): string | undefined {
  const parsed = pipedreamAppSlugSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
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

/** Renderer-safe aggregate result of applying changed integration access to live agents. */
export const pipedreamAgentReloadOutcomeSchema = z
  .object({ state: z.enum(["applied", "restart-required", "failed-pending"]) })
  .strict();
export type PipedreamAgentReloadOutcome = z.infer<typeof pipedreamAgentReloadOutcomeSchema>;

/** Public snapshot safe to send over IPC and persist in renderer state. */
export const pipedreamSnapshotSchema = z
  .object({
    personalMcp: pipedreamPersonalMcpSnapshotSchema,
    connect: pipedreamConnectSnapshotSchema,
    agentReload: pipedreamAgentReloadOutcomeSchema.optional(),
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
  "incomplete-values",
  "invalid-values",
  "not-dedicated",
  "secure-storage-unavailable",
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

const pipedreamConnectFlowIdSchema = z.string().uuid();

/** Opaque main-owned Connect flow handle; never a browser tab identifier. */
export const pipedreamConnectFlowPayloadSchema = z
  .object({ flowId: pipedreamConnectFlowIdSchema })
  .strict();
export type PipedreamConnectFlowPayload = z.infer<typeof pipedreamConnectFlowPayloadSchema>;

/**
 * Coarse renderer-safe state correlated to one opaque main-owned flow.
 * Pipedream's current Connect redirect supplies no account identity, so a
 * succeeded state must never be used to infer or auto-grant a refreshed account.
 */
export const pipedreamConnectFlowStatusSchema = z
  .object({ state: z.enum(["open", "closed", "expired", "succeeded", "failed"]) })
  .strict();
export type PipedreamConnectFlowStatus = z.infer<typeof pipedreamConnectFlowStatusSchema>;

const pipedreamPersonalMcpOauthFlowIdSchema = z.string().uuid();

/** Opaque renderer handle for a main-owned Personal Pipedream OAuth flow. */
export const pipedreamPersonalMcpOauthFlowPayloadSchema = z
  .object({ flowId: pipedreamPersonalMcpOauthFlowIdSchema })
  .strict();
export type PipedreamPersonalMcpOauthFlowPayload = z.infer<
  typeof pipedreamPersonalMcpOauthFlowPayloadSchema
>;

/** URL-free begin result; authorization URL, PKCE state, and tab identity stay in main. */
export const pipedreamPersonalMcpOauthBeginResultSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("authorized") }).strict(),
  z.object({ state: z.literal("open"), flowId: pipedreamPersonalMcpOauthFlowIdSchema }).strict(),
  z.object({ state: z.literal("error") }).strict(),
]);
export type PipedreamPersonalMcpOauthBeginResult = z.infer<
  typeof pipedreamPersonalMcpOauthBeginResultSchema
>;

/** Coarse terminal state; upstream errors and sensitive browser details remain privileged. */
export const pipedreamPersonalMcpOauthFlowStatusSchema = z
  .object({ state: z.enum(["open", "authorized", "error", "closed"]) })
  .strict();
export type PipedreamPersonalMcpOauthFlowStatus = z.infer<
  typeof pipedreamPersonalMcpOauthFlowStatusSchema
>;

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
    opened: z.literal(true),
    expiresAt: z.iso.datetime(),
    flowId: pipedreamConnectFlowIdSchema,
  })
  .strict();
export type PipedreamBeginConnectResult = z.infer<typeof pipedreamBeginConnectResultSchema>;
