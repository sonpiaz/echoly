// @vitest-environment jsdom
//
// Stage C (ADS) — subtitle-first #onSeek is a NO-OP while an ad is active.
//
// YouTube uses ONE <video> for ad+content, so the ad-in/ad-out boundaries fire
// `seeked` events. Those are NOT user seeks — honoring them would reset
// `_played`/renderCursor against the AD clock and corrupt the bookkeeping. The
// gate is `if (lifecycle.isPausedFor('ad')) return;` at the top of #onSeek.
//
// We exercise #onSeek through the public reAnchor() wrapper (a thin pass-through
// added for the ad-end clean re-anchor), which is the exact same code path.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SubtitleFirstPipeline } from "@/content/pipelines/subtitle-first-pipeline";
import { LifecycleController } from "@/content/lifecycle";
import { SessionManager } from "@/content/session-manager";
import type { SubtitleFirstSession } from "@/content/session-manager";
import type { ContentApp } from "@/content/index";

function installChrome() {
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: { id: "test", sendMessage: vi.fn().mockResolvedValue(undefined) },
  };
}
function uninstallChrome() {
  (globalThis as { chrome?: unknown }).chrome = undefined;
}

/** A minimal real ContentApp facade: lifecycle + sm + capture(videoEl) + optional ad. */
function makeApp(
  lifecycle: LifecycleController,
  sm: SessionManager,
  video: HTMLVideoElement,
  ad?: { reseed: () => void } | null,
) {
  return {
    lifecycle,
    sm,
    capture: { videoEl: video },
    overlay: { setTargetText: vi.fn(), setSourceText: vi.fn() },
    ad: ad ?? null,
  } as unknown as ContentApp;
}

/** Build a subtitle-first session whose cues are ALL marked _played. */
function makeSession(): SubtitleFirstSession {
  const sentences = [
    { start: 0, end: 2, text: "a", _played: true, _buffer: undefined },
    { start: 2, end: 4, text: "b", _played: true, _buffer: undefined },
    { start: 4, end: 6, text: "c", _played: true, _buffer: undefined },
  ] as unknown as SubtitleFirstSession["sentences"];
  return {
    kind: "subtitle-first",
    token: 1,
    pc: null, dc: null, stream: null, remoteAudio: null,
    // Closed ctx → the #playbackTick fired at the end of #onSeek is a clean no-op,
    // so the test isolates the seek bookkeeping (the _played reset).
    audioCtx: { state: "closed" } as unknown as AudioContext,
    outputGain: null, rtcSessionId: null, apiBearer: "b",
    abortController: new AbortController(),
    sentences,
    translations: [],
    currentSource: null, currentPlayingIdx: null,
    playbackTimer: null, renderCursor: 3, rollingInFlight: false, stopFlag: false,
    _batchRequestIds: new Map(),
    _sentBatchRanges: new Map(),
    _renderEpoch: 0,
    _pendingLines: new Set(),
    _pendingFirstQueuedAt: 0,
  } as SubtitleFirstSession;
}

beforeEach(() => { installChrome(); });
afterEach(() => { vi.restoreAllMocks(); uninstallChrome(); });

describe("subtitle-first #onSeek — Stage C ad gate", () => {
  it("is a NO-OP while an ad is active (does NOT reset _played / renderCursor)", () => {
    const lifecycle = new LifecycleController();
    const sm = new SessionManager();
    sm.lifecycle = lifecycle;
    const video = { currentTime: 0 } as HTMLVideoElement;
    const session = makeSession();
    sm.session = session;
    const app = makeApp(lifecycle, sm, video);
    const pipeline = new SubtitleFirstPipeline(app);

    // Hold the 'ad' reason → #onSeek must early-return.
    lifecycle.pause("ad");

    // Seek "back" to t=0 (would normally reset _played for all cues).
    video.currentTime = 0;
    pipeline.reAnchor(session, video);

    // No reset happened — bookkeeping is untouched against the ad clock.
    expect(session.sentences.every((s) => s._played === true)).toBe(true);
    expect(session.renderCursor).toBe(3);
  });

  it("DOES re-anchor once the ad reason is cleared (the ad-end clean re-anchor)", () => {
    const lifecycle = new LifecycleController();
    const sm = new SessionManager();
    sm.lifecycle = lifecycle;
    const video = { currentTime: 0 } as HTMLVideoElement;
    const session = makeSession();
    sm.session = session;
    const app = makeApp(lifecycle, sm, video);
    const pipeline = new SubtitleFirstPipeline(app);

    // No ad reason held (ad has ended, reason already popped) → re-anchor runs.
    video.currentTime = 0;
    pipeline.reAnchor(session, video);

    // Cues at/after t=0 are reset so they replay against the restored content clock.
    expect(session.sentences.every((s) => s._played === false)).toBe(true);
    expect(session.renderCursor).toBe(0);
  });

  it("a real user seek while NOT in an ad still resets the seeked-into cues", () => {
    const lifecycle = new LifecycleController();
    const sm = new SessionManager();
    sm.lifecycle = lifecycle;
    const video = { currentTime: 3 } as HTMLVideoElement; // seek to t=3 (mid cue 'b')
    const session = makeSession();
    sm.session = session;
    const app = makeApp(lifecycle, sm, video);
    const pipeline = new SubtitleFirstPipeline(app);

    pipeline.reAnchor(session, video);

    // GAP-7: t=3 falls INSIDE cue 'b' (spans 2..4) → 'b' is the COVERING/anchor
    // cue. The reset loop keys off the anchor cue's start (2), NOT newT (3), so
    // cue 'b' itself resets and actually replays from its start on a mid-cue
    // seek-back (no swallowed line). Cue 'a' (ends at 2, before t=3) stays played.
    expect(session.sentences[0]!._played).toBe(true);  // 'a' — passed, stays played
    expect(session.sentences[1]!._played).toBe(false); // 'b' — covering cue, resets
    expect(session.sentences[2]!._played).toBe(false); // 'c' — after anchor, resets
    expect(session.renderCursor).toBe(1); // anchor index is cue 'b' (idx 1)
  });

  // ─ FORWARD seek must RE-TARGET the render cursor (the "dub stops after seek" bug)
  // The old `renderCursor = Math.min(renderCursor, anchor.index)` was a no-op on a
  // forward seek (anchor.index > renderCursor), so the rolling renderer never
  // fetched the seek-target cues → the dub went silent. The fix assigns the anchor
  // index outright, re-targeting the pump to the new position.
  it("FORWARD seek advances renderCursor to the anchor (re-targets the render pump)", () => {
    const lifecycle = new LifecycleController();
    const sm = new SessionManager();
    sm.lifecycle = lifecycle;
    // 6 cues (0..5), each 2s. Only cue 0 has been rendered → renderCursor = 1.
    const sentences = [
      { start: 0, end: 2, text: "a", _played: true, _buffer: undefined },
      { start: 2, end: 4, text: "b", _played: false, _buffer: undefined },
      { start: 4, end: 6, text: "c", _played: false, _buffer: undefined },
      { start: 6, end: 8, text: "d", _played: false, _buffer: undefined },
      { start: 8, end: 10, text: "e", _played: false, _buffer: undefined },
      { start: 10, end: 12, text: "f", _played: false, _buffer: undefined },
    ] as unknown as SubtitleFirstSession["sentences"];
    const session = { ...makeSession(), sentences, renderCursor: 1 } as SubtitleFirstSession;
    sm.session = session;
    // User scrubs FORWARD to t=9 → cue 'e' (idx 4, spans 8..10) is the covering
    // anchor (t=9 is strictly inside it; cue 'd' [6,8] ends before 9).
    const video = { currentTime: 9 } as HTMLVideoElement;
    const app = makeApp(lifecycle, sm, video);
    const pipeline = new SubtitleFirstPipeline(app);

    pipeline.reAnchor(session, video);

    // BEFORE the fix this stayed at 1 (Math.min(1,4)) → renderer never reaches cue
    // 'e' → dub silent. AFTER: cursor re-targets to the anchor index (4).
    expect(session.renderCursor).toBe(4);
    // Cues at/after the anchor (start ≥ 8) are reset to replay; earlier untouched.
    expect(session.sentences[4]!._played).toBe(false); // 'e' — anchor, reset
    expect(session.sentences[5]!._played).toBe(false); // 'f' — after anchor, reset
  });

  // ─ GAP-7: mid-cue seek-BACK replays the covering line (not skipped) ──────────
  // The exact regression the GAP-7 fix targets: seeking back into the middle of a
  // cue that was already played must un-mark it so it replays from its start.
  it("GAP-7: mid-cue seek-back un-marks the covering cue so it replays", () => {
    const lifecycle = new LifecycleController();
    const sm = new SessionManager();
    sm.lifecycle = lifecycle;
    // Seek back to t=5 — inside cue 'c' (spans 4..6), which was _played.
    const video = { currentTime: 5 } as HTMLVideoElement;
    const session = makeSession();
    sm.session = session;
    const app = makeApp(lifecycle, sm, video);
    const pipeline = new SubtitleFirstPipeline(app);

    expect(session.sentences[2]!._played).toBe(true); // 'c' was played
    pipeline.reAnchor(session, video);

    // 'c' is the covering cue → reset (would NOT happen if the loop keyed off newT
    // since 5 > c.start=4 → c.start >= 5 is false → 'c' would stay played/skipped).
    expect(session.sentences[2]!._played).toBe(false);
    expect(session.renderCursor).toBe(2); // anchor index is cue 'c' (idx 2)
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C3 — #onSeek calls app.ad.reseed() FIRST; no-ops rest when seek triggered ad
// ─────────────────────────────────────────────────────────────────────────────

describe("subtitle-first #onSeek — C3: reseed() called first, gates on ad state", () => {
  it("C3a: reseed() is called before the isPausedFor('ad') gate on every seek", () => {
    const lifecycle = new LifecycleController();
    const sm = new SessionManager();
    sm.lifecycle = lifecycle;
    const video = { currentTime: 3 } as HTMLVideoElement;
    const session = makeSession();
    sm.session = session;

    const reseedSpy = vi.fn();
    const app = makeApp(lifecycle, sm, video, { reseed: reseedSpy });
    const pipeline = new SubtitleFirstPipeline(app);

    // No ad active — reseed should be called and seek proceeds normally.
    pipeline.reAnchor(session, video);

    expect(reseedSpy).toHaveBeenCalledTimes(1);
  });

  it("C3b: reseed() that flips ad state ON causes #onSeek to no-op (ad gate fires)", () => {
    const lifecycle = new LifecycleController();
    const sm = new SessionManager();
    sm.lifecycle = lifecycle;
    const video = { currentTime: 0 } as HTMLVideoElement;
    const session = makeSession();
    sm.session = session;

    // reseed() will synchronously push the 'ad' reason — simulating a seek that
    // triggers a mid-roll ad. After reseed(), isPausedFor('ad') === true, so
    // the rest of #onSeek must be skipped (no _played reset, no cursor change).
    const reseedSpy = vi.fn().mockImplementation(() => {
      lifecycle.pause("ad");
    });
    const app = makeApp(lifecycle, sm, video, { reseed: reseedSpy });
    const pipeline = new SubtitleFirstPipeline(app);

    // Record the state BEFORE the seek.
    const renderCursorBefore = session.renderCursor;
    const playedBefore = session.sentences.map((s) => s._played);

    pipeline.reAnchor(session, video);

    // reseed() was called (Fix C — reseed before gate).
    expect(reseedSpy).toHaveBeenCalledTimes(1);

    // After reseed() pushed 'ad', the gate fired → no bookkeeping changes.
    expect(session.renderCursor).toBe(renderCursorBefore);
    session.sentences.forEach((s, i) => {
      expect(s._played).toBe(playedBefore[i]);
    });
  });

  it("C3c: reseed() with no ad watcher (ad=null) still proceeds normally", () => {
    // When app.ad is null (non-YouTube platform / no ad support), reseed()
    // optional chaining must not throw and the seek proceeds.
    const lifecycle = new LifecycleController();
    const sm = new SessionManager();
    sm.lifecycle = lifecycle;
    const video = { currentTime: 0 } as HTMLVideoElement;
    const session = makeSession();
    sm.session = session;

    // Pass null ad — tests the `this.app.ad?.reseed()` optional chain.
    const app = makeApp(lifecycle, sm, video, null);
    const pipeline = new SubtitleFirstPipeline(app);

    // Should not throw; seek re-anchors normally.
    expect(() => pipeline.reAnchor(session, video)).not.toThrow();
    // All cues reset (t=0, no ad gate).
    expect(session.sentences.every((s) => s._played === false)).toBe(true);
  });
});
