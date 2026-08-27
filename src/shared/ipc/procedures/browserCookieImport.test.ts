import { describe, expect, it } from "vitest";

interface StrictSchema {
  safeParse(value: unknown): { success: boolean };
}

interface Procedure {
  channel: string;
  transport: string;
}

interface BrowserCookieImportIpcModule {
  browserCookieImportSourceSchema: StrictSchema;
  browserCookieImportStateSchema: StrictSchema;
  browserCookieImportPreviewPayloadSchema: StrictSchema;
  browserCookieImportCommitPayloadSchema: StrictSchema;
  browserCookieImportProcedures: Record<string, Procedure>;
}

async function loadIpc(): Promise<BrowserCookieImportIpcModule> {
  const modulePath = "./browserCookieImport";
  return (await import(modulePath)) as BrowserCookieImportIpcModule;
}

const source = {
  sourceId: "11111111-1111-4111-8111-111111111111",
  label: "Chrome – Work",
  browserFamily: "chrome",
  extensionVersion: "1.0.0",
  pairedAt: Date.parse("2026-08-27T12:00:00.000Z"),
  connected: true,
};

const activeRequest = {
  requestId: "33333333-3333-4333-8333-333333333333",
  sourceId: source.sourceId,
  status: "ready",
  sourceKind: "extension",
  targetUrls: ["https://example.com"],
  domains: [{ domain: "example.com", cookieCount: 2, unsupportedCount: 0 }],
  expiresAt: Date.parse("2026-08-27T12:05:00.000Z"),
};

describe("browser cookie-import IPC", () => {
  it("exposes only main-local procedures", async () => {
    const { browserCookieImportProcedures } = await loadIpc();
    expect(Object.keys(browserCookieImportProcedures)).toEqual([
      "browserCookieImportOpenExtensionFolder",
      "browserCookieImportGetState",
      "browserCookieImportChooseFile",
      "browserCookieImportBeginPairing",
      "browserCookieImportCancelPairing",
      "browserCookieImportForgetSource",
      "browserCookieImportPreview",
      "browserCookieImportCommit",
      "browserCookieImportCancel",
    ]);
    expect(
      Object.values(browserCookieImportProcedures).every(
        ({ channel, transport }) =>
          transport === "main-local" && channel.startsWith("poracode:browser-cookie-import-"),
      ),
    ).toBe(true);
  });

  it("accepts renderer-safe source and preview metadata", async () => {
    const { browserCookieImportSourceSchema, browserCookieImportStateSchema } = await loadIpc();
    expect(browserCookieImportSourceSchema.safeParse(source).success).toBe(true);
    expect(
      browserCookieImportStateSchema.safeParse({ sources: [source], activeRequest }).success,
    ).toBe(true);
  });

  it.each(["value", "cookies", "token", "tokenHash"])(
    "rejects renderer-visible %s data",
    async (secretKey) => {
      const { browserCookieImportSourceSchema, browserCookieImportStateSchema } = await loadIpc();
      expect(
        browserCookieImportSourceSchema.safeParse({ ...source, [secretKey]: "secret" }).success,
      ).toBe(false);
      expect(
        browserCookieImportStateSchema.safeParse({
          sources: [source],
          activeRequest: { ...activeRequest, [secretKey]: "secret" },
        }).success,
      ).toBe(false);
      expect(
        browserCookieImportStateSchema.safeParse({
          sources: [source],
          activeRequest: {
            ...activeRequest,
            domains: [{ ...activeRequest.domains[0], [secretKey]: "secret" }],
          },
        }).success,
      ).toBe(false);
    },
  );

  it("allows one to twelve explicit HTTP(S) targets", async () => {
    const { browserCookieImportPreviewPayloadSchema } = await loadIpc();
    expect(
      browserCookieImportPreviewPayloadSchema.safeParse({
        sourceId: source.sourceId,
        targetUrls: ["http://localhost:5173/", "https://example.com"],
      }).success,
    ).toBe(true);
    expect(
      browserCookieImportPreviewPayloadSchema.safeParse({
        sourceId: source.sourceId,
        targetUrls: Array.from({ length: 12 }, (_, index) => `https://${index}.example.com/`),
      }).success,
    ).toBe(true);
  });

  it.each([
    [],
    ["ftp://example.com/"],
    ["javascript:alert(1)"],
    ["https://user:password@example.com/"],
    ["https://example.com/private"],
    ["https://example.com/?token=secret"],
    ["https://example.com/#private"],
    Array.from({ length: 13 }, (_, index) => `https://${index}.example.com/`),
  ])("rejects missing, unsafe, credentialed, or excessive target URLs", async (targetUrls) => {
    const { browserCookieImportPreviewPayloadSchema } = await loadIpc();
    expect(
      browserCookieImportPreviewPayloadSchema.safeParse({ sourceId: source.sourceId, targetUrls })
        .success,
    ).toBe(false);
  });

  it("lets commit choose domains but never submit cookie material", async () => {
    const { browserCookieImportCommitPayloadSchema } = await loadIpc();
    const commit = {
      requestId: activeRequest.requestId,
      selectedDomains: ["example.com"],
    };
    expect(browserCookieImportCommitPayloadSchema.safeParse(commit).success).toBe(true);
    expect(
      browserCookieImportCommitPayloadSchema.safeParse({
        ...commit,
        cookies: [{ name: "session", value: "secret" }],
      }).success,
    ).toBe(false);
    expect(
      browserCookieImportCommitPayloadSchema.safeParse({ ...commit, value: "secret" }).success,
    ).toBe(false);
  });
});
