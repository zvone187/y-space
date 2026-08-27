import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalCookieImportTranscript,
  createEphemeralKeyPair,
  deriveConnectionKey,
  derivePairingKey,
  encryptCookieImportPayload,
  hmacProof,
  sha256,
} from "./crypto";

interface WorkerKeyPair {
  keyPair: CryptoKeyPair;
  publicKey: string;
}

interface EncryptedEnvelope {
  iv: string;
  ciphertext: string;
}

interface WorkerHarness {
  context: vm.Context;
  storage: Record<string, unknown>;
  grantedOrigins: Set<string>;
  removedOrigins: string[][];
}

function createWorkerHarness(options?: {
  initialStorage?: Record<string, unknown>;
  initiallyGrantedOrigins?: string[];
  permissionRemovalSucceeds?: boolean;
}): WorkerHarness {
  const storage: Record<string, unknown> = structuredClone(options?.initialStorage ?? {});
  const grantedOrigins = new Set(options?.initiallyGrantedOrigins ?? []);
  const removedOrigins: string[][] = [];
  class DormantWebSocket {
    static readonly OPEN = 1;
    readonly readyState = 0;

    addEventListener(): void {}
    close(): void {}
    send(): void {}
  }
  const chrome = {
    storage: {
      local: {
        get: async (keys: string[]) =>
          Object.fromEntries(
            keys.filter((key) => key in storage).map((key) => [key, storage[key]]),
          ),
        set: async (values: Record<string, unknown>) => Object.assign(storage, values),
        remove: async (keys: string[]) => {
          for (const key of keys) delete storage[key];
        },
      },
    },
    permissions: {
      contains: async ({ origins }: { origins: string[] }) =>
        origins.every((origin) => grantedOrigins.has(origin)),
      remove: async ({ origins }: { origins: string[] }) => {
        removedOrigins.push([...origins]);
        if (options?.permissionRemovalSucceeds === false) return false;
        for (const origin of origins) grantedOrigins.delete(origin);
        return true;
      },
    },
    cookies: { getAll: async () => [] },
    action: {
      setBadgeBackgroundColor: async () => undefined,
      setBadgeText: async () => undefined,
    },
    runtime: {
      getManifest: () => ({ version: "1.0.0" }),
      sendMessage: async () => undefined,
      onMessage: { addListener: () => undefined },
      onInstalled: { addListener: () => undefined },
      onStartup: { addListener: () => undefined },
    },
    alarms: {
      create: () => undefined,
      onAlarm: { addListener: () => undefined },
    },
  };
  const context = vm.createContext({
    URL,
    Uint8Array,
    TextDecoder,
    TextEncoder,
    atob,
    btoa,
    chrome,
    console,
    crypto: webcrypto,
    navigator: { userAgent: "Chrome" },
    setInterval: () => 1,
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    WebSocket: DormantWebSocket,
  });
  const source = readFileSync(resolve(process.cwd(), "chrome-extension/background.js"), "utf8");
  vm.runInContext(source, context, { filename: "chrome-extension/background.js" });
  return { context, storage, grantedOrigins, removedOrigins };
}

function setContextValue(context: vm.Context, name: string, value: unknown): void {
  Object.defineProperty(context, name, { configurable: true, value, writable: true });
}

function runInWorker<T>(context: vm.Context, expression: string): T {
  return vm.runInContext(expression, context) as T;
}

describe("Chrome extension and bridge crypto interoperability", () => {
  it("shares pairing vectors and accepts the server's exact pair/hello transcripts", async () => {
    const { context, storage } = createWorkerHarness();
    const pairingId = "11111111-1111-4111-8111-111111111111";
    const sourceId = "22222222-2222-4222-8222-222222222222";
    const challenge = "A".repeat(43);
    const pairingNonce = "B".repeat(43);
    const pairingCode = "12345678";

    setContextValue(context, "testPairingVector", {
      pairingCode,
      pairingId,
      challenge,
      pairingNonce,
    });
    const workerPairingKey = await runInWorker<Promise<Uint8Array>>(
      context,
      "derivePairingKey(testPairingVector.pairingCode, testPairingVector.pairingId, testPairingVector.challenge, testPairingVector.pairingNonce)",
    );
    const nodePairingKey = derivePairingKey({
      code: pairingCode,
      pairingId,
      connectionChallenge: challenge,
      clientNonce: pairingNonce,
    });
    expect(Buffer.from(workerPairingKey)).toEqual(nodePairingKey);

    const workerPairKeys = await runInWorker<Promise<WorkerKeyPair>>(
      context,
      "createEphemeralKeyPair()",
    );
    const pairServerKeys = createEphemeralKeyPair();
    const pairTranscript = canonicalCookieImportTranscript([
      "pair.session.v1",
      pairingId,
      challenge,
      pairingNonce,
      workerPairKeys.publicKey,
      pairServerKeys.publicKey,
      sourceId,
    ]);
    const pairServerSession = deriveConnectionKey({
      ecdh: pairServerKeys.ecdh,
      peerPublicKey: workerPairKeys.publicKey,
      authenticationKey: nodePairingKey,
      transcript: pairTranscript,
    });
    const encryptedToken = encryptCookieImportPayload({
      key: pairServerSession,
      plaintext: "extension-interoperability-token",
      aad: `pair.token:${pairingId}:${sourceId}`,
    });
    const pairResult = {
      sourceId,
      serverPublicKey: pairServerKeys.publicKey,
      proof: hmacProof(
        nodePairingKey,
        canonicalCookieImportTranscript([
          "pair.server.v1",
          pairTranscript,
          encryptedToken.iv,
          encryptedToken.ciphertext,
        ]),
      ),
      ...encryptedToken,
    };
    setContextValue(context, "testPairPending", {
      kind: "pair",
      pairingId,
      challenge,
      clientNonce: pairingNonce,
      clientPublicKey: workerPairKeys.publicKey,
      keyPair: workerPairKeys.keyPair,
      pairingKey: workerPairingKey,
      sourceId,
    });
    setContextValue(context, "testPairResult", pairResult);
    await runInWorker<Promise<void>>(
      context,
      "(async () => { pendingHandshake = testPairPending; await acceptPairResult(testPairResult); })()",
    );
    expect(storage.token).toBe("extension-interoperability-token");
    expect(runInWorker<boolean>(context, "authenticated")).toBe(true);

    const authenticationKey = sha256(String(storage.token));
    const helloNonce = "C".repeat(43);
    const workerHelloKeys = await runInWorker<Promise<WorkerKeyPair>>(
      context,
      "createEphemeralKeyPair()",
    );
    const helloServerKeys = createEphemeralKeyPair();
    const helloTranscript = canonicalCookieImportTranscript([
      "hello.session.v1",
      challenge,
      helloNonce,
      workerHelloKeys.publicKey,
      helloServerKeys.publicKey,
      sourceId,
    ]);
    const helloServerSession = deriveConnectionKey({
      ecdh: helloServerKeys.ecdh,
      peerPublicKey: workerHelloKeys.publicKey,
      authenticationKey,
      transcript: helloTranscript,
    });
    setContextValue(context, "testHelloPending", {
      kind: "hello",
      challenge,
      clientNonce: helloNonce,
      clientPublicKey: workerHelloKeys.publicKey,
      keyPair: workerHelloKeys.keyPair,
      authenticationKey: new Uint8Array(authenticationKey),
      sourceId,
    });
    setContextValue(context, "testHelloResult", {
      sourceId,
      serverPublicKey: helloServerKeys.publicKey,
      proof: hmacProof(
        authenticationKey,
        canonicalCookieImportTranscript(["hello.server.v1", helloTranscript]),
      ),
    });
    await runInWorker<Promise<void>>(
      context,
      "(async () => { authenticated = false; sessionKey = null; pendingHandshake = testHelloPending; await acceptHelloResult(testHelloResult); })()",
    );
    expect(runInWorker<boolean>(context, "authenticated")).toBe(true);

    const envelope = encryptCookieImportPayload({
      key: helloServerSession,
      plaintext: "server-to-extension-session-proof",
      aad: "interop-proof",
    });
    setContextValue(context, "testEnvelope", envelope);
    await expect(
      runInWorker<Promise<string>>(
        context,
        'decryptPayload(sessionKey, testEnvelope.iv, testEnvelope.ciphertext, "interop-proof")',
      ),
    ).resolves.toBe("server-to-extension-session-proof");

    setContextValue(context, "testWorkerPlaintext", "extension-to-server-session-proof");
    const workerEnvelope = await runInWorker<Promise<EncryptedEnvelope>>(
      context,
      'encryptPayload(sessionKey, testWorkerPlaintext, "interop-proof")',
    );
    const decryptedByServer = await import("./crypto").then(({ decryptCookieImportPayload }) =>
      decryptCookieImportPayload({
        key: helloServerSession,
        ...workerEnvelope,
        aad: "interop-proof",
      }),
    );
    expect(decryptedByServer).toBe("extension-to-server-session-proof");
  });

  it("cleans only newly granted origins after an MV3 restart and durably retries failure", async () => {
    const newOrigin = "https://new.example/*";
    const preexistingOrigin = "https://preexisting.example/*";
    const managedRequest = {
      requestId: "33333333-3333-4333-8333-333333333333",
      targetUrls: ["https://new.example"],
      previewDomains: ["new.example"],
      newlyGrantedOrigins: [newOrigin],
      expiresAt: Date.now() + 60_000,
      status: "ready",
    };
    const cleaned = createWorkerHarness({
      initialStorage: { managedRequests: { [managedRequest.requestId]: managedRequest } },
      initiallyGrantedOrigins: [newOrigin, preexistingOrigin],
    });
    for (let turn = 0; turn < 5; turn += 1) await new Promise(setImmediate);

    expect(cleaned.removedOrigins).toEqual([[newOrigin]]);
    expect(cleaned.grantedOrigins.has(newOrigin)).toBe(false);
    expect(cleaned.grantedOrigins.has(preexistingOrigin)).toBe(true);
    expect(cleaned.storage.managedRequests).toEqual({});

    const retry = createWorkerHarness({
      initialStorage: { managedRequests: { [managedRequest.requestId]: managedRequest } },
      initiallyGrantedOrigins: [newOrigin, preexistingOrigin],
      permissionRemovalSucceeds: false,
    });
    for (let turn = 0; turn < 5; turn += 1) await new Promise(setImmediate);

    expect(retry.removedOrigins).toEqual([[newOrigin]]);
    expect(retry.grantedOrigins.has(preexistingOrigin)).toBe(true);
    expect(retry.storage.managedRequests).toMatchObject({
      [managedRequest.requestId]: {
        newlyGrantedOrigins: [newOrigin],
        status: "cleanup",
      },
    });

    const lateGrant = createWorkerHarness();
    for (let turn = 0; turn < 3; turn += 1) await new Promise(setImmediate);
    lateGrant.storage.managedRequests = {
      [managedRequest.requestId]: { ...managedRequest, status: "awaiting-permission" },
    };
    setContextValue(lateGrant.context, "testLateRequestId", managedRequest.requestId);
    setContextValue(lateGrant.context, "testLateOrigin", newOrigin);
    await runInWorker<Promise<void>>(lateGrant.context, "cancelRequest(testLateRequestId)");
    expect(lateGrant.storage.managedRequests).toMatchObject({
      [managedRequest.requestId]: { status: "cancelled" },
    });
    lateGrant.grantedOrigins.add(newOrigin);
    await runInWorker<Promise<void>>(
      lateGrant.context,
      "resumePreviewAfterPermission(testLateRequestId, true, [testLateOrigin])",
    );
    expect(lateGrant.grantedOrigins.has(newOrigin)).toBe(false);
    expect(lateGrant.storage.managedRequests).toEqual({});
  });
});
