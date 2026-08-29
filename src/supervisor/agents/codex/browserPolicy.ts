import {
  COMPETING_BROWSER_COMMAND_REGEX_SOURCE,
  hasYSpaceBrowserMcp,
} from "@/shared/browserExclusivePolicy";
import type { ResolvedMcpServer } from "@/shared/contracts";

const CODEX_BROWSER_EXCLUSIVE_CONFIG = [
  ["features.browser_use", false],
  ["features.browser_use_external", false],
  ["features.browser_use_full_cdp_access", false],
  ["features.in_app_browser", false],
  ["features.computer_use", false],
  ["features.standalone_web_search", false],
  // GPT-5.6 models can select Code Mode from the model catalog even when the
  // optional feature flag is off. Keep its isolated host available so the
  // model can orchestrate Y Space Browser calls, but force every default-
  // namespace tool (including shell/exec) to remain a direct model call where
  // the app-owned PreToolUse hook can enforce Browser exclusivity.
  ["features.code_mode.enabled", false],
  ["features.code_mode.direct_only_tool_namespaces", ["functions"]],
  ["features.code_mode_only", false],
  ["features.code_mode_host", true],
  ["web_search", "disabled"],
  ['plugins."browser@openai-bundled".enabled', false],
] as const;

export function buildCodexBrowserExclusiveConfig(
  mcpServers: readonly ResolvedMcpServer[],
): Record<string, boolean | string | readonly string[]> {
  return hasYSpaceBrowserMcp(mcpServers) ? Object.fromEntries(CODEX_BROWSER_EXCLUSIVE_CONFIG) : {};
}

/** Process-scoped Codex policy; never rewrites the user's config.toml. */
export function buildCodexBrowserExclusiveArgs(mcpServers: readonly ResolvedMcpServer[]): string[] {
  return Object.entries(buildCodexBrowserExclusiveConfig(mcpServers)).flatMap(([key, value]) => [
    "-c",
    `${key}=${typeof value === "boolean" ? String(value) : JSON.stringify(value)}`,
  ]);
}

/** Launch-scoped input consumed by the app-owned Codex PreToolUse hook. */
export function buildCodexBrowserExclusiveEnv(
  mcpServers: readonly ResolvedMcpServer[],
): Record<string, string> {
  return hasYSpaceBrowserMcp(mcpServers)
    ? {
        PORACODE_CODEX_BROWSER_EXCLUSIVE: "1",
        PORACODE_BROWSER_COMMAND_DENY_REGEX: COMPETING_BROWSER_COMMAND_REGEX_SOURCE,
      }
    : {};
}
