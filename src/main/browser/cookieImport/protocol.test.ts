import { describe, expect, it } from "vitest";

interface ParseResult {
  success: boolean;
}

interface StrictSchema {
  safeParse(value: unknown): ParseResult;
}

interface ProtocolModule {
  COOKIE_IMPORT_PROTOCOL_VERSION: number;
  COOKIE_IMPORT_MAX_COOKIES: number;
  COOKIE_IMPORT_MAX_PAYLOAD_BYTES: number;
  cookieImportClientMessageSchema: StrictSchema;
  cookieImportServerMessageSchema: StrictSchema;
  cookieImportCommitResultPayloadSchema: StrictSchema;
  assertCookieImportPayloadSize(payload: string | Buffer): void;
}

async function loadProtocol(): Promise<ProtocolModule> {
  const modulePath = "./protocol";
  return (await import(modulePath)) as ProtocolModule;
}

const sourceId = "11111111-1111-4111-8111-111111111111";
const requestId = "33333333-3333-4333-8333-333333333333";

const validCookie = {
  name: "session",
  value: "raw-secret",
  domain: ".example.com",
  hostOnly: false,
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "lax",
  session: true,
};

describe("cookie-import wire protocol", () => {
  it("uses proof-authenticated pairing and hello messages with no plaintext code or token", async () => {
    const protocol = await loadProtocol();

    expect(protocol.COOKIE_IMPORT_PROTOCOL_VERSION).toBe(1);
    const hello = {
      protocolVersion: 1,
      type: "hello",
      sourceId,
      clientNonce: "A".repeat(43),
      clientPublicKey: "B".repeat(87),
      proof: "C".repeat(43),
      extensionVersion: "1.0.0",
      browserFamily: "chrome",
      label: "Work profile",
    };
    expect(protocol.cookieImportClientMessageSchema.safeParse(hello).success).toBe(true);
    expect(
      protocol.cookieImportClientMessageSchema.safeParse({ ...hello, token: "pairing-token" })
        .success,
    ).toBe(false);
    expect(
      protocol.cookieImportClientMessageSchema.safeParse({
        ...hello,
        type: "pair.request",
        pairingId: "22222222-2222-4222-8222-222222222222",
        code: "12345678",
      }).success,
    ).toBe(false);
  });

  it("accepts preview metadata but rejects cookie values in preview messages", async () => {
    const { cookieImportClientMessageSchema } = await loadProtocol();
    const preview = {
      protocolVersion: 1,
      type: "preview.result",
      requestId,
      domains: [{ domain: "example.com", cookieCount: 2, unsupportedCount: 1 }],
    };

    expect(cookieImportClientMessageSchema.safeParse(preview).success).toBe(true);
    expect(
      cookieImportClientMessageSchema.safeParse({
        ...preview,
        domains: [{ ...preview.domains[0], value: "must-not-cross-preview" }],
      }).success,
    ).toBe(false);
    expect(
      cookieImportClientMessageSchema.safeParse({
        ...preview,
        cookies: [validCookie],
      }).success,
    ).toBe(false);
  });

  it("allows raw cookie values only inside an encrypted commit envelope", async () => {
    const { cookieImportClientMessageSchema, cookieImportServerMessageSchema } =
      await loadProtocol();

    const encryptedCommit = {
      protocolVersion: 1,
      type: "commit.result",
      requestId,
      iv: "A".repeat(16),
      ciphertext: "B".repeat(64),
    };
    expect(cookieImportClientMessageSchema.safeParse(encryptedCommit).success).toBe(true);
    expect(
      cookieImportClientMessageSchema.safeParse({ ...encryptedCommit, cookies: [validCookie] })
        .success,
    ).toBe(false);
    expect(
      cookieImportServerMessageSchema.safeParse({
        protocolVersion: 1,
        type: "commit.request",
        requestId,
        targetUrls: ["https://example.com"],
        selectedDomains: ["example.com"],
        expiresAt: Date.now() + 60_000,
        cookies: [validCookie],
      }).success,
    ).toBe(false);
  });

  it.each(["listTabs", "attach", "openTab", "cdp", "cdpEvent", "detach"])(
    "rejects the retired %s tab/CDP request",
    async (type) => {
      const { cookieImportClientMessageSchema, cookieImportServerMessageSchema } =
        await loadProtocol();
      const legacyMessage = {
        protocolVersion: 1,
        type,
        id: 7,
        tabId: 9,
        method: "Runtime.evaluate",
      };

      expect(cookieImportClientMessageSchema.safeParse(legacyMessage).success).toBe(false);
      expect(cookieImportServerMessageSchema.safeParse(legacyMessage).success).toBe(false);
    },
  );

  it("enforces cookie-count and serialized-payload caps", async () => {
    const protocol = await loadProtocol();
    expect(protocol.COOKIE_IMPORT_MAX_COOKIES).toBe(750);
    expect(protocol.COOKIE_IMPORT_MAX_PAYLOAD_BYTES).toBe(4 * 1024 * 1024);

    const cookies = Array.from({ length: protocol.COOKIE_IMPORT_MAX_COOKIES + 1 }, (_, index) => ({
      ...validCookie,
      name: `cookie-${index}`,
    }));
    expect(
      protocol.cookieImportCommitResultPayloadSchema.safeParse({
        requestId,
        cookies,
      }).success,
    ).toBe(false);

    expect(() =>
      protocol.assertCookieImportPayloadSize(
        "x".repeat(protocol.COOKIE_IMPORT_MAX_PAYLOAD_BYTES + 1),
      ),
    ).toThrow(/payload|size|large/i);
  });

  it.each([
    "https://example.com/private",
    "https://example.com/?token=secret",
    "https://example.com/#private",
  ])("rejects non-origin target %s", async (targetUrl) => {
    const protocol = await loadProtocol();
    expect(
      protocol.cookieImportServerMessageSchema.safeParse({
        protocolVersion: 1,
        type: "preview.request",
        requestId,
        targetUrls: [targetUrl],
        expiresAt: Date.now() + 60_000,
      }).success,
    ).toBe(false);
  });
});
