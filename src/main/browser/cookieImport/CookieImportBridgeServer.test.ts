import { createServer } from "node:net";
import { once } from "node:events";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { CookieImportBridgeServer } from "./CookieImportBridgeServer";
import { CookieImportPairingStore } from "./CookieImportPairingStore";
import {
  canonicalCookieImportTranscript,
  createEphemeralKeyPair,
  decryptCookieImportPayload,
  deriveConnectionKey,
  derivePairingKey,
  encryptCookieImportPayload,
  hmacProof,
  proofMatches,
  sha256,
} from "./crypto";

const PAIRING_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const TAMPERED_REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const TOKEN = "test-token-that-never-crosses-the-wire-in-plaintext";

interface WireMessage {
  protocolVersion: number;
  type: string;
  [key: string]: unknown;
}

class MessageQueue {
  private readonly messages: WireMessage[] = [];
  private readonly waiters: Array<(message: WireMessage) => void> = [];

  constructor(socket: WebSocket) {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as WireMessage;
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.messages.push(message);
    });
  }

  async next(type: string): Promise<WireMessage> {
    while (true) {
      const message =
        this.messages.shift() ??
        (await new Promise<WireMessage>((resolve) => this.waiters.push(resolve)));
      if (message.type === type) return message;
    }
  }
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to allocate test port.");
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

function connect(url: string): Promise<{ socket: WebSocket; queue: MessageQueue }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin: "chrome-extension://cookie-import-test" });
    const queue = new MessageQueue(socket);
    socket.once("open", () => resolve({ socket, queue }));
    socket.once("error", reject);
  });
}

describe("CookieImportBridgeServer authenticated transport", () => {
  const bridges: CookieImportBridgeServer[] = [];
  const sockets: WebSocket[] = [];

  afterEach(() => {
    for (const socket of sockets) socket.close();
    for (const bridge of bridges) bridge.dispose();
  });

  it("pairs and reconnects with mutual proof, encrypts values, and rejects tampering", async () => {
    const port = await unusedPort();
    const pairingStore = new CookieImportPairingStore({
      randomId: () => PAIRING_ID,
      randomCode: () => "12345678",
      randomToken: () => TOKEN,
    });
    const bridge = new CookieImportBridgeServer({ pairingStore, ports: [port] });
    bridges.push(bridge);
    const info = await bridge.start();
    const pairing = bridge.beginPairing();

    const { socket: firstSocket, queue: firstQueue } = await connect(info.url);
    sockets.push(firstSocket);
    const connectionChallenge = await firstQueue.next("connection.challenge");
    await firstQueue.next("pairing.challenge");

    const clientKeys = createEphemeralKeyPair();
    const clientNonce = "A".repeat(43);
    const pairingKey = derivePairingKey({
      code: pairing.code,
      pairingId: pairing.pairingId,
      connectionChallenge: String(connectionChallenge.challenge),
      clientNonce,
    });
    const clientTranscript = canonicalCookieImportTranscript([
      "pair.client.v1",
      pairing.pairingId,
      connectionChallenge.challenge,
      clientNonce,
      clientKeys.publicKey,
      SOURCE_ID,
      "Original profile",
      "chrome",
      "1.0.0",
    ]);
    const pairRequest = {
      protocolVersion: 1,
      type: "pair.request",
      pairingId: pairing.pairingId,
      sourceId: SOURCE_ID,
      clientNonce,
      clientPublicKey: clientKeys.publicKey,
      proof: hmacProof(pairingKey, clientTranscript),
      extensionVersion: "1.0.0",
      browserFamily: "chrome",
      label: "Original profile",
    };
    const serializedPairRequest = JSON.stringify(pairRequest);
    expect(serializedPairRequest).not.toContain(pairing.code);
    expect(serializedPairRequest).not.toContain(TOKEN);
    firstSocket.send(serializedPairRequest);

    const pairResult = await firstQueue.next("pair.result");
    const pairSessionTranscript = canonicalCookieImportTranscript([
      "pair.session.v1",
      pairing.pairingId,
      connectionChallenge.challenge,
      clientNonce,
      clientKeys.publicKey,
      pairResult.serverPublicKey,
      SOURCE_ID,
    ]);
    expect(
      proofMatches(
        pairingKey,
        canonicalCookieImportTranscript([
          "pair.server.v1",
          pairSessionTranscript,
          pairResult.iv,
          pairResult.ciphertext,
        ]),
        String(pairResult.proof),
      ),
    ).toBe(true);
    const firstSessionKey = deriveConnectionKey({
      ecdh: clientKeys.ecdh,
      peerPublicKey: String(pairResult.serverPublicKey),
      authenticationKey: pairingKey,
      transcript: pairSessionTranscript,
    });
    expect(
      decryptCookieImportPayload({
        key: firstSessionKey,
        iv: String(pairResult.iv),
        ciphertext: String(pairResult.ciphertext),
        aad: `pair.token:${pairing.pairingId}:${SOURCE_ID}`,
      }),
    ).toBe(TOKEN);
    expect(JSON.stringify(pairResult)).not.toContain(TOKEN);
    firstSocket.close();
    await once(firstSocket, "close");

    const { socket: secondSocket, queue: secondQueue } = await connect(info.url);
    sockets.push(secondSocket);
    const reconnectChallenge = await secondQueue.next("connection.challenge");
    const reconnectKeys = createEphemeralKeyPair();
    const reconnectNonce = "B".repeat(43);
    const authenticationKey = sha256(TOKEN);
    const helloTranscript = canonicalCookieImportTranscript([
      "hello.client.v1",
      reconnectChallenge.challenge,
      reconnectNonce,
      reconnectKeys.publicKey,
      SOURCE_ID,
      "Renamed profile",
      "brave",
      "1.1.0",
    ]);
    const hello = {
      protocolVersion: 1,
      type: "hello",
      sourceId: SOURCE_ID,
      clientNonce: reconnectNonce,
      clientPublicKey: reconnectKeys.publicKey,
      proof: hmacProof(authenticationKey, helloTranscript),
      extensionVersion: "1.1.0",
      browserFamily: "brave",
      label: "Renamed profile",
    };
    expect(JSON.stringify(hello)).not.toContain(TOKEN);
    secondSocket.send(JSON.stringify(hello));

    const helloResult = await secondQueue.next("hello.result");
    const reconnectSessionTranscript = canonicalCookieImportTranscript([
      "hello.session.v1",
      reconnectChallenge.challenge,
      reconnectNonce,
      reconnectKeys.publicKey,
      helloResult.serverPublicKey,
      SOURCE_ID,
    ]);
    expect(
      proofMatches(
        authenticationKey,
        canonicalCookieImportTranscript(["hello.server.v1", reconnectSessionTranscript]),
        String(helloResult.proof),
      ),
    ).toBe(true);
    const reconnectSessionKey = deriveConnectionKey({
      ecdh: reconnectKeys.ecdh,
      peerPublicKey: String(helloResult.serverPublicKey),
      authenticationKey,
      transcript: reconnectSessionTranscript,
    });
    expect(bridge.listSources()).toMatchObject([
      { sourceId: SOURCE_ID, label: "Renamed profile", browserFamily: "brave", connected: true },
    ]);

    const expiresAt = Date.now() + 30_000;
    const previewPromise = bridge.requestPreview({
      requestId: REQUEST_ID,
      sourceId: SOURCE_ID,
      targetUrls: ["https://example.com"],
      expiresAt,
    });
    const previewRequest = await secondQueue.next("preview.request");
    expect(previewRequest).toMatchObject({ requestId: REQUEST_ID, expiresAt });
    secondSocket.send(
      JSON.stringify({
        protocolVersion: 1,
        type: "preview.result",
        requestId: REQUEST_ID,
        domains: [{ domain: "example.com", cookieCount: 1, unsupportedCount: 0 }],
      }),
    );
    await expect(previewPromise).resolves.toMatchObject({ requestId: REQUEST_ID });

    const rawCookieValue = "encrypted-cookie-sentinel";
    const commitPromise = bridge.requestCommit({
      requestId: REQUEST_ID,
      sourceId: SOURCE_ID,
      targetUrls: ["https://example.com"],
      selectedDomains: ["example.com"],
      expiresAt,
    });
    await secondQueue.next("commit.request");
    const encryptedCommit = encryptCookieImportPayload({
      key: reconnectSessionKey,
      plaintext: JSON.stringify({
        requestId: REQUEST_ID,
        cookies: [
          {
            name: "session",
            value: rawCookieValue,
            domain: "example.com",
            hostOnly: true,
            path: "/",
            secure: true,
            httpOnly: true,
            sameSite: "lax",
            session: true,
          },
        ],
      }),
      aad: `commit.result:${REQUEST_ID}`,
    });
    const serializedCommit = JSON.stringify({
      protocolVersion: 1,
      type: "commit.result",
      requestId: REQUEST_ID,
      ...encryptedCommit,
    });
    expect(serializedCommit).not.toContain(rawCookieValue);
    secondSocket.send(serializedCommit);
    await expect(commitPromise).resolves.toMatchObject({
      cookies: [{ value: rawCookieValue }],
    });

    const tamperedPromise = bridge.requestCommit({
      requestId: TAMPERED_REQUEST_ID,
      sourceId: SOURCE_ID,
      targetUrls: ["https://example.com"],
      selectedDomains: ["example.com"],
      expiresAt,
    });
    await secondQueue.next("commit.request");
    const tampered = encryptCookieImportPayload({
      key: reconnectSessionKey,
      plaintext: JSON.stringify({ requestId: TAMPERED_REQUEST_ID, cookies: [] }),
      aad: "commit.result:wrong-request",
    });
    secondSocket.send(
      JSON.stringify({
        protocolVersion: 1,
        type: "commit.result",
        requestId: TAMPERED_REQUEST_ID,
        ...tampered,
      }),
    );
    await expect(tamperedPromise).rejects.toThrow(/invalid encrypted/i);
  });
});
