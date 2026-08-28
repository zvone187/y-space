import assert from "node:assert/strict";
import { test } from "vitest";

import {
  resolveMacSigningIdentity,
  resolveMacSigningPolicy,
  shouldNotarizeMacBuild,
} from "./mac-signing-policy.mjs";

void test("uses an ad-hoc identity for an explicitly unsigned local build", () => {
  assert.equal(resolveMacSigningIdentity({ CSC_IDENTITY_AUTO_DISCOVERY: "false" }), "-");
  assert.equal(shouldNotarizeMacBuild({ CSC_IDENTITY_AUTO_DISCOVERY: "false" }, "never"), false);
});

void test("preserves configured certificate signing", () => {
  assert.equal(
    resolveMacSigningIdentity({
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
      CSC_LINK: "/secure/developer-id.p12",
    }),
    undefined,
  );
  assert.equal(
    shouldNotarizeMacBuild(
      {
        CSC_IDENTITY_AUTO_DISCOVERY: "false",
        CSC_LINK: "/secure/developer-id.p12",
      },
      "never",
    ),
    true,
  );
  assert.equal(
    resolveMacSigningIdentity({
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
      CSC_NAME: "Developer ID Application: Example (TEAM123)",
    }),
    undefined,
  );
});

void test("leaves normal keychain auto-discovery unchanged", () => {
  assert.equal(resolveMacSigningIdentity({}), undefined);
  assert.equal(resolveMacSigningIdentity({ CSC_IDENTITY_AUTO_DISCOVERY: "true" }), undefined);
});

void test("allows ad-hoc fallback only for unpublished builds without explicit credentials", () => {
  assert.deepEqual(resolveMacSigningPolicy({}, "never"), {
    allowAdhocFallback: true,
    forceCodeSigning: false,
    identity: undefined,
    notarize: false,
    requireCertificate: false,
  });

  assert.deepEqual(resolveMacSigningPolicy({}, "always"), {
    allowAdhocFallback: false,
    forceCodeSigning: true,
    identity: undefined,
    notarize: true,
    requireCertificate: true,
  });
  assert.deepEqual(resolveMacSigningPolicy({ CSC_IDENTITY_AUTO_DISCOVERY: "false" }, "always"), {
    allowAdhocFallback: false,
    forceCodeSigning: true,
    identity: undefined,
    notarize: true,
    requireCertificate: true,
  });
});

void test("configured certificate and keychain identities are always strict", () => {
  for (const env of [
    { CSC_LINK: "/secure/developer-id.p12" },
    { CSC_NAME: "Developer ID Application: Example (TEAM123)" },
    { CSC_KEYCHAIN: "/secure/release.keychain-db" },
  ]) {
    assert.deepEqual(resolveMacSigningPolicy(env, "never"), {
      allowAdhocFallback: false,
      forceCodeSigning: true,
      identity: undefined,
      notarize: true,
      requireCertificate: true,
    });
  }
});

void test("an explicit release-signing intent is strict even when electron-builder publishing is disabled", () => {
  assert.deepEqual(resolveMacSigningPolicy({ YSPACE_MAC_REQUIRE_CERTIFICATE: "1" }, "never"), {
    allowAdhocFallback: false,
    forceCodeSigning: true,
    identity: undefined,
    notarize: true,
    requireCertificate: true,
  });
});

void test("blank certificate-intent variables do not disable local ad-hoc fallback", () => {
  assert.deepEqual(
    resolveMacSigningPolicy(
      {
        CSC_KEYCHAIN: "  ",
        YSPACE_MAC_REQUIRE_CERTIFICATE: "",
      },
      "never",
    ),
    {
      allowAdhocFallback: true,
      forceCodeSigning: false,
      identity: undefined,
      notarize: false,
      requireCertificate: false,
    },
  );
});
