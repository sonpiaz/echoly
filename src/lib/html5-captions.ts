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

// Cue-readiness poll (RC4): after activating a previously "disabled" track the
// browser parses its cues lazily — poll briefly for them to populate.
const HTML5_CUE_READY_INTERVAL_MS = 100;
const HTML5_CUE_READY_MAX_ATTEMPTS = 5;

/**
 * Wait (bounded) for a just-activated track's cues to populate. The browser parses
 * cues asynchronously after a track is switched out of "disabled" mode, so a single
 * synchronous read right after activation sees `cues === null`. Returns the cue list
 * once non-empty, or whatever is present at the deadline (possibly null/empty).
 */
async function waitForCues(
  track: TextTrack,
  signal?: AbortSignal,
): Promise<TextTrackCueList | null> {
  for (let i = 0; i < HTML5_CUE_READY_MAX_ATTEMPTS; i++) {
    if (signal?.aborted) return null;
    const cues = track.cues;
    if (cues && cues.length > 0) return cues;
    await new Promise((r) => setTimeout(r, HTML5_CUE_READY_INTERVAL_MS));
  }
  return track.cues ?? null;
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
      // A track left in its default "disabled" mode exposes cues === null — the
      // browser only parses cues for an ACTIVE track. Activate it to "hidden" (parses
      // cues WITHOUT rendering native captions over the video) and wait briefly for
      // the lazy parse. Only when WE find it disabled: an already-active track with no
      // cues genuinely has none → fall straight through to the <track src> fetch (b).
      let cues = track.cues;
      let activated = false;
      if ((!cues || cues.length === 0) && track.mode === "disabled") {
        try {
          track.mode = "hidden";
          activated = true;
        } catch {
          // mode is read-only in some embeddings — fall through to strategy (b).
        }
        cues = await waitForCues(track, signal);
      }
      if (cues && cues.length > 0) {
        // Copy the cue data BEFORE any mode reset — resetting to "disabled" can empty
        // the live track.cues list, and our result must survive that.
        const captions = textTrackCuesToCaptionCues(cues);
        // Restore the track's original disabled state — we activated it only to read
        // cues; leave no lingering cuechange side-effect on the platform's track.
        if (activated) {
          try {
            track.mode = "disabled";
          } catch {
            /* read-only — nothing to restore */
          }
        }
        if (captions.length > 0) {
          return {
            captions,
            sourceLang: track.language ?? null,
            trackName: track.label || undefined,
          };
        }
      } else if (activated) {
        // No cues even after activation — restore the disabled mode before strategy (b).
        try {
          track.mode = "disabled";
        } catch {
          /* read-only */
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
