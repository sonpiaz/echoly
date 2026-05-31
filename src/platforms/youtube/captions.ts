// YouTube-specific caption helpers.
//
// This module holds the YouTube-specific functions that were previously
// co-located in `src/lib/youtube-captions.ts`. The platform-neutral helpers
// (CaptionSentence, regroupToSentences, mergeWithDedupe,
// clampSentenceTimelineNoOverlap, SUBFIRST_* constants) have been moved to
// `@/lib/caption-utils` by agent F — import them from there, not here.

import type { CaptionCue } from "@/shared/platform-ports";

// ─── Video ID ────────────────────────────────────────────────────────────────

export function getYouTubeVideoId(href = location.href): string | null {
  try {
    const u = new URL(href);
    const v = u.searchParams.get("v");
    if (v) return v;
    const m = u.pathname.match(/\/embed\/([^/?]+)/);
    if (m) return m[1] ?? null;
    return null;
  } catch {
    return null;
  }
}

// ─── Caption track selection ──────────────────────────────────────────────────

export function pickCaptionTrack(
  tracks: Array<{ languageCode?: string; kind?: string; baseUrl?: string }>,
  targetLang: string,
): (typeof tracks)[number] | null {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  const targetCode = (targetLang || "").toLowerCase().split("-")[0];
  const score = (t: (typeof tracks)[number]) => {
    const code = (t.languageCode || "").toLowerCase().split("-")[0];
    let s = 0;
    if (code === targetCode) s += 100;
    if (code === "en") s += 50;
    if (!t.kind || t.kind !== "asr") s += 10;
    return s;
  };
  return [...tracks].sort((a, b) => score(b) - score(a))[0] ?? null;
}

// ─── json3 event parser ───────────────────────────────────────────────────────

export function parseJson3Events(
  events: Array<{ segs?: Array<{ utf8?: string }>; tStartMs?: number; dDurationMs?: number }>,
): CaptionCue[] {
  const out: CaptionCue[] = [];
  for (const e of events) {
    if (!e?.segs || typeof e.tStartMs !== "number") continue;
    const text = e.segs
      .map((s) => s.utf8 || "")
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (!text || text === "\n") continue;
    const start = e.tStartMs / 1000;
    const dur = (e.dDurationMs || 0) / 1000;
    out.push({ start, end: start + dur, text });
  }
  return out;
}

// ─── Subtitle translation prompt helpers ─────────────────────────────────────

export function buildSubtitleTranslatePrompt(
  items: string[],
  langName: string,
): string {
  return (
    `Translate these ${items.length} subtitle lines to ${langName}. ` +
    `Return exactly ${items.length} strings in the same order. ` +
    `Preserve names, brand names, and technical terms verbatim. No commentary.\n\n` +
    `Each translated line should be CONCISE — prefer shorter natural phrasing ` +
    `over literal word-for-word, so the dub fits the same time slot as the original cue.\n\n` +
    `Input lines:\n${JSON.stringify(items)}`
  );
}

export function alignSubtitleTranslations(
  sources: string[],
  lines: string[] | null | undefined,
): string[] {
  if (!Array.isArray(lines)) lines = [];
  return sources.map((src, i) => {
    const t = lines[i];
    return typeof t === "string" && t.trim() ? t.trim() : src;
  });
}
