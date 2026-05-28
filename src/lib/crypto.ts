// ────────────────────────────────────────────────────────────────────────────
// Pure WebCrypto AES-GCM helpers — chrome-free, used by the BYOK key storage.
//
// HONEST SCOPE: "light encryption" / obfuscation-grade. The encryption key is
// stored next to the ciphertext (chrome.storage.local), so anything that can
// read the storage can also derive the plaintext. The goal is to avoid plain
// keys in casual storage dumps + defense-in-depth — NOT cryptographic secrecy
// (a hostile process inside the user's browser can defeat this; that's the
// accepted "mã hóa nhẹ" trade-off, fine because the key only ever spends the
// user's own Kyma credit).
// ────────────────────────────────────────────────────────────────────────────

const ALG = "AES-GCM";
const NONCE_LEN = 12; // 96 bits — AES-GCM default.

/** Cryptographically random byte sequence. */
export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** Standard base64 encode (chrome.storage.local handles JSON, so we use
 *  base64 strings rather than raw Uint8Array). */
export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importAesKey(key: Uint8Array): Promise<CryptoKey> {
  if (key.length !== 32) {
    throw new Error(`AES-GCM install key must be 32 bytes (got ${key.length})`);
  }
  // TS 5.7 DOM lib narrows BufferSource to ArrayBufferView<ArrayBuffer>; raw
  // Uint8Array's backing buffer type is wider. Cast is safe in practice
  // (WebCrypto reads bytes, not the buffer-kind).
  return crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    ALG,
    false,
    ["encrypt", "decrypt"],
  );
}

/** AES-GCM encrypt a UTF-8 string with a 256-bit key. Returns base64-encoded
 *  nonce + ciphertext-with-auth-tag (AES-GCM appends the tag itself). */
export async function encryptString(
  key: Uint8Array,
  plaintext: string,
): Promise<{ n: string; c: string }> {
  const k = await importAesKey(key);
  const nonce = randomBytes(NONCE_LEN);
  const ctBuf = await crypto.subtle.encrypt(
    { name: ALG, iv: nonce as BufferSource },
    k,
    new TextEncoder().encode(plaintext) as BufferSource,
  );
  return { n: bytesToBase64(nonce), c: bytesToBase64(new Uint8Array(ctBuf)) };
}

/** Inverse of encryptString. Throws if the ciphertext is tampered (AES-GCM
 *  auth tag fails). Caller treats throw as "no usable key, force re-entry". */
export async function decryptString(
  key: Uint8Array,
  nonceB64: string,
  ctB64: string,
): Promise<string> {
  const k = await importAesKey(key);
  const nonce = base64ToBytes(nonceB64);
  const ct = base64ToBytes(ctB64);
  const plainBuf = await crypto.subtle.decrypt(
    { name: ALG, iv: nonce as BufferSource },
    k,
    ct as BufferSource,
  );
  return new TextDecoder().decode(plainBuf);
}
