import { describe, expect, it } from "vitest";
import {
  pipedreamPersonalMcpOauthBeginResultSchema,
  pipedreamPersonalMcpOauthFlowPayloadSchema,
} from "../../contracts";
import { RENDERER_IPC_PROCEDURE_NAMES } from "../procedureMap";
import { pipedreamProcedures } from "./pipedream";

describe("Pipedream IPC procedures", () => {
  it("exposes only renderer-safe operations and keeps Connect-link creation main-local", () => {
    expect(Object.keys(pipedreamProcedures).sort()).toEqual([
      "pipedreamBeginConnect",
      "pipedreamBeginPersonalMcpOauth",
      "pipedreamCancelConnect",
      "pipedreamCancelPersonalMcpOauth",
      "pipedreamChooseEnvFile",
      "pipedreamClearEnvFile",
      "pipedreamClearPersonalMcpOauth",
      "pipedreamDisconnectAccount",
      "pipedreamFinishConnect",
      "pipedreamGetConnectFlowStatus",
      "pipedreamGetPersonalMcpOauthFlowStatus",
      "pipedreamGetSnapshot",
      "pipedreamInternalBeginPersonalMcpOauth",
      "pipedreamInternalCancelPersonalMcpOauth",
      "pipedreamInternalClearPersonalMcpOauth",
      "pipedreamInternalWaitPersonalMcpOauth",
      "pipedreamListApps",
      "pipedreamRefreshAccounts",
      "pipedreamSetAccountAgentAccess",
    ]);
    expect(pipedreamProcedures.pipedreamBeginConnect.transport).toBe("main-local");
    expect(pipedreamProcedures.pipedreamGetConnectFlowStatus.transport).toBe("main-local");
    expect(pipedreamProcedures.pipedreamFinishConnect.transport).toBe("main-local");
    expect(pipedreamProcedures.pipedreamCancelConnect.transport).toBe("main-local");
    expect(pipedreamProcedures.pipedreamChooseEnvFile.transport).toBe("main-local");
    expect(pipedreamProcedures.pipedreamClearEnvFile.transport).toBe("main-local");
    expect(pipedreamProcedures.pipedreamBeginPersonalMcpOauth.transport).toBe("main-local");
    expect(pipedreamProcedures.pipedreamGetPersonalMcpOauthFlowStatus.transport).toBe("main-local");
    expect(pipedreamProcedures.pipedreamCancelPersonalMcpOauth.transport).toBe("main-local");
    expect(pipedreamProcedures.pipedreamClearPersonalMcpOauth.transport).toBe("main-local");
    expect(pipedreamProcedures.pipedreamGetSnapshot.transport).toBe("supervisor");
    expect(pipedreamProcedures.pipedreamDisconnectAccount.transport).toBe("supervisor");
  });

  it("keeps the Personal Pipedream OAuth URL and supervisor flow off the renderer bridge", () => {
    const flowId = "4d73cb38-1566-4e07-bf92-ce6edf1c82e8";
    expect(pipedreamPersonalMcpOauthBeginResultSchema.parse({ state: "open", flowId })).toEqual({
      state: "open",
      flowId,
    });
    expect(
      pipedreamPersonalMcpOauthBeginResultSchema.safeParse({
        state: "open",
        flowId,
        authorizationUrl:
          "https://pipedream.com/oauth?state=renderer-secret-sentinel&code_challenge=private",
      }).success,
    ).toBe(false);
    expect(
      pipedreamPersonalMcpOauthFlowPayloadSchema.safeParse({
        flowId,
        supervisorFlowId: "supervisor-private",
        tabId: "sensitive-private",
      }).success,
    ).toBe(false);

    for (const internal of [
      "pipedreamInternalBeginPersonalMcpOauth",
      "pipedreamInternalWaitPersonalMcpOauth",
      "pipedreamInternalCancelPersonalMcpOauth",
      "pipedreamInternalClearPersonalMcpOauth",
    ]) {
      expect(RENDERER_IPC_PROCEDURE_NAMES).not.toContain(internal);
    }
  });

  it("keeps environment-file paths main-owned", () => {
    const parsed = pipedreamProcedures.pipedreamChooseEnvFile.payloadSchema.safeParse({
      dialogTitle: "Choose Pipedream environment file",
      filePath: "/private/path/that-must-not-cross-renderer-ipc/.env.pipedream",
    });
    expect(parsed.success).toBe(false);
  });

  it("strictly rejects caller-supplied URLs, identities, scopes, and headers", () => {
    const parsed = pipedreamProcedures.pipedreamBeginConnect.payloadSchema.safeParse({
      appSlug: "slack",
      url: "https://attacker.invalid",
      externalUserId: "attacker",
      headers: { authorization: "Bearer attacker" },
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts only an opaque flow id for status, finish, and cancellation", () => {
    const flowId = "4d73cb38-1566-4e07-bf92-ce6edf1c82e8";
    for (const procedure of [
      pipedreamProcedures.pipedreamGetConnectFlowStatus,
      pipedreamProcedures.pipedreamFinishConnect,
      pipedreamProcedures.pipedreamCancelConnect,
    ]) {
      expect(procedure.payloadSchema.safeParse({ flowId }).success).toBe(true);
      expect(
        procedure.payloadSchema.safeParse({ flowId, tabId: "sensitive-tab-private" }).success,
      ).toBe(false);
    }
  });
});
