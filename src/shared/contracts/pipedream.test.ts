import { describe, expect, it } from "vitest";
import {
  pipedreamBeginConnectPayloadSchema,
  pipedreamDisconnectAccountPayloadSchema,
  pipedreamListAppsPayloadSchema,
  pipedreamSetAccountAgentAccessPayloadSchema,
  pipedreamSnapshotSchema,
} from "./pipedream";

const SAFE_SNAPSHOT = {
  personalMcp: {
    enabled: true,
    authenticated: true,
    serverName: "pd",
  },
  connect: {
    state: "ready",
    credentialSource: "environment",
    environment: "development",
    projectIdHint: "proj_…123",
    projectName: "Y Space QA",
    accounts: [
      {
        id: "apn_Account123",
        name: "Y Space Slack",
        healthy: true,
        connectedAt: "2026-08-27T12:00:00.000Z",
        agentAccess: true,
        app: {
          id: "app_Slack123",
          slug: "slack",
          name: "Slack",
          iconUrl: "https://assets.pipedream.net/slack.png",
        },
      },
    ],
  },
} as const;

describe("Pipedream public contracts", () => {
  it("accepts only the renderer-safe snapshot shape", () => {
    const parsed = pipedreamSnapshotSchema.parse(SAFE_SNAPSHOT);

    expect(parsed).toEqual(SAFE_SNAPSHOT);
    expect(JSON.stringify(parsed)).not.toMatch(
      /"(?:clientSecret|accessToken|connectToken|externalUserId|credentials)":/i,
    );
  });

  it.each([
    ["client secret", { clientSecret: "must-not-cross-ipc" }],
    ["developer access token", { accessToken: "must-not-cross-ipc" }],
    ["connect token", { connectToken: "must-not-cross-ipc" }],
    ["external user id", { externalUserId: "install-private-id" }],
    ["raw upstream error", { rawError: { response: "provider-private-data" } }],
  ])("rejects a snapshot containing %s", (_label, forbiddenField) => {
    expect(
      pipedreamSnapshotSchema.safeParse({
        ...SAFE_SNAPSHOT,
        connect: { ...SAFE_SNAPSHOT.connect, ...forbiddenField },
      }).success,
    ).toBe(false);
  });

  it("keeps caller-controlled identities, URLs, scopes, and headers out of IPC payloads", () => {
    expect(
      pipedreamListAppsPayloadSchema.safeParse({
        query: "slack",
        cursor: "cursor-1",
        limit: 20,
      }).success,
    ).toBe(true);
    expect(pipedreamBeginConnectPayloadSchema.safeParse({ appSlug: "slack" }).success).toBe(true);
    expect(
      pipedreamDisconnectAccountPayloadSchema.safeParse({ accountId: "apn_Account123" }).success,
    ).toBe(true);
    expect(
      pipedreamSetAccountAgentAccessPayloadSchema.safeParse({
        accountId: "apn_Account123",
        enabled: false,
      }).success,
    ).toBe(true);

    for (const forbidden of [
      { externalUserId: "someone-else" },
      { url: "https://attacker.invalid" },
      { scope: "*" },
      { headers: { authorization: "Bearer attacker" } },
      { environment: "production" },
      { includeCredentials: true },
    ]) {
      expect(
        pipedreamBeginConnectPayloadSchema.safeParse({ appSlug: "slack", ...forbidden }).success,
      ).toBe(false);
    }
  });

  it("rejects route-shaped identifiers instead of accepting arbitrary upstream paths", () => {
    expect(
      pipedreamBeginConnectPayloadSchema.safeParse({ appSlug: "https://attacker.invalid/mcp" })
        .success,
    ).toBe(false);
    expect(
      pipedreamDisconnectAccountPayloadSchema.safeParse({ accountId: "../../tokens" }).success,
    ).toBe(false);
  });
});
