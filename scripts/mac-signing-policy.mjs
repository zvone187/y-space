export const MAC_REQUIRE_CERTIFICATE_ENV = "YSPACE_MAC_REQUIRE_CERTIFICATE";

function hasValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasExplicitSigningCredentials(env) {
  return hasValue(env.CSC_LINK) || hasValue(env.CSC_NAME) || hasValue(env.CSC_KEYCHAIN);
}

function isPublishingBuild(publish) {
  return typeof publish !== "string" || publish.trim().toLowerCase() !== "never";
}

export function resolveMacSigningIdentity(env) {
  // Pin every fallback build to electron-builder's ad-hoc identity so its
  // post-fuse signing pass always runs. Relying on keychain auto-discovery here
  // lets electron-builder skip signing when no certificate is installed,
  // leaving the earlier signature invalid after it mutates Electron's fuses.
  return hasExplicitSigningCredentials(env) ? undefined : "-";
}

export function resolveMacSigningPolicy(env, publish) {
  const hasExplicitCredentials = hasExplicitSigningCredentials(env);
  const requiresCertificateByIntent = hasValue(env[MAC_REQUIRE_CERTIFICATE_ENV]);
  const publishing = isPublishingBuild(publish);
  const requireCertificate = hasExplicitCredentials || requiresCertificateByIntent || publishing;

  return {
    allowAdhocFallback: !requireCertificate,
    forceCodeSigning: requireCertificate,
    identity: requireCertificate ? undefined : resolveMacSigningIdentity(env),
    notarize: requireCertificate,
    requireCertificate,
  };
}

export function shouldNotarizeMacBuild(env, publish) {
  return resolveMacSigningPolicy(env, publish).notarize;
}
