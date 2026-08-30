import { describe, expect, it, vi } from "vitest";
import {
  SUPERVISOR_BOOTSTRAP_FAILURE_CODE,
  SUPERVISOR_SECRET_BOOTSTRAP_PROTOCOL_VERSION,
} from "@/shared/supervisorSecretBootstrap";
import type { SupervisorSecurityBootstrap } from "@/shared/supervisorSecretBootstrap";
import { createSupervisorSecretBootstrapGate } from "./secretBootstrapGate";

const VALID_KEY = Buffer.alloc(32, 11).toString("base64");

function validMessage(id = "request-id") {
  return {
    kind: "supervisor-secret-bootstrap" as const,
    version: SUPERVISOR_SECRET_BOOTSTRAP_PROTOCOL_VERSION,
    id,
    secretStorageKey: VALID_KEY,
    allowPipedreamOauthPersistence: false,
  };
}

describe("createSupervisorSecretBootstrapGate", () => {
  it("initializes exactly once and exposes the context only after accepting the key", () => {
    const initialize = vi.fn<(bootstrap: SupervisorSecurityBootstrap) => { runtime: string }>(
      () => ({
        runtime: "ready",
      }),
    );
    const gate = createSupervisorSecretBootstrapGate(initialize);

    expect(gate.current()).toBeUndefined();
    expect(gate.handle(validMessage())).toEqual({
      handled: true,
      reply: {
        kind: "supervisor-secret-bootstrap-reply",
        replyTo: "request-id",
        ok: true,
        data: { version: SUPERVISOR_SECRET_BOOTSTRAP_PROTOCOL_VERSION, ready: true },
      },
    });
    expect(initialize).toHaveBeenCalledExactlyOnceWith({
      secretStorageKey: VALID_KEY,
      allowPipedreamOauthPersistence: false,
    });
    expect(gate.current()).toEqual({ runtime: "ready" });

    expect(gate.handle(validMessage("duplicate"))).toEqual({
      handled: true,
      reply: expect.objectContaining({
        replyTo: "duplicate",
        ok: false,
        error: "Supervisor security bootstrap was already attempted.",
      }),
    });
    expect(initialize).toHaveBeenCalledOnce();
  });

  it("rejects malformed bootstrap input without consuming the one valid attempt", () => {
    const initialize = vi.fn<(bootstrap: SupervisorSecurityBootstrap) => { runtime: string }>(
      () => ({
        runtime: "ready",
      }),
    );
    const gate = createSupervisorSecretBootstrapGate(initialize);

    expect(gate.handle({ ...validMessage(), secretStorageKey: "not-a-key" })).toEqual({
      handled: true,
      reply: expect.objectContaining({
        ok: false,
        error: "Supervisor security bootstrap is invalid.",
      }),
    });
    expect(initialize).not.toHaveBeenCalled();
    expect(gate.handle(validMessage())).toMatchObject({
      handled: true,
      reply: { ok: true },
    });
  });

  it("fails closed after initializer failure and never exposes the thrown details", () => {
    const initialize = vi.fn<(bootstrap: SupervisorSecurityBootstrap) => { runtime: string }>(
      () => {
        throw new Error("sensitive initializer detail");
      },
    );
    const gate = createSupervisorSecretBootstrapGate(initialize);

    const first = gate.handle(validMessage());
    expect(first).toEqual({
      handled: true,
      reply: expect.objectContaining({
        ok: false,
        error: "Supervisor security bootstrap failed.",
      }),
    });
    expect(JSON.stringify(first)).not.toContain("sensitive initializer detail");
    expect(gate.current()).toBeUndefined();
    expect(gate.handle(validMessage("retry"))).toMatchObject({
      handled: true,
      reply: {
        ok: false,
        error: "Supervisor security bootstrap was already attempted.",
      },
    });
    expect(initialize).toHaveBeenCalledOnce();
  });

  it("reports only an allowlisted typed cause for recoverable OAuth store failure", () => {
    const marker = new Error("malformed contents include a private token");
    const gate = createSupervisorSecretBootstrapGate(
      () => {
        throw marker;
      },
      {
        classifyInitializationError: (error) =>
          error === marker
            ? SUPERVISOR_BOOTSTRAP_FAILURE_CODE.MCP_OAUTH_STORE_UNAVAILABLE
            : SUPERVISOR_BOOTSTRAP_FAILURE_CODE.INITIALIZATION_FAILED,
      },
    );

    const result = gate.handle(validMessage());

    expect(result).toEqual({
      handled: true,
      reply: {
        kind: "supervisor-secret-bootstrap-reply",
        replyTo: "request-id",
        ok: false,
        error: "Supervisor security bootstrap failed.",
        failureCode: SUPERVISOR_BOOTSTRAP_FAILURE_CODE.MCP_OAUTH_STORE_UNAVAILABLE,
      },
    });
    expect(JSON.stringify(result)).not.toContain("private token");
  });

  it("ignores non-bootstrap messages and does not reflect an oversized request id", () => {
    const gate = createSupervisorSecretBootstrapGate(() => ({ runtime: "ready" }));
    expect(gate.handle({ type: "ordinary-request" })).toEqual({ handled: false });
    expect(gate.handle({ kind: "supervisor-secret-bootstrap", id: "x".repeat(129) })).toEqual({
      handled: true,
    });
  });
});
