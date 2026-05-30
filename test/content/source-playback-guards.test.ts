import { describe, expect, it, vi, afterEach } from "vitest";
import * as mediaStage from "@/content/media-stage";
import * as ytAd from "@/content/youtube-ad-state";
import { shouldIgnoreSourcePlaybackEvent } from "@/content/source-playback-guards";

describe("shouldIgnoreSourcePlaybackEvent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns false on generic platform", () => {
    vi.spyOn(mediaStage, "detectMediaPlatform").mockReturnValue("generic");
    expect(shouldIgnoreSourcePlaybackEvent()).toBe(false);
  });

  it("delegates to YouTube ad detector on youtube", () => {
    vi.spyOn(mediaStage, "detectMediaPlatform").mockReturnValue("youtube");
    vi.spyOn(ytAd, "isYouTubeAdPlaying").mockReturnValue(true);
    expect(shouldIgnoreSourcePlaybackEvent()).toBe(true);
  });
});
