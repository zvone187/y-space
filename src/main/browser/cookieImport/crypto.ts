import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  createHmac,
  hkdfSync,
  pbkdf2Sync,
  randomBytes,
  timingSafeEqual,
  type ECDH,
} from "node:crypto";

export const COOKIE_IMPORT_PAIRING_KDF_ITERATIONS = 310_000;

export function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

export function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

export function canonicalCookieImportTranscript(parts: readonly unknown[]): string {
  return JSON.stringify(parts);
}

export function sha256(value: string | Uint8Array): Buffer {
  return createHash("sha256").update(value).digest();
}

export function derivePairingKey(input: {
  code: string;
  pairingId: string;
  connectionChallenge: string;
  clientNonce: string;
}): Buffer {
  const salt = canonicalCookieImportTranscript([
    "y-space-cookie-import-pair-v1",
    input.pairingId,
    input.connectionChallenge,
    input.clientNonce,
  ]);
  return pbkdf2Sync(input.code, salt, COOKIE_IMPORT_PAIRING_KDF_ITERATIONS, 32, "sha256");
}

export function hmacProof(key: Uint8Array, transcript: string): string {
  return createHmac("sha256", key).update(transcript).digest("base64url");
}

export function proofMatches(key: Uint8Array, transcript: string, proof: string): boolean {
  const expected = createHmac("sha256", key).update(transcript).digest();
  const received = decodeBase64Url(proof);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function createEphemeralKeyPair(): { ecdh: ECDH; publicKey: string } {
  const ecdh = createECDH("prime256v1");
  const publicKey = encodeBase64Url(ecdh.generateKeys());
  return { ecdh, publicKey };
}

export function deriveConnectionKey(input: {
  ecdh: ECDH;
  peerPublicKey: string;
  authenticationKey: Uint8Array;
  transcript: string;
}): Buffer {
  const sharedSecret = input.ecdh.computeSecret(decodeBase64Url(input.peerPublicKey));
  return Buffer.from(
    hkdfSync(
      "sha256",
      sharedSecret,
      input.authenticationKey,
      Buffer.from(input.transcript, "utf8"),
      32,
    ),
  );
}

export function encryptCookieImportPayload(input: {
  key: Uint8Array;
  plaintext: string;
  aad: string;
}): { iv: string; ciphertext: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", input.key, iv);
  cipher.setAAD(Buffer.from(input.aad, "utf8"));
  const encrypted = Buffer.concat([cipher.update(input.plaintext, "utf8"), cipher.final()]);
  return {
    iv: encodeBase64Url(iv),
    ciphertext: encodeBase64Url(Buffer.concat([encrypted, cipher.getAuthTag()])),
  };
}

export function decryptCookieImportPayload(input: {
  key: Uint8Array;
  iv: string;
  ciphertext: string;
  aad: string;
}): string {
  const encryptedWithTag = decodeBase64Url(input.ciphertext);
  if (encryptedWithTag.length < 16) throw new Error("Encrypted cookie payload is invalid.");
  const encrypted = encryptedWithTag.subarray(0, -16);
  const tag = encryptedWithTag.subarray(-16);
  const decipher = createDecipheriv("aes-256-gcm", input.key, decodeBase64Url(input.iv));
  decipher.setAAD(Buffer.from(input.aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
