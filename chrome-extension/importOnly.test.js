import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const extensionDirectory = new URL("./", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", extensionDirectory), "utf8"));
const background = await readFile(new URL("background.js", extensionDirectory), "utf8");
const popup = await readFile(new URL("popup.html", extensionDirectory), "utf8");

await test("extension permissions are limited to cookie import and local pairing", () => {
  assert.deepEqual([...manifest.permissions].sort(), ["alarms", "cookies", "storage"]);
  assert.ok(!Object.hasOwn(manifest, "host_permissions"));
  assert.deepEqual([...manifest.optional_host_permissions].sort(), ["http://*/*", "https://*/*"]);
  for (const retiredPermission of ["debugger", "tabs", "tabGroups"]) {
    assert.ok(!manifest.permissions.includes(retiredPermission), retiredPermission);
  }
  assert.equal(manifest.minimum_chrome_version, "120");
});

await test("extension authenticates the bridge and durably cleans temporary permissions", () => {
  assert.doesNotMatch(background, /type:\s*["']pair\.request["'][\s\S]{0,500}\bcode\s*[,}]/);
  assert.doesNotMatch(background, /type:\s*["']hello["'][\s\S]{0,500}\btoken\s*[,}]/);
  assert.match(background, /PBKDF2/);
  assert.match(background, /AES-GCM/);
  assert.match(background, /managedRequests/);
  assert.match(background, /chrome\.storage\.local/);
  assert.match(background, /HEARTBEAT/);
});

await test("extension contains no browser-tab or CDP control surface", () => {
  assert.doesNotMatch(background, /chrome\.(?:debugger|tabs|tabGroups)\b/);
  for (const legacyMessage of ["listTabs", "attach", "openTab", "cdp", "cdpEvent", "detach"]) {
    assert.ok(!background.includes(`"${legacyMessage}"`), legacyMessage);
  }
});

await test("extension copy describes import rather than browser control", () => {
  const copy = `${manifest.description}\n${popup}`;
  assert.match(copy, /import cookies/i);
  assert.doesNotMatch(copy, /agent(?:s)? control|devtools protocol|control this browser/i);
});
