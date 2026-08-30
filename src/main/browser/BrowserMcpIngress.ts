import type { McpThreadIdentity } from "@/shared/browserMcpThread";
import {
  MAX_BROWSER_EVIDENCE_TAB_ID_LENGTH,
  MAX_BROWSER_EVIDENCE_TOOL_NAME_LENGTH,
  MAX_BROWSER_EVIDENCE_URL_LENGTH,
  type BrowserMcpSafeTabEvidence,
  type BrowserMcpToolCallReport,
} from "@/shared/browserMcpEvidence";
import type { BrowserPanelManager } from "./BrowserPanelManager";
import {
  StreamableHttpMcpIngress,
  type McpLaunchContextIdentityResolver,
  type StreamableHttpMcpIngressInfo,
  type StreamableHttpMcpToolCallOutcome,
} from "../mcp/StreamableHttpMcpIngress";
import {
  BROWSER_MCP_INSTRUCTIONS,
  TOOLS,
  dispatchTool,
  formatToolResult,
  isKnownToolName,
  normalizeToolName,
  type ToolContext,
} from "./mcp/toolRegistry";

export type BrowserMcpIngressInfo = StreamableHttpMcpIngressInfo;

export interface BrowserMcpIngressOptions {
  resolveLaunchContextIdentity: McpLaunchContextIdentityResolver;
  /** Private main -> supervisor proof path. Never receives tool args or page content. */
  onToolCallReport?(report: BrowserMcpToolCallReport): Promise<void> | void;
}

/**
 * Single in-process MCP server. Speaks Streamable-HTTP MCP at `POST /mcp`
 * (JSON-RPC body, single JSON response). All five agent providers connect
 * here by URL — no per-thread Node child process. The transport is shared
 * with the computer-use ingress via {@link StreamableHttpMcpIngress}.
 */
export class BrowserMcpIngress {
  private allowEval = false;
  private allowDataAccess = false;
  private getManager: (() => BrowserPanelManager | null) | null = null;
  private readonly ingress: StreamableHttpMcpIngress<ToolContext>;

  constructor(options: BrowserMcpIngressOptions) {
    this.ingress = new StreamableHttpMcpIngress<ToolContext>({
      launchContextAudience: "browser",
      resolveLaunchContextIdentity: options.resolveLaunchContextIdentity,
      serverInfo: { name: "browser", version: "2.0.0" },
      instructions: BROWSER_MCP_INSTRUCTIONS,
      tools: TOOLS,
      isKnownToolName,
      // Dispatch keeps passive inspection resident in the background and
      // presents only the exact tab used by an interactive pointer action.
      buildContext: (identity) => this.buildContext(identity),
      contextUnavailableMessage: "browser panel not ready",
      dispatchTool,
      formatToolResult,
      onAfterToolCall: (outcome, ctx, identity) =>
        this.reportToolCall(options, outcome, ctx, identity),
    });
  }

  setManagerAccessor(getter: () => BrowserPanelManager | null): void {
    this.getManager = getter;
  }

  setAllowEval(allow: boolean): void {
    this.allowEval = allow;
  }

  setAllowDataAccess(allow: boolean): void {
    this.allowDataAccess = allow;
  }

  start(): Promise<BrowserMcpIngressInfo> {
    return this.ingress.start();
  }

  getInfo(): BrowserMcpIngressInfo | null {
    return this.ingress.getInfo();
  }

  dispose(): void {
    this.ingress.dispose();
  }

  private buildContext(identity: McpThreadIdentity): ToolContext | null {
    const manager = this.getManager?.();
    if (!manager) return null;
    return {
      manager,
      allowEval: this.allowEval,
      allowDataAccess: this.allowDataAccess,
      ...(identity.launchId ? { launchId: identity.launchId } : {}),
      ...(identity.threadId ? { threadId: identity.threadId } : {}),
      ...(identity.title ? { threadTitle: identity.title } : {}),
    };
  }

  private async reportToolCall(
    options: BrowserMcpIngressOptions,
    outcome: StreamableHttpMcpToolCallOutcome,
    ctx: ToolContext,
    identity: McpThreadIdentity,
  ): Promise<void> {
    if (
      !options.onToolCallReport ||
      !identity.threadId ||
      !identity.launchId ||
      !identity.browserEvidenceTurnId
    ) {
      return;
    }
    const successfulProof = outcome.success && !isUnsuccessfulProofResult(outcome.rawResult);
    const report: BrowserMcpToolCallReport = {
      threadId: identity.threadId,
      launchId: identity.launchId,
      turnId: identity.browserEvidenceTurnId,
      toolName: boundText(normalizeToolName(outcome.name), MAX_BROWSER_EVIDENCE_TOOL_NAME_LENGTH),
      success: successfulProof,
      occurredAt: outcome.occurredAt,
      ...(successfulProof ? extractSafeTabEvidence(outcome.rawResult, ctx) : {}),
    };
    await options.onToolCallReport(report);
  }
}

/**
 * Reduce an arbitrary in-process tool result to metadata read back from the
 * app's authoritative tab object. We never forward args, raw results, DOM
 * snapshots, screenshots, console output, titles, URL paths/queries, or other
 * page content.
 */
function extractSafeTabEvidence(rawResult: unknown, ctx: ToolContext): BrowserMcpSafeTabEvidence {
  const tabId = readResultTabId(rawResult) ?? ctx.resolvedTabIdForToolCall;
  const tab = tabId ? ctx.manager.getTab(tabId) : null;
  if (!tab) return {};
  try {
    const snapshot = tab.snapshot();
    const safeUrl = snapshot.url ? sanitizeEvidenceUrl(snapshot.url) : undefined;
    return {
      tabId: boundText(tab.tabId, MAX_BROWSER_EVIDENCE_TAB_ID_LENGTH),
      ...(safeUrl ? { url: safeUrl } : {}),
    };
  } catch {
    return { tabId: boundText(tab.tabId, MAX_BROWSER_EVIDENCE_TAB_ID_LENGTH) };
  }
}

function isUnsuccessfulProofResult(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return result.timedOut === true || result.ambiguous === true;
}

function readResultTabId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const nested =
    record.tab && typeof record.tab === "object"
      ? (record.tab as Record<string, unknown>).tabId
      : undefined;
  for (const candidate of [record.tabId, nested, record.implicitTabId, record.activeTabId]) {
    if (typeof candidate === "string" && candidate.trim()) {
      return boundText(candidate, MAX_BROWSER_EVIDENCE_TAB_ID_LENGTH);
    }
  }
  return undefined;
}

function boundText(value: string, maxLength: number): string {
  return value.trim().slice(0, maxLength);
}

/** Persist only an HTTP(S) origin; paths, queries, fragments, and credentials are private. */
function sanitizeEvidenceUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  return boundText(url.origin, MAX_BROWSER_EVIDENCE_URL_LENGTH) || undefined;
}
