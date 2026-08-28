import { readFileSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PipedreamConnectionStore } from "./PipedreamConnectionStore";

const ACCOUNT = {
  id: "apn_Account123",
  name: "Y Space Slack",
  healthy: true,
  connectedAt: "2026-08-27T12:00:00.000Z",
  app: {
    id: "app_Slack123",
    slug: "slack",
    name: "Slack",
    iconUrl: "https://assets.pipedream.net/slack.png",
  },
} as const;

describe("PipedreamConnectionStore", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function makeStore() {
    const root = await mkdtemp(join(tmpdir(), "y-space-pipedream-store-"));
    roots.push(root);
    const filePath = join(root, "pipedream-connections.json");
    return { filePath, store: new PipedreamConnectionStore({ filePath }) };
  }

  it("persists only safe account summaries and local agent-access grants", async () => {
    const { filePath, store } = await makeStore();

    store.replaceRemoteAccounts([ACCOUNT]);
    store.setAgentAccess(ACCOUNT.id, true);

    expect(new PipedreamConnectionStore({ filePath }).list()).toEqual([
      { ...ACCOUNT, agentAccess: true },
    ]);
    const serialized = readFileSync(filePath, "utf8");
    expect(serialized).not.toMatch(
      /client[_-]?secret|access[_-]?token|connect[_-]?token|external[_-]?user|credentials|authorization/i,
    );
    const protectedOnThisPlatform =
      process.platform === "win32" || (statSync(filePath).mode & 0o777) === 0o600;
    expect(protectedOnThisPlatform).toBe(true);
  });

  it("preserves grants for refreshed accounts, drops disconnected accounts, and defaults new ones off", async () => {
    const { store } = await makeStore();
    store.replaceRemoteAccounts([ACCOUNT]);
    store.setAgentAccess(ACCOUNT.id, true);

    store.replaceRemoteAccounts([
      { ...ACCOUNT, name: "Renamed Slack" },
      {
        ...ACCOUNT,
        id: "apn_Github456",
        name: "GitHub",
        app: { id: "app_Github456", slug: "github", name: "GitHub" },
      },
    ]);

    expect(store.list()).toEqual([
      expect.objectContaining({ id: ACCOUNT.id, name: "Renamed Slack", agentAccess: true }),
      expect.objectContaining({ id: "apn_Github456", agentAccess: false }),
    ]);
    store.remove("apn_Account123");
    expect(store.list().map((account) => account.id)).toEqual(["apn_Github456"]);
  });

  it("persists a stable opaque local id without exposing it in renderer account summaries", async () => {
    const { filePath, store } = await makeStore();
    store.configureScope("scope-one");
    store.replaceRemoteAccounts([ACCOUNT]);
    store.setAgentAccess(ACCOUNT.id, true);

    const first = store.listGrantedForRelay();
    const reopened = new PipedreamConnectionStore({ filePath });
    reopened.configureScope("scope-one");
    const second = reopened.listGrantedForRelay();

    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
    expect(first[0]?.localAccountId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(first[0]?.localAccountId).not.toContain("Account123");
    expect(store.list()[0]).not.toHaveProperty("localAccountId");
  });

  it("fails closed and clears grants when the configured Connect scope changes", async () => {
    const { filePath, store } = await makeStore();
    store.configureScope("project-a-user-a");
    store.replaceRemoteAccounts([ACCOUNT]);
    store.setAgentAccess(ACCOUNT.id, true);

    const reopened = new PipedreamConnectionStore({ filePath });
    reopened.configureScope("project-b-user-a");

    expect(reopened.list()).toEqual([]);
    expect(readFileSync(filePath, "utf8")).not.toContain("apn_Account123");
  });

  it("fails closed when the persisted file is corrupt or contains unknown sensitive fields", async () => {
    const { filePath } = await makeStore();
    await writeFile(filePath, JSON.stringify({ version: 1, accounts: [], accessToken: "leak" }));

    expect(new PipedreamConnectionStore({ filePath }).list()).toEqual([]);
  });
});
