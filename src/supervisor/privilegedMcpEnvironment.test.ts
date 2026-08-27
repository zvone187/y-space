import { afterEach, describe, expect, it, vi } from "vitest";

const KEYS = [
  "PORACODE_BROWSER_MCP_URL",
  "PORACODE_BROWSER_MCP_TOKEN",
  "PORACODE_COMPUTER_USE_MCP_URL",
  "PORACODE_COMPUTER_USE_MCP_TOKEN",
  "PORACODE_APP_CONTROLS_MCP_URL",
  "PORACODE_APP_CONTROLS_MCP_TOKEN",
  "PORACODE_CHROME_MCP_URL",
  "PORACODE_CHROME_MCP_TOKEN",
] as const;

const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  vi.resetModules();
  for (const key of KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("privileged MCP environment", () => {
  it("captures ingress roots once and removes every ambient child-process copy", async () => {
    process.env.PORACODE_BROWSER_MCP_URL = "http://127.0.0.1:41001";
    process.env.PORACODE_BROWSER_MCP_TOKEN = "browser-root";
    process.env.PORACODE_APP_CONTROLS_MCP_URL = "http://127.0.0.1:41002";
    process.env.PORACODE_APP_CONTROLS_MCP_TOKEN = "controls-root";
    process.env.PORACODE_CHROME_MCP_URL = "http://legacy.invalid";
    process.env.PORACODE_CHROME_MCP_TOKEN = "legacy-root";
    const { capturePrivilegedMcpEnvironment, readPrivilegedMcpEnvironment } =
      await import("./privilegedMcpEnvironment");

    capturePrivilegedMcpEnvironment();

    for (const key of KEYS) expect(process.env[key]).toBeUndefined();
    expect(readPrivilegedMcpEnvironment("browser")).toEqual({
      url: "http://127.0.0.1:41001",
      token: "browser-root",
    });
    expect(readPrivilegedMcpEnvironment("app-controls")).toEqual({
      url: "http://127.0.0.1:41002",
      token: "controls-root",
    });

    // A later ambient spoof cannot replace the launch root captured at boot.
    process.env.PORACODE_BROWSER_MCP_TOKEN = "spoofed-root";
    expect(readPrivilegedMcpEnvironment("browser")?.token).toBe("browser-root");
  });
});
