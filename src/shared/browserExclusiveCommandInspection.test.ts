import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isCompetingBrowserCommandOrScript } from "./browserExclusiveCommandInspection";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "y-space-browser-command-"));
  tempDirs.push(dir);
  return dir;
}

describe("browser-exclusive script command inspection", () => {
  it("denies a neutral Node script that fetches a page without exposing its contents", () => {
    const cwd = fixture();
    const scriptPath = join(cwd, "check.js");
    writeFileSync(scriptPath, "await fetch('https://secret.example.test/path?token=hidden');\n");

    expect(isCompetingBrowserCommandOrScript(`node ${scriptPath}`, cwd)).toBe(true);
  });

  it("denies a package script that delegates to Playwright", () => {
    const cwd = fixture();
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ scripts: { e2e: "playwright test" } }),
    );

    expect(isCompetingBrowserCommandOrScript("npm run e2e", cwd)).toBe(true);
  });

  it("denies browser routes hidden in pre/post package lifecycle scripts", () => {
    const cwd = fixture();
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({
        scripts: {
          precheck: "node precheck.js",
          check: "node check.js",
          postcheck: "playwright test",
        },
      }),
    );
    writeFileSync(join(cwd, "precheck.js"), "console.log('safe');\n");
    writeFileSync(join(cwd, "check.js"), "console.log('safe');\n");

    expect(isCompetingBrowserCommandOrScript("npm run check", cwd)).toBe(true);
  });

  it("denies AppleScript files that target alternate external browsers", () => {
    const cwd = fixture();
    writeFileSync(join(cwd, "launch.applescript"), 'tell application "Vivaldi" to activate\n');

    expect(isCompetingBrowserCommandOrScript("osascript launch.applescript", cwd)).toBe(true);
  });

  it("denies Python scripts that use subprocess or os.system to launch a browser", () => {
    const cwd = fixture();
    writeFileSync(
      join(cwd, "launch.py"),
      "import subprocess\nsubprocess.run(['open', 'https://secret.example.test'])\n",
    );
    writeFileSync(join(cwd, "launch-other.py"), "import os\nos.system('firefox')\n");

    expect(isCompetingBrowserCommandOrScript("python launch.py", cwd)).toBe(true);
    expect(isCompetingBrowserCommandOrScript("python launch-other.py", cwd)).toBe(true);
  });

  it("preserves an inspectable build script with no web or browser route", () => {
    const cwd = fixture();
    writeFileSync(join(cwd, "build.mjs"), "console.log('build');\n");
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ scripts: { build: "node build.mjs" } }),
    );

    expect(isCompetingBrowserCommandOrScript("pnpm run build", cwd)).toBe(false);
  });

  it("fails closed when an invoked script or package manifest cannot be inspected", () => {
    const cwd = fixture();
    expect(isCompetingBrowserCommandOrScript("node missing.js", cwd)).toBe(true);
    expect(isCompetingBrowserCommandOrScript("npm run missing", cwd)).toBe(true);
  });

  it.each(["npm install", "pnpm add vitest"])(
    "does not misclassify package-manager built-in command %s",
    (command) => {
      const cwd = fixture();
      expect(isCompetingBrowserCommandOrScript(command, cwd)).toBe(false);
    },
  );
});
