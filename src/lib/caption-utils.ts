// Platform-neutral caption utilities.
//
// This module holds the CaptionSentence type and the platform-agnostic
// grouping/deduplication algorithms that were previously co-located with
// YouTube-specific code in youtube-captions.ts.
//
// Consumers should import CaptionCue from @/shared/platform-ports (one source
// of truth) and the sentence-level types/algorithms from here.

import type { CaptionCue } from "@/shared/platform-ports";

// Re-export CaptionCue so callers that previously imported it from this module
// (or from youtube-captions.ts) have a single import path.
export type { CaptionCue } from "@/shared/platform-ports";

// ─── Sentence type ────────────────────────────────────────────────────────────

/**
 * A grouped sentence produced by `regroupToSentences`. Extends `CaptionCue`
 * with two mutable state fields used by the play-once dub driver:
 *
 * - `_buffer?`  — decoded `AudioBuffer` for the TTS clip (populated lazily by
 *                 the subtitle-first pipeline after the TTS fetch resolves).
 * - `_played?`  — set to `true` by the 250 ms driver tick after the clip has
 *                 been queued for playback; prevents re-queuing.
 *
 * These fields are deliberately underscore-prefixed to signal that they are
 * internal scheduler state, not part of the caption data contract.
 */
export interface CaptionSentence extends CaptionCue {
  _buffer?: AudioBuffer;
  _played?: boolean;
}

// ─── Caption tag filter ───────────────────────────────────────────────────────

/**
 * Regex for cues whose ENTIRE text is a bracketed/parenthesised annotation or
 * pure music notes — e.g. [Music], [Applause], (laughs), ♪♪, [Âm nhạc].
 * Conservative: matches only when the WHOLE text is a tag/music block so lines
 * with real speech outside brackets are never dropped.
 */
const TAG_ONLY_RE = /^\s*[\[\(][^\]\)]{0,40}[\]\)]\s*$/u;
const MUSIC_ONLY_RE = /^\s*[♪♫][\s♪♫]*$/u;

/**
 * Return `true` when the cue contains only a bracketed/parenthesised tag or
 * pure music-note characters — i.e. no spoken text worth dubbing.
 *
 * Examples that return `true`:
 *   "[Music]"  "[Applause]"  "[Âm nhạc]"  "(laughs)"  "♪ ♪"  "♫♫"
 *
 * Examples that return `false` (contain real words):
 *   "[Music] Welcome"  "Hello ♪"  "He said [sighs] quietly"
 */
export function isTagOnlyCue(text: string): boolean {
  return TAG_ONLY_RE.test(text) || MUSIC_ONLY_RE.test(text);
}

/**
 * Strip leading and trailing ♪/♫ characters (and surrounding whitespace) from
 * a caption text while preserving inner words.
 *
 * Examples:
 *   "♪ Hello world ♪"  →  "Hello world"
 *   "♫ Amazing grace"  →  "Amazing grace"
 *   "Hello world"      →  "Hello world"  (unchanged)
 */
export function trimMusicNotes(text: string): string {
  return text.replace(/^[\s♪♫]+/, "").replace(/[\s♪♫]+$/, "");
}

// ─── Batch/lookahead constants ────────────────────────────────────────────────

/** Number of sentences fetched per TTS batch in the subtitle-first pipeline. */
export const SUBFIRST_BATCH_SIZE = 10;

/**
 * How far ahead (in ms) the subtitle-first pipeline pre-fetches TTS audio.
 * Sentences whose `start` falls within `currentTime + SUBFIRST_LOOKAHEAD_MS`
 * are included in the next batch request.
 */
export const SUBFIRST_LOOKAHEAD_MS = 30_000;

/**
 * Target decoded-audio lead in seconds (C4). The rolling renderer issues new
 * batches whenever the decoded coverage ahead of the playhead is below this
 * value. 45s gives ≥7× margin over the worst-case server batch latency (6s)
 * so the buffer never empties between fetches in normal conditions.
 *
 * Must be ≤ SUBFIRST_LOOKAHEAD_MS/1000 (30s) in practice we set it conservatively
 * below 30s so we don't fetch past the lookahead window. Keep in sync:
 * BUFFER_AHEAD_TARGET_SEC=25 is below the 30s lookahead so there's always room.
 */
export const BUFFER_AHEAD_TARGET_SEC = 25;

/**
 * A gap between caption cues larger than this (in ms) is treated as a
 * sentence boundary even when the previous cue does not end with punctuation.
 */
export const SUBFIRST_GAP_MS = 1500;

/**
 * Maximum word count for a grouped sentence. Cues are merged until either a
 * sentence-ending punctuation mark, a time gap > `SUBFIRST_GAP_MS`, or this
 * word limit is reached.
 *
 * Also used as the cap for the rolling-ASR overlap detection window in
 * `mergeWithDedupe` / `leadingOverlapTokens`.
 */
export const SUBFIRST_MAX_WORDS = 10;

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Count the token-level overlap: the longest suffix of `aText` that equals a
 * prefix of `bText` (case-insensitive), capped at `SUBFIRST_MAX_WORDS`.
 *
 * YouTube rolling-ASR repeats the tail of the previous cue at the start of the
 * next one. This detects that overlap so it can be stripped before merging.
 */
function leadingOverlapTokens(aText: string, bText: string): number {
  const aTokens = aText.split(/\s+/).filter(Boolean);
  const bTokens = bText.split(/\s+/).filter(Boolean);
  const maxOverlap = Math.min(aTokens.length, bTokens.length, SUBFIRST_MAX_WORDS);
  for (let n = maxOverlap; n > 0; n--) {
    const suffix = aTokens
      .slice(-n)
      .map((s) => s.toLowerCase())
      .join(" ");
    const prefix = bTokens
      .slice(0, n)
      .map((s) => s.toLowerCase())
      .join(" ");
    if (suffix === prefix) return n;
  }
  return 0;
}

/**
 * Drop the prefix of `nextText` already present as a suffix of `prevText`.
 * Used at sentence boundaries to avoid re-dubbing words that were included in
 * the previously emitted sentence.
 */
function stripLeadingOverlap(prevText: string, nextText: string): string {
  const overlap = leadingOverlapTokens(prevText, nextText);
  return nextText.split(/\s+/).filter(Boolean).slice(overlap).join(" ");
}

// ─── Exported algorithms ──────────────────────────────────────────────────────

/**
 * Merge `bText` onto `aText`, stripping any token-level overlap at the
 * junction. Used while accumulating cues into a sentence to handle the
 * rolling-ASR case where each incoming cue repeats the tail of the previous.
 *
 * Example:
 *   aText = "Hello world"
 *   bText = "world foo"     ← "world" is the overlapping token
 *   result = "Hello world foo"
 */
export function mergeWithDedupe(aText: string, bText: string): string {
  const overlap = leadingOverlapTokens(aText, bText);
  const tail = bText.split(/\s+/).filter(Boolean).slice(overlap).join(" ");
  return tail ? `${aText} ${tail}`.trim() : aText;
}

/**
 * Group raw `CaptionCue[]` into `CaptionSentence[]` suitable for the
 * play-once dub driver.
 *
 * Grouping rules (in priority order):
 * 1. Sentence-ending punctuation (`[.!?…。！？]` at end of cue text).
 * 2. Time gap between cues > `SUBFIRST_GAP_MS` ms.
 * 3. Accumulated word count ≥ `SUBFIRST_MAX_WORDS`.
 *
 * At a sentence boundary triggered by rule 1 or 3 (not a time gap), the
 * leading overlap of the next cue is stripped to prevent rolling-ASR words
 * from being re-dubbed.
 *
 * The result is passed through `clampSentenceTimelineNoOverlap` before return
 * to ensure start/end monotonicity (some sources have end > next start).
 */
export function regroupToSentences(captions: CaptionCue[]): CaptionSentence[] {
  const out: CaptionSentence[] = [];
  let acc: CaptionSentence | null = null;

  for (const rawCue of captions) {
    // Drop cues whose entire text is a bracketed tag or pure music notes.
    // [Music], [Applause], (laughs), ♪♪ → translated+billed as "Âm nhạc" etc.
    if (isTagOnlyCue(rawCue.text)) continue;
    // Trim leading/trailing ♪/♫ from mixed lines ("♪ Hello world ♪" → "Hello world").
    const c: CaptionCue = trimMusicNotes(rawCue.text) !== rawCue.text
      ? { ...rawCue, text: trimMusicNotes(rawCue.text) }
      : rawCue;
    if (!acc) {
      acc = { ...c };
      continue;
    }
    const prevText: string = acc.text;
    const prevEnd: number = acc.end;
    const gapMs: number = (c.start - prevEnd) * 1000;
    const endsSentence = /[.!?…。！？]$/.test(prevText);
    const tooLong = prevText.split(/\s+/).length >= SUBFIRST_MAX_WORDS;

    if (endsSentence || gapMs > SUBFIRST_GAP_MS || tooLong) {
      out.push(acc);
      // Time-gap boundary: keep the cue as-is (no rolling-ASR issue across a
      // genuine pause). Punctuation / word-limit boundary: strip the overlap.
      const stripped: string =
        gapMs > SUBFIRST_GAP_MS ? c.text : stripLeadingOverlap(prevText, c.text);
      acc = stripped ? { ...c, text: stripped } : null;
    } else {
      acc.text = mergeWithDedupe(acc.text, c.text);
      acc.end = c.end;
    }
  }
  if (acc) out.push(acc);
  return clampSentenceTimelineNoOverlap(out);
}

/**
 * Clamp overlapping sentence end-times so `end[i] <= start[i+1]`.
 *
 * Rolling-ASR and json3 sources often produce cues where the end time of one
 * cue exceeds the start of the next. The play-once driver schedules TTS clips
 * at `sentence.start`; if end[i] > start[i+1], two clips fire at the same
 * wall-clock time, causing duplicated dub audio. This function eliminates that
 * by tightening end[i] to start[i+1] wherever they would overlap.
 */
export function clampSentenceTimelineNoOverlap(
  sentences: CaptionSentence[],
): CaptionSentence[] {
  if (sentences.length < 2) return sentences;
  const out = sentences.map((s) => ({ ...s }));
  for (let i = 0; i < out.length - 1; i++) {
    if (out[i]!.end > out[i + 1]!.start) {
      out[i]!.end = out[i + 1]!.start;
    }
  }
  return out;
}
