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
  const autoDiscoveryDisabled = env.CSC_IDENTITY_AUTO_DISCOVERY?.trim().toLowerCase() === "false";
  return autoDiscoveryDisabled && !hasExplicitSigningCredentials(env) ? "-" : undefined;
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
