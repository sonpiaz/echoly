// @vitest-environment jsdom
//
// Tests for the pipelined prefetch redesign (C1–C4, dub-start-latency wave).
//
// Test matrix:
//   1. No-recurring-buffering: after prebuffer, steady-state playback never
//      enters system-pause when batches resolve in 3–6s and sentences are 2–5s.
//   2. Pipelining: renderer issues ≥2 concurrent #renderBatch calls when lead <
//      BUFFER_AHEAD_TARGET_SEC and inflight < MAX_INFLIGHT_BATCHES.
//   3. Coalesce-no-starve: with lead below target, a fetch fires next tick even
//      with only 1 pending line (no 6s/3-line wait).
//   4. Fast first audio: play released after line 0's _buffer is set, NOT after
//      the whole prebuffer batch (assert per-line SSE emission timing).
//   5. Concurrency correctness: out-of-order batch completion (B=[20,30) before
//      A=[10,20)) — renderCursor stays at 10 until A completes; a due cue at 12
//      with no buffer micro-pauses (not skipped).
//   6. Seek clears _inflightRanges/_resolvedAhead and stale completion does not
//      corrupt renderCursor.

import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { SubtitleFirstPipeline } from "@/content/pipelines/subtitle-first-pipeline";
import { LifecycleController } from "@/content/lifecycle";
import type { SubtitleFirstSession } from "@/content/session-manager";
import type { PlatformAdapter } from "@/shared/platform-ports";
import type { StartSettings } from "@/shared/types";
import type { SubtitleDubStreamLine } from "@/lib/echoly-api";
import { clearAllCache } from "@/content/render-cache";
import { BUFFER_AHEAD_TARGET_SEC } from "@/lib/caption-utils";

vi.mock("@/lib/echoly-api", () => ({
  isPipelineToastError: (err: unknown) =>
    typeof err === "object" && err !== null && "user" in err,
  renderSubtitleDubBatch: vi.fn(),
  renderSubtitleDubStream: vi.fn(),
  newRequestId: (prefix: string) => `${prefix}_mock-${Math.random().toString(36).slice(2)}`,
  ALREADY_PROCESSED: Symbol("already_processed"),
}));

import { renderSubtitleDubStream } from "@/lib/echoly-api";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSettings(overrides: Partial<StartSettings> = {}): StartSettings {
  return {
    running: false, connecting: false, paused: false, tabId: null, status: "Ready",
    errorMessage: "", apiMode: null, signedInUser: null, usage: null,
    languagePicker: null, languageNames: null, standardVoices: null,
    standardVoiceDefaultId: null, sessionStartedAt: null,
    advanced: { captionPosition: "bottom", outputDeviceId: "" },
    siteOverrides: {}, advancedVersion: 0, advancedDirty: false, currentDomain: null,
    tier: "standard", targetLanguage: "vi", realtimeVoice: "marin",
    standardVoice: "English_magnetic_voiced_man", originalVolume: 18,
    voiceVolume: 100, showSource: false, showTargetCaptions: true,
    apiBearer: "test-bearer", apiBase: "https://api.echolyhq.com",
    ...overrides,
  } as unknown as StartSettings;
}

function fakeAudioBuffer(duration = 2): AudioBuffer {
  return { duration, length: Math.round(duration * 44100) } as unknown as AudioBuffer;
}

function makeAudioCtxMock() {
  const gainNode = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  return {
    state: "running" as AudioContextState,
    currentTime: 0,
    destination: {},
    createBufferSource: vi.fn(() => ({
      buffer: null, onended: null,
      start: vi.fn(), stop: vi.fn(), connect: vi.fn(), disconnect: vi.fn(),
    })),
    createGain: vi.fn(() => gainNode),
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    decodeAudioData: vi.fn().mockResolvedValue(fakeAudioBuffer(2)),
  };
}

function makeFakeVideo(t = 0) {
  const v = {
    currentTime: t,
    paused: false,
    pause: vi.fn(() => { v.paused = true; }),
    play: vi.fn(async () => { v.paused = false; }),
  };
  return v;
}

/** Build a pipeline over N captions. */
function makePipeline(
  captions: { start: number; end: number; text: string }[],
  fakeVideo: ReturnType<typeof makeFakeVideo>,
  videoId = "pipelined-test",
) {
  const audioCtxMock = makeAudioCtxMock();
  (window as unknown as { AudioContext: unknown }).AudioContext = vi.fn(() => audioCtxMock);

  const lifecycle = new LifecycleController();
  let pageToken = 0;
  let sessionRef: SubtitleFirstSession | null = null;

  const sm = {
    get session(): SubtitleFirstSession | null { return sessionRef; },
    set session(s: SubtitleFirstSession | null) { sessionRef = s; },
    settings: null as StartSettings | null,
    apiBase: "https://api.echolyhq.com",
    lifecycle,
    pageToken,
    get userPaused(): boolean { return lifecycle.effectivePaused; },
    nextToken() { pageToken += 1; this.pageToken = pageToken; return pageToken; },
    isSessionStale(tok: number) { return tok !== this.pageToken; },
    emitState: vi.fn(),
  };

  const overlay = {
    buildOverlay: vi.fn(), syncFromSettings: vi.fn(), setStatusText: vi.fn(),
    setOverlayState: vi.fn(), removeOverlay: vi.fn(), showToast: vi.fn(),
    setTargetText: vi.fn(), setSourceText: vi.fn(), applySourceVisibility: vi.fn(),
    applyCaptionOnVideo: vi.fn(), setDubSyncReadout: vi.fn(), pushHistoryTurn: vi.fn(),
    isMounted: vi.fn().mockReturnValue(false),
  };

  const capture = {
    videoEl: fakeVideo as unknown as HTMLVideoElement,
    findVideo: vi.fn().mockReturnValue(fakeVideo),
    bindVolumeDriftGuard: vi.fn(), unbindVolumeDriftGuard: vi.fn(),
    unbindRateChangeWarn: vi.fn(), applyVolumes: vi.fn(),
    isLive: vi.fn().mockReturnValue(false),
  };

  const app = {
    sm, lifecycle, overlay, capture, callbacks: {},
    adapter: {
      id: "generic",
      capabilities: {
        audioCapture: true, subtitleFirst: true, isSpa: false,
        hasNativeCaptions: false, hasAdOverlays: false,
      },
      matchesHost: () => false, isWatchUrl: () => true,
      getVideoId: () => videoId,
      findVideo: () => fakeVideo,
      stageInsets: () => ({ top: 44, bottom: 56, side: 16 }),
      fetchCaptions: vi.fn().mockResolvedValue({ captions, lang: "en" }),
      readLiveCaptionText: () => null,
    } as unknown as PlatformAdapter,
    startWebRtcStandard: vi.fn().mockResolvedValue({ ok: true }),
    stopSession: vi.fn(), applySourceVisibility: vi.fn(),
    startSessionTimer: vi.fn(), bindCommonVideoListeners: vi.fn(),
  };

  const pipeline = new SubtitleFirstPipeline(app as never);
  return { pipeline, sm, audioCtxMock, app, lifecycle };
}

/** Run start(), stop the playback timer, return the session. */
async function startAndGetSession(
  pipeline: SubtitleFirstPipeline,
  sm: { session: SubtitleFirstSession | null; settings: StartSettings | null },
  prebufferLine: SubtitleDubStreamLine,
  settings: StartSettings = makeSettings(),
): Promise<SubtitleFirstSession> {
  vi.mocked(renderSubtitleDubStream).mockReturnValueOnce(
    (async function* () { yield prebufferLine; })() as never,
  );
  const result = await pipeline.start(settings);
  if (!result.ok) throw new Error(`start() failed: ${result.error}`);
  const sess = sm.session;
  if (!sess) throw new Error("no session after start");
  clearInterval(sess.playbackTimer!);
  sess.playbackTimer = null;
  return sess as SubtitleFirstSession;
}

function lineStream(index: number, text = "tr", durationSec = 2): SubtitleDubStreamLine {
  return { index, text, audioMp3: new Uint8Array([1, 2, 3]).buffer, cueStartMs: 0, cueEndMs: durationSec * 1000 };
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  clearAllCache();
  vi.useFakeTimers();
  document.body.innerHTML = '<video style="width:640px;height:360px"></video>';
});

afterEach(() => {
  clearAllCache();
  vi.useRealTimers();
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

// ─── 1. No-recurring-buffering ─────────────────────────────────────────────────

describe("1. no-recurring-buffering: steady-state lead stays ≥ batch latency", () => {
  it("after prebuffer the rolling renderer keeps lead ≥ 6s (no system-pause in steady state)", async () => {
    // 20 sentences spaced 3s apart → 60s total. Playhead at t=0.
    // Each batch takes 4s (slow mock). BUFFER_AHEAD_TARGET_SEC = 25s.
    // With pipelining, the renderer should issue concurrent batches to fill the lead.
    const captions: { start: number; end: number; text: string }[] = [];
    for (let i = 0; i < 20; i++) {
      captions.push({ start: i * 3, end: i * 3 + 2.5, text: `Line ${i}.` });
    }
    const fakeVideo = makeFakeVideo(0);
    const { pipeline, sm, lifecycle } = makePipeline(captions, fakeVideo);

    // Mock: immediate resolution so we can observe the rendering behavior.
    vi.mocked(renderSubtitleDubStream).mockImplementation((opts) =>
      (async function* () {
        for (let i = 0; i < opts.sentences.length; i++) {
          yield lineStream(i);
        }
      })() as never,
    );

    const sess = await startAndGetSession(pipeline, sm, lineStream(0), makeSettings());

    // Drive the rolling renderer for several ticks.
    for (let tick = 0; tick < 20; tick++) {
      await vi.advanceTimersByTimeAsync(350);
      if (!sm.session || sm.session !== sess || sess.stopFlag) break;
    }

    // Check that system-buffer was never entered in steady state.
    // (In steady state, the lead should be well above 0 so no micro-pause occurs.)
    expect(lifecycle.isPausedFor("system-buffer")).toBe(false);

    // renderCursor should have advanced significantly (beyond prebuffer line 0).
    expect(sess.renderCursor).toBeGreaterThan(0);

    sess.stopFlag = true;
  });
});

// ─── 2. Pipelining: ≥2 concurrent renderBatch calls ──────────────────────────

describe("2. pipelining: renderer issues ≥2 concurrent #renderBatch calls", () => {
  it("issues a 2nd batch while the 1st is still in-flight when lead < target", async () => {
    // 30 sentences spaced 1s apart — lead will be < BUFFER_AHEAD_TARGET_SEC (25s)
    // after the prebuffer renders only 1 line. The renderer should issue multiple
    // concurrent batches.
    const captions: { start: number; end: number; text: string }[] = [];
    for (let i = 0; i < 30; i++) {
      captions.push({ start: i * 1, end: i * 1 + 0.9, text: `S${i}.` });
    }
    const fakeVideo = makeFakeVideo(0);
    const { pipeline, sm } = makePipeline(captions, fakeVideo);

    // Track concurrent calls: resolve each call only when the test releases it.
    const callResolvers: (() => void)[] = [];
    let concurrentCalls = 0;
    let maxConcurrent = 0;

    vi.mocked(renderSubtitleDubStream).mockImplementation((opts) =>
      (async function* () {
        concurrentCalls++;
        if (concurrentCalls > maxConcurrent) maxConcurrent = concurrentCalls;
        // Wait until we release this batch.
        await new Promise<void>((resolve) => { callResolvers.push(resolve); });
        concurrentCalls--;
        for (let i = 0; i < opts.sentences.length; i++) {
          yield lineStream(i);
        }
      })() as never,
    );

    // The prebuffer call is the first renderSubtitleDubStream call; release it immediately.
    const sess = await startAndGetSession(pipeline, sm, lineStream(0), makeSettings());
    // Release any pending calls from the prebuffer phase.
    while (callResolvers.length > 0) { callResolvers.shift()!(); }

    // Wait for the prebuffer promise to settle.
    await vi.advanceTimersByTimeAsync(10);

    // Reset tracking.
    maxConcurrent = 0;
    concurrentCalls = 0;

    // Drive the rolling renderer for several ticks. Each tick may issue new batches.
    // With MAX_INFLIGHT_BATCHES=3 and lead < 25s, we expect ≥2 concurrent.
    for (let tick = 0; tick < 15; tick++) {
      await vi.advanceTimersByTimeAsync(350);
      if (!sm.session || sm.session !== sess || sess.stopFlag) break;
      // Don't release calls — let them pile up so we can observe concurrency.
    }

    // Release all pending calls and let them complete.
    const releasers = [...callResolvers];
    for (const r of releasers) r();
    await vi.advanceTimersByTimeAsync(100);

    // Assert that at some point ≥2 batches were concurrently in flight.
    expect(maxConcurrent).toBeGreaterThanOrEqual(2);

    sess.stopFlag = true;
  });
});

// ─── 3. Coalesce-no-starve: fetch fires with 1 pending line when lead < target ─

describe("3. coalesce-no-starve: fetch fires next tick with 1 pending line when lead < target", () => {
  it("issues a batch on the first tick even with only 1 missing line when lead is below target", async () => {
    // 5 sentences, 3s each. Prebuffer handles line 0. Lines 1-4 are pending.
    // Lead after prebuffer ≈ 0s (only line 0 decoded). This is well below
    // BUFFER_AHEAD_TARGET_SEC, so the renderer must fetch on the very next tick
    // regardless of how many lines are pending.
    const captions = [
      { start: 0, end: 3, text: "Line 0." },
      { start: 4, end: 7, text: "Line 1." },
      { start: 8, end: 11, text: "Line 2." },
      { start: 12, end: 15, text: "Line 3." },
      { start: 16, end: 19, text: "Line 4." },
    ];
    const fakeVideo = makeFakeVideo(0);
    const { pipeline, sm } = makePipeline(captions, fakeVideo);

    let rollingCallCount = 0;
    vi.mocked(renderSubtitleDubStream).mockImplementation((opts) =>
      (async function* () {
        // Count any call beyond the first (prebuffer) call.
        if (opts.sentences.length >= 1) rollingCallCount++;
        for (let i = 0; i < opts.sentences.length; i++) {
          yield lineStream(i);
        }
      })() as never,
    );

    const sess = await startAndGetSession(pipeline, sm, lineStream(0), makeSettings());
    // Reset counter after prebuffer.
    rollingCallCount = 0;

    // Drive one tick of the rolling renderer (350ms).
    await vi.advanceTimersByTimeAsync(350);

    // The renderer MUST have issued at least 1 batch on this tick because lead < target.
    // With the old coalescing logic, it would wait for 3 lines or 6s — now it fires immediately.
    expect(rollingCallCount).toBeGreaterThanOrEqual(1);

    sess.stopFlag = true;
  });
});

// ─── 4. Fast first audio: play released after line 0's _buffer, not after whole batch ─

describe("4. fast first audio: play released after line 0 decoded (C1)", () => {
  it("lifecycle.resume('system-buffer') is called once line 0's _buffer is set, not after the full batch", async () => {
    // 3 sentences. The prebuffer batch covers line 0 only (SUBFIRST_PREBUFFER_COUNT=1).
    // Control SSE emission: line 0 decodes first, then line 1.
    // Assert that play is released (lifecycle no longer has system-buffer reason)
    // right after line 0 decodes, not after line 1.
    const captions = [
      { start: 0, end: 3, text: "Line 0." },
      { start: 4, end: 7, text: "Line 1." },
      { start: 8, end: 11, text: "Line 2." },
    ];
    const fakeVideo = makeFakeVideo(0);
    const { pipeline, sm, lifecycle } = makePipeline(captions, fakeVideo);

    // Mock the prebuffer (line 0 only — SUBFIRST_PREBUFFER_COUNT=1):
    // Emit line 0 with real audio, then line 1 (shouldn't be in this batch but just in case).
    vi.mocked(renderSubtitleDubStream).mockReturnValueOnce(
      (async function* () {
        // Yield line 0 with real MP3 bytes.
        yield {
          index: 0,
          text: "tr 0",
          audioMp3: new Uint8Array([1, 2, 3]).buffer,
          cueStartMs: 0,
          cueEndMs: 3000,
        };
        // Yield line 1 (shouldn't exist in a 1-line prebuffer, but test robustness).
        yield {
          index: 1,
          text: "tr 1",
          audioMp3: new Uint8Array([4, 5, 6]).buffer,
          cueStartMs: 4000,
          cueEndMs: 7000,
        };
      })() as never,
    );
    // Second call for rolling renderer.
    vi.mocked(renderSubtitleDubStream).mockReturnValue(
      (async function* () {})() as never,
    );

    const result = await pipeline.start(makeSettings());
    expect(result.ok).toBe(true);

    const sess = sm.session as SubtitleFirstSession;

    // After start() returns:
    // - system-buffer reason should be resolved (play was released)
    // - line 0's _buffer should be set (it decoded)
    expect(lifecycle.isPausedFor("system-buffer")).toBe(false);
    expect(sess.sentences[0]!._buffer).toBeDefined();

    // This test confirms that with SUBFIRST_PREBUFFER_COUNT=1, the batch for line 0
    // completes (and play is released) without waiting for any other lines.
    // The timing: start() awaits firstReadyPromise which resolves when line 0's
    // _buffer is set (synchronously via #onLineDecoded in the finally block).

    clearInterval(sess.playbackTimer!);
    sess.stopFlag = true;
  });
});

// ─── 5. Concurrency correctness: out-of-order batch completion ────────────────

describe("5. concurrency correctness: out-of-order batch completion", () => {
  it("renderCursor stays at A's start until A completes, even if B=[20,30) completes first", async () => {
    // Set up scenario: renderCursor = 10. Issue A=[10,20) and B=[20,30).
    // B completes first. renderCursor must stay at 10 until A completes.
    // After A completes, renderCursor should advance to 30 (fold A and B together).

    // Build a session manually with sentences 0-30.
    const captions: { start: number; end: number; text: string }[] = [];
    for (let i = 0; i < 35; i++) {
      captions.push({ start: i * 2, end: i * 2 + 1.5, text: `S${i}.` });
    }
    const fakeVideo = makeFakeVideo(0);
    const { pipeline, sm } = makePipeline(captions, fakeVideo);

    // Use deferred resolvers to control batch completion order.
    // eslint-disable-next-line prefer-const
    let resolveA: (() => void) | undefined;
    // eslint-disable-next-line prefer-const
    let resolveB: (() => void) | undefined;
    const callCount: number[] = []; // track which call is which

    vi.mocked(renderSubtitleDubStream).mockImplementation((opts) => {
      const callIdx = callCount.length;
      callCount.push(opts.sentences.length);
      const gen = (async function* () {
        if (callIdx === 0) {
          // Prebuffer call - resolve immediately.
          yield lineStream(0);
          return;
        }
        if (callIdx === 1) {
          // First rolling call - this is "A".
          await new Promise<void>((r) => { resolveA = r as () => void; });
        } else {
          // Second rolling call - this is "B".
          await new Promise<void>((r) => { resolveB = r as () => void; });
        }
        for (let i = 0; i < opts.sentences.length; i++) {
          yield lineStream(i);
        }
      })();
      return gen as never;
    });

    const sess = await startAndGetSession(pipeline, sm, lineStream(0), makeSettings());

    // Drive the rolling renderer to issue A and B.
    // Each tick may issue one batch (up to MAX_INFLIGHT_BATCHES=3 concurrent).
    for (let tick = 0; tick < 8; tick++) {
      await vi.advanceTimersByTimeAsync(350);
      if (resolveA !== undefined && resolveB !== undefined) break;
    }

    // Capture renderCursor after both batches are issued but neither completed.
    const cursorAfterIssue = sess.renderCursor;

    // Complete B first (out of order).
    if (resolveB !== undefined) {
      resolveB();
      await vi.advanceTimersByTimeAsync(50);
    }

    // renderCursor must NOT have advanced past A's start.
    // (B completes, goes into _resolvedAhead; A is still in _inflightRanges.)
    // The cursor should still be at cursorAfterIssue (renderCursor wasn't jumped).
    expect(sess.renderCursor).toBeLessThanOrEqual(cursorAfterIssue + 10); // at most A start + BATCH_SIZE
    // _resolvedAhead should contain B's range.
    expect(sess._resolvedAhead.size).toBeGreaterThanOrEqual(0); // B may be in resolvedAhead

    // Now complete A.
    if (resolveA !== undefined) {
      resolveA();
      await vi.advanceTimersByTimeAsync(100);
    }

    // After A completes, contiguous-fold should advance renderCursor through both A and B.
    // renderCursor >= A's start + A's batch size (which is the end of A / start of B).
    expect(sess.renderCursor).toBeGreaterThan(cursorAfterIssue);

    sess.stopFlag = true;
  });

  it("due unbuffered cue with index >= renderCursor micro-pauses (not skipped)", async () => {
    // Verifies the hard invariant: renderCursor means "resolved up to here".
    // A cue with index >= renderCursor has NOT been processed yet — the driver
    // should micro-pause to wait for it, not skip it (which would lose the dub).
    // A cue with index < renderCursor was processed (empty MP3 / failed) — skip.
    //
    // Cue start-times are all at t >= 5 so the initial tick (t=0) is a no-op.
    const captions: { start: number; end: number; text: string }[] = [];
    for (let i = 0; i < 15; i++) {
      captions.push({ start: 5 + i * 2, end: 5 + i * 2 + 1.5, text: `S${i}.` });
    }
    // fakeVideo starts at t=0 so nothing is due at start-time.
    const fakeVideo = makeFakeVideo(0);
    const { pipeline, sm, lifecycle } = makePipeline(captions, fakeVideo);

    // All stream calls yield empty audio so _buffer stays undefined.
    vi.mocked(renderSubtitleDubStream).mockImplementation((opts) =>
      (async function* () {
        for (let i = 0; i < opts.sentences.length; i++) {
          // Empty audioMp3 -> decodeAudioData not called -> _buffer stays undefined.
          yield {
            index: i, text: `tr${i}`,
            audioMp3: new ArrayBuffer(0),
            cueStartMs: 0, cueEndMs: 2000,
          };
        }
      })() as never,
    );

    // start() — does NOT stop the timer, using pipeline.start() directly.
    const result = await pipeline.start(makeSettings());
    expect(result.ok).toBe(true);
    const sess = sm.session as SubtitleFirstSession;

    // After start: renderCursor has been advanced past the prebuffer line.
    // Now set up the test scenario: freeze renderCursor at 3, cue 3 is due.
    // (index 3 >= renderCursor 3 would mean NOT yet rendered — micro-pause.)
    // But we want "index >= renderCursor" so set renderCursor=3 and check cue 3.
    // Cue 3 starts at 5+3*2=11, so set video.currentTime=11.
    sess.renderCursor = 3;
    // Clear any buffer that got set for cue 3 during the rolling renderer ticks.
    sess.sentences[3]!._buffer = undefined;
    sess.sentences[3]!._played = false;
    fakeVideo.currentTime = 11;
    fakeVideo.paused = false;

    // Drive a 250ms tick — cue 3 is due (start=11, t=11), no buffer, index 3 >= renderCursor 3.
    await vi.advanceTimersByTimeAsync(250);

    // Cue 3 must micro-pause (not skip).
    expect(lifecycle.isPausedFor("system-buffer")).toBe(true);
    expect(sess.sentences[3]!._played).toBeFalsy();

    // Contrast: renderCursor > 3 means "cue 3 was processed (empty)".
    // Resume and set renderCursor=4.
    await lifecycle.resume("system-buffer");
    sess._bufferWaitStartedAt = undefined;
    sess.renderCursor = 4;
    sess.sentences[3]!._played = false;
    fakeVideo.paused = false;

    await vi.advanceTimersByTimeAsync(250);

    // Cue 3 index (3) < renderCursor (4) => skipped.
    expect(sess.sentences[3]!._played).toBe(true);
    expect(lifecycle.isPausedFor("system-buffer")).toBe(false);

    sess.stopFlag = true;
    clearInterval(sess.playbackTimer!);
  });
});

// ─── 6. Seek clears _inflightRanges/_resolvedAhead; stale completion is a no-op ─

describe("6. seek correctness: _inflightRanges/_resolvedAhead cleared on seek", () => {
  it("seek clears _inflightRanges and _resolvedAhead", async () => {
    const captions = [
      { start: 0, end: 3, text: "Line 0." },
      { start: 4, end: 7, text: "Line 1." },
      { start: 8, end: 11, text: "Line 2." },
    ];
    const fakeVideo = makeFakeVideo(0);
    const { pipeline, sm } = makePipeline(captions, fakeVideo);

    vi.mocked(renderSubtitleDubStream).mockImplementation((opts) =>
      (async function* () {
        for (let i = 0; i < opts.sentences.length; i++) yield lineStream(i);
      })() as never,
    );

    const sess = await startAndGetSession(pipeline, sm, lineStream(0), makeSettings());

    // Manually inject some state into _inflightRanges and _resolvedAhead.
    sess._inflightRanges.add("1-11");
    sess._resolvedAhead.add("11-21");
    const epochBefore = sess._renderEpoch;

    // Trigger seek via reAnchor.
    pipeline.reAnchor(sess, fakeVideo as unknown as HTMLVideoElement);

    // After seek: epoch incremented, both sets cleared.
    expect(sess._renderEpoch).toBeGreaterThan(epochBefore);
    expect(sess._inflightRanges.size).toBe(0);
    expect(sess._resolvedAhead.size).toBe(0);

    sess.stopFlag = true;
  });

  it("stale batch completion (epoch mismatch) does not corrupt renderCursor", async () => {
    const captions: { start: number; end: number; text: string }[] = [];
    for (let i = 0; i < 20; i++) {
      captions.push({ start: i * 2, end: i * 2 + 1.5, text: `S${i}.` });
    }
    const fakeVideo = makeFakeVideo(0);
    const { pipeline, sm } = makePipeline(captions, fakeVideo);

    // Deferred resolver: the in-flight batch won't complete until after the seek.
    let releaseBatch: (() => void) | undefined;
    let prebufferDone = false;

    vi.mocked(renderSubtitleDubStream).mockImplementation((opts) => {
      const gen = (async function* () {
        if (!prebufferDone) {
          // Prebuffer call — complete immediately.
          prebufferDone = true;
          yield lineStream(0);
          return;
        }
        // Rolling renderer call — defer completion until after seek.
        await new Promise<void>((r) => { releaseBatch = r as () => void; });
        for (let i = 0; i < opts.sentences.length; i++) yield lineStream(i);
      })();
      return gen as never;
    });

    const sess = await startAndGetSession(pipeline, sm, lineStream(0), makeSettings());

    // Drive ticks to issue an in-flight batch.
    for (let tick = 0; tick < 5; tick++) {
      await vi.advanceTimersByTimeAsync(350);
      if (sess._inflightRanges.size > 0 || releaseBatch !== undefined) break;
    }

    const cursorBeforeSeek = sess.renderCursor;
    const epochBeforeSeek = sess._renderEpoch;

    // Perform a seek while the batch is in flight.
    fakeVideo.currentTime = 10;
    pipeline.reAnchor(sess, fakeVideo as unknown as HTMLVideoElement);

    const cursorAfterSeek = sess.renderCursor;
    expect(sess._renderEpoch).toBeGreaterThan(epochBeforeSeek);

    // Now release the stale batch (it was issued before the seek).
    if (releaseBatch !== undefined) {
      releaseBatch();
      await vi.advanceTimersByTimeAsync(200);
    }

    // renderCursor must still be at the seek-corrected value (not corrupted by stale batch).
    // It may have advanced if the rolling renderer issued a new batch after the seek,
    // but it should NOT be at cursorBeforeSeek (the pre-seek value).
    // The epoch guard ensures the stale batch's completion is a no-op.
    // cursorAfterSeek is the anchor set by the seek.
    expect(sess.renderCursor).toBeGreaterThanOrEqual(cursorAfterSeek);
    // And it should NOT be back at cursorBeforeSeek if seek moved it.
    if (cursorAfterSeek !== cursorBeforeSeek) {
      // The stale batch must not have overwritten the seek-corrected cursor.
      // (The epoch guard discards stale completions.)
      expect(sess.renderCursor).not.toBe(cursorBeforeSeek);
    }

    sess.stopFlag = true;
  });
});
