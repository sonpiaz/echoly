// Unit tests for parseVtt — realistic multi-cue fixtures covering all the
// edge-cases the parser promises to handle.
//
// Fixtures cover:
//   - WEBVTT header + blank-line block separator
//   - Numeric cue id line
//   - HH:MM:SS.mmm long-form timestamps
//   - MM:SS.mmm short-form timestamps
//   - Cue-setting suffix after " --> " (align:start position:0%)
//   - Multi-line cue text (joined with space)
//   - Inline tags: <c.colorname>, <i>, <v Name>
//   - Monotonic start ordering (parser sorts defensively)

import { describe, it, expect } from "vitest";
import { parseVtt } from "@/lib/vtt-parse";

// ─── Coursera-style fixture ───────────────────────────────────────────────────
//
// Characteristics: cue ids, HH:MM:SS.mmm timestamps, cue-setting suffix,
// inline <c.colorname> tag, multi-line cue body.

const COURSERA_VTT = `WEBVTT

1
00:00:01.000 --> 00:00:04.500 align:start position:0%
<c.colorname>Welcome</c> to this lecture on machine learning.

2
00:00:05.200 --> 00:00:09.800 align:start position:0%
Today we will cover
supervised learning algorithms.

3
00:00:10.400 --> 00:00:14.000
Let's start with <i>linear regression</i>.

4
00:01:02.000 --> 00:01:06.500
The cost function <v Instructor>measures</v> the error
between predicted and actual values.
`;

// ─── Udemy-style fixture ──────────────────────────────────────────────────────
//
// Characteristics: short MM:SS.mmm timestamps (Udemy auto-captions use this),
// numeric cue ids, multi-word inline <v Name> tag, a cue with a cue-setting.

const UDEMY_VTT = `WEBVTT

1
00:12.000 --> 00:15.500 align:start
Hello and welcome to this Python course.

2
00:16.000 --> 00:19.800
In this section you will learn about
<v Instructor>loops and conditionals</v>.

3
01:02.300 --> 01:05.700
Let's write our first function together.

4
02:30.000 --> 02:34.500
Now let's move on to <i>object-oriented programming</i>.
`;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("parseVtt — Coursera-style fixture", () => {
  const cues = parseVtt(COURSERA_VTT);

  it("parses 4 cues", () => {
    expect(cues).toHaveLength(4);
  });

  it("each cue has start < end", () => {
    for (const cue of cues) {
      expect(cue.start).toBeLessThan(cue.end);
    }
  });

  it("starts are monotonically non-decreasing", () => {
    for (let i = 1; i < cues.length; i++) {
      expect(cues[i]!.start).toBeGreaterThanOrEqual(cues[i - 1]!.start);
    }
  });

  it("strips inline <c.colorname> tag from first cue text", () => {
    expect(cues[0]!.text).not.toMatch(/<[^>]*>/);
    expect(cues[0]!.text).toContain("Welcome");
    expect(cues[0]!.text).toContain("lecture on machine learning");
  });

  it("joins multi-line cue text with a space", () => {
    // Cue 2 has two text lines
    expect(cues[1]!.text).toBe("Today we will cover supervised learning algorithms.");
  });

  it("strips <i> tags from cue 3", () => {
    expect(cues[2]!.text).not.toMatch(/<[^>]*>/);
    expect(cues[2]!.text).toContain("linear regression");
  });

  it("cue-setting suffix does NOT corrupt the end timestamp", () => {
    // Cue 1: end should be 4.5s not something that includes "align" text
    expect(cues[0]!.end).toBeCloseTo(4.5);
    expect(cues[0]!.start).toBeCloseTo(1.0);
  });

  it("strips <v Name> tag from multi-line cue 4", () => {
    expect(cues[3]!.text).not.toMatch(/<[^>]*>/);
    expect(cues[3]!.text).toContain("measures");
    expect(cues[3]!.text).toContain("cost function");
  });

  it("parses the long-form 1-minute timestamp correctly", () => {
    // Cue 4 starts at 00:01:02.000 = 62s
    expect(cues[3]!.start).toBeCloseTo(62.0);
    expect(cues[3]!.end).toBeCloseTo(66.5);
  });
});

describe("parseVtt — Udemy-style fixture (short MM:SS.mmm timestamps)", () => {
  const cues = parseVtt(UDEMY_VTT);

  it("parses 4 cues", () => {
    expect(cues).toHaveLength(4);
  });

  it("each cue has start < end", () => {
    for (const cue of cues) {
      expect(cue.start).toBeLessThan(cue.end);
    }
  });

  it("starts are monotonically non-decreasing", () => {
    for (let i = 1; i < cues.length; i++) {
      expect(cues[i]!.start).toBeGreaterThanOrEqual(cues[i - 1]!.start);
    }
  });

  it("parses short MM:SS.mmm timestamps correctly (first cue: 00:12.000)", () => {
    expect(cues[0]!.start).toBeCloseTo(12.0);
    expect(cues[0]!.end).toBeCloseTo(15.5);
  });

  it("cue-setting suffix does NOT corrupt the end timestamp", () => {
    // Cue 1 end = 00:15.500, not contaminated by "align:start"
    expect(cues[0]!.end).toBeCloseTo(15.5);
  });

  it("strips <v Name> inline tag from cue 2", () => {
    expect(cues[1]!.text).not.toMatch(/<[^>]*>/);
    expect(cues[1]!.text).toContain("loops and conditionals");
  });

  it("joins multi-line cue text", () => {
    expect(cues[1]!.text).toContain("In this section you will learn about");
    expect(cues[1]!.text).toContain("loops and conditionals");
  });

  it("strips <i> tag from last cue", () => {
    expect(cues[3]!.text).not.toMatch(/<[^>]*>/);
    expect(cues[3]!.text).toContain("object-oriented programming");
  });

  it("parses the MM:SS.mmm timestamp for cue 3 (01:02.300 = 62.3s)", () => {
    expect(cues[2]!.start).toBeCloseTo(62.3);
    expect(cues[2]!.end).toBeCloseTo(65.7);
  });
});

describe("parseVtt — edge cases", () => {
  it("returns an empty array for a header-only VTT", () => {
    expect(parseVtt("WEBVTT\n\n")).toHaveLength(0);
  });

  it("skips cues where end <= start", () => {
    const bad = `WEBVTT

00:00:05.000 --> 00:00:03.000
This cue has inverted timestamps.
`;
    expect(parseVtt(bad)).toHaveLength(0);
  });

  it("handles a VTT without trailing blank line (flushes final block)", () => {
    const noTrailing = `WEBVTT

00:00:01.000 --> 00:00:03.000
Only cue, no trailing newline.`;
    const result = parseVtt(noTrailing);
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toBe("Only cue, no trailing newline.");
  });
});
