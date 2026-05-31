// Udemy platform adapter.
//
// Caption-only path: Udemy uses Widevine DRM (Shaka Player) for paid content,
// so `captureStream` / tabCapture is hard-blocked by Chrome at the browser
// level. `audioCapture: false` is a LOAD-BEARING flag — the pipeline reads it
// to refuse the WebRTC fallback and avoid burning credits on a silent stream.
//
// Captions are fetched via the undocumented api-2.0 subscribed-courses endpoint
// using the user's existing session cookies (same-origin). Not all lectures have
// captions; the adapter returns `null` when the caption array is empty so the
// caller (SubtitleFirstPipeline) can surface the "unsupported on this video" path.

import type {
  PlatformAdapter,
  PlatformCapabilities,
  CaptionFetchResult,
} from "@/shared/platform-ports";
import { parseVtt } from "@/lib/vtt-parse";

// ─── Capabilities ──────────────────────────────────────────────────────────────

const UDEMY_CAPABILITIES: PlatformCapabilities = {
  /**
   * FALSE — Widevine DRM hard-blocks captureStream on paid courses.
   * The pipeline uses this flag to refuse the WebRTC fallback.
   */
  audioCapture: false,
  /** Caption-driven subtitle-first dub via api-2.0 VTT endpoint. */
  subtitleFirst: true,
  /** React SPA — history.pushState navigation between lectures. */
  isSpa: true,
  /** Udemy renders its own caption overlay; we suppress it while dubbing. */
  hasNativeCaptions: true,
  /** No YouTube-style mid-roll ad overlays. */
  hasAdOverlays: false,
};

// ─── URL helpers ───────────────────────────────────────────────────────────────

/**
 * Lecture URL pattern: /course/<slug>/learn/lecture/<lectureId>[/...]
 * e.g. https://www.udemy.com/course/python-bootcamp/learn/lecture/12345678
 */
const LECTURE_RE = /\/course\/[^/]+\/learn\/lecture\/(\d+)/;

// ─── courseId extraction ───────────────────────────────────────────────────────

/**
 * Extract the Udemy courseId from the DOM.
 *
 * Primary: `.ud-app-loader[data-module-args]` JSON → `courseId`.
 * Fallback: `body[data-clp-course-id]`.
 *
 * Returns `null` on any failure (guarded against missing elements / malformed
 * JSON — this adapter is written to a documented DOM contract, not live-verified).
 */
function extractCourseId(): string | null {
  try {
    const loader = document.querySelector(".ud-app-loader");
    if (loader) {
      const raw = loader.getAttribute("data-module-args");
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const id = parsed["courseId"];
        if (id != null) return String(id);
      }
    }
  } catch {
    // ignore JSON parse error, fall through to secondary
  }

  try {
    const bodyId = document.body?.getAttribute("data-clp-course-id");
    if (bodyId) return bodyId;
  } catch {
    // ignore
  }

  return null;
}

// ─── Caption track selection ───────────────────────────────────────────────────

interface UdemyCaption {
  locale_id?: string;
  video_label?: string;
  url?: string;
  title?: string;
}

/**
 * Pick the best caption track from the api-2.0 captions array.
 *
 * Matching strategy:
 *   1. Exact `locale_id` prefix match against `preferLang` (e.g. "en" matches
 *      "en_US", "en_GB").
 *   2. First available track when no `preferLang` given or no match found.
 *
 * Returns `null` when the array is empty or no usable track is found.
 */
function pickCaptionTrack(
  captions: UdemyCaption[],
  preferLang?: string,
): UdemyCaption | null {
  if (!captions.length) return null;

  if (preferLang) {
    const lang = preferLang.toLowerCase();
    const match = captions.find((c) => {
      const locale = (c.locale_id ?? "").toLowerCase();
      return locale === lang || locale.startsWith(lang + "_") || locale.startsWith(lang + "-");
    });
    if (match) return match;
  }

  // Fall back to first track
  return captions[0] ?? null;
}

// ─── Adapter ───────────────────────────────────────────────────────────────────

export const udemyAdapter: PlatformAdapter = {
  id: "udemy",
  capabilities: UDEMY_CAPABILITIES,

  // ─── Registry dispatch ──────────────────────────────────────────────────

  matchesHost(hostname: string): boolean {
    return hostname === "udemy.com" || hostname.endsWith(".udemy.com");
  },

  // ─── URL classification ─────────────────────────────────────────────────

  isWatchUrl(url: string): boolean {
    try {
      const pathname = new URL(url).pathname;
      return LECTURE_RE.test(pathname);
    } catch {
      return false;
    }
  },

  getVideoId(url: string): string | null {
    try {
      const pathname = new URL(url).pathname;
      const m = pathname.match(LECTURE_RE);
      return m?.[1] ?? null;
    } catch {
      return null;
    }
  },

  // ─── DOM queries ────────────────────────────────────────────────────────

  /**
   * Find the primary `<video>` element.
   *
   * The stream is Widevine-protected so capture won't work, but we still need
   * the element for overlay positioning and `video.currentTime` sync used by
   * the subtitle-dub driver.
   */
  findVideo(): HTMLVideoElement | null {
    return document.querySelector("video");
  },

  /**
   * Insets clearing Udemy's Shaka player chrome:
   *   top: 12px  — thin progress bar / header gradient
   *   bottom: 56px — control bar height
   *   side: 16px — narrow side padding
   */
  stageInsets(_video: HTMLVideoElement): { top: number; bottom: number; side: number } {
    return { top: 12, bottom: 56, side: 16 };
  },

  // ─── Caption acquisition ────────────────────────────────────────────────

  /**
   * Fetch VTT captions via the undocumented Udemy api-2.0 endpoint.
   *
   * Flow:
   *   1. Extract courseId from the DOM (.ud-app-loader data-module-args).
   *   2. lectureId is the videoId param (extracted from the URL by getVideoId).
   *   3. GET api-2.0/users/me/subscribed-courses/<courseId>/lectures/<lectureId>/
   *      with session cookies (credentials:"include").
   *   4. Parse asset.captions[], pick by preferLang, fetch the VTT URL.
   *   5. parseVtt → CaptionCue[].
   *
   * Returns `null` on any failure or when no captions are available.
   * NEVER throws — all errors are caught and collapsed to null.
   */
  async fetchCaptions(opts: {
    videoId: string;
    preferLang?: string;
    signal: AbortSignal;
  }): Promise<CaptionFetchResult | null> {
    const { videoId, preferLang, signal } = opts;

    try {
      const courseId = extractCourseId();
      if (!courseId) return null;

      const lectureId = videoId;

      const apiUrl =
        `https://www.udemy.com/api-2.0/users/me/subscribed-courses/${courseId}` +
        `/lectures/${lectureId}/` +
        `?fields[lecture]=asset&fields[asset]=captions,download_urls`;

      const lectureRes = await fetch(apiUrl, {
        credentials: "include",
        signal,
        headers: { Accept: "application/json, text/plain, */*" },
      });

      if (!lectureRes.ok) return null;

      const lectureJson = (await lectureRes.json()) as Record<string, unknown>;

      // Navigate: lectureJson.asset.captions[]
      const asset = lectureJson["asset"] as Record<string, unknown> | undefined;
      if (!asset) return null;

      const rawCaptions = asset["captions"];
      if (!Array.isArray(rawCaptions) || rawCaptions.length === 0) return null;

      const captions = rawCaptions as UdemyCaption[];

      const track = pickCaptionTrack(captions, preferLang);
      if (!track?.url) return null;

      const vttRes = await fetch(track.url, { signal });
      if (!vttRes.ok) return null;

      const vttText = await vttRes.text();
      const cues = parseVtt(vttText);

      if (cues.length === 0) return null;

      return {
        captions: cues,
        sourceLang: track.locale_id ?? null,
        trackName: track.title ?? track.video_label ?? undefined,
      };
    } catch {
      // AbortError, network failure, JSON parse failure — all collapse to null
      return null;
    }
  },

  // ─── Live caption scraping ──────────────────────────────────────────────

  /**
   * Udemy renders captions inside its own Shaka player UI, but they are not
   * scraped live. Return null — the source-text overlay just stays empty.
   */
  readLiveCaptionText(): string | null {
    return null;
  },

  // ─── Optional hooks ─────────────────────────────────────────────────────

  /**
   * Hide Udemy's native caption element for the duration of the dub session.
   *
   * Udemy renders WebVTT captions via a `<track>` element. Setting `mode` to
   * `"hidden"` on every active TextTrack disables the on-screen rendering while
   * keeping the track loaded (so `currentTime` lookups still work). The restore
   * function re-enables any track that was "showing" before we touched it.
   */
  suppressNativeCaptions(): () => void {
    const restored: Array<{ track: TextTrack; mode: TextTrackMode }> = [];

    try {
      const video = document.querySelector("video");
      if (video) {
        for (const track of Array.from(video.textTracks)) {
          if (track.mode === "showing") {
            restored.push({ track, mode: "showing" });
            track.mode = "hidden";
          }
        }
      }
    } catch {
      // DOM not ready — no-op
    }

    return () => {
      for (const { track, mode } of restored) {
        try {
          track.mode = mode;
        } catch {
          // element may have been removed
        }
      }
    };
  },
};
