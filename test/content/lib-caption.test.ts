// Layer A — golden/characterization tests for the pure caption logic
// (src/lib/caption.ts). Captured from legacy/content.js: parseJson3Events
// 1610-1621, mergeWithDedupe 1633-1645, regroupToSentences 1647-1665,
// pickCaptionTrack 1528-1543.
import { describe, it, expect } from "vitest";
import {
  mergeWithDedupe,
  parseJson3Events,
  pickCaptionTrack,
  regroupToSentences,
  type Caption,
  type Json3Event,
} from "@/lib/caption";

describe("parseJson3Events", () => {
  it("converts segs+tStartMs to seconds; drops empty/newline/no-start events", () => {
    const events: Json3Event[] = [
      { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: "Hello " }, { utf8: "world" }] },
      { tStartMs: 4000, dDurationMs: 500, segs: [{ utf8: "\n" }] }, // dropped
      { dDurationMs: 500, segs: [{ utf8: "no start" }] }, // dropped (no tStartMs)
      { tStartMs: 5000, segs: [{ utf8: "  spaced   out  " }] }, // dur defaults 0
    ];
    const out = parseJson3Events(events);
    expect(out).toEqual([
      { start: 1, end: 3, text: "Hello world" },
      { start: 5, end: 5, text: "spaced out" },
    ]);
  });

  it("returns [] for empty input", () => {
    expect(parseJson3Events([])).toEqual([]);
  });
});

describe("mergeWithDedupe (collapses ASR sliding-window overlap)", () => {
  it("drops the duplicated suffix/prefix tokens (case-insensitive match)", () => {
    expect(mergeWithDedupe("the world how", "World how are you")).toBe(
      "the world how are you",
    );
  });
  it("plain concat when there is no overlap", () => {
    expect(mergeWithDedupe("alpha beta", "gamma delta")).toBe(
      "alpha beta gamma delta",
    );
  });
  it("returns A unchanged when B is fully contained in the overlap", () => {
    expect(mergeWithDedupe("one two three", "two three")).toBe("one two three");
  });
});

describe("regroupToSentences", () => {
  it("breaks on terminal punctuation", () => {
    const caps: Caption[] = [
      { start: 0, end: 1, text: "Hello there." },
      { start: 1, end: 2, text: "How are you" },
    ];
    const out = regroupToSentences(caps);
    expect(out.map((c) => c.text)).toEqual(["Hello there.", "How are you"]);
  });

  it("breaks on a large inter-cue gap (> 1500ms)", () => {
    const caps: Caption[] = [
      { start: 0, end: 1, text: "first part" },
      { start: 3, end: 4, text: "second part" }, // gap = 2000ms
    ];
    const out = regroupToSentences(caps);
    expect(out.length).toBe(2);
  });

  it("merges adjacent cues (small gap, no terminal punct, under word cap)", () => {
    const caps: Caption[] = [
      { start: 0, end: 1, text: "the world how" },
      { start: 1, end: 2, text: "world how are you" },
    ];
    const out = regroupToSentences(caps);
    expect(out.length).toBe(1);
    expect(out[0]!.text).toBe("the world how are you");
    expect(out[0]!.end).toBe(2);
  });

  it("breaks when accumulated words reach SUBFIRST_MAX_WORDS (15)", () => {
    const long = "a b c d e f g h i j k l m n o"; // 15 words
    const caps: Caption[] = [
      { start: 0, end: 1, text: long },
      { start: 1, end: 2, text: "p q r" },
    ];
    const out = regroupToSentences(caps);
    expect(out.length).toBe(2);
  });
});

describe("pickCaptionTrack (native target > en > manual-over-asr)", () => {
  it("prefers the native target-language track", () => {
    const tracks = [
      { languageCode: "en", baseUrl: "en" },
      { languageCode: "vi", baseUrl: "vi" },
    ];
    expect(pickCaptionTrack(tracks, "vi")!.baseUrl).toBe("vi");
  });
  it("prefers English when no native target track exists", () => {
    const tracks = [
      { languageCode: "fr", baseUrl: "fr" },
      { languageCode: "en", baseUrl: "en" },
    ];
    expect(pickCaptionTrack(tracks, "vi")!.baseUrl).toBe("en");
  });
  it("prefers manual over ASR within the same language", () => {
    const tracks = [
      { languageCode: "en", kind: "asr", baseUrl: "asr" },
      { languageCode: "en", baseUrl: "manual" },
    ];
    expect(pickCaptionTrack(tracks, "vi")!.baseUrl).toBe("manual");
  });
  it("returns null for empty / missing track lists", () => {
    expect(pickCaptionTrack([], "vi")).toBeNull();
    expect(pickCaptionTrack(undefined, "vi")).toBeNull();
  });
});
