import { createHmac, timingSafeEqual } from "node:crypto";
import type { McpThreadIdentity } from "./browserMcpThread";

export type McpLaunchContextAudience = "browser" | "computer-use" | "app-controls";
export type McpLaunchContextRouting = "thread";

export interface McpLaunchContext {
  routing: "thread";
  identity: McpThreadIdentity;
}

interface SerializedMcpLaunchContext {
  v: 1;
  audience: McpLaunchContextAudience;
  routing: McpLaunchContextRouting;
  threadId?: string;
  launchId?: string;
  title?: string;
  disabledTools?: string[];
}

const TOKEN_PREFIX = "yspace-mcp-v1";
export const MCP_LAUNCH_CONTEXT_HEADER = "x-y-space-mcp-context";
const MAX_THREAD_ID_LENGTH = 1024;
const MAX_LAUNCH_ID_LENGTH = 128;
const MAX_TITLE_LENGTH = 80;
const MAX_DISABLED_TOOLS = 512;
const MAX_TOOL_NAME_LENGTH = 256;
const MAX_PAYLOAD_LENGTH = 128 * 1024;

/**
 * Mint a provider credential whose routing identity and tool policy are
 * authenticated by the ingress root secret. The root secret stays inside the
 * main/supervisor trust boundary; agents receive only this scoped capability.
 */
export function createMcpLaunchContextToken(
  rootToken: string,
  audience: McpLaunchContextAudience,
  identity: McpThreadIdentity,
): string {
  if (!rootToken) throw new Error("MCP launch context root token is required");

  const threadId = normalizeNonEmptyString(identity?.threadId, MAX_THREAD_ID_LENGTH);
  const launchId = normalizeNonEmptyString(identity?.launchId, MAX_LAUNCH_ID_LENGTH);
  const title = normalizeNonEmptyString(identity?.title, MAX_TITLE_LENGTH);
  const disabledTools = normalizeDisabledTools(identity?.disabledTools);
  if (!threadId) throw new Error("MCP launch context requires a thread identity");
  const payload: SerializedMcpLaunchContext = {
    v: 1,
    audience,
    routing: "thread",
    threadId,
    ...(launchId ? { launchId } : {}),
    ...(title ? { title } : {}),
    ...(disabledTools.length > 0 ? { disabledTools } : {}),
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = sign(rootToken, encoded);
  return `${TOKEN_PREFIX}.${encoded}.${signature}`;
}

/** Verify and decode a scoped credential. Invalid or cross-ingress tokens fail closed. */
export function verifyMcpLaunchContextToken(
  rootToken: string,
  audience: McpLaunchContextAudience,
  token: string,
): McpLaunchContext | undefined {
  if (!rootToken || !token || token.length > MAX_PAYLOAD_LENGTH) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return undefined;
  const encoded = parts[1];
  const suppliedSignature = parts[2];
  if (!encoded || !suppliedSignature) return undefined;
  const expectedSignature = sign(rootToken, encoded);
  if (!constantTimeEquals(suppliedSignature, expectedSignature)) return undefined;

  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.v !== 1 || value.audience !== audience) return undefined;
  if (value.routing !== "thread") return undefined;

  const threadId = readBoundedString(value.threadId, MAX_THREAD_ID_LENGTH);
  const launchId = readBoundedString(value.launchId, MAX_LAUNCH_ID_LENGTH);
  const title = readBoundedString(value.title, MAX_TITLE_LENGTH);
  const disabledTools = readDisabledTools(value.disabledTools);
  if (threadId === null || launchId === null || title === null || disabledTools === null) {
    return undefined;
  }
  if (!threadId) return undefined;

  return {
    routing: "thread",
    identity: {
      threadId,
      ...(launchId ? { launchId } : {}),
      ...(title ? { title } : {}),
      ...(disabledTools.length > 0 ? { disabledTools } : {}),
    },
  };
}

function sign(rootToken: string, encodedPayload: string): string {
  return createHmac("sha256", rootToken).update(encodedPayload).digest("base64url");
}

function constantTimeEquals(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function normalizeNonEmptyString(value: string | undefined, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().slice(0, maxLength);
  return normalized || undefined;
}

function normalizeDisabledTools(tools: readonly string[] | undefined): string[] {
  if (!tools) return [];
  const normalized = new Set<string>();
  for (const tool of tools) {
    const name = normalizeNonEmptyString(tool, MAX_TOOL_NAME_LENGTH);
    if (name) normalized.add(name);
    if (normalized.size >= MAX_DISABLED_TOOLS) break;
  }
  return [...normalized];
}

function readBoundedString(value: unknown, maxLength: number): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return null;
  return value;
}

function readDisabledTools(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_DISABLED_TOOLS) return null;
  const tools: string[] = [];
  for (const tool of value) {
    if (typeof tool !== "string" || tool.length === 0 || tool.length > MAX_TOOL_NAME_LENGTH) {
      return null;
    }
    tools.push(tool);
  }
  return [...new Set(tools)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
