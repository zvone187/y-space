import { afterEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = [
  "PORACODE_COMPUTER_USE_MCP_URL",
  "PORACODE_COMPUTER_USE_MCP_TOKEN",
  "PORACODE_BROWSER_MCP_URL",
  "PORACODE_BROWSER_MCP_TOKEN",
  "PORACODE_APP_CONTROLS_MCP_URL",
  "PORACODE_APP_CONTROLS_MCP_TOKEN",
  "PORACODE_CHROME_MCP_URL",
  "PORACODE_CHROME_MCP_TOKEN",
  "PIPEDREAM_CLIENT_ID",
  "PIPEDREAM_CLIENT_SECRET",
  "PIPEDREAM_PROJECT_ID",
  "PIPEDREAM_ENVIRONMENT",
  "PIPEDREAM_ENV_FILE",
] as const;

const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
});

describe("sanitizedProcessEnv", () => {
  it("keeps launch-only MCP credentials out of ambient child environments", async () => {
    for (const key of ENV_KEYS) process.env[key] = `${key}-secret`;

    const { sanitizeChildProcessEnv, sanitizedProcessEnv } = await import("./spawnDiagnostics");

    for (const key of ENV_KEYS) {
      expect(sanitizedProcessEnv).not.toHaveProperty(key);
      expect(process.env[key]).toBe(`${key}-secret`);
    }
    expect(
      sanitizeChildProcessEnv({
        SAFE_VALUE: "kept",
        PORACODE_BROWSER_MCP_TOKEN: "late-browser-root",
        PORACODE_APP_CONTROLS_MCP_TOKEN: "late-controls-root",
        PIPEDREAM_CLIENT_SECRET: "late-pipedream-secret",
        pipedream_client_id: "case-insensitive-secret",
      }),
    ).toEqual({ SAFE_VALUE: "kept" });
  });
});
