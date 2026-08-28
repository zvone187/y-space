export interface PrivilegedMcpEnvironment {
  url: string;
  token: string;
}

type PrivilegedMcpServerId = "browser" | "computer-use" | "app-controls";

const MCP_ENV_KEYS = {
  browser: {
    url: "PORACODE_BROWSER_MCP_URL",
    token: "PORACODE_BROWSER_MCP_TOKEN",
  },
  "computer-use": {
    url: "PORACODE_COMPUTER_USE_MCP_URL",
    token: "PORACODE_COMPUTER_USE_MCP_TOKEN",
  },
  "app-controls": {
    url: "PORACODE_APP_CONTROLS_MCP_URL",
    token: "PORACODE_APP_CONTROLS_MCP_TOKEN",
  },
} as const satisfies Record<PrivilegedMcpServerId, { url: string; token: string }>;

let configured = false;
const captured = new Map<PrivilegedMcpServerId, PrivilegedMcpEnvironment>();

/**
 * Capture main-process MCP ingress roots once, then remove them from the
 * supervisor's ambient environment before it can spawn any provider, shell,
 * probe, hook, or tool subprocess. Launch resolvers read the in-memory copy.
 */
export function capturePrivilegedMcpEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  if (configured) return;
  configured = true;
  for (const serverId of Object.keys(MCP_ENV_KEYS) as PrivilegedMcpServerId[]) {
    const keys = MCP_ENV_KEYS[serverId];
    const url = env[keys.url];
    const token = env[keys.token];
    if (url && token) captured.set(serverId, { url, token });
    delete env[keys.url];
    delete env[keys.token];
  }
  // Retired external-browser credentials must not survive an upgrade into a
  // provider subprocess either, even though no launch resolver consumes them.
  delete env.PORACODE_CHROME_MCP_URL;
  delete env.PORACODE_CHROME_MCP_TOKEN;
}

/**
 * Read the captured production credentials. Before supervisor bootstrap this
 * falls back to process.env so isolated resolver tests and tooling remain
 * deterministic without mutating global module state.
 */
export function readPrivilegedMcpEnvironment(
  serverId: PrivilegedMcpServerId,
): PrivilegedMcpEnvironment | null {
  if (configured) return captured.get(serverId) ?? null;
  const keys = MCP_ENV_KEYS[serverId];
  const url = process.env[keys.url];
  const token = process.env[keys.token];
  return url && token ? { url, token } : null;
}
