import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COMPETING_BROWSER_COMMAND_REGEX_SOURCE } from "@/shared/browserExclusivePolicy";

const sourceForwardPath = fileURLToPath(new URL("./forward.mjs", import.meta.url));
const sourceRuntimePath = fileURLToPath(
  new URL("../../plugin/forward-runtime/poracode-hook-runtime.mjs", import.meta.url),
);
const stagingDir = mkdtempSync(join(tmpdir(), "y-space-claude-forward-test-"));
const forwardPath = join(stagingDir, "forward.mjs");

beforeAll(() => {
  copyFileSync(sourceForwardPath, forwardPath);
  copyFileSync(sourceRuntimePath, join(stagingDir, "poracode-hook-runtime.mjs"));
  writeFileSync(join(stagingDir, "plugin.json"), JSON.stringify({ version: "test" }), "utf8");
  writeFileSync(
    join(stagingDir, "browser-script.js"),
    "await fetch('https://private.example.test/path?token=do-not-log');\n",
    "utf8",
  );
  writeFileSync(join(stagingDir, "safe-script.js"), "console.log('safe');\n", "utf8");
  writeFileSync(
    join(stagingDir, "launch.applescript"),
    'tell application "Comet" to activate\n',
    "utf8",
  );
  writeFileSync(join(stagingDir, "launch.py"), "import os\nos.system('firefox')\n", "utf8");
  writeFileSync(
    join(stagingDir, "package.json"),
    JSON.stringify({
      scripts: {
        e2e: "playwright test",
        build: "node safe-script.js",
        check: "node safe-script.js",
        postcheck: "node browser-script.js",
      },
    }),
    "utf8",
  );
});

afterAll(() => rmSync(stagingDir, { recursive: true, force: true }));

function runPreToolUse(command: string, browserExclusive = true): string {
  const result = spawnSync(process.execPath, [forwardPath, "PreToolUse"], {
    encoding: "utf8",
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "session-1",
      tool_name: "Bash",
      tool_input: { command, cwd: stagingDir },
    }),
    env: {
      ...process.env,
      NODE_NO_WARNINGS: "1",
      PORACODE_CLAUDE_BROWSER_EXCLUSIVE: browserExclusive ? "1" : "0",
      PORACODE_BROWSER_COMMAND_DENY_REGEX: COMPETING_BROWSER_COMMAND_REGEX_SOURCE,
    },
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  return result.stdout;
}

describe("Claude terminal Browser-exclusive PreToolUse hook", () => {
  it.each([
    "node browser-script.js",
    "osascript launch.applescript",
    "python launch.py",
    "npm run e2e",
    "npm run check",
  ])("denies browser work hidden behind %s", (command) => {
    expect(JSON.parse(runPreToolUse(command))).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringMatching(/Y Space Browser/iu),
      },
    });
    expect(runPreToolUse(command)).not.toContain("private.example.test");
  });

  it.each(["node safe-script.js", "pnpm run build", "npm install", "pnpm add vitest"])(
    "preserves non-browser command %s",
    (command) => {
      expect(runPreToolUse(command)).toBe("");
    },
  );

  it("restores the provider shell when the Browser is globally disabled", () => {
    expect(runPreToolUse("node browser-script.js", false)).toBe("");
  });
});
