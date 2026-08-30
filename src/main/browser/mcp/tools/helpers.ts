import { resolveRefToSelector } from "../../pageDriver";
import type { ResolvedBrowserTab, ToolContext } from "./types";

export function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

/** createTab options for an agent-created tab, carrying the calling thread so it
 *  joins that thread's tab group (named by the task). */
export function agentTabOpts(ctx: ToolContext): {
  agent: true;
  threadId?: string;
  threadTitle?: string;
} {
  return {
    agent: true,
    ...(ctx.threadId ? { threadId: ctx.threadId } : {}),
    ...(ctx.threadTitle ? { threadTitle: ctx.threadTitle } : {}),
  };
}

/** Presence ownership is per authenticated agent launch when that identity is
 * available. Legacy/test callers without a launch nonce retain their existing
 * per-thread behavior. Tab grouping itself intentionally remains per thread. */
export function automationSessionId(ctx: ToolContext): string {
  return ctx.launchId ? `launch:${ctx.launchId}` : (ctx.threadId ?? "unscoped");
}

export async function resolveTabId(
  ctx: ToolContext,
  payload: Record<string, unknown>,
): Promise<string> {
  const rememberResolvedTab = (tabId: string): string => {
    ctx.resolvedTabIdForToolCall = tabId;
    return tabId;
  };
  const sessionId = automationSessionId(ctx);
  const requested = typeof payload.tabId === "string" ? payload.tabId : null;
  if (requested) {
    if (!ctx.manager.getTab(requested)) throw new Error(`unknown tab ${requested}`);
    ctx.manager.recordAutomationTarget(sessionId, requested);
    // Marks agent activity + revives the tab if it was unmounted while idle.
    await ctx.manager.ensureTabReady(requested);
    if (ctx.threadId) ctx.manager.rememberTabForThread(ctx.threadId, requested);
    await ctx.manager.showAutomationCursor(sessionId, requested);
    return rememberResolvedTab(requested);
  }
  const active = ctx.threadId
    ? ctx.manager.getActiveTabForThread(ctx.threadId)
    : ctx.manager.getActiveTab();
  if (active) {
    ctx.manager.recordAutomationTarget(sessionId, active.tabId);
    await ctx.manager.ensureTabReady(active.tabId);
    await ctx.manager.showAutomationCursor(sessionId, active.tabId);
    return rememberResolvedTab(active.tabId);
  }
  ctx.manager.touchAutomationSession(sessionId);
  const info = await ctx.manager.createTab({ activate: true }, agentTabOpts(ctx));
  ctx.manager.recordAutomationTarget(sessionId, info.tabId);
  await ctx.manager.showAutomationCursor(sessionId, info.tabId);
  return rememberResolvedTab(info.tabId);
}

export async function resolveSelectorArg(
  tab: ResolvedBrowserTab,
  payload: Record<string, unknown>,
): Promise<string | null> {
  if (typeof payload.selector === "string" && payload.selector.length > 0) {
    return payload.selector;
  }
  if (typeof payload.ref === "string" && payload.ref.length > 0) {
    return await resolveRefToSelector(tab.webContents, payload.ref);
  }
  return null;
}

export async function requireTab(
  ctx: ToolContext,
  payload: Record<string, unknown>,
): Promise<{ tab: ResolvedBrowserTab }> {
  const tabId = await resolveTabId(ctx, payload);
  const tab = ctx.manager.getTab(tabId);
  if (!tab) throw new Error(`unknown tab ${tabId}`);
  return { tab };
}
