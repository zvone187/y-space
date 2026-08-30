/** Privacy-bounded metadata emitted only after the app-owned Browser MCP runs. */
export interface BrowserMcpSafeTabEvidence {
  tabId?: string | undefined;
  url?: string | undefined;
  title?: string | undefined;
}

/** Main-process report delivered over the private main -> supervisor IPC. */
export interface BrowserMcpToolCallReport extends BrowserMcpSafeTabEvidence {
  threadId: string;
  launchId: string;
  turnId: string;
  toolName: string;
  success: boolean;
  occurredAt: number;
}

export const MAX_BROWSER_EVIDENCE_TOOL_NAME_LENGTH = 128;
export const MAX_BROWSER_EVIDENCE_TAB_ID_LENGTH = 256;
export const MAX_BROWSER_EVIDENCE_URL_LENGTH = 2_048;
export const MAX_BROWSER_EVIDENCE_TITLE_LENGTH = 256;
export const MAX_BROWSER_EVIDENCE_ACTIONS_PER_TURN = 64;
export const MAX_BROWSER_EVIDENCE_THREADS = 256;

/** Marker stored on canonical Browser outcomes; provider-authored rows cannot forge it. */
export const Y_SPACE_BROWSER_EVIDENCE_SOURCE = "y-space-browser-mcp" as const;

export type BrowserEvidenceActionKind = "navigation" | "inspection" | "interaction";

const NAVIGATION_TOOLS = new Set([
  "new_tab",
  "open",
  "open_or_focus_tab",
  "navigate",
  "back",
  "forward",
  "reload",
]);

const INSPECTION_TOOLS = new Set([
  "screenshot",
  "query",
  "wait_for",
  "snapshot",
  "inspect",
  "get",
  "is",
  "find",
  "wait_for_url",
  "wait_for_text",
  "wait_for_js",
  "console",
  "requests",
  "cookies",
  "storage",
  "frames",
]);

const INTERACTION_TOOLS = new Set([
  "click",
  "dblclick",
  "focus",
  "type",
  "fill",
  "check",
  "uncheck",
  "select",
  "eval",
  "hover",
  "press",
  "scroll",
  "dialog",
  "addscript",
  "addstyle",
]);

/**
 * Classify only calls that prove page navigation, inspection, or interaction.
 * Session/control and tab-metadata calls deliberately return null: `enable`,
 * `disable`, `api`, or `list_tabs` alone must never certify a claimed test.
 */
export function browserEvidenceActionKind(toolName: string): BrowserEvidenceActionKind | null {
  if (NAVIGATION_TOOLS.has(toolName)) return "navigation";
  if (INSPECTION_TOOLS.has(toolName)) return "inspection";
  if (INTERACTION_TOOLS.has(toolName)) return "interaction";
  return null;
}
