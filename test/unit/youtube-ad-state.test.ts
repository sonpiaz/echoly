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

  it("returns true when ad module is present", () => {
    const ad = document.createElement("div");
    ad.className = "video-ads ytp-ad-module";
    document.body.appendChild(ad);
    expect(isYouTubeAdPlaying()).toBe(true);
  });
});
