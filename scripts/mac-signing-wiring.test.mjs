import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import YAML from "yaml";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

void test("release workflow requires certificate signing independently of artifact upload", () => {
  const workflow = YAML.parse(
    readFileSync(resolve(repoRoot, ".github", "workflows", "_build.yml"), "utf8"),
  );
  const steps = workflow.jobs.build.steps;
  const packageMac = steps.find((step) => step.name === "Package macOS");
  const verifyMac = steps.find((step) => step.name === "Verify macOS app bundle");

  assert.equal(packageMac.env.YSPACE_MAC_REQUIRE_CERTIFICATE, "1");
  assert.match(packageMac.run, /build-desktop-artifact\.mjs --platform mac --skip-build/u);
  assert.doesNotMatch(packageMac.run, /--publish\s+(?:always|onTag|onTagOrDraft)/u);

  assert.match(verifyMac.run, /Signature=adhoc/u);
  assert.match(verifyMac.run, /Authority=/u);
});

void test("desktop packaging wires signing policy into config, hook, and child environment", () => {
  const source = readFileSync(resolve(repoRoot, "scripts", "build-desktop-artifact.mjs"), "utf8");

  assert.match(source, /resolveMacSigningPolicy\(process\.env, publish\)/u);
  assert.match(
    source,
    /\[ADHOC_FALLBACK_ENV\]: macSigningPolicy\.allowAdhocFallback \? "1" : "0"/u,
  );
  assert.match(source, /afterPack: build\/after-pack\.cjs/u);
  assert.match(source, /forceCodeSigning: \$\{macSigningPolicy\.forceCodeSigning\}/u);
  assert.match(source, /notarize: \$\{macSigningPolicy\.notarize\}/u);
  assert.match(
    source,
    /verifyMacAppBundle\(appBundle, \{[\s\S]*requireCertificate: macSigningPolicy\.requireCertificate/u,
  );
});
