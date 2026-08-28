import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { test } from "vitest";

const require = createRequire(import.meta.url);
const { findMacAppBundles, verifyMacAppBundle } = require("../build/mac-signing.cjs");

function result(status, stderr = "") {
  return { error: undefined, status, stderr, stdout: "" };
}

void test("ad-hoc fallback signs once and then requires deep strict verification", () => {
  const calls = [];
  const responses = [result(1, "code object is not signed"), result(0), result(0)];
  const runner = (command, args) => {
    calls.push([command, args]);
    return responses.shift();
  };

  const outcome = verifyMacAppBundle("/tmp/Y Space.app", {
    allowAdhocFallback: true,
    entitlementsPath: "/tmp/entitlements.plist",
    runner,
  });

  assert.deepEqual(outcome, { usedAdhocFallback: true });
  assert.deepEqual(calls, [
    ["codesign", ["--verify", "--deep", "--strict", "--verbose=4", "/tmp/Y Space.app"]],
    [
      "codesign",
      [
        "--force",
        "--deep",
        "--sign",
        "-",
        "--options",
        "runtime",
        "--entitlements",
        "/tmp/entitlements.plist",
        "/tmp/Y Space.app",
      ],
    ],
    ["codesign", ["--verify", "--deep", "--strict", "--verbose=4", "/tmp/Y Space.app"]],
  ]);
});

void test("strict verification never downgrades a failed certificate build", () => {
  const calls = [];
  assert.throws(
    () =>
      verifyMacAppBundle("/tmp/Y Space.app", {
        allowAdhocFallback: false,
        requireCertificate: true,
        runner: (command, args) => {
          calls.push([command, args]);
          return result(1, "invalid signature");
        },
      }),
    /failed deep\/strict code-signature verification/,
  );
  assert.equal(calls.length, 1);
});

void test("strict verification rejects an ad-hoc signature where a certificate is required", () => {
  const responses = [result(0), result(0, "Executable=/tmp/Y Space.app\nSignature=adhoc\n")];
  assert.throws(
    () =>
      verifyMacAppBundle("/tmp/Y Space.app", {
        requireCertificate: true,
        runner: () => responses.shift(),
      }),
    /not signed with a certificate identity/,
  );
});

void test("discovers app bundles in electron-builder mac output directories", () => {
  const root = mkdtempSync(join(tmpdir(), "y-space-signing-test-"));
  try {
    mkdirSync(join(root, "mac-arm64", "Y Space.app"), { recursive: true });
    mkdirSync(join(root, "mac", "Y Space Nightly.app"), { recursive: true });
    mkdirSync(join(root, "unrelated", "Ignored.app"), { recursive: true });

    assert.deepEqual(findMacAppBundles(root), [
      join(root, "mac-arm64", "Y Space.app"),
      join(root, "mac", "Y Space Nightly.app"),
    ]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
