import {
  back,
  clearCookies,
  evalJs,
  evaluateOneShotStyle,
  findByA11y,
  forward,
  getCookies,
  getElementInfo,
  getElementState,
  getFrameTree,
  pageSnapshot,
  querySelectorAllSnapshot,
  setCookie,
  storageClear,
  storageGet,
  storageGetAll,
  storageRemove,
  storageSet,
  waitForJs,
  waitForSelector,
  waitForText,
  waitForUrl,
} from "../../cdp/tools";
import {
  completeCursorAction,
  confirmCursorTarget,
  dispatchNativeFocus,
  dispatchNativeKey,
  dispatchNativeSelect,
  dispatchNativeText,
  dispatchNativeToggle,
  dispatchPointerClick,
  dispatchPointerWheel,
  glideCursorToActiveTarget,
  glideCursorToSelector,
  glideCursorToViewportCenter,
  setCursorOverlayVisible,
  type AgentCursorTarget,
  type NativeInputAuthorization,
  type NativeInputOutcome,
  type NativeKeyboardInputDispatcher,
  type NativeKeyboardInputOptions,
  type NativeSelectMenuKey,
  type NativeSelectMenuKeyDispatcher,
} from "../../cursorOverlay";
import type { AutomationPresentationLease } from "../../BrowserPanelManager";
import {
  agentTabOpts,
  automationSessionId,
  clampInteger,
  requireTab,
  resolveSelectorArg,
  resolveTabId,
} from "./helpers";
import { runScreenshotTool } from "./screenshot";
import { compactToolSpec, normalizeToolName, TOOLS } from "./specs";
import type { ResolvedBrowserTab, ToolContext } from "./types";

const MAX_EVAL_RESULT = 64 * 1024;
const INTERACTIVE_TOOLS = new Set([
  "click",
  "dblclick",
  "focus",
  "type",
  "fill",
  "check",
  "uncheck",
  "select",
  "hover",
  "press",
  "scroll",
]);
const SERIALIZED_BROWSER_TOOLS = new Set([
  ...INTERACTIVE_TOOLS,
  "disable",
  "activate_tab",
  "new_tab",
  "open_or_focus_tab",
  "close_tab",
  "navigate",
  "back",
  "forward",
  "reload",
  "screenshot",
]);
const interactiveQueues = new WeakMap<object, Map<string, Promise<void>>>();
const NATIVE_SELECT_MENU_KEY_SETTLE_MS = 16;
const NATIVE_KEYBOARD_SETTLE_MS = 16;
const NATIVE_TEXT_INPUT_CAP_MS = 2_000;
const NATIVE_DOCUMENT_GUARD_CAP_MS = 750;

const NATIVE_SELECT_MENU_KEY_CODE: Record<NativeSelectMenuKey, string> = {
  ArrowDown: "Down",
  Enter: "Enter",
  Escape: "Escape",
  Home: "Home",
};

const NATIVE_KEY_CODE: Record<string, string> = {
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  Backspace: "Backspace",
  Delete: "Delete",
  End: "End",
  Enter: "Enter",
  Esc: "Escape",
  Escape: "Escape",
  Home: "Home",
  Tab: "Tab",
  " ": "Space",
};

function interactiveInputResult(outcome: NativeInputOutcome): Record<string, unknown> {
  if (outcome.status === "completed") return { ok: true };
  if (outcome.status === "ambiguous") {
    const timedOut = outcome.reason.endsWith("-timeout");
    const transportRejected =
      !timedOut &&
      (outcome.reason.endsWith("-rejected") || outcome.reason.endsWith("-interrupted"));
    const pointerMoveCompleted = outcome.partial === "pointer-move";
    const singleClickCompleted = outcome.partial === "single-click";
    const atLeastOneClickCompleted = outcome.partial === "at-least-one-click";
    return {
      ok: false,
      ambiguous: true,
      ...(timedOut ? { timedOut: true } : {}),
      ...(transportRejected ? { transportRejected: true } : {}),
      reason: outcome.reason,
      ...(outcome.partial ? { partial: outcome.partial } : {}),
      ...(typeof outcome.clickDispatched === "boolean"
        ? { clickDispatched: outcome.clickDispatched }
        : {}),
      hint: pointerMoveCompleted
        ? "Trusted pointer movement reached Chromium and page hover/mousemove handlers may have run. No click was dispatched. Inspect page state before any retry."
        : singleClickCompleted
          ? "One trusted click completed, but the requested double-click did not. Inspect page state before any retry."
          : atLeastOneClickCompleted
            ? "At least one trusted click completed, and the second click outcome is uncertain. Inspect page state before any retry."
            : "Native input may already have reached Chromium. Inspect page state before any retry.",
    };
  }
  const reason =
    outcome.reason === "presentation-authorization-revoked"
      ? "presentation-changed"
      : outcome.reason;
  return { error: `Native browser input failed: ${reason}` };
}

function nativeInputAuthorized(authorize: NativeInputAuthorization): boolean {
  try {
    return authorize() === true;
  } catch {
    return false;
  }
}

interface PageFrameTreeResult {
  frameTree?: { frame?: { id?: string; loaderId?: string } };
}

interface PresentedDocumentGuard {
  readonly webContents: ResolvedBrowserTab["webContents"];
  readonly cdp: ResolvedBrowserTab["cdp"];
  readonly mainDocumentIdentity: string;
}

async function readMainDocumentIdentity(cdp: ResolvedBrowserTab["cdp"]): Promise<string | null> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve(cdp.send<PageFrameTreeResult>("Page.getFrameTree")).then(
        (value) => ({ status: "fulfilled" as const, value }),
        () => ({ status: "rejected" as const }),
      ),
      new Promise<{ status: "timed-out" }>((resolve) => {
        timeout = setTimeout(() => resolve({ status: "timed-out" }), NATIVE_DOCUMENT_GUARD_CAP_MS);
      }),
    ]);
    if (result.status !== "fulfilled") return null;
    const frameId = result.value.frameTree?.frame?.id;
    const loaderId = result.value.frameTree?.frame?.loaderId;
    if (!frameId || !loaderId) return null;
    return `${frameId.length}:${frameId}:${loaderId.length}:${loaderId}`;
  } catch {
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function capturePresentedDocument(
  tab: ResolvedBrowserTab,
  mainDocumentIdentity: string,
): PresentedDocumentGuard | null {
  try {
    return {
      webContents: tab.webContents,
      cdp: tab.cdp,
      mainDocumentIdentity,
    };
  } catch {
    return null;
  }
}

function presentedGuestStillExact(tab: ResolvedBrowserTab, guard: PresentedDocumentGuard): boolean {
  try {
    return (
      tab.webContents === guard.webContents &&
      tab.cdp === guard.cdp &&
      !guard.webContents.isDestroyed()
    );
  } catch {
    return false;
  }
}

async function presentedDocumentStillExact(
  tab: ResolvedBrowserTab,
  guard: PresentedDocumentGuard,
): Promise<boolean> {
  if (!presentedGuestStillExact(tab, guard)) return false;
  const identity = await readMainDocumentIdentity(guard.cdp);
  return identity === guard.mainDocumentIdentity && presentedGuestStillExact(tab, guard);
}

function interactiveQueueTarget(
  ctx: ToolContext,
  payload: Record<string, unknown>,
): { key: string; tabId?: string } {
  const requested = typeof payload.tabId === "string" ? payload.tabId : undefined;
  if (requested) return { key: "visible-browser-surface", tabId: requested };
  const active = ctx.threadId
    ? ctx.manager.getActiveTabForThread(ctx.threadId)
    : ctx.manager.getActiveTab();
  if (active) return { key: "visible-browser-surface", tabId: active.tabId };
  return { key: "visible-browser-surface" };
}

async function serializeInteractive<T>(
  ctx: ToolContext,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  let queues = interactiveQueues.get(ctx.manager);
  if (!queues) {
    queues = new Map();
    interactiveQueues.set(ctx.manager, queues);
  }
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => {}).then(() => gate);
  queues.set(key, tail);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (queues.get(key) === tail) queues.delete(key);
    if (queues.size === 0) interactiveQueues.delete(ctx.manager);
  }
}

/** Interactive tools reveal their exact first-class tab and wait for a
 * renderer/compositor acknowledgement before native input is eligible to run.
 * Clearing the page hide style also makes an action visible when browser.enable
 * was omitted or a previous session already called disable. */
async function requireInteractiveTab(
  ctx: ToolContext,
  payload: Record<string, unknown>,
): Promise<{
  tab: ResolvedBrowserTab;
  presentation: AutomationPresentationLease;
  authorize: NativeInputAuthorization;
}> {
  // Interactive calls are self-contained: omitted browser.enable still starts
  // a bounded lease that browser.disable (or expiry) can cleanly release.
  ctx.manager.setAutomationSession(automationSessionId(ctx), true);
  const result = await requireTab(ctx, payload);
  const presentation = await ctx.manager.presentAutomationTarget(result.tab.tabId);
  if (!presentation) {
    throw new Error(
      `Native browser input failed: presentation-unavailable for tab ${result.tab.tabId}`,
    );
  }
  if (!(await setCursorOverlayVisible(result.tab.cdp, true))) {
    throw new Error("Native browser input failed: cursor-unavailable");
  }
  const authorize: NativeInputAuthorization = () =>
    ctx.manager.validateAutomationPresentation(presentation);
  return { ...result, presentation, authorize };
}

function presentationChanged(
  ctx: ToolContext,
  presentation: AutomationPresentationLease,
  target: AgentCursorTarget,
): Record<string, unknown> | null {
  if (target.nativeMoveAmbiguous) {
    return interactiveInputResult({
      status: "ambiguous",
      reason: target.nativeMoveReason ?? "pointer-path-timeout",
      ...(target.nativeMoveCompletedBeforeFailure
        ? { partial: "pointer-move", clickDispatched: false }
        : {}),
    });
  }
  if (nativeInputAuthorized(() => ctx.manager.validateAutomationPresentation(presentation))) {
    return null;
  }
  return target.nativeMoveCompletedBeforeFailure
    ? interactiveInputResult({
        status: "ambiguous",
        reason: "presentation-changed",
        partial: "pointer-move",
        clickDispatched: false,
      })
    : { error: "Native browser input failed: presentation-changed" };
}

type FocusedPresentedGuest =
  | { ok: true; authorize: NativeInputAuthorization }
  | { ok: false; outcome: NativeInputOutcome };

function completedPointerMoveOnly(reason: string): NativeInputOutcome {
  return {
    status: "ambiguous",
    reason,
    partial: "pointer-move",
    clickDispatched: false,
  };
}

/**
 * CDP's DOM.focus only changes document focus. On macOS, printable key input
 * is routed through the window's first-responder WebContents, so the exact
 * visible guest must also own native focus before any keyboard side effect.
 * Capture that guest and keep it in the authorization predicate so a tab/view
 * replacement or focus theft stops the sequence before the next key.
 */
async function focusPresentedGuest(
  tab: ResolvedBrowserTab,
  authorize: NativeInputAuthorization,
  mainDocumentIdentity: string,
): Promise<FocusedPresentedGuest> {
  const documentGuard = capturePresentedDocument(tab, mainDocumentIdentity);
  if (!documentGuard) {
    return { ok: false, outcome: completedPointerMoveOnly("guest-target-unavailable") };
  }
  const presentedWebContents = documentGuard.webContents;
  if (!(await presentedDocumentStillExact(tab, documentGuard))) {
    return { ok: false, outcome: completedPointerMoveOnly("guest-target-replaced") };
  }
  if (!nativeInputAuthorized(authorize)) {
    return {
      ok: false,
      outcome: completedPointerMoveOnly("presentation-authorization-revoked"),
    };
  }
  try {
    presentedWebContents.focus();
  } catch {
    return { ok: false, outcome: completedPointerMoveOnly("guest-focus-rejected") };
  }
  if (!(await presentedDocumentStillExact(tab, documentGuard))) {
    return { ok: false, outcome: completedPointerMoveOnly("guest-target-replaced") };
  }
  if (!nativeInputAuthorized(authorize)) {
    return {
      ok: false,
      outcome: completedPointerMoveOnly("presentation-authorization-revoked"),
    };
  }
  try {
    if (!presentedWebContents.isFocused()) {
      return {
        ok: false,
        outcome: completedPointerMoveOnly("guest-focus-did-not-apply"),
      };
    }
  } catch {
    return { ok: false, outcome: completedPointerMoveOnly("guest-focus-rejected") };
  }
  return {
    ok: true,
    authorize: () => {
      if (!presentedGuestStillExact(tab, documentGuard) || !nativeInputAuthorized(authorize)) {
        return false;
      }
      try {
        return presentedWebContents.isFocused();
      } catch {
        return false;
      }
    },
  };
}

function electronKeyboardModifiers(
  options: NativeKeyboardInputOptions,
): Electron.InputEvent["modifiers"] {
  const mask = (options.modifiers ?? 0) | (options.shift ? 8 : 0);
  const modifiers: NonNullable<Electron.InputEvent["modifiers"]> = [];
  if (mask & 1) modifiers.push("alt");
  if (mask & 2) modifiers.push("control");
  if (mask & 4) modifiers.push("meta");
  if (mask & 8) modifiers.push("shift");
  return modifiers.length > 0 ? modifiers : undefined;
}

function electronKeyCode(key: string): string | null {
  const mapped = NATIVE_KEY_CODE[key];
  if (mapped) return mapped;
  if (key.length !== 1) return null;
  return /^[a-z]$/iu.test(key) ? key.toUpperCase() : key;
}

/** Bind every keyboard/text side effect to the exact presented guest. Unlike
 * CDP key dispatch, WebContents-native input cannot follow the host renderer's
 * first responder when the Y Space composer previously owned focus. */
function createNativeKeyboardDispatcher(
  tab: ResolvedBrowserTab,
  authorize: NativeInputAuthorization,
  mainDocumentIdentity: string,
): NativeKeyboardInputDispatcher {
  const documentGuard = capturePresentedDocument(tab, mainDocumentIdentity);
  if (!documentGuard) {
    return {
      async key() {
        return { status: "failed", reason: "guest-target-unavailable" };
      },
      async insertText() {
        return { status: "failed", reason: "guest-target-unavailable" };
      },
    };
  }
  const presentedWebContents = documentGuard.webContents;
  const synchronousGuardReason = (): string | null => {
    try {
      if (!presentedGuestStillExact(tab, documentGuard)) return "guest-target-replaced";
      if (!nativeInputAuthorized(authorize)) return "presentation-authorization-revoked";
      if (!presentedWebContents.isFocused()) return "guest-focus-lost";
      return null;
    } catch {
      return "guest-target-unavailable";
    }
  };
  const guardReason = async (): Promise<string | null> => {
    if (!(await presentedDocumentStillExact(tab, documentGuard))) {
      return "guest-target-replaced";
    }
    return synchronousGuardReason();
  };
  const releaseStillTargetsOriginalDocument = async (): Promise<boolean> => {
    if (presentedWebContents.isDestroyed()) return false;
    try {
      if (tab.webContents !== presentedWebContents) {
        return (
          (await readMainDocumentIdentity(documentGuard.cdp)) === documentGuard.mainDocumentIdentity
        );
      }
    } catch {
      return false;
    }
    return await presentedDocumentStillExact(tab, documentGuard);
  };
  const releaseBestEffort = async (
    keyCode: string,
    modifiers: Electron.InputEvent["modifiers"],
  ): Promise<void> => {
    try {
      if (!(await releaseStillTargetsOriginalDocument())) return;
      presentedWebContents.sendInputEvent({
        type: "keyUp",
        keyCode,
        ...(modifiers ? { modifiers } : {}),
      });
    } catch {}
  };

  return {
    async key(key, options = {}) {
      if (options.commands?.includes("selectAll")) {
        const before = await guardReason();
        if (before) return { status: "failed", reason: before };
        try {
          // Electron's edit command is bound to this exact WebContents. A
          // synthetic Command/Ctrl+A can leave the caret untouched on some
          // controlled inputs, causing the following Backspace to delete only
          // one character before insertText appends the replacement.
          presentedWebContents.selectAll();
        } catch {
          return { status: "failed", reason: "native-select-all-rejected" };
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, NATIVE_KEYBOARD_SETTLE_MS);
        });
        const after = await guardReason();
        if (after) return { status: "ambiguous", reason: after };
        return { status: "completed" };
      }
      const keyCode = electronKeyCode(key);
      if (!keyCode) return { status: "failed", reason: "native-key-unsupported" };
      const modifiers = electronKeyboardModifiers(options);
      const printable = key.length === 1 && !((options.modifiers ?? 0) & (1 | 2 | 4));
      const printableKey = options.shift && /^[a-z]$/u.test(key) ? key.toUpperCase() : key;
      const before = await guardReason();
      if (before) return { status: "failed", reason: before };
      try {
        presentedWebContents.sendInputEvent({
          type: "keyDown",
          keyCode,
          ...(modifiers ? { modifiers } : {}),
        });
      } catch {
        return { status: "failed", reason: "native-key-down-rejected" };
      }
      const afterDown = await guardReason();
      if (afterDown) {
        await releaseBestEffort(keyCode, modifiers);
        return { status: "ambiguous", reason: afterDown };
      }
      if (printable) {
        try {
          presentedWebContents.sendInputEvent({
            type: "char",
            keyCode: printableKey,
            ...(modifiers ? { modifiers } : {}),
          });
        } catch {
          await releaseBestEffort(keyCode, modifiers);
          return { status: "ambiguous", reason: "native-char-rejected" };
        }
      }
      const beforeUp = await guardReason();
      if (beforeUp) {
        await releaseBestEffort(keyCode, modifiers);
        return { status: "ambiguous", reason: beforeUp };
      }
      try {
        presentedWebContents.sendInputEvent({
          type: "keyUp",
          keyCode,
          ...(modifiers ? { modifiers } : {}),
        });
      } catch {
        await releaseBestEffort(keyCode, modifiers);
        return { status: "ambiguous", reason: "native-key-up-rejected" };
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, NATIVE_KEYBOARD_SETTLE_MS);
      });
      return { status: "completed" };
    },
    async insertText(text) {
      const before = await guardReason();
      if (before) return { status: "failed", reason: before };
      let result: "fulfilled" | "rejected" | "timed-out";
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        result = await Promise.race([
          Promise.resolve(presentedWebContents.insertText(text)).then(
            () => "fulfilled" as const,
            () => "rejected" as const,
          ),
          new Promise<"timed-out">((resolve) => {
            timeout = setTimeout(() => resolve("timed-out"), NATIVE_TEXT_INPUT_CAP_MS);
          }),
        ]);
      } catch {
        result = "rejected";
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      if (result !== "fulfilled") {
        return {
          status: "ambiguous",
          reason: result === "timed-out" ? "text-input-timeout" : "text-input-rejected",
        };
      }
      const after = await guardReason();
      if (after) return { status: "ambiguous", reason: after };
      return { status: "completed" };
    },
  };
}

/** Bind OS-owned select-menu input to the exact guest that received the
 * presentation proof on platforms whose native picker accepts raw menu keys. */
function createNativeSelectMenuKeyDispatcher(
  tab: ResolvedBrowserTab,
  authorize: NativeInputAuthorization,
  mainDocumentIdentity: string,
): NativeSelectMenuKeyDispatcher {
  const documentGuard = capturePresentedDocument(tab, mainDocumentIdentity);
  if (!documentGuard) {
    return async () => ({ status: "failed", reason: "select-native-menu-target-replaced" });
  }
  const presentedWebContents = documentGuard.webContents;
  const releaseStillTargetsOriginalDocument = async (): Promise<boolean> => {
    if (presentedWebContents.isDestroyed()) return false;
    try {
      if (tab.webContents !== presentedWebContents) {
        return (
          (await readMainDocumentIdentity(documentGuard.cdp)) === documentGuard.mainDocumentIdentity
        );
      }
    } catch {
      return false;
    }
    return await presentedDocumentStillExact(tab, documentGuard);
  };
  const releaseBestEffort = async (keyCode: string): Promise<void> => {
    try {
      if (!(await releaseStillTargetsOriginalDocument())) return;
      presentedWebContents.sendInputEvent({ type: "keyUp", keyCode });
    } catch {}
  };

  return async (key, options = {}) => {
    const cleanup = options.cleanup === true && key === "Escape";
    const keyCode = NATIVE_SELECT_MENU_KEY_CODE[key];
    // The document proof is asynchronous, then the exact guest and synchronous
    // presentation proof are rechecked immediately before the native side
    // effect. Cleanup Escape may bypass presentation revocation only while the
    // original document is still current.
    if (!(await presentedDocumentStillExact(tab, documentGuard))) {
      return { status: "failed", reason: "select-native-menu-target-replaced" };
    }
    if (!cleanup && !nativeInputAuthorized(authorize)) {
      return { status: "failed", reason: "presentation-authorization-revoked" };
    }
    try {
      presentedWebContents.sendInputEvent({ type: "rawKeyDown", keyCode });
    } catch {
      return { status: "failed", reason: "select-native-key-down-rejected" };
    }
    if (!(await presentedDocumentStillExact(tab, documentGuard))) {
      await releaseBestEffort(keyCode);
      return { status: "ambiguous", reason: "select-native-menu-target-replaced" };
    }
    if (!cleanup && !nativeInputAuthorized(authorize)) {
      await releaseBestEffort(keyCode);
      return { status: "ambiguous", reason: "presentation-authorization-revoked" };
    }
    try {
      presentedWebContents.sendInputEvent({ type: "keyUp", keyCode });
    } catch {
      await releaseBestEffort(keyCode);
      return { status: "ambiguous", reason: "select-native-key-up-rejected" };
    }
    // sendInputEvent enqueues native work. Yield one frame-equivalent so the
    // OS menu can update before the next exact-node/:open revalidation.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, NATIVE_SELECT_MENU_KEY_SETTLE_MS);
    });
    return { status: "completed" };
  };
}

/** Raw dispatch returning JS objects. The MCP wrapper formats these into the
 *  proper content shape. */
export async function dispatchTool(
  name: string,
  payload: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const normalized = normalizeToolName(name);
  if (SERIALIZED_BROWSER_TOOLS.has(normalized)) {
    const target = interactiveQueueTarget(ctx, payload);
    return await serializeInteractive(ctx, target.key, async () =>
      dispatchToolUnqueued(
        normalized,
        target.tabId ? { ...payload, tabId: target.tabId } : payload,
        ctx,
      ),
    );
  }
  return await dispatchToolUnqueued(normalized, payload, ctx);
}

async function dispatchToolUnqueued(
  name: string,
  payload: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  switch (name) {
    case "api":
      return {
        server: "browser",
        description:
          "Controls first-class Y Space browser page tabs through navigation, inspection, input, screenshots, console, network, dialogs, cookies, and storage.",
        guidance: [
          "Prefer this MCP server over shell-driven browser automation when a page is visible in Y Space.",
          "Call enable before a browsing session and disable before pausing for user input or finishing.",
          "Start with snapshot or find to identify @e refs before click, fill, type, hover, get, is, or scroll.",
          "Use fill for form fields when replacing text; use type only when appending text to the current value.",
          "Use wait after navigation or mutations instead of fixed sleeps unless a plain ms delay is intentional.",
          "Use requests and console after actions to verify web app behavior and diagnose failures.",
          "Interactive tools present the exact global browser tab and move the orange Y Space cursor to the real target; passive inspection remains in the background without ornamental cursor activity.",
          "Use eval, cookies, and storage only when the corresponding Y Space setting allows it.",
        ],
        workflows: {
          inspect: ["list_tabs", "find_tabs", "snapshot", "find", "get", "is"],
          navigate: [
            "new_tab",
            "open_or_focus_tab",
            "open",
            "navigate",
            "back",
            "forward",
            "reload",
          ],
          interact: [
            "click",
            "dblclick",
            "focus",
            "fill",
            "type",
            "check",
            "uncheck",
            "select",
            "press",
            "hover",
            "scroll",
            "wait",
          ],
          verify: ["screenshot", "console", "requests", "wait_for_url", "frames"],
          advanced: ["dialog", "addscript", "addstyle", "eval", "cookies", "storage"],
        },
        conventions: {
          refs: "snapshot/find return @e refs. Prefer passing ref over fragile CSS selectors.",
          aliases: {
            open: "navigate",
            goto: "navigate",
            inspect: "snapshot",
            key: "press",
            keyboard_type: "type",
          },
          snapshot:
            "Use interactiveOnly/includeUrls/selector to reduce output before handing page state to the model.",
        },
        tools: TOOLS.filter((tool) => tool.name !== "api").map(compactToolSpec),
        tabs: tabOverview(ctx),
      };
    case "enable": {
      const sessionId = automationSessionId(ctx);
      ctx.manager.setAutomationSession(sessionId, true);
      const tab = ctx.threadId
        ? ctx.manager.getActiveTabForThread(ctx.threadId)
        : ctx.manager.getActiveTab();
      if (tab) {
        ctx.manager.recordAutomationTarget(sessionId, tab.tabId);
        await ctx.manager.ensureTabReady(tab.tabId);
        await ctx.manager.showAutomationCursor(sessionId, tab.tabId);
      }
      return { enabled: true };
    }
    case "disable": {
      // The manager-wide queue places disable after every already-enqueued
      // input or tab mutation, so presence cannot disappear mid-gesture.
      ctx.manager.setAutomationSession(automationSessionId(ctx), false);
      return { enabled: false };
    }
    case "list_tabs":
      return tabOverview(ctx);
    case "find_tabs": {
      const query = String(payload.query ?? "")
        .trim()
        .toLowerCase();
      if (!query) throw new Error("query required");
      const limit = clampInteger(payload.limit, 20, 1, 100);
      const state = agentVisibleState(ctx);
      return {
        tabs: state.tabs
          .filter((tab) =>
            [tab.tabId, tab.url, tab.title].some((value) => value.toLowerCase().includes(query)),
          )
          .slice(0, limit),
        implicitTabId: ctx.threadId
          ? (ctx.manager.getActiveTabForThread(ctx.threadId)?.tabId ?? null)
          : state.activeTabId,
      };
    }
    case "new_tab": {
      const url = typeof payload.url === "string" ? payload.url : undefined;
      const activate = payload.activate !== false;
      const sessionId = automationSessionId(ctx);
      ctx.manager.touchAutomationSession(sessionId);
      const tab = await ctx.manager.createTab(
        { ...(url ? { url } : {}), activate },
        agentTabOpts(ctx),
      );
      ctx.manager.recordAutomationTarget(sessionId, tab.tabId);
      await ctx.manager.showAutomationCursor(sessionId, tab.tabId);
      return tab;
    }
    case "activate_tab": {
      const tabId = String(payload.tabId ?? "");
      if (!ctx.manager.getTab(tabId)) throw new Error(`unknown tab ${tabId}`);
      ctx.manager.setActiveTab(tabId);
      if (ctx.threadId) ctx.manager.rememberTabForThread(ctx.threadId, tabId);
      const sessionId = automationSessionId(ctx);
      ctx.manager.recordAutomationTarget(sessionId, tabId);
      await ctx.manager.ensureTabReady(tabId);
      await ctx.manager.showAutomationCursor(sessionId, tabId);
      return { ok: true };
    }
    case "open_or_focus_tab": {
      const url = String(payload.url ?? "").trim();
      if (!url) throw new Error("url required");
      const match =
        payload.match === "origin" || payload.match === "prefix" ? payload.match : "exact";
      const existing = agentVisibleState(ctx).tabs.find((tab) =>
        tabUrlMatches(tab.url, url, match),
      );
      if (existing) {
        if (payload.activate !== false) ctx.manager.setActiveTab(existing.tabId);
        if (ctx.threadId) ctx.manager.rememberTabForThread(ctx.threadId, existing.tabId);
        const sessionId = automationSessionId(ctx);
        ctx.manager.recordAutomationTarget(sessionId, existing.tabId);
        await ctx.manager.ensureTabReady(existing.tabId);
        await ctx.manager.showAutomationCursor(sessionId, existing.tabId);
        return { created: false, tab: existing };
      }
      const activate = payload.activate !== false;
      const sessionId = automationSessionId(ctx);
      ctx.manager.touchAutomationSession(sessionId);
      const tab = await ctx.manager.createTab({ url, activate }, agentTabOpts(ctx));
      ctx.manager.recordAutomationTarget(sessionId, tab.tabId);
      await ctx.manager.showAutomationCursor(sessionId, tab.tabId);
      return { created: true, tab };
    }
    case "close_tab": {
      const tabId = String(payload.tabId ?? "");
      if (!ctx.manager.getTab(tabId)) throw new Error(`unknown tab ${tabId}`);
      await ctx.manager.closeTab(tabId);
      return { ok: true };
    }
    case "navigate": {
      const tabId = await resolveTabId(ctx, payload);
      const url = String(payload.url ?? "");
      if (!url) throw new Error("url required");
      await ctx.manager.navigate(tabId, url);
      return { ok: true, tabId };
    }
    case "back": {
      const { tab } = await requireTab(ctx, payload);
      await tab.cdp.attach();
      await back(tab.cdp);
      return { ok: true };
    }
    case "forward": {
      const { tab } = await requireTab(ctx, payload);
      await tab.cdp.attach();
      await forward(tab.cdp);
      return { ok: true };
    }
    case "reload": {
      const tabId = await resolveTabId(ctx, payload);
      await ctx.manager.reload(tabId);
      return { ok: true };
    }
    case "get_url": {
      const { tab } = await requireTab(ctx, payload);
      return { url: tab.snapshot().url };
    }
    case "get_title": {
      const { tab } = await requireTab(ctx, payload);
      return { title: tab.snapshot().title };
    }
    case "screenshot": {
      return await runScreenshotTool(ctx, payload);
    }
    case "query": {
      const { tab } = await requireTab(ctx, payload);
      const selector = String(payload.selector ?? "");
      if (!selector) throw new Error("selector required");
      await tab.cdp.attach();
      const limit = clampInteger(payload.limit, 20, 1, 100);
      const offset = clampInteger(payload.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      return await querySelectorAllSnapshot(tab.cdp, selector, limit, offset);
    }
    case "wait_for": {
      const { tab } = await requireTab(ctx, payload);
      const selector = String(payload.selector ?? "");
      const timeoutMs = typeof payload.timeoutMs === "number" ? payload.timeoutMs : 5000;
      if (!selector) throw new Error("selector required");
      await tab.cdp.attach();
      const found = await waitForSelector(tab.cdp, selector, timeoutMs);
      return { found };
    }
    case "click": {
      const { tab, presentation, authorize } = await requireInteractiveTab(ctx, payload);
      const selector = await resolveSelectorArg(tab, payload);
      if (!selector) throw new Error("selector or ref required");
      const target = await glideCursorToSelector(tab.cdp, selector, "click", authorize);
      if (!target) return { error: "Native browser input failed: target-unavailable" };
      const changed = presentationChanged(ctx, presentation, target);
      if (changed) return changed;
      const outcome = await dispatchPointerClick(tab.cdp, target, 1, authorize);
      if (outcome.status !== "completed") return interactiveInputResult(outcome);
      await completeCursorAction(tab.cdp, target, "click", {}, authorize);
      return { ok: true };
    }
    case "dblclick": {
      const { tab, presentation, authorize } = await requireInteractiveTab(ctx, payload);
      const selector = await resolveSelectorArg(tab, payload);
      if (!selector) throw new Error("selector or ref required");
      const target = await glideCursorToSelector(tab.cdp, selector, "double-click", authorize);
      if (!target) return { error: "Native browser input failed: target-unavailable" };
      const changed = presentationChanged(ctx, presentation, target);
      if (changed) return changed;
      const outcome = await dispatchPointerClick(tab.cdp, target, 2, authorize);
      if (outcome.status !== "completed") return interactiveInputResult(outcome);
      await completeCursorAction(tab.cdp, target, "double-click", {}, authorize);
      return { ok: true };
    }
    case "focus": {
      const { tab, presentation, authorize } = await requireInteractiveTab(ctx, payload);
      const selector = await resolveSelectorArg(tab, payload);
      if (!selector) throw new Error("selector or ref required");
      const target = await glideCursorToSelector(tab.cdp, selector, "focus", authorize);
      if (!target) return { error: "Native browser input failed: target-unavailable" };
      const changed = presentationChanged(ctx, presentation, target);
      if (changed) return changed;
      const focusedGuest = await focusPresentedGuest(tab, authorize, target.mainDocumentIdentity);
      if (!focusedGuest.ok) return interactiveInputResult(focusedGuest.outcome);
      const outcome = await dispatchNativeFocus(tab.cdp, selector, target, focusedGuest.authorize);
      if (outcome.status !== "completed") return interactiveInputResult(outcome);
      await completeCursorAction(tab.cdp, target, "focus", {}, authorize);
      return { ok: true };
    }
    case "type": {
      const { tab, presentation, authorize } = await requireInteractiveTab(ctx, payload);
      const text = String(payload.text ?? "");
      const submit = payload.submit === true;
      const selector = await resolveSelectorArg(tab, payload);
      if (!selector) throw new Error("selector or ref required");
      const target = await glideCursorToSelector(tab.cdp, selector, "text", authorize);
      if (!target) return { error: "Native browser input failed: target-unavailable" };
      const changed = presentationChanged(ctx, presentation, target);
      if (changed) return changed;
      const focusedGuest = await focusPresentedGuest(tab, authorize, target.mainDocumentIdentity);
      if (!focusedGuest.ok) return interactiveInputResult(focusedGuest.outcome);
      const nativeKeyboard = createNativeKeyboardDispatcher(
        tab,
        authorize,
        target.mainDocumentIdentity,
      );
      const outcome = await dispatchNativeText(
        tab.cdp,
        selector,
        target,
        text,
        {
          replace: false,
          submit,
        },
        focusedGuest.authorize,
        nativeKeyboard,
      );
      if (outcome.status !== "completed") return interactiveInputResult(outcome);
      await completeCursorAction(tab.cdp, target, "text", {}, authorize);
      return { ok: true };
    }
    case "fill": {
      const { tab, presentation, authorize } = await requireInteractiveTab(ctx, payload);
      const text = String(payload.text ?? "");
      const submit = payload.submit === true;
      const selector = await resolveSelectorArg(tab, payload);
      if (!selector) throw new Error("selector or ref required");
      const target = await glideCursorToSelector(tab.cdp, selector, "text", authorize);
      if (!target) return { error: "Native browser input failed: target-unavailable" };
      const changed = presentationChanged(ctx, presentation, target);
      if (changed) return changed;
      const focusedGuest = await focusPresentedGuest(tab, authorize, target.mainDocumentIdentity);
      if (!focusedGuest.ok) return interactiveInputResult(focusedGuest.outcome);
      const nativeKeyboard = createNativeKeyboardDispatcher(
        tab,
        authorize,
        target.mainDocumentIdentity,
      );
      const outcome = await dispatchNativeText(
        tab.cdp,
        selector,
        target,
        text,
        {
          replace: true,
          submit,
        },
        focusedGuest.authorize,
        nativeKeyboard,
      );
      if (outcome.status !== "completed") return interactiveInputResult(outcome);
      await completeCursorAction(tab.cdp, target, "text", {}, authorize);
      return { ok: true };
    }
    case "check": {
      const { tab, presentation, authorize } = await requireInteractiveTab(ctx, payload);
      const selector = await resolveSelectorArg(tab, payload);
      if (!selector) throw new Error("selector or ref required");
      const target = await glideCursorToSelector(tab.cdp, selector, "toggle", authorize);
      if (!target) return { error: "Native browser input failed: target-unavailable" };
      const changed = presentationChanged(ctx, presentation, target);
      if (changed) return changed;
      const outcome = await dispatchNativeToggle(tab.cdp, selector, target, true, authorize);
      if (outcome.status !== "completed") return interactiveInputResult(outcome);
      await completeCursorAction(tab.cdp, target, "toggle", { label: "✓" }, authorize);
      return { ok: true };
    }
    case "uncheck": {
      const { tab, presentation, authorize } = await requireInteractiveTab(ctx, payload);
      const selector = await resolveSelectorArg(tab, payload);
      if (!selector) throw new Error("selector or ref required");
      const target = await glideCursorToSelector(tab.cdp, selector, "toggle", authorize);
      if (!target) return { error: "Native browser input failed: target-unavailable" };
      const changed = presentationChanged(ctx, presentation, target);
      if (changed) return changed;
      const outcome = await dispatchNativeToggle(tab.cdp, selector, target, false, authorize);
      if (outcome.status !== "completed") return interactiveInputResult(outcome);
      await completeCursorAction(tab.cdp, target, "toggle", { label: "–" }, authorize);
      return { ok: true };
    }
    case "select": {
      const { tab, presentation, authorize } = await requireInteractiveTab(ctx, payload);
      const value = String(payload.value ?? "");
      if (!value) throw new Error("value required");
      const selector = await resolveSelectorArg(tab, payload);
      if (!selector) throw new Error("selector or ref required");
      const target = await glideCursorToSelector(tab.cdp, selector, "select", authorize);
      if (!target) return { error: "Native browser input failed: target-unavailable" };
      const changed = presentationChanged(ctx, presentation, target);
      if (changed) return changed;
      const focusedGuest = await focusPresentedGuest(tab, authorize, target.mainDocumentIdentity);
      if (!focusedGuest.ok) return interactiveInputResult(focusedGuest.outcome);
      const nativeKeyboard = createNativeKeyboardDispatcher(
        tab,
        authorize,
        target.mainDocumentIdentity,
      );
      const outcome = await dispatchNativeSelect(
        tab.cdp,
        selector,
        target,
        value,
        createNativeSelectMenuKeyDispatcher(
          tab,
          focusedGuest.authorize,
          target.mainDocumentIdentity,
        ),
        focusedGuest.authorize,
        process.platform === "darwin" ? "typeahead" : "native-menu",
        nativeKeyboard,
      );
      if (outcome.status !== "completed") return interactiveInputResult(outcome);
      await completeCursorAction(tab.cdp, target, "select", {}, authorize);
      return { ok: true };
    }
    case "eval": {
      if (!ctx.allowEval) {
        return { error: "eval is disabled in Y Space settings" };
      }
      const { tab } = await requireTab(ctx, payload);
      const expression = String(payload.js ?? "");
      if (!expression) throw new Error("js required");
      await tab.cdp.attach();
      try {
        const result = await evalJs(tab.cdp, expression);
        let serialized: unknown = result;
        if (typeof result === "string" && result.length > MAX_EVAL_RESULT) {
          serialized = `${result.slice(0, MAX_EVAL_RESULT)}...[truncated]`;
        }
        return { result: serialized };
      } catch (err) {
        return { error: (err as Error).message ?? "eval failed" };
      }
    }
    case "snapshot": {
      const { tab } = await requireTab(ctx, payload);
      await tab.cdp.attach();
      const maxNodes = clampInteger(payload.maxNodes, 120, 1, 500);
      const offset = clampInteger(payload.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      const mode = payload.mode === "compact" || payload.mode === "summary" ? payload.mode : "full";
      const maxTextLength =
        typeof payload.maxTextLength === "number"
          ? clampInteger(payload.maxTextLength, mode === "full" ? 200 : 80, 20, 1000)
          : undefined;
      const includeHidden = payload.includeHidden === true;
      return await pageSnapshot(tab.cdp, {
        maxNodes,
        offset,
        mode,
        ...(maxTextLength != null ? { maxTextLength } : {}),
        includeHidden,
        ...(payload.interactiveOnly === false ? { interactiveOnly: false } : {}),
        ...(payload.includeUrls === true ? { includeUrls: true } : {}),
        ...(typeof payload.selector === "string" ? { selector: payload.selector } : {}),
      });
    }
    case "get": {
      const { tab } = await requireTab(ctx, payload);
      await tab.cdp.attach();
      const selector = await resolveSelectorArg(tab, payload);
      if (!selector) throw new Error("selector or ref required");
      const fieldsRaw = Array.isArray(payload.fields) ? (payload.fields as string[]) : ["text"];
      const fields = fieldsRaw.filter(
        (f): f is "text" | "html" | "value" | "attr" | "count" | "box" | "styles" =>
          ["text", "html", "value", "attr", "count", "box", "styles"].includes(f),
      );
      const attrName = typeof payload.attr === "string" ? payload.attr : undefined;
      const styles = Array.isArray(payload.styles) ? (payload.styles as string[]) : undefined;
      return await getElementInfo(tab.cdp, selector, fields, attrName, styles);
    }
    case "is": {
      const { tab } = await requireTab(ctx, payload);
      await tab.cdp.attach();
      const selector = await resolveSelectorArg(tab, payload);
      if (!selector) throw new Error("selector or ref required");
      return await getElementState(tab.cdp, selector);
    }
    case "find": {
      const { tab } = await requireTab(ctx, payload);
      await tab.cdp.attach();
      return await findByA11y(tab.cdp, {
        ...(typeof payload.role === "string" ? { role: payload.role } : {}),
        ...(typeof payload.name === "string" ? { name: payload.name } : {}),
        ...(typeof payload.label === "string" ? { label: payload.label } : {}),
        ...(typeof payload.placeholder === "string" ? { placeholder: payload.placeholder } : {}),
        ...(typeof payload.text === "string" ? { text: payload.text } : {}),
        ...(typeof payload.testid === "string" ? { testid: payload.testid } : {}),
        ...(typeof payload.nth === "number" ? { nth: payload.nth } : {}),
        ...(typeof payload.limit === "number" ? { limit: payload.limit } : {}),
        ...(typeof payload.visibleOnly === "boolean" ? { visibleOnly: payload.visibleOnly } : {}),
        ...(typeof payload.interactiveOnly === "boolean"
          ? { interactiveOnly: payload.interactiveOnly }
          : {}),
        ...(typeof payload.within === "string" ? { within: payload.within } : {}),
      });
    }
    case "hover": {
      const { tab, presentation, authorize } = await requireInteractiveTab(ctx, payload);
      const selector = await resolveSelectorArg(tab, payload);
      if (!selector) throw new Error("selector or ref required");
      const target = await glideCursorToSelector(tab.cdp, selector, "hover", authorize);
      if (!target) return { error: "Native browser input failed: target-unavailable" };
      const changed = presentationChanged(ctx, presentation, target);
      if (changed) return changed;
      const outcome = await confirmCursorTarget(tab.cdp, target);
      if (outcome.status !== "completed") return interactiveInputResult(outcome);
      return { ok: true };
    }
    case "press": {
      const { tab, presentation, authorize } = await requireInteractiveTab(ctx, payload);
      const key = String(payload.key ?? "");
      if (!key) throw new Error("key required");
      const hasTarget = typeof payload.selector === "string" || typeof payload.ref === "string";
      const selector = hasTarget ? await resolveSelectorArg(tab, payload) : undefined;
      if (hasTarget && !selector) throw new Error("selector or ref required");
      const shift = payload.shift === true;
      const target = selector
        ? await glideCursorToSelector(tab.cdp, selector, "press", authorize)
        : await glideCursorToActiveTarget(tab.cdp, "press", authorize);
      if (!target) return { error: "Native browser input failed: target-unavailable" };
      const changed = presentationChanged(ctx, presentation, target);
      if (changed) return changed;
      const focusedGuest = await focusPresentedGuest(tab, authorize, target.mainDocumentIdentity);
      if (!focusedGuest.ok) return interactiveInputResult(focusedGuest.outcome);
      const nativeKeyboard = createNativeKeyboardDispatcher(
        tab,
        authorize,
        target.mainDocumentIdentity,
      );
      const outcome = await dispatchNativeKey(
        tab.cdp,
        selector ?? undefined,
        target,
        key,
        {
          shift,
        },
        focusedGuest.authorize,
        nativeKeyboard,
      );
      if (outcome.status !== "completed") return interactiveInputResult(outcome);
      await completeCursorAction(tab.cdp, target, "press", { label: key }, authorize);
      return { ok: true };
    }
    case "wait": {
      const timeoutMs = typeof payload.timeoutMs === "number" ? payload.timeoutMs : 5000;
      if (typeof payload.ms === "number") {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, Math.min(60_000, payload.ms as number))),
        );
        return { ok: true };
      }
      const { tab } = await requireTab(ctx, payload);
      await tab.cdp.attach();
      if (typeof payload.selector === "string" && payload.selector.length > 0) {
        const found = await waitForSelector(tab.cdp, payload.selector, timeoutMs);
        return { found };
      }
      if (typeof payload.text === "string" && payload.text.length > 0) {
        await waitForText(tab.cdp, payload.text, timeoutMs);
        return { ok: true };
      }
      if (typeof payload.url === "string" && payload.url.length > 0) {
        const url = await waitForUrl(tab.cdp, payload.url, timeoutMs);
        return { url };
      }
      if (typeof payload.js === "string" && payload.js.length > 0) {
        if (!ctx.allowEval) {
          return { error: "wait.js requires eval to be enabled in settings" };
        }
        const result = await waitForJs(tab.cdp, payload.js, timeoutMs);
        return { result };
      }
      throw new Error("wait requires selector, text, url, js, or ms");
    }
    case "scroll": {
      const { tab, presentation, authorize } = await requireInteractiveTab(ctx, payload);
      const hasTarget = typeof payload.selector === "string" || typeof payload.ref === "string";
      const selector = hasTarget
        ? ((await resolveSelectorArg(tab, payload)) ?? undefined)
        : undefined;
      if (hasTarget && !selector) throw new Error("selector or ref required");
      const deltaX = typeof payload.x === "number" && Number.isFinite(payload.x) ? payload.x : 0;
      const deltaY = typeof payload.y === "number" && Number.isFinite(payload.y) ? payload.y : 0;
      const target = selector
        ? await glideCursorToSelector(tab.cdp, selector, "scroll", authorize)
        : await glideCursorToViewportCenter(tab.cdp, "scroll", authorize);
      if (!target) return { error: "Native browser input failed: target-unavailable" };
      const changed = presentationChanged(ctx, presentation, target);
      if (changed) return changed;
      let outcome: NativeInputOutcome;
      if (selector) {
        // A selector without deltas means "bring into view"; the move phase did
        // that before drawing the matching cursor trajectory. With deltas, send
        // a real wheel at the selected element (including nested scrollers).
        outcome =
          deltaX !== 0 || deltaY !== 0
            ? await dispatchPointerWheel(tab.cdp, target, deltaX, deltaY, authorize)
            : await confirmCursorTarget(tab.cdp, target);
      } else {
        outcome = await dispatchPointerWheel(tab.cdp, target, deltaX, deltaY, authorize);
      }
      if (outcome.status !== "completed") return interactiveInputResult(outcome);
      await completeCursorAction(tab.cdp, target, "scroll", { deltaX, deltaY }, authorize);
      return { ok: true };
    }
    case "wait_for_url": {
      const { tab } = await requireTab(ctx, payload);
      await tab.cdp.attach();
      const pattern = String(payload.pattern ?? "");
      const timeoutMs = typeof payload.timeoutMs === "number" ? payload.timeoutMs : 5000;
      if (!pattern) throw new Error("pattern required");
      const url = await waitForUrl(tab.cdp, pattern, timeoutMs);
      return { url };
    }
    case "wait_for_text": {
      const { tab } = await requireTab(ctx, payload);
      await tab.cdp.attach();
      const text = String(payload.text ?? "");
      const timeoutMs = typeof payload.timeoutMs === "number" ? payload.timeoutMs : 5000;
      if (!text) throw new Error("text required");
      await waitForText(tab.cdp, text, timeoutMs);
      return { ok: true };
    }
    case "wait_for_js": {
      if (!ctx.allowEval) {
        return { error: "wait_for_js requires eval to be enabled in settings" };
      }
      const { tab } = await requireTab(ctx, payload);
      await tab.cdp.attach();
      const expression = String(payload.js ?? "");
      const timeoutMs = typeof payload.timeoutMs === "number" ? payload.timeoutMs : 5000;
      if (!expression) throw new Error("js required");
      const result = await waitForJs(tab.cdp, expression, timeoutMs);
      return { result };
    }
    case "console": {
      const { tab } = await requireTab(ctx, payload);
      const limit = clampInteger(payload.limit, 50, 1, 100);
      const offset = clampInteger(payload.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      const level =
        typeof payload.level === "string"
          ? (payload.level as "log" | "warn" | "error" | "info" | "debug" | "exception")
          : undefined;
      let entries = tab.getConsoleEntries();
      if (level) entries = entries.filter((e) => e.level === level);
      const page = entries.slice(offset, offset + limit);
      if (payload.clear === true) tab.clearConsole();
      return {
        count: entries.length,
        offset,
        limit,
        nextOffset: offset + page.length < entries.length ? offset + page.length : null,
        entries: page,
      };
    }
    case "requests": {
      const { tab } = await requireTab(ctx, payload);
      await tab.cdp.attach();
      if (!tab.network.isEnabled()) {
        await tab.network.enable(tab.cdp);
      }
      const filter = typeof payload.filter === "string" ? payload.filter : undefined;
      const limit = clampInteger(payload.limit, 50, 1, 100);
      const offset = clampInteger(payload.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      const entries = tab.network.list({ ...(filter ? { filter } : {}), limit: 500 });
      const page = entries.slice(offset, offset + limit);
      if (payload.clear === true) tab.network.clear();
      return {
        count: entries.length,
        offset,
        limit,
        nextOffset: offset + page.length < entries.length ? offset + page.length : null,
        requests: page,
      };
    }
    case "cookies": {
      if (!ctx.allowDataAccess) {
        return {
          error:
            "cookies is disabled. Enable 'Allow agents to read/write cookies and storage' in Y Space settings.",
        };
      }
      const { tab } = await requireTab(ctx, payload);
      await tab.cdp.attach();
      const op = String(payload.op ?? "get") as "get" | "set" | "clear";
      if (op === "get") {
        const urls = Array.isArray(payload.urls) ? (payload.urls as string[]) : undefined;
        const cookies = await getCookies(tab.cdp, urls);
        return { cookies };
      }
      if (op === "set") {
        const cookie = payload.cookie as Parameters<typeof setCookie>[1] | undefined;
        if (!cookie || typeof cookie.name !== "string" || typeof cookie.value !== "string") {
          throw new Error("cookie.name and cookie.value required for op:set");
        }
        const ok = await setCookie(tab.cdp, cookie);
        return { ok };
      }
      if (op === "clear") {
        const filter = (payload.filter ?? undefined) as
          | { name?: string; domain?: string; url?: string }
          | undefined;
        return await clearCookies(tab.cdp, filter);
      }
      throw new Error(`unknown cookies op: ${op}`);
    }
    case "storage": {
      if (!ctx.allowDataAccess) {
        return {
          error:
            "storage is disabled. Enable 'Allow agents to read/write cookies and storage' in Y Space settings.",
        };
      }
      const { tab } = await requireTab(ctx, payload);
      await tab.cdp.attach();
      const kind = (payload.kind === "session" ? "session" : "local") as "local" | "session";
      const op = String(payload.op ?? "");
      if (op === "getAll") {
        const items = await storageGetAll(tab.cdp, kind);
        return { items };
      }
      if (op === "get") {
        const key = String(payload.key ?? "");
        if (!key) throw new Error("key required");
        const value = await storageGet(tab.cdp, kind, key);
        return { value };
      }
      if (op === "set") {
        const key = String(payload.key ?? "");
        const value = String(payload.value ?? "");
        if (!key) throw new Error("key required");
        await storageSet(tab.cdp, kind, key, value);
        return { ok: true };
      }
      if (op === "remove") {
        const key = String(payload.key ?? "");
        if (!key) throw new Error("key required");
        await storageRemove(tab.cdp, kind, key);
        return { ok: true };
      }
      if (op === "clear") {
        await storageClear(tab.cdp, kind);
        return { ok: true };
      }
      throw new Error(`unknown storage op: ${op}`);
    }
    case "dialog": {
      const { tab } = await requireTab(ctx, payload);
      await tab.cdp.attach();
      const op = String(payload.op ?? "set") as "set" | "wait" | "recent";
      if (op === "recent") {
        const limit = typeof payload.limit === "number" ? payload.limit : 10;
        return { dialogs: tab.dialogs.recent(limit) };
      }
      const action = (payload.action === "dismiss" ? "dismiss" : "accept") as "accept" | "dismiss";
      const promptText = typeof payload.promptText === "string" ? payload.promptText : undefined;
      const disposition = {
        action,
        ...(promptText != null ? { promptText } : {}),
      };
      if (op === "set") {
        tab.dialogs.setNextDisposition(disposition);
        return { ok: true, armed: disposition };
      }
      if (op === "wait") {
        const timeoutMs = typeof payload.timeoutMs === "number" ? payload.timeoutMs : 10_000;
        const entry = await tab.dialogs.waitForNext(disposition, timeoutMs);
        return entry ? { dialog: entry } : { dialog: null };
      }
      throw new Error(`unknown dialog op: ${op}`);
    }
    case "frames": {
      const { tab } = await requireTab(ctx, payload);
      await tab.cdp.attach();
      const frames = await getFrameTree(tab.cdp);
      return { frames };
    }
    case "addscript": {
      const { tab } = await requireTab(ctx, payload);
      await tab.cdp.attach();
      const op = String(payload.op ?? "add") as "add" | "remove" | "removeAll";
      if (op === "add") {
        const source = String(payload.source ?? "");
        if (!source) throw new Error("source required");
        return await tab.addInitScript(source);
      }
      if (op === "remove") {
        const identifier = String(payload.identifier ?? "");
        if (!identifier) throw new Error("identifier required");
        await tab.removeInitScript(identifier);
        return { ok: true };
      }
      if (op === "removeAll") {
        const removed = await tab.removeAllInitScripts();
        return { ok: true, removed };
      }
      throw new Error(`unknown addscript op: ${op}`);
    }
    case "addstyle": {
      const { tab } = await requireTab(ctx, payload);
      await tab.cdp.attach();
      const op = String(payload.op ?? "add") as "add" | "oneshot";
      const css = String(payload.css ?? "");
      if (!css) throw new Error("css required");
      if (op === "add") {
        return await tab.addInitStyle(css);
      }
      if (op === "oneshot") {
        await evaluateOneShotStyle(tab.cdp, css);
        return { ok: true };
      }
      throw new Error(`unknown addstyle op: ${op}`);
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function tabOverview(ctx: ToolContext): ReturnType<ToolContext["manager"]["snapshot"]> & {
  implicitTabId: string | null;
} {
  const state = agentVisibleState(ctx);
  return {
    ...state,
    implicitTabId: ctx.threadId
      ? (ctx.manager.getActiveTabForThread(ctx.threadId)?.tabId ?? null)
      : (ctx.manager.getActiveTab()?.tabId ?? null),
  };
}

function agentVisibleState(ctx: ToolContext): ReturnType<ToolContext["manager"]["snapshot"]> {
  const state = ctx.manager.snapshot();
  const tabs = state.tabs.filter((tab) => ctx.manager.getTab(tab.tabId) !== null);
  return {
    ...state,
    tabs,
    activeTabId: tabs.some((tab) => tab.tabId === state.activeTabId) ? state.activeTabId : null,
  };
}

function tabUrlMatches(
  candidate: string,
  requested: string,
  match: "exact" | "origin" | "prefix",
): boolean {
  if (match === "prefix") return candidate.startsWith(requested);
  if (match === "exact") return candidate === requested;
  try {
    return new URL(candidate).origin === new URL(requested).origin;
  } catch {
    return false;
  }
}
