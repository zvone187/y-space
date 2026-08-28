import { PIPEDREAM_ENV_KEYS } from "@/shared/pipedreamBootstrap";

/**
 * Credentials that are valid only inside the main/supervisor control plane.
 *
 * Keep this list independent of provider launch modules: shell profiles,
 * direnv, adapter overrides, and SDK-supplied environments can all reintroduce
 * a value after bootstrap removed it from `process.env`. Every untrusted child
 * boundary therefore filters against this one case-insensitive denylist.
 */
export const PRIVILEGED_CHILD_ENV_KEYS = [
  "PORACODE_BROWSER_MCP_URL",
  "PORACODE_BROWSER_MCP_TOKEN",
  "PORACODE_COMPUTER_USE_MCP_URL",
  "PORACODE_COMPUTER_USE_MCP_TOKEN",
  "PORACODE_APP_CONTROLS_MCP_URL",
  "PORACODE_APP_CONTROLS_MCP_TOKEN",
  // Compatibility cleanup for the retired external-Chrome controller.
  "PORACODE_CHROME_MCP_URL",
  "PORACODE_CHROME_MCP_TOKEN",
  ...PIPEDREAM_ENV_KEYS,
  "PIPEDREAM_ENV_FILE",
] as const;

const PRIVILEGED_CHILD_ENV_KEY_SET = new Set<string>(
  PRIVILEGED_CHILD_ENV_KEYS.map((key) => key.toUpperCase()),
);

export function isPrivilegedChildEnvKey(key: string): boolean {
  return PRIVILEGED_CHILD_ENV_KEY_SET.has(key.toUpperCase());
}

/** Convert any env-like record to a node child-safe, privilege-free record. */
export function sanitizePrivilegedChildEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== "string" || value.includes("\0")) continue;
    if (isPrivilegedChildEnvKey(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Login profiles run after the host env is filtered and may export secrets
 * again. Prefix the final shell script with an explicit unset before exec.
 */
export function posixPrivilegedEnvironmentUnsetPrefix(): string {
  const canonicalKeys = PRIVILEGED_CHILD_ENV_KEYS.join(" ");
  const awkProgram = [
    `BEGIN { split("${canonicalKeys}", keys, " ");`,
    "for (i in keys) denied[keys[i]] = 1 }",
    '{ name = $0; sub(/=.*/, "", name); if (denied[toupper(name)]) print name }',
  ].join(" ");
  return [
    `unset ${canonicalKeys};`,
    `for __y_space_privileged_env_name in $(/usr/bin/env | /usr/bin/awk '${awkProgram}'); do`,
    'unset "$__y_space_privileged_env_name";',
    "done;",
    "unset __y_space_privileged_env_name; ",
  ].join(" ");
}
