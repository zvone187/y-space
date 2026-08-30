import type { ToolCallPayload } from "@/shared/contracts";
import {
  BROWSER_EVIDENCE_CAP_INVALIDATION_TOOL,
  Y_SPACE_BROWSER_EVIDENCE_SOURCE,
  browserEvidenceActionKind,
  isBrowserEvidenceStateBoundary,
  type BrowserEvidenceActionKind,
} from "@/shared/browserMcpEvidence";
import type { RuntimeChatItem } from "@/renderer/state/slices/runtimeEventSlice";

export type BrowserVerificationBadgeState =
  | { kind: "verified"; actionCount: number }
  | { kind: "unverified" }
  | null;

type BrowserClaimFacet = BrowserEvidenceActionKind | "page_metadata";

interface BrowserClaimRequirement {
  actionFacets: readonly BrowserClaimFacet[];
  tabIds: readonly string[];
  origins: readonly string[];
}

interface AppOwnedBrowserEvidence {
  actionKind: BrowserEvidenceActionKind;
  tabId?: string;
  origin?: string;
}

interface PositionedBrowserEvidence extends AppOwnedBrowserEvidence {
  position: number;
}

interface BrowserFailure {
  actionKind: BrowserEvidenceActionKind;
  position: number;
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

  const evidence: PositionedBrowserEvidence[] = [];
  const failures: BrowserFailure[] = [];
  const tabStateBoundaryPositions: number[] = [];
  const globalInvalidationPositions: number[] = [];
  for (let index = turnStart; index < turnEnd; index += 1) {
    const item = items[itemIds[index]!];
    if (!item || item.parentItemId) continue;
    const action = appOwnedBrowserEvidence(item);
    if (action) evidence.push({ ...action, position: index });
    const failureKind = appOwnedBrowserFailureKind(item);
    if (failureKind) failures.push({ actionKind: failureKind, position: index });
    if (isAppOwnedBrowserStateBoundaryItem(item)) tabStateBoundaryPositions.push(index);
    if (isAppOwnedBrowserGlobalInvalidationItem(item)) globalInvalidationPositions.push(index);
  }

  if (!claimRequirement) {
    const lastInvalidationPosition = Math.max(
      failures.at(-1)?.position ?? -1,
      tabStateBoundaryPositions.at(-1) ?? -1,
      globalInvalidationPositions.at(-1) ?? -1,
    );
    const suffix = evidence.filter((entry) => entry.position > lastInvalidationPosition);
    if (lastInvalidationPosition >= 0 && evidence.length > 0 && suffix.length === 0) {
      return { kind: "unverified" };
    }
    return suffix.length > 0 ? { kind: "verified", actionCount: suffix.length } : null;
  }

  const proof = new Set<PositionedBrowserEvidence>();
  for (const requiredFacet of claimRequirement.actionFacets) {
    const lastRelevantFailurePosition = failures.reduce(
      (latest, failure) =>
        failureIsRelevantToFacet(failure.actionKind, requiredFacet)
          ? Math.max(latest, failure.position)
          : latest,
      -1,
    );
    const lastGlobalInvalidationPosition = globalInvalidationPositions.at(-1) ?? -1;
    const lastPageChangingOutcomePosition =
      requiredFacet === "page_metadata"
        ? Math.max(
            evidence.reduce(
              (latest, entry) =>
                entry.actionKind === "navigation" || entry.actionKind === "interaction"
                  ? Math.max(latest, entry.position)
                  : latest,
              -1,
            ),
            failures.reduce(
              (latest, failure) =>
                failure.actionKind === "navigation" || failure.actionKind === "interaction"
                  ? Math.max(latest, failure.position)
                  : latest,
              -1,
            ),
            tabStateBoundaryPositions.at(-1) ?? -1,
          )
        : -1;
    const proofBoundary = Math.max(
      lastRelevantFailurePosition,
      lastPageChangingOutcomePosition,
      lastGlobalInvalidationPosition,
    );
    const matchingActions = evidence.filter(
      (entry) =>
        entry.position > proofBoundary && evidenceSatisfiesFacet(entry.actionKind, requiredFacet),
    );
    if (
      matchingActions.length === 0 ||
      !evidenceMatchesClaimReferences(matchingActions, claimRequirement)
    ) {
      return { kind: "unverified" };
    }
    for (const action of matchingActions) proof.add(action);
  }
  return { kind: "verified", actionCount: proof.size };
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
  const interaction =
    "(?:double(?:-|\\s)?click(?:s|ed|ing)?|click(?:s|ed|ing)?|focus(?:es|ed|ing)?|typ(?:e|es|ed|ing)|fill(?:s|ed|ing)?|submit(?:s|ted|ting)?|select(?:s|ed|ing)?|press(?:es|ed|ing)?|hover(?:s|ed|ing)?|scroll(?:s|ed|ing)?|toggl(?:e|es|ed|ing)|accept(?:s|ed|ing)?|dismiss(?:es|ed|ing)?|evaluat(?:e|es|ed|ing)|(?:add(?:s|ed|ing)?|inject(?:s|ed|ing)?)[\\s\\S]{0,24}(?:script|style))";
  // "Checked the website" means inspection, while checking a form control is
  // native interaction. Require a nearby control noun to keep that distinction.
  const controlToggle =
    "(?:(?:un)?check(?:s|ed|ing)?\\b[\\s\\S]{0,40}\\b(?:checkbox|radio|switch|toggle|option|control)|(?:checkbox|radio|switch|toggle|option|control)\\b[\\s\\S]{0,40}\\b(?:un)?check(?:s|ed|ing)?)";
  const inspection =
    "(?:verif(?:y|ies|ied|ying|ication(?:s)?)|test(?:s|ed|ing)?|check(?:s|ed|ing)?|confirm(?:s|ed|ing|ation(?:s)?)|inspect(?:s|ed|ing|ion(?:s)?))";
  const navigation =
    "(?:open(?:s|ed|ing)?|navigat(?:e|es|ed|ing|ion(?:s)?)|visit(?:s|ed|ing)?|load(?:s|ed|ing)?)";
  const actionFacets = new Set<BrowserClaimFacet>();
  if (
    matches(interaction) ||
    mentionsReferencedAction(interaction) ||
    matches(controlToggle) ||
    mentionsReferencedAction(controlToggle)
  ) {
    actionFacets.add("interaction");
  }
  if (matches(inspection) || mentionsReferencedAction(inspection)) actionFacets.add("inspection");
  // A concise provider final can refer back to Browser work simply as
  // "Verification succeeded." Treat that success assertion as an inspection
  // claim so it cannot evade the unverified badge by using a noun form.
  if (
    /\bverification\b[\s\S]{0,48}\b(?:succeed(?:s|ed|ing)?|successful|passed|complet(?:e|ed))\b/iu.test(
      text,
    )
  ) {
    actionFacets.add("inspection");
  }
  if (matches(navigation) || mentionsReferencedAction(navigation)) {
    actionFacets.add("navigation");
  }
  // A provider that reports final/current page metadata is asserting a read of
  // the post-action Browser state, not merely that some earlier action ran.
  // Keep this as a separate facet so a failed wait must be recovered by an
  // authoritative get_url/get_title/snapshot-style inspection.
  const pageMetadataClaim =
    /(?:\b(?:final|current)\s+(?:browser\s+)?(?:url|title)\b|\b(?:browser\s+)?(?:url|title)\s*:)/iu.test(
      text,
    );
  const explicitlyBrowserMetadata =
    /(?:\b(?:final|current)\s+browser\s+(?:url|title)\b|\bbrowser\s+(?:url|title)\s*:)/iu.test(
      text,
    );
  if (pageMetadataClaim && (hasReferences || actionFacets.size > 0 || explicitlyBrowserMetadata)) {
    actionFacets.add("page_metadata");
  }
  if (actionFacets.size === 0 && hasReferences) actionFacets.add("navigation");
  if (actionFacets.size === 0) return null;
  return {
    // Reporting a URL or Browser tab is itself a Browser result claim. Any
    // substantive Browser action may support it, but setup/control calls may
    // not because they never enter the evidence list above.
    actionFacets: [...actionFacets],
    tabIds,
    origins,
  };
}

export function isAppOwnedBrowserEvidenceItem(item: RuntimeChatItem | undefined): boolean {
  if (!isAppOwnedBrowserOutcomeItem(item)) return false;
  return item.payload.status === "success";
}

/** Any canonical Browser result, including a negative result reported after a
 * provider final. Both outcomes are logical turn metadata rather than later
 * provider work, but only successful outcomes can satisfy verification. */
export function isAppOwnedBrowserOutcomeItem(
  item: RuntimeChatItem | undefined,
): item is RuntimeChatItem & { payload: ToolCallPayload } {
  if (item?.type !== "mcp_tool_call" || item.state !== "completed") return false;
  const payload = item.payload as ToolCallPayload | undefined;
  return (
    payload?.serverId === "browser" &&
    (payload.status === "success" || payload.status === "error") &&
    payload.browserEvidence?.source === Y_SPACE_BROWSER_EVIDENCE_SOURCE
  );
}

function isAppOwnedBrowserStateBoundaryItem(item: RuntimeChatItem | undefined): boolean {
  return isAppOwnedBrowserOutcomeItem(item) && isBrowserEvidenceStateBoundary(item.payload.name);
}

function isAppOwnedBrowserGlobalInvalidationItem(item: RuntimeChatItem | undefined): boolean {
  return (
    isAppOwnedBrowserOutcomeItem(item) &&
    item.payload.name === BROWSER_EVIDENCE_CAP_INVALIDATION_TOOL
  );
}

function appOwnedBrowserFailureKind(
  item: RuntimeChatItem | undefined,
): BrowserEvidenceActionKind | null {
  if (!isAppOwnedBrowserOutcomeItem(item)) return null;
  const payload = item.payload;
  return payload.status === "error" ? browserEvidenceActionKind(payload.name) : null;
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

function evidenceSatisfiesFacet(
  actionKind: BrowserEvidenceActionKind,
  facet: BrowserClaimFacet,
): boolean {
  return facet === "page_metadata"
    ? actionKind === "inspection"
    : satisfiesClaim(actionKind, facet);
}

function failureIsRelevantToFacet(
  actionKind: BrowserEvidenceActionKind,
  facet: BrowserClaimFacet,
): boolean {
  return facet === "page_metadata"
    ? actionKind === "inspection"
    : satisfiesClaim(actionKind, facet);
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
  const candidates = [
    ...withoutUrls.matchAll(/\btab-[a-z0-9](?:[a-z0-9_-]{0,253}[a-z0-9])?\b/giu),
  ].map((match) => {
    const tabId = match[0];
    const suffix = withoutUrls.slice((match.index ?? 0) + tabId.length);
    return { tabId, truncated: /^[-_]?(?:\.{3}|…)/u.test(suffix) };
  });
  const tabIds = new Set(
    candidates.filter(({ truncated }) => !truncated).map(({ tabId }) => tabId),
  );
  for (const { tabId, truncated } of candidates) {
    if (!truncated) continue;
    // Providers sometimes repeat an authenticated ID in shortened form such
    // as `tab-acf68c7a-...`. Ignore that occurrence only when another exact
    // claimed ID proves what it abbreviates; never authenticate by prefix.
    const repeatsExactId = [...tabIds].some(
      (exactTabId) => exactTabId.startsWith(`${tabId}-`) || exactTabId.startsWith(`${tabId}_`),
    );
    if (!repeatsExactId) tabIds.add(`${tabId}-…`);
  }
  return [...tabIds];
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
