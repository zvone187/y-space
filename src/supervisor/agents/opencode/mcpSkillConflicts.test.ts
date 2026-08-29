import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveOpenCodeProfileMcpNamesForPaths,
  resolveOpenCodeConfigPaths,
} from "./mcpSkillConflicts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("OpenCode MCP conflicts", () => {
  it("uses effective distro config overrides for WSL terminal launches", () => {
    const location = {
      kind: "wsl" as const,
      distro: "Ubuntu",
      linuxPath: "/work/project",
      uncPath: "\\\\wsl.localhost\\Ubuntu\\work\\project",
    };

    expect(
      resolveOpenCodeConfigPaths(location, {
        HOME: "/home/demo",
        XDG_CONFIG_HOME: "/srv/xdg",
        OPENCODE_CONFIG: "/run/user/1000/opencode-browser.jsonc",
      }),
    ).toEqual([
      "\\\\wsl.localhost\\Ubuntu\\srv\\xdg\\opencode\\opencode.jsonc",
      "\\\\wsl.localhost\\Ubuntu\\srv\\xdg\\opencode\\opencode.json",
      "\\\\wsl.localhost\\Ubuntu\\work\\project\\opencode.jsonc",
      "\\\\wsl.localhost\\Ubuntu\\work\\project\\opencode.json",
      "\\\\wsl.localhost\\Ubuntu\\run\\user\\1000\\opencode-browser.jsonc",
    ]);
  });

  it("resolves relative WSL config overrides against distro HOME and project cwd", () => {
    const location = {
      kind: "wsl" as const,
      distro: "Ubuntu",
      linuxPath: "/work/project",
      uncPath: "\\\\wsl.localhost\\Ubuntu\\work\\project",
    };

    expect(
      resolveOpenCodeConfigPaths(location, {
        HOME: "/home/demo",
        OPENCODE_CONFIG_DIR: ".settings/opencode",
        OPENCODE_CONFIG: "configs/browser.json",
      }),
    ).toEqual([
      "\\\\wsl.localhost\\Ubuntu\\home\\demo\\.settings\\opencode\\opencode.jsonc",
      "\\\\wsl.localhost\\Ubuntu\\home\\demo\\.settings\\opencode\\opencode.json",
      "\\\\wsl.localhost\\Ubuntu\\work\\project\\opencode.jsonc",
      "\\\\wsl.localhost\\Ubuntu\\work\\project\\opencode.json",
      "\\\\wsl.localhost\\Ubuntu\\work\\project\\configs\\browser.json",
    ]);
  });

  it("finds every enabled unmanaged profile MCP so neutral dynamic tools fail closed", () => {
    const dir = mkdtempSync(join(tmpdir(), "y-space-opencode-conflict-"));
    tempDirs.push(dir);
    const configPath = join(dir, "opencode.jsonc");
    writeFileSync(
      configPath,
      `{
        // A deliberately generic name must not hide the driver.
        mcp: {
          e2e: { type: "local", command: ["npx", "-y", "@playwright/mcp@latest"] },
          github: { type: "remote", url: "https://api.github.test/mcp" },
          analytics: { type: "remote", url: "https://example.test/browser-events/mcp" },
          pipedream: { type: "local", command: ["node", "server.js"], cwd: "/repo/browser-ui" },
          alreadyOff: { type: "local", command: ["puppeteer"], enabled: false },
        },
      }`,
    );

    expect(resolveOpenCodeProfileMcpNamesForPaths([configPath])).toEqual([
      "e2e",
      "github",
      "analytics",
      "pipedream",
    ]);
  });

  it("does not copy malformed config contents or credentials into logs", () => {
    const dir = mkdtempSync(join(tmpdir(), "y-space-opencode-malformed-"));
    tempDirs.push(dir);
    const configPath = join(dir, "opencode.json");
    const secret = "pd-secret-must-not-reach-logs";
    writeFileSync(configPath, `{ mcp: { pipedream: { token: "${secret}`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(resolveOpenCodeProfileMcpNamesForPaths([configPath])).toEqual([]);
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
    warn.mockRestore();
  });
});
