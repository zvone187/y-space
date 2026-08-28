import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  replaceManagedAndroidAppLinks,
  replaceManagedIosAssociatedDomains,
} from "../../scripts/mobile-app-links.mjs";

const ANDROID_MANIFEST = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <application>
    <activity android:name=".MainActivity">
      <intent-filter><action android:name="android.intent.action.MAIN" /></intent-filter>
      <intent-filter android:autoVerify="true">
        <data android:scheme="https" android:host="poracode.com" android:pathPrefix="/pair" />
        <data android:scheme="https" android:host="poracode.com" android:pathPrefix="/app" />
      </intent-filter>
      <intent-filter android:autoVerify="true">
        <data android:scheme="https" android:host="docs.example.test" android:pathPrefix="/docs" />
      </intent-filter>
      <intent-filter android:autoVerify="true">
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.BROWSABLE" />
        <data android:scheme="https" android:host="external-app.example.test" android:pathPrefix="/app" />
      </intent-filter>
    </activity>
  </application>
</manifest>`;

const IOS_ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>aps-environment</key>
  <string>production</string>
  <key>com.apple.developer.associated-domains</key>
  <array>
    <string>applinks:poracode.com</string>
    <string>webcredentials:poracode.com</string>
    <string>applinks:previous.example.test</string>
    <string>webcredentials:previous.example.test</string>
    <string>applinks:docs.example.test</string>
    <string>activitycontinuation:handoff.example.test</string>
  </array>
</dict>
</plist>`;

describe("native mobile app-link configuration", () => {
  it("keeps retired upstream claims out of checked-in native trust declarations", () => {
    const androidManifest = readFileSync("android/app/src/main/AndroidManifest.xml", "utf8");
    const iosEntitlements = readFileSync("ios/App/App/App.entitlements", "utf8");

    expect(androidManifest).not.toContain("poracode.com");
    expect(iosEntitlements).not.toContain("poracode.com");
  });

  it("replaces Android managed hosts and preserves unrelated filters", () => {
    const configured = replaceManagedAndroidAppLinks(ANDROID_MANIFEST, "pair.example.test");

    expect(configured).not.toContain("poracode.com");
    expect(configured).toContain('android:host="docs.example.test"');
    expect(configured).toContain('android:host="external-app.example.test"');
    expect(configured.match(/android:host="pair\.example\.test"/g)).toHaveLength(2);
    expect(replaceManagedAndroidAppLinks(configured, "pair.example.test")).toBe(configured);
  });

  it("prunes Android managed hosts when no replacement is configured", () => {
    const configured = replaceManagedAndroidAppLinks(ANDROID_MANIFEST, null);

    expect(configured).not.toContain("poracode.com");
    expect(configured).toContain('android:host="docs.example.test"');
    expect(configured).toContain('android:host="external-app.example.test"');
    expect(configured).not.toContain('android:pathPrefix="/pair"');
  });

  it("replaces iOS legacy and prior managed host pairs", () => {
    const configured = replaceManagedIosAssociatedDomains(IOS_ENTITLEMENTS, "pair.example.test");

    expect(configured).not.toMatch(/poracode\.com|previous\.example\.test/);
    expect(configured).toContain("applinks:docs.example.test");
    expect(configured).toContain("activitycontinuation:handoff.example.test");
    expect(configured.match(/pair\.example\.test/g)).toHaveLength(2);
    expect(replaceManagedIosAssociatedDomains(configured, "pair.example.test")).toBe(configured);
  });

  it("prunes iOS managed pairs without removing unrelated associated domains", () => {
    const configured = replaceManagedIosAssociatedDomains(IOS_ENTITLEMENTS, null);

    expect(configured).not.toMatch(/poracode\.com|previous\.example\.test/);
    expect(configured).toContain("applinks:docs.example.test");
    expect(configured).toContain("activitycontinuation:handoff.example.test");
  });

  it("actively prunes prior managed claims when the configurator has no host", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "y-space-mobile-links-"));
    try {
      const androidManifestPath = join(fixtureRoot, "android/app/src/main/AndroidManifest.xml");
      const iosAppDir = join(fixtureRoot, "ios/App/App");
      mkdirSync(join(fixtureRoot, "android/app/src/main"), { recursive: true });
      mkdirSync(iosAppDir, { recursive: true });
      writeFileSync(androidManifestPath, ANDROID_MANIFEST);
      writeFileSync(
        join(iosAppDir, "Info.plist"),
        '<?xml version="1.0"?><plist version="1.0"><dict></dict></plist>',
      );
      writeFileSync(join(iosAppDir, "App.entitlements"), IOS_ENTITLEMENTS);
      const baseEnv = { ...process.env };
      delete baseEnv.PORACODE_MOBILE_APP_HOST;
      delete baseEnv.PORACODE_MOBILE_REQUIRE_NATIVE_LINKS;
      delete baseEnv.PORACODE_MOBILE_REQUIRE_ANDROID_LINKS;
      delete baseEnv.PORACODE_MOBILE_REQUIRE_IOS_LINKS;

      const result = spawnSync(process.execPath, [resolve("scripts/configure-mobile-native.mjs")], {
        cwd: fixtureRoot,
        env: baseEnv,
        encoding: "utf8",
      });

      expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
      expect(readFileSync(androidManifestPath, "utf8")).not.toContain("poracode.com");
      const entitlements = readFileSync(join(iosAppDir, "App.entitlements"), "utf8");
      expect(entitlements).not.toMatch(/poracode\.com|previous\.example\.test/);
      expect(entitlements).toContain("applinks:docs.example.test");
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("adds an iOS associated-domains block when one is absent", () => {
    const entitlements = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>aps-environment</key>
  <string>production</string>
</dict>
</plist>`;

    const configured = replaceManagedIosAssociatedDomains(entitlements, "pair.example.test");
    expect(configured).toContain("<key>com.apple.developer.associated-domains</key>");
    expect(configured.match(/pair\.example\.test/g)).toHaveLength(2);
  });
});
