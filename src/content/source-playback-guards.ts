// Platform-specific guards for source <video> pause/play — keep generic RTC sync clean.

import { detectMediaPlatform } from "./media-stage";
import { isYouTubeAdPlaying } from "./youtube-ad-state";

/**
 * When true, ignore pause/play on the source video (e.g. YouTube ad overlay pause).
 * Generic sites: always false.
 */
export function shouldIgnoreSourcePlaybackEvent(): boolean {
  if (detectMediaPlatform() === "youtube") return isYouTubeAdPlaying();
  return false;
}
