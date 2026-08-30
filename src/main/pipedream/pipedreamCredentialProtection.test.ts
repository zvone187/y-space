import { describe, expect, it, vi } from "vitest";
import {
  APPLE_DEVELOPER_ID_APPLICATION_REQUIREMENT,
  canDestructivelyImportPipedreamCredentials,
  hasStableMacCodeSignature,
  isStableMacCodeSignatureDetails,
  resolveContainingMacAppBundle,
  type MacCodeSignRunner,
} from "./pipedreamCredentialProtection";

const eligible = {
  platform: "darwin" as const,
  isPackaged: true,
  persistentKey: true,
  usesMockKeychain: false,
  executablePath: "/Applications/Y Space.app/Contents/MacOS/Y Space",
};

describe("canDestructivelyImportPipedreamCredentials", () => {
  it("allows a packaged macOS build only when its stable signature is verified", () => {
    const inspect = vi.fn<(executablePath: string) => boolean>(() => true);
    expect(canDestructivelyImportPipedreamCredentials(eligible, inspect)).toBe(true);
    expect(inspect).toHaveBeenCalledExactlyOnceWith(eligible.executablePath);
    expect(canDestructivelyImportPipedreamCredentials(eligible, () => false)).toBe(false);
  });

  it.each([
    { ...eligible, platform: "win32" as const },
    { ...eligible, platform: "linux" as const },
    { ...eligible, isPackaged: false },
    { ...eligible, persistentKey: false },
    { ...eligible, usesMockKeychain: true },
  ])("refuses same-user, session-only, development, and mock-keychain stores", (input) => {
    const inspect = vi.fn<(executablePath: string) => boolean>(() => true);
    expect(canDestructivelyImportPipedreamCredentials(input, inspect)).toBe(false);
    expect(inspect).not.toHaveBeenCalled();
  });
});

describe("isStableMacCodeSignatureDetails", () => {
  it("requires a Developer ID Application authority and explicit team identity", () => {
    expect(
      isStableMacCodeSignatureDetails(
        "Signature size=9056\nAuthority=Developer ID Application: Y Space Inc\nTeamIdentifier=ABC123",
      ),
    ).toBe(true);
    expect(isStableMacCodeSignatureDetails("Signature=adhoc\nTeamIdentifier=not set")).toBe(false);
    expect(isStableMacCodeSignatureDetails("TeamIdentifier=ABC123")).toBe(false);
    expect(
      isStableMacCodeSignatureDetails(
        "Authority=Apple Development: Local Developer\nTeamIdentifier=ABC123",
      ),
    ).toBe(false);
    expect(isStableMacCodeSignatureDetails("Authority=Developer ID Application: Y Space Inc")).toBe(
      false,
    );
    expect(
      isStableMacCodeSignatureDetails(
        "Authority=Developer ID Application: Y Space Inc\nTeamIdentifier=not set",
      ),
    ).toBe(false);
  });
});

describe("hasStableMacCodeSignature", () => {
  const executable = "/Applications/Y Space.app/Contents/MacOS/Y Space";
  const verified = { status: 0, stdout: "", stderr: "valid on disk" };
  const displayed = {
    status: 0,
    stdout: "",
    stderr:
      "Signature size=9056\nAuthority=Developer ID Application: Y Space Inc\nTeamIdentifier=ABC123",
  };

  it("requires an Apple-anchored Developer ID chain before inspecting its identity", () => {
    const run = vi
      .fn<MacCodeSignRunner>()
      .mockReturnValueOnce(verified)
      .mockReturnValueOnce(displayed);

    expect(hasStableMacCodeSignature(executable, run)).toBe(true);
    expect(run.mock.calls).toEqual([
      [
        [
          "--verify",
          "--deep",
          "--strict",
          "--verbose=2",
          `-R=${APPLE_DEVELOPER_ID_APPLICATION_REQUIREMENT}`,
          "/Applications/Y Space.app",
        ],
      ],
      [["--display", "--verbose=4", executable]],
    ]);
  });

  it("rejects convincing fake Developer ID metadata when the Apple requirement fails", () => {
    const run = vi
      .fn<MacCodeSignRunner>()
      .mockReturnValueOnce({
        status: 1,
        stdout: "",
        stderr: "code failed to satisfy specified code requirement(s)",
      })
      .mockReturnValueOnce(displayed);

    expect(hasStableMacCodeSignature(executable, run)).toBe(false);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toContain(`-R=${APPLE_DEVELOPER_ID_APPLICATION_REQUIREMENT}`);
  });

  it("denies import when full-bundle verification fails without trusting display metadata", () => {
    const run = vi.fn<MacCodeSignRunner>().mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "a sealed resource is missing or invalid",
    });

    expect(hasStableMacCodeSignature(executable, run)).toBe(false);
    expect(run).toHaveBeenCalledOnce();
  });

  it("rejects executables that are not inside a macOS app bundle", () => {
    const run = vi.fn<MacCodeSignRunner>();
    expect(hasStableMacCodeSignature("/tmp/Y Space", run)).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(resolveContainingMacAppBundle(executable)).toBe("/Applications/Y Space.app");
  });
});
