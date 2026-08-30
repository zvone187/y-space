import { describe, expect, it } from "vitest";
import {
  isPipedreamPrivilegedBootstrapMessage,
  isPipedreamPrivilegedConnectLinkRequest,
} from "./pipedreamPrivilegedIpc";

describe("Pipedream privileged IPC", () => {
  it("accepts only a complete ready bootstrap on the private message channel", () => {
    expect(
      isPipedreamPrivilegedBootstrapMessage({
        kind: "pipedream-privileged-bootstrap",
        id: "bootstrap-1",
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

    expect(
      isPipedreamPrivilegedBootstrapMessage({
        kind: "pipedream-privileged-bootstrap",
        id: "bootstrap-secure",
        payload: {
          externalUserId: "y-space-install-private-id",
          bootstrap: {
            state: "ready",
            source: "secure-storage",
            credentials: {
              clientId: "client-id-private",
              clientSecret: "client-secret-private",
              projectId: "proj_Test123",
              environment: "production",
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
          id: "bootstrap-invalid",
          payload: { externalUserId: "y-space-install-private-id", bootstrap },
        }),
      ).toBe(false);
    }
  });

  it("rejects an oversized project id on the private bootstrap channel", () => {
    expect(
      isPipedreamPrivilegedBootstrapMessage({
        kind: "pipedream-privileged-bootstrap",
        id: "bootstrap-oversized-project",
        payload: {
          externalUserId: "y-space-install-private-id",
          bootstrap: {
            state: "ready",
            source: "secure-storage",
            credentials: {
              clientId: "client-id-private",
              clientSecret: "client-secret-private",
              projectId: `proj_${"a".repeat(129)}`,
              environment: "development",
            },
          },
        },
      }),
    ).toBe(false);
  });

  it("requires a bounded reply id for privileged bootstrap acknowledgements", () => {
    const payload = {
      externalUserId: "y-space-install-private-id",
      bootstrap: { state: "absent" },
    };
    expect(
      isPipedreamPrivilegedBootstrapMessage({
        kind: "pipedream-privileged-bootstrap",
        id: "bootstrap-ack",
        payload,
      }),
    ).toBe(true);
    expect(
      isPipedreamPrivilegedBootstrapMessage({
        kind: "pipedream-privileged-bootstrap",
        payload,
      }),
    ).toBe(false);
  });

  it("accepts exact loopback redirect capabilities only on the private request channel", () => {
    const request = {
      kind: "pipedream-privileged-request",
      id: "request-1",
      request: {
        type: "create-connect-link",
        appSlug: "gmail",
        successRedirectUrl: `http://127.0.0.1:43127/success/${"a".repeat(64)}`,
        errorRedirectUrl: `http://127.0.0.1:43127/error/${"b".repeat(64)}`,
      },
    };

    expect(isPipedreamPrivilegedConnectLinkRequest(request)).toBe(true);
    for (const unsafe of [
      { ...request.request, successRedirectUrl: "https://attacker.invalid/success" },
      { ...request.request, errorRedirectUrl: `http://localhost:43127/error/${"b".repeat(64)}` },
      { ...request.request, successRedirectUrl: `http://127.0.0.1:43127/success/short` },
      { ...request.request, extra: "smuggled" },
    ]) {
      expect(isPipedreamPrivilegedConnectLinkRequest({ ...request, request: unsafe })).toBe(false);
    }
  });
});
