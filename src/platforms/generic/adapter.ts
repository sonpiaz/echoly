// Generic / fallback platform adapter.
//
// Returned by the registry when no specific adapter matches the current
// hostname. Assumes a plain HTML5 <video> page with no platform-specific
// caption API or player chrome knowledge.
//
// Capabilities:
//   audioCapture: true   — standard HTML5 video, no DRM assumed
//   subtitleFirst: false — no caption API; fall back to WebRTC-Standard audio
//   isSpa: false         — full-page reload between navigations assumed
//   hasNativeCaptions: false
//   hasAdOverlays: false

import type {
  PlatformAdapter,
  PlatformCapabilities,
  CaptionFetchResult,
} from "@/shared/platform-ports";

const GENERIC_CAPABILITIES: PlatformCapabilities = {
  audioCapture: true,
  subtitleFirst: false,
  isSpa: false,
  hasNativeCaptions: false,
  hasAdOverlays: false,
};

/**
 * Find the largest visible `<video>` element on the page.
 *
 * "Visible" is defined as having a bounding rect of at least 160 × 90 px
 * (ignores thumbnail / preview elements). When multiple videos pass that
 * threshold, the one with the greatest bounding-box area wins.
 *
 * This is a direct copy of the `pickLargestVisibleVideo` logic from
 * `src/content/media-stage.ts` — replicated rather than imported so that the
 * generic adapter has zero dependency on the legacy media-stage module (which
 * owner D will refactor).
 */
function pickLargestVisibleVideo(): HTMLVideoElement | null {
  let best: HTMLVideoElement | null = null;
  let bestArea = 0;
  for (const el of document.querySelectorAll("video")) {
    const r = el.getBoundingClientRect();
    if (r.width < 160 || r.height < 90) continue;
    const area = r.width * r.height;
    if (area > bestArea) {
      bestArea = area;
      best = el;
    }
  }
  return best;
}

export const genericAdapter: PlatformAdapter = {
  id: "generic",
  capabilities: GENERIC_CAPABILITIES,

  // The generic adapter is never selected by hostname matching — the registry
  // returns it explicitly when ADAPTERS.find() returns undefined. Returning
  // false here ensures it can never "steal" a hostname from a real adapter if
  // someone were to accidentally include it in the ADAPTERS array.
  matchesHost(_hostname: string): boolean {
    return false;
  },

  // On a generic page we optimistically treat every URL as a watch URL since
  // we have no structural knowledge. The caller (auto-start) will find no
  // video and bail out naturally.
  isWatchUrl(_url: string): boolean {
    return true;
  },

  getVideoId(url: string): string | null {
    try {
      const pathname = new URL(url).pathname;
      // Use the full pathname as a stable id so that distinct URLs on the same
      // origin produce distinct ids. Strip leading/trailing slashes.
      const id = pathname.replace(/^\/+|\/+$/g, "");
      return id || null;
    } catch {
      return null;
    }
  },

  findVideo(): HTMLVideoElement | null {
    return pickLargestVisibleVideo();
  },

  stageInsets(_video: HTMLVideoElement): { top: number; bottom: number; side: number } {
    // Conservative defaults that match the "generic" branch of the legacy
    // media-stage.ts stageInsets() function.
    return { bottom: 56, top: 44, side: 16 };
  },

  async fetchCaptions(_opts: {
    videoId: string;
    preferLang?: string;
    signal: AbortSignal;
  }): Promise<CaptionFetchResult | null> {
    // Generic pages have no known caption API.
    return null;
  },

  readLiveCaptionText(): string | null {
    // Generic pages have no known live-caption DOM.
    return null;
  },
};
