import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PipedreamAccountSummary } from "@/shared/contracts/pipedream";
import { pipedreamAccountSummarySchema } from "@/shared/contracts/pipedream";
import { writeFileAtomic } from "@/shared/atomicFile";
import { durableFileSystem, type FileDurability } from "@/shared/fileDurability";
import { z } from "zod";

const storedAccountSchema = pipedreamAccountSummarySchema
  .extend({ localAccountId: z.uuid() })
  .strict();

const storeFileSchema = z
  .object({
    version: z.literal(2),
    scopeHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    accounts: z.array(storedAccountSchema).max(1_000),
  })
  .strict();

const legacyStoreFileSchema = z
  .object({
    version: z.literal(1),
    accounts: z.array(pipedreamAccountSummarySchema).max(1_000),
  })
  .strict();

export interface PipedreamConnectionStoreOptions {
  readonly filePath: string;
  readonly writeFile?: typeof writeFileAtomic;
  readonly durability?: FileDurability;
}

type RemoteAccount = Omit<PipedreamAccountSummary, "agentAccess">;
type StoredAccount = z.infer<typeof storedAccountSchema>;

export interface PipedreamGrantedRelayAccount {
  readonly account: PipedreamAccountSummary;
  /** Local-only provider alias. Never derived from, or sent to, Pipedream. */
  readonly localAccountId: string;
}

interface StoredState {
  readonly scopeHash?: string;
  readonly accounts: StoredAccount[];
}

/** Persists only renderer-safe summaries and local grants; upstream credentials never enter it. */
export class PipedreamConnectionStore {
  readonly #filePath: string;
  readonly #writeFile: typeof writeFileAtomic;
  readonly #durability: FileDurability;
  #scopeHash: string | undefined;
  #accounts: StoredAccount[];

  constructor(options: PipedreamConnectionStoreOptions) {
    this.#filePath = options.filePath;
    this.#writeFile = options.writeFile ?? writeFileAtomic;
    this.#durability = options.durability ?? durableFileSystem;
    const stored = this.#read();
    this.#scopeHash = stored.scopeHash;
    this.#accounts = stored.accounts;
  }

  list(): PipedreamAccountSummary[] {
    return this.#accounts.map(publicAccountSummary);
  }

  listGrantedForRelay(): PipedreamGrantedRelayAccount[] {
    return this.#accounts
      .filter((account) => account.agentAccess && account.healthy)
      .map((account) => ({
        account: publicAccountSummary(account),
        localAccountId: account.localAccountId,
      }));
  }

  hasScopedAccount(accountId: string): boolean {
    return (
      this.#scopeHash !== undefined && this.#accounts.some((account) => account.id === accountId)
    );
  }

  getScopedAccount(accountId: string): PipedreamAccountSummary | undefined {
    if (this.#scopeHash === undefined) return undefined;
    const account = this.#accounts.find((candidate) => candidate.id === accountId);
    return account ? publicAccountSummary(account) : undefined;
  }

  /**
   * Pins persisted grants to one Connect project/environment/user tuple. The
   * caller may pass raw scope material: only its SHA-256 digest is persisted.
   */
  configureScope(scopeMaterial: string): void {
    const normalized = scopeMaterial.trim();
    if (!normalized) throw new Error("Pipedream connection scope is required.");
    const scopeHash = createHash("sha256").update(normalized, "utf8").digest("hex");
    if (this.#scopeHash === scopeHash) return;

    // Existing unscoped data cannot be proven to belong to this identity, and
    // a changed digest definitely does not. Fail closed in both cases.
    this.#commit({ scopeHash, accounts: this.#accounts.length > 0 ? [] : this.#accounts });
  }

  replaceRemoteAccounts(
    accounts: readonly RemoteAccount[],
    forceAgentAccessOff: ReadonlySet<string> = new Set(),
  ): void {
    const previous = new Map(this.#accounts.map((account) => [account.id, account]));
    const next = accounts.map((account) => {
      const existing = previous.get(account.id);
      return storedAccountSchema.parse({
        ...account,
        agentAccess: forceAgentAccessOff.has(account.id) ? false : (existing?.agentAccess ?? false),
        localAccountId: existing?.localAccountId ?? randomUUID(),
      });
    });
    this.#commit({ ...(this.#scopeHash ? { scopeHash: this.#scopeHash } : {}), accounts: next });
  }

  setAgentAccess(accountId: string, enabled: boolean): void {
    const index = this.#accounts.findIndex((account) => account.id === accountId);
    if (index < 0) throw new Error("Pipedream account is not connected.");
    const account = this.#accounts[index]!;
    const next = this.#accounts.map((candidate, candidateIndex) =>
      candidateIndex === index ? { ...account, agentAccess: enabled } : candidate,
    );
    this.#commit({ ...(this.#scopeHash ? { scopeHash: this.#scopeHash } : {}), accounts: next });
  }

  /**
   * First durable phase of disconnect. Persist access-off and rotate the local
   * relay identity before either removing the row or issuing an upstream DELETE.
   */
  beginDisconnect(accountId: string): void {
    const index = this.#accounts.findIndex((account) => account.id === accountId);
    if (index < 0) throw new Error("Pipedream account is not connected.");
    const account = this.#accounts[index]!;
    const next = this.#accounts.map((candidate, candidateIndex) =>
      candidateIndex === index
        ? { ...account, agentAccess: false, localAccountId: randomUUID() }
        : candidate,
    );
    this.#commit({ ...(this.#scopeHash ? { scopeHash: this.#scopeHash } : {}), accounts: next });
  }

  remove(accountId: string): void {
    const next = this.#accounts.filter((account) => account.id !== accountId);
    if (next.length === this.#accounts.length) return;
    this.#commit({ ...(this.#scopeHash ? { scopeHash: this.#scopeHash } : {}), accounts: next });
  }

  /** Restores only safe display metadata after an ambiguous remote revoke. */
  restoreRevokedAccount(account: PipedreamAccountSummary): void {
    const revoked = pipedreamAccountSummarySchema.parse({ ...account, agentAccess: false });
    const index = this.#accounts.findIndex((candidate) => candidate.id === revoked.id);
    let next: StoredAccount[];
    if (index >= 0) {
      const existing = this.#accounts[index]!;
      next = this.#accounts.map((candidate, candidateIndex) =>
        candidateIndex === index
          ? { ...revoked, localAccountId: existing.localAccountId }
          : candidate,
      );
    } else {
      if (this.#accounts.length >= 1_000) return;
      next = [...this.#accounts, { ...revoked, localAccountId: randomUUID() }];
    }
    this.#commit({ ...(this.#scopeHash ? { scopeHash: this.#scopeHash } : {}), accounts: next });
  }

  #read(): StoredState {
    try {
      const value: unknown = JSON.parse(readFileSync(this.#filePath, "utf8"));
      const current = storeFileSchema.safeParse(value);
      if (current.success) {
        return {
          ...(current.data.scopeHash ? { scopeHash: current.data.scopeHash } : {}),
          accounts: current.data.accounts,
        };
      }
      const legacy = legacyStoreFileSchema.safeParse(value);
      if (legacy.success) {
        return {
          accounts: legacy.data.accounts.map((account) => ({
            ...account,
            localAccountId: randomUUID(),
          })),
        };
      }
      return { accounts: [] };
    } catch {
      return { accounts: [] };
    }
  }

  #commit(next: StoredState): void {
    const payload = storeFileSchema.parse({
      version: 2,
      ...(next.scopeHash ? { scopeHash: next.scopeHash } : {}),
      accounts: next.accounts,
    });
    this.#writeFile(this.#filePath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      durability: this.#durability,
    });
    this.#scopeHash = payload.scopeHash;
    this.#accounts = payload.accounts;
  }
}

function publicAccountSummary(account: StoredAccount): PipedreamAccountSummary {
  const { localAccountId: _localAccountId, ...summary } = account;
  return { ...summary, app: { ...summary.app } };
}
