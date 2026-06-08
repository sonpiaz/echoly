// YouTube platform adapter.
//
// Implements `PlatformAdapter` for youtube.com. Wraps the existing YouTube
// logic (behavior-preserving) moved into this directory.

import type { PlatformAdapter, PlatformCapabilities, CaptionFetchResult } from "@/shared/platform-ports";
import { getYouTubeVideoId } from "./captions";
import { fetchYouTubeCaptionsWithSettle, readPlayerResponseFromDom } from "./captions-fetch";
import { installYoutubeCaptionCache } from "./caption-cache";
import { isYouTubeAdPlaying, getYouTubeAdSignalTarget } from "./ad-state";
import { suppressYouTubeNativeCaptions } from "./native-captions";

const YOUTUBE_CAPABILITIES: PlatformCapabilities = {
  audioCapture: true,
  subtitleFirst: true,
  isSpa: true,
  hasNativeCaptions: true,
  hasAdOverlays: true,
};

/**
 * Find the YouTube primary `<video>` element using fast-path selectors from
 * the legacy `media-stage.ts` YouTube branch, with a largest-visible fallback.
 */
function findYouTubeVideo(): HTMLVideoElement | null {
  return (
    document.querySelector<HTMLVideoElement>("video.html5-main-video") ||
    document.querySelector<HTMLVideoElement>(".html5-video-player video") ||
    document.querySelector<HTMLVideoElement>("video")
  );
}

export const youtubeAdapter: PlatformAdapter = {
  id: "youtube",
  capabilities: YOUTUBE_CAPABILITIES,

  matchesHost(hostname: string): boolean {
    const h = hostname.replace(/^www\./, "");
    return h === "youtube.com" || h.endsWith(".youtube.com");
  },

  isWatchUrl(url: string): boolean {
    // Matches the existing isYouTubeWatchUrl + isYouTubeWatchPage logic found
    // in `shared/active-site.ts` and `content/pipelines/youtube-captions-fetch.ts`.
    try {
      const u = new URL(url);
      if (!u.hostname.includes("youtube.com")) return false;
      // Watch page: /watch?v=...
      if (u.pathname === "/watch" && u.searchParams.has("v")) return true;
      // Embedded player: /embed/<videoId>
      if (/^\/embed\/[^/?]+/.test(u.pathname)) return true;
      return false;
    } catch {
      return false;
    }
  },

  getVideoId(url: string): string | null {
    return getYouTubeVideoId(url);
  },

  findVideo(): HTMLVideoElement | null {
    return findYouTubeVideo();
  },

  stageInsets(_video: HTMLVideoElement): { top: number; bottom: number; side: number } {
    // YouTube player chrome: 72px controls bar at bottom, 52px top chrome,
    // 20px horizontal padding. Matches the legacy `stageInsets("youtube")` in
    // `src/content/media-stage.ts`.
    return { bottom: 72, top: 52, side: 20 };
  },

  async fetchCaptions(opts: {
    videoId: string;
    preferLang?: string;
    avoidLang?: string;
    signal: AbortSignal;
  }): Promise<CaptionFetchResult | null> {
    // Pass preferLang AS-IS: `undefined` means "auto" (pick the original/ASR
    // track); a defined code is the user's explicit source choice and must win.
    // Do NOT default to "en" here — that would erase the auto/explicit distinction.
    return fetchYouTubeCaptionsWithSettle(
      opts.videoId,
      opts.preferLang,
      opts.signal,
      undefined,
      opts.avoidLang,
    );
  },

  readLiveCaptionText(): string | null {
    // Scrape the currently-rendered caption segment text from the YT player.
    // Matches the `readYTCaptions()` logic in `src/content/index.ts`.
    const segs = document.querySelectorAll(".ytp-caption-segment");
    if (!segs.length) return null;
    const text = Array.from(segs)
      .map((s) => s.textContent)
      .join(" ")
      .trim()
      .replace(/\s+/g, " ");
    return text || null;
  },

  suppressNativeCaptions(): () => void {
    return suppressYouTubeNativeCaptions();
  },

  isAdPlaying(): boolean {
    return isYouTubeAdPlaying();
  },

  getAdSignalTarget(): Element | null {
    // #movie_player — the element YouTube flips `ad-showing`/`ad-interrupting`
    // on. The AdWatcher observes its `class` attribute for instant ad detection.
    return getYouTubeAdSignalTarget();
  },

  shouldIgnorePlaybackEvent(_ev: Event, _video: HTMLVideoElement): boolean {
    return isYouTubeAdPlaying();
  },

  installBackgroundServices(): void {
    installYoutubeCaptionCache();
  },

  getVideoTitle(): string | null {
    // Prefer structured player response — most reliable, no page-title suffix.
    try {
      const pr = readPlayerResponseFromDom();
      const details = pr?.["videoDetails"] as Record<string, unknown> | undefined;
      const title = details?.["title"];
      if (typeof title === "string" && title.trim()) {
        return title.trim();
      }
    } catch {
      /* fall through */
    }
    // Fallback: document.title strips the trailing " - YouTube" suffix.
    const raw = document.title ?? "";
    return raw.replace(/\s*-\s*YouTube\s*$/i, "").trim() || null;
  },
};
