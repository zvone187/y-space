import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileDurability } from "@/shared/fileDurability";
import { recoverMalformedMcpOAuthCredentialStore } from "./mcpOAuthCredentialStoreRecovery";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("malformed MCP OAuth credential-store recovery", () => {
  it("does not inspect or remove possible plaintext/token state when confirmation is declined", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "y-space-mcp-oauth-recovery-decline-"));
    cleanups.push(() => rmSync(baseDir, { recursive: true, force: true }));
    const storePath = join(baseDir, "mcp-oauth.json");
    const sentinel = '{"servers":{"private":"plaintext-token-sentinel"';
    writeFileSync(storePath, sentinel, { mode: 0o600 });
    const durability: FileDurability = {
      syncFile: vi.fn<(path: string) => void>(),
      syncDirectory: vi.fn<(path: string) => void>(),
    };

    await expect(
      recoverMalformedMcpOAuthCredentialStore({
        baseDir,
        confirmReset: async () => false,
        durability,
      }),
    ).resolves.toBe("stop");

    expect(readFileSync(storePath, "utf8")).toBe(sentinel);
    expect(durability.syncFile).not.toHaveBeenCalled();
    expect(durability.syncDirectory).not.toHaveBeenCalled();
  });

  it("durably removes only the active store after explicit native confirmation", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "y-space-mcp-oauth-recovery-confirm-"));
    cleanups.push(() => rmSync(baseDir, { recursive: true, force: true }));
    const storePath = join(baseDir, "mcp-oauth.json");
    const siblingPath = join(baseDir, "keep-me.json");
    writeFileSync(storePath, "plaintext-or-token-state", { mode: 0o600 });
    writeFileSync(siblingPath, "sibling", { mode: 0o600 });
    const calls: string[] = [];
    const durability: FileDurability = {
      syncFile: (path) => calls.push(`file:${path}`),
      syncDirectory: (path) => calls.push(`directory:${path}`),
    };

    await expect(
      recoverMalformedMcpOAuthCredentialStore({
        baseDir,
        confirmReset: async () => true,
        durability,
      }),
    ).resolves.toBe("retry");

    expect(() => readFileSync(storePath, "utf8")).toThrow(/ENOENT/);
    expect(readFileSync(siblingPath, "utf8")).toBe("sibling");
    expect(calls).toEqual([`file:${storePath}`, `directory:${baseDir}`]);
  });

  it("fails closed when the confirmed reset cannot be durably committed", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "y-space-mcp-oauth-recovery-failure-"));
    cleanups.push(() => rmSync(baseDir, { recursive: true, force: true }));
    const storePath = join(baseDir, "mcp-oauth.json");
    writeFileSync(storePath, "possible-token-state", { mode: 0o600 });

    await expect(
      recoverMalformedMcpOAuthCredentialStore({
        baseDir,
        confirmReset: async () => true,
        durability: {
          syncFile: () => undefined,
          syncDirectory: () => {
            throw new Error("simulated directory flush failure");
          },
        },
      }),
    ).rejects.toThrow("OAuth credential store reset could not be committed safely.");
  });

  it("refuses before deletion when the platform has no durable namespace commit", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "y-space-mcp-oauth-recovery-unsupported-"));
    cleanups.push(() => rmSync(baseDir, { recursive: true, force: true }));
    const storePath = join(baseDir, "mcp-oauth.json");
    const sentinel = "possible-token-state";
    writeFileSync(storePath, sentinel, { mode: 0o600 });
    const syncFile = vi.fn<(path: string) => void>();
    const syncDirectory = vi.fn<(path: string) => void>();

    await expect(
      recoverMalformedMcpOAuthCredentialStore({
        baseDir,
        confirmReset: async () => true,
        durability: {
          assertDirectorySyncSupported: () => {
            throw new Error("namespace durability unavailable");
          },
          syncFile,
          syncDirectory,
        },
      }),
    ).rejects.toThrow("OAuth credential store reset could not be committed safely.");

    expect(readFileSync(storePath, "utf8")).toBe(sentinel);
    expect(syncFile).not.toHaveBeenCalled();
    expect(syncDirectory).not.toHaveBeenCalled();
  });

  it("refuses to recursively remove a non-file store target", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "y-space-mcp-oauth-recovery-directory-"));
    cleanups.push(() => rmSync(baseDir, { recursive: true, force: true }));
    const storePath = join(baseDir, "mcp-oauth.json");
    const nestedState = join(storePath, "possible-token-state");
    mkdirSync(storePath);
    writeFileSync(nestedState, "sentinel", { mode: 0o600 });

    await expect(
      recoverMalformedMcpOAuthCredentialStore({
        baseDir,
        confirmReset: async () => true,
      }),
    ).rejects.toThrow("OAuth credential store reset could not be committed safely.");
    expect(readFileSync(nestedState, "utf8")).toBe("sentinel");
  });
});
