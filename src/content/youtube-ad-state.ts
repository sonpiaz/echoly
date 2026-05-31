/** Detect YouTube ad playback so we do not treat ad pauses as user pauses. */

export function isYouTubeAdPlaying(): boolean {
  const player = document.getElementById("movie_player");
  if (!player) return false;
  // Canonical, reliable signal: YouTube adds these classes to #movie_player ONLY
  // while an ad is active. Do NOT query `.video-ads.ytp-ad-module` — that
  // container is ALWAYS present in the DOM (empty between ads), so it would make
  // this return true during normal playback → real user pauses get ignored
  // (the dub keeps playing while the video is paused).
  return (
    player.classList.contains("ad-showing") ||
    player.classList.contains("ad-interrupting")
  );
}
