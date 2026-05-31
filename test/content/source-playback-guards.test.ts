// @vitest-environment jsdom
import { describe, expect, it, afterEach } from "vitest";
import { isYouTubeAdPlaying } from "@/platforms/youtube/ad-state";
import { shouldIgnoreSourcePlaybackEvent } from "@/content/source-playback-guards";
import type { PlatformAdapter } from "@/shared/platform-ports";

// Minimal adapter stubs
function makeGenericAdapter(): PlatformAdapter {
  return {
    id: "generic",
    capabilities: { audioCapture: true, subtitleFirst: false, isSpa: false, hasNativeCaptions: false, hasAdOverlays: false },
    matchesHost: () => false,
    isWatchUrl: () => false,
    getVideoId: () => null,
    findVideo: () => null,
    stageInsets: () => ({ top: 44, bottom: 56, side: 16 }),
    fetchCaptions: async () => null,
    readLiveCaptionText: () => null,
  };
}

function makeYouTubeAdapter(): PlatformAdapter {
  return {
    ...makeGenericAdapter(),
    id: "youtube",
    capabilities: { audioCapture: true, subtitleFirst: true, isSpa: true, hasNativeCaptions: true, hasAdOverlays: true },
    shouldIgnorePlaybackEvent: (_ev: Event, _video: HTMLVideoElement) => isYouTubeAdPlaying(),
  };
}

describe("shouldIgnoreSourcePlaybackEvent", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("returns false on generic platform (no shouldIgnorePlaybackEvent hook)", () => {
    const adapter = makeGenericAdapter();
    expect(shouldIgnoreSourcePlaybackEvent(adapter)).toBe(false);
  });

  it("delegates to YouTube ad detector on youtube", () => {
    const adapter = makeYouTubeAdapter();
    // Set up the DOM condition that isYouTubeAdPlaying checks
    const player = document.createElement("div");
    player.id = "movie_player";
    player.classList.add("ad-showing");
    document.body.appendChild(player);
    expect(shouldIgnoreSourcePlaybackEvent(adapter)).toBe(true);
  });
});
