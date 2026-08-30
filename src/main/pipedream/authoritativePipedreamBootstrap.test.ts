import { describe, expect, it } from "vitest";
import type { PipedreamBootstrap } from "@/shared/pipedreamBootstrap";
import { AuthoritativePipedreamBootstrap } from "./authoritativePipedreamBootstrap";

const READY: PipedreamBootstrap = {
  state: "ready",
  source: "secure-storage",
  credentials: {
    clientId: "client-id",
    clientSecret: "client-secret",
    projectId: "proj_Authoritative123",
    environment: "production",
  },
};

describe("AuthoritativePipedreamBootstrap", () => {
  it("commits imported credentials before a live supervisor acknowledgement", async () => {
    const state = new AuthoritativePipedreamBootstrap();
    let rejectConfigure!: (error: Error) => void;
    const lostAcknowledgement = new Promise<never>((_resolve, reject) => {
      rejectConfigure = reject;
    });

    const configuration = state.configure(READY, () => lostAcknowledgement);
    expect(state.current()).toEqual(READY);

    rejectConfigure(new Error("supervisor reply lost"));
    await expect(configuration).rejects.toThrow("supervisor reply lost");
    // A restart resolver still reads the durable imported state.
    expect(state.current()).toEqual(READY);
  });

  it("commits a clear before a failed live reconfiguration", async () => {
    const state = new AuthoritativePipedreamBootstrap(READY);
    const configuration = state.configure({ state: "absent" }, () =>
      Promise.reject(new Error("supervisor exited after applying clear")),
    );

    expect(state.current()).toEqual({ state: "absent" });
    await expect(configuration).rejects.toThrow("supervisor exited after applying clear");
    // A crash-restarted supervisor cannot receive the old ready credentials.
    expect(state.current()).toEqual({ state: "absent" });
  });
});
