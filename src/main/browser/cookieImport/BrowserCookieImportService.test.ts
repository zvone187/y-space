import { describe, expect, it, vi } from "vitest";

interface CookieImportService {
  getState(): unknown;
  preview(input: { sourceId: string; targetUrls: string[] }): Promise<unknown>;
  previewLocal(input: { sourceId: string; targetUrls: string[] }): Promise<unknown>;
  previewFile(input: { fileName: string; serialized: string; targetUrls: string[] }): unknown;
  commit(input: { requestId: string; selectedDomains: string[] }): Promise<unknown>;
}

interface CookieImportServiceConstructor {
  new (options: {
    session: {
      cookies: {
        get(filter?: Record<string, unknown>): Promise<unknown[]>;
        set(details: Record<string, unknown>): Promise<void>;
        flushStore(): Promise<void>;
      };
    };
    bridge: {
      requestPreview(input: unknown): Promise<unknown>;
      requestCommit(input: unknown): Promise<unknown>;
      cancel(input?: unknown): Promise<void>;
    };
    emit(...args: unknown[]): void;
    listLocalProfiles?(): unknown[];
    readLocalProfile?(input: {
      sourceId: string;
      targetUrls: string[];
    }): Promise<{ cookies: unknown[]; invalidCount: number }>;
    now: () => number;
    randomId: () => string;
  }): CookieImportService;
}

async function loadService(): Promise<CookieImportServiceConstructor> {
  const modulePath = "./BrowserCookieImportService";
  const module = (await import(modulePath)) as {
    BrowserCookieImportService: CookieImportServiceConstructor;
  };
  return module.BrowserCookieImportService;
}

const sourceId = "11111111-1111-4111-8111-111111111111";
const requestId = "33333333-3333-4333-8333-333333333333";

async function makeService(options?: { previewResult?: unknown; commitResult?: unknown }) {
  const BrowserCookieImportService = await loadService();
  let now = Date.parse("2026-08-27T12:00:00.000Z");
  const cookies = {
    get: vi.fn<(filter?: Record<string, unknown>) => Promise<unknown[]>>(async () => []),
    set: vi.fn<(details: Record<string, unknown>) => Promise<void>>(async () => undefined),
    flushStore: vi.fn<() => Promise<void>>(async () => undefined),
  };
  const bridge = {
    requestPreview: vi.fn<(input: unknown) => Promise<unknown>>(
      async () =>
        options?.previewResult ?? {
          requestId,
          domains: [{ domain: "example.com", cookieCount: 1, unsupportedCount: 0 }],
        },
    ),
    requestCommit: vi.fn<(input: unknown) => Promise<unknown>>(
      async () => options?.commitResult ?? { requestId, cookies: [] },
    ),
    cancel: vi.fn<(input?: unknown) => Promise<void>>(async () => undefined),
  };
  const emit = vi.fn<(...args: unknown[]) => void>();
  const service = new BrowserCookieImportService({
    session: { cookies },
    bridge,
    emit,
    now: () => now,
    randomId: () => requestId,
  });
  return {
    service,
    cookies,
    bridge,
    emit,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

describe("BrowserCookieImportService", () => {
  it("returns and emits metadata-only preview state", async () => {
    const secret = "must-never-enter-renderer-state";
    const fixture = await makeService({
      previewResult: {
        requestId,
        domains: [{ domain: "example.com", cookieCount: 2, unsupportedCount: 1 }],
      },
    });
    const preview = await fixture.service.preview({
      sourceId,
      targetUrls: ["https://example.com"],
    });

    expect(fixture.bridge.requestPreview).toHaveBeenCalledWith({
      requestId,
      sourceId,
      targetUrls: ["https://example.com"],
      expiresAt: Date.parse("2026-08-27T12:05:00.000Z"),
    });
    expect(preview).toMatchObject({
      requestId,
      domains: [{ domain: "example.com", cookieCount: 2, unsupportedCount: 1 }],
    });
    expect(JSON.stringify({ preview, emitted: fixture.emit.mock.calls })).not.toContain(secret);
    expect(JSON.stringify({ preview, emitted: fixture.emit.mock.calls })).not.toMatch(
      /"(?:value|cookies|token|tokenHash)"\s*:/,
    );
  });

  it("keeps commit cookie values inside main and exposes counts only", async () => {
    const secret = "commit-only-cookie-value";
    const fixture = await makeService({
      commitResult: {
        requestId,
        cookies: [
          {
            name: "session",
            value: secret,
            domain: "example.com",
            hostOnly: true,
            path: "/",
            secure: true,
            httpOnly: true,
            sameSite: "lax",
            session: true,
          },
        ],
      },
    });
    await fixture.service.preview({ sourceId, targetUrls: ["https://example.com"] });
    fixture.emit.mockClear();

    const result = await fixture.service.commit({ requestId, selectedDomains: ["example.com"] });

    expect(fixture.cookies.set).toHaveBeenCalledWith(
      expect.objectContaining({ name: "session", value: secret }),
    );
    expect(fixture.cookies.flushStore).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ importedCount: 1, skippedCount: 0 });
    expect(JSON.stringify({ result, emitted: fixture.emit.mock.calls })).not.toContain(secret);
    expect(JSON.stringify({ result, emitted: fixture.emit.mock.calls })).not.toMatch(
      /"(?:value|cookies|token|tokenHash)"\s*:/,
    );
  });

  it.each(["ftp://example.com/", "javascript:alert(1)", "https://user:password@example.com/"])(
    "rejects unsafe target URL %s before contacting the extension",
    async (targetUrl) => {
      const fixture = await makeService();

      await expect(fixture.service.preview({ sourceId, targetUrls: [targetUrl] })).rejects.toThrow(
        /target|url|origin|scheme|credential/i,
      );
      expect(fixture.bridge.requestPreview).not.toHaveBeenCalled();
    },
  );

  it("skips a commit cookie outside every approved target origin", async () => {
    const fixture = await makeService({
      previewResult: {
        requestId,
        domains: [{ domain: "attacker.example", cookieCount: 1, unsupportedCount: 0 }],
      },
      commitResult: {
        requestId,
        cookies: [
          {
            name: "session",
            value: "out-of-scope-secret",
            domain: ".attacker.example",
            hostOnly: false,
            path: "/",
            secure: true,
            httpOnly: true,
            sameSite: "lax",
            session: true,
          },
        ],
      },
    });
    await fixture.service.preview({ sourceId, targetUrls: ["https://example.com/"] });

    const result = await fixture.service.commit({
      requestId,
      selectedDomains: ["attacker.example"],
    });

    expect(fixture.cookies.set).not.toHaveBeenCalled();
    expect(result).toMatchObject({ importedCount: 0, skippedCount: 1 });
    expect(JSON.stringify(result)).not.toContain("out-of-scope-secret");
  });

  it("keeps file values in main memory, deduplicates them, and reports only counts", async () => {
    const fixture = await makeService();
    const firstSecret = "file-secret-first";
    const replacementSecret = "file-secret-replacement";
    const preview = fixture.service.previewFile({
      fileName: "cookies.json",
      targetUrls: ["https://example.com"],
      serialized: JSON.stringify([
        {
          name: "session",
          value: firstSecret,
          domain: "example.com",
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "lax",
          session: true,
        },
        {
          name: "session",
          value: replacementSecret,
          domain: "example.com",
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "lax",
          session: true,
        },
      ]),
    });

    expect(preview).toMatchObject({
      sourceKind: "file",
      sourceLabel: "cookies.json",
      domains: [{ domain: "example.com", cookieCount: 2, unsupportedCount: 0 }],
    });
    expect(JSON.stringify({ preview, emitted: fixture.emit.mock.calls })).not.toContain(
      firstSecret,
    );
    expect(JSON.stringify({ preview, emitted: fixture.emit.mock.calls })).not.toContain(
      replacementSecret,
    );

    const result = await fixture.service.commit({
      requestId,
      selectedDomains: ["example.com"],
    });
    expect(fixture.bridge.requestCommit).not.toHaveBeenCalled();
    expect(fixture.cookies.set).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: "session", value: replacementSecret }),
    );
    expect(result).toMatchObject({ importedCount: 1, skippedCount: 1 });
    expect(JSON.stringify({ result, emitted: fixture.emit.mock.calls })).not.toContain(firstSecret);
    expect(JSON.stringify({ result, emitted: fixture.emit.mock.calls })).not.toContain(
      replacementSecret,
    );
  });

  it("previews an installed browser profile without sending cookie values to the renderer", async () => {
    const BrowserCookieImportService = await loadService();
    const secret = "local-profile-cookie-secret";
    const cookies = {
      get: vi.fn<(filter?: Record<string, unknown>) => Promise<unknown[]>>(async () => []),
      set: vi.fn<(details: Record<string, unknown>) => Promise<void>>(async () => undefined),
      flushStore: vi.fn<() => Promise<void>>(async () => undefined),
    };
    const localProfile = {
      sourceId,
      label: "Firefox — work",
      browserFamily: "firefox",
    };
    const readLocalProfile = vi.fn<
      (input: {
        sourceId: string;
        targetUrls: string[];
      }) => Promise<{ cookies: unknown[]; invalidCount: number }>
    >(async () => ({
      cookies: [
        {
          name: "session",
          value: secret,
          domain: "example.com",
          hostOnly: true,
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "lax",
          session: true,
        },
      ],
      invalidCount: 0,
    }));
    const emit = vi.fn<(state: unknown) => void>();
    const service = new BrowserCookieImportService({
      session: { cookies },
      bridge: {
        requestPreview: vi.fn<(input: unknown) => Promise<unknown>>(),
        requestCommit: vi.fn<(input: unknown) => Promise<unknown>>(),
        cancel: vi.fn<(input?: unknown) => Promise<void>>(),
      },
      emit,
      listLocalProfiles: () => [localProfile],
      readLocalProfile,
      now: () => Date.parse("2026-08-27T12:00:00.000Z"),
      randomId: () => requestId,
    });

    expect(service.getState()).toMatchObject({ localProfiles: [localProfile] });
    const preview = await service.previewLocal({
      sourceId,
      targetUrls: ["https://example.com"],
    });
    expect(readLocalProfile).toHaveBeenCalledWith({
      sourceId,
      targetUrls: ["https://example.com"],
    });
    expect(preview).toMatchObject({
      sourceKind: "local-profile",
      sourceLabel: "Firefox — work",
      domains: [{ domain: "example.com", cookieCount: 1, unsupportedCount: 0 }],
    });
    expect(
      JSON.stringify({ preview, state: service.getState(), emitted: emit.mock.calls }),
    ).not.toContain(secret);

    await service.commit({ requestId, selectedDomains: ["example.com"] });
    expect(cookies.set).toHaveBeenCalledWith(expect.objectContaining({ value: secret }));
  });

  it("expires and clears an uncommitted file import after five minutes", async () => {
    const fixture = await makeService();
    const secret = "expired-file-secret";
    fixture.service.previewFile({
      fileName: "cookies.json",
      targetUrls: ["https://example.com"],
      serialized: JSON.stringify([
        {
          name: "session",
          value: secret,
          domain: "example.com",
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "lax",
          session: true,
        },
      ]),
    });
    fixture.advance(5 * 60 * 1000 + 1);

    await expect(
      fixture.service.commit({ requestId, selectedDomains: ["example.com"] }),
    ).rejects.toThrow(/expired/i);
    expect(fixture.cookies.set).not.toHaveBeenCalled();
    expect(JSON.stringify(fixture.emit.mock.calls)).not.toContain(secret);
  });
});
