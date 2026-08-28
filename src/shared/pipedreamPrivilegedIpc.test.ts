import { describe, expect, it } from "vitest";
import { isPipedreamPrivilegedBootstrapMessage } from "./pipedreamPrivilegedIpc";

describe("Pipedream privileged IPC", () => {
  it("accepts only a complete ready bootstrap on the private message channel", () => {
    expect(
      isPipedreamPrivilegedBootstrapMessage({
        kind: "pipedream-privileged-bootstrap",
        payload: {
          externalUserId: "y-space-install-private-id",
          bootstrap: {
            state: "ready",
            source: "environment",
            credentials: {
              clientId: "client-id-private",
              clientSecret: "client-secret-private",
              projectId: "proj_Test123",
              environment: "development",
            },
          },
        },
      }),
    ).toBe(true);
  });

  it("rejects smuggled credentials on absent or partial bootstrap states", () => {
    for (const bootstrap of [
      { state: "absent", clientSecret: "smuggled" },
      {
        state: "partial",
        missingKeys: ["PIPEDREAM_CLIENT_SECRET"],
        credentials: { clientSecret: "smuggled" },
      },
    ]) {
      expect(
        isPipedreamPrivilegedBootstrapMessage({
          kind: "pipedream-privileged-bootstrap",
          payload: { externalUserId: "y-space-install-private-id", bootstrap },
        }),
      ).toBe(false);
    }
  });
});
