/** Per-thread identity used by Y Space-owned MCP launch capabilities. */

export interface McpThreadIdentity {
  threadId?: string;
  /** Opaque per-launch nonce used to revoke capabilities across task restarts. */
  launchId?: string;
  /**
   * Live supervisor-owned nonce for the accepted user turn. This value is
   * deliberately excluded from the signed launch token: the ingress receives
   * it only from per-request liveness revalidation, so an agent cannot carry
   * Browser proof from an earlier turn into the current one.
   */
  browserEvidenceTurnId?: string;
  title?: string;
  disabledTools?: readonly string[];
  /** Live, supervisor-derived policy for the Computer Use ingress. Not signed by agents. */
  managedBrowserConnected?: boolean;
}

const MAX_TITLE = 80;

/**
 * Legacy query encoder retained only for the computer-use ingress. Browser and
 * App Controls use signed launch capabilities and must not trust URL identity.
 */
export function encodeThreadQuery(
  baseUrl: string,
  identity: McpThreadIdentity | undefined,
): string {
  if (!identity?.threadId) return baseUrl;
  const sep = baseUrl.includes("?") ? "&" : "?";
  let query = `${sep}thread=${encodeURIComponent(identity.threadId)}`;
  const title = identity.title?.trim();
  if (title) query += `&title=${encodeURIComponent(title.slice(0, MAX_TITLE))}`;
  for (const tool of identity.disabledTools ?? []) {
    query += `&disable=${encodeURIComponent(tool)}`;
  }
  return baseUrl + query;
}

/** Legacy decoder paired with {@link encodeThreadQuery}. */
export function decodeThreadIdentity(url: string | undefined): McpThreadIdentity {
  if (!url) return {};
  try {
    const params = new URL(url, "http://x").searchParams;
    const threadId = params.get("thread") ?? undefined;
    const title = params.get("title") ?? undefined;
    const disabledTools = params.getAll("disable").filter(Boolean);
    return {
      ...(threadId ? { threadId } : {}),
      ...(title ? { title } : {}),
      ...(disabledTools.length > 0 ? { disabledTools } : {}),
    };
  } catch {
    return {};
  }
}

/** Tab-group colors supported by the embedded Browser UI. */
export const THREAD_GROUP_COLORS = [
  "blue",
  "green",
  "orange",
  "cyan",
  "red",
  "yellow",
  "purple",
] as const;
export type ThreadGroupColor = (typeof THREAD_GROUP_COLORS)[number];

/** Stable color for a thread's tab group, hashed from its id. */
export function threadGroupColor(threadId: string): ThreadGroupColor {
  let hash = 0;
  for (let i = 0; i < threadId.length; i++) {
    hash = (hash * 31 + threadId.charCodeAt(i)) >>> 0;
  }
  return THREAD_GROUP_COLORS[hash % THREAD_GROUP_COLORS.length]!;
}
