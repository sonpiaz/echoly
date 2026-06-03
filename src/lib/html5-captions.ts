// Shared HTML5 text-track caption fetcher.
//
// Provides `fetchHtml5TextTrackCaptions` — a single, platform-agnostic helper
// that reads captions from a `<video>` element's HTML5 text-track machinery:
//
//   (a) already-loaded `video.textTracks` cues (zero network, preferred).
//   (b) `<track src>` VTT fetch (credentials:"include") when cues are absent.
//   (c) null when neither path yields captions.
//
// Ported from src/platforms/coursera/adapter.ts (textTrackCuesToCaptionCues,
// pickTextTrack, findTrackElement). Kept pure + jsdom-testable — no DOM
// globals beyond what is passed in via the `video` argument.

import type { CaptionFetchResult, CaptionCue } from "@/shared/platform-ports";
import { parseVtt } from "@/lib/vtt-parse";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface Html5CaptionOpts {
  /** BCP-47 preferred language (e.g. "en"). Pick first track when omitted. */
  preferLang?: string;
  /** AbortSignal forwarded to the VTT fetch (step b). */
  signal?: AbortSignal;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Convert a TextTrackCueList (or array-like) into CaptionCue[].
 * Guards against absent / malformed cue fields.
 * Strips any inline VTT tags that some platforms leave in the text.
 */
function textTrackCuesToCaptionCues(cues: TextTrackCueList): CaptionCue[] {
  const result: CaptionCue[] = [];
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    if (!cue) continue;
    const start = cue.startTime;
    const end = cue.endTime;
    if (typeof start !== "number" || typeof end !== "number") continue;
    if (end <= start) continue;
    // TextTrackCue.text is on VTTCue; guard with `in` check
    const text = "text" in cue ? String((cue as VTTCue).text).trim() : "";
    if (!text) continue;
    // Strip any inline VTT tags that some platforms leave in the text
    const plain = text.replace(/<[^>]*>/g, "").trim();
    if (!plain) continue;
    result.push({ start, end, text: plain });
  }
  result.sort((a, b) => a.start - b.start);
  return result;
}

/**
 * Pick the best matching TextTrack from a TextTrackList.
 * Only considers `subtitles` and `captions` kinds.
 * Priority: preferLang exact → preferLang prefix → first available.
 */
function pickTextTrack(
  tracks: TextTrackList,
  preferLang?: string,
): TextTrack | null {
  const relevant: TextTrack[] = [];
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    if (!t) continue;
    const kind = t.kind;
    if (kind === "subtitles" || kind === "captions") {
      relevant.push(t);
    }
  }
  if (relevant.length === 0) return null;

  if (preferLang) {
    // Exact language match
    const exact = relevant.find(
      (t) => t.language?.toLowerCase() === preferLang.toLowerCase(),
    );
    if (exact) return exact;
    // Prefix match (e.g. "en" matches "en-US")
    const prefix = relevant.find((t) =>
      t.language?.toLowerCase().startsWith(preferLang.toLowerCase()),
    );
    if (prefix) return prefix;
  }
  // Fall back to first available
  return relevant[0] ?? null;
}

/**
 * Find the `<track>` DOM element that corresponds to a given TextTrack object.
 * Matches by `el.track === track` identity first, then kind + srclang fallback.
 */
function findTrackElement(
  video: HTMLVideoElement,
  track: TextTrack,
): HTMLTrackElement | null {
  const els = video.querySelectorAll<HTMLTrackElement>("track");
  for (const el of els) {
    if (
      el.track === track ||
      (el.kind === track.kind && el.srclang === track.language)
    ) {
      return el;
    }
  }
  return null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch captions from a `<video>` element using the standard HTML5 text-track
 * mechanism. Tries two strategies in order:
 *
 *   (a) Already-loaded `video.textTracks` cues — zero network, preferred.
 *   (b) Fetch the matching `<track src>` VTT URL with `credentials:"include"`.
 *
 * Returns `null` when neither strategy yields any captions, or when the signal
 * is aborted before a result is produced.
 *
 * This is the universal fallback called by `SubtitleFirstPipeline` before
 * concluding "no captions" — it covers any platform that ships standard HTML5
 * `<track>` elements (Udemy, generic sites, etc.) without requiring each
 * adapter to reimplement the same logic.
 */
export async function fetchHtml5TextTrackCaptions(
  video: HTMLVideoElement,
  opts?: Html5CaptionOpts,
): Promise<CaptionFetchResult | null> {
  const { preferLang, signal } = opts ?? {};

  // Honor an already-aborted signal immediately.
  if (signal?.aborted) return null;

  try {
    const tracks = video.textTracks;
    const track = pickTextTrack(tracks, preferLang);
    if (track) {
      // ── Strategy (a): already-loaded cues ──────────────────────────────────
      const cues = track.cues;
      if (cues && cues.length > 0) {
        const captions = textTrackCuesToCaptionCues(cues);
        if (captions.length > 0) {
          return {
            captions,
            sourceLang: track.language ?? null,
            trackName: track.label || undefined,
          };
        }
      }

      // ── Strategy (b): fetch <track src> VTT ────────────────────────────────
      const trackEl = findTrackElement(video, track);
      if (trackEl?.src) {
        try {
          const res = await fetch(trackEl.src, {
            credentials: "include",
            signal,
          });
          if (res.ok) {
            const vttText = await res.text();
            const captions = parseVtt(vttText);
            if (captions.length > 0) {
              return {
                captions,
                sourceLang: track.language ?? null,
                trackName: track.label || undefined,
              };
            }
          }
        } catch {
          // Fetch failed (e.g. AbortError, CDN error) — fall through to null
        }
      }
    }
  } catch {
    // Unexpected DOM error — fall through to null
  }

  return null;
}
