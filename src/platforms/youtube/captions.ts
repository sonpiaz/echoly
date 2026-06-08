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

/**
 * Select the best SOURCE caption track for dubbing.
 *
 * `sourcePref` distinguishes two modes:
 *   • `undefined` (AUTO) — the user left "Auto-detect": pick the video's ORIGINAL
 *     spoken-language track (ASR-first), avoiding the output language.
 *   • a BCP-47 code (EXPLICIT) — the user chose a specific source language: a track
 *     in that language MUST win, even over the ASR/original track.
 *
 * Scoring:
 *   +300  code matches an EXPLICIT sourcePref — the user's choice wins decisively
 *   +100  ASR (auto-captions) = the original spoken-language track
 *   +20   code is "en" — safe fallback source
 *   hard  code matches avoidLang primary subtag → score −1000 (NEVER the output lang)
 *
 * Returns `null` when:
 *   - tracks is empty, OR
 *   - the highest-scoring track's language IS the avoid/target language
 *     (prevents target→target dubbing even when it is the only track).
 */
export function pickCaptionTrack(
  tracks: Array<{ languageCode?: string; kind?: string; baseUrl?: string }>,
  sourcePref?: string,
  avoidLang?: string,
): (typeof tracks)[number] | null {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  // null = AUTO (no explicit choice). A defined value = the user's explicit source.
  const sourceCode = sourcePref ? sourcePref.toLowerCase().split("-")[0] : null;
  const avoidCode = avoidLang ? avoidLang.toLowerCase().split("-")[0] : null;
  const score = (t: (typeof tracks)[number]) => {
    const code = (t.languageCode || "").toLowerCase().split("-")[0];
    if (avoidCode && code === avoidCode) return -1000; // hard avoid the output language
    let s = 0;
    if (sourceCode && code === sourceCode) s += 300; // EXPLICIT source choice wins over ASR
    if (t.kind === "asr") s += 100;                  // original spoken language
    if (code === "en") s += 20;                      // English is a safe default source
    return s;
  };
  const best = [...tracks].sort((a, b) => score(b) - score(a))[0] ?? null;
  if (!best) return null;
  // Robustness: if the best remaining track IS the target/avoid language, return
  // null so the caller falls back (audio-capture) instead of dubbing target→target.
  if (avoidCode) {
    const bestCode = (best.languageCode || "").toLowerCase().split("-")[0];
    if (bestCode === avoidCode) return null;
  }
  return best;
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

// ─── Timedtext body parser (json3 OR srv3/srv1 XML) ───────────────────────────

/**
 * Parse a raw YouTube timedtext response body into CaptionCue[]. Handles the
 * json3 format (`{events:[...]}`) AND the XML formats (srv3 `<p t d>` / srv1
 * `<text start dur>`) — the player may fetch any of these, and the MAIN-world
 * capture relays whatever the player actually got (pot-proof, zero refetch).
 * Returns [] when the body is empty/unparseable.
 */
export function parseTimedtextBody(body: string): CaptionCue[] {
  const trimmed = body?.trim();
  if (!trimmed) return [];
  // json3
  if (trimmed.startsWith("{")) {
    try {
      const json = JSON.parse(trimmed) as {
        events?: Parameters<typeof parseJson3Events>[0];
      };
      return parseJson3Events(json.events || []);
    } catch {
      return [];
    }
  }
  // XML (srv3 / srv1)
  if (trimmed.startsWith("<")) {
    try {
      const doc = new DOMParser().parseFromString(trimmed, "text/xml");
      if (doc.querySelector("parsererror")) return [];
      const out: CaptionCue[] = [];
      // srv3: <body><p t="ms" d="ms"><s>seg</s>...</p></body>
      const ps = Array.from(doc.querySelectorAll("p"));
      if (ps.length) {
        for (const p of ps) {
          const t = Number(p.getAttribute("t"));
          if (!Number.isFinite(t)) continue;
          const d = Number(p.getAttribute("d") || "0");
          const text = (p.textContent || "").replace(/\s+/g, " ").trim();
          if (!text) continue;
          const start = t / 1000;
          out.push({ start, end: start + (Number.isFinite(d) ? d / 1000 : 0), text });
        }
        if (out.length) return out;
      }
      // srv1: <transcript><text start="s" dur="s">...</text></transcript>
      const texts = Array.from(doc.querySelectorAll("text"));
      for (const el of texts) {
        const start = Number(el.getAttribute("start"));
        if (!Number.isFinite(start)) continue;
        const dur = Number(el.getAttribute("dur") || "0");
        const text = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (!text) continue;
        out.push({ start, end: start + (Number.isFinite(dur) ? dur : 0), text });
      }
      return out;
    } catch {
      return [];
    }
  }
  return [];
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
