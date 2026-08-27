/**
 * Y Space Cookie Import — MV3 background worker.
 *
 * The loopback socket is untrusted until it proves knowledge of the pairing
 * secret. Pairing codes and long-lived tokens never cross that socket, and
 * raw cookie values only leave this worker inside an authenticated AES-GCM
 * envelope. Permission and request metadata are durable so an MV3 worker
 * restart cannot strand a newly granted origin permission.
 */

const PROTOCOL_VERSION = 1;
const MAX_COOKIES = 750;
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const MAX_ENCRYPTED_PLAINTEXT_BYTES = 3_000_000;
const MAX_TARGETS = 12;
const PAIRING_KDF_ITERATIONS = 310_000;
const HEARTBEAT_INTERVAL_MS = 20_000;
const KEEPALIVE_ALARM = "y-space-cookie-import-keepalive";
const SCAN_DELAY_MS = 250;
const IDLE_RETRY_MS = 4000;
const MANAGED_REQUESTS_KEY = "managedRequests";
const PORTS = [
  ...Array.from({ length: 13 }, (_, index) => 47820 + index),
  ...Array.from({ length: 13 }, (_, index) => 32120 + index),
];

let socket = null;
let connecting = false;
let reconnectTimer = null;
let portIndex = 0;
let lastError = null;
let pairingChallenge = null;
let connectionChallenge = null;
let pendingHandshake = null;
let authenticated = false;
let sessionKey = null;
let managedMutation = Promise.resolve();

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function isSocketOpen() {
  return socket?.readyState === WebSocket.OPEN;
}

function payloadBytes(value) {
  return encoder.encode(value).byteLength;
}

function encodeBase64Url(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function canonicalTranscript(parts) {
  return JSON.stringify(parts);
}

async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function importHmacKey(rawKey) {
  return crypto.subtle.importKey("raw", rawKey, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

async function hmacProof(rawKey, transcript) {
  const key = await importHmacKey(rawKey);
  return encodeBase64Url(await crypto.subtle.sign("HMAC", key, encoder.encode(transcript)));
}

async function verifyHmacProof(rawKey, transcript, proof) {
  try {
    const key = await importHmacKey(rawKey);
    return crypto.subtle.verify("HMAC", key, decodeBase64Url(proof), encoder.encode(transcript));
  } catch {
    return false;
  }
}

async function derivePairingKey(code, pairingId, challenge, clientNonce) {
  const source = await crypto.subtle.importKey("raw", encoder.encode(code), "PBKDF2", false, [
    "deriveBits",
  ]);
  const salt = encoder.encode(
    canonicalTranscript(["y-space-cookie-import-pair-v1", pairingId, challenge, clientNonce]),
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt,
        iterations: PAIRING_KDF_ITERATIONS,
      },
      source,
      256,
    ),
  );
}

async function createEphemeralKeyPair() {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ]);
  const publicKey = encodeBase64Url(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  return { keyPair, publicKey };
}

async function deriveConnectionKey(keyPair, peerPublicKey, authenticationKey, transcript) {
  const importedPeer = await crypto.subtle.importKey(
    "raw",
    decodeBase64Url(peerPublicKey),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: "ECDH", public: importedPeer },
    keyPair.privateKey,
    256,
  );
  const hkdfKey = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: authenticationKey,
      info: encoder.encode(transcript),
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptPayload(key, plaintext, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(aad), tagLength: 128 },
    key,
    encoder.encode(plaintext),
  );
  return { iv: encodeBase64Url(iv), ciphertext: encodeBase64Url(ciphertext) };
}

async function decryptPayload(key, iv, ciphertext, aad) {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: decodeBase64Url(iv),
      additionalData: encoder.encode(aad),
      tagLength: 128,
    },
    key,
    decodeBase64Url(ciphertext),
  );
  return decoder.decode(plaintext);
}

function send(message) {
  if (!isSocketOpen()) throw new Error("Y Space is not connected.");
  const serialized = JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...message });
  if (payloadBytes(serialized) > MAX_PAYLOAD_BYTES) {
    throw new Error("Cookie-import payload exceeds the 4 MiB limit.");
  }
  socket.send(serialized);
}

async function detectBrowserFamily() {
  try {
    if (await navigator.brave?.isBrave?.()) return "brave";
  } catch {
    // Fall through to user-agent detection.
  }
  const userAgent = navigator.userAgent.toLowerCase();
  if (userAgent.includes("edg/")) return "edge";
  if (userAgent.includes("chromium")) return "chromium";
  return "chrome";
}

function defaultProfileLabel(browserFamily) {
  const displayNames = {
    brave: "Brave",
    edge: "Microsoft Edge",
    chromium: "Chromium",
    chrome: "Chrome",
  };
  return `${displayNames[browserFamily] || "Browser"} profile`;
}

async function getIdentity() {
  const stored = await chrome.storage.local.get(["sourceId", "token", "profileLabel"]);
  const sourceId = stored.sourceId || crypto.randomUUID();
  const browserFamily = await detectBrowserFamily();
  const label =
    typeof stored.profileLabel === "string" && stored.profileLabel.trim()
      ? stored.profileLabel.trim().slice(0, 120)
      : defaultProfileLabel(browserFamily);
  const changes = {};
  if (!stored.sourceId) changes.sourceId = sourceId;
  if (!stored.profileLabel) changes.profileLabel = label;
  if (Object.keys(changes).length > 0) await chrome.storage.local.set(changes);
  return {
    sourceId,
    token: typeof stored.token === "string" && stored.token ? stored.token : null,
    extensionVersion: chrome.runtime.getManifest().version,
    browserFamily,
    label,
  };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function loadManagedRequests() {
  const stored = await chrome.storage.local.get([MANAGED_REQUESTS_KEY]);
  const value = stored[MANAGED_REQUESTS_KEY];
  return isRecord(value) ? value : {};
}

function mutateManagedRequests(mutator) {
  const operation = managedMutation.then(async () => {
    const records = await loadManagedRequests();
    const result = await mutator(records);
    await chrome.storage.local.set({ [MANAGED_REQUESTS_KEY]: records });
    return result;
  });
  managedMutation = operation.catch(() => undefined);
  return operation;
}

function normalizeOriginPattern(value) {
  const parsed = new URL(value.replace(/\/\*$/u, "/"));
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Invalid origin pattern.");
  }
  return `${parsed.origin}/*`;
}

async function removeOrigins(origins) {
  const normalized = [...new Set((origins || []).map(normalizeOriginPattern))];
  if (normalized.length === 0) return true;
  try {
    let anyGranted = false;
    for (const origin of normalized) {
      if (await chrome.permissions.contains({ origins: [origin] })) {
        anyGranted = true;
        break;
      }
    }
    if (!anyGranted) return true;
    return await chrome.permissions.remove({ origins: normalized });
  } catch {
    return false;
  }
}

async function releaseManagedRequest(requestId, { retainTombstone = false } = {}) {
  let origins = [];
  await mutateManagedRequests((records) => {
    const record = records[requestId];
    if (!isRecord(record)) return;
    origins = Array.isArray(record.newlyGrantedOrigins) ? record.newlyGrantedOrigins : [];
    record.status = retainTombstone ? "cancelled" : "cleanup";
  });
  if (origins.length === 0) {
    if (!retainTombstone) {
      await mutateManagedRequests((records) => {
        delete records[requestId];
      });
    }
    return;
  }
  const removed = await removeOrigins(origins);
  await mutateManagedRequests((records) => {
    const record = records[requestId];
    if (removed) {
      if (!retainTombstone) delete records[requestId];
      return;
    }
    records[requestId] = {
      ...(isRecord(record) ? record : {}),
      requestId,
      newlyGrantedOrigins: origins,
      status: "cleanup",
      expiresAt: Date.now(),
    };
  });
}

async function releaseAllManagedRequests() {
  const records = await loadManagedRequests();
  for (const requestId of Object.keys(records)) {
    await releaseManagedRequest(requestId);
  }
}

async function connect() {
  if (isSocketOpen() || connecting) return;
  connecting = true;
  const port = PORTS[portIndex % PORTS.length];
  let candidate;
  try {
    candidate = new WebSocket(`ws://127.0.0.1:${port}/cookie-import`);
  } catch (error) {
    connecting = false;
    lastError = String(error);
    scheduleReconnect();
    return;
  }
  socket = candidate;

  candidate.addEventListener("open", () => {
    if (socket !== candidate) return;
    connecting = false;
    portIndex = 0;
    lastError = null;
    authenticated = false;
    connectionChallenge = null;
    pendingHandshake = null;
    sessionKey = null;
    void broadcastStatus();
  });

  candidate.addEventListener("message", (event) => {
    void handleServerMessage(event.data);
  });

  candidate.addEventListener("close", () => {
    if (socket === candidate) socket = null;
    connecting = false;
    authenticated = false;
    connectionChallenge = null;
    pendingHandshake = null;
    sessionKey = null;
    portIndex += 1;
    void releaseAllManagedRequests();
    void broadcastStatus();
    scheduleReconnect();
  });

  candidate.addEventListener("error", () => {
    lastError = "Looking for Y Space…";
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = portIndex < PORTS.length ? SCAN_DELAY_MS : IDLE_RETRY_MS;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

function hasOnlyKeys(message, keys) {
  const allowed = new Set(keys);
  return Object.keys(message).every((key) => allowed.has(key));
}

function parseServerMessage(raw) {
  const serialized = typeof raw === "string" ? raw : String(raw);
  if (payloadBytes(serialized) > MAX_PAYLOAD_BYTES) throw new Error("Message is too large.");
  const message = JSON.parse(serialized);
  if (!isRecord(message) || message.protocolVersion !== PROTOCOL_VERSION || !message.type) {
    throw new Error("Invalid cookie-import message.");
  }
  const allowedKeys = {
    "connection.challenge": ["protocolVersion", "type", "challenge"],
    "pairing.challenge": ["protocolVersion", "type", "pairingId", "expiresAt"],
    "pair.result": [
      "protocolVersion",
      "type",
      "sourceId",
      "serverPublicKey",
      "proof",
      "iv",
      "ciphertext",
    ],
    "hello.result": ["protocolVersion", "type", "sourceId", "serverPublicKey", "proof"],
    "preview.request": ["protocolVersion", "type", "requestId", "targetUrls", "expiresAt"],
    "commit.request": [
      "protocolVersion",
      "type",
      "requestId",
      "targetUrls",
      "selectedDomains",
      "expiresAt",
    ],
    "cancel.request": ["protocolVersion", "type", "requestId"],
    error: ["protocolVersion", "type", "code", "message"],
    pong: ["protocolVersion", "type"],
  };
  const keys = allowedKeys[message.type];
  if (!keys || !hasOnlyKeys(message, keys)) throw new Error("Unsupported cookie-import message.");
  return message;
}

async function handleServerMessage(raw) {
  let message;
  try {
    message = parseServerMessage(raw);
  } catch {
    socket?.close(1008, "Invalid cookie-import protocol message");
    return;
  }

  try {
    switch (message.type) {
      case "connection.challenge":
        await acceptConnectionChallenge(message);
        return;
      case "pairing.challenge":
        acceptPairingChallenge(message);
        return;
      case "pair.result":
        await acceptPairResult(message);
        return;
      case "hello.result":
        await acceptHelloResult(message);
        return;
      case "preview.request":
        requireAuthenticatedSession();
        await preparePreview(message);
        return;
      case "commit.request":
        requireAuthenticatedSession();
        await commitCookies(message);
        return;
      case "cancel.request":
        requireAuthenticatedSession();
        await cancelRequest(message.requestId);
        return;
      case "error":
        pendingHandshake = null;
        if (message.code === "authentication_failed") {
          await chrome.storage.local.remove(["token"]);
          authenticated = false;
          sessionKey = null;
        }
        lastError =
          typeof message.message === "string" ? message.message : "Y Space rejected the request.";
        void broadcastStatus();
        return;
      case "pong":
        return;
    }
  } catch {
    socket?.close(1008, "Cookie-import authentication or request validation failed");
  }
}

async function acceptConnectionChallenge(message) {
  if (connectionChallenge || !/^[A-Za-z\d_-]{43}$/u.test(message.challenge)) {
    throw new Error("Invalid connection challenge.");
  }
  connectionChallenge = message.challenge;
  const identity = await getIdentity();
  if (identity.token) await beginHello(identity);
  void broadcastStatus();
}

function acceptPairingChallenge(message) {
  if (
    typeof message.pairingId !== "string" ||
    typeof message.expiresAt !== "number" ||
    message.expiresAt <= Date.now()
  ) {
    throw new Error("Invalid pairing challenge.");
  }
  pairingChallenge = { pairingId: message.pairingId, expiresAt: message.expiresAt };
  void broadcastStatus();
}

async function beginHello(identity) {
  if (!connectionChallenge || !identity.token || pendingHandshake) return;
  const authenticationKey = await sha256(identity.token);
  const clientNonce = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const { keyPair, publicKey } = await createEphemeralKeyPair();
  const transcript = canonicalTranscript([
    "hello.client.v1",
    connectionChallenge,
    clientNonce,
    publicKey,
    identity.sourceId,
    identity.label,
    identity.browserFamily,
    identity.extensionVersion,
  ]);
  const proof = await hmacProof(authenticationKey, transcript);
  pendingHandshake = {
    kind: "hello",
    challenge: connectionChallenge,
    clientNonce,
    clientPublicKey: publicKey,
    keyPair,
    authenticationKey,
    sourceId: identity.sourceId,
  };
  send({
    type: "hello",
    sourceId: identity.sourceId,
    clientNonce,
    clientPublicKey: publicKey,
    proof,
    extensionVersion: identity.extensionVersion,
    browserFamily: identity.browserFamily,
    label: identity.label,
  });
}

async function acceptHelloResult(message) {
  const pending = pendingHandshake;
  if (
    pending?.kind !== "hello" ||
    message.sourceId !== pending.sourceId ||
    !/^[A-Za-z\d_-]{87}$/u.test(message.serverPublicKey)
  ) {
    throw new Error("Unexpected hello result.");
  }
  const transcript = canonicalTranscript([
    "hello.session.v1",
    pending.challenge,
    pending.clientNonce,
    pending.clientPublicKey,
    message.serverPublicKey,
    pending.sourceId,
  ]);
  const valid = await verifyHmacProof(
    pending.authenticationKey,
    canonicalTranscript(["hello.server.v1", transcript]),
    message.proof,
  );
  if (!valid) throw new Error("Y Space did not prove the saved pairing.");
  sessionKey = await deriveConnectionKey(
    pending.keyPair,
    message.serverPublicKey,
    pending.authenticationKey,
    transcript,
  );
  pendingHandshake = null;
  authenticated = true;
  pairingChallenge = null;
  lastError = null;
  void broadcastStatus();
}

async function acceptPairResult(message) {
  const pending = pendingHandshake;
  if (
    pending?.kind !== "pair" ||
    message.sourceId !== pending.sourceId ||
    !/^[A-Za-z\d_-]{87}$/u.test(message.serverPublicKey)
  ) {
    throw new Error("Unexpected pairing result.");
  }
  const transcript = canonicalTranscript([
    "pair.session.v1",
    pending.pairingId,
    pending.challenge,
    pending.clientNonce,
    pending.clientPublicKey,
    message.serverPublicKey,
    pending.sourceId,
  ]);
  const proofTranscript = canonicalTranscript([
    "pair.server.v1",
    transcript,
    message.iv,
    message.ciphertext,
  ]);
  if (!(await verifyHmacProof(pending.pairingKey, proofTranscript, message.proof))) {
    throw new Error("Y Space did not prove the pairing code.");
  }
  const derivedSessionKey = await deriveConnectionKey(
    pending.keyPair,
    message.serverPublicKey,
    pending.pairingKey,
    transcript,
  );
  const token = await decryptPayload(
    derivedSessionKey,
    message.iv,
    message.ciphertext,
    `pair.token:${pending.pairingId}:${pending.sourceId}`,
  );
  if (!/^[A-Za-z\d_-]{20,200}$/u.test(token)) throw new Error("Invalid encrypted pairing token.");
  await chrome.storage.local.set({ token });
  sessionKey = derivedSessionKey;
  pendingHandshake = null;
  authenticated = true;
  pairingChallenge = null;
  lastError = null;
  void broadcastStatus();
}

function requireAuthenticatedSession() {
  if (!authenticated || !sessionKey) throw new Error("Authenticated cookie session required.");
}

function validateTargetUrls(targetUrls) {
  if (!Array.isArray(targetUrls) || targetUrls.length < 1 || targetUrls.length > MAX_TARGETS) {
    throw new Error("Cookie import requires one to twelve target origins.");
  }
  return targetUrls.map((target) => {
    const url = new URL(target);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      (url.pathname !== "/" && url.pathname !== "") ||
      url.search ||
      url.hash
    ) {
      throw new Error("Cookie import target must be an exact HTTP(S) origin.");
    }
    return url.origin;
  });
}

function originsForTargets(targetUrls) {
  return [...new Set(targetUrls.map((target) => `${new URL(target).origin}/*`))];
}

async function missingOrigins(origins) {
  const missing = [];
  for (const origin of origins) {
    if (!(await chrome.permissions.contains({ origins: [origin] }))) missing.push(origin);
  }
  return missing;
}

function requireFutureDeadline(expiresAt) {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
    throw new Error("Cookie-import request has expired.");
  }
}

async function preparePreview(message) {
  try {
    requireFutureDeadline(message.expiresAt);
    const targetUrls = validateTargetUrls(message.targetUrls);
    const origins = originsForTargets(targetUrls);
    const newlyGrantedOrigins = await missingOrigins(origins);
    await mutateManagedRequests((records) => {
      if (records[message.requestId]) throw new Error("Cookie-import request ID was reused.");
      records[message.requestId] = {
        requestId: message.requestId,
        targetUrls,
        previewDomains: [],
        newlyGrantedOrigins,
        expiresAt: message.expiresAt,
        status: newlyGrantedOrigins.length > 0 ? "awaiting-permission" : "previewing",
      };
    });
    if (newlyGrantedOrigins.length > 0) {
      await chrome.action.setBadgeBackgroundColor({ color: "#e59b34" });
      await chrome.action.setBadgeText({ text: "!" });
      void broadcastStatus();
      return;
    }
    await previewCookies(message.requestId);
  } catch {
    sendRequestError(message.requestId, "invalid_target", "Cookie-import targets are invalid.");
    await releaseManagedRequest(message.requestId);
  }
}

async function resumePreviewAfterPermission(requestId, granted, origins) {
  const receivedOrigins = [...new Set((origins || []).map(normalizeOriginPattern))].sort();
  const records = await loadManagedRequests();
  const record = records[requestId];
  if (!isRecord(record)) {
    if (granted) await removeOrigins(receivedOrigins);
    return;
  }
  const expectedOrigins = [...(record.newlyGrantedOrigins || [])].sort();
  if (JSON.stringify(expectedOrigins) !== JSON.stringify(receivedOrigins)) {
    if (granted) await removeOrigins(receivedOrigins);
    throw new Error("Permission response did not match the pending request.");
  }
  if (record.status !== "awaiting-permission" || Date.now() >= record.expiresAt) {
    await removeOrigins(expectedOrigins);
    await releaseManagedRequest(requestId);
    return;
  }
  if (!granted || (await missingOrigins(expectedOrigins)).length > 0) {
    sendRequestError(requestId, "permission_denied", "Origin permission was not granted.");
    await releaseManagedRequest(requestId);
    await chrome.action.setBadgeText({ text: "" });
    void broadcastStatus();
    return;
  }
  await mutateManagedRequests((managedRequests) => {
    const current = managedRequests[requestId];
    if (!isRecord(current) || current.status !== "awaiting-permission") {
      throw new Error("Cookie-import permission request is no longer active.");
    }
    current.status = "previewing";
  });
  await chrome.action.setBadgeText({ text: "" });
  await previewCookies(requestId);
}

function cookieKey(cookie) {
  const partition = cookie.partitionKey?.topLevelSite || "";
  return `${cookie.storeId || ""}\u0000${cookie.name}\u0000${cookie.domain}\u0000${cookie.path}\u0000${partition}`;
}

async function collectCookies(targetUrls) {
  const unique = new Map();
  for (const targetUrl of targetUrls) {
    const cookies = await chrome.cookies.getAll({ url: targetUrl });
    for (const cookie of cookies) {
      unique.set(cookieKey(cookie), cookie);
      if (unique.size > MAX_COOKIES) throw new Error("Cookie count limit exceeded.");
    }
  }
  return [...unique.values()];
}

function normalizedCookieDomain(cookie) {
  return cookie.domain.replace(/^\.+/u, "").toLowerCase();
}

async function previewCookies(requestId) {
  try {
    const records = await loadManagedRequests();
    const record = records[requestId];
    if (!isRecord(record) || record.status !== "previewing") {
      throw new Error("Cookie preview is no longer active.");
    }
    requireFutureDeadline(record.expiresAt);
    const cookies = await collectCookies(record.targetUrls);
    const byDomain = new Map();
    for (const cookie of cookies) {
      const domain = normalizedCookieDomain(cookie);
      const summary = byDomain.get(domain) || { domain, cookieCount: 0, unsupportedCount: 0 };
      if (cookie.partitionKey) summary.unsupportedCount += 1;
      else summary.cookieCount += 1;
      byDomain.set(domain, summary);
    }
    const domains = [...byDomain.values()].sort((left, right) =>
      left.domain.localeCompare(right.domain),
    );
    await mutateManagedRequests((managedRequests) => {
      const current = managedRequests[requestId];
      if (!isRecord(current) || current.status !== "previewing") {
        throw new Error("Cookie preview was cancelled.");
      }
      current.previewDomains = domains.map(({ domain }) => domain);
      current.status = "ready";
    });
    send({ type: "preview.result", requestId, domains });
    void broadcastStatus();
  } catch {
    sendRequestError(requestId, "preview_failed", "Unable to inspect cookies.");
    await releaseManagedRequest(requestId);
  }
}

function toWireCookie(cookie) {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    hostOnly: cookie.hostOnly,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    session: cookie.session,
    ...(typeof cookie.expirationDate === "number" ? { expirationDate: cookie.expirationDate } : {}),
    ...(typeof cookie.storeId === "string" ? { storeId: cookie.storeId } : {}),
    ...(cookie.partitionKey
      ? {
          partitionKey: {
            topLevelSite: cookie.partitionKey.topLevelSite,
            ...(typeof cookie.partitionKey.hasCrossSiteAncestor === "boolean"
              ? { hasCrossSiteAncestor: cookie.partitionKey.hasCrossSiteAncestor }
              : {}),
          },
        }
      : {}),
  };
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function commitCookies(message) {
  try {
    requireFutureDeadline(message.expiresAt);
    const targetUrls = validateTargetUrls(message.targetUrls);
    const records = await loadManagedRequests();
    const record = records[message.requestId];
    if (
      !isRecord(record) ||
      record.status !== "ready" ||
      record.expiresAt !== message.expiresAt ||
      !arraysEqual(record.targetUrls, targetUrls)
    ) {
      throw new Error("Commit does not match its cookie preview.");
    }
    if (!Array.isArray(message.selectedDomains) || message.selectedDomains.length > MAX_COOKIES) {
      throw new Error("Invalid domain selection.");
    }
    const previewDomains = new Set(record.previewDomains);
    const selected = new Set(
      message.selectedDomains.map((domain) => String(domain).replace(/^\.+/u, "").toLowerCase()),
    );
    for (const domain of selected) {
      if (!previewDomains.has(domain)) throw new Error("Domain was not present in the preview.");
    }
    const origins = originsForTargets(targetUrls);
    if ((await missingOrigins(origins)).length > 0)
      throw new Error("Origin permission is missing.");
    await mutateManagedRequests((managedRequests) => {
      const current = managedRequests[message.requestId];
      if (!isRecord(current) || current.status !== "ready") {
        throw new Error("Cookie-import commit was already consumed.");
      }
      current.status = "committing";
    });
    const cookies = (await collectCookies(targetUrls))
      .filter((cookie) => selected.has(normalizedCookieDomain(cookie)))
      .map(toWireCookie);
    const serialized = JSON.stringify({ requestId: message.requestId, cookies });
    if (payloadBytes(serialized) > MAX_ENCRYPTED_PLAINTEXT_BYTES) {
      throw new Error("Encrypted cookie export exceeds the payload limit.");
    }
    requireAuthenticatedSession();
    const encrypted = await encryptPayload(
      sessionKey,
      serialized,
      `commit.result:${message.requestId}`,
    );
    send({ type: "commit.result", requestId: message.requestId, ...encrypted });
  } catch {
    sendRequestError(message.requestId, "commit_failed", "Unable to export selected cookies.");
  } finally {
    await releaseManagedRequest(message.requestId);
    void broadcastStatus();
  }
}

function sendRequestError(requestId, code, message) {
  try {
    send({ type: "request.error", requestId, code, message });
  } catch {
    // The socket is already gone; raw cookie data is never persisted for a retry.
  }
}

async function cancelRequest(requestId) {
  const records = await loadManagedRequests();
  const record = records[requestId];
  const retainTombstone = isRecord(record) && record.status === "awaiting-permission";
  await releaseManagedRequest(requestId, { retainTombstone });
  await chrome.action.setBadgeText({ text: "" });
  void broadcastStatus();
}

async function submitPairingCode(code) {
  if (
    !pairingChallenge ||
    !connectionChallenge ||
    pairingChallenge.expiresAt <= Date.now() ||
    !/^\d{8}$/u.test(code) ||
    !isSocketOpen() ||
    pendingHandshake
  ) {
    throw new Error("Enter the active eight-digit pairing code from Y Space.");
  }
  const identity = await getIdentity();
  const clientNonce = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const { keyPair, publicKey } = await createEphemeralKeyPair();
  const pairingKey = await derivePairingKey(
    code,
    pairingChallenge.pairingId,
    connectionChallenge,
    clientNonce,
  );
  const transcript = canonicalTranscript([
    "pair.client.v1",
    pairingChallenge.pairingId,
    connectionChallenge,
    clientNonce,
    publicKey,
    identity.sourceId,
    identity.label,
    identity.browserFamily,
    identity.extensionVersion,
  ]);
  const proof = await hmacProof(pairingKey, transcript);
  pendingHandshake = {
    kind: "pair",
    pairingId: pairingChallenge.pairingId,
    challenge: connectionChallenge,
    clientNonce,
    clientPublicKey: publicKey,
    keyPair,
    pairingKey,
    sourceId: identity.sourceId,
  };
  send({
    type: "pair.request",
    pairingId: pairingChallenge.pairingId,
    sourceId: identity.sourceId,
    clientNonce,
    clientPublicKey: publicKey,
    proof,
    extensionVersion: identity.extensionVersion,
    browserFamily: identity.browserFamily,
    label: identity.label,
  });
}

async function setProfileLabel(label) {
  const normalized = String(label || "").trim();
  if (!normalized || normalized.length > 120) {
    throw new Error("Profile name must be between 1 and 120 characters.");
  }
  await chrome.storage.local.set({ profileLabel: normalized });
  if (isSocketOpen()) socket.close(1000, "Profile label changed");
  void broadcastStatus();
}

async function forgetPairing() {
  await chrome.storage.local.remove(["token"]);
  pairingChallenge = null;
  pendingHandshake = null;
  sessionKey = null;
  authenticated = false;
  lastError = null;
  await releaseAllManagedRequests();
  socket?.close(1000, "Pairing forgotten");
  void broadcastStatus();
}

async function currentPendingPermission() {
  const records = await loadManagedRequests();
  return Object.values(records)
    .filter(
      (record) =>
        isRecord(record) &&
        record.status === "awaiting-permission" &&
        Number(record.expiresAt) > Date.now(),
    )
    .sort((left, right) => left.expiresAt - right.expiresAt)[0];
}

async function getStatus() {
  const identity = await getIdentity();
  const permission = await currentPendingPermission();
  return {
    connected: isSocketOpen() && authenticated,
    connecting,
    paired: Boolean(identity.token),
    pairingAvailable: Boolean(pairingChallenge && pairingChallenge.expiresAt > Date.now()),
    pairingExpiresAt: pairingChallenge?.expiresAt || null,
    pendingRequestId: permission?.requestId || null,
    pendingOrigins: permission ? [...permission.newlyGrantedOrigins] : [],
    profileLabel: identity.label,
    browserFamily: identity.browserFamily,
    lastError,
    version: identity.extensionVersion,
  };
}

async function broadcastStatus() {
  const status = await getStatus();
  try {
    await chrome.runtime.sendMessage({ event: "status", status });
  } catch {
    // No popup is open.
  }
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  void (async () => {
    switch (message?.cmd) {
      case "getStatus":
        return getStatus();
      case "pair":
        await submitPairingCode(String(message.code || ""));
        return { ok: true };
      case "permissionResult":
        await resumePreviewAfterPermission(
          String(message.requestId || ""),
          Boolean(message.granted),
          message.origins,
        );
        return { ok: true };
      case "setProfileLabel":
        await setProfileLabel(message.label);
        return { ok: true };
      case "forgetPairing":
        await forgetPairing();
        return { ok: true };
      default:
        return { ok: false, error: "Unsupported extension request." };
    }
  })()
    .then(respond)
    .catch((error) => respond({ ok: false, error: String(error?.message || error) }));
  return true;
});

function runHeartbeat() {
  if (isSocketOpen() && authenticated) {
    try {
      send({ type: "ping" });
    } catch {
      socket?.close();
    }
  } else {
    void connect();
  }
  void releaseExpiredRequests();
}

async function releaseExpiredRequests() {
  const records = await loadManagedRequests();
  const now = Date.now();
  for (const [requestId, record] of Object.entries(records)) {
    if (!isRecord(record) || record.status === "cleanup" || Number(record.expiresAt) <= now) {
      await releaseManagedRequest(requestId);
    }
  }
}

function cleanUpAndConnect() {
  void (async () => {
    await releaseAllManagedRequests();
    await connect();
  })();
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  cleanUpAndConnect();
});
chrome.runtime.onStartup.addListener(cleanUpAndConnect);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) runHeartbeat();
});

setInterval(runHeartbeat, HEARTBEAT_INTERVAL_MS);
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
cleanUpAndConnect();
