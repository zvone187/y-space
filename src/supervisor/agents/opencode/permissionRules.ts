import type { PermissionRule } from "./legacySdk";
import {
  COMPETING_BROWSER_COMMAND_GLOBS,
  COMPETING_BROWSER_SKILL_NAMES,
} from "@/shared/browserExclusivePolicy";

/**
 * Build the Poracode-owned permission override for OpenCode sessions.
 *
 * Supervised mode intentionally returns undefined so OpenCode resolves
 * permissions from its normal global + project config stack.
 */
export function buildOpenCodePermissionRules(
  approvalPolicy: string | undefined,
  browserExclusive = false,
): PermissionRule[] | undefined {
  const isFullAccess = approvalPolicy === "yolo" || approvalPolicy === "never";
  if (!isFullAccess) return undefined;

  const rules: PermissionRule[] = [{ permission: "*", pattern: "*", action: "allow" }];
  if (!browserExclusive) return rules;

  return [
    ...rules,
    // These launch-owned denies must follow the wildcard allow: OpenCode uses
    // the last matching rule, so reversing the order silently re-enables the
    // provider routes in full-access sessions.
    { permission: "webfetch", pattern: "*", action: "deny" },
    { permission: "websearch", pattern: "*", action: "deny" },
    ...COMPETING_BROWSER_SKILL_NAMES.map((pattern) => ({
      permission: "skill",
      pattern,
      action: "deny" as const,
    })),
    ...COMPETING_BROWSER_COMMAND_GLOBS.map((pattern) => ({
      permission: "bash",
      pattern,
      action: "deny" as const,
    })),
    { permission: "playwright_*", pattern: "*", action: "deny" },
    { permission: "puppeteer_*", pattern: "*", action: "deny" },
    { permission: "selenium_*", pattern: "*", action: "deny" },
    { permission: "gstack_*", pattern: "*", action: "deny" },
    { permission: "stagehand_*", pattern: "*", action: "deny" },
    { permission: "browserbase_*", pattern: "*", action: "deny" },
    { permission: "browserstack_*", pattern: "*", action: "deny" },
    { permission: "browserless_*", pattern: "*", action: "deny" },
    { permission: "chrome_*", pattern: "*", action: "deny" },
    { permission: "chromium_*", pattern: "*", action: "deny" },
    { permission: "chrome-devtools_*", pattern: "*", action: "deny" },
    { permission: "chrome_devtools_*", pattern: "*", action: "deny" },
    { permission: "firefox_*", pattern: "*", action: "deny" },
    { permission: "webkit_*", pattern: "*", action: "deny" },
    { permission: "webdriver_*", pattern: "*", action: "deny" },
    { permission: "node_repl_*", pattern: "*", action: "deny" },
    { permission: "browser-use_*", pattern: "*", action: "deny" },
    { permission: "browser_use_*", pattern: "*", action: "deny" },
  ];
}
