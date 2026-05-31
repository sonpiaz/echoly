import { describe, expect, it } from "vitest";
import {
  clampSentenceTimelineNoOverlap,
  mergeWithDedupe,
  regroupToSentences,
} from "@/lib/caption-utils";
import { parseJson3Events } from "@/platforms/youtube/captions";

describe("parseJson3Events", () => {
  it("maps json3 segs to cues", () => {
    const cues = parseJson3Events([
      {
        tStartMs: 1000,
        dDurationMs: 500,
        segs: [{ utf8: "Hello " }, { utf8: "world" }],
      },
    ]);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.text).toBe("Hello world");
    expect(cues[0]!.start).toBe(1);
    expect(cues[0]!.end).toBeCloseTo(1.5);
  });
});

describe("regroupToSentences", () => {
  it("merges overlapping ASR tails", () => {
    const merged = mergeWithDedupe("the world how", "world how are you");
    expect(merged).toBe("the world how are you");
    const sentences = regroupToSentences([
      { start: 0, end: 1, text: "the world how" },
      { start: 1.1, end: 2, text: "world how are you" },
    ]);
    expect(sentences).toHaveLength(1);
    expect(sentences[0]!.text).toBe("the world how are you");
  });
});

describe("regroupToSentences — cross-boundary ASR dedup (duplicate-dub root cause)", () => {
  it("does not repeat the tail of sentence[N] at the start of sentence[N+1] on a tooLong split", () => {
    // Rolling ASR buildup: each cue repeats the previous tail and adds words.
    // After ~15 words the tooLong boundary fires; the trigger cue ("...terms")
    // must not carry "terms" into the next sentence.
    const sentences = regroupToSentences([
      { start: 0.0, end: 0.6, text: "Welcome to the channel today we" },
      { start: 0.6, end: 1.2, text: "the channel today we are going to" },
      { start: 1.2, end: 1.8, text: "we are going to talk about machine" },
      { start: 1.8, end: 2.4, text: "talk about machine learning in simple" },
      { start: 2.4, end: 3.0, text: "machine learning in simple terms" },
      { start: 3.0, end: 3.6, text: "terms for beginners let us start" },
      { start: 3.6, end: 4.2, text: "for beginners let us start with the basics" },
    ]);
    expect(sentences.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < sentences.length; i++) {
      const prev = sentences[i - 1]!.text.split(/\s+/).map((w) => w.toLowerCase());
      const cur = sentences[i]!.text.split(/\s+/).map((w) => w.toLowerCase());
      const tail = prev.slice(-3);
      const head = cur.slice(0, 3);
      expect(tail.filter((w) => head.includes(w))).toHaveLength(0);
    }
  });

  it("does not repeat the closing phrase of sentence[N] at the start of sentence[N+1] on a punctuation split", () => {
    const sentences = regroupToSentences([
      { start: 0.0, end: 0.5, text: "now let me explain" },
      { start: 0.5, end: 1.0, text: "let me explain." },
      { start: 1.0, end: 1.5, text: "explain. So the first" },
      { start: 1.5, end: 2.0, text: "So the first thing" },
    ]);
    expect(sentences.length).toBeGreaterThanOrEqual(2);
    expect(sentences[1]!.text.toLowerCase().startsWith("explain")).toBe(false);
  });

  it("keeps a genuinely new line intact across a time-gap split", () => {
    const sentences = regroupToSentences([
      { start: 0.0, end: 1.0, text: "first topic done." },
      { start: 5.0, end: 6.0, text: "completely different sentence here" },
    ]);
    expect(sentences).toHaveLength(2);
    expect(sentences[1]!.text).toBe("completely different sentence here");
  });

  it("regroup clamps overlapping ASR timeline so adjacent ends do not exceed next start", () => {
    const sentences = regroupToSentences([
      { start: 0.0, end: 2.0, text: "line one." },
      { start: 0.5, end: 2.5, text: "line two." },
      { start: 1.0, end: 3.0, text: "line three." },
    ]);
    for (let i = 0; i < sentences.length - 1; i++) {
      expect(sentences[i]!.end).toBeLessThanOrEqual(sentences[i + 1]!.start);
    }
  });
});

describe("clampSentenceTimelineNoOverlap", () => {
  it("trims end times only", () => {
    const out = clampSentenceTimelineNoOverlap([
      { start: 0, end: 3, text: "a" },
      { start: 1, end: 4, text: "b" },
    ]);
    expect(out[0]!.end).toBe(1);
    expect(out[1]!.start).toBe(1);
  });
});
