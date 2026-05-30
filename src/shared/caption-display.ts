// Caption visibility — platform-agnostic prefs mapped from persisted Settings.
// Site-specific *sources* (YouTube `.ytp-caption-segment`, SSE `source` field,
// etc.) live in content; these flags only control whether we render them.

import type { Settings } from "./types";

export interface CaptionDisplayPrefs {
  /** Translated line on the in-page overlay strip (any site with <video>). */
  showTargetOnVideo: boolean;
  /** Source-language line in the expanded panel when the pipeline provides text. */
  showSourceInPanel: boolean;
}

export function captionDisplayFromSettings(
  s: Partial<Settings> | null | undefined,
): CaptionDisplayPrefs {
  return {
    showTargetOnVideo: s?.showTargetCaptions !== false,
    showSourceInPanel: !!s?.showSource,
  };
}
