// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isYouTubeAdPlaying } from "@/content/youtube-ad-state";

describe("isYouTubeAdPlaying", () => {
  let player: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    player = document.createElement("div");
    player.id = "movie_player";
    document.body.appendChild(player);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("returns false when no ad classes or modules", () => {
    expect(isYouTubeAdPlaying()).toBe(false);
  });

  it("returns true when movie_player has ad-showing", () => {
    player.classList.add("ad-showing");
    expect(isYouTubeAdPlaying()).toBe(true);
  });

  it("returns true when movie_player has ad-interrupting", () => {
    player.classList.add("ad-interrupting");
    expect(isYouTubeAdPlaying()).toBe(true);
  });

  it("returns FALSE when only the (always-present) ad-module container exists, no ad class", () => {
    // `.video-ads.ytp-ad-module` persists in YouTube's DOM even with no ad — it
    // must NOT read as an active ad, else real user pauses get ignored and the
    // dub keeps playing while the video is paused.
    const adContainer = document.createElement("div");
    adContainer.className = "video-ads ytp-ad-module";
    document.body.appendChild(adContainer);
    expect(isYouTubeAdPlaying()).toBe(false);
  });
});
