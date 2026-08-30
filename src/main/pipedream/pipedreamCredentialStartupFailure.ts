import { PipedreamCredentialStoreUnavailableError } from "./pipedreamCredentialStore";

export interface PipedreamCredentialStartupFailureNotice {
  readonly type: "error";
  readonly buttons: readonly ["Quit"];
  readonly defaultId: 0;
  readonly cancelId: 0;
  readonly noLink: true;
  readonly title: string;
  readonly message: string;
  readonly detail: string;
}

/**
 * Returns a deliberately static notice for an unauthenticated credential
 * record. Never include the originating error or a filesystem path here: the
 * native dialog may be visible while the user is screen sharing.
 */
export function describePipedreamCredentialStartupFailure(
  error: unknown,
): PipedreamCredentialStartupFailureNotice | undefined {
  if (
    !(error instanceof PipedreamCredentialStoreUnavailableError) ||
    error.canResetAfterConfirmedSourceRemoval
  ) {
    return undefined;
  }

  return {
    type: "error",
    buttons: ["Quit"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: "Pipedream credentials are unavailable",
    message: "Y Space could not safely open its saved Pipedream credentials.",
    detail:
      "No agents were started, and Y Space did not change or delete any saved credential data. Restore access to the operating-system credential store or a known-good Y Space data backup, then reopen the app. If an original plaintext Pipedream setup file still exists, secure or remove it manually and contact support before changing the encrypted record.",
  };
}
