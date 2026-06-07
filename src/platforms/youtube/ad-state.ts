// Detect YouTube ad playback so we do not treat ad pauses as user pauses.
//
// Moved from `src/content/youtube-ad-state.ts`.

/**
 * Canonical ad-signal classes. YouTube adds these to `#movie_player` ONLY while
 * an ad is active. This is the single source of truth for "is an ad on" — both
 * the poll fallback (`isYouTubeAdPlaying`) and the Stage-C `AdWatcher`'s
 * MutationObserver (which watches `#movie_player`'s `class` attribute and
 * re-reads this predicate the same microtask YouTube flips one of these) read it.
 *
 * Do NOT query `.video-ads.ytp-ad-module` — that container is ALWAYS present in
 * the DOM (empty between ads), so it would read true during normal playback →
 * real user pauses get ignored (the dub keeps playing while the video is paused).
 */
export const YOUTUBE_AD_CLASSES = ["ad-showing", "ad-interrupting"] as const;

/** True iff the given element carries one of the YouTube ad-signal classes. */
export function hasYouTubeAdClass(el: Element | null): boolean {
  if (!el) return false;
  return YOUTUBE_AD_CLASSES.some((c) => el.classList.contains(c));
}

/** The element YouTube flips the ad classes on — the AdWatcher observes its `class`. */
export function getYouTubeAdSignalTarget(): Element | null {
  return document.getElementById("movie_player");
}

export function isYouTubeAdPlaying(): boolean {
  return hasYouTubeAdClass(getYouTubeAdSignalTarget());
}
