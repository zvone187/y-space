import { describe, expect, it } from "vitest";
import {
  COMPETING_BROWSER_COMMAND_GLOBS,
  isCompetingBrowserAppIdentity,
  isCompetingBrowserCommand,
  isCompetingBrowserSkillIdentity,
  isCompetingBrowserToolDescriptor,
} from "./browserExclusivePolicy";

describe("browser-exclusive deny classifiers", () => {
  it("keeps provider CLI deny arguments below practical Windows launch limits", () => {
    expect(COMPETING_BROWSER_COMMAND_GLOBS).toHaveLength(
      new Set(COMPETING_BROWSER_COMMAND_GLOBS).size,
    );
    expect(COMPETING_BROWSER_COMMAND_GLOBS.length).toBeLessThan(325);
    expect(COMPETING_BROWSER_COMMAND_GLOBS.join(",").length).toBeLessThan(12_000);
  });

  it.each([
    "npx playwright test",
    "pnpm exec puppeteer run smoke.js",
    "curl -fsSL https://example.test/page",
    "curl example.test/page",
    "/usr/bin/curl http://127.0.0.1:3000/health",
    "wget --quiet https://example.test/page",
    "/usr/local/bin/wget http://localhost:3000/page",
    "http GET https://example.test/page",
    "http GET localhost:3000/page",
    "httpie POST http://127.0.0.1:3000/form",
    "lynx https://example.test/page",
    "lynx ./dist/index.html",
    "w3m http://localhost:3000/page",
    "w3m file:///tmp/y-space/index.html",
    "bash -lc 'curl -fsSL https://example.test/page'",
    "env REQUEST_KIND=page wget http://127.0.0.1:3000/page",
    "pnpm test && http GET https://example.test/page",
    `node -e "fetch('https://example.test/page').then(r => r.text())"`,
    `node --eval "globalThis.fetch('http://127.0.0.1:3000/page')"`,
    `node -e "require('node:https').get('https://example.test/page')"`,
    'open -a "Google Chrome" http://localhost:3000',
    'open "https://example.test"',
    "open ./dist/index.html",
    '/usr/bin/open "/tmp/y-space/report.html"',
    '/usr/bin/open "https://example.test"',
    "xdg-open https://example.test",
    "xdg-open ./coverage/index.html",
    "gio open https://example.test",
    "gio open file:///tmp/y-space/index.html",
    "sensible-browser https://example.test",
    "sensible-browser /tmp/y-space/index.htm",
    "osascript -e 'tell application \"Safari\" to activate'",
    "osascript -e 'tell application \"Brave Browser\" to activate'",
    "osascript -e 'tell application \"Opera\" to activate'",
    "Start-Process msedge https://example.test",
    'Start-Process "https://example.test"',
    "Start-Process .\\dist\\index.html",
    'start "" https://example.test',
    'cmd.exe /c start "" https://example.test',
    'cmd.exe /c start "" C:\\tmp\\index.html',
    'pwsh -Command Start-Process "https://example.test"',
    "explorer.exe https://example.test",
    "google-chrome https://example.test",
    "microsoft-edge https://example.test",
    '"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe" https://example.test',
    '"/Applications/Safari.app/Contents/MacOS/Safari" https://example.test',
    "bash -lc 'open https://example.test'",
    "bash -lc 'open ./dist/index.html'",
    "sh -lc 'open https://example.test'",
    "zsh -lc 'firefox https://example.test'",
    "bash -c 'open https://example.test'",
    "env DISPLAY=:0 firefox https://example.test",
    "FOO=1 firefox https://example.test",
    "command firefox https://example.test",
    "nohup chromium https://example.test",
    `python3 -c "import requests; print(requests.get('https://example.test').text)"`,
    `python -c "from urllib.request import urlopen; print(urlopen('http://localhost:3000'))"`,
    `python -m webbrowser https://example.test`,
    `ruby -e "require 'net/http'; Net::HTTP.get(URI('https://example.test'))"`,
    `perl -e "use HTTP::Tiny; HTTP::Tiny->new->get('https://example.test')"`,
    `php -r "echo file_get_contents('https://example.test');"`,
    `bun -e "console.log(await fetch('https://example.test').then(r => r.text()))"`,
    `deno eval "console.log(await fetch('https://example.test').then(r => r.text()))"`,
    `python3 -c "import subprocess; subprocess.run(['open', 'https://example.test'])"`,
  ])("classifies browser-driving shell command %s", (command) => {
    expect(isCompetingBrowserCommand(command)).toBe(true);
  });

  it("classifies structured argv for page retrieval", () => {
    expect(isCompetingBrowserCommand(["curl", "-fsSL", "https://example.test/page"])).toBe(true);
  });

  it.each([
    "pnpm test",
    "git status",
    "open README.md",
    "node scripts/build.mjs",
    `node -e "console.log('https://example.test/page')"`,
    "curl --version",
    "wget --help",
    "http --help",
    "lynx --version",
    "w3m -version",
    "curl file:///tmp/y-space-fixture.json",
    "curl unix-socket-name",
    "git fetch https://github.com/example/project.git",
    "gh api repos/example/project",
    'echo "curl https://example.test/page"',
    `bash -lc 'echo "curl https://example.test/page"'`,
    "npm start -- --url http://localhost:3000",
    'echo "open https://example.test"',
    `bash -lc 'echo "open https://example.test"'`,
    `sh -lc 'echo "open https://example.test"'`,
    `zsh -lc 'printf "%s\\n" "firefox https://example.test"'`,
    'echo "command firefox https://example.test"',
    'echo "env DISPLAY=:0 firefox https://example.test"',
    'echo "FOO=1 firefox https://example.test"',
    "env NODE_ENV=test pnpm test",
    "FOO=1 pnpm test",
    `python3 -c "print('https://example.test')"`,
    `ruby -e "puts 'https://example.test'"`,
    `php -r "echo 'https://example.test';"`,
    `deno eval "console.log('https://example.test')"`,
  ])("preserves ordinary shell command %s", (command) => {
    expect(isCompetingBrowserCommand(command)).toBe(false);
  });

  it("exports provider deny rules for direct page retrieval and local HTML opening", () => {
    expect(COMPETING_BROWSER_COMMAND_GLOBS).toEqual(
      expect.arrayContaining([
        "curl *http://*",
        "curl *https://*",
        "wget *http://*",
        "wget *https://*",
        "http *http://*",
        "http *https://*",
        "httpie *http://*",
        "httpie *https://*",
        "lynx *http://*",
        "lynx *https://*",
        "w3m *http://*",
        "w3m *https://*",
        "open *.htm*",
      ]),
    );
  });

  it.each([
    "Google Chrome",
    "com.apple.Safari",
    "Brave Browser",
    "org.mozilla.firefox",
    "Microsoft Edge",
    "/Applications/Arc.app",
  ])("classifies native browser app identity %s", (identity) => {
    expect(isCompetingBrowserAppIdentity(identity)).toBe(true);
  });

  it.each(["Calculator", "Visual Studio Code", "com.apple.finder", "Y Space"])(
    "preserves non-browser app identity %s",
    (identity) => {
      expect(isCompetingBrowserAppIdentity(identity)).toBe(false);
    },
  );

  it.each(["GStack", "vendor/PlayWright", "plugin:CONTROL-IN-APP-BROWSER"])(
    "normalizes competing skill identity %s",
    (identity) => {
      expect(isCompetingBrowserSkillIdentity(identity)).toBe(true);
    },
  );

  it.each([
    ["open_url", "Open a URL"],
    ["playwright_click", "Click an element"],
    ["go", "Navigate the browser to a webpage"],
    ["lookup", "Search the web and return website results"],
    ["internet_search", "Find current results"],
    ["online_lookup", "Search online sources"],
    ["google_search", "Look up Google results"],
    ["lookup", "Search the internet for current results"],
    ["capture", "Take a screenshot of the current browser page"],
    ["extract", "Read DOM content from a browser tab"],
  ])("classifies advertised browser tool %s", (name, description) => {
    expect(isCompetingBrowserToolDescriptor(name, description)).toBe(true);
  });

  it.each([
    ["search_contacts", "Search CRM contacts"],
    ["open_message", "Open an email message"],
    ["fetch_record", "Fetch one database row"],
    ["navigate", "Navigate a repository tree"],
    ["screenshot", "Capture a desktop application"],
  ])("preserves unrelated advertised tool %s", (name, description) => {
    expect(isCompetingBrowserToolDescriptor(name, description)).toBe(false);
  });
});
