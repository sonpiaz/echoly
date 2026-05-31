// WebVTT parser — converts a VTT string into CaptionCue[].
//
// Handles the full subset of WebVTT that appears in real-world platform
// responses (Coursera, Udemy, YouTube auto-generated):
//   - WEBVTT header (with or without BOM / metadata block)
//   - Optional cue id / number lines
//   - HH:MM:SS.mmm --> HH:MM:SS.mmm  (hours optional, minutes always present)
//   - MM:SS.mmm  (two-field short form, no hours component)
//   - Cue-setting suffixes after the timestamp arrow (position, align, …)
//   - Multi-line cue text (joined with a single space)
//   - Blank-line cue separators
//   - Simple inline tag stripping: <c>, <c.class>, <v Name>, <i>, <b>, <u>,
//     <ruby>, <rt>, <lang>, <00:00:00.000> timestamp tags
//
// Returns cues sorted by start time with start < end.

import type { CaptionCue } from "@/shared/platform-ports";

// ─── Timestamp parsing ────────────────────────────────────────────────────────

/**
 * Parse a WebVTT timestamp string to seconds.
 *
 * Accepts:
 *   HH:MM:SS.mmm  (ISO-style, hours always two or more digits)
 *   MM:SS.mmm     (short form, no hours)
 *   HH:MM:SS,mmm  (SRT-style comma — tolerated for robustness)
 *
 * Returns `null` when the string does not match any recognised format.
 */
function parseTimestamp(raw: string): number | null {
  // Strip surrounding whitespace
  const s = raw.trim();

  // HH:MM:SS.mmm  or  HH:MM:SS,mmm
  const long = s.match(/^(\d+):(\d{2}):(\d{2})[.,](\d{1,3})$/);
  if (long) {
    const [, hh, mm, ss, ms] = long;
    return (
      parseInt(hh!, 10) * 3600 +
      parseInt(mm!, 10) * 60 +
      parseInt(ss!, 10) +
      parseInt(ms!.padEnd(3, "0"), 10) / 1000
    );
  }

  // MM:SS.mmm  or  MM:SS,mmm
  const short = s.match(/^(\d+):(\d{2})[.,](\d{1,3})$/);
  if (short) {
    const [, mm, ss, ms] = short;
    return (
      parseInt(mm!, 10) * 60 +
      parseInt(ss!, 10) +
      parseInt(ms!.padEnd(3, "0"), 10) / 1000
    );
  }

  return null;
}

// ─── Inline tag stripping ─────────────────────────────────────────────────────

/**
 * Strip WebVTT inline tags from cue text, leaving only plain text.
 *
 * Removed patterns:
 *   <c>, </c>, <c.class>, <v Name>, <i>, </i>, <b>, </b>, <u>, </u>
 *   <ruby>, </ruby>, <rt>, </rt>, <lang …>, </lang>
 *   Timestamp tags: <00:00:00.000>
 *
 * Intentionally does NOT use innerHTML / DOMParser — this runs in the SW
 * context and must be pure-string.
 */
function stripInlineTags(text: string): string {
  return (
    text
      // Timestamp tags like <00:01:23.456>
      .replace(/<\d+:\d{2}:\d{2}[.,]\d+>/g, "")
      // All other angle-bracket tags (open/close/self-closing)
      .replace(/<[^>]*>/g, "")
      // Collapse internal whitespace runs left by removed tags
      .replace(/\s+/g, " ")
      .trim()
  );
}

// ─── Cue-block parser ─────────────────────────────────────────────────────────

/**
 * Determine whether a string is a VTT timestamp line (contains ` --> `).
 */
function isTimestampLine(line: string): boolean {
  return line.includes(" --> ");
}

/**
 * Parse a single cue block (an array of non-empty lines representing one cue)
 * into a `CaptionCue`, or `null` if the block cannot be parsed.
 *
 * A cue block has the structure:
 *   [optional cue id / number]
 *   HH:MM:SS.mmm --> HH:MM:SS.mmm [cue-settings …]
 *   cue text line 1
 *   cue text line 2   ← optional, joined with space
 */
function parseCueBlock(lines: string[]): CaptionCue | null {
  let timingLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isTimestampLine(lines[i]!)) {
      timingLineIdx = i;
      break;
    }
  }
  if (timingLineIdx === -1) return null;

  const timingLine = lines[timingLineIdx]!;
  // Everything after " --> " may include cue-setting tokens (position, align,
  // line, size, region). Split on " --> " and then take only the first token
  // of the second part as the end-timestamp.
  const arrowIdx = timingLine.indexOf(" --> ");
  const startRaw = timingLine.slice(0, arrowIdx).trim();
  const afterArrow = timingLine.slice(arrowIdx + 5); // 5 = " --> ".length
  // End timestamp is the first whitespace-delimited token (cue settings follow)
  const endRaw = afterArrow.trimStart().split(/\s+/)[0] ?? "";

  const start = parseTimestamp(startRaw);
  const end = parseTimestamp(endRaw);
  if (start === null || end === null) return null;
  if (end <= start) return null;

  // Text lines: everything after the timing line
  const textLines = lines.slice(timingLineIdx + 1);
  if (textLines.length === 0) return null;

  const text = stripInlineTags(textLines.join(" "));
  if (!text) return null;

  return { start, end, text };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse a WebVTT string into an array of `CaptionCue` objects.
 *
 * - Cues are sorted by `start` time (ascending).
 * - Only cues with `start < end` and non-empty text are included.
 * - The `WEBVTT` header and any NOTE / STYLE / REGION blocks are ignored.
 * - BOM (`﻿`) at the start is stripped.
 *
 * @param vtt - Raw WebVTT string (e.g. the body of a `.vtt` response).
 * @returns Sorted array of `CaptionCue` objects.
 */
export function parseVtt(vtt: string): CaptionCue[] {
  // Strip BOM if present
  const src = vtt.startsWith("﻿") ? vtt.slice(1) : vtt;

  // Normalise line endings
  const lines = src.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  const cues: CaptionCue[] = [];

  // Split into blocks on blank lines
  let block: string[] = [];

  const flushBlock = () => {
    if (block.length === 0) return;

    // Skip WEBVTT header block, NOTE blocks, STYLE blocks, REGION blocks
    const first = block[0]!.trim();
    if (
      first.startsWith("WEBVTT") ||
      first.startsWith("NOTE") ||
      first.startsWith("STYLE") ||
      first.startsWith("REGION")
    ) {
      block = [];
      return;
    }

    const cue = parseCueBlock(block);
    if (cue) cues.push(cue);
    block = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd(); // keep leading whitespace (cue text may indent)
    if (line === "") {
      flushBlock();
    } else {
      block.push(line);
    }
  }
  // Flush the final block (file may not end with a blank line)
  flushBlock();

  // Sort by start time (most sources are already ordered, but be defensive)
  cues.sort((a, b) => a.start - b.start);

  return cues;
}
