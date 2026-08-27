import type {
  PipedreamBootstrap,
  PipedreamBootstrapCredentials,
  PipedreamEnvKey,
} from "./pipedreamBootstrap";

export interface PipedreamPrivilegedBootstrapPayload {
  readonly bootstrap: PipedreamBootstrap;
  readonly externalUserId: string;
}

export interface PipedreamPrivilegedBootstrapMessage {
  readonly kind: "pipedream-privileged-bootstrap";
  readonly payload: PipedreamPrivilegedBootstrapPayload;
}

export interface PipedreamPrivilegedConnectLinkRequest {
  readonly kind: "pipedream-privileged-request";
  readonly id: string;
  readonly request: {
    readonly type: "create-connect-link";
    readonly appSlug: string;
  };
}

export interface PipedreamPrivilegedConnectLinkResult {
  readonly connectLinkUrl: string;
  readonly expiresAt: string;
}

export type PipedreamPrivilegedReply =
  | {
      readonly kind: "pipedream-privileged-reply";
      readonly replyTo: string;
      readonly ok: true;
      readonly data: PipedreamPrivilegedConnectLinkResult;
    }
  | {
      readonly kind: "pipedream-privileged-reply";
      readonly replyTo: string;
      readonly ok: false;
      readonly error: string;
    };

export function isPipedreamPrivilegedBootstrapMessage(
  value: unknown,
): value is PipedreamPrivilegedBootstrapMessage {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["kind", "payload"]) ||
    value.kind !== "pipedream-privileged-bootstrap"
  )
    return false;
  const payload = value.payload;
  if (
    !isRecord(payload) ||
    !hasOnlyKeys(payload, ["bootstrap", "externalUserId"]) ||
    !isBoundedString(payload.externalUserId, 250)
  )
    return false;
  return isPipedreamBootstrap(payload.bootstrap);
}

export function isPipedreamPrivilegedConnectLinkRequest(
  value: unknown,
): value is PipedreamPrivilegedConnectLinkRequest {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["kind", "id", "request"]) ||
    value.kind !== "pipedream-privileged-request"
  )
    return false;
  if (
    !isBoundedString(value.id, 256) ||
    !isRecord(value.request) ||
    !hasOnlyKeys(value.request, ["type", "appSlug"])
  )
    return false;
  return (
    value.request.type === "create-connect-link" &&
    typeof value.request.appSlug === "string" &&
    /^[a-z0-9][a-z0-9_-]{0,127}$/.test(value.request.appSlug)
  );
}

function isPipedreamBootstrap(value: unknown): value is PipedreamBootstrap {
  if (!isRecord(value)) return false;
  if (value.state === "absent") return Object.keys(value).length === 1;
  if (value.state === "partial") {
    return (
      hasOnlyKeys(value, ["state", "missingKeys"]) &&
      Array.isArray(value.missingKeys) &&
      value.missingKeys.every((key) => PIPEDREAM_KEYS.has(key as PipedreamEnvKey))
    );
  }
  return (
    hasOnlyKeys(value, ["state", "source", "credentials"]) &&
    value.state === "ready" &&
    value.source === "environment" &&
    isPipedreamCredentials(value.credentials)
  );
}

function isPipedreamCredentials(value: unknown): value is PipedreamBootstrapCredentials {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["clientId", "clientSecret", "projectId", "environment"]) &&
    isBoundedString(value.clientId, 4_096) &&
    isBoundedString(value.clientSecret, 16_384) &&
    typeof value.projectId === "string" &&
    /^proj_[a-zA-Z0-9]+$/.test(value.projectId) &&
    (value.environment === "development" || value.environment === "production")
  );
}

const PIPEDREAM_KEYS = new Set<PipedreamEnvKey>([
  "PIPEDREAM_CLIENT_ID",
  "PIPEDREAM_CLIENT_SECRET",
  "PIPEDREAM_PROJECT_ID",
  "PIPEDREAM_ENVIRONMENT",
]);

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}
