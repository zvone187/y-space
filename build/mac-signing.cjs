const { spawnSync } = require("node:child_process");
const { readdirSync } = require("node:fs");
const { join, resolve } = require("node:path");

const ADHOC_FALLBACK_ENV = "YSPACE_MAC_ALLOW_ADHOC_FALLBACK";

function commandOutput(result) {
  return [result?.stdout, result?.stderr]
    .filter(Boolean)
    .map((value) => String(value).trim())
    .filter(Boolean)
    .join("\n");
}

function runCodesign(args, runner) {
  const result = runner("codesign", args, { encoding: "utf8" });
  if (result?.error) {
    return { detail: result.error.message, ok: false, output: "" };
  }
  const output = commandOutput(result);
  return {
    detail: output || `codesign exited with status ${result?.status ?? "unknown"}`,
    ok: result?.status === 0,
    output,
  };
}

function verificationArgs(appPath) {
  return ["--verify", "--deep", "--strict", "--verbose=4", appPath];
}

function verifyMacAppBundle(
  appPath,
  {
    allowAdhocFallback = false,
    entitlementsPath,
    requireCertificate = false,
    runner = spawnSync,
  } = {},
) {
  let verification = runCodesign(verificationArgs(appPath), runner);
  let usedAdhocFallback = false;

  if (!verification.ok) {
    if (!allowAdhocFallback) {
      throw new Error(
        `[mac-signing] ${appPath} failed deep/strict code-signature verification: ${verification.detail}`,
      );
    }

    const signingArgs = ["--force", "--deep", "--sign", "-", "--options", "runtime"];
    if (entitlementsPath) {
      signingArgs.push("--entitlements", entitlementsPath);
    }
    signingArgs.push(appPath);

    const signing = runCodesign(signingArgs, runner);
    if (!signing.ok) {
      throw new Error(`[mac-signing] failed to ad-hoc sign ${appPath}: ${signing.detail}`);
    }
    usedAdhocFallback = true;

    verification = runCodesign(verificationArgs(appPath), runner);
    if (!verification.ok) {
      throw new Error(
        `[mac-signing] ${appPath} failed deep/strict verification after ad-hoc signing: ${verification.detail}`,
      );
    }
  }

  if (requireCertificate) {
    const identity = runCodesign(["--display", "--verbose=4", appPath], runner);
    const isAdhoc = /(?:^|\n)Signature=adhoc(?:\n|$)/u.test(identity.output);
    const hasAuthority = /(?:^|\n)Authority=.+(?:\n|$)/u.test(identity.output);
    if (!identity.ok || isAdhoc || !hasAuthority) {
      throw new Error(
        `[mac-signing] ${appPath} is not signed with a certificate identity; refusing to downgrade a publishing or configured-certificate build.`,
      );
    }
  }

  return { usedAdhocFallback };
}

function findMacAppBundles(root) {
  const apps = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const entryPath = join(root, entry.name);
    if (entry.name.endsWith(".app")) {
      apps.push(entryPath);
      continue;
    }
    if (!/^mac(?:-|$)/u.test(entry.name)) continue;
    for (const child of readdirSync(entryPath, { withFileTypes: true })) {
      if (child.isDirectory() && child.name.endsWith(".app")) {
        apps.push(join(entryPath, child.name));
      }
    }
  }
  return apps.sort();
}

function prepareMacAppBundleForPackaging(context, env = process.env) {
  if (context.electronPlatformName !== "darwin" || env[ADHOC_FALLBACK_ENV] !== "1") {
    return;
  }

  const apps = findMacAppBundles(context.appOutDir);
  if (apps.length !== 1) {
    throw new Error(
      `[mac-signing] expected one macOS app bundle in ${context.appOutDir}, found ${apps.length}`,
    );
  }

  const projectDir =
    context.packager?.info?.projectDir ??
    context.packager?.projectDir ??
    resolve(context.appOutDir, "..", "..");
  const result = verifyMacAppBundle(apps[0], {
    allowAdhocFallback: true,
    entitlementsPath: join(projectDir, "build", "entitlements.mac.local.plist"),
  });
  if (result.usedAdhocFallback) {
    console.log(`[mac-signing] applied local ad-hoc signature to ${apps[0]}`);
  } else {
    console.log(`[mac-signing] preserved existing valid signature on ${apps[0]}`);
  }
}

module.exports = {
  ADHOC_FALLBACK_ENV,
  findMacAppBundles,
  prepareMacAppBundleForPackaging,
  verifyMacAppBundle,
};
