// SettingsClient tests — exercise the HTTP layer at the fetch IO boundary.
// Mocking `fetch` here is NOT mocking business logic; fetch IS the SUT's
// boundary. The client has no domain logic of its own (no merging, no caching).
//
// Covers:
//   • GET 200 → returns the parsed bundle
//   • GET 401 → returns null (the SW treats this as "guest")
//   • GET signed-out (no token) → returns null without ever calling fetch
//   • PUT 200 → returns the new bundle
//   • PUT 409 → throws SettingsHttpError with the conflict bundle attached
//   • PUT 500 → throws SettingsHttpError with status=500
//   • DELETE 200 → returns the new bundle
//   • bearer header is set, content-type is set on PUT bodies

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  SettingsClient,
  SettingsHttpError,
} from "@/background/settings-client";
import type {
  AdvancedSettings,
  SiteOverrideMap,
} from "@/shared/advanced";
import { DEFAULT_ADVANCED } from "@/shared/advanced";

const API_BASE = "https://api.test.local/v1";

const SAMPLE_SETTINGS: AdvancedSettings = {
  ...DEFAULT_ADVANCED,
  translationStyle: "casual",
};
const SAMPLE_OVERRIDES: SiteOverrideMap = {
  "youtube.com": { latencyPreset: "snappy" },
};
const SAMPLE_BUNDLE = {
  settings: SAMPLE_SETTINGS,
  siteOverrides: SAMPLE_OVERRIDES,
  version: 7,
  updatedAt: "2026-05-28T12:00:00.000Z",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("SettingsClient — HTTP boundary", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let client: SettingsClient;
  let getToken: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    (globalThis as { fetch?: unknown }).fetch = fetchSpy;
    getToken = vi.fn().mockResolvedValue("tok-abc");
    client = new SettingsClient(API_BASE, getToken);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── GET ───────────────────────────────────────────────────────────────────
  describe("fetchBundle", () => {
    it("signed-out (no token) → null without hitting the network", async () => {
      getToken.mockResolvedValueOnce(null);
      const r = await client.fetchBundle();
      expect(r).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("200 → returns parsed bundle and sends Bearer auth", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(200, SAMPLE_BUNDLE));
      const r = await client.fetchBundle();
      expect(r).toEqual(SAMPLE_BUNDLE);
      expect(fetchSpy).toHaveBeenCalledWith(
        `${API_BASE}/me/settings`,
        expect.objectContaining({
          headers: { Authorization: "Bearer tok-abc" },
        }),
      );
    });

    it("401 → null (treat as signed-out; cookie expired)", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(401, { error: "expired" }));
      const r = await client.fetchBundle();
      expect(r).toBeNull();
    });

    it("500 → throws SettingsHttpError with status + body", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(500, { error: "boom" }));
      await expect(client.fetchBundle()).rejects.toMatchObject({
        name: "SettingsHttpError",
        status: 500,
      });
    });

    it("malformed JSON body → throws SettingsHttpError(malformed)", async () => {
      // 200 but missing required fields
      fetchSpy.mockResolvedValueOnce(jsonResponse(200, { foo: "bar" }));
      await expect(client.fetchBundle()).rejects.toMatchObject({
        name: "SettingsHttpError",
        status: 200,
      });
    });
  });

  // ── PUT global ────────────────────────────────────────────────────────────
  describe("putGlobal", () => {
    it("200 → returns new bundle; body carries patch + expectedVersion", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(200, SAMPLE_BUNDLE));
      const r = await client.putGlobal({ translationStyle: "literal" }, 6);
      expect(r).toEqual(SAMPLE_BUNDLE);

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(init.method).toBe("PUT");
      expect(init.body).toBe(
        JSON.stringify({
          patch: { translationStyle: "literal" },
          expectedVersion: 6,
        }),
      );
      // Headers are passed as a Headers instance from the SUT.
      const headers = init.headers as Headers;
      expect(headers.get("Authorization")).toBe("Bearer tok-abc");
      expect(headers.get("Content-Type")).toBe("application/json");
    });

    it("409 → throws SettingsHttpError with the current bundle attached", async () => {
      const currentBundle = { ...SAMPLE_BUNDLE, version: 9 };
      fetchSpy.mockResolvedValueOnce(jsonResponse(409, currentBundle));
      const promise = client.putGlobal({ translationStyle: "literal" }, 6);
      await expect(promise).rejects.toBeInstanceOf(SettingsHttpError);
      try {
        await promise;
      } catch (err) {
        expect(err).toBeInstanceOf(SettingsHttpError);
        const e = err as SettingsHttpError;
        expect(e.status).toBe(409);
        expect(e.body).toEqual(currentBundle);
      }
    });

    it("signed-out → throws 401 SettingsHttpError before reaching the wire", async () => {
      getToken.mockResolvedValueOnce(null);
      await expect(
        client.putGlobal({ translationStyle: "literal" }),
      ).rejects.toMatchObject({
        name: "SettingsHttpError",
        status: 401,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // ── PUT site override ─────────────────────────────────────────────────────
  describe("putSiteOverride", () => {
    it("encodes the domain in the URL", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(200, SAMPLE_BUNDLE));
      await client.putSiteOverride(
        "youtube.com",
        { captionPosition: "top" },
        3,
      );
      expect(fetchSpy.mock.calls[0]?.[0]).toBe(
        `${API_BASE}/me/settings/sites/youtube.com`,
      );
    });

    it("special characters in domain are percent-encoded", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(200, SAMPLE_BUNDLE));
      await client.putSiteOverride("a b.com", {}, 1);
      expect(fetchSpy.mock.calls[0]?.[0]).toBe(
        `${API_BASE}/me/settings/sites/a%20b.com`,
      );
    });
  });

  // ── DELETE site override ──────────────────────────────────────────────────
  describe("removeSiteOverride", () => {
    it("200 → returns new bundle", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(200, SAMPLE_BUNDLE));
      const r = await client.removeSiteOverride("youtube.com");
      expect(r).toEqual(SAMPLE_BUNDLE);
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${API_BASE}/me/settings/sites/youtube.com`);
      expect(init.method).toBe("DELETE");
    });

    it("404 → throws SettingsHttpError(404)", async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(404, { error: "no such site" }),
      );
      await expect(
        client.removeSiteOverride("youtube.com"),
      ).rejects.toMatchObject({
        status: 404,
      });
    });
  });
});
