import { describe, expect, it } from "vitest";
import { PipedreamCredentialStoreUnavailableError } from "./pipedreamCredentialStore";
import { describePipedreamCredentialStartupFailure } from "./pipedreamCredentialStartupFailure";

describe("Pipedream credential startup failure notice", () => {
  it("offers only Quit for an unreadable record and promises no automatic mutation", () => {
    const notice = describePipedreamCredentialStartupFailure(
      new PipedreamCredentialStoreUnavailableError(false),
    );

    expect(notice).toEqual({
      type: "error",
      buttons: ["Quit"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: "Pipedream credentials are unavailable",
      message: "Y Space could not safely open its saved Pipedream credentials.",
      detail:
        "No agents were started, and Y Space did not change or delete any saved credential data. Restore access to the operating-system credential store or a known-good Y Space data backup, then reopen the app. If an original plaintext Pipedream setup file still exists, secure or remove it manually and contact support before changing the encrypted record.",
    });
    expect(notice?.detail).toContain("did not change or delete");
    expect(notice?.buttons).not.toContain("Reset");
  });

  it("never copies an error message, credential, or path into the native notice", () => {
    const error = new PipedreamCredentialStoreUnavailableError(false);
    error.message =
      "Could not decrypt /Users/alice/private/.env.pipedream containing pd_secret_do-not-display";

    const serializedNotice = JSON.stringify(describePipedreamCredentialStartupFailure(error));

    expect(serializedNotice).not.toContain("/Users/alice");
    expect(serializedNotice).not.toContain(".env.pipedream");
    expect(serializedNotice).not.toContain("pd_secret_do-not-display");
  });

  it("does not duplicate the existing confirmed-source recovery prompt", () => {
    expect(
      describePipedreamCredentialStartupFailure(new PipedreamCredentialStoreUnavailableError(true)),
    ).toBeUndefined();
  });

  it("ignores unrelated startup failures", () => {
    expect(describePipedreamCredentialStartupFailure(new Error("unrelated"))).toBeUndefined();
  });
});
