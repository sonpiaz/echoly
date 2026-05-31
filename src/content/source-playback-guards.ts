// Platform-specific guards for source <video> pause/play — keep generic RTC sync clean.
//
// Delegates to the active PlatformAdapter so the guard is platform-agnostic.
// The adapter's shouldIgnorePlaybackEvent? optional method returns true when the
// event is a spurious pause caused by an ad overlay (e.g. YouTube mid-roll) and
// the dub session should NOT be torn down.
//
// Note: the event/video parameters are forwarded to the adapter if it needs them,
// but current adapters (YouTube) only check internal DOM state (isYouTubeAdPlaying)
// and do not use the event object. Both are kept in the signature for correctness
// against the PlatformAdapter contract.

import type { PlatformAdapter } from "@/shared/platform-ports";

/**
 * When true, ignore this pause/play event on the source video.
 * e.g. YouTube ad overlay causes a spurious pause that should not stop the dub.
 *
 * Falls back to false (do not ignore) when the adapter has no
 * shouldIgnorePlaybackEvent hook (generic / platforms with no ad overlays).
 */
export function shouldIgnoreSourcePlaybackEvent(
  adapter: PlatformAdapter,
  ev?: Event,
  video?: HTMLVideoElement,
): boolean {
  if (!adapter.shouldIgnorePlaybackEvent) return false;
  // Create a synthetic event when one is not provided (e.g. called from a
  // handler that doesn't receive the DOM event). YouTube's implementation
  // does not use the event — it only checks internal DOM state.
  const safeEv = ev ?? new Event("pause");
  const safeVideo = video ?? (null as unknown as HTMLVideoElement);
  return adapter.shouldIgnorePlaybackEvent(safeEv, safeVideo);
}
