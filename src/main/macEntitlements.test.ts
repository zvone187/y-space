import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guards the macOS signing entitlements that ship in the notarized build. The
// hardened runtime denies microphone capture (no TCC prompt, silent audio)
// unless the audio-input entitlement is present, and codesign silently drops
// entitlements if the plist contains XML comments.
const entitlementsPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../build/entitlements.mac.plist",
);
const plist = readFileSync(entitlementsPath, "utf8");
const localPlist = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../build/entitlements.mac.local.plist"),
  "utf8",
);

describe("mac hardened-runtime entitlements", () => {
  it("grants the microphone (audio-input) entitlement so voice input can record", () => {
    expect(plist).toContain("com.apple.security.device.audio-input");
  });

  it("does not ship the debugger entitlement", () => {
    expect(plist).not.toContain("com.apple.security.cs.debugger");
  });

  it("does not allow DYLD injection or unsigned library loading", () => {
    expect(plist).not.toContain("com.apple.security.cs.allow-dyld-environment-variables");
    expect(plist).not.toContain("com.apple.security.cs.disable-library-validation");
  });

  it("contains no XML comments (codesign silently drops entitlements when present)", () => {
    expect(plist).not.toContain("<!--");
  });

  it("isolates unsigned local compatibility from the notarized release entitlements", () => {
    expect(localPlist).toContain("com.apple.security.cs.disable-library-validation");
    expect(localPlist).not.toContain("com.apple.security.cs.allow-dyld-environment-variables");
    expect(localPlist).not.toContain("com.apple.security.cs.debugger");
    expect(localPlist).not.toContain("<!--");
  });
});
