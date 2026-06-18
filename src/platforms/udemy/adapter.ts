// Udemy platform adapter.
//
// Caption path: Udemy uses Widevine DRM (Shaka Player) on PAID content, so
// `captureStream` is hard-blocked by Chrome there — but free previews and some
// non-DRM lectures CAN be captured. `capabilities.audioCapture` stays `false`
// (the platform is *generally* DRM); `canCaptureAudioNow(video)` refines that
// per-lecture at the no-caption fallback branch via a fast EME probe, so a
// non-DRM lecture with no captions can still fall back to audio→STT→TTS.
//
// Captions are fetched via the undocumented api-2.0 subscribed-courses endpoint
// using the user's existing session cookies (same-origin). Every failure step is
// logged with the shared `[echoly-cc]` prefix so it can be self-diagnosed on a
// real page. The adapter returns `null` when no usable caption track exists.

import type {
  PlatformAdapter,
  PlatformCapabilities,
  CaptionFetchResult,
} from "@/shared/platform-ports";
import { CAPTION_BOTTOM_INSET } from "@/shared/platform-ports";
import { parseVtt } from "@/lib/vtt-parse";

// ─── Diagnostics ────────────────────────────────────────────────────────────────

/**
 * Diagnostic logger for Udemy caption acquisition — visible in the PAGE console.
 * Shares the `[echoly-cc]` prefix with the YouTube caption waterfall (cclog) so
 * all caption diagnostics filter together. Used at every `return null` so a user
 * on a real Udemy page can see WHICH step failed without a debugger.
 */
function udlog(...args: unknown[]): void {
  console.info("[echoly-cc]", "udemy:", ...args);
}

/** Truncate a (possibly signed) caption CDN URL before logging it. */
function safeUrl(u: string | undefined): string {
  if (!u) return "(none)";
  return u.length > 80 ? u.slice(0, 80) + "…" : u;
}

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

/** Course slug from the taking-page URL (always present; no DOM needed). */
function extractSlug(): string | null {
  try {
    const m = location.pathname.match(/\/course\/([^/]+)\//);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

// ─── Auth headers ────────────────────────────────────────────────────────────────

/**
 * Headers for the api-2.0 calls. Same-origin on www.udemy.com → `credentials:
 * "include"` already sends the session cookies (no CORS preflight), but some
 * Udemy edge nodes additionally want the explicit bearer / client-id / snail-case
 * headers (confirmed by yt-dlp + the Kahirul fork). We read them from
 * `document.cookie` when available (non-HttpOnly); if HttpOnly, the cookie is
 * still sent automatically by `credentials:"include"`, so this is belt-and-braces.
 */
function udemyApiHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/json, text/plain, */*",
    // Reliability: stops the CDN serving a cached logged-OUT response.
    "x-udemy-cache-logged-in": "1",
    "X-Requested-With": "XMLHttpRequest",
  };
  try {
    const jar: Record<string, string> = {};
    for (const part of document.cookie.split(";")) {
      const i = part.indexOf("=");
      if (i === -1) continue;
      jar[part.slice(0, i).trim()] = part.slice(i + 1);
    }
    const token = jar["access_token"];
    if (token) {
      h["Authorization"] = `Bearer ${token}`;
      h["X-Udemy-Bearer-Token"] = token;
    }
    if (jar["client_id"]) h["X-Udemy-Client-Id"] = jar["client_id"];
  } catch {
    // document.cookie unavailable — credentials:"include" still carries the session
  }
  return h;
}

// ─── courseId resolution ─────────────────────────────────────────────────────────
//
// The numeric courseId is NOT in the lecture URL (only the slug is). The legacy
// DOM-scrape approach is unreliable on the current React taking page (yt-dlp issue
// #15681, Jan-2026: ng-init / data-course-id / "courseId" all gone). So we try a
// cheap DOM fast-path first, then fall back to the ROBUST method used by active
// downloaders: resolve slug → courseId via the subscribed-courses list API.

/** slug → courseId, cached for the content-script lifetime (slug↦id is stable). */
const courseIdCache = new Map<string, string>();

/** Read `courseId` out of a `data-module-args` JSON attribute value. */
function courseIdFromModuleArgs(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const id = parsed["courseId"];
    if (id != null) return String(id);
  } catch {
    // malformed JSON — caller falls through to the next strategy
  }
  return null;
}

/**
 * FAST PATH — try to read courseId straight from the DOM (zero network). These
 * patterns are brittle (Udemy keeps changing them), so this is best-effort; a
 * miss is normal and falls through to the API resolver.
 */
function extractCourseIdFromDom(): string | null {
  const probes: Array<() => string | null> = [
    // current React taking-page module
    () => courseIdFromModuleArgs(
      document.querySelector('[data-module-id="course-taking"]')?.getAttribute("data-module-args") ?? null,
    ),
    // React component props carrying courseId
    () => courseIdFromModuleArgs(
      document.querySelector('[data-component-props*="courseId"]')?.getAttribute("data-component-props") ?? null,
    ),
    // legacy AngularJS app loader
    () => courseIdFromModuleArgs(
      document.querySelector(".ud-app-loader")?.getAttribute("data-module-args") ?? null,
    ),
    // embedded bootstrap JSON inside <script> tags (scoped, not whole-page)
    () => {
      const scripts = document.querySelectorAll("script:not([src])");
      for (const s of Array.from(scripts)) {
        const text = s.textContent;
        if (!text || text.indexOf("courseId") === -1) continue;
        const m = text.match(/"courseId"\s*:\s*(\d+)/);
        if (m?.[1]) return m[1];
      }
      return null;
    },
    // landing-page / older body attributes
    () =>
      document.body?.getAttribute("data-clp-course-id") ??
      document.body?.getAttribute("data-course-id") ??
      null,
  ];
  for (const probe of probes) {
    try {
      const id = probe();
      if (id) return id;
    } catch {
      /* next probe */
    }
  }
  return null;
}

/**
 * ROBUST PATH — resolve the numeric courseId from the URL slug via the
 * subscribed-courses LIST API (the user's enrollment list), then match the slug
 * against each course's `published_title` / `url`. This is what active 2025/2026
 * Udemy downloaders use; it needs no DOM scraping and survives Udemy DOM churn.
 *
 * Only the user's ENROLLED courses appear here — a slug that doesn't match means
 * "not enrolled / preview" (the lecture caption endpoint would 403 anyway).
 */
async function resolveCourseIdViaApi(
  slug: string,
  signal: AbortSignal,
): Promise<string | null> {
  const cached = courseIdCache.get(slug);
  if (cached) return cached;

  const url =
    "https://www.udemy.com/api-2.0/users/me/subscribed-courses/" +
    "?fields[course]=id,url,published_title&ordering=-last_accessed&page=1&page_size=10000";

  const res = await fetch(url, {
    credentials: "include",
    signal,
    headers: udemyApiHeaders(),
  });
  if (!res.ok) {
    udlog("subscribed-courses list non-ok", { status: res.status, slug });
    return null;
  }

  const json = (await res.json()) as { results?: Array<Record<string, unknown>> };
  const results = Array.isArray(json.results) ? json.results : [];
  const match = results.find((c) => {
    const title = typeof c["published_title"] === "string" ? c["published_title"] : "";
    const cUrl = typeof c["url"] === "string" ? c["url"] : "";
    return title === slug || cUrl.includes(`/course/${slug}/`);
  });
  const id = match?.["id"];
  if (id != null) {
    courseIdCache.set(slug, String(id));
    return String(id);
  }

  udlog("slug not found in subscribed-courses (not enrolled / preview?)", {
    slug,
    enrolledCount: results.length,
  });
  return null;
}

/**
 * Resolve the numeric courseId: DOM fast-path → API resolver. Logs which path
 * won so a real page can be diagnosed.
 */
async function resolveCourseId(signal: AbortSignal): Promise<string | null> {
  const fromDom = extractCourseIdFromDom();
  if (fromDom) return fromDom;

  const slug = extractSlug();
  if (!slug) {
    udlog("no courseId — DOM probes missed and no slug in URL");
    return null;
  }
  try {
    const fromApi = await resolveCourseIdViaApi(slug, signal);
    if (fromApi) {
      udlog("courseId resolved via subscribed-courses API", { slug, courseId: fromApi });
      return fromApi;
    }
  } catch (err) {
    udlog("subscribed-courses resolve threw", String(err));
  }
  return null;
}

// ─── Caption track selection ───────────────────────────────────────────────────

interface UdemyCaption {
  locale_id?: string;
  /** Some responses only carry the nested locale object instead of `locale_id`. */
  locale?: { locale?: string } | null;
  video_label?: string;
  url?: string;
  title?: string;
  /** `"auto"` marks an auto-generated/auto-translated track (vs an uploaded CC). */
  source?: string;
  /** `true` when the track is a translation of the original audio, not the source. */
  is_translation?: boolean;
  /** Processing status — `1` = ready. Other numbers = still transcoding (skip). */
  status?: number;
}

/** A caption is usable if it has a VTT url and is ready (status 1 or unset). */
function isReadyCaption(c: UdemyCaption): boolean {
  return !!c.url && (c.status == null || c.status === 1);
}

/** Lower-cased locale of a caption track, tolerating the nested `locale` object. */
function captionLocale(c: UdemyCaption): string {
  return (c.locale_id ?? c.locale?.locale ?? "").toLowerCase();
}

/** A locale string matches a BCP-47 lang prefix (e.g. "en" ↔ "en_US"/"en-GB"). */
function localeMatches(locale: string, lang: string): boolean {
  const l = lang.toLowerCase();
  return locale === l || locale.startsWith(l + "_") || locale.startsWith(l + "-");
}

/** Auto-generated or auto-translated track — NOT the genuine uploaded source. */
function isAutoCaption(c: UdemyCaption): boolean {
  return c.source === "auto" || c.is_translation === true;
}

/**
 * Pick the best caption track from the api-2.0 captions array.
 *
 * Goal: dub from the GENUINE source track (e.g. "English [CC]"), never from an
 * auto-translation, and never from the output/target language.
 *
 * Order (first match wins):
 *   1. non-auto track matching `preferLang`
 *   2. non-auto track in any language (excluding `avoidLang`)
 *   3. any track matching `preferLang` (excluding `avoidLang`)
 *   4. first track NOT in `avoidLang`
 *   5. first track (last resort)
 *
 * Returns `null` when the array is empty.
 */
function pickCaptionTrack(
  captions: UdemyCaption[],
  preferLang?: string,
  avoidLang?: string,
): UdemyCaption | null {
  if (!captions.length) return null;

  const usable = captions.filter(isReadyCaption);
  if (!usable.length) return null;

  const avoid = avoidLang?.toLowerCase();
  const notAvoided = (c: UdemyCaption) =>
    !avoid || !localeMatches(captionLocale(c), avoid);
  const candidates = usable.filter(notAvoided);

  // preferLang matches across all candidates (computed once, used at 1 and 3)
  const preferMatches = preferLang
    ? candidates.filter((c) => localeMatches(captionLocale(c), preferLang))
    : [];

  // 1 — non-auto ∧ preferLang
  const preferNonAuto = preferMatches.find((c) => !isAutoCaption(c));
  if (preferNonAuto) return preferNonAuto;

  // 2 — non-auto in any language (excluding avoidLang)
  const nonAuto = candidates.find((c) => !isAutoCaption(c));
  if (nonAuto) return nonAuto;

  // 3 — any track matching preferLang (auto allowed at this point)
  if (preferMatches[0]) return preferMatches[0];

  // 4 — first non-avoided track
  if (candidates[0]) return candidates[0];

  // No usable SOURCE track: every track is in avoidLang (the output language).
  // Return null rather than dub target→target — the caller then falls through to
  // the audio→STT→TTS path, which captures the real source audio.
  return null;
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

  // ─── Per-lecture audio-capture refinement ────────────────────────────────

  /**
   * Runtime refinement of the static `audioCapture: false` flag.
   *
   * Udemy is GENERALLY DRM, but free previews and some non-DRM lectures CAN be
   * captured. Widevine attaches EME `MediaKeys` to the `<video>` element; that
   * property is an IDL property on the Blink-shared element, so it is visible
   * from the content script's isolated world. When `mediaKeys` is set the stream
   * is encrypted and `captureStream` yields a silent (track-less) stream → refuse.
   * When it is `null` we OPTIMISTICALLY allow the audio→STT→TTS fallback;
   * `captureWithRetry` then validates (and fails fast, burning no credits, if the
   * stream truly has no audio).
   *
   * Residual: if the user presses Start on a DRM lecture BEFORE playback begins,
   * `mediaKeys` may not be attached yet → this returns `true` and the fallback
   * hits the captureWithRetry timeout. That is rare (no-captions ∧ DRM ∧ never
   * played) and still safe (no credits charged); gating on `readyState` instead
   * would wrongly REFUSE valid non-DRM lectures that have not loaded metadata.
   */
  canCaptureAudioNow(video: HTMLVideoElement): boolean {
    try {
      return video.mediaKeys == null;
    } catch {
      return false;
    }
  },

  /**
   * Insets clearing Udemy's Shaka player chrome:
   *   top: 12px  — thin progress bar / header gradient
   *   bottom: standardized clearance (shared const) above the control bar
   *   side: 16px — narrow side padding
   */
  stageInsets(_video: HTMLVideoElement): { top: number; bottom: number; side: number } {
    return { top: 12, bottom: CAPTION_BOTTOM_INSET, side: 16 };
  },

  // ─── Caption acquisition ────────────────────────────────────────────────

  /**
   * Fetch VTT captions via the undocumented Udemy api-2.0 endpoint.
   *
   * Flow:
   *   1. Resolve courseId: DOM fast-path → subscribed-courses API (slug→id).
   *   2. lectureId is the videoId param (extracted from the URL by getVideoId).
   *   3. GET api-2.0/users/me/subscribed-courses/<courseId>/lectures/<lectureId>/
   *      with session cookies (credentials:"include") + udemy api headers.
   *   4. Parse asset.captions[], pick the genuine source track (non-auto, ready,
   *      honoring preferLang/avoidLang), fetch the VTT URL.
   *   5. parseVtt → CaptionCue[].
   *
   * Returns `null` on any failure or when no captions are available — and logs
   * the exact failing step with the `[echoly-cc]` prefix. NEVER throws.
   */
  async fetchCaptions(opts: {
    videoId: string;
    preferLang?: string;
    avoidLang?: string;
    signal: AbortSignal;
  }): Promise<CaptionFetchResult | null> {
    const { videoId, preferLang, avoidLang, signal } = opts;

    try {
      const courseId = await resolveCourseId(signal);
      if (!courseId) {
        // resolveCourseId already logged the specific reason.
        return null;
      }

      const lectureId = videoId;

      const apiUrl =
        `https://www.udemy.com/api-2.0/users/me/subscribed-courses/${courseId}` +
        `/lectures/${lectureId}/` +
        `?fields[lecture]=asset&fields[asset]=captions,download_urls,course_is_drmed`;

      const lectureRes = await fetch(apiUrl, {
        credentials: "include",
        signal,
        headers: udemyApiHeaders(),
      });

      if (!lectureRes.ok) {
        udlog("api-2.0 lecture request non-ok", {
          status: lectureRes.status,
          courseId,
          lectureId,
        });
        return null;
      }

      const lectureJson = (await lectureRes.json()) as Record<string, unknown>;

      // Navigate: lectureJson.asset.captions[]
      const asset = lectureJson["asset"] as Record<string, unknown> | undefined;
      if (!asset) {
        udlog("api-2.0 response has no asset field", { courseId, lectureId });
        return null;
      }

      const rawCaptions = asset["captions"];
      if (!Array.isArray(rawCaptions) || rawCaptions.length === 0) {
        udlog("asset.captions is empty/absent", { courseId, lectureId });
        return null;
      }

      const captions = rawCaptions as UdemyCaption[];

      const track = pickCaptionTrack(captions, preferLang, avoidLang);
      if (!track?.url) {
        udlog("no usable caption track after pick", {
          total: captions.length,
          locales: captions.map(captionLocale),
          preferLang,
          avoidLang,
        });
        return null;
      }

      // The VTT lives on a CROSS-ORIGIN CloudFront host (vtt-c.udemycdn.com), not
      // www.udemy.com. Its signed query params (Expires/Signature/Key-Pair-Id) ARE
      // the auth, so session cookies are neither needed nor allowed: CloudFront
      // serves these with `Access-Control-Allow-Origin: *`, and per the Fetch spec a
      // `*` ACAO is invalid for a credentialed request → the browser blocks the read
      // ("Access-Control-Allow-Credentials … must be 'true'"). `credentials:"omit"`
      // sends a plain cross-origin GET that the wildcard ACAO permits. (The api-2.0
      // calls above are SAME-ORIGIN to www.udemy.com and correctly keep "include".)
      const vttRes = await fetch(track.url, { credentials: "omit", signal });
      if (!vttRes.ok) {
        udlog("VTT fetch non-ok", { status: vttRes.status, url: safeUrl(track.url) });
        return null;
      }

      const vttText = await vttRes.text();
      const cues = parseVtt(vttText);

      if (cues.length === 0) {
        udlog("VTT parsed but yielded 0 cues", { url: safeUrl(track.url) });
        return null;
      }

      return {
        captions: cues,
        sourceLang: track.locale_id ?? track.locale?.locale ?? null,
        trackName: track.title ?? track.video_label ?? undefined,
      };
    } catch (err) {
      // AbortError, network failure, JSON parse failure — all collapse to null.
      udlog("fetchCaptions threw", String(err));
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

  getVideoTitle(): string | null {
    return document.title?.trim() || null;
  },

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
