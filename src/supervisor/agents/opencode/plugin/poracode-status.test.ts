import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const pluginUrl = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "poracode-status.mjs"),
).href;
const tempDirs: string[] = [];

interface HookResult {
  denied: boolean;
  message?: string;
}

function invokeToolHook(
  tool: string,
  args: Record<string, unknown>,
  browserExclusive = true,
): HookResult {
  const runner = `
    const pluginModule = await import(${JSON.stringify(pluginUrl)});
    const hooks = await pluginModule.default.server();
    try {
      await hooks["tool.execute.before"](
        { tool: process.env.Y_SPACE_TEST_TOOL, sessionID: "test-session" },
        { args: JSON.parse(process.env.Y_SPACE_TEST_TOOL_ARGS) },
      );
      process.stdout.write(JSON.stringify({ denied: false }));
    } catch (error) {
      process.stdout.write(JSON.stringify({
        denied: true,
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", runner], {
    encoding: "utf8",
    env: {
      ...process.env,
      PORACODE_OPENCODE_BROWSER_EXCLUSIVE: browserExclusive ? "1" : "0",
      PORACODE_HOOK_URL: "",
      Y_SPACE_TEST_TOOL: tool,
      Y_SPACE_TEST_TOOL_ARGS: JSON.stringify(args),
    },
  });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as HookResult;
}

function invokeShellHook(command: string, cwd: string, browserExclusive = true): HookResult {
  return invokeToolHook("bash", { command, cwd }, browserExclusive);
}

function createProject(): string {
  const project = mkdtempSync(join(tmpdir(), "y-space-opencode-script-policy-"));
  tempDirs.push(project);
  writeFileSync(join(project, "browser-script.js"), "await fetch('https://example.test');\n");
  writeFileSync(join(project, "safe-script.js"), "console.log('local only');\n");
  writeFileSync(join(project, "launch.applescript"), 'tell application "Opera" to activate\n');
  writeFileSync(
    join(project, "launch.py"),
    "import subprocess\nsubprocess.Popen(['brave-browser'])\n",
  );
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({
      scripts: {
        e2e: "playwright test",
        build: "node safe-script.js",
        check: "node safe-script.js",
        postcheck: "node browser-script.js",
      },
    }),
  );
  return project;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("OpenCode Browser-exclusive shell hook", () => {
  it("denies browser retrieval hidden behind node and package scripts", () => {
    const project = createProject();

    for (const command of [
      "node browser-script.js",
      "osascript launch.applescript",
      "python launch.py",
      "npm run e2e",
      "npm run check",
    ]) {
      const result = invokeShellHook(command, project);
      expect(result.denied).toBe(true);
      expect(result.message).toMatch(/Y Space Browser/iu);
      expect(result.message).not.toContain("example.test");
    }
  });

  it("allows local scripts and package-manager install commands", () => {
    const project = createProject();

    for (const command of [
      "node safe-script.js",
      "pnpm run build",
      "npm install lodash",
      "pnpm add axios",
    ]) {
      expect(invokeShellHook(command, project)).toEqual({ denied: false });
    }
  });

  it("restores normal shell behavior when the Browser is globally disabled", () => {
    const project = createProject();

    expect(invokeShellHook("node browser-script.js", project, false)).toEqual({ denied: false });
  });

  it.each(["GStack", "vendor/PlayWright", "plugin:CONTROL-IN-APP-BROWSER"])(
    "denies case and namespace variants of Browser skill %s",
    (name) => {
      const result = invokeToolHook("skill", { name });
      expect(result.denied).toBe(true);
      expect(result.message).toMatch(/Y Space Browser/iu);
    },
  );
});
