import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

export interface PipedreamCredentialProtectionInput {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly persistentKey: boolean;
  readonly usesMockKeychain: boolean;
  readonly executablePath: string;
}

/**
 * Destructive setup-file import is stricter than ordinary local preference
 * encryption: after the plaintext file is removed, the OS-wrapped key becomes
 * the sole recovery path. Electron documents app isolation only for macOS
 * Keychain, and a stable signature is required for consistent identity across
 * updates. Windows DPAPI is same-user, Linux providers vary, and Chromium's
 * mock keychain is deliberately non-production.
 */
export function canDestructivelyImportPipedreamCredentials(
  input: PipedreamCredentialProtectionInput,
  inspectMacSignature: (executablePath: string) => boolean = hasStableMacCodeSignature,
): boolean {
  return (
    input.platform === "darwin" &&
    input.isPackaged &&
    input.persistentKey &&
    !input.usesMockKeychain &&
    inspectMacSignature(input.executablePath)
  );
}

export interface MacCodeSignResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type MacCodeSignRunner = (args: readonly string[]) => MacCodeSignResult;

// Apple documents these certificate extensions for Developer ID Application
// leaf certificates and the Developer ID intermediate. Requiring both under
// the Apple trust anchor prevents a locally issued certificate with a
// convincing common name and TeamIdentifier from authorizing destructive
// credential import.
export const APPLE_DEVELOPER_ID_APPLICATION_REQUIREMENT =
  "anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists";

export function hasStableMacCodeSignature(
  executablePath: string,
  runCodesign: MacCodeSignRunner = runMacCodesign,
): boolean {
  const appBundle = resolveContainingMacAppBundle(executablePath);
  if (!appBundle) return false;
  try {
    const verification = runCodesign([
      "--verify",
      "--deep",
      "--strict",
      "--verbose=2",
      `-R=${APPLE_DEVELOPER_ID_APPLICATION_REQUIREMENT}`,
      appBundle,
    ]);
    if (verification.status !== 0) return false;
    const display = runCodesign(["--display", "--verbose=4", executablePath]);
    if (display.status !== 0) return false;
    const details = `${display.stdout}\n${display.stderr}`;
    return isStableMacCodeSignatureDetails(details);
  } catch {
    return false;
  }
}

export function resolveContainingMacAppBundle(executablePath: string): string | undefined {
  const absolute = resolve(executablePath);
  const marker = ".app/Contents/MacOS/";
  const markerIndex = absolute.lastIndexOf(marker);
  if (markerIndex < 0) return undefined;
  return absolute.slice(0, markerIndex + ".app".length);
}

function runMacCodesign(args: readonly string[]): MacCodeSignResult {
  const result = spawnSync("/usr/bin/codesign", [...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    timeout: 5_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function isStableMacCodeSignatureDetails(details: string): boolean {
  return (
    !/^Signature=adhoc$/m.test(details) &&
    /^Authority=Developer ID Application:.+$/m.test(details) &&
    /^TeamIdentifier=(?!not set$)[A-Z0-9]+$/m.test(details)
  );
}
