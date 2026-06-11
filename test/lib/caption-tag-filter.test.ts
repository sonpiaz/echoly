// Tests for the caption tag-filter additions in src/lib/caption-utils.ts.
//
// Covers:
//   1. isTagOnlyCue — table-driven: true for bracketed tags, music notes; false
//      for lines with real speech outside brackets.
//   2. trimMusicNotes — strips leading/trailing ♪/♫ but preserves inner words.
//   3. regroupToSentences integration — tag-only cues are dropped entirely;
//      mixed lines with real words are kept (with notes trimmed).

import { describe, it, expect } from "vitest";
import {
  isTagOnlyCue,
  trimMusicNotes,
  regroupToSentences,
} from "@/lib/caption-utils";

// ─── 1. isTagOnlyCue ─────────────────────────────────────────────────────────

describe("isTagOnlyCue", () => {
  const trueTable: string[] = [
    "[Music]",
    "[Applause]",
    "[Âm nhạc]",
    "(laughs)",
    "(chuckles)",
    "[laughter]",
    "♪",
    "♫",
    "♪♪",
    "♫♫",
    " ♪ ♪ ",
    "  [Music]  ",           // leading/trailing whitespace
    "(sighs)",
    "[applause]",
    "[MUSIC]",               // case doesn't matter (regex is not case-insensitive but tag chars are)
    "[♪]",                   // nested music in brackets
  ];

  const falseTable: Array<[string, string]> = [
    ["Hello world", "normal speech"],
    ["[Music] Welcome to the show", "tag + real words"],
    ["Hello ♪", "words then note"],
    ["♪ Hello", "note then words"],
    ["He said (sighs) quietly", "mid-sentence tag"],
    ["[Music starts] and then he spoke", "tag start + words"],
    ["♪ Amazing grace how sweet", "note + words"],
    ["This is a test.", "normal sentence"],
    ["", "empty string"],
    ["  ", "whitespace only — no brackets, no music notes"],
  ];

  for (const text of trueTable) {
    it(`returns true for: ${JSON.stringify(text)}`, () => {
      expect(isTagOnlyCue(text)).toBe(true);
    });
  }

  for (const [text, desc] of falseTable) {
    it(`returns false for ${desc}: ${JSON.stringify(text)}`, () => {
      expect(isTagOnlyCue(text)).toBe(false);
    });
  }
});

// ─── 2. trimMusicNotes ────────────────────────────────────────────────────────

describe("trimMusicNotes", () => {
  it("strips leading ♪", () => {
    expect(trimMusicNotes("♪ Hello world")).toBe("Hello world");
  });

  it("strips trailing ♪", () => {
    expect(trimMusicNotes("Hello world ♪")).toBe("Hello world");
  });

  it("strips both leading and trailing ♪", () => {
    expect(trimMusicNotes("♪ Hello world ♪")).toBe("Hello world");
  });

  it("strips ♫ characters", () => {
    expect(trimMusicNotes("♫ Amazing grace ♫")).toBe("Amazing grace");
  });

  it("strips mixed ♪ and ♫", () => {
    expect(trimMusicNotes("♪♫ Some lyrics ♫♪")).toBe("Some lyrics");
  });

  it("leaves inner text with notes untouched", () => {
    // The note is INSIDE the text — trimMusicNotes only trims leading/trailing.
    // Inner notes are preserved (they're part of the transcription).
    expect(trimMusicNotes("Hello ♪ world")).toBe("Hello ♪ world");
  });

  it("returns unchanged string when no notes present", () => {
    expect(trimMusicNotes("Hello world")).toBe("Hello world");
  });

  it("handles multiple notes at start", () => {
    expect(trimMusicNotes("♪ ♪ Hello")).toBe("Hello");
  });

  it("preserves empty string", () => {
    expect(trimMusicNotes("")).toBe("");
  });
});

// ─── 3. regroupToSentences integration ────────────────────────────────────────

describe("regroupToSentences — tag-only cue filtering", () => {
  it("drops [Music] cue entirely", () => {
    const cues = [
      { start: 0, end: 2, text: "[Music]" },
      { start: 2, end: 5, text: "Welcome to the show." },
    ];
    const result = regroupToSentences(cues);
    expect(result.map((s) => s.text)).not.toContain("[Music]");
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]!.text).toContain("Welcome");
  });

  it("drops [Applause] cue entirely", () => {
    const cues = [
      { start: 0, end: 3, text: "Thank you very much." },
      { start: 3, end: 5, text: "[Applause]" },
      { start: 5, end: 8, text: "We will now begin." },
    ];
    const result = regroupToSentences(cues);
    for (const s of result) {
      expect(s.text.toLowerCase()).not.toContain("applause");
    }
  });

  it("drops (laughs) cue entirely", () => {
    const cues = [
      { start: 0, end: 2, text: "That's funny." },
      { start: 2, end: 3, text: "(laughs)" },
      { start: 3, end: 6, text: "Moving on." },
    ];
    const result = regroupToSentences(cues);
    for (const s of result) {
      expect(s.text).not.toContain("laughs");
    }
  });

  it("drops pure music-note cue ♪♪", () => {
    const cues = [
      { start: 0, end: 2, text: "♪♪" },
      { start: 2, end: 5, text: "Hello there." },
    ];
    const result = regroupToSentences(cues);
    expect(result.some((s) => /^[♪♫\s]+$/.test(s.text))).toBe(false);
    expect(result[0]!.text).toContain("Hello");
  });

  it("drops [Âm nhạc] (Vietnamese) cue", () => {
    const cues = [
      { start: 0, end: 2, text: "[Âm nhạc]" },
      { start: 2, end: 5, text: "Xin chào." },
    ];
    const result = regroupToSentences(cues);
    for (const s of result) {
      expect(s.text).not.toContain("Âm nhạc");
    }
  });

  it("does NOT drop a cue with real words outside brackets", () => {
    const cues = [
      { start: 0, end: 4, text: "[Music] Welcome to the show." },
    ];
    const result = regroupToSentences(cues);
    // The whole cue is NOT tag-only (has real words), so it must not be dropped.
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]!.text).toContain("Welcome");
  });

  it("trims leading ♪ from mixed cue", () => {
    const cues = [
      { start: 0, end: 4, text: "♪ Hello world." },
    ];
    const result = regroupToSentences(cues);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]!.text).not.toMatch(/^♪/);
    expect(result[0]!.text).toContain("Hello world");
  });

  it("trims trailing ♪ from mixed cue", () => {
    const cues = [
      { start: 0, end: 4, text: "Amazing grace ♪" },
    ];
    const result = regroupToSentences(cues);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]!.text).not.toMatch(/♪$/);
    expect(result[0]!.text).toContain("Amazing grace");
  });

  it("produces correct sentence count when multiple tag-only cues are interspersed", () => {
    const cues = [
      { start: 0, end: 2, text: "[Music]" },
      { start: 2, end: 5, text: "Hello world." },
      { start: 5, end: 6, text: "♪" },
      { start: 6, end: 9, text: "How are you?" },
      { start: 9, end: 10, text: "[Applause]" },
      { start: 10, end: 13, text: "Goodbye." },
    ];
    const result = regroupToSentences(cues);
    // Should have 3 real sentences; tags dropped.
    expect(result).toHaveLength(3);
    expect(result[0]!.text).toContain("Hello");
    expect(result[1]!.text).toContain("How are you");
    expect(result[2]!.text).toContain("Goodbye");
  });

  it("handles a video with ONLY tag cues — returns empty array", () => {
    const cues = [
      { start: 0, end: 2, text: "[Music]" },
      { start: 2, end: 4, text: "♪♪" },
      { start: 4, end: 6, text: "(applause)" },
    ];
    const result = regroupToSentences(cues);
    expect(result).toHaveLength(0);
  });
});
