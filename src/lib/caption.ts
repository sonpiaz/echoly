// ────────────────────────────────────────────────────────────────────────────
// Pure — caption parsing + regrouping. Ported verbatim from legacy/content.js:
//   pickCaptionTrack 1528-1543, parseJson3Events 1610-1621,
//   mergeWithDedupe 1633-1645, regroupToSentences 1647-1665.
// Chrome-free / network-free: given raw json3 events (or caption-track metadata)
// they produce the sentence-shaped cues the subtitle-first pipeline schedules.
// ────────────────────────────────────────────────────────────────────────────

// Subtitle-first regrouping tunables (legacy/content.js:1394-1398).
export const SUBFIRST_GAP_MS = 1500; // sentence boundary if inter-cue gap > this
export const SUBFIRST_MAX_WORDS = 15; // OR cumulative words > this

/** A single timed caption cue (seconds). `_buffer` is attached later by the
 *  TTS render stage; kept optional here so the pure parsers don't depend on it. */
export interface Caption {
  start: number;
  end: number;
  text: string;
  _buffer?: AudioBuffer;
}

/** json3 event shape (subset we read). */
export interface Json3Event {
  segs?: { utf8?: string }[];
  tStartMs?: number;
  dDurationMs?: number;
}

/** A YouTube caption track (subset of ytInitialPlayerResponse.captionTracks). */
export interface CaptionTrack {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
}

/** Score-rank caption tracks: native target > en > manual-over-asr.
 *  Returns the best track, or null when none. (legacy pickCaptionTrack.) */
export function pickCaptionTrack(
  tracks: CaptionTrack[] | undefined,
  targetLang: string,
): CaptionTrack | null {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  const targetCode = (targetLang || "").toLowerCase().split("-")[0];
  const score = (t: CaptionTrack): number => {
    const code = (t.languageCode || "").toLowerCase().split("-")[0];
    let s = 0;
    // Native target-lang track is gold (human-translated subs)
    if (code === targetCode) s += 100;
    // English source most often available + best translation source
    if (code === "en") s += 50;
    // Manual > ASR (manual has no `kind`, ASR has kind: "asr")
    if (!t.kind || t.kind !== "asr") s += 10;
    return s;
  };
  return [...tracks].sort((a, b) => score(b) - score(a))[0]!;
}

/** Parse json3 timedtext events into timed cues (seconds). Drops empty /
 *  newline-only segments and events lacking a numeric start. (legacy.) */
export function parseJson3Events(events: Json3Event[]): Caption[] {
  const out: Caption[] = [];
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

/** Collapse the ASR sliding-window overlap between two consecutive cue texts by
 *  finding the longest matching suffix-of-A / prefix-of-B (capped at 8 tokens)
 *  and dropping the duplicate tokens from B before joining. (legacy.) */
export function mergeWithDedupe(aText: string, bText: string): string {
  const aTokens = aText.split(/\s+/).filter(Boolean);
  const bTokens = bText.split(/\s+/).filter(Boolean);
  const maxOverlap = Math.min(aTokens.length, bTokens.length, 8); // cap at 8
  let overlap = 0;
  for (let n = maxOverlap; n > 0; n--) {
    const suffix = aTokens
      .slice(-n)
      .map((s) => s.toLowerCase())
      .join(" ");
    const prefix = bTokens
      .slice(0, n)
      .map((s) => s.toLowerCase())
      .join(" ");
    if (suffix === prefix) {
      overlap = n;
      break;
    }
  }
  const tail = bTokens.slice(overlap).join(" ");
  return tail ? `${aText} ${tail}`.trim() : aText;
}

/** Regroup short ASR cues into sentence-shaped chunks (boundary on terminal
 *  punctuation, an inter-cue gap > SUBFIRST_GAP_MS, or accumulated words >=
 *  SUBFIRST_MAX_WORDS), deduping the sliding-window overlap. (legacy.) */
export function regroupToSentences(captions: Caption[]): Caption[] {
  const out: Caption[] = [];
  let acc: Caption | null = null;
  for (const c of captions) {
    if (!acc) {
      acc = { ...c };
      continue;
    }
    const gapMs = (c.start - acc.end) * 1000;
    const endsSentence = /[.!?…。！？]$/.test(acc.text);
    const tooLong = acc.text.split(/\s+/).length >= SUBFIRST_MAX_WORDS;
    if (endsSentence || gapMs > SUBFIRST_GAP_MS || tooLong) {
      out.push(acc);
      acc = { ...c };
    } else {
      acc.text = mergeWithDedupe(acc.text, c.text);
      acc.end = c.end;
    }
  }
  if (acc) out.push(acc);
  return out;
}
