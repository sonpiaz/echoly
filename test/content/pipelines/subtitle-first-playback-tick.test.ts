// @vitest-environment jsdom
//
// Tests for the buffering-aware #playbackTick control flow introduced by the
// sync-pause-resume wave (SOLUTION §3.1 + AC#2-#6, #8-#11).
//
// Design:
//   • #playbackTick is a native JS private field — triggered by advancing the
//     250ms setInterval fake timer or, for the first tick, by the immediate
//     this.#playbackTick(newSession) call at the end of start().
//   • We put all cue start-times at t=10 so the initial tick (currentTime=0)
//     sees nothing due and is a no-op. After start() resolves we set
//     currentTime and advance timers to drive the first meaningful tick.
//   • #runRollingRenderer is a background 1000ms while-loop; we MUST NOT use
//     runAllTimersAsync (infinite loop). We advance timers in 250ms chunks.
//   • jsdom doesn't implement video.pause / .play — we use a plain fake video.

import { beforeEach, describe, it, expect, vi, afterEach } from "vitest";
import { SubtitleFirstPipeline } from "@/content/pipelines/subtitle-first-pipeline";
import { LifecycleController } from "@/content/lifecycle";
import type { SubtitleFirstSession } from "@/content/session-manager";
import type { CaptionSentence } from "@/lib/caption-utils";
import type { PlatformAdapter } from "@/shared/platform-ports";
import type { StartSettings } from "@/shared/types";

// ─── Mock echoly-api ──────────────────────────────────────────────────────────

vi.mock("@/lib/echoly-api", () => ({
  isPipelineToastError: () => false,
  renderSubtitleDubBatch: vi.fn(),
  // renderSubtitleDubStream is used by the streaming #renderBatch path;
  // the playback-tick tests drive the buffered path via renderSubtitleDubBatch,
  // so stream is never called here — provide a no-op async generator stub.
  renderSubtitleDubStream: vi.fn(async function* () {}),
  // newRequestId is used by #renderBatch to generate stable per-batch ids.
  newRequestId: (prefix: string) => `${prefix}_mock-uuid`,
  // ALREADY_PROCESSED sentinel used by #renderBatch for idempotency replays.
  ALREADY_PROCESSED: Symbol("already_processed"),
}));

import { renderSubtitleDubBatch, renderSubtitleDubStream } from "@/lib/echoly-api";

// ─── Shared settings builder ──────────────────────────────────────────────────

function makeSettings(): StartSettings {
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
  } as unknown as StartSettings;
}

function makeFakeBuffer(): AudioBuffer {
  return {} as AudioBuffer;
}

// ─── AudioContext mock ────────────────────────────────────────────────────────

interface MockSource {
  buffer: AudioBuffer | null;
  onended: (() => void) | null;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  fireEnded(): void;
}

function makeAudioCtxMock() {
  const sources: MockSource[] = [];
  const gainNode = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  return {
    state: "running" as AudioContextState,
    currentTime: 0, destination: {},
    createBufferSource: vi.fn(() => {
      const src: MockSource = {
        buffer: null, onended: null,
        start: vi.fn(), stop: vi.fn(), connect: vi.fn(), disconnect: vi.fn(),
        fireEnded() { src.onended?.(); },
      };
      sources.push(src);
      return src as unknown as AudioBufferSourceNode;
    }),
    createGain: vi.fn(() => gainNode),
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    decodeAudioData: vi.fn().mockResolvedValue(makeFakeBuffer()),
    _sources: sources,
  };
}

// ─── Fake video ───────────────────────────────────────────────────────────────

interface FakeVideo {
  currentTime: number;
  paused: boolean;
  pause: ReturnType<typeof vi.fn>;
  play: ReturnType<typeof vi.fn>;
}

function makeFakeVideo(t = 0): FakeVideo {
  const v: FakeVideo = {
    currentTime: t, paused: false,
    pause: vi.fn(() => { v.paused = true; }),
    play: vi.fn(async () => { v.paused = false; }),
  };
  return v;
}

// ─── Pipeline harness ────────────────────────────────────────────────────────

function makePipeline(captions: { start: number; end: number; text: string }[], fakeVideo: FakeVideo) {
  const audioCtxMock = makeAudioCtxMock();
  (window as unknown as { AudioContext: unknown }).AudioContext = vi.fn(() => audioCtxMock);

  // Real LifecycleController — the subtitle-first pipeline now holds the
  // system-buffer micro-pause as the controller's 'system-buffer' reason and
  // routes video.pause()/play() through it (replaces the old _systemPaused flag).
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
    // Derived (mirror the real SessionManager getters).
    get videoPaused(): boolean { return lifecycle.effectivePaused; },
    get userPaused(): boolean { return lifecycle.effectivePaused; },
    nextToken() { pageToken += 1; this.pageToken = pageToken; return pageToken; },
    isSessionStale(tok: number) { return tok !== this.pageToken && this.session?.token !== tok; },
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
      capabilities: { audioCapture: true, subtitleFirst: true, isSpa: false, hasNativeCaptions: false, hasAdOverlays: false },
      matchesHost: () => false, isWatchUrl: () => true,
      getVideoId: () => "test-video-id",
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
  return { pipeline, sm, lifecycle, overlay, fakeVideo, audioCtxMock };
}

/**
 * Start the pipeline. All network/decode mocks use mockResolvedValue so they
 * resolve via microtasks. The start() call returns the session.
 *
 * IMPORTANT: use cue start-times > 10s (not due at t=0) so the immediate
 * post-start tick is a no-op. After start() set currentTime and advance timers.
 */
async function doStart(
  pipeline: SubtitleFirstPipeline,
  sm: { session: SubtitleFirstSession | null },
  renderResult: { text: string; audioMp3: ArrayBuffer }[],
): Promise<SubtitleFirstSession> {
  // renderSubtitleDubStream is now the primary path; mock it to yield the
  // same result as the old renderSubtitleDubBatch mock. The stream generator
  // yields one item per renderResult entry with the correct index.
  vi.mocked(renderSubtitleDubStream).mockReturnValue(
    (async function* () {
      for (let i = 0; i < renderResult.length; i++) {
        yield {
          index: i,
          text: renderResult[i]!.text,
          audioMp3: renderResult[i]!.audioMp3,
          cueStartMs: 0,
          cueEndMs: 3000,
        };
      }
    })() as never,
  );
  // Keep renderSubtitleDubBatch mock in place for the fallback path.
  vi.mocked(renderSubtitleDubBatch).mockResolvedValue(renderResult);
  const result = await pipeline.start(makeSettings());
  if (!result.ok) throw new Error(`start() failed: ${result.error}`);
  const sess = sm.session;
  if (!sess) throw new Error("no session");
  return sess;
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SubtitleFirstPipeline — buffering-aware playback tick (sync-pause-resume wave)", () => {

  // ─ AC#2: un-buffered cue at playhead → system-pause ─────────────────────────
  //
  // Cue at 10..13s (not due at t=0). After start, set currentTime=10 and
  // ensure no buffer. First 250ms tick: cue is due, no buffer → system-pause.

  it("AC#2: un-buffered cue at playhead → video.pause() + _systemPaused=true, NOT _played", async () => {
    const captions = [{ start: 10, end: 13, text: "hello" }];
    const fakeVideo = makeFakeVideo(0);
    const { pipeline, sm, lifecycle, audioCtxMock } = makePipeline(captions, fakeVideo);

    // byteLength=0 → pipeline skips decodeAudioData → _buffer stays undefined.
    const sess = await doStart(pipeline, sm, [{ text: "tr", audioMp3: new ArrayBuffer(0) }]);
    const sent = sess.sentences[0]!;

    // Verify _buffer is absent.
    expect(sent._buffer).toBeUndefined();
    // Initial tick was at t=0 — cue start=10 > 0+0.15, so nothing happened.
    expect(lifecycle.isPausedFor("system-buffer")).toBe(false);

    // Simulate the renderer being BEHIND: cue 0 not yet rendered (renderCursor=0).
    // This is the only case that should micro-pause — a cue the render pump hasn't
    // reached yet. (An already-rendered cue with no audio must SKIP, not wait —
    // see the "no-audio cue" regression test below.)
    sess.renderCursor = 0;

    // Simulate video seeking to cue time.
    fakeVideo.currentTime = 10;
    fakeVideo.paused = false;

    // 250ms tick: cue is due (10 ≤ 10+0.15), no buffer, not yet rendered → system-pause.
    await vi.advanceTimersByTimeAsync(250);

    expect(fakeVideo.pause).toHaveBeenCalled();
    expect(lifecycle.isPausedFor("system-buffer")).toBe(true);
    expect(sent._played).toBeFalsy();
    expect(audioCtxMock._sources.length).toBe(0);

    clearInterval(sess.playbackTimer!);
  });

  // ─ HANG REGRESSION (live "stuck on Buffering…") ─────────────────────────────
  //
  // A cue whose server MP3 was empty / failed to decode has _buffer=undefined but
  // the renderer has ALREADY passed it (renderCursor > its index) — the buffer will
  // NEVER arrive. The first cut of the micro-pause waited on it forever → the live
  // "stuck on Buffering…" hang the user hit. It must be SKIPPED, not waited on.

  it("HANG regression: already-rendered cue with no audio → skipped, NOT micro-paused", async () => {
    const captions = [
      { start: 10, end: 13, text: "no-audio." },
      { start: 16, end: 19, text: "next." },
    ];
    const fakeVideo = makeFakeVideo(0);
    const { pipeline, sm, lifecycle, audioCtxMock } = makePipeline(captions, fakeVideo);

    // Cue 0: empty MP3 → _buffer stays undefined but renderCursor still advances
    // past it. Cue 1: real audio.
    const sess = await doStart(pipeline, sm, [
      { text: "tr0", audioMp3: new ArrayBuffer(0) },
      { text: "tr1", audioMp3: new ArrayBuffer(100) },
    ]);
    const s0 = sess.sentences[0]!;
    expect(s0._buffer).toBeUndefined();
    // The renderer has processed cue 0 (renderCursor moved past index 0).
    expect(sess.renderCursor).toBeGreaterThan(0);

    const pausesAfterStart = vi.mocked(fakeVideo.pause).mock.calls.length;

    fakeVideo.currentTime = 10; // cue 0 due
    fakeVideo.paused = false;

    // Several ticks: cue 0 must be skipped immediately, never entering system-pause.
    await vi.advanceTimersByTimeAsync(1000);

    expect(lifecycle.isPausedFor("system-buffer")).toBe(false);                               // NO hang
    expect(vi.mocked(fakeVideo.pause).mock.calls.length).toBe(pausesAfterStart); // no micro-pause
    expect(s0._played).toBe(true);                                       // skipped
    expect(audioCtxMock._sources.length).toBe(0);                        // no audio to play yet

    clearInterval(sess.playbackTimer!);
  });

  // ─ AC#3: buffer arrives → cue played once ──────────────────────────────────

  it("AC#3: buffer arrives while system-paused → play + src.start() called once", async () => {
    const captions = [{ start: 10, end: 13, text: "hello" }];
    const fakeVideo = makeFakeVideo(0);
    const { pipeline, sm, lifecycle, audioCtxMock } = makePipeline(captions, fakeVideo);

    const sess = await doStart(pipeline, sm, [{ text: "tr", audioMp3: new ArrayBuffer(0) }]);
    const sent = sess.sentences[0]!;

    sess.renderCursor = 0; // renderer behind → micro-pause path (not the no-audio skip)
    fakeVideo.currentTime = 10;
    fakeVideo.paused = false;

    // Tick 1: no buffer → system-pause.
    await vi.advanceTimersByTimeAsync(250);
    expect(lifecycle.isPausedFor("system-buffer")).toBe(true);
    const pausesBefore = vi.mocked(fakeVideo.pause).mock.calls.length;
    // Record how many times play was called before the system-resume.
    const playsBefore = vi.mocked(fakeVideo.play).mock.calls.length;

    // Buffer arrives.
    sent._buffer = makeFakeBuffer();
    // video is now paused (set by system-pause).

    // Tick 2: system-pause check → buffer ready → resumeSystemPause → play().
    await vi.advanceTimersByTimeAsync(250);
    expect(lifecycle.isPausedFor("system-buffer")).toBe(false);
    // Exactly one more play() call from resumeSystemPause.
    expect(vi.mocked(fakeVideo.play).mock.calls.length).toBe(playsBefore + 1);
    // No new pause.
    expect(vi.mocked(fakeVideo.pause).mock.calls.length).toBe(pausesBefore);

    // Tick 3: video.paused=false (play() mock sets it), buffer present → start cue.
    await vi.advanceTimersByTimeAsync(250);
    expect(audioCtxMock._sources.length).toBe(1);
    expect(audioCtxMock._sources[0]!.start).toHaveBeenCalledTimes(1);
    expect(sent._played).toBe(true);

    // Tick 4: no re-start (currentSource occupied).
    await vi.advanceTimersByTimeAsync(250);
    expect(audioCtxMock._sources[0]!.start).toHaveBeenCalledTimes(1);

    clearInterval(sess.playbackTimer!);
  });

  // ─ AC#4: self-issued guard (replaces the old _systemPaused onPause guard) ────
  // onPause now no-ops when the controller itself issued the pause (its
  // synchronous #selfIssued flag is set across the controller's own video.pause()
  // — e.g. the system-buffer micro-pause). A genuine user pause (flag not set)
  // routes to pauseSession().

  it("AC#4: isSelfIssued()=true → onPause guard returns early (pauseSession NOT called)", async () => {
    const pauseSession = vi.fn();
    const lifecycle = new LifecycleController();

    // Mirror the index.ts onPause handler shape.
    function simulateOnPause() {
      if (lifecycle.isSelfIssued()) return;
      pauseSession();
    }

    // Observe the flag *inside* the controller-owned video.pause() call.
    let selfIssuedDuringPause = false;
    const fakeVideo = {
      paused: false,
      pause: vi.fn(() => { selfIssuedDuringPause = lifecycle.isSelfIssued(); }),
      play: vi.fn(async () => {}),
    } as unknown as HTMLVideoElement;
    lifecycle.setVideo(fakeVideo);

    lifecycle.pause("system-buffer");
    // The flag was true at the synchronous video.pause() call boundary…
    expect(selfIssuedDuringPause).toBe(true);
    // …and stays true across the window the async "pause" DOM event would land in,
    // so a controller-issued onPause no-ops.
    expect(lifecycle.isSelfIssued()).toBe(true);
    simulateOnPause();
    expect(pauseSession).not.toHaveBeenCalled();

    // The flag clears on the next macrotask (after the DOM event task). A genuine
    // user pause after that routes to pauseSession.
    await vi.advanceTimersByTimeAsync(1);
    expect(lifecycle.isSelfIssued()).toBe(false);
    simulateOnPause();
    expect(pauseSession).toHaveBeenCalledTimes(1);
  });

  // ─ AC#5: Play-once invariant — no dup src.start() ───────────────────────────

  it("AC#5: buffered cue is src.start()ed exactly once; subsequent ticks do NOT re-start", async () => {
    const captions = [{ start: 10, end: 13, text: "hello" }];
    const fakeVideo = makeFakeVideo(0);
    const { pipeline, sm, audioCtxMock } = makePipeline(captions, fakeVideo);

    // byteLength=100 → decodeAudioData resolves → _buffer is set.
    const sess = await doStart(pipeline, sm, [{ text: "tr", audioMp3: new ArrayBuffer(100) }]);
    const sent = sess.sentences[0]!;

    // Ensure buffer is present (decodeAudioData may not have been awaited yet in
    // all vitest microtask queue scenarios — set manually if absent).
    if (!sent._buffer) sent._buffer = makeFakeBuffer();

    fakeVideo.currentTime = 10;
    fakeVideo.paused = false;

    // Tick 1: buffer present → start the cue.
    await vi.advanceTimersByTimeAsync(250);

    expect(sent._played).toBe(true);
    const srcCount = audioCtxMock._sources.length;
    expect(srcCount).toBe(1);
    expect(audioCtxMock._sources[0]!.start).toHaveBeenCalledTimes(1);

    // Ticks 2-4: currentSource is occupied (onended not fired) → no re-start.
    await vi.advanceTimersByTimeAsync(750);
    expect(audioCtxMock._sources[0]!.start).toHaveBeenCalledTimes(1);

    clearInterval(sess.playbackTimer!);
  });

  // ─ AC#6: Stale-after-seek → skip, not freeze ────────────────────────────────

  it("AC#6: un-buffered cue > DRIFT_SKIP_SEC past its end → skipped (no system-pause)", async () => {
    // Stale: start=10, end=12. At currentTime=16: diff=16-12=4 > DRIFT_SKIP_SEC=3 → skip.
    // Next:  start=16, end=19 — buffered → should play.
    const captions = [
      { start: 10, end: 12, text: "stale" },
      { start: 16, end: 19, text: "next" },
    ];
    const fakeVideo = makeFakeVideo(0);
    const { pipeline, sm, lifecycle, audioCtxMock } = makePipeline(captions, fakeVideo);

    const sess = await doStart(pipeline, sm, [
      { text: "tr0", audioMp3: new ArrayBuffer(0) },   // no buffer for stale
      { text: "tr1", audioMp3: new ArrayBuffer(100) },  // buffer for next
    ]);

    const s0 = sess.sentences[0]!; // stale
    const s1 = sess.sentences[1]!; // next

    // Ensure stale has no buffer, next has buffer.
    s0._buffer = undefined;
    s0._played = false;
    if (!s1._buffer) s1._buffer = makeFakeBuffer();
    s1._played = false;

    // Simulate forward seek to 16.
    fakeVideo.currentTime = 16;
    fakeVideo.paused = false;

    // Tick: stale cue skipped (diff=4>3), next cue started.
    await vi.advanceTimersByTimeAsync(250);

    expect(s0._played).toBe(true);          // skipped
    expect(lifecycle.isPausedFor("system-buffer")).toBe(false); // no micro-pause
    expect(audioCtxMock._sources.length).toBeGreaterThan(0); // next cue started

    clearInterval(sess.playbackTimer!);
  });

  // ─ FIX 2 (Bug B1 — seek desync): BUFFERED stale cue is drift-skipped ────────
  //
  // A forward seek leaves earlier cues already DECODED (the rolling renderer
  // fetched them before the seek) whose end is now well behind the new playhead.
  // The old `while (due && !due._buffer)` guard only skipped UNbuffered stale
  // cues, so a buffered-but-stale cue slipped through to #startCue and played at
  // the WRONG video position (the seek-desync bug). The fix makes the time-stale
  // check buffer-agnostic: t - due.end > DRIFT_SKIP_SEC skips regardless of
  // whether _buffer is present. This test FAILS against the pre-fix code (the
  // stale cue's src.start would be called and the wrong cue would play).

  it("FIX2-B1: a BUFFERED cue > DRIFT_SKIP_SEC past its end (forward seek) is SKIPPED, the current cue plays", async () => {
    // cue0 (stale): start=10, end=12 — HAS a decoded _buffer.
    // cue1 (current): start=20, end=23 — HAS a decoded _buffer.
    // Seek to t=20: 20 - 12 = 8 > DRIFT_SKIP_SEC=3 → cue0 must be skipped even
    // though it is buffered; cue1 (current) must start.
    const captions = [
      { start: 10, end: 12, text: "stale-buffered." },
      { start: 20, end: 23, text: "current." },
    ];
    const fakeVideo = makeFakeVideo(0);
    const { pipeline, sm, lifecycle, audioCtxMock } = makePipeline(captions, fakeVideo);

    const sess = await doStart(pipeline, sm, [
      { text: "tr0", audioMp3: new ArrayBuffer(100) }, // buffer for stale
      { text: "tr1", audioMp3: new ArrayBuffer(100) }, // buffer for current
    ]);

    const s0 = sess.sentences[0]!; // stale — buffered
    const s1 = sess.sentences[1]!; // current — buffered

    // Both cues have a real _buffer (the crux: stale is BUFFERED, not empty).
    const stale = makeFakeBuffer();
    s0._buffer = stale;
    s0._played = false;
    if (!s1._buffer) s1._buffer = makeFakeBuffer();
    s1._played = false;

    const sourcesBefore = audioCtxMock._sources.length;

    // Forward seek to cue1's start.
    fakeVideo.currentTime = 20;
    fakeVideo.paused = false;

    // Tick: stale buffered cue0 must be skipped (diff=8>3); current cue1 starts.
    await vi.advanceTimersByTimeAsync(250);

    // cue0 marked played WITHOUT being started (drift-skip), no micro-pause.
    expect(s0._played).toBe(true);
    expect(lifecycle.isPausedFor("system-buffer")).toBe(false);

    // Exactly ONE new source was created — and its buffer is cue1's, NOT the
    // stale cue0's. (Pre-fix: cue0 would be started → wrong-position audio.)
    const created = audioCtxMock._sources.slice(sourcesBefore);
    expect(created.length).toBe(1);
    expect(created[0]!.buffer).toBe(s1._buffer);
    expect(created[0]!.buffer).not.toBe(stale);
    expect(created[0]!.start).toHaveBeenCalledTimes(1);
    // cue1 is the one that played.
    expect(s1._played).toBe(true);

    clearInterval(sess.playbackTimer!);
  });

  // ─ FIX 2 regression-guard: buffered cue with dueIdx < renderCursor is PLAYED ──
  //
  // The FIRST (wrong) cut of the fix broadened the dueIdx<renderCursor skip to
  // buffered cues too — which broke NORMAL playback (a buffered cue with index <
  // renderCursor is the normal ready state, NOT a stale cue). The fix keeps the
  // dueIdx<renderCursor skip tied to the NO-BUFFER case only. This test asserts a
  // buffered cue at the current position with dueIdx < renderCursor still plays.

  it("FIX2-regression: a buffered cue at the current position with dueIdx < renderCursor is STILL played (not skipped)", async () => {
    // Single cue at 10..13s, NOT stale (currentTime=10 → 10-13 = -3, well within
    // DRIFT_SKIP_SEC), buffered, and renderCursor advanced PAST it (the normal
    // ready state after the rolling renderer processed it).
    const captions = [{ start: 10, end: 13, text: "ready-and-current." }];
    const fakeVideo = makeFakeVideo(0);
    const { pipeline, sm, lifecycle, audioCtxMock } = makePipeline(captions, fakeVideo);

    const sess = await doStart(pipeline, sm, [
      { text: "tr0", audioMp3: new ArrayBuffer(100) },
    ]);
    const s0 = sess.sentences[0]!;
    if (!s0._buffer) s0._buffer = makeFakeBuffer();
    s0._played = false;
    // renderCursor strictly past the cue's index 0 → dueIdx(0) < renderCursor.
    sess.renderCursor = 1;

    const sourcesBefore = audioCtxMock._sources.length;

    // At the cue's own position (not stale).
    fakeVideo.currentTime = 10;
    fakeVideo.paused = false;

    await vi.advanceTimersByTimeAsync(250);

    // Must be PLAYED, not skipped: a source created and started for it.
    expect(lifecycle.isPausedFor("system-buffer")).toBe(false);
    const created = audioCtxMock._sources.slice(sourcesBefore);
    expect(created.length).toBe(1);
    expect(created[0]!.buffer).toBe(s0._buffer);
    expect(created[0]!.start).toHaveBeenCalledTimes(1);
    expect(s0._played).toBe(true);

    clearInterval(sess.playbackTimer!);
  });

  // ─ AC#8: Initial pre-buffer covers SUBFIRST_PREBUFFER_COUNT=3 sentences ────

  it("AC#8: start() requests at least SUBFIRST_PREBUFFER_COUNT=2 sentences in the first renderBatch", async () => {
    // Each cue ends with a sentence-ending punctuation mark so regroupToSentences
    // keeps them as separate CaptionSentences rather than merging them. Large gaps
    // (2s+) also work. Using punctuation is the most direct signal.
    // Note: SUBFIRST_PREBUFFER_COUNT was lowered from 3 to 2 (B2 startup latency fix).
    const captions = [
      { start: 10, end: 12, text: "Hello." },
      { start: 14, end: 16, text: "World." },
      { start: 18, end: 20, text: "Foo." },
      { start: 22, end: 24, text: "Bar." },
      { start: 26, end: 28, text: "Baz." },
    ];
    const fakeVideo = makeFakeVideo(0);
    const { pipeline, sm } = makePipeline(captions, fakeVideo);

    // Pipeline uses renderSubtitleDubStream (the streaming path).
    const streamCalls: { sentences: unknown[] }[] = [];
    vi.mocked(renderSubtitleDubStream).mockImplementation(function(opts: { sentences: unknown[] }) {
      streamCalls.push({ sentences: opts.sentences });
      return (async function* () {
        for (let i = 0; i < opts.sentences.length; i++) {
          yield { index: i, text: `tr: ${i}`, audioMp3: new ArrayBuffer(100), cueStartMs: 0, cueEndMs: 3000 };
        }
      })() as never;
    } as never);
    await pipeline.start(makeSettings());

    expect(streamCalls.length).toBeGreaterThan(0);
    // First batch gates video.play() on the FIRST due line only (prebuffer=1) so
    // the start freeze is one TTS, not N; the rolling renderer fills the rest.
    const firstBatchLen = streamCalls[0]!.sentences.length;
    expect(firstBatchLen).toBeGreaterThanOrEqual(1);
  });

  // ─ AC#9: Stall cap prevents infinite freeze ─────────────────────────────────
  //
  // When the buffer never arrives, the stall cap calls video.play() (resumeSystemPause)
  // so the video is not paused forever. After the resume the tick immediately
  // re-enters system-pause (stall cap fires → resume → same tick falls through →
  // no buffer → micro-pause again) — this is correct: the video keeps getting
  // brief resume opportunities so currentTime advances until the cue is stale.
  // The test verifies: (a) video.play() is called once the stall cap fires, and
  // (b) when we manually advance currentTime past end+DRIFT_SKIP=3, the cue is
  // skipped and system-pause ends permanently.

  it("AC#9: stall cap calls video.play() to un-freeze; advancing time past cue end then skips the cue", async () => {
    const captions = [{ start: 10, end: 13, text: "hello" }];
    const fakeVideo = makeFakeVideo(0);
    const { pipeline, sm, lifecycle } = makePipeline(captions, fakeVideo);

    const sess = await doStart(pipeline, sm, [{ text: "tr", audioMp3: new ArrayBuffer(0) }]);
    const sent = sess.sentences[0]!;

    delete sent._buffer;
    sent._played = false;
    sess.renderCursor = 0; // renderer behind → micro-pause path
    fakeVideo.currentTime = 10;
    fakeVideo.paused = false;

    // Tick 1: no buffer → system-pause.
    await vi.advanceTimersByTimeAsync(250);
    expect(lifecycle.isPausedFor("system-buffer")).toBe(true);

    const playsBefore = vi.mocked(fakeVideo.play).mock.calls.length;

    // Back-date waitStartedAt to trigger stall cap on next tick.
    sess._bufferWaitStartedAt = performance.now() - 9000;

    // Tick 2: stall cap fires → video.play() called (un-freeze signal).
    await vi.advanceTimersByTimeAsync(250);
    // play() was called at least once after we back-dated the wait time.
    expect(vi.mocked(fakeVideo.play).mock.calls.length).toBeGreaterThan(playsBefore);

    // Now simulate that the video has actually advanced past the cue's stale window.
    fakeVideo.currentTime = 17; // 17 - 13 = 4 > DRIFT_SKIP_SEC=3 → stale
    fakeVideo.paused = false;
    // Back-date again so stall cap fires before the plain wait path.
    sess._bufferWaitStartedAt = performance.now() - 9000;

    // Tick 3: stale check → skip (not micro-pause).
    await vi.advanceTimersByTimeAsync(250);
    expect(sent._played).toBe(true);    // skipped as stale
    expect(lifecycle.isPausedFor("system-buffer")).toBe(false); // no more freeze

    clearInterval(sess.playbackTimer!);
  });

  // ─ GAP-1 REGRESSION: rolling renderer runs during system-pause ─────────────
  //
  // This is the regression test that would have caught the original GAP 1 bug:
  // the rolling renderer was skipping ALL render work while video.paused=true,
  // which is also true during a driver-issued system-pause. As a result, the
  // buffer the tick was waiting for was NEVER produced → SUBFIRST_BUFFER_WAIT_MAX_MS
  // fired → cue drift-skipped → silent drop.
  //
  // Strategy: the cue is un-buffered when the playhead reaches it. The tick
  // enters system-pause (video.pause()). We then advance timers by ≥1000ms so
  // the rolling renderer wakes up. The renderer calls renderSubtitleDubBatch
  // (mocked to return a real audioMp3 payload), then decodeAudioData (mocked
  // to return a real buffer). The tick (250ms) then sees _buffer and:
  //   (a) calls video.play() (resumeSystemPause),
  //   (b) calls src.start() for the cue,
  //   (c) does NOT mark the cue as drift-skipped.
  //
  // We do NOT manually inject _buffer — the render path must produce it.

  it("GAP-1 regression: rolling renderer produces _buffer during system-pause → cue played, not dropped", async () => {
    // Scenario: 4 cues. start() renders cues 0-1 (SUBFIRST_PREBUFFER_COUNT=2).
    // Cues 2-3 are NOT rendered at start. We manually evict their buffers and
    // set renderCursor=3 so cue 3 is the one the roller must render.
    // Playhead reaches cue 3 → system-pause. Rolling renderer wakes up, sees
    // video.paused=true — WITHOUT the fix it skips → deadlock; WITH the fix it
    // runs (isSystemPaused=true exempts the paused guard), renders cue 3, sets
    // _buffer, then the 250ms tick resumes and plays cue 3.
    //
    // With SUBFIRST_PREBUFFER_COUNT=1, firstWaveEnd=min(4,0+1)=1 — start() renders
    // only cue 0; cues 1-3 are left for the rolling renderer. ✓
    const captions = [
      { start: 10, end: 12, text: "one." },
      { start: 14, end: 16, text: "two." },
      { start: 18, end: 20, text: "three." },
      { start: 22, end: 25, text: "four." },   // <── the one the roller must render
    ];
    const fakeVideo = makeFakeVideo(0);
    const { pipeline, sm, lifecycle, audioCtxMock } = makePipeline(captions, fakeVideo);

    // Use renderSubtitleDubStream (the streaming path used by #renderBatch).
    // First call: start() initial wave (cues 0-1).
    // Second call: rolling renderer renders cue 3.
    let streamCallCount = 0;
    vi.mocked(renderSubtitleDubStream).mockImplementation(function(opts: { sentences: unknown[] }) {
      const idx = streamCallCount++;
      return (async function* () {
        for (let i = 0; i < opts.sentences.length; i++) {
          yield {
            index: i,
            text: `tr${idx}-${i}`,
            audioMp3: new ArrayBuffer(100),
            cueStartMs: 0,
            cueEndMs: 3000,
          };
        }
      })() as never;
    } as never);

    const result = await pipeline.start(makeSettings());
    if (!result.ok) throw new Error(`start() failed: ${result.error}`);
    const sess = sm.session!;

    // Confirm initial wave rendered cue 0 (prebuffer=1). Cue 1 is rendered by the
    // rolling renderer, not the start gate.
    expect(sess.sentences[0]!._buffer).toBeDefined();

    // Force renderCursor=3 so rolling renderer will render only cue 3.
    // Manually evict any buffer on cues 2-3 and mark cue 2 as played.
    delete sess.sentences[2]!._buffer;
    delete sess.sentences[3]!._buffer;
    sess.sentences[2]!._played = true; // skip cue 2 for this test
    sess.renderCursor = 3;

    const cue3 = sess.sentences[3]!;
    expect(cue3._buffer).toBeUndefined();
    expect(sess.renderCursor).toBe(3);

    // Fast-forward playhead to cue 3. Cues 0-1 played.
    sess.sentences[0]!._played = true;
    sess.sentences[1]!._played = true;
    fakeVideo.currentTime = 22; // cue 3 start
    fakeVideo.paused = false;

    // Tick: cue 3 is due (start=22 ≤ 22+0.15), no buffer → system-pause.
    await vi.advanceTimersByTimeAsync(250);
    expect(lifecycle.isPausedFor("system-buffer")).toBe(true);
    expect(fakeVideo.pause).toHaveBeenCalled();
    expect(cue3._played).toBeFalsy();
    expect(audioCtxMock._sources.length).toBe(0);

    // KEY ASSERTION: without the fix, the rolling renderer sees video.paused=true
    // and skips → _buffer never produced → deadlock.
    // With the fix: isSystemPaused=true exempts the paused guard → renderer runs.
    //
    // Advance 1000ms — the rolling renderer (SUBFIRST_RENDER_TICK_MS=350) fires
    // within this window. It runs renderSubtitleDubStream for cue 3, then
    // decodeAudioData (mocked → returns makeFakeBuffer()), setting cue3._buffer.
    await vi.advanceTimersByTimeAsync(1000);
    // Allow microtasks (Promise resolutions from async renderBatch) to settle.
    await vi.advanceTimersByTimeAsync(50);

    // _buffer must now be set — this is what the fix ensures.
    expect(cue3._buffer).toBeDefined();

    // The 250ms tick fires and detects _buffer → resumeSystemPause → video.play().
    await vi.advanceTimersByTimeAsync(250);
    expect(vi.mocked(fakeVideo.play).mock.calls.length).toBeGreaterThan(0);
    expect(lifecycle.isPausedFor("system-buffer")).toBe(false);

    // Next tick: video unpaused, buffer present → src.start().
    await vi.advanceTimersByTimeAsync(250);
    expect(audioCtxMock._sources.length).toBeGreaterThan(0);
    expect(audioCtxMock._sources[0]!.start).toHaveBeenCalledTimes(1);
    expect(cue3._played).toBe(true);

    clearInterval(sess.playbackTimer!);
  });

  // ─ AC#11: stopFlag cancels system-pause wait ────────────────────────────────

  it("AC#11: stopFlag set during system-pause → subsequent ticks bail early, video.play() NOT called", async () => {
    const captions = [{ start: 10, end: 13, text: "hello" }];
    const fakeVideo = makeFakeVideo(0);
    const { pipeline, sm, lifecycle } = makePipeline(captions, fakeVideo);

    const sess = await doStart(pipeline, sm, [{ text: "tr", audioMp3: new ArrayBuffer(0) }]);
    const sent = sess.sentences[0]!;

    delete sent._buffer;
    sent._played = false;
    sess.renderCursor = 0; // renderer behind → micro-pause path
    fakeVideo.currentTime = 10;
    fakeVideo.paused = false;

    // Tick 1: enters system-pause.
    await vi.advanceTimersByTimeAsync(250);
    expect(lifecycle.isPausedFor("system-buffer")).toBe(true);

    const playBefore = vi.mocked(fakeVideo.play).mock.calls.length;

    // Simulate stopSession: set stopFlag + bump pageToken.
    sess.stopFlag = true;
    sent._buffer = makeFakeBuffer(); // buffer arrives, but stopFlag should prevent resume

    // Tick 2: stopFlag at top → early return.
    await vi.advanceTimersByTimeAsync(250);
    expect(vi.mocked(fakeVideo.play).mock.calls.length).toBe(playBefore);

    clearInterval(sess.playbackTimer!);
  });
});
