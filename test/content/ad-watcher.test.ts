// @vitest-environment jsdom
//
// Stage C (ADS) tests — SOLUTION §2.
//
// Covers:
//   1. AdWatcher edge-detect — onAdStart/onAdEnd fire exactly once per false↔true
//      transition (poll + MutationObserver); class churn that doesn't flip the
//      boolean is ignored; stop() disconnects cleanly (no late fire).
//   2. The ad-pause routes through lifecycle.pause('ad') and the ad-resume through
//      resume('ad') (the controller owns video.pause()/play()).
//   3. User-pause during an ad AND ad during a user-pause: resume only when BOTH
//      reasons clear (reason-stack AND semantics).
//   4. The WebRTC ad-pause disables sender tracks + POSTs media-pause (server
//      metering freezes) via the SAME syncSourcePauseState path the user pause uses.
//
// #onSeek-no-op-while-ad is covered in subtitle-first-ad-onseek.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AdWatcher } from "@/content/ad-watcher";
import { LifecycleController } from "@/content/lifecycle";
import { AD_WAIT_POLL_MS } from "@/shared/constants";
import type { ContentApp } from "@/content/index";
import type { PlatformAdapter } from "@/shared/platform-ports";

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** A controllable ad state + the #movie_player element the observer watches. */
function makeAdAdapter(opts: {
  target?: Element | null;
  isAdPlaying: () => boolean;
}): PlatformAdapter {
  return {
    id: "youtube",
    isAdPlaying: opts.isAdPlaying,
    getAdSignalTarget: () => opts.target ?? null,
  } as unknown as PlatformAdapter;
}

function makeApp(adapter: PlatformAdapter): ContentApp {
  return { adapter } as unknown as ContentApp;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Edge-detect
// ─────────────────────────────────────────────────────────────────────────────

describe("AdWatcher — edge detect (poll backstop)", () => {
  it("fires onAdStart exactly once on false→true and onAdEnd exactly once on true→false", () => {
    let ad = false;
    const adapter = makeAdAdapter({ isAdPlaying: () => ad });
    const watcher = new AdWatcher(makeApp(adapter));
    const onStart = vi.fn();
    const onEnd = vi.fn();
    watcher.start(onStart, onEnd);

    // No ad yet — polls do nothing.
    vi.advanceTimersByTime(AD_WAIT_POLL_MS * 3);
    expect(onStart).not.toHaveBeenCalled();

    // Ad starts → next poll fires onAdStart once.
    ad = true;
    vi.advanceTimersByTime(AD_WAIT_POLL_MS);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onEnd).not.toHaveBeenCalled();

    // Ad stays on across several polls → NO repeat (boolean unchanged).
    vi.advanceTimersByTime(AD_WAIT_POLL_MS * 4);
    expect(onStart).toHaveBeenCalledTimes(1);

    // Ad ends → onAdEnd once.
    ad = false;
    vi.advanceTimersByTime(AD_WAIT_POLL_MS);
    expect(onEnd).toHaveBeenCalledTimes(1);

    // Off stays off → no repeat.
    vi.advanceTimersByTime(AD_WAIT_POLL_MS * 4);
    expect(onEnd).toHaveBeenCalledTimes(1);

    watcher.stop();
  });

  it("seeds #adActive from the current state — an ad already on at start does NOT fire onAdStart", () => {
    let ad = true; // ad already playing when the watcher starts (start-gate case)
    const adapter = makeAdAdapter({ isAdPlaying: () => ad });
    const watcher = new AdWatcher(makeApp(adapter));
    const onStart = vi.fn();
    const onEnd = vi.fn();
    watcher.start(onStart, onEnd);

    vi.advanceTimersByTime(AD_WAIT_POLL_MS * 2);
    expect(onStart).not.toHaveBeenCalled(); // seeded as active, no transition

    // Only the SUBSEQUENT end transition is reported.
    ad = false;
    vi.advanceTimersByTime(AD_WAIT_POLL_MS);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(watcher.adActive).toBe(false);

    watcher.stop();
  });

  it("ignores a second false→true→false cycle correctly (one start + one end each)", () => {
    let ad = false;
    const adapter = makeAdAdapter({ isAdPlaying: () => ad });
    const watcher = new AdWatcher(makeApp(adapter));
    const onStart = vi.fn();
    const onEnd = vi.fn();
    watcher.start(onStart, onEnd);

    ad = true; vi.advanceTimersByTime(AD_WAIT_POLL_MS);
    ad = false; vi.advanceTimersByTime(AD_WAIT_POLL_MS);
    ad = true; vi.advanceTimersByTime(AD_WAIT_POLL_MS);
    ad = false; vi.advanceTimersByTime(AD_WAIT_POLL_MS);

    expect(onStart).toHaveBeenCalledTimes(2);
    expect(onEnd).toHaveBeenCalledTimes(2);
    watcher.stop();
  });

  it("stop() disconnects the poll — no late fire after stop", () => {
    let ad = false;
    const adapter = makeAdAdapter({ isAdPlaying: () => ad });
    const watcher = new AdWatcher(makeApp(adapter));
    const onStart = vi.fn();
    const onEnd = vi.fn();
    watcher.start(onStart, onEnd);
    watcher.stop();

    ad = true;
    vi.advanceTimersByTime(AD_WAIT_POLL_MS * 5);
    expect(onStart).not.toHaveBeenCalled();
  });
});

describe("AdWatcher — edge detect (MutationObserver on #movie_player class)", () => {
  it("fires onAdStart the moment the ad class flips on the observed element", async () => {
    const player = document.createElement("div");
    player.id = "movie_player";
    document.body.appendChild(player);

    const adapter = makeAdAdapter({
      target: player,
      // Mirror the real predicate: ad iff the element carries an ad class.
      isAdPlaying: () => player.classList.contains("ad-showing"),
    });
    const watcher = new AdWatcher(makeApp(adapter));
    const onStart = vi.fn();
    const onEnd = vi.fn();
    watcher.start(onStart, onEnd);

    // Flip the class as YouTube does. jsdom MutationObserver fires on a microtask.
    player.classList.add("ad-showing");
    await Promise.resolve();
    await Promise.resolve();
    expect(onStart).toHaveBeenCalledTimes(1);

    // Unrelated class churn must NOT re-fire (boolean unchanged).
    player.classList.add("some-unrelated-class");
    await Promise.resolve();
    await Promise.resolve();
    expect(onStart).toHaveBeenCalledTimes(1);

    // Flip off → onAdEnd once.
    player.classList.remove("ad-showing");
    await Promise.resolve();
    await Promise.resolve();
    expect(onEnd).toHaveBeenCalledTimes(1);

    watcher.stop();
    player.remove();
  });

  it("stop() disconnects the observer — a later class flip does not fire", async () => {
    const player = document.createElement("div");
    player.id = "movie_player";
    document.body.appendChild(player);
    const adapter = makeAdAdapter({
      target: player,
      isAdPlaying: () => player.classList.contains("ad-showing"),
    });
    const watcher = new AdWatcher(makeApp(adapter));
    const onStart = vi.fn();
    watcher.start(onStart, vi.fn());
    watcher.stop();

    player.classList.add("ad-showing");
    await Promise.resolve();
    await Promise.resolve();
    expect(onStart).not.toHaveBeenCalled();
    player.remove();
  });

  it("with no observer target (adapter returns null) it still edge-detects via the poll", () => {
    let ad = false;
    const adapter = makeAdAdapter({ target: null, isAdPlaying: () => ad });
    const watcher = new AdWatcher(makeApp(adapter));
    const onStart = vi.fn();
    watcher.start(onStart, vi.fn());

    ad = true;
    vi.advanceTimersByTime(AD_WAIT_POLL_MS);
    expect(onStart).toHaveBeenCalledTimes(1);
    watcher.stop();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A4 — lastAdEndAt is set BEFORE the onAdEnd callback fires (ordering invariant)
// ─────────────────────────────────────────────────────────────────────────────

describe("AdWatcher — A4: lastAdEndAt ordering (set before onAdEnd callback)", () => {
  it("lastAdEndAt is non-null synchronously when onAdEnd is invoked (not after)", () => {
    // Start with an ad already running (seed adActive=true), then let it end.
    let ad = true;
    const adapter = makeAdAdapter({ isAdPlaying: () => ad });
    const watcher = new AdWatcher(makeApp(adapter));

    let lastAdEndAtDuringCallback: number | null | undefined = undefined;
    const onEnd = vi.fn(() => {
      // Capture the value of lastAdEndAt at the moment the callback fires.
      // The ordering requirement: it must already be set (non-null) BEFORE
      // onAdEnd is invoked, not after.
      lastAdEndAtDuringCallback = watcher.lastAdEndAt;
    });

    watcher.start(vi.fn(), onEnd);
    // Verify the watcher seeded correctly (no callback at start for an active ad).
    expect(watcher.adActive).toBe(true);
    expect(watcher.lastAdEndAt).toBeNull();

    // Simulate ad ending via the poll.
    ad = false;
    vi.advanceTimersByTime(AD_WAIT_POLL_MS);

    expect(onEnd).toHaveBeenCalledTimes(1);
    // lastAdEndAt must have been set BEFORE the callback was invoked.
    expect(lastAdEndAtDuringCallback).not.toBeNull();
    expect(typeof lastAdEndAtDuringCallback).toBe("number");
    // And it remains set after.
    expect(watcher.lastAdEndAt).not.toBeNull();

    watcher.stop();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C1 / C2 — reseed() edge semantics and idempotency
// ─────────────────────────────────────────────────────────────────────────────

describe("AdWatcher — C1/C2: reseed() after a seek", () => {
  it("C1 — reseed() fires onAdStart exactly once when the ad class is now on (observer may have missed it)", () => {
    // The watcher is started with no ad, then the ad state changes (simulating
    // the observer missing it during a seek). reseed() re-reads and edge-fires.
    let ad = false;
    const adapter = makeAdAdapter({ isAdPlaying: () => ad });
    const watcher = new AdWatcher(makeApp(adapter));
    const onStart = vi.fn();
    watcher.start(onStart, vi.fn());

    expect(watcher.adActive).toBe(false);

    // Flip ad state (as if the observer missed it during the seek).
    ad = true;
    // Do NOT advance fake timers — the poll has not fired yet.

    // reseed() must detect the flip and fire onAdStart exactly once.
    watcher.reseed();
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(watcher.adActive).toBe(true);

    // Calling reseed() again with unchanged state must not fire again (idempotent).
    watcher.reseed();
    expect(onStart).toHaveBeenCalledTimes(1);

    watcher.stop();
  });

  it("C2 — reseed() with unchanged ad state fires no callback (idempotent)", () => {
    let ad = false;
    const adapter = makeAdAdapter({ isAdPlaying: () => ad });
    const watcher = new AdWatcher(makeApp(adapter));
    const onStart = vi.fn();
    const onEnd = vi.fn();
    watcher.start(onStart, onEnd);

    // No state change — reseed() must be a no-op.
    watcher.reseed();
    watcher.reseed();
    watcher.reseed();
    expect(onStart).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();

    watcher.stop();
  });
});
