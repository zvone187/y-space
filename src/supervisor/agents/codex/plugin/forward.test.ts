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
const stagingDir = mkdtempSync(join(tmpdir(), "y-space-codex-forward-test-"));
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
    'tell application "Vivaldi" to activate\n',
    "utf8",
  );
  writeFileSync(
    join(stagingDir, "launch.py"),
    "import subprocess\nsubprocess.run(['open', 'https://example.test'])\n",
    "utf8",
  );
  writeFileSync(
    join(stagingDir, "package.json"),
    JSON.stringify({
      scripts: {
        e2e: "playwright test",
        build: "node safe-script.js",
        check: "node safe-script.js",
        postcheck: "playwright test",
      },
    }),
    "utf8",
  );
});

afterAll(() => rmSync(stagingDir, { recursive: true, force: true }));

function runPreToolUse(
  toolInput: Record<string, unknown>,
  browserExclusive: boolean,
  toolName = "Bash",
): string {
  const result = spawnSync(process.execPath, [forwardPath, "PreToolUse"], {
    encoding: "utf8",
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "session-1",
      turn_id: "turn-1",
      tool_name: toolName,
      tool_input: toolInput,
    }),
    env: {
      ...process.env,
      NODE_NO_WARNINGS: "1",
      PORACODE_CODEX_BROWSER_EXCLUSIVE: browserExclusive ? "1" : "0",
      PORACODE_BROWSER_COMMAND_DENY_REGEX: COMPETING_BROWSER_COMMAND_REGEX_SOURCE,
    },
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  return result.stdout;
}

describe("Codex browser-exclusive PreToolUse hook", () => {
  it.each([
    "npx playwright test",
    'open -a "Google Chrome" http://localhost:3000',
    'open "https://example.test"',
    "google-chrome https://example.test",
    'cmd.exe /c start "" https://example.test',
    "osascript -e 'tell application \"Safari\" to activate'",
    "bash -lc 'open https://example.test'",
    "sh -lc 'open https://example.test'",
    "zsh -lc 'firefox https://example.test'",
    "bash -c 'open https://example.test'",
    "env DISPLAY=:0 firefox https://example.test",
    "FOO=1 firefox https://example.test",
    "command firefox https://example.test",
    "nohup chromium https://example.test",
  ])("denies browser-driving shell command %s", (command) => {
    expect(JSON.parse(runPreToolUse({ command }, true))).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringMatching(/Y Space Browser/iu),
      },
    });
  });

  it.each([
    ["exec_command", { cmd: "curl -fsSL https://example.test/page" }],
    ["functions.exec_command", { cmd: "wget -q http://127.0.0.1:3000/page" }],
    ["exec_command", { cmd: ["http", "GET", "https://example.test/page"] }],
    ["functions.exec_command", { command: ["lynx", "https://example.test/page"] }],
  ])("denies the real %s unified-exec input schema", (toolName, toolInput) => {
    expect(JSON.parse(runPreToolUse(toolInput, true, toolName))).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringMatching(/Y Space Browser/iu),
      },
    });
  });

  it.each([
    { command: "pnpm test", cmd: "curl https://example.test/page" },
    { command: "wget https://example.test/page", cmd: "git status" },
  ])("inspects both command fields when a tool supplies both", (toolInput) => {
    expect(JSON.parse(runPreToolUse(toolInput, true, "functions.exec_command"))).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringMatching(/Y Space Browser/iu),
      },
    });
  });

  it.each([
    "pnpm test",
    `sh -lc 'echo "open https://example.test"'`,
    `zsh -lc 'printf "%s\\n" "firefox https://example.test"'`,
    'echo "env DISPLAY=:0 firefox https://example.test"',
    'echo "FOO=1 firefox https://example.test"',
    "env NODE_ENV=test pnpm test",
    "FOO=1 pnpm test",
  ])("preserves ordinary shell command %s", (command) => {
    expect(runPreToolUse({ command }, true)).toBe("");
  });

  it.each(["exec_command", "functions.exec_command"])(
    "preserves ordinary %s unified-exec input",
    (toolName) => {
      expect(runPreToolUse({ cmd: "pnpm test" }, true, toolName)).toBe("");
    },
  );

  it.each([
    `node ${join(stagingDir, "browser-script.js")}`,
    `osascript ${join(stagingDir, "launch.applescript")}`,
    `python ${join(stagingDir, "launch.py")}`,
    "npm run e2e",
    "npm run check",
  ])("denies browser work hidden behind script indirection: %s", (command) => {
    expect(JSON.parse(runPreToolUse({ command, cwd: stagingDir }, true))).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringMatching(/Y Space Browser/iu),
      },
    });
  });

  it.each([`node ${join(stagingDir, "safe-script.js")}`, "pnpm run build"])(
    "preserves inspectable non-browser script command %s",
    (command) => {
      expect(runPreToolUse({ command, cwd: stagingDir }, true)).toBe("");
    },
  );

  it.each(["npm install", "pnpm add vitest"])(
    "preserves package-manager built-in command %s",
    (command) => {
      expect(runPreToolUse({ command, cwd: stagingDir }, true)).toBe("");
    },
  );

  it("is disabled outside a managed Browser launch", () => {
    expect(runPreToolUse({ command: "npx playwright test" }, false)).toBe("");
  });

  it("does not mistake apply_patch content for an executable shell command", () => {
    expect(runPreToolUse({ command: "+ Run npx playwright test in CI" }, true, "apply_patch")).toBe(
      "",
    );
  });
});
