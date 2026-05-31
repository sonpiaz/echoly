// Pure YouTube caption parsing + sentence regrouping (chrome-free).

export interface CaptionCue {
  start: number;
  end: number;
  text: string;
}

export interface CaptionSentence extends CaptionCue {
  _buffer?: AudioBuffer;
  _played?: boolean;
}

export const SUBFIRST_BATCH_SIZE = 10;
export const SUBFIRST_LOOKAHEAD_MS = 30_000;
export const SUBFIRST_GAP_MS = 1500;
// Keep subtitle-first TTS chunks shorter so per-line audio duration better fits
// caption slots (reduces overlap/delay pressure in scheduler).
export const SUBFIRST_MAX_WORDS = 10;

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

/**
 * Token count of the longest suffix of `aText` that equals a prefix of `bText`
 * (case-insensitive, capped at SUBFIRST_MAX_WORDS). Used to dedupe YouTube's
 * rolling-ASR overlap where each cue repeats the tail of the previous one — the
 * cap must cover a full sentence so a long restart isn't missed (was 8).
 */
function leadingOverlapTokens(aText: string, bText: string): number {
  const aTokens = aText.split(/\s+/).filter(Boolean);
  const bTokens = bText.split(/\s+/).filter(Boolean);
  const maxOverlap = Math.min(aTokens.length, bTokens.length, SUBFIRST_MAX_WORDS);
  for (let n = maxOverlap; n > 0; n--) {
    const suffix = aTokens.slice(-n).map((s) => s.toLowerCase()).join(" ");
    const prefix = bTokens.slice(0, n).map((s) => s.toLowerCase()).join(" ");
    if (suffix === prefix) return n;
  }
  return 0;
}

export function mergeWithDedupe(aText: string, bText: string): string {
  const overlap = leadingOverlapTokens(aText, bText);
  const tail = bText.split(/\s+/).filter(Boolean).slice(overlap).join(" ");
  return tail ? `${aText} ${tail}`.trim() : aText;
}

/** Drop the prefix of `nextText` already present as a suffix of `prevText`. */
function stripLeadingOverlap(prevText: string, nextText: string): string {
  const overlap = leadingOverlapTokens(prevText, nextText);
  return nextText.split(/\s+/).filter(Boolean).slice(overlap).join(" ");
}

export function regroupToSentences(captions: CaptionCue[]): CaptionSentence[] {
  const out: CaptionSentence[] = [];
  let acc: CaptionSentence | null = null;
  for (const c of captions) {
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
      // Rolling ASR repeats the tail of the previous cue at the start of the next.
      // Strip that overlap so the boundary cue does not re-dub words already in the
      // sentence we just pushed (the root cause of duplicated dub audio). A pure
      // time-gap split keeps `c` intact (no rolling overlap there).
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
 * Rolling ASR / json3 cues often have end[i] > start[i+1]. Timeline scheduling
 * at each `start` then stacks TTS clips — heard as duplicated dub voice.
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
