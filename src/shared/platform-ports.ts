// ─────────────────────────────────────────────────────────────────────────────
// LOCKED CONTRACT — platform adapter seam.
//
// Every platform-specific decision (find video, fetch captions, read live
// caption text, inset chrome, suppress native captions, route playback events)
// flows through the PlatformAdapter returned by the registry. Nothing outside
// src/platforms/ should contain platform-name string-checks.
//
// Field name NOTE: CaptionFetchResult.captions is named `captions` (not `cues`)
// to match the existing pipeline consumer:
//   subtitle-first-pipeline.ts:137  captionResult?.captions.length
//   subtitle-first-pipeline.ts:151  regroupToSentences(captionResult.captions)
// Do NOT rename.
// ─────────────────────────────────────────────────────────────────────────────

/** All platforms the extension knows about. `"generic"` is the catch-all. */
export type PlatformId = "youtube" | "coursera" | "udemy" | "generic";

/**
 * Immutable capability flags for a platform. Read once at session-start; do
 * NOT change at runtime (use stop-and-restart if the situation changes).
 */
export interface PlatformCapabilities {
  /**
   * Tab / element audio can be captured via `captureStream` or WebRTC.
   * `false` when the platform uses DRM (e.g. Udemy / Widevine) — Chrome
   * hard-blocks `captureStream` on Widevine-protected media.
   */
  audioCapture: boolean;

  /**
   * Caption-driven subtitle-first dub is available on this platform.
   * The platform exposes `<track>` VTT or a captions API that `fetchCaptions`
   * can reach.
   */
  subtitleFirst: boolean;

  /**
   * SPA — the platform navigates between videos without a full page reload
   * (YouTube, Coursera). The content script must watch `history.pushState` /
   * `popstate` / `navigation` events to detect video changes.
   */
  isSpa: boolean;

  /**
   * The platform renders its own caption UI while the video plays. The adapter
   * may implement `suppressNativeCaptions` to hide it while we dub so the two
   * caption stacks don't conflict.
   */
  hasNativeCaptions: boolean;

  /**
   * The platform shows ad overlays that pause / replace the main video
   * (YouTube mid-roll). `shouldIgnorePlaybackEvent` can filter these out so a
   * pause during an ad does not tear down the dub session.
   */
  hasAdOverlays: boolean;
}

/**
 * A single time-aligned caption cue. `start` and `end` are in **seconds**.
 * Both fields are always set (`end > start`); callers must not assume equal
 * duration between cues.
 */
export interface CaptionCue {
  /** Cue start time in seconds. */
  start: number;
  /** Cue end time in seconds. Always `> start`. */
  end: number;
  /** Plain text of the cue (inline tags stripped). */
  text: string;
}

/**
 * Return value of `PlatformAdapter.fetchCaptions`. `null` from the adapter
 * means no captions are available for this video / language combination.
 *
 * IMPORTANT: the field is named `captions` (not `cues`) to match the existing
 * `SubtitleFirstPipeline` consumers at lines :137 and :151.
 */
export interface CaptionFetchResult {
  /**
   * Ordered array of caption cues for the requested source language.
   * Sorted by `start`, every entry satisfies `start < end`.
   */
  captions: CaptionCue[];

  /**
   * BCP-47 language tag of the captions if known (e.g. `"en"`, `"vi"`),
   * `null` if the platform does not expose it.
   */
  sourceLang: string | null;

  /**
   * Human-readable name of the selected caption track (e.g. `"English (auto)"`),
   * if reported by the platform. Optional.
   */
  trackName?: string;
}

/**
 * Standardized clearance (px) between the bottom of the on-video caption stack
 * and the bottom edge of the player stage — i.e. how far the subtitle sits ABOVE
 * the player controls / seek bar. Single source of truth so every platform keeps
 * the SAME bottom gap (the caption stack is bottom-anchored, so this value also
 * governs the 2-line / realtime case — the card grows upward, its bottom stays).
 *
 * Raised from the old 56px: 56px left only a few px above YouTube's scrubber, so
 * a 2-line realtime caption visually overlapped the seek bar. 72px clears the
 * ~48–60px control region on YouTube/Udemy/Coursera with margin to spare.
 */
export const CAPTION_BOTTOM_INSET = 72;

/**
 * Per-platform strategy object.
 *
 * The registry (`src/platforms/registry.ts`) returns one instance per tab
 * session. All platform-specific decisions are delegated here; the content
 * script and background SW have ZERO inline platform-name checks.
 */
export interface PlatformAdapter {
  /** Stable platform identifier. */
  readonly id: PlatformId;

  /**
   * Immutable capability flags. Read once at session-start via
   * `detectAdapter(location.hostname).capabilities`.
   */
  readonly capabilities: PlatformCapabilities;

  // ─── Registry dispatch ──────────────────────────────────────────────────

  /**
   * Returns `true` if this adapter is responsible for the given hostname
   * (e.g. `"www.youtube.com"`, `"www.coursera.org"`). The registry iterates
   * `ADAPTERS` in order and returns the first match; the generic fallback
   * always returns `false` and is returned explicitly when nothing matches.
   */
  matchesHost(hostname: string): boolean;

  // ─── URL classification ─────────────────────────────────────────────────

  /**
   * Returns `true` when the URL is a playable lecture / watch page (as opposed
   * to a listing, home, or search page). The registry exposes
   * `isSupportedWatchUrl(url)` which delegates here; auto-start fires only
   * when this returns `true`.
   */
  isWatchUrl(url: string): boolean;

  /**
   * Returns a stable per-video identifier (used for caption caching and
   * session keying). Returns `null` if no stable id can be extracted (e.g. on
   * a generic page with no structured URL).
   */
  getVideoId(url: string): string | null;

  // ─── DOM queries ────────────────────────────────────────────────────────

  /**
   * Find the primary `<video>` element to dub. Returns `null` until the
   * element appears; the caller polls (typically every ~200 ms) until it is
   * non-null before starting the session.
   */
  findVideo(): HTMLVideoElement | null;

  /**
   * Insets (in px) so the Echoly overlay clears the platform's player chrome.
   * Shape matches the existing `media-stage.ts` `MediaStageInsets` type:
   * `{ top, bottom, side }` — do NOT invent `left`/`right` variants.
   *
   * `video` is provided so adapters that measure chrome from the video rect
   * can do so; most adapters return a constant.
   */
  stageInsets(video: HTMLVideoElement): { top: number; bottom: number; side: number };

  // ─── Caption acquisition ────────────────────────────────────────────────

  /**
   * Fetch and parse captions for the requested source language. Returns a
   * `CaptionFetchResult` on success, `null` when no captions are available
   * for this video / language combination.
   *
   * `opts.signal` must be respected — abort in-flight network calls when it
   * fires so credits are not burned on a cancelled session.
   */
  fetchCaptions(opts: {
    videoId: string;
    /** BCP-47 preferred source language (e.g. `"en"`). Optional — the adapter
     *  picks the best available (original) track when omitted. */
    preferLang?: string;
    /** BCP-47 output/target language to AVOID selecting as the source track
     *  (never dub target→target). Adapters may ignore it. */
    avoidLang?: string;
    signal: AbortSignal;
  }): Promise<CaptionFetchResult | null>;

  // ─── Live caption scraping ──────────────────────────────────────────────

  /**
   * Read the text currently rendered by the platform's own caption UI, for
   * display in the Echoly source-text overlay when `settings.showSource` is
   * enabled.
   *
   * YouTube: scrapes `.ytp-caption-segment` text nodes.
   * Platforms with no live-caption DOM: return `null` — the source-text line
   * stays empty without throwing.
   */
  readLiveCaptionText(): string | null;

  // ─── Optional hooks ─────────────────────────────────────────────────────

  /**
   * Hide the platform's own caption track for the duration of the dub session
   * (prevents two caption stacks from overlapping). Returns a restore function
   * that re-enables native captions when the session ends.
   *
   * Only implement when `capabilities.hasNativeCaptions` is `true`.
   */
  suppressNativeCaptions?(): () => void;

  /**
   * Returns `true` when `ev` should be ignored by the playback-event handler.
   * Used to filter spurious `pause` events fired during ad overlays (YouTube)
   * so the dub session is not torn down mid-ad.
   */
  shouldIgnorePlaybackEvent?(ev: Event, video: HTMLVideoElement): boolean;

  /**
   * Returns `true` when an ad is currently playing on this platform (e.g. a
   * YouTube pre/mid-roll). When implemented, `startSession` gates on this:
   * Translate pressed during an ad enters the "ad-wait" state and defers until
   * the ad ends, rather than translating the ad / mis-reporting "no captions".
   * It is ALSO the Stage-C `AdWatcher` poll backstop. Adapters that cannot detect
   * ads omit this (treated as "no ad detection").
   */
  isAdPlaying?(): boolean;

  /**
   * Returns the DOM element whose `class` attribute the platform flips when an
   * ad starts / ends (YouTube: `#movie_player` — it gains/loses `ad-showing` /
   * `ad-interrupting`). The Stage-C `AdWatcher` puts a `MutationObserver` on this
   * element's `class` attribute so it can pause the dub the SAME microtask the ad
   * starts (instant — no poll latency). `isAdPlaying()` stays the poll fallback.
   *
   * Returns `null` when the element is not present yet, OR for platforms with no
   * observable ad signal (those are poll-only / have no ads — the AdWatcher just
   * relies on its `isAdPlaying()` backstop). Optional: adapters that omit it are
   * treated as "no observer target".
   */
  getAdSignalTarget?(): Element | null;

  /**
   * Register background-SW services (e.g. `webRequest` intercept for the
   * YouTube timedtext cache). Called once at SW boot via
   * `installAllBackgroundServices()` in the registry.
   *
   * Only implement for platforms that need a SW-side hook. New platforms that
   * do their caption fetch content-side (DOM `<track>` / `fetch`) do NOT need
   * this.
   */
  installBackgroundServices?(): void;

  /**
   * Return the title of the current video, or `null` when unavailable.
   *
   * Used to populate `x-echoly-video-title` on server requests so the usage
   * dashboard can show a human-readable title instead of the site name.
   *
   * Default implementation: `document.title` (trimmed). Platform adapters
   * should override this to use a more reliable source (e.g. YouTube's
   * `ytInitialPlayerResponse.videoDetails.title`).
   *
   * Call at session start (after captions are fetched / the page is settled).
   * The returned value must be short enough to URL-encode safely; the server
   * clamps to 200 chars after `decodeURIComponent`.
   */
  getVideoTitle?(): string | null;
}
