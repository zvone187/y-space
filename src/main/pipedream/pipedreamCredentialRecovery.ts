import type { PipedreamBootstrap } from "@/shared/pipedreamBootstrap";
import {
  PipedreamCredentialStoreUnavailableError,
  type PipedreamCredentialStore,
} from "./pipedreamCredentialStore";

export interface PipedreamCredentialRecoveryOptions {
  readonly store: PipedreamCredentialStore;
  readonly startupBootstrap: PipedreamBootstrap;
  readonly confirmReset: () => Promise<boolean>;
}

/**
 * Keeps agents stopped while an unreadable record might represent an
 * unfinished plaintext-source cleanup. Only an explicit native confirmation
 * may forget that record and continue without Pipedream.
 */
export async function applyPipedreamCredentialsWithRecovery(
  options: PipedreamCredentialRecoveryOptions,
): Promise<PipedreamBootstrap> {
  try {
    return options.store.applyPersisted(options.startupBootstrap);
  } catch (error) {
    if (!(error instanceof PipedreamCredentialStoreUnavailableError)) throw error;
    if (!error.canResetAfterConfirmedSourceRemoval) throw error;
    if (!(await options.confirmReset())) throw error;
    options.store.resetAfterConfirmedSourceRemoval();
    return options.startupBootstrap;
  }
}
