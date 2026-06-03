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

  // ── AC1: engine ticks after ≥2 pause/resume cycles ──────────────────────────

  it("AC1 — tick loop still runs after a single stop→snap→start cycle (engine not permanently dead)", async () => {
    let videoTime = 100;
    let dubTime = 5.0;
    const rateHistory: number[] = [];

    const video = {
      get currentTime() { return videoTime; },
      get paused() { return false; },
      get playbackRate() { return rateHistory.at(-1) ?? 1; },
      set playbackRate(r: number) { rateHistory.push(r); },
    } as unknown as HTMLVideoElement;
    const dub = {
      get currentTime() { return dubTime; },
    } as unknown as HTMLAudioElement;

    const sync = bindStandardDubPlaybackSync({
      video,
      getDubAudio: () => dub,
      isUserPaused: () => false,
    });

    // First run cycle
    sync.snapPlaybackStart();
    sync.start();
    await vi.advanceTimersByTimeAsync(600); // anchor captured

    // Pause/stop
    sync.stop();

    // Resume: snapPlaybackStart() MUST reset stopped=false (A1 fix)
    sync.snapPlaybackStart();
    sync.start();
    dubTime = 5.2; // dub has some currentTime
    await vi.advanceTimersByTimeAsync(600); // anchor should be captured again

    // Now drift: video races ahead
    videoTime = 120;
    const ratesBefore = rateHistory.length;
    await vi.advanceTimersByTimeAsync(2000);

    // If the engine was permanently dead, no rate changes would happen after resume.
    // If alive, it will try to correct (set playbackRate below 1 or above 1).
    expect(rateHistory.length).toBeGreaterThan(ratesBefore);
    sync.stop();
  });

  it("AC1 — engine still ticks after ≥2 pause/resume cycles", async () => {
    let videoTime = 100;
    let dubTime = 5.0;
    const ratesApplied: number[] = [];

    // Use a proxy-style object to track playbackRate writes
    const videoState = { playbackRate: 1 };
    const video = new Proxy(
      {
        get currentTime() { return videoTime; },
        get paused() { return false; },
      } as unknown as HTMLVideoElement,
      {
        get(target, prop) {
          if (prop === "playbackRate") return videoState.playbackRate;
          if (prop === "currentTime") return videoTime;
          if (prop === "paused") return false;
          return Reflect.get(target, prop);
        },
        set(_target, prop, value) {
          if (prop === "playbackRate") {
            videoState.playbackRate = value as number;
            ratesApplied.push(value as number);
          }
          return true;
        },
      },
    );
    const dub = {
      get currentTime() { return dubTime; },
    } as unknown as HTMLAudioElement;

    const sync = bindStandardDubPlaybackSync({
      video,
      getDubAudio: () => dub,
      isUserPaused: () => false,
    });

    // Cycle 1
    sync.snapPlaybackStart();
    sync.start();
    dubTime = 5.1;
    await vi.advanceTimersByTimeAsync(600);
    sync.stop();

    // Cycle 2
    sync.snapPlaybackStart();
    sync.start();
    dubTime = 5.2;
    await vi.advanceTimersByTimeAsync(600);
    sync.stop();

    // Cycle 3 (≥2 complete cycles done; now measure live ticking)
    sync.snapPlaybackStart();
    sync.start();
    dubTime = 5.3;
    await vi.advanceTimersByTimeAsync(600); // anchor captured

    const ratesBefore = ratesApplied.length;
    videoTime = 130; // drift: video way ahead
    await vi.advanceTimersByTimeAsync(1500);

    // Engine alive → it has applied rate corrections after cycle 3
    expect(ratesApplied.length).toBeGreaterThan(ratesBefore);
    sync.stop();
  });

  // ── AC8: gate timeout still plays the video ──────────────────────────────────

  it("AC8 — waitForFirstDub timeout resolves false (soft-fail, not indefinite)", async () => {
    // dub never gets currentTime > 0.04 → waitForFirstDub times out
    const video = {
      currentTime: 10,
      playbackRate: 1,
      paused: false,
    } as unknown as HTMLVideoElement;
    const dub = {
      currentTime: 0, // never advances
    } as unknown as HTMLAudioElement;

    const sync = bindStandardDubPlaybackSync({
      video,
      getDubAudio: () => dub,
      isUserPaused: () => false,
    });

    sync.snapPlaybackStart();
    // Use a very short timeout so the test is fast
    const resultPromise = sync.waitForFirstDub(200);
    await vi.advanceTimersByTimeAsync(300);
    const result = await resultPromise;

    // Must resolve false (not hang forever)
    expect(result).toBe(false);
    sync.stop();
  });
});
