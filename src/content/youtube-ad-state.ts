/** Detect YouTube ad playback so we do not treat ad pauses as user pauses. */

export function isYouTubeAdPlaying(): boolean {
  const player = document.getElementById("movie_player");
  if (!player) return false;
  if (
    player.classList.contains("ad-showing") ||
    player.classList.contains("ad-interrupting")
  ) {
    return true;
  }
  return !!document.querySelector(
    ".video-ads.ytp-ad-module, .ytp-ad-player-overlay",
  );
}
