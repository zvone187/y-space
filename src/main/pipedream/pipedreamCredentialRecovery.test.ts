import { describe, expect, it, vi } from "vitest";
import type { PipedreamBootstrap } from "@/shared/pipedreamBootstrap";
import {
  PipedreamCredentialStoreUnavailableError,
  type PipedreamCredentialStore,
} from "./pipedreamCredentialStore";
import { applyPipedreamCredentialsWithRecovery } from "./pipedreamCredentialRecovery";

const ABSENT: PipedreamBootstrap = { state: "absent" };

function failingStore(error: Error, clear = vi.fn<() => void>()): PipedreamCredentialStore {
  return {
    importEnvironmentFile: vi.fn<PipedreamCredentialStore["importEnvironmentFile"]>(),
    applyPersisted: () => {
      throw error;
    },
    clear,
    resetAfterConfirmedSourceRemoval: clear,
  };
}

describe("Pipedream credential startup recovery", () => {
  it("continues normally without asking for recovery when the store opens", async () => {
    const store: PipedreamCredentialStore = {
      importEnvironmentFile: vi.fn<PipedreamCredentialStore["importEnvironmentFile"]>(),
      applyPersisted: () => ABSENT,
      clear: vi.fn<() => void>(),
      resetAfterConfirmedSourceRemoval: vi.fn<() => void>(),
    };
    const confirmReset = vi.fn<() => Promise<boolean>>();

    await expect(
      applyPipedreamCredentialsWithRecovery({
        store,
        startupBootstrap: ABSENT,
        confirmReset,
      }),
    ).resolves.toBe(ABSENT);
    expect(confirmReset).not.toHaveBeenCalled();
  });

  it("keeps startup fail-closed when the user declines recovery", async () => {
    const clear = vi.fn<() => void>();
    const error = new PipedreamCredentialStoreUnavailableError(true);
    const store = failingStore(error, clear);

    await expect(
      applyPipedreamCredentialsWithRecovery({
        store,
        startupBootstrap: ABSENT,
        confirmReset: async () => false,
      }),
    ).rejects.toBe(error);
    expect(clear).not.toHaveBeenCalled();
  });

  it("clears only after explicit recovery confirmation and then uses the launch fallback", async () => {
    const clear = vi.fn<() => void>();
    const store = failingStore(new PipedreamCredentialStoreUnavailableError(true), clear);

    await expect(
      applyPipedreamCredentialsWithRecovery({
        store,
        startupBootstrap: ABSENT,
        confirmReset: async () => true,
      }),
    ).resolves.toBe(ABSENT);
    expect(clear).toHaveBeenCalledOnce();
  });

  it("does not swallow unrelated failures or a failed reset", async () => {
    const confirmReset = vi.fn<() => Promise<boolean>>(async () => true);
    await expect(
      applyPipedreamCredentialsWithRecovery({
        store: failingStore(new Error("unexpected storage failure")),
        startupBootstrap: ABSENT,
        confirmReset,
      }),
    ).rejects.toThrow("unexpected storage failure");
    expect(confirmReset).not.toHaveBeenCalled();

    const resetFailure = failingStore(new PipedreamCredentialStoreUnavailableError(true));
    resetFailure.resetAfterConfirmedSourceRemoval = () => {
      throw new Error("reset failed");
    };
    await expect(
      applyPipedreamCredentialsWithRecovery({
        store: resetFailure,
        startupBootstrap: ABSENT,
        confirmReset: async () => true,
      }),
    ).rejects.toThrow("reset failed");
  });

  it("never offers Reset for an unreadable record with no authenticated source locator", async () => {
    const reset = vi.fn<() => void>();
    const confirmReset = vi.fn<() => Promise<boolean>>(async () => true);
    const error = new PipedreamCredentialStoreUnavailableError(false);

    await expect(
      applyPipedreamCredentialsWithRecovery({
        store: failingStore(error, reset),
        startupBootstrap: ABSENT,
        confirmReset,
      }),
    ).rejects.toBe(error);
    expect(confirmReset).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
  });
});
