import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PipedreamMainService, type PipedreamMainServiceOptions } from "./PipedreamMainService";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeService(overrides?: {
  persistEnvFilePath?: (filePath: string) => void;
  clearEnvFilePath?: () => void;
  configureBootstrap?: PipedreamMainServiceOptions["configureBootstrap"];
}) {
  return new PipedreamMainService({
    createConnectLink: async () => ({
      connectLinkUrl: "https://pipedream.com/connect?app=slack",
      expiresAt: "2026-08-27T12:10:00.000Z",
    }),
    openConnectUrl: async () => undefined,
    persistEnvFilePath: overrides?.persistEnvFilePath ?? (() => undefined),
    clearEnvFilePath: overrides?.clearEnvFilePath ?? (() => undefined),
    fallbackBootstrap: () => ({ state: "absent" }),
    configureBootstrap:
      overrides?.configureBootstrap ??
      (async () =>
        ({
          personalMcp: { enabled: false, authenticated: false, serverName: "pd" },
          connect: {
            state: "ready",
            credentialSource: "environment",
            environment: "development",
            projectIdHint: "proj_…0123",
            projectName: "Pipedream Connect",
            accounts: [],
          },
        }) as never),
  });
}

describe("PipedreamMainService", () => {
  it("opens the one-use link only in the embedded browser and returns a renderer-safe acknowledgement", async () => {
    const privateLink =
      "https://pipedream.com/_static/connect.html?token=connect-token-private&connectLink=true&app=slack";
    const openConnectUrl = vi.fn<(url: string) => Promise<void>>(async () => undefined);
    const service = new PipedreamMainService({
      createConnectLink: vi.fn<
        (appSlug: string) => Promise<{ connectLinkUrl: string; expiresAt: string }>
      >(async () => ({
        connectLinkUrl: privateLink,
        expiresAt: "2026-08-27T12:10:00.000Z",
      })),
      openConnectUrl,
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap: async () => ({}) as never,
    });

    const result = await service.beginConnect({ appSlug: "slack" });

    expect(openConnectUrl).toHaveBeenCalledExactlyOnceWith(privateLink);
    expect(result).toEqual({ opened: true, expiresAt: "2026-08-27T12:10:00.000Z" });
    expect(JSON.stringify(result)).not.toMatch(/connect-token-private|connectLinkUrl|token=/i);
  });

  it("rejects any non-Pipedream or non-app-scoped link before opening it", async () => {
    const openConnectUrl = vi.fn<(url: string) => Promise<void>>(async () => undefined);
    const service = new PipedreamMainService({
      createConnectLink: async () => ({
        connectLinkUrl: "https://attacker.invalid/connect?token=private",
        expiresAt: "2026-08-27T12:10:00.000Z",
      }),
      openConnectUrl,
      persistEnvFilePath: () => undefined,
      clearEnvFilePath: () => undefined,
      fallbackBootstrap: () => ({ state: "absent" }),
      configureBootstrap: async () => ({}) as never,
    });

    await expect(service.beginConnect({ appSlug: "slack" })).rejects.toThrow(/invalid/i);
    expect(openConnectUrl).not.toHaveBeenCalled();
  });

  it("imports a selected env file, persists only its path, and returns a redacted snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "y-space-pipedream-main-"));
    tempRoots.push(root);
    const filePath = join(root, ".env.pipedream");
    writeFileSync(
      filePath,
      [
        "PIPEDREAM_CLIENT_ID=runtime-client-id",
        "PIPEDREAM_CLIENT_SECRET=runtime-client-secret",
        "PIPEDREAM_PROJECT_ID=proj_Runtime123",
        "PIPEDREAM_ENVIRONMENT=development",
      ].join("\n"),
    );
    const persistEnvFilePath = vi.fn<(filePath: string) => void>();
    const configureBootstrap = vi.fn<PipedreamMainServiceOptions["configureBootstrap"]>(
      async () => ({
        personalMcp: { enabled: false, authenticated: false, serverName: "pd" as const },
        connect: {
          state: "ready" as const,
          credentialSource: "environment" as const,
          environment: "development" as const,
          projectIdHint: "proj_…0123",
          projectName: "Pipedream Connect",
          accounts: [],
        },
      }),
    );
    const service = makeService({ persistEnvFilePath, configureBootstrap });

    const result = await service.importEnvironmentFile(filePath);

    expect(result).toMatchObject({
      status: "configured",
      snapshot: { connect: { state: "ready" } },
    });
    expect(persistEnvFilePath).toHaveBeenCalledExactlyOnceWith(filePath);
    expect(configureBootstrap).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ state: "ready", source: "environment" }),
    );
    expect(JSON.stringify(result)).not.toMatch(
      /runtime-client-secret|runtime-client-id|Runtime123/,
    );
  });

  it("returns a safe validation result without replacing config for an unrelated file", async () => {
    const root = mkdtempSync(join(tmpdir(), "y-space-pipedream-main-"));
    tempRoots.push(root);
    const filePath = join(root, ".env.pipedream");
    writeFileSync(filePath, "UNRELATED=value\n");
    const persistEnvFilePath = vi.fn<(filePath: string) => void>();
    const configureBootstrap = vi.fn<PipedreamMainServiceOptions["configureBootstrap"]>();
    const service = makeService({ persistEnvFilePath, configureBootstrap });

    await expect(service.importEnvironmentFile(filePath)).resolves.toEqual({
      status: "invalid",
      reason: "no-supported-values",
    });
    expect(persistEnvFilePath).not.toHaveBeenCalled();
    expect(configureBootstrap).not.toHaveBeenCalled();
  });

  it("does not persist a selected path when live configuration fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "y-space-pipedream-main-"));
    tempRoots.push(root);
    const filePath = join(root, ".env.pipedream");
    writeFileSync(
      filePath,
      [
        "PIPEDREAM_CLIENT_ID=client-id",
        "PIPEDREAM_CLIENT_SECRET=client-secret",
        "PIPEDREAM_PROJECT_ID=proj_Failure123",
        "PIPEDREAM_ENVIRONMENT=development",
      ].join("\n"),
    );
    const persistEnvFilePath = vi.fn<(filePath: string) => void>();
    const configureBootstrap = vi.fn<PipedreamMainServiceOptions["configureBootstrap"]>(
      async () => {
        throw new Error("configuration unavailable");
      },
    );
    const service = makeService({ persistEnvFilePath, configureBootstrap });

    await expect(service.importEnvironmentFile(filePath)).rejects.toThrow(
      "configuration unavailable",
    );
    expect(persistEnvFilePath).not.toHaveBeenCalled();
  });

  it("forgets path metadata and restores the launch-time fallback", async () => {
    const clearEnvFilePath = vi.fn<() => void>();
    const configureBootstrap = vi.fn<PipedreamMainServiceOptions["configureBootstrap"]>(
      async () => ({
        personalMcp: { enabled: false, authenticated: false, serverName: "pd" as const },
        connect: { state: "absent" as const },
      }),
    );
    const service = makeService({ clearEnvFilePath, configureBootstrap });

    await expect(service.clearEnvironmentFile()).resolves.toMatchObject({
      connect: { state: "absent" },
    });
    expect(clearEnvFilePath).toHaveBeenCalledOnce();
    expect(configureBootstrap).toHaveBeenCalledExactlyOnceWith({ state: "absent" });
  });
});
