import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { z } from "zod";
import { derivePairingKey, proofMatches } from "./crypto";

const PAIRING_TTL_MS = 5 * 60 * 1000;
const MAX_PAIRING_ATTEMPTS = 5;

const pairedSourceInputSchema = z
  .object({
    sourceId: z.string().uuid(),
    label: z.string().min(1).max(120),
    browserFamily: z.enum(["chrome", "chromium", "brave", "edge"]),
    extensionVersion: z.string().min(1).max(64),
  })
  .strict();

const storedSourceSchema = pairedSourceInputSchema
  .extend({
    pairedAt: z.number().int().nonnegative(),
    tokenHash: z.string().regex(/^[a-f\d]{64}$/),
  })
  .strict();

const persistedStateSchema = z
  .object({
    version: z.literal(1),
    sources: z.array(storedSourceSchema),
  })
  .strict();

export type CookieImportPairedSourceInput = z.infer<typeof pairedSourceInputSchema>;
type StoredSource = z.infer<typeof storedSourceSchema>;
type PersistedState = z.infer<typeof persistedStateSchema>;

export interface CookieImportPairedSource extends CookieImportPairedSourceInput {
  pairedAt: number;
}

export interface CookieImportPairingChallenge {
  pairingId: string;
  code: string;
  expiresAt: number;
}

interface ActivePairing extends CookieImportPairingChallenge {
  failedAttempts: number;
  locked: boolean;
}

export interface CookieImportPairingStoreOptions {
  load?(): unknown;
  save?(state: PersistedState): void;
  purge?(): void;
  now?(): number;
  randomCode?(): string;
  randomToken?(): string;
  randomId?(): string;
}

export interface CookieImportPairingRevocationResult {
  revoked: boolean;
  purgedAll: boolean;
}

function defaultRandomCode(): string {
  return randomInt(0, 100_000_000).toString().padStart(8, "0");
}

function defaultRandomToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class CookieImportPairingStore {
  private readonly sources = new Map<string, StoredSource>();
  private readonly activePairings = new Map<string, ActivePairing>();
  private readonly loadState: () => unknown;
  private readonly saveState: (state: PersistedState) => void;
  private readonly purgeState: (() => void) | undefined;
  private readonly now: () => number;
  private readonly randomCode: () => string;
  private readonly randomToken: () => string;
  private readonly randomId: () => string;

  constructor(options: CookieImportPairingStoreOptions = {}) {
    this.loadState = options.load ?? (() => undefined);
    this.saveState = options.save ?? (() => undefined);
    this.purgeState = options.purge;
    this.now = options.now ?? Date.now;
    this.randomCode = options.randomCode ?? defaultRandomCode;
    this.randomToken = options.randomToken ?? defaultRandomToken;
    this.randomId = options.randomId ?? randomUUID;

    const loaded = this.loadState();
    if (loaded === undefined || loaded === null) return;
    const parsedState = persistedStateSchema.safeParse(loaded);
    if (!parsedState.success) return;
    const state = parsedState.data;
    for (const source of state.sources) this.sources.set(source.sourceId, source);
  }

  beginPairing(): CookieImportPairingChallenge {
    this.pruneExpiredPairings();
    const code = this.randomCode();
    if (!/^\d{8}$/.test(code)) throw new Error("Pairing code generator must return eight digits.");
    const pairing: ActivePairing = {
      pairingId: this.randomId(),
      code,
      expiresAt: this.now() + PAIRING_TTL_MS,
      failedAttempts: 0,
      locked: false,
    };
    this.activePairings.set(pairing.pairingId, pairing);
    return { pairingId: pairing.pairingId, code: pairing.code, expiresAt: pairing.expiresAt };
  }

  cancelPairing(pairingId: string): boolean {
    return this.activePairings.delete(pairingId);
  }

  acceptPairingProof(input: {
    pairingId: string;
    connectionChallenge: string;
    clientNonce: string;
    proofTranscript: string;
    proof: string;
    source: CookieImportPairedSourceInput;
  }): { token: string; pairingKey: Buffer; source: CookieImportPairedSource } {
    const pairing = this.requireActivePairing(input.pairingId);
    const pairingKey = derivePairingKey({
      code: pairing.code,
      pairingId: pairing.pairingId,
      connectionChallenge: input.connectionChallenge,
      clientNonce: input.clientNonce,
    });
    if (!proofMatches(pairingKey, input.proofTranscript, input.proof)) {
      this.recordFailedAttempt(pairing);
      throw new Error(
        pairing.locked ? "Pairing is locked after too many attempts." : "Pairing proof is invalid.",
      );
    }
    const accepted = this.finishPairing(pairing, input.source);
    return { ...accepted, pairingKey };
  }

  authenticateProof(input: {
    sourceId: string;
    transcript: string;
    proof: string;
  }): { authenticationKey: Buffer; source: CookieImportPairedSource } | null {
    const stored = this.sources.get(input.sourceId);
    if (!stored) return null;
    const authenticationKey = Buffer.from(stored.tokenHash, "hex");
    if (!proofMatches(authenticationKey, input.transcript, input.proof)) return null;
    return { authenticationKey, source: this.toPublicSource(stored) };
  }

  refreshSourceMetadata(
    sourceId: string,
    input: Omit<CookieImportPairedSourceInput, "sourceId">,
  ): void {
    const stored = this.sources.get(sourceId);
    if (!stored) return;
    const parsed = pairedSourceInputSchema.parse({ sourceId, ...input });
    const next: StoredSource = { ...stored, ...parsed };
    this.sources.set(sourceId, next);
    this.persist();
  }

  private finishPairing(
    pairing: ActivePairing,
    source: CookieImportPairedSourceInput,
  ): { token: string; source: CookieImportPairedSource } {
    const parsedSource = pairedSourceInputSchema.parse(source);
    const token = this.randomToken();
    if (!token) throw new Error("Pairing token generator returned an empty token.");
    const stored: StoredSource = {
      ...parsedSource,
      pairedAt: this.now(),
      tokenHash: hashToken(token),
    };
    this.sources.set(stored.sourceId, stored);
    this.activePairings.delete(pairing.pairingId);
    this.persist();
    return { token, source: this.toPublicSource(stored) };
  }

  private requireActivePairing(pairingId: string): ActivePairing {
    const pairing = this.activePairings.get(pairingId);
    if (!pairing) throw new Error("Pairing request was not found.");
    if (pairing.locked) throw new Error("Pairing is locked after too many attempts.");
    if (this.now() >= pairing.expiresAt) {
      this.activePairings.delete(pairing.pairingId);
      throw new Error("Pairing code has expired.");
    }
    return pairing;
  }

  private recordFailedAttempt(pairing: ActivePairing): void {
    pairing.failedAttempts += 1;
    if (pairing.failedAttempts >= MAX_PAIRING_ATTEMPTS) pairing.locked = true;
  }

  forgetSource(sourceId: string): CookieImportPairingRevocationResult {
    if (!this.sources.delete(sourceId)) return { revoked: false, purgedAll: false };
    try {
      this.persist();
      return { revoked: true, purgedAll: false };
    } catch (writeError) {
      this.sources.clear();
      if (!this.purgeState) throw writeError;
      try {
        this.purgeState();
      } catch (purgeError) {
        throw new Error("Unable to persist or securely purge browser-cookie pairings.", {
          cause: purgeError,
        });
      }
      return { revoked: true, purgedAll: true };
    }
  }

  listSources(): CookieImportPairedSource[] {
    return [...this.sources.values()]
      .sort((left, right) => left.pairedAt - right.pairedAt)
      .map((source) => this.toPublicSource(source));
  }

  private toPublicSource(source: StoredSource): CookieImportPairedSource {
    return {
      sourceId: source.sourceId,
      label: source.label,
      browserFamily: source.browserFamily,
      extensionVersion: source.extensionVersion,
      pairedAt: source.pairedAt,
    };
  }

  private persist(): void {
    this.saveState(persistedStateSchema.parse({ version: 1, sources: [...this.sources.values()] }));
  }

  private pruneExpiredPairings(): void {
    const now = this.now();
    for (const [pairingId, pairing] of this.activePairings) {
      if (pairing.expiresAt <= now) this.activePairings.delete(pairingId);
    }
  }
}
