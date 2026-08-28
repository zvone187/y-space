import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  CookieImportPairingStore,
  type CookieImportPairingChallenge,
  type CookieImportPairedSource,
} from "./CookieImportPairingStore";
import {
  assertCookieImportPayloadSize,
  cookieImportClientMessageSchema,
  cookieImportCommitResultPayloadSchema,
  cookieImportServerMessageSchema,
  COOKIE_IMPORT_MAX_PAYLOAD_BYTES,
  COOKIE_IMPORT_PROTOCOL_VERSION,
  type CookieImportCommitResult,
  type CookieImportPreviewResult,
  type CookieImportServerMessage,
} from "./protocol";
import type { CookieImportBridge, CookieImportRendererSource } from "./BrowserCookieImportService";
import {
  canonicalCookieImportTranscript,
  createEphemeralKeyPair,
  decryptCookieImportPayload,
  deriveConnectionKey,
  encodeBase64Url,
  encryptCookieImportPayload,
  hmacProof,
} from "./crypto";

const DEFAULT_PORTS = [
  ...Array.from({ length: 13 }, (_, index) => 47820 + index),
  ...Array.from({ length: 13 }, (_, index) => 32120 + index),
];
const DEFAULT_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;

interface BridgeConnection {
  socket: WebSocket;
  sourceId: string | null;
  authenticated: boolean;
  challenge: string;
  sessionKey: Buffer | null;
  authenticationTimer: ReturnType<typeof setTimeout>;
}

interface PendingRequest {
  kind: "preview" | "commit";
  connection: BridgeConnection;
  timer: ReturnType<typeof setTimeout>;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export interface CookieImportBridgeInfo {
  port: number;
  url: string;
}

export interface CookieImportBridgeServerOptions {
  pairingStore: CookieImportPairingStore;
  ports?: readonly number[];
  requestTimeoutMs?: number;
  now?(): number;
  onStateChange?(): void;
}

function isExtensionOrigin(origin: string | undefined): boolean {
  return (
    typeof origin === "string" &&
    (origin.startsWith("chrome-extension://") || origin.startsWith("moz-extension://"))
  );
}

function rawMessageToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return String(data);
}

export class CookieImportBridgeServer implements CookieImportBridge {
  private readonly connections = new Set<BridgeConnection>();
  private readonly authenticatedBySourceId = new Map<string, BridgeConnection>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly ports: readonly number[];
  private readonly requestTimeoutMs: number;
  private readonly now: () => number;
  private server: WebSocketServer | null = null;
  private info: CookieImportBridgeInfo | null = null;
  private activePairing: CookieImportPairingChallenge | null = null;
  private pairingExpiryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: CookieImportBridgeServerOptions) {
    this.ports = options.ports?.length ? [...options.ports] : DEFAULT_PORTS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<CookieImportBridgeInfo> {
    if (this.info) return this.info;
    const port = await this.listenOnAvailablePort();
    this.info = { port, url: `ws://127.0.0.1:${port}/cookie-import` };
    return this.info;
  }

  getInfo(): CookieImportBridgeInfo | null {
    return this.info;
  }

  beginPairing(): CookieImportPairingChallenge {
    if (this.activePairing) this.options.pairingStore.cancelPairing(this.activePairing.pairingId);
    this.clearPairingExpiryTimer();
    this.activePairing = this.options.pairingStore.beginPairing();
    this.schedulePairingExpiry();
    this.broadcastPairingChallenge();
    this.notifyStateChange();
    return { ...this.activePairing };
  }

  cancelPairing(pairingId: string): void {
    this.options.pairingStore.cancelPairing(pairingId);
    if (this.activePairing?.pairingId === pairingId) {
      this.activePairing = null;
      this.clearPairingExpiryTimer();
    }
    this.notifyStateChange();
  }

  forgetSource(sourceId: string): void {
    this.revokeSourceConnection(sourceId);
    try {
      const result = this.options.pairingStore.forgetSource(sourceId);
      if (result.purgedAll) {
        for (const connectedSourceId of [...this.authenticatedBySourceId.keys()]) {
          this.revokeSourceConnection(connectedSourceId);
        }
      }
    } finally {
      const retainedSourceIds = new Set(
        this.options.pairingStore.listSources().map((source) => source.sourceId),
      );
      for (const connectedSourceId of [...this.authenticatedBySourceId.keys()]) {
        if (!retainedSourceIds.has(connectedSourceId)) {
          this.revokeSourceConnection(connectedSourceId);
        }
      }
      this.notifyStateChange();
    }
  }

  listSources(): CookieImportRendererSource[] {
    return this.options.pairingStore.listSources().map((source) => ({
      ...source,
      connected: this.authenticatedBySourceId.has(source.sourceId),
    }));
  }

  requestPreview(input: {
    requestId: string;
    sourceId: string;
    targetUrls: string[];
    expiresAt: number;
  }): Promise<CookieImportPreviewResult> {
    const connection = this.requireConnection(input.sourceId);
    return this.request<CookieImportPreviewResult>(connection, input.requestId, "preview", {
      protocolVersion: COOKIE_IMPORT_PROTOCOL_VERSION,
      type: "preview.request",
      requestId: input.requestId,
      targetUrls: input.targetUrls,
      expiresAt: input.expiresAt,
    });
  }

  requestCommit(input: {
    requestId: string;
    sourceId: string;
    targetUrls: string[];
    selectedDomains: string[];
    expiresAt: number;
  }): Promise<CookieImportCommitResult> {
    const connection = this.requireConnection(input.sourceId);
    return this.request<CookieImportCommitResult>(connection, input.requestId, "commit", {
      protocolVersion: COOKIE_IMPORT_PROTOCOL_VERSION,
      type: "commit.request",
      requestId: input.requestId,
      targetUrls: input.targetUrls,
      selectedDomains: input.selectedDomains,
      expiresAt: input.expiresAt,
    });
  }

  async cancel(input: { requestId: string; sourceId: string }): Promise<void> {
    const pending = this.pending.get(input.requestId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(input.requestId);
      pending.reject(new Error("Cookie import was cancelled."));
    }
    const connection = this.authenticatedBySourceId.get(input.sourceId);
    if (!connection) return;
    this.send(connection.socket, {
      protocolVersion: COOKIE_IMPORT_PROTOCOL_VERSION,
      type: "cancel.request",
      requestId: input.requestId,
    });
  }

  dispose(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Cookie-import bridge closed."));
    }
    this.pending.clear();
    for (const connection of this.connections) {
      clearTimeout(connection.authenticationTimer);
      connection.sessionKey?.fill(0);
      connection.sessionKey = null;
      try {
        connection.socket.close(1001, "Y Space is closing");
      } catch {}
    }
    this.connections.clear();
    this.authenticatedBySourceId.clear();
    try {
      this.server?.close();
    } catch {}
    this.server = null;
    this.info = null;
    this.activePairing = null;
    this.clearPairingExpiryTimer();
    this.notifyStateChange();
  }

  private request<Result>(
    connection: BridgeConnection,
    requestId: string,
    kind: PendingRequest["kind"],
    message: CookieImportServerMessage,
  ): Promise<Result> {
    if (this.pending.has(requestId)) {
      return Promise.reject(new Error("Cookie-import request ID is already active."));
    }
    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        try {
          this.send(connection.socket, {
            protocolVersion: COOKIE_IMPORT_PROTOCOL_VERSION,
            type: "cancel.request",
            requestId,
          });
        } catch {}
        reject(new Error("Cookie-import extension request timed out."));
      }, this.requestTimeoutMs);
      this.pending.set(requestId, {
        kind,
        connection,
        timer,
        resolve: (value) => resolve(value as Result),
        reject,
      });
      try {
        this.send(connection.socket, message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error("Unable to contact cookie extension."));
      }
    });
  }

  private requireConnection(sourceId: string): BridgeConnection {
    const connection = this.authenticatedBySourceId.get(sourceId);
    if (!connection?.authenticated || connection.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Selected browser-cookie source is not connected.");
    }
    return connection;
  }

  private listenOnAvailablePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      let index = 0;
      const tryPort = (): void => {
        const port = this.ports[index];
        if (port === undefined) {
          reject(new Error("No cookie-import bridge port is available."));
          return;
        }
        const server = new WebSocketServer({
          host: "127.0.0.1",
          port,
          maxPayload: COOKIE_IMPORT_MAX_PAYLOAD_BYTES,
          verifyClient: (info, callback) => this.verifyClient(info.origin, info.req, callback),
        });
        server.once("error", (error: NodeJS.ErrnoException) => {
          try {
            server.close();
          } catch {}
          if (error.code === "EADDRINUSE" && index < this.ports.length - 1) {
            index += 1;
            tryPort();
            return;
          }
          reject(error);
        });
        server.once("listening", () => {
          this.server = server;
          server.on("connection", (socket) => this.handleConnection(socket));
          resolve(port);
        });
      };
      tryPort();
    });
  }

  private verifyClient(
    origin: string | undefined,
    request: IncomingMessage,
    callback: (accepted: boolean, code?: number, message?: string) => void,
  ): void {
    let pathname = "";
    try {
      pathname = new URL(request.url ?? "", "ws://127.0.0.1").pathname;
    } catch {}
    if (pathname === "/cookie-import" && isExtensionOrigin(origin)) {
      callback(true);
      return;
    }
    callback(false, 403, "Extension origin and cookie-import path required");
  }

  private handleConnection(socket: WebSocket): void {
    const connection: BridgeConnection = {
      socket,
      sourceId: null,
      authenticated: false,
      challenge: encodeBase64Url(randomBytes(32)),
      sessionKey: null,
      authenticationTimer: setTimeout(() => socket.close(1008, "Authentication timed out"), 30_000),
    };
    this.connections.add(connection);
    socket.on("message", (data) => this.handleMessage(connection, data));
    socket.on("close", () => this.closeConnection(connection));
    socket.on("error", () => this.closeConnection(connection));
    this.send(socket, {
      protocolVersion: COOKIE_IMPORT_PROTOCOL_VERSION,
      type: "connection.challenge",
      challenge: connection.challenge,
    });
    const activePairing = this.getActivePairing();
    if (activePairing) this.sendPairingChallenge(socket, activePairing);
  }

  private handleMessage(connection: BridgeConnection, data: unknown): void {
    let parsed: ReturnType<typeof cookieImportClientMessageSchema.parse>;
    try {
      const serialized = rawMessageToString(data);
      assertCookieImportPayloadSize(serialized);
      parsed = cookieImportClientMessageSchema.parse(JSON.parse(serialized));
    } catch {
      connection.socket.close(1008, "Invalid cookie-import protocol message");
      return;
    }

    if (parsed.type === "pair.request") {
      this.handlePairRequest(connection, parsed);
      return;
    }
    if (parsed.type === "hello") {
      this.handleHello(connection, parsed);
      return;
    }
    if (!connection.authenticated || !connection.sourceId) {
      connection.socket.close(1008, "Authentication required");
      return;
    }
    if (parsed.type === "ping") {
      this.send(connection.socket, {
        protocolVersion: COOKIE_IMPORT_PROTOCOL_VERSION,
        type: "pong",
      });
      return;
    }
    if (parsed.type === "request.error") {
      if (parsed.requestId) this.rejectPending(parsed.requestId, connection, parsed.code);
      return;
    }
    const pending = this.pending.get(parsed.requestId);
    if (!pending || pending.connection !== connection) return;
    if (
      (parsed.type === "preview.result" && pending.kind !== "preview") ||
      (parsed.type === "commit.result" && pending.kind !== "commit")
    ) {
      connection.socket.close(1008, "Cookie-import response type mismatch");
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(parsed.requestId);
    if (parsed.type === "preview.result") {
      pending.resolve({ requestId: parsed.requestId, domains: parsed.domains });
    } else {
      try {
        if (!connection.sessionKey) throw new Error("Encrypted cookie session is unavailable.");
        const serialized = decryptCookieImportPayload({
          key: connection.sessionKey,
          iv: parsed.iv,
          ciphertext: parsed.ciphertext,
          aad: `commit.result:${parsed.requestId}`,
        });
        assertCookieImportPayloadSize(serialized);
        const result = cookieImportCommitResultPayloadSchema.parse(JSON.parse(serialized));
        if (result.requestId !== parsed.requestId) {
          throw new Error("Cookie-import response ID mismatch.");
        }
        pending.resolve(result);
      } catch {
        connection.socket.close(1008, "Invalid encrypted cookie payload");
        pending.reject(new Error("Browser-cookie source returned an invalid encrypted payload."));
      }
    }
  }

  private handlePairRequest(
    connection: BridgeConnection,
    message: Extract<
      ReturnType<typeof cookieImportClientMessageSchema.parse>,
      { type: "pair.request" }
    >,
  ): void {
    try {
      const clientTranscript = canonicalCookieImportTranscript([
        "pair.client.v1",
        message.pairingId,
        connection.challenge,
        message.clientNonce,
        message.clientPublicKey,
        message.sourceId,
        message.label,
        message.browserFamily,
        message.extensionVersion,
      ]);
      const accepted = this.options.pairingStore.acceptPairingProof({
        pairingId: message.pairingId,
        connectionChallenge: connection.challenge,
        clientNonce: message.clientNonce,
        proofTranscript: clientTranscript,
        proof: message.proof,
        source: {
          sourceId: message.sourceId,
          label: message.label,
          browserFamily: message.browserFamily,
          extensionVersion: message.extensionVersion,
        },
      });
      const serverKeys = createEphemeralKeyPair();
      const sessionTranscript = canonicalCookieImportTranscript([
        "pair.session.v1",
        message.pairingId,
        connection.challenge,
        message.clientNonce,
        message.clientPublicKey,
        serverKeys.publicKey,
        message.sourceId,
      ]);
      const sessionKey = deriveConnectionKey({
        ecdh: serverKeys.ecdh,
        peerPublicKey: message.clientPublicKey,
        authenticationKey: accepted.pairingKey,
        transcript: sessionTranscript,
      });
      const encryptedToken = encryptCookieImportPayload({
        key: sessionKey,
        plaintext: accepted.token,
        aad: `pair.token:${message.pairingId}:${message.sourceId}`,
      });
      const serverProof = hmacProof(
        accepted.pairingKey,
        canonicalCookieImportTranscript([
          "pair.server.v1",
          sessionTranscript,
          encryptedToken.iv,
          encryptedToken.ciphertext,
        ]),
      );
      this.activePairing = null;
      this.clearPairingExpiryTimer();
      connection.sessionKey = sessionKey;
      this.authenticateConnection(connection, accepted.source);
      this.send(connection.socket, {
        protocolVersion: COOKIE_IMPORT_PROTOCOL_VERSION,
        type: "pair.result",
        sourceId: accepted.source.sourceId,
        serverPublicKey: serverKeys.publicKey,
        proof: serverProof,
        ...encryptedToken,
      });
      this.notifyStateChange();
    } catch {
      this.send(connection.socket, {
        protocolVersion: COOKIE_IMPORT_PROTOCOL_VERSION,
        type: "error",
        code: "pairing_failed",
        message: "Pairing code is invalid, expired, or locked.",
      });
    }
  }

  private handleHello(
    connection: BridgeConnection,
    message: Extract<ReturnType<typeof cookieImportClientMessageSchema.parse>, { type: "hello" }>,
  ): void {
    let nextSessionKey: Buffer | null = null;
    try {
      const clientTranscript = canonicalCookieImportTranscript([
        "hello.client.v1",
        connection.challenge,
        message.clientNonce,
        message.clientPublicKey,
        message.sourceId,
        message.label,
        message.browserFamily,
        message.extensionVersion,
      ]);
      const authenticated = this.options.pairingStore.authenticateProof({
        sourceId: message.sourceId,
        transcript: clientTranscript,
        proof: message.proof,
      });
      if (!authenticated) throw new Error("Invalid pairing proof.");

      const serverKeys = createEphemeralKeyPair();
      const sessionTranscript = canonicalCookieImportTranscript([
        "hello.session.v1",
        connection.challenge,
        message.clientNonce,
        message.clientPublicKey,
        serverKeys.publicKey,
        message.sourceId,
      ]);
      nextSessionKey = deriveConnectionKey({
        ecdh: serverKeys.ecdh,
        peerPublicKey: message.clientPublicKey,
        authenticationKey: authenticated.authenticationKey,
        transcript: sessionTranscript,
      });
      const serverProof = hmacProof(
        authenticated.authenticationKey,
        canonicalCookieImportTranscript(["hello.server.v1", sessionTranscript]),
      );
      this.options.pairingStore.refreshSourceMetadata(message.sourceId, {
        label: message.label,
        browserFamily: message.browserFamily,
        extensionVersion: message.extensionVersion,
      });
      const refreshedSource = this.options.pairingStore
        .listSources()
        .find((source) => source.sourceId === message.sourceId);
      if (!refreshedSource) throw new Error("Pairing not found.");

      connection.sessionKey?.fill(0);
      connection.sessionKey = nextSessionKey;
      nextSessionKey = null;
      this.authenticateConnection(connection, refreshedSource);
      this.send(connection.socket, {
        protocolVersion: COOKIE_IMPORT_PROTOCOL_VERSION,
        type: "hello.result",
        sourceId: refreshedSource.sourceId,
        serverPublicKey: serverKeys.publicKey,
        proof: serverProof,
      });
      this.notifyStateChange();
    } catch {
      nextSessionKey?.fill(0);
      connection.sessionKey?.fill(0);
      connection.sessionKey = null;
      try {
        this.send(connection.socket, {
          protocolVersion: COOKIE_IMPORT_PROTOCOL_VERSION,
          type: "error",
          code: "authentication_failed",
          message: "Pairing is no longer valid. Pair this browser again.",
        });
      } catch {
        // The peer may already have disconnected during authentication.
      }
      connection.socket.close(1008, "Invalid pairing");
    }
  }

  private authenticateConnection(connection: BridgeConnection, source: CookieImportPairedSource) {
    const previous = this.authenticatedBySourceId.get(source.sourceId);
    connection.sourceId = source.sourceId;
    connection.authenticated = true;
    clearTimeout(connection.authenticationTimer);
    this.authenticatedBySourceId.set(source.sourceId, connection);
    if (previous && previous !== connection) previous.socket.close(1008, "Newer connection opened");
  }

  private revokeSourceConnection(sourceId: string): void {
    const connection = this.authenticatedBySourceId.get(sourceId);
    if (!connection) return;
    this.authenticatedBySourceId.delete(sourceId);
    connection.authenticated = false;
    try {
      connection.socket.close(1008, "Pairing revoked");
    } finally {
      this.closeConnection(connection);
    }
  }

  private rejectPending(requestId: string, connection: BridgeConnection, code: string): void {
    const pending = this.pending.get(requestId);
    if (!pending || pending.connection !== connection) return;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.reject(new Error(`Cookie-import extension rejected request (${code}).`));
  }

  private closeConnection(connection: BridgeConnection): void {
    if (!this.connections.delete(connection)) return;
    clearTimeout(connection.authenticationTimer);
    connection.sessionKey?.fill(0);
    connection.sessionKey = null;
    if (
      connection.sourceId &&
      this.authenticatedBySourceId.get(connection.sourceId) === connection
    ) {
      this.authenticatedBySourceId.delete(connection.sourceId);
    }
    for (const [requestId, pending] of this.pending) {
      if (pending.connection !== connection) continue;
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      pending.reject(new Error("Browser-cookie source disconnected."));
    }
    this.notifyStateChange();
  }

  private broadcastPairingChallenge(): void {
    const activePairing = this.getActivePairing();
    if (!activePairing) return;
    for (const connection of this.connections) {
      if (!connection.authenticated) this.sendPairingChallenge(connection.socket, activePairing);
    }
  }

  private getActivePairing(): CookieImportPairingChallenge | null {
    const pairing = this.activePairing;
    if (!pairing || this.now() < pairing.expiresAt) return pairing;
    this.options.pairingStore.cancelPairing(pairing.pairingId);
    this.activePairing = null;
    this.clearPairingExpiryTimer();
    this.notifyStateChange();
    return null;
  }

  private schedulePairingExpiry(): void {
    this.clearPairingExpiryTimer();
    const pairing = this.activePairing;
    if (!pairing) return;
    this.pairingExpiryTimer = setTimeout(
      () => {
        this.pairingExpiryTimer = null;
        if (this.getActivePairing()) this.schedulePairingExpiry();
      },
      Math.max(0, pairing.expiresAt - this.now()),
    );
    this.pairingExpiryTimer.unref?.();
  }

  private clearPairingExpiryTimer(): void {
    if (!this.pairingExpiryTimer) return;
    clearTimeout(this.pairingExpiryTimer);
    this.pairingExpiryTimer = null;
  }

  private sendPairingChallenge(socket: WebSocket, pairing: CookieImportPairingChallenge): void {
    this.send(socket, {
      protocolVersion: COOKIE_IMPORT_PROTOCOL_VERSION,
      type: "pairing.challenge",
      pairingId: pairing.pairingId,
      expiresAt: pairing.expiresAt,
    });
  }

  private send(socket: WebSocket, message: CookieImportServerMessage): void {
    const parsed = cookieImportServerMessageSchema.parse(message);
    const serialized = JSON.stringify(parsed);
    assertCookieImportPayloadSize(serialized);
    socket.send(serialized);
  }

  private notifyStateChange(): void {
    this.options.onStateChange?.();
  }
}
