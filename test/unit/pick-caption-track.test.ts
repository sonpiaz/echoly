// Unit tests for pickCaptionTrack — source-track selection (Fix D).
//
// The picker must select the ORIGINAL spoken-language track, NOT the output
// language. Key invariants:
//   D1  ASR + matching source → beats any non-ASR track; never picks avoidLang.
//   D2  For a fixed track-set, result is the same regardless of what avoidLang
//       is, as long as avoidLang is a language NOT present in the tracks.
//   D5  When the ONLY track IS the avoidLang, return null (→ audio-capture fallback).

import { describe, it, expect } from "vitest";
import { pickCaptionTrack } from "@/platforms/youtube/captions";

// ─── Shared track fixtures ────────────────────────────────────────────────────

const EN_ASR = { languageCode: "en", kind: "asr", baseUrl: "https://example.com/en-asr" };
const EN_MANUAL = { languageCode: "en", kind: "standard", baseUrl: "https://example.com/en" };
const VI_TRACK = { languageCode: "vi", kind: "standard", baseUrl: "https://example.com/vi" };
const KO_TRACK = { languageCode: "ko", kind: "standard", baseUrl: "https://example.com/ko" };

// ─── D1: en ASR + vi track, avoid vi → picks en ──────────────────────────────

describe("pickCaptionTrack — D1: source vs target selection", () => {
  it("returns the en ASR track when avoidLang=vi and sourcePref=en", () => {
    const result = pickCaptionTrack([EN_ASR, VI_TRACK], "en", "vi");
    expect(result).not.toBeNull();
    expect(result?.languageCode).toBe("en");
  });

  it("ASR track beats a non-ASR track of the same language", () => {
    const result = pickCaptionTrack([EN_MANUAL, EN_ASR], "en", "vi");
    expect(result?.kind).toBe("asr");
  });

  it("returns null when avoidLang track would win (vi-only with avoidLang=vi)", () => {
    // D5: the only track is the avoid language → null
    const result = pickCaptionTrack([VI_TRACK], "en", "vi");
    expect(result).toBeNull();
  });
});

// ─── D2: fixed track-set picks the same source regardless of avoidLang ───────

describe("pickCaptionTrack — D2: stable source selection across avoidLang values", () => {
  // Track set: en ASR + ko. Source selection should be en ASR regardless of
  // which non-present language we're asked to avoid.
  const tracks = [EN_ASR, KO_TRACK];

  it("picks en ASR when avoidLang=vi (not present)", () => {
    expect(pickCaptionTrack(tracks, "en", "vi")?.languageCode).toBe("en");
  });

  it("picks en ASR when avoidLang=fr (not present)", () => {
    expect(pickCaptionTrack(tracks, "en", "fr")?.languageCode).toBe("en");
  });

  it("picks en ASR when avoidLang=de (not present)", () => {
    expect(pickCaptionTrack(tracks, "en", "de")?.languageCode).toBe("en");
  });

  it("result is the same object for any avoidLang not in the track set", () => {
    const r1 = pickCaptionTrack(tracks, "en", "vi");
    const r2 = pickCaptionTrack(tracks, "en", "fr");
    // Both should pick the same track (by languageCode + kind).
    expect(r1?.languageCode).toBe(r2?.languageCode);
    expect(r1?.kind).toBe(r2?.kind);
  });
});

// ─── D5: only the target/avoid language exists → null ────────────────────────

describe("pickCaptionTrack — D5: null when only avoidLang track exists", () => {
  it("returns null when the only track IS the avoidLang (vi-only, avoid=vi)", () => {
    expect(pickCaptionTrack([VI_TRACK], "en", "vi")).toBeNull();
  });

  it("returns null for ASR track when ASR language IS the avoidLang", () => {
    const VI_ASR = { languageCode: "vi", kind: "asr", baseUrl: "https://example.com/vi-asr" };
    expect(pickCaptionTrack([VI_ASR], "en", "vi")).toBeNull();
  });
});

// ─── Scoring sanity checks ────────────────────────────────────────────────────

describe("pickCaptionTrack — scoring sanity", () => {
  it("returns null for an empty track list", () => {
    expect(pickCaptionTrack([], "en", "vi")).toBeNull();
  });

  it("AUTO mode (sourcePref omitted) picks the ASR/original track", () => {
    const result = pickCaptionTrack([EN_ASR, VI_TRACK], undefined, "vi");
    expect(result?.languageCode).toBe("en");
    expect(result?.kind).toBe("asr");
  });

  it("prefers ASR track over manual track even for non-English source", () => {
    const KO_ASR = { languageCode: "ko", kind: "asr", baseUrl: "https://example.com/ko-asr" };
    // sourcePref=ko, avoidLang=vi → ko ASR should beat ko manual
    const result = pickCaptionTrack([KO_TRACK, KO_ASR], "ko", "vi");
    expect(result?.kind).toBe("asr");
  });

  it("with no avoidLang, picks highest-scoring track (ASR en)", () => {
    const result = pickCaptionTrack([EN_ASR, VI_TRACK, KO_TRACK], "en");
    expect(result?.languageCode).toBe("en");
    expect(result?.kind).toBe("asr");
  });
});

// ─── Explicit source MUST win over a different-language ASR (Problem-2 follow-up) ─
// The user's "mất tiếng Original không theo cài đặt" bug: when the user explicitly
// chose a source language, a different-language ASR track was winning (ASR +100 >
// old explicit +60). Now an explicit match scores +300 and wins decisively.

describe("pickCaptionTrack — explicit source overrides the ASR bonus", () => {
  const JA_ASR = { languageCode: "ja", kind: "asr", baseUrl: "https://example.com/ja-asr" };

  it("EXPLICIT en is chosen over a ja ASR track (en manual beats ja asr)", () => {
    const result = pickCaptionTrack([JA_ASR, EN_MANUAL], "en", "vi");
    expect(result?.languageCode).toBe("en");
    expect(result?.kind).toBe("standard");
  });

  it("AUTO (no explicit) on the same set falls back to the ASR/original (ja asr)", () => {
    const result = pickCaptionTrack([JA_ASR, EN_MANUAL], undefined, "vi");
    expect(result?.languageCode).toBe("ja");
    expect(result?.kind).toBe("asr");
  });

  it("EXPLICIT ko is chosen over an en ASR track", () => {
    const result = pickCaptionTrack([EN_ASR, KO_TRACK], "ko", "vi");
    expect(result?.languageCode).toBe("ko");
  });

  it("EXPLICIT source not present in the set → falls back to the original (ASR)", () => {
    // user wants "ja" but only en-asr + ko exist → original (en asr) is the fallback
    const result = pickCaptionTrack([EN_ASR, KO_TRACK], "ja", "vi");
    expect(result?.kind).toBe("asr");
  });
});
