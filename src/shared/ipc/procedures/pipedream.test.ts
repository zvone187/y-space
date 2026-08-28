import { describe, expect, it } from "vitest";
import { pipedreamProcedures } from "./pipedream";

describe("Pipedream IPC procedures", () => {
  it("exposes only renderer-safe operations and keeps Connect-link creation main-local", () => {
    expect(Object.keys(pipedreamProcedures).sort()).toEqual([
      "pipedreamBeginConnect",
      "pipedreamChooseEnvFile",
      "pipedreamClearEnvFile",
      "pipedreamDisconnectAccount",
      "pipedreamGetSnapshot",
      "pipedreamListApps",
      "pipedreamRefreshAccounts",
      "pipedreamSetAccountAgentAccess",
    ]);
    expect(pipedreamProcedures.pipedreamBeginConnect.transport).toBe("main-local");
    expect(pipedreamProcedures.pipedreamChooseEnvFile.transport).toBe("main-local");
    expect(pipedreamProcedures.pipedreamClearEnvFile.transport).toBe("main-local");
    expect(pipedreamProcedures.pipedreamGetSnapshot.transport).toBe("supervisor");
    expect(pipedreamProcedures.pipedreamDisconnectAccount.transport).toBe("supervisor");
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
});
