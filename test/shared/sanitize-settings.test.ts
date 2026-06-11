// Tests for sanitizeServerPatch (global 13-key) vs sanitizePatch (local 6-key
// advanced) vs sanitizeSiteOverridePatch (site overrides — legacy 3 keys ONLY).
import { describe, it, expect } from "vitest";
import { sanitizeServerPatch, sanitizePatch, sanitizeSiteOverridePatch } from "@/shared/advanced";

describe("sanitizeSiteOverridePatch — legacy-3 restriction", () => {
  it("keeps the 3 site-scoped keys and strips the 3 subtitle-style keys", () => {
    const result = sanitizeSiteOverridePatch({
      captionPosition: "top",
      autoStartHosts: { "youtube.com": true },
      outputDeviceId: "device-1",
      captionFontSize: "xlarge",
      captionBgOpacity: "transparent",
      captionFontWeight: "bold",
    } as Record<string, unknown> as Record<string, string | number | boolean | object | null>);

    expect(result.captionPosition).toBe("top");
    expect(result.autoStartHosts).toEqual({ "youtube.com": true });
    expect(result.outputDeviceId).toBe("device-1");
    expect((result as Record<string, unknown>).captionFontSize).toBeUndefined();
    expect((result as Record<string, unknown>).captionBgOpacity).toBeUndefined();
    expect((result as Record<string, unknown>).captionFontWeight).toBeUndefined();
  });

  it("strips the synced Settings keys too", () => {
    const result = sanitizeSiteOverridePatch({
      mode: "realtime",
      targetLanguage: "fr",
      captionPosition: "bottom",
    } as Record<string, unknown> as Record<string, string | number | boolean | object | null>);
    expect(result.captionPosition).toBe("bottom");
    expect((result as Record<string, unknown>).mode).toBeUndefined();
    expect((result as Record<string, unknown>).targetLanguage).toBeUndefined();
  });
});

describe("sanitizeServerPatch — global 10-key patch", () => {
  it("accepts all 3 Advanced keys", () => {
    const result = sanitizeServerPatch({
      captionPosition: "top",
      autoStartHosts: { "youtube.com": true },
      outputDeviceId: "device-123",
    } as Record<string, unknown> as Record<string, string | number | boolean | object | null>);

    expect(result.captionPosition).toBe("top");
    expect(result.autoStartHosts).toEqual({ "youtube.com": true });
    expect(result.outputDeviceId).toBe("device-123");
  });

  it("accepts all 7 synced Settings keys", () => {
    const result = sanitizeServerPatch({
      mode: "realtime",
      targetLanguage: "vi",
      sourceLanguage: "auto",
      standardVoice: "English_magnetic_voiced_man",
      realtimeVoice: "marin",
      showSource: false,
      showTargetCaptions: true,
    } as Record<string, unknown> as Record<string, string | number | boolean | object | null>);

    expect(result.mode).toBe("realtime");
    expect(result.targetLanguage).toBe("vi");
    expect(result.sourceLanguage).toBe("auto");
    expect(result.standardVoice).toBe("English_magnetic_voiced_man");
    expect(result.realtimeVoice).toBe("marin");
    expect(result.showSource).toBe(false);
    expect(result.showTargetCaptions).toBe(true);
  });

  it("rejects invalid mode values", () => {
    const result = sanitizeServerPatch({
      mode: "dubbing",
    } as Record<string, unknown> as Record<string, string | number | boolean | object | null>);
    expect(result.mode).toBeUndefined();
  });

  it("rejects targetLanguage that does not match BCP-47-ish regex", () => {
    const result = sanitizeServerPatch({
      targetLanguage: "this_is_way_too_long_for_a_language_code_!!",
    } as Record<string, unknown> as Record<string, string | number | boolean | object | null>);
    expect(result.targetLanguage).toBeUndefined();
  });

  it("accepts sourceLanguage:auto", () => {
    const result = sanitizeServerPatch({
      sourceLanguage: "auto",
    } as Record<string, unknown> as Record<string, string | number | boolean | object | null>);
    expect(result.sourceLanguage).toBe("auto");
  });

  it("drops unknown keys", () => {
    const result = sanitizeServerPatch({
      unknownKey: "xyz",
      mode: "standard",
    } as Record<string, unknown> as Record<string, string | number | boolean | object | null>);
    expect((result as Record<string, unknown>).unknownKey).toBeUndefined();
    expect(result.mode).toBe("standard");
  });

  it("returns empty object for null / non-object input", () => {
    expect(sanitizeServerPatch(null)).toEqual({});
  });
});

describe("sanitizePatch — site-override (3-key restriction)", () => {
  it("strips the 7 synced Settings keys from a site-override patch", () => {
    const result = sanitizePatch({
      captionPosition: "top",
      mode: "realtime",
      targetLanguage: "fr",
      sourceLanguage: "auto",
      standardVoice: "v1",
      realtimeVoice: "marin",
      showSource: true,
      showTargetCaptions: false,
    } as Record<string, unknown> as Record<string, string | number | boolean | object | null>);

    // Only the 3 Advanced keys survive
    expect(result.captionPosition).toBe("top");
    // The 7 synced keys must NOT appear
    expect((result as Record<string, unknown>).mode).toBeUndefined();
    expect((result as Record<string, unknown>).targetLanguage).toBeUndefined();
    expect((result as Record<string, unknown>).sourceLanguage).toBeUndefined();
    expect((result as Record<string, unknown>).standardVoice).toBeUndefined();
    expect((result as Record<string, unknown>).realtimeVoice).toBeUndefined();
    expect((result as Record<string, unknown>).showSource).toBeUndefined();
    expect((result as Record<string, unknown>).showTargetCaptions).toBeUndefined();
  });

  it("returns only captionPosition when only captionPosition is valid", () => {
    const result = sanitizePatch({
      captionPosition: "float",
    } as Record<string, unknown> as Record<string, string | number | boolean | object | null>);
    expect(result).toEqual({ captionPosition: "float" });
  });
});
