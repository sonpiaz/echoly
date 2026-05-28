// Unit tests for src/lib/crypto.ts — pure WebCrypto AES-GCM helpers.
// Round-trip, tamper detection, key isolation, base64 helpers.

import { describe, it, expect } from "vitest";
import {
  bytesToBase64,
  base64ToBytes,
  encryptString,
  decryptString,
  randomBytes,
} from "@/lib/crypto";

const k1 = new Uint8Array(32).fill(7);
const k2 = new Uint8Array(32).fill(9);

describe("randomBytes", () => {
  it("returns the requested length", () => {
    expect(randomBytes(32).length).toBe(32);
    expect(randomBytes(12).length).toBe(12);
  });
  it("yields different bytes on each call (almost-certainly)", () => {
    const a = bytesToBase64(randomBytes(32));
    const b = bytesToBase64(randomBytes(32));
    expect(a).not.toBe(b);
  });
});

describe("base64 round-trip", () => {
  it("encodes and decodes raw bytes", () => {
    const src = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const decoded = base64ToBytes(bytesToBase64(src));
    expect(Array.from(decoded)).toEqual(Array.from(src));
  });
});

describe("encryptString / decryptString", () => {
  it("round-trips a UTF-8 plaintext", async () => {
    const blob = await encryptString(k1, "kyma-key-abc123");
    expect(blob.n).toBeTypeOf("string");
    expect(blob.c).toBeTypeOf("string");
    const plain = await decryptString(k1, blob.n, blob.c);
    expect(plain).toBe("kyma-key-abc123");
  });

  it("round-trips multi-byte unicode", async () => {
    const msg = "Việt Nam — café — 日本語 — 🔐";
    const { n, c } = await encryptString(k1, msg);
    expect(await decryptString(k1, n, c)).toBe(msg);
  });

  it("uses a fresh nonce per encrypt (same plaintext → different ciphertexts)", async () => {
    const a = await encryptString(k1, "same");
    const b = await encryptString(k1, "same");
    expect(a.n).not.toBe(b.n);
    expect(a.c).not.toBe(b.c);
  });

  it("the wrong key fails to decrypt (auth tag rejects)", async () => {
    const { n, c } = await encryptString(k1, "secret");
    await expect(decryptString(k2, n, c)).rejects.toThrow();
  });

  it("tampered ciphertext fails to decrypt", async () => {
    const { n, c } = await encryptString(k1, "secret");
    const tampered = bytesToBase64(
      base64ToBytes(c).map((b, i) => (i === 0 ? b ^ 0xff : b)) as unknown as Uint8Array,
    );
    await expect(decryptString(k1, n, tampered)).rejects.toThrow();
  });

  it("rejects a wrong-length key with a clear error", async () => {
    const bad = new Uint8Array(16).fill(1);
    await expect(encryptString(bad, "x")).rejects.toThrow(/32 bytes/);
  });
});
