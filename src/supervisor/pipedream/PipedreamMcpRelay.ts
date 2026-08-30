import { parsePipedreamAppSlug, type PipedreamEnvironment } from "@/shared/contracts/pipedream";

export const PIPEDREAM_MCP_V3_URL = "https://remote.mcp.pipedream.net/v3";

const PROJECT_ID_PATTERN = /^proj_[a-zA-Z0-9]+$/;
const ACCOUNT_ID_PATTERN = /^apn_[a-zA-Z0-9]+$/;
const FORWARDED_MCP_HEADERS = [
  "accept",
  "content-type",
  "mcp-protocol-version",
  "mcp-session-id",
  "last-event-id",
] as const;
const RETRYABLE_READ_METHODS = new Set([
  "initialize",
  "ping",
  "tools/list",
  "resources/list",
  "resources/read",
  "prompts/list",
  "prompts/get",
]);

export interface BuildPipedreamMcpUpstreamHeadersInput {
  readonly incoming: Headers;
  readonly accessToken: string;
  readonly projectId: string;
  readonly environment: PipedreamEnvironment;
  readonly externalUserId: string;
  readonly accountId?: string;
}

/**
 * Builds upstream headers from an allowlist. Inbound authorization and x-pd-*
 * fields are never copied, so an agent cannot select a different identity,
 * project, environment, app, account, or registry.
 */
export function buildPipedreamMcpUpstreamHeaders(
  input: BuildPipedreamMcpUpstreamHeadersInput,
): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_MCP_HEADERS) {
    const value = input.incoming.get(name);
    if (value !== null) headers.set(name, value);
  }

  headers.set("authorization", `Bearer ${requireNonEmpty(input.accessToken, "access token")}`);
  headers.set("x-pd-project-id", requirePattern(input.projectId, PROJECT_ID_PATTERN, "project id"));
  headers.set("x-pd-environment", requireEnvironment(input.environment));
  headers.set(
    "x-pd-external-user-id",
    requireBounded(input.externalUserId, 250, "external user id"),
  );
  headers.set("x-pd-registry", "all");
  if (input.accountId !== undefined) {
    headers.set(
      "x-pd-account-id",
      requirePattern(input.accountId, ACCOUNT_ID_PATTERN, "account id"),
    );
  }
  return headers;
}

/**
 * Pipedream accepts routing fields as either headers or query parameters.
 * Keep the Unicode app slug in the URL so Fetch's ByteString header model
 * cannot reject a valid catalog identifier.
 */
export function buildPipedreamMcpUpstreamUrl(appSlug: string): string {
  const safeAppSlug = parsePipedreamAppSlug(appSlug);
  if (!safeAppSlug) throw new Error("Invalid Pipedream app slug.");
  const url = new URL(PIPEDREAM_MCP_V3_URL);
  url.searchParams.set("app", safeAppSlug);
  return url.toString();
}

export interface PipedreamMcpSessionBinding {
  readonly bindingId: string;
  readonly sessionId: string;
}

export interface PipedreamMcpSessionRegistryOptions {
  readonly maxSessionsPerBinding?: number;
  readonly maxSessionsTotal?: number;
}

const DEFAULT_MAX_SESSIONS_PER_BINDING = 64;
const DEFAULT_MAX_SESSIONS_TOTAL = 4_096;

/** Tracks ownership so an upstream MCP session cannot be replayed by another binding. */
export class PipedreamMcpSessionRegistry {
  readonly #ownerBySessionId = new Map<string, string>();
  readonly #sessionIdsByBinding = new Map<string, Set<string>>();
  readonly #maxSessionsPerBinding: number;
  readonly #maxSessionsTotal: number;

  constructor(options: PipedreamMcpSessionRegistryOptions = {}) {
    this.#maxSessionsPerBinding = requirePositiveInteger(
      options.maxSessionsPerBinding ?? DEFAULT_MAX_SESSIONS_PER_BINDING,
      "per-binding MCP session limit",
    );
    this.#maxSessionsTotal = requirePositiveInteger(
      options.maxSessionsTotal ?? DEFAULT_MAX_SESSIONS_TOTAL,
      "global MCP session limit",
    );
  }

  bind(binding: PipedreamMcpSessionBinding): void {
    const bindingId = requireBounded(binding.bindingId, 256, "relay binding id");
    const sessionId = requireBounded(binding.sessionId, 1_024, "MCP session id");
    const existingOwner = this.#ownerBySessionId.get(sessionId);
    if (existingOwner && existingOwner !== bindingId) {
      throw new Error("Pipedream MCP session is already bound to another relay binding.");
    }
    if (existingOwner === bindingId) return;

    const ownedSessions = this.#sessionIdsByBinding.get(bindingId) ?? new Set<string>();
    if (ownedSessions.size >= this.#maxSessionsPerBinding) {
      throw new Error("Pipedream MCP session limit reached for this relay binding.");
    }
    if (this.#ownerBySessionId.size >= this.#maxSessionsTotal) {
      throw new Error("Pipedream MCP relay session limit reached.");
    }
    this.#ownerBySessionId.set(sessionId, bindingId);
    ownedSessions.add(sessionId);
    this.#sessionIdsByBinding.set(bindingId, ownedSessions);
  }

  owns(binding: PipedreamMcpSessionBinding): boolean {
    const bindingId = binding.bindingId.trim();
    const sessionId = binding.sessionId.trim();
    if (!bindingId || !sessionId) return false;
    return this.#ownerBySessionId.get(sessionId) === bindingId;
  }

  clearSession(binding: PipedreamMcpSessionBinding): boolean {
    const bindingId = binding.bindingId.trim();
    const sessionId = binding.sessionId.trim();
    if (!bindingId || !sessionId || this.#ownerBySessionId.get(sessionId) !== bindingId) {
      return false;
    }

    this.#ownerBySessionId.delete(sessionId);
    const ownedSessions = this.#sessionIdsByBinding.get(bindingId);
    ownedSessions?.delete(sessionId);
    if (ownedSessions?.size === 0) this.#sessionIdsByBinding.delete(bindingId);
    return true;
  }

  clearBinding(bindingId: string): void {
    const normalizedBindingId = bindingId.trim();
    if (!normalizedBindingId) return;
    const ownedSessions = this.#sessionIdsByBinding.get(normalizedBindingId);
    if (!ownedSessions) return;
    for (const sessionId of ownedSessions) this.#ownerBySessionId.delete(sessionId);
    this.#sessionIdsByBinding.delete(normalizedBindingId);
  }

  clear(): void {
    this.#ownerBySessionId.clear();
    this.#sessionIdsByBinding.clear();
  }
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid Pipedream ${label}.`);
  return value;
}

export interface PipedreamUnauthorizedRetryInput {
  readonly status: number;
  readonly jsonRpcMethod: string | undefined;
}

/**
 * A token refresh may replay only side-effect-free MCP requests. In particular,
 * `tools/call` is never retried because the first call may already have run.
 */
export function shouldRetryAfterPipedreamUnauthorized(
  input: PipedreamUnauthorizedRetryInput,
): boolean {
  return input.status === 401 && RETRYABLE_READ_METHODS.has(input.jsonRpcMethod ?? "");
}

function requirePattern(value: string, pattern: RegExp, label: string): string {
  const normalized = value.trim();
  if (!pattern.test(normalized)) throw new Error(`Invalid Pipedream ${label}.`);
  return normalized;
}

function requireNonEmpty(value: string, label: string): string {
  return requireBounded(value, 16_384, label);
}

function requireEnvironment(value: string): PipedreamEnvironment {
  if (value !== "development" && value !== "production") {
    throw new Error("Invalid Pipedream environment.");
  }
  return value;
}

function requireBounded(value: string, maxLength: number, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new Error(`Invalid Pipedream ${label}.`);
  return normalized;
}
