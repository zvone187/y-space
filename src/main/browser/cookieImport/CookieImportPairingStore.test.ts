import { describe, expect, it } from "vitest";
import { canonicalCookieImportTranscript, derivePairingKey, hmacProof, sha256 } from "./crypto";

interface PairedSourceInput {
  sourceId: string;
  label: string;
  browserFamily: string;
  extensionVersion: string;
}

interface PairingStore {
  beginPairing(): { pairingId: string; code: string; expiresAt: number };
  acceptPairingProof(input: {
    pairingId: string;
    connectionChallenge: string;
    clientNonce: string;
    proofTranscript: string;
    proof: string;
    source: PairedSourceInput;
  }): {
    token: string;
    source: PairedSourceInput;
  };
  authenticateProof(input: {
    sourceId: string;
    transcript: string;
    proof: string;
  }): { source: PairedSourceInput } | null;
  forgetSource(sourceId: string): void;
  listSources(): PairedSourceInput[];
}

interface PairingStoreConstructor {
  new (options: {
    load: () => unknown;
    save: (state: unknown) => void;
    purge?: () => void;
    now: () => number;
    randomCode: () => string;
    randomToken: () => string;
  }): PairingStore;
}

async function loadPairingStore(): Promise<PairingStoreConstructor> {
  const modulePath = "./CookieImportPairingStore";
  const module = (await import(modulePath)) as {
    CookieImportPairingStore: PairingStoreConstructor;
  };
  return module.CookieImportPairingStore;
}

const source = (sourceId = "11111111-1111-4111-8111-111111111111"): PairedSourceInput => ({
  sourceId,
  label: "Chrome – Work",
  browserFamily: "chrome",
  extensionVersion: "1.0.0",
});

async function makeStore() {
  const CookieImportPairingStore = await loadPairingStore();
  let now = Date.parse("2026-08-27T12:00:00.000Z");
  let saved: unknown = undefined;
  let nextToken = "raw-token-that-must-not-be-persisted";
  const store = new CookieImportPairingStore({
    load: () => saved,
    save: (state) => {
      saved = structuredClone(state);
    },
    now: () => now,
    randomCode: () => "12345678",
    randomToken: () => nextToken,
  });
  return {
    store,
    getSaved: () => saved,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    setToken: (token: string) => {
      nextToken = token;
    },
  };
}

function proofForPairing(pairing: { pairingId: string; code: string }, code = pairing.code) {
  const connectionChallenge = "A".repeat(43);
  const clientNonce = "B".repeat(43);
  const proofTranscript = canonicalCookieImportTranscript([
    "pairing-store-test",
    pairing.pairingId,
    connectionChallenge,
    clientNonce,
  ]);
  const pairingKey = derivePairingKey({
    code,
    pairingId: pairing.pairingId,
    connectionChallenge,
    clientNonce,
  });
  return {
    connectionChallenge,
    clientNonce,
    proofTranscript,
    proof: hmacProof(pairingKey, proofTranscript),
  };
}

function acceptPairing(
  store: PairingStore,
  pairing: { pairingId: string; code: string },
  pairedSource = source(),
) {
  return store.acceptPairingProof({
    pairingId: pairing.pairingId,
    ...proofForPairing(pairing),
    source: pairedSource,
  });
}

describe("CookieImportPairingStore", () => {
  it("starts unpaired when persisted pairing metadata is invalid", async () => {
    const CookieImportPairingStore = await loadPairingStore();
    const store = new CookieImportPairingStore({
      load: () => ({ version: 1, sources: [{ tokenHash: "not-a-valid-pairing" }] }),
      save: () => undefined,
      now: Date.now,
      randomCode: () => "12345678",
      randomToken: () => "replacement-token",
    });

    expect(store.listSources()).toEqual([]);
  });

  it("issues an eight-digit five-minute code and persists only a token hash", async () => {
    const fixture = await makeStore();
    const pairing = fixture.store.beginPairing();

    expect(pairing.code).toMatch(/^\d{8}$/);
    expect(pairing.expiresAt).toBe(Date.parse("2026-08-27T12:05:00.000Z"));
    const accepted = acceptPairing(fixture.store, pairing);

    expect(accepted.token).toBe("raw-token-that-must-not-be-persisted");
    const serialized = JSON.stringify(fixture.getSaved());
    expect(serialized).toContain("tokenHash");
    expect(serialized).not.toContain(accepted.token);
    const transcript = canonicalCookieImportTranscript(["authenticate", source().sourceId]);
    expect(
      fixture.store.authenticateProof({
        sourceId: source().sourceId,
        transcript,
        proof: hmacProof(sha256(accepted.token), transcript),
      }),
    ).not.toBeNull();
  });

  it("expires a pairing after five minutes", async () => {
    const fixture = await makeStore();
    const pairing = fixture.store.beginPairing();
    fixture.advance(5 * 60 * 1000 + 1);

    expect(() =>
      fixture.store.acceptPairingProof({
        pairingId: pairing.pairingId,
        ...proofForPairing(pairing),
        source: source(),
      }),
    ).toThrow(/expired/i);
  });

  it("locks a pairing after five incorrect code attempts", async () => {
    const fixture = await makeStore();
    const pairing = fixture.store.beginPairing();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(() =>
        fixture.store.acceptPairingProof({
          pairingId: pairing.pairingId,
          ...proofForPairing(pairing, "00000000"),
          source: source(),
        }),
      ).toThrow(/code|attempt|pair/i);
    }

    expect(() =>
      fixture.store.acceptPairingProof({
        pairingId: pairing.pairingId,
        ...proofForPairing(pairing),
        source: source(),
      }),
    ).toThrow(/locked|attempt|pair/i);
  });

  it("rejects a wrong token and revokes a forgotten source", async () => {
    const fixture = await makeStore();
    const pairing = fixture.store.beginPairing();
    const accepted = acceptPairing(fixture.store, pairing);
    const transcript = canonicalCookieImportTranscript(["authenticate", source().sourceId]);
    expect(
      fixture.store.authenticateProof({
        sourceId: source().sourceId,
        transcript,
        proof: hmacProof(sha256("wrong-token"), transcript),
      }),
    ).toBeNull();
    expect(
      fixture.store.authenticateProof({
        sourceId: source().sourceId,
        transcript,
        proof: hmacProof(sha256(accepted.token), transcript),
      }),
    ).not.toBeNull();
    fixture.store.forgetSource(source().sourceId);
    expect(
      fixture.store.authenticateProof({
        sourceId: source().sourceId,
        transcript,
        proof: hmacProof(sha256(accepted.token), transcript),
      }),
    ).toBeNull();
  });

  it("retains multiple independently authenticated browser profiles", async () => {
    const fixture = await makeStore();
    const first = fixture.store.beginPairing();
    acceptPairing(fixture.store, first);

    fixture.setToken("second-profile-token");
    const second = fixture.store.beginPairing();
    acceptPairing(fixture.store, second, source("44444444-4444-4444-8444-444444444444"));

    expect(fixture.store.listSources().map(({ sourceId }) => sourceId)).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "44444444-4444-4444-8444-444444444444",
    ]);
  });

  it("purges every pairing when revocation cannot persist the reduced store", async () => {
    const CookieImportPairingStore = await loadPairingStore();
    let purged = false;
    const store = new CookieImportPairingStore({
      load: () => ({
        version: 1,
        sources: [
          {
            ...source(),
            pairedAt: 1,
            tokenHash: sha256("first-token").toString("hex"),
          },
          {
            ...source("44444444-4444-4444-8444-444444444444"),
            pairedAt: 2,
            tokenHash: sha256("second-token").toString("hex"),
          },
        ],
      }),
      save: () => {
        throw new Error("simulated persistence failure");
      },
      purge: () => {
        purged = true;
      },
      now: Date.now,
      randomCode: () => "12345678",
      randomToken: () => "replacement-token",
    });

    expect(() => store.forgetSource(source().sourceId)).not.toThrow();
    expect(purged).toBe(true);
    expect(store.listSources()).toEqual([]);
  });
});
