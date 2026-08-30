const SECRET_KEY_BYTES = 32;
const SECRET_KEY_BASE64_LENGTH = 44;
const REQUEST_ID_MAX_LENGTH = 128;

export const SUPERVISOR_SECRET_BOOTSTRAP_PROTOCOL_VERSION = 3 as const;

export const SUPERVISOR_BOOTSTRAP_FAILURE_CODE = {
  ALREADY_ATTEMPTED: "already-attempted",
  INITIALIZATION_FAILED: "initialization-failed",
  INVALID: "invalid-bootstrap",
  MCP_OAUTH_STORE_UNAVAILABLE: "mcp-oauth-store-unavailable",
} as const;

export type SupervisorBootstrapFailureCode =
  (typeof SUPERVISOR_BOOTSTRAP_FAILURE_CODE)[keyof typeof SUPERVISOR_BOOTSTRAP_FAILURE_CODE];

const SUPERVISOR_BOOTSTRAP_FAILURE_MESSAGE: Record<SupervisorBootstrapFailureCode, string> = {
  [SUPERVISOR_BOOTSTRAP_FAILURE_CODE.ALREADY_ATTEMPTED]:
    "Supervisor security bootstrap was already attempted.",
  [SUPERVISOR_BOOTSTRAP_FAILURE_CODE.INITIALIZATION_FAILED]:
    "Supervisor security bootstrap failed.",
  [SUPERVISOR_BOOTSTRAP_FAILURE_CODE.INVALID]: "Supervisor security bootstrap is invalid.",
  [SUPERVISOR_BOOTSTRAP_FAILURE_CODE.MCP_OAUTH_STORE_UNAVAILABLE]:
    "Supervisor security bootstrap failed.",
};

export interface SupervisorSecurityBootstrap {
  readonly secretStorageKey: string;
  readonly allowPipedreamOauthPersistence: boolean;
}

export interface SupervisorSecretBootstrapMessage {
  readonly kind: "supervisor-secret-bootstrap";
  readonly version: typeof SUPERVISOR_SECRET_BOOTSTRAP_PROTOCOL_VERSION;
  readonly id: string;
  readonly secretStorageKey: string;
  readonly allowPipedreamOauthPersistence: boolean;
}

export type SupervisorSecretBootstrapReply =
  | {
      readonly kind: "supervisor-secret-bootstrap-reply";
      readonly replyTo: string;
      readonly ok: true;
      readonly data: {
        readonly version: typeof SUPERVISOR_SECRET_BOOTSTRAP_PROTOCOL_VERSION;
        readonly ready: true;
      };
    }
  | {
      readonly kind: "supervisor-secret-bootstrap-reply";
      readonly replyTo: string;
      readonly ok: false;
      readonly error: string;
      readonly failureCode: SupervisorBootstrapFailureCode;
    };

export function isSupervisorSecretBootstrapCandidate(
  value: unknown,
): value is { readonly kind: "supervisor-secret-bootstrap"; readonly id?: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "supervisor-secret-bootstrap"
  );
}

export function isSupervisorSecretBootstrapMessage(
  value: unknown,
): value is SupervisorSecretBootstrapMessage {
  if (!isSupervisorSecretBootstrapCandidate(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    !hasExactKeys(record, [
      "allowPipedreamOauthPersistence",
      "id",
      "kind",
      "secretStorageKey",
      "version",
    ]) ||
    record.version !== SUPERVISOR_SECRET_BOOTSTRAP_PROTOCOL_VERSION ||
    !isSafeRequestId(record.id) ||
    typeof record.secretStorageKey !== "string" ||
    typeof record.allowPipedreamOauthPersistence !== "boolean"
  ) {
    return false;
  }
  return isCanonicalSecretStorageKey(record.secretStorageKey);
}

export function isSupervisorSecretBootstrapAck(value: unknown): value is {
  readonly version: typeof SUPERVISOR_SECRET_BOOTSTRAP_PROTOCOL_VERSION;
  readonly ready: true;
} {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    hasExactKeys(record, ["ready", "version"]) &&
    record.version === SUPERVISOR_SECRET_BOOTSTRAP_PROTOCOL_VERSION &&
    record.ready === true
  );
}

export function isSupervisorSecretBootstrapFailure(
  value: unknown,
): value is Extract<SupervisorSecretBootstrapReply, { readonly ok: false }> {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (
    !hasExactKeys(record, ["error", "failureCode", "kind", "ok", "replyTo"]) ||
    record.kind !== "supervisor-secret-bootstrap-reply" ||
    record.ok !== false ||
    !isSafeRequestId(record.replyTo) ||
    !isSupervisorBootstrapFailureCode(record.failureCode)
  ) {
    return false;
  }
  return record.error === supervisorBootstrapFailureMessage(record.failureCode);
}

export function supervisorBootstrapFailureMessage(code: SupervisorBootstrapFailureCode): string {
  return SUPERVISOR_BOOTSTRAP_FAILURE_MESSAGE[code];
}

export function safeSupervisorSecretBootstrapReplyId(value: unknown): string | undefined {
  if (!isSupervisorSecretBootstrapCandidate(value) || !isSafeRequestId(value.id)) {
    return undefined;
  }
  return value.id;
}

export function isCanonicalSecretStorageKey(value: string): boolean {
  if (value.length !== SECRET_KEY_BASE64_LENGTH || !/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, "base64");
  return decoded.length === SECRET_KEY_BYTES && decoded.toString("base64") === value;
}

function isSafeRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= REQUEST_ID_MAX_LENGTH;
}

function isSupervisorBootstrapFailureCode(value: unknown): value is SupervisorBootstrapFailureCode {
  return Object.values(SUPERVISOR_BOOTSTRAP_FAILURE_CODE).some((code) => code === value);
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}
