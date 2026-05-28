// Unit tests for src/background/guest-policy.ts — the fetcher with TTL cache
// and safe default fallback. Mocks global fetch; verifies behavior on success,
// HTTP failure, malformed payload, network error, and cache hits.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  fetchGuestPolicy,
  invalidateGuestPolicy,
} from "@/background/guest-policy";
import { DEFAULT_GUEST_LANGUAGE_POLICY } from "@/shared/types";
import { ECHOLY_GUEST_CONFIG_URL } from "@/shared/constants";

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  invalidateGuestPolicy();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchGuestPolicy — success", () => {
  it("returns the validated policy from a well-formed response", async () => {
    const policy = {
      allowedSource: ["en", "es"],
      allowedTarget: ["vi", "fr"],
      defaults: { source: "en", target: "vi" },
    };
    const fetchSpy = vi.fn().mockResolvedValue(okResponse({ ok: true, policy }));
    vi.stubGlobal("fetch", fetchSpy);
    const got = await fetchGuestPolicy();
    expect(got).toEqual(policy);
    expect(fetchSpy).toHaveBeenCalledWith(
      ECHOLY_GUEST_CONFIG_URL,
      expect.objectContaining({ method: "GET", credentials: "omit" }),
    );
  });

  it("caches within TTL — second call does NOT hit the network", async () => {
    const policy = {
      allowedSource: ["en"],
      allowedTarget: ["vi"],
      defaults: { source: "en", target: "vi" },
    };
    const fetchSpy = vi.fn().mockResolvedValue(okResponse({ ok: true, policy }));
    vi.stubGlobal("fetch", fetchSpy);
    await fetchGuestPolicy();
    await fetchGuestPolicy();
    await fetchGuestPolicy();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("invalidateGuestPolicy() forces a re-fetch", async () => {
    const policy = {
      allowedSource: ["en"],
      allowedTarget: ["vi"],
      defaults: { source: "en", target: "vi" },
    };
    const fetchSpy = vi.fn().mockResolvedValue(okResponse({ ok: true, policy }));
    vi.stubGlobal("fetch", fetchSpy);
    await fetchGuestPolicy();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    invalidateGuestPolicy();
    await fetchGuestPolicy();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("fetchGuestPolicy — failure modes (always returns DEFAULT)", () => {
  it("non-2xx response → default", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("oops", { status: 500 })),
    );
    expect(await fetchGuestPolicy()).toEqual(DEFAULT_GUEST_LANGUAGE_POLICY);
  });

  it("malformed JSON body → default", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("not json", { status: 200 })),
    );
    expect(await fetchGuestPolicy()).toEqual(DEFAULT_GUEST_LANGUAGE_POLICY);
  });

  it("invalid shape (defaults outside allowed) → default", async () => {
    const bad = {
      allowedSource: ["en"],
      allowedTarget: ["vi"],
      defaults: { source: "ja", target: "vi" }, // ja not allowed
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(okResponse({ ok: true, policy: bad })),
    );
    expect(await fetchGuestPolicy()).toEqual(DEFAULT_GUEST_LANGUAGE_POLICY);
  });

  it("network error → default (and does NOT poison the cache)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValueOnce(new TypeError("net down")),
    );
    expect(await fetchGuestPolicy()).toEqual(DEFAULT_GUEST_LANGUAGE_POLICY);
    // Next call should try again (no cached failure value).
    const goodPolicy = {
      allowedSource: ["en"],
      allowedTarget: ["vi", "ja"],
      defaults: { source: "en", target: "vi" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(okResponse({ ok: true, policy: goodPolicy })),
    );
    expect(await fetchGuestPolicy()).toEqual(goodPolicy);
  });
});
