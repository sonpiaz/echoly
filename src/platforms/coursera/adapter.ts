// Coursera platform adapter.
//
// Coursera delivers lectures via a React SPA with a standard HTML5 <video>
// element. Captions are available via:
//   1. Already-loaded <track kind="subtitles"|"captions"> elements / textTracks
//      (zero network, no extra host permission required — preferred).
//   2. fetch(<track>.src) + parseVtt when a track src is present but cues are
//      not yet loaded (e.g. src is a signed VTT URL).
//   3. FALLBACK: api.coursera.org/api/onDemandLectureVideos.v1/<videoId>
//      (covered by *.coursera.org host permission).
//
// Capabilities:
//   audioCapture:      true  — likely HTML5, no confirmed Widevine
//   subtitleFirst:     true  — <track> VTT + Coursera API available
//   isSpa:             true  — React SPA, history.pushState between lectures
//   hasNativeCaptions: true  — Coursera renders its own caption UI
//   hasAdOverlays:     false — no ad overlays

import type {
  PlatformAdapter,
  PlatformCapabilities,
  CaptionFetchResult,
  CaptionCue,
} from "@/shared/platform-ports";
import { parseVtt } from "@/lib/vtt-parse";

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Matches Coursera lecture pages:
 *   /learn/<course-slug>/lecture/<item-id>
 *   /learn/<course-slug>/lecture/<item-id>/<title-slug>
 *
 * Does NOT match:
 *   /learn/<course>/home/...
 *   /learn/<course>/supplement/...
 *   /learn/<course>/quiz/...
 *   /browse/...
 */
const LECTURE_URL_RE = /\/learn\/[^/]+\/lecture\/([^/?#]+)/;

const COURSERA_CAPABILITIES: PlatformCapabilities = {
  audioCapture: true,
  subtitleFirst: true,
  isSpa: true,
  hasNativeCaptions: true,
  hasAdOverlays: false,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Find the primary (largest visible) <video> element.
 * Prefers the largest by bounding-box area; falls back to `querySelector('video')`.
 */
function findLargestVideo(): HTMLVideoElement | null {
  let best: HTMLVideoElement | null = null;
  let bestArea = 0;
  for (const el of document.querySelectorAll("video")) {
    const r = el.getBoundingClientRect();
    const area = r.width * r.height;
    if (area > bestArea) {
      bestArea = area;
      best = el;
    }
  }
  // If no video had a non-zero bounding rect (hidden/detached), fall back to first.
  return best ?? (document.querySelector("video") as HTMLVideoElement | null);
}

/**
 * Convert a TextTrackCueList (or array-like) into CaptionCue[].
 * Guards against any absent / malformed cue field.
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
 * Priority: preferLang exact match → preferLang prefix match → first available.
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
 * Pick a language from the Coursera API subtitlesVtt map.
 * Returns [langCode, vttUrl] or null.
 */
function pickCourseraApiTrack(
  subtitlesVtt: Record<string, string>,
  preferLang?: string,
): [string, string] | null {
  const keys = Object.keys(subtitlesVtt);
  if (keys.length === 0) return null;

  if (preferLang) {
    // Exact match
    if (subtitlesVtt[preferLang]) return [preferLang, subtitlesVtt[preferLang]!];
    // Prefix match
    const prefixKey = keys.find((k) =>
      k.toLowerCase().startsWith(preferLang.toLowerCase()),
    );
    if (prefixKey && subtitlesVtt[prefixKey]) {
      return [prefixKey, subtitlesVtt[prefixKey]!];
    }
  }
  // First available
  const firstKey = keys[0]!;
  return [firstKey, subtitlesVtt[firstKey]!];
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export const courseraAdapter: PlatformAdapter = {
  id: "coursera",
  capabilities: COURSERA_CAPABILITIES,

  matchesHost(hostname: string): boolean {
    return hostname === "coursera.org" || hostname.endsWith(".coursera.org");
  },

  isWatchUrl(url: string): boolean {
    try {
      const { pathname } = new URL(url);
      return LECTURE_URL_RE.test(pathname);
    } catch {
      return false;
    }
  },

  getVideoId(url: string): string | null {
    try {
      const { pathname } = new URL(url);
      const m = pathname.match(LECTURE_URL_RE);
      return m?.[1] ?? null;
    } catch {
      return null;
    }
  },

  findVideo(): HTMLVideoElement | null {
    return findLargestVideo();
  },

  stageInsets(
    _video: HTMLVideoElement,
  ): { top: number; bottom: number; side: number } {
    // Clears Coursera's top toolbar (~48 px) and bottom player controls (~56 px).
    return { top: 12, bottom: 56, side: 16 };
  },

  async fetchCaptions(opts: {
    videoId: string;
    preferLang?: string;
    signal: AbortSignal;
  }): Promise<CaptionFetchResult | null> {
    const { videoId, preferLang, signal } = opts;

    // ── Strategy 1: already-loaded textTracks on the <video> element ──────────
    try {
      const video = findLargestVideo();
      if (video) {
        const tracks = video.textTracks;
        const track = pickTextTrack(tracks, preferLang);
        if (track) {
          const cues = track.cues;
          if (cues && cues.length > 0) {
            const captions = textTrackCuesToCaptionCues(cues);
            if (captions.length > 0) {
              return {
                captions,
                sourceLang: track.language || null,
                trackName: track.label || undefined,
              };
            }
          }

          // ── Strategy 2: track has a fetchable src (VTT URL) ────────────────
          // Find the matching <track> element to get its src attribute.
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
                    sourceLang: track.language || null,
                    trackName: track.label || undefined,
                  };
                }
              }
            } catch {
              // Fetch failed (e.g. signal aborted, CDN error) — fall through to API
            }
          }
        }
      }
    } catch {
      // DOM access failed — fall through to API
    }

    // ── Strategy 3: Coursera onDemandLectureVideos API ────────────────────────
    try {
      const apiUrl =
        `https://api.coursera.org/api/onDemandLectureVideos.v1/${encodeURIComponent(videoId)}` +
        `?fields=sources,subtitles,subtitlesVtt,subtitlesTxt`;
      const res = await fetch(apiUrl, { credentials: "include", signal });
      if (!res.ok) return null;

      const json = (await res.json()) as unknown;
      // Guard every level — API shape not live-verified
      if (!json || typeof json !== "object") return null;
      const elements = (json as Record<string, unknown>)["elements"];
      if (!Array.isArray(elements) || elements.length === 0) return null;
      const element = elements[0] as Record<string, unknown>;
      if (!element || typeof element !== "object") return null;

      // subtitlesVtt is a language→URL map, e.g. { "en": "https://…/en.vtt" }
      const subtitlesVtt = element["subtitlesVtt"];
      if (subtitlesVtt && typeof subtitlesVtt === "object") {
        const vttMap = subtitlesVtt as Record<string, string>;
        const picked = pickCourseraApiTrack(vttMap, preferLang);
        if (picked) {
          const [langCode, vttUrl] = picked;
          try {
            const vttRes = await fetch(vttUrl, { credentials: "include", signal });
            if (vttRes.ok) {
              const vttText = await vttRes.text();
              const captions = parseVtt(vttText);
              if (captions.length > 0) {
                return { captions, sourceLang: langCode, trackName: langCode };
              }
            }
          } catch {
            // VTT fetch failed — continue to subtitles map below
          }
        }
      }

      // subtitles is also a language→URL map (plain text / alt format)
      const subtitles = element["subtitles"];
      if (subtitles && typeof subtitles === "object") {
        const subMap = subtitles as Record<string, string>;
        const picked = pickCourseraApiTrack(subMap, preferLang);
        if (picked) {
          const [langCode, vttUrl] = picked;
          try {
            const vttRes = await fetch(vttUrl, { credentials: "include", signal });
            if (vttRes.ok) {
              const vttText = await vttRes.text();
              const captions = parseVtt(vttText);
              if (captions.length > 0) {
                return { captions, sourceLang: langCode, trackName: langCode };
              }
            }
          } catch {
            // VTT fetch failed
          }
        }
      }
    } catch {
      // API fetch failed (network error, abort, parse error)
    }

    return null;
  },

  readLiveCaptionText(): string | null {
    // We drive our own subtitle overlay; no need to scrape Coursera's native
    // caption UI. Return null — source-overlay line stays empty without throwing.
    return null;
  },

  suppressNativeCaptions(): () => void {
    // Coursera renders its own caption overlay. Hide <track> elements while
    // dubbing so the two caption stacks do not conflict.
    const hidden: Array<{ el: HTMLTrackElement; mode: TextTrackMode }> = [];
    const video = findLargestVideo();
    if (video) {
      const trackEls = video.querySelectorAll<HTMLTrackElement>("track");
      for (const el of trackEls) {
        if (el.track) {
          hidden.push({ el, mode: el.track.mode });
          el.track.mode = "hidden";
        }
      }
    }
    return () => {
      for (const { el, mode } of hidden) {
        if (el.track) el.track.mode = mode;
      }
    };
  },
};

// ─── Internal helpers (not exported) ─────────────────────────────────────────

/**
 * Find the <track> DOM element that corresponds to a given TextTrack object.
 * Matches by language and kind (label is a tiebreaker).
 */
function findTrackElement(
  video: HTMLVideoElement,
  track: TextTrack,
): HTMLTrackElement | null {
  const els = video.querySelectorAll<HTMLTrackElement>("track");
  for (const el of els) {
    if (
      el.track === track ||
      (el.kind === track.kind &&
        el.srclang === track.language)
    ) {
      return el;
    }
  }
  return null;
}
