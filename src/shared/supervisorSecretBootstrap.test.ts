import { describe, expect, it } from "vitest";
import {
  isSupervisorSecretBootstrapFailure,
  isSupervisorSecretBootstrapAck,
  isSupervisorSecretBootstrapMessage,
  safeSupervisorSecretBootstrapReplyId,
  SUPERVISOR_BOOTSTRAP_FAILURE_CODE,
  SUPERVISOR_SECRET_BOOTSTRAP_PROTOCOL_VERSION,
} from "./supervisorSecretBootstrap";

const VALID_KEY = Buffer.alloc(32, 7).toString("base64");

describe("supervisor secret bootstrap protocol", () => {
  it("accepts only the versioned exact-shape message with a canonical 32-byte key", () => {
    const message = {
      kind: "supervisor-secret-bootstrap",
      version: SUPERVISOR_SECRET_BOOTSTRAP_PROTOCOL_VERSION,
      id: "request-id",
      secretStorageKey: VALID_KEY,
      allowPipedreamOauthPersistence: false,
    };

    expect(isSupervisorSecretBootstrapMessage(message)).toBe(true);
    expect(isSupervisorSecretBootstrapMessage({ ...message, extra: true })).toBe(false);
    expect(isSupervisorSecretBootstrapMessage({ ...message, version: 1 })).toBe(false);
    expect(isSupervisorSecretBootstrapMessage({ ...message, secretStorageKey: "key" })).toBe(false);
    expect(
      isSupervisorSecretBootstrapMessage({
        ...message,
        secretStorageKey: `${VALID_KEY.slice(0, -1)}A`,
      }),
    ).toBe(false);
    expect(
      isSupervisorSecretBootstrapMessage({
        ...message,
        allowPipedreamOauthPersistence: "yes",
      }),
    ).toBe(false);
  });

  it("validates the acknowledgement payload exactly", () => {
    const acknowledgement = {
      version: SUPERVISOR_SECRET_BOOTSTRAP_PROTOCOL_VERSION,
      ready: true,
    };
    expect(isSupervisorSecretBootstrapAck(acknowledgement)).toBe(true);
    expect(isSupervisorSecretBootstrapAck({ ...acknowledgement, extra: true })).toBe(false);
    expect(isSupervisorSecretBootstrapAck({ ...acknowledgement, ready: false })).toBe(false);
  });

  it("accepts only fixed, versioned bootstrap failure codes", () => {
    const failure = {
      kind: "supervisor-secret-bootstrap-reply",
      replyTo: "request-id",
      ok: false,
      error: "Supervisor security bootstrap failed.",
      failureCode: SUPERVISOR_BOOTSTRAP_FAILURE_CODE.MCP_OAUTH_STORE_UNAVAILABLE,
    };

    expect(isSupervisorSecretBootstrapFailure(failure)).toBe(true);
    expect(isSupervisorSecretBootstrapFailure({ ...failure, extra: true })).toBe(false);
    expect(isSupervisorSecretBootstrapFailure({ ...failure, failureCode: "raw-error" })).toBe(
      false,
    );
    expect(isSupervisorSecretBootstrapFailure({ ...failure, replyTo: "x".repeat(129) })).toBe(
      false,
    );
  });

  it("returns a bounded correlation id for fixed-error replies only", () => {
    expect(
      safeSupervisorSecretBootstrapReplyId({
        kind: "supervisor-secret-bootstrap",
        id: "request-id",
      }),
    ).toBe("request-id");
    expect(
      safeSupervisorSecretBootstrapReplyId({
        kind: "supervisor-secret-bootstrap",
        id: "x".repeat(129),
      }),
    ).toBeUndefined();
  });
});
