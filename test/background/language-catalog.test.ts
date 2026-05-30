import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchPublicLanguageCatalog,
  offlineLanguageCatalog,
  resolvePublicLanguageCatalog,
} from "@/background/language-catalog";

describe("language catalog (server SoT, HTTP cache)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const sampleResponse = {
    ok: true,
    languages: {
      en: "English",
      vi: "Vietnamese",
      ja: "Japanese",
      ar: "Arabic",
    },
    pairs: [
      { source: "en", target: "vi" },
      { source: "en", target: "ja" },
      { source: "ar", target: "en" },
    ],
  };

  it("offline bootstrap has 17 languages (sync with server)", () => {
    expect(Object.keys(offlineLanguageCatalog().languageNames)).toHaveLength(17);
  });

  it("fetchPublicLanguageCatalog uses default HTTP cache", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => sampleResponse,
    } as Response);

    const snap = await fetchPublicLanguageCatalog();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/config/language-pairs"),
      expect.objectContaining({ cache: "default" }),
    );
    expect(snap?.picker.map(([c]) => c)).toEqual(["en", "ja", "vi"]);
  });

  it("resolvePublicLanguageCatalog falls back to offline when fetch fails", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("offline"));
    const snap = await resolvePublicLanguageCatalog();
    expect(snap.picker.length).toBeGreaterThan(0);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
