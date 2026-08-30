import { describe, expect, it } from "vitest";
import {
  pipedreamBeginConnectPayloadSchema,
  pipedreamBeginConnectResultSchema,
  pipedreamConnectFlowPayloadSchema,
  pipedreamConnectFlowStatusSchema,
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

  it.each(["applied", "restart-required", "failed-pending"] as const)(
    "accepts the strict renderer-safe %s agent reload outcome",
    (state) => {
      const snapshot = { ...SAFE_SNAPSHOT, agentReload: { state } };

      expect(pipedreamSnapshotSchema.parse(snapshot)).toEqual(snapshot);
      expect(
        pipedreamSnapshotSchema.safeParse({
          ...snapshot,
          agentReload: { state, error: "private provider restart detail" },
        }).success,
      ).toBe(false);
    },
  );

  it("rejects unknown agent reload states", () => {
    expect(
      pipedreamSnapshotSchema.safeParse({
        ...SAFE_SNAPSHOT,
        agentReload: { state: "silently-ignored" },
      }).success,
    ).toBe(false);
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

  it("exposes only an opaque flow id and coarse terminal state for Connect lifecycle IPC", () => {
    const flowId = "4d73cb38-1566-4e07-bf92-ce6edf1c82e8";

    expect(
      pipedreamBeginConnectResultSchema.parse({
        opened: true,
        expiresAt: "2026-08-27T12:10:00.000Z",
        flowId,
      }),
    ).toEqual({
      opened: true,
      expiresAt: "2026-08-27T12:10:00.000Z",
      flowId,
    });
    expect(pipedreamConnectFlowPayloadSchema.parse({ flowId })).toEqual({ flowId });
    expect(pipedreamConnectFlowStatusSchema.parse({ state: "open" })).toEqual({ state: "open" });
    expect(pipedreamConnectFlowStatusSchema.parse({ state: "closed" })).toEqual({
      state: "closed",
    });
    expect(pipedreamConnectFlowStatusSchema.parse({ state: "succeeded" })).toEqual({
      state: "succeeded",
    });
    expect(pipedreamConnectFlowStatusSchema.parse({ state: "failed" })).toEqual({
      state: "failed",
    });
    expect(pipedreamConnectFlowStatusSchema.parse({ state: "expired" })).toEqual({
      state: "expired",
    });

    for (const forbidden of [
      { flowId, tabId: "sensitive-tab-private" },
      { flowId, url: "https://pipedream.com/connect?token=private" },
      { flowId, state: "open" },
    ]) {
      expect(pipedreamConnectFlowPayloadSchema.safeParse(forbidden).success).toBe(false);
    }
    expect(
      pipedreamConnectFlowStatusSchema.safeParse({
        state: "open",
        tabId: "sensitive-tab-private",
      }).success,
    ).toBe(false);
    expect(
      pipedreamConnectFlowStatusSchema.safeParse({
        state: "succeeded",
        accountId: "apn_UncorrelatedRendererGuess",
      }).success,
    ).toBe(false);
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

  it("accepts safe Pipedream app slugs while preserving opaque identifier bytes", () => {
    expect(pipedreamBeginConnectPayloadSchema.parse({ appSlug: "_0codekit" })).toEqual({
      appSlug: "_0codekit",
    });
    expect(pipedreamBeginConnectPayloadSchema.parse({ appSlug: "µ-torrent" })).toEqual({
      appSlug: "µ-torrent",
    });
    expect(pipedreamBeginConnectPayloadSchema.parse({ appSlug: "e\u0301quipe" })).toEqual({
      appSlug: "e\u0301quipe",
    });
  });

  it.each([
    "bad slug",
    " badslug",
    "badslug ",
    "bad/slug",
    "bad\\slug",
    "bad?slug",
    "bad#slug",
    "bad%slug",
    "\u0000bad",
  ])("rejects unsafe Pipedream app slug %j", (appSlug) => {
    expect(pipedreamBeginConnectPayloadSchema.safeParse({ appSlug }).success).toBe(false);
  });
});
