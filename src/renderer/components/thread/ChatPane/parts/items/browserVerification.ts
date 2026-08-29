import type { ToolCallPayload } from "@/shared/contracts";
import {
  Y_SPACE_BROWSER_EVIDENCE_SOURCE,
  browserEvidenceActionKind,
  type BrowserEvidenceActionKind,
} from "@/shared/browserMcpEvidence";
import type { RuntimeChatItem } from "@/renderer/state/slices/runtimeEventSlice";

export type BrowserVerificationBadgeState =
  | { kind: "verified"; actionCount: number }
  | { kind: "unverified" }
  | null;

interface BrowserClaimRequirement {
  actionKind: BrowserEvidenceActionKind;
  tabIds: readonly string[];
  origins: readonly string[];
}

interface AppOwnedBrowserEvidence {
  actionKind: BrowserEvidenceActionKind;
  tabId?: string;
  origin?: string;
}

/**
 * Resolve proof for the final response's own user turn. Only the app-owned
 * marker counts; provider-authored Browser-looking tool rows are not proof.
 */
export function resolveBrowserVerificationBadge(
  items: Record<string, RuntimeChatItem> | undefined,
  itemIds: readonly string[] | undefined,
  finalItemIds: readonly string[],
  finalText: string,
): BrowserVerificationBadgeState {
  const claimRequirement = browserClaimRequirement(finalText);
  if (!items || !itemIds?.length || finalItemIds.length === 0) {
    return claimRequirement ? { kind: "unverified" } : null;
  }
  let finalStart = itemIds.length;
  let finalEnd = -1;
  for (const finalItemId of finalItemIds) {
    const index = itemIds.indexOf(finalItemId);
    if (index >= 0) {
      finalStart = Math.min(finalStart, index);
      finalEnd = Math.max(finalEnd, index);
    }
  }
  if (finalStart === itemIds.length) return null;

  let turnStart = 0;
  for (let index = finalStart - 1; index >= 0; index -= 1) {
    const item = items[itemIds[index]!];
    if (item?.type === "user_message" || item?.type === "question_answer") {
      turnStart = index + 1;
      break;
    }
  }
  let turnEnd = itemIds.length;
  for (let index = finalEnd + 1; index < itemIds.length; index += 1) {
    const item = items[itemIds[index]!];
    if (item?.type === "user_message" || item?.type === "question_answer") {
      turnEnd = index;
      break;
    }
  }

  const evidence: AppOwnedBrowserEvidence[] = [];
  for (let index = turnStart; index < turnEnd; index += 1) {
    const item = items[itemIds[index]!];
    if (!item || item.parentItemId) continue;
    const action = appOwnedBrowserEvidence(item);
    if (action) evidence.push(action);
  }
  if (evidence.length === 0) return claimRequirement ? { kind: "unverified" } : null;
  if (claimRequirement) {
    const matchingActions = evidence.filter((entry) =>
      satisfiesClaim(entry.actionKind, claimRequirement.actionKind),
    );
    if (
      matchingActions.length === 0 ||
      !evidenceMatchesClaimReferences(matchingActions, claimRequirement)
    ) {
      return { kind: "unverified" };
    }
  }
  return { kind: "verified", actionCount: evidence.length };
}

export function claimsBrowserVerification(text: string): boolean {
  return browserClaimRequirement(text) !== null;
}

function browserClaimRequirement(text: string): BrowserClaimRequirement | null {
  const origins = extractClaimedHttpOrigins(text);
  const tabIds = extractClaimedBrowserTabIds(text);
  // Bare "tab" and "page" are intentionally excluded: Y Space also opens
  // files, PDFs, spreadsheets, and other non-browser surfaces in global tabs.
  const surface = "(?:browser(?:\\s+tab)?|website|webpage|web\\s+page|site)";
  const matches = (action: string) =>
    new RegExp(
      `(?:\\b(?:${action})\\b[\\s\\S]{0,96}\\b${surface}\\b|\\b${surface}\\b[\\s\\S]{0,96}\\b(?:${action})\\b)`,
      "iu",
    ).test(text);
  const hasReferences = tabIds.length > 0 || origins.length > 0;
  const textWithoutReferences = removeBrowserClaimReferences(text);
  const mentionsReferencedAction = (action: string) =>
    hasReferences && new RegExp(`\\b(?:${action})\\b`, "iu").test(textWithoutReferences);
  const interaction = "(?:click(?:s|ed|ing)?|fill(?:s|ed|ing)?|submit(?:s|ted|ting)?)";
  const inspection =
    "(?:verif(?:y|ies|ied|ying|ication(?:s)?)|test(?:s|ed|ing)?|check(?:s|ed|ing)?|confirm(?:s|ed|ing|ation(?:s)?)|inspect(?:s|ed|ing|ion(?:s)?))";
  const navigation =
    "(?:open(?:s|ed|ing)?|navigat(?:e|es|ed|ing|ion(?:s)?)|visit(?:s|ed|ing)?|load(?:s|ed|ing)?)";
  let actionKind: BrowserEvidenceActionKind | null = null;
  if (matches(interaction) || mentionsReferencedAction(interaction)) actionKind = "interaction";
  else if (matches(inspection) || mentionsReferencedAction(inspection)) actionKind = "inspection";
  // A concise provider final can refer back to Browser work simply as
  // "Verification succeeded." Treat that success assertion as an inspection
  // claim so it cannot evade the unverified badge by using a noun form.
  else if (
    /\bverification\b[\s\S]{0,48}\b(?:succeed(?:s|ed|ing)?|successful|passed|complet(?:e|ed))\b/iu.test(
      text,
    )
  ) {
    actionKind = "inspection";
  }
  if (!actionKind && (matches(navigation) || mentionsReferencedAction(navigation))) {
    actionKind = "navigation";
  }
  if (!actionKind && tabIds.length === 0 && origins.length === 0) return null;
  return {
    // Reporting a URL or Browser tab is itself a Browser result claim. Any
    // substantive Browser action may support it, but setup/control calls may
    // not because they never enter the evidence list above.
    actionKind: actionKind ?? "navigation",
    tabIds,
    origins,
  };
}

export function isAppOwnedBrowserEvidenceItem(item: RuntimeChatItem | undefined): boolean {
  if (item?.type !== "mcp_tool_call" || item.state !== "completed") return false;
  const payload = item.payload as ToolCallPayload | undefined;
  return (
    payload?.serverId === "browser" &&
    payload.status === "success" &&
    payload.browserEvidence?.source === Y_SPACE_BROWSER_EVIDENCE_SOURCE
  );
}

function appOwnedBrowserEvidence(item: RuntimeChatItem): AppOwnedBrowserEvidence | null {
  if (!isAppOwnedBrowserEvidenceItem(item)) return null;
  const payload = item.payload as ToolCallPayload;
  const actionKind = browserEvidenceActionKind(payload.name);
  if (!actionKind) return null;
  const tabId = payload.browserEvidence?.tabId?.trim();
  const origin = normalizeHttpOrigin(payload.browserEvidence?.url);
  return {
    actionKind,
    ...(tabId ? { tabId } : {}),
    ...(origin ? { origin } : {}),
  };
}

function satisfiesClaim(
  actionKind: BrowserEvidenceActionKind,
  requirement: BrowserEvidenceActionKind,
): boolean {
  if (requirement === "navigation") return true;
  if (requirement === "inspection") return actionKind !== "navigation";
  return actionKind === "interaction";
}

function evidenceMatchesClaimReferences(
  evidence: readonly AppOwnedBrowserEvidence[],
  requirement: BrowserClaimRequirement,
): boolean {
  const { origins, tabIds } = requirement;
  if (origins.length === 0 && tabIds.length === 0) return true;
  if (origins.length === 0) {
    return tabIds.every((tabId) => evidence.some((entry) => entry.tabId === tabId));
  }
  if (tabIds.length === 0) {
    return origins.every((origin) => evidence.some((entry) => entry.origin === origin));
  }

  // When the final reports both dimensions, bind them on the same authenticated
  // action. Otherwise evidence from tab A and unrelated origin B could be
  // stitched together into a false verified result.
  return (
    tabIds.every((tabId) =>
      evidence.some(
        (entry) => entry.tabId === tabId && !!entry.origin && origins.includes(entry.origin),
      ),
    ) &&
    origins.every((origin) =>
      evidence.some(
        (entry) => entry.origin === origin && !!entry.tabId && tabIds.includes(entry.tabId),
      ),
    )
  );
}

function extractClaimedHttpOrigins(text: string): string[] {
  const origins = new Set<string>();
  for (const match of text.matchAll(/\bhttps?:\/\/[^\s<>"'`]+/giu)) {
    const origin = normalizeHttpOrigin(trimUrlProseSuffix(match[0]));
    if (origin) origins.add(origin);
  }
  return [...origins];
}

function extractClaimedBrowserTabIds(text: string): string[] {
  // Exclude URL bodies first: a path such as `/tabs/tab-history` names a route,
  // not an app Browser tab identity.
  const withoutUrls = text.replace(/\bhttps?:\/\/[^\s<>"'`]+/giu, (url) => " ".repeat(url.length));
  return [...new Set(withoutUrls.match(/\btab-[a-z0-9](?:[a-z0-9_-]{0,253}[a-z0-9])?\b/giu) ?? [])];
}

function removeBrowserClaimReferences(text: string): string {
  return text
    .replace(/\bhttps?:\/\/[^\s<>"'`]+/giu, (url) => " ".repeat(url.length))
    .replace(/\btab-[a-z0-9](?:[a-z0-9_-]{0,253}[a-z0-9])?\b/giu, (tabId) =>
      " ".repeat(tabId.length),
    );
}

function normalizeHttpOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function trimUrlProseSuffix(value: string): string {
  let trimmed = value;
  while (/[.,;:!?}]/u.test(trimmed.at(-1) ?? "")) trimmed = trimmed.slice(0, -1);
  while (trimmed.endsWith(")") && countCharacter(trimmed, ")") > countCharacter(trimmed, "(")) {
    trimmed = trimmed.slice(0, -1);
  }
  while (trimmed.endsWith("]") && countCharacter(trimmed, "]") > countCharacter(trimmed, "[")) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

function countCharacter(value: string, character: string): number {
  return value.split(character).length - 1;
}
