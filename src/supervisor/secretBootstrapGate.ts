import {
  isSupervisorSecretBootstrapCandidate,
  isSupervisorSecretBootstrapMessage,
  safeSupervisorSecretBootstrapReplyId,
  supervisorBootstrapFailureMessage,
  SUPERVISOR_BOOTSTRAP_FAILURE_CODE,
  SUPERVISOR_SECRET_BOOTSTRAP_PROTOCOL_VERSION,
  type SupervisorBootstrapFailureCode,
  type SupervisorSecretBootstrapReply,
  type SupervisorSecurityBootstrap,
} from "@/shared/supervisorSecretBootstrap";

export type SupervisorSecretBootstrapDecision =
  | { readonly handled: false }
  | { readonly handled: true; readonly reply?: SupervisorSecretBootstrapReply };

export interface SupervisorSecretBootstrapGate<Context> {
  current(): Context | undefined;
  handle(message: unknown): SupervisorSecretBootstrapDecision;
}

export interface SupervisorSecretBootstrapGateOptions {
  readonly classifyInitializationError?: (error: unknown) => SupervisorBootstrapFailureCode;
}

/**
 * One-shot startup boundary for the supervisor. The secret is synchronously
 * consumed by `initialize` and is never retained by the gate or placed in the
 * process environment. Invalid and duplicate bootstrap attempts fail closed
 * with fixed replies that cannot echo secret-bearing input.
 */
export function createSupervisorSecretBootstrapGate<Context>(
  initialize: (bootstrap: SupervisorSecurityBootstrap) => Context,
  options: SupervisorSecretBootstrapGateOptions = {},
): SupervisorSecretBootstrapGate<Context> {
  let context: Context | undefined;
  let attempted = false;

  return Object.freeze({
    current: () => context,
    handle: (message: unknown): SupervisorSecretBootstrapDecision => {
      if (!isSupervisorSecretBootstrapCandidate(message)) return { handled: false };

      const replyTo = safeSupervisorSecretBootstrapReplyId(message);
      if (!replyTo) return { handled: true };
      if (attempted) {
        return {
          handled: true,
          reply: fixedFailure(replyTo, SUPERVISOR_BOOTSTRAP_FAILURE_CODE.ALREADY_ATTEMPTED),
        };
      }
      if (!isSupervisorSecretBootstrapMessage(message)) {
        return {
          handled: true,
          reply: fixedFailure(replyTo, SUPERVISOR_BOOTSTRAP_FAILURE_CODE.INVALID),
        };
      }

      attempted = true;
      try {
        context = initialize(
          Object.freeze({
            secretStorageKey: message.secretStorageKey,
            allowPipedreamOauthPersistence: message.allowPipedreamOauthPersistence,
          }),
        );
        return {
          handled: true,
          reply: {
            kind: "supervisor-secret-bootstrap-reply",
            replyTo,
            ok: true,
            data: {
              version: SUPERVISOR_SECRET_BOOTSTRAP_PROTOCOL_VERSION,
              ready: true,
            },
          },
        };
      } catch (error) {
        return {
          handled: true,
          reply: fixedFailure(
            replyTo,
            options.classifyInitializationError?.(error) ??
              SUPERVISOR_BOOTSTRAP_FAILURE_CODE.INITIALIZATION_FAILED,
          ),
        };
      }
    },
  });
}

function fixedFailure(
  replyTo: string,
  failureCode: SupervisorBootstrapFailureCode,
): SupervisorSecretBootstrapReply {
  return {
    kind: "supervisor-secret-bootstrap-reply",
    replyTo,
    ok: false,
    error: supervisorBootstrapFailureMessage(failureCode),
    failureCode,
  };
}
