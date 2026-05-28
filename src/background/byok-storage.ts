// ────────────────────────────────────────────────────────────────────────────
// BYOK key storage — at-rest "light encryption" wrapper around chrome.storage.
//
// Design (approved plan §4):
//  • Per-install 256-bit AES-GCM key stored at INSTALL_KEY_STORAGE (lazy-gen).
//  • The user's Kyma key is stored under BYOK_CIPHER_KEY as {n, c} (nonce + ct).
//  • The legacy plaintext key (under "kymaKey") is migrated one-shot on first
//    load and then removed.
//  • Plaintext only exists in BACKGROUND PROCESS MEMORY (state.kymaKey) and on
//    the wire to the content script over the runtime channel (TLS-equivalent
//    intra-extension). It NEVER sits plaintext in chrome.storage.local.
//
// HONEST SCOPE: this is obfuscation, not cryptographic secrecy — the install
// key sits next to the ciphertext (see src/lib/crypto.ts header). Acceptable
// because the key only ever spends the user's own Kyma credit.
// ────────────────────────────────────────────────────────────────────────────

import {
  bytesToBase64,
  base64ToBytes,
  encryptString,
  decryptString,
  randomBytes,
} from "@/lib/crypto";

/** chrome.storage.local key — the install-wide AES key (base64). */
const INSTALL_KEY_STORAGE = "__echoly_install_kk_v1";
/** chrome.storage.local key — the encrypted BYOK key blob {n, c} (base64). */
const BYOK_CIPHER_KEY = "kymaKey_enc";
/** Legacy plaintext key (pre-Wave-2). Migrated + deleted on first load. */
const BYOK_PLAINTEXT_KEY = "kymaKey";

interface CipherBlob {
  n: string; // base64 nonce
  c: string; // base64 ciphertext (incl. AES-GCM auth tag)
}

/**
 * Get the install-wide AES key, creating it on first use. Stored in
 * chrome.storage.local; survives SW cold starts. The key is 32 bytes of
 * cryptographic randomness; it never leaves the extension.
 */
async function getOrCreateInstallKey(): Promise<Uint8Array> {
  const got = await chrome.storage.local.get(INSTALL_KEY_STORAGE);
  const existing = got[INSTALL_KEY_STORAGE] as string | undefined;
  if (typeof existing === "string" && existing.length > 0) {
    try {
      const bytes = base64ToBytes(existing);
      if (bytes.length === 32) return bytes;
    } catch {
      // Corrupted base64 — fall through to regenerate.
    }
  }
  const fresh = randomBytes(32);
  await chrome.storage.local.set({
    [INSTALL_KEY_STORAGE]: bytesToBase64(fresh),
  });
  return fresh;
}

/**
 * Load the BYOK key (plaintext) into memory.
 *  - If a ciphertext blob exists → decrypt + return.
 *  - Else if a LEGACY plaintext "kymaKey" exists (pre-Wave-2 install) → adopt
 *    it: encrypt it, write the ciphertext blob, delete the plaintext key.
 *  - Else → return "" (no key set).
 * Decryption failure returns "" (treat as "no key" → user re-enters).
 */
export async function loadByokKey(): Promise<string> {
  const got = await chrome.storage.local.get([
    BYOK_CIPHER_KEY,
    BYOK_PLAINTEXT_KEY,
  ]);
  const blob = got[BYOK_CIPHER_KEY] as CipherBlob | undefined;
  const legacyPlain = got[BYOK_PLAINTEXT_KEY] as string | undefined;

  // Migration path: legacy plaintext present + no ciphertext yet.
  if (!blob && typeof legacyPlain === "string" && legacyPlain.trim()) {
    await saveByokKey(legacyPlain);
    return legacyPlain;
  }
  if (!blob) return "";

  try {
    const key = await getOrCreateInstallKey();
    return await decryptString(key, blob.n, blob.c);
  } catch {
    // Tampered ciphertext, wrong install key, or runtime crypto failure.
    // Treat as "no key" — the user just re-enters it. Never throw to callers.
    return "";
  }
}

/**
 * Persist the BYOK key. Empty/whitespace input clears the key (and the legacy
 * field for hygiene). Otherwise encrypt and write the ciphertext blob; the
 * legacy plaintext field is removed on every write so callers can't observe
 * a half-migrated state.
 */
export async function saveByokKey(plain: string): Promise<void> {
  const trimmed = plain.trim();
  if (!trimmed) {
    await chrome.storage.local.remove([BYOK_CIPHER_KEY, BYOK_PLAINTEXT_KEY]);
    return;
  }
  const key = await getOrCreateInstallKey();
  const blob = await encryptString(key, trimmed);
  await chrome.storage.local.set({ [BYOK_CIPHER_KEY]: blob });
  await chrome.storage.local.remove(BYOK_PLAINTEXT_KEY);
}

/** Test-only exports — the storage key names, so tests can poke chrome mock
 *  state without duplicating the strings. Not part of the runtime contract. */
export const __TEST_KEYS = {
  INSTALL_KEY_STORAGE,
  BYOK_CIPHER_KEY,
  BYOK_PLAINTEXT_KEY,
} as const;
