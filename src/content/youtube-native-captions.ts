// Hide YouTube's own CC track while Echoly is translating — the overlay shows
// the translated line; leaving YT CC on stacks two subtitle layers over dub audio.

function findSubtitlesButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    "button.ytp-subtitles-button, .ytp-subtitles-button",
  );
}

/** Turn off YT player CC if it was on; returns restore (re-enable only if we turned it off). */
export function suppressYouTubeNativeCaptions(): () => void {
  const btn = findSubtitlesButton();
  const wasOn = btn?.getAttribute("aria-pressed") === "true";
  if (wasOn) {
    try {
      btn!.click();
    } catch {
      /* ignore */
    }
  }
  return () => {
    if (!wasOn) return;
    const again = findSubtitlesButton();
    if (again && again.getAttribute("aria-pressed") !== "true") {
      try {
        again.click();
      } catch {
        /* ignore */
      }
    }
  };
}
