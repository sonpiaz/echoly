import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  bindStandardDubPlaybackSync,
  computeVideoAheadSec,
} from "@/lib/dub-playback-sync";

describe("computeVideoAheadSec", () => {
  it("returns zero when video tracks dub anchor", () => {
    expect(computeVideoAheadSec(15, 5, 10, 0)).toBe(0);
  });

  it("returns positive when video is ahead", () => {
    expect(computeVideoAheadSec(20, 5, 10, 0)).toBe(5);
  });
});

describe("bindStandardDubPlaybackSync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never pauses; slows only when video runs ahead after 1:1 anchor", async () => {
    let videoTime = 10;
    const video = {
      get currentTime() {
        return videoTime;
      },
      set currentTime(t: number) {
        videoTime = t;
      },
      playbackRate: 1,
      paused: false,
      pause: vi.fn(),
      play: vi.fn(async () => {}),
    } as unknown as HTMLVideoElement;
    const dub = {
      currentTime: 0.2,
      paused: false,
      pause: vi.fn(),
      play: vi.fn(async () => {}),
    } as unknown as HTMLAudioElement;

    const sync = bindStandardDubPlaybackSync({
      video,
      getDubAudio: () => dub,
      isUserPaused: () => false,
    });

    sync.snapPlaybackStart();
    sync.start();
    await vi.advanceTimersByTimeAsync(600);
    videoTime = 18;
    await vi.advanceTimersByTimeAsync(2500);
    expect(video.pause).not.toHaveBeenCalled();
    expect(video.playbackRate).toBeLessThan(1);
    sync.stop();
    expect(video.playbackRate).toBe(1);
  });
});
