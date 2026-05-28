// Unit tests for src/background/byok-storage.ts — the at-rest encryption
// wrapper around chrome.storage.local for the BYOK key.
//
// Verifies: save+load round-trip, empty input clears storage, the legacy
// plaintext `kymaKey` field is migrated to encrypted on first load and then
// removed, and a tampered ciphertext returns "" (defense-in-depth).

import { describe, it, expect, beforeEach } from "vitest";
import { resetChrome, type FakeChrome } from "../setup";
import {
  loadByokKey,
  saveByokKey,
  __TEST_KEYS,
} from "@/background/byok-storage";

let chromeFake: FakeChrome;

beforeEach(() => {
  chromeFake = resetChrome();
});

describe("byok-storage — save / load round-trip", () => {
  it("encrypts at rest then decrypts back on load", async () => {
    await saveByokKey("kyma_secret_xyz");
    // Storage should NOT contain plaintext under "kymaKey":
    const store = chromeFake.storage.local._data;
    expect(store[__TEST_KEYS.BYOK_PLAINTEXT_KEY]).toBeUndefined();
    // Should contain an install key + a cipher blob {n,c}:
    expect(typeof store[__TEST_KEYS.INSTALL_KEY_STORAGE]).toBe("string");
    const blob = store[__TEST_KEYS.BYOK_CIPHER_KEY] as { n: string; c: string };
    expect(blob).toMatchObject({ n: expect.any(String), c: expect.any(String) });
    // None of these stored fields should contain the plaintext literal:
    const dump = JSON.stringify(store);
    expect(dump.includes("kyma_secret_xyz")).toBe(false);

    expect(await loadByokKey()).toBe("kyma_secret_xyz");
  });

  it("trims whitespace on save", async () => {
    await saveByokKey("   trimmed-key   ");
    expect(await loadByokKey()).toBe("trimmed-key");
  });

  it("empty / whitespace-only input clears storage", async () => {
    await saveByokKey("real-key");
    expect(await loadByokKey()).toBe("real-key");
    await saveByokKey("   ");
    const store = chromeFake.storage.local._data;
    expect(store[__TEST_KEYS.BYOK_CIPHER_KEY]).toBeUndefined();
    expect(store[__TEST_KEYS.BYOK_PLAINTEXT_KEY]).toBeUndefined();
    expect(await loadByokKey()).toBe("");
  });

  it("returns empty string when no key has ever been set", async () => {
    expect(await loadByokKey()).toBe("");
  });
});

describe("byok-storage — legacy plaintext migration", () => {
  it("adopts a legacy plaintext kymaKey on first load and removes it", async () => {
    // Simulate a pre-Wave-2 install: plaintext key sitting in storage.
    chromeFake.storage.local._data[__TEST_KEYS.BYOK_PLAINTEXT_KEY] = "legacy-plain";
    expect(await loadByokKey()).toBe("legacy-plain");

    const store = chromeFake.storage.local._data;
    // Plaintext field gone, ciphertext written.
    expect(store[__TEST_KEYS.BYOK_PLAINTEXT_KEY]).toBeUndefined();
    expect(store[__TEST_KEYS.BYOK_CIPHER_KEY]).toBeDefined();
    // Subsequent load decrypts the migrated key.
    expect(await loadByokKey()).toBe("legacy-plain");
  });

  it("does not adopt empty/whitespace plaintext", async () => {
    chromeFake.storage.local._data[__TEST_KEYS.BYOK_PLAINTEXT_KEY] = "   ";
    expect(await loadByokKey()).toBe("");
    // No ciphertext written, plaintext untouched (it's empty either way).
    expect(
      chromeFake.storage.local._data[__TEST_KEYS.BYOK_CIPHER_KEY],
    ).toBeUndefined();
  });
});

describe("byok-storage — corrupted ciphertext", () => {
  it("returns empty string when the ciphertext is tampered (treat as no key)", async () => {
    await saveByokKey("real-key");
    const blob = chromeFake.storage.local._data[
      __TEST_KEYS.BYOK_CIPHER_KEY
    ] as { n: string; c: string };
    // Flip the first character of the base64 ciphertext to corrupt the AES-GCM
    // auth tag (which is appended to the ciphertext) — decryption will throw.
    const flippedChar = blob.c[0] === "A" ? "B" : "A";
    chromeFake.storage.local._data[__TEST_KEYS.BYOK_CIPHER_KEY] = {
      n: blob.n,
      c: flippedChar + blob.c.slice(1),
    };
    expect(await loadByokKey()).toBe("");
  });
});
