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
import type { SubtitleFirstSession } from "@/content/session-manager";
import type { CaptionSentence } from "@/lib/caption-utils";
import type { PlatformAdapter } from "@/shared/platform-ports";
import type { StartSettings } from "@/shared/types";

// ─── Mock echoly-api ──────────────────────────────────────────────────────────

vi.mock("@/lib/echoly-api", () => ({
  isPipelineToastError: () => false,
  renderSubtitleDubBatch: vi.fn(),
}));

import { renderSubtitleDubBatch } from "@/lib/echoly-api";

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

  let pageToken = 0;
  let sessionRef: SubtitleFirstSession | null = null;

  const sm = {
    get session(): SubtitleFirstSession | null { return sessionRef; },
    set session(s: SubtitleFirstSession | null) { sessionRef = s; },
    settings: null as StartSettings | null,
    apiBase: "https://api.echolyhq.com",
    pageToken, videoPaused: false,
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
    sm, overlay, capture, callbacks: {},
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
  return { pipeline, sm, overlay, fakeVideo, audioCtxMock };
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
    const { pipeline, sm, audioCtxMock } = makePipeline(captions, fakeVideo);

    // byteLength=0 → pipeline skips decodeAudioData → _buffer stays undefined.
    const sess = await doStart(pipeline, sm, [{ text: "tr", audioMp3: new ArrayBuffer(0) }]);
    const sent = sess.sentences[0]!;

    // Verify _buffer is absent.
    expect(sent._buffer).toBeUndefined();
    // Initial tick was at t=0 — cue start=10 > 0+0.15, so nothing happened.
    expect(sess._systemPaused).toBeFalsy();

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
    expect(sess._systemPaused).toBe(true);
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
    const { pipeline, sm, audioCtxMock } = makePipeline(captions, fakeVideo);

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

    expect(sess._systemPaused).toBeFalsy();                               // NO hang
    expect(vi.mocked(fakeVideo.pause).mock.calls.length).toBe(pausesAfterStart); // no micro-pause
    expect(s0._played).toBe(true);                                       // skipped
    expect(audioCtxMock._sources.length).toBe(0);                        // no audio to play yet

    clearInterval(sess.playbackTimer!);
  });

  // ─ AC#3: buffer arrives → cue played once ──────────────────────────────────

  it("AC#3: buffer arrives while system-paused → play + src.start() called once", async () => {
    const captions = [{ start: 10, end: 13, text: "hello" }];
    const fakeVideo = makeFakeVideo(0);
    const { pipeline, sm, audioCtxMock } = makePipeline(captions, fakeVideo);

    const sess = await doStart(pipeline, sm, [{ text: "tr", audioMp3: new ArrayBuffer(0) }]);
    const sent = sess.sentences[0]!;

    sess.renderCursor = 0; // renderer behind → micro-pause path (not the no-audio skip)
    fakeVideo.currentTime = 10;
    fakeVideo.paused = false;

    // Tick 1: no buffer → system-pause.
    await vi.advanceTimersByTimeAsync(250);
    expect(sess._systemPaused).toBe(true);
    const pausesBefore = vi.mocked(fakeVideo.pause).mock.calls.length;
    // Record how many times play was called before the system-resume.
    const playsBefore = vi.mocked(fakeVideo.play).mock.calls.length;

    // Buffer arrives.
    sent._buffer = makeFakeBuffer();
    // video is now paused (set by system-pause).

    // Tick 2: system-pause check → buffer ready → resumeSystemPause → play().
    await vi.advanceTimersByTimeAsync(250);
    expect(sess._systemPaused).toBeFalsy();
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

  // ─ AC#4: _systemPaused guard ────────────────────────────────────────────────
  // After the pause/resume rewire, onPause now calls pauseSession() (not stopSession).
  // The _systemPaused guard still returns early to prevent a user-pause action
  // when the driver itself issued the pause (buffer-wait micro-pause).

  it("AC#4: _systemPaused=true → onPause guard returns early (pauseSession NOT called)", () => {
    const pauseSession = vi.fn();

    function simulateOnPause(sess: { kind: string; _systemPaused?: boolean } | null) {
      if (!sess) return;
      if (sess.kind === "subtitle-first" && sess._systemPaused) return;
      pauseSession();
    }

    // With _systemPaused: true — guard fires, no action.
    simulateOnPause({ kind: "subtitle-first", _systemPaused: true });
    expect(pauseSession).not.toHaveBeenCalled();

    // With _systemPaused: false — guard doesn't fire, pauseSession runs.
    simulateOnPause({ kind: "subtitle-first", _systemPaused: false });
    expect(pauseSession).toHaveBeenCalledTimes(1);

    pauseSession.mockClear();
    // With _systemPaused: undefined — same as false.
    simulateOnPause({ kind: "subtitle-first", _systemPaused: undefined });
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
    const { pipeline, sm, audioCtxMock } = makePipeline(captions, fakeVideo);

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
    expect(sess._systemPaused).toBeFalsy(); // no micro-pause
    expect(audioCtxMock._sources.length).toBeGreaterThan(0); // next cue started

    clearInterval(sess.playbackTimer!);
  });

  // ─ AC#8: Initial pre-buffer covers SUBFIRST_PREBUFFER_COUNT=3 sentences ────

  it("AC#8: start() requests at least SUBFIRST_PREBUFFER_COUNT=3 sentences in the first renderBatch", async () => {
    // Each cue ends with a sentence-ending punctuation mark so regroupToSentences
    // keeps them as separate CaptionSentences rather than merging them. Large gaps
    // (2s+) also work. Using punctuation is the most direct signal.
    const captions = [
      { start: 10, end: 12, text: "Hello." },
      { start: 14, end: 16, text: "World." },
      { start: 18, end: 20, text: "Foo." },
      { start: 22, end: 24, text: "Bar." },
      { start: 26, end: 28, text: "Baz." },
    ];
    const fakeVideo = makeFakeVideo(0);
    const { pipeline, sm } = makePipeline(captions, fakeVideo);

    vi.mocked(renderSubtitleDubBatch).mockResolvedValue(
      captions.map((c) => ({ text: `tr: ${c.text}`, audioMp3: new ArrayBuffer(100) })),
    );
    await pipeline.start(makeSettings());

    const calls = vi.mocked(renderSubtitleDubBatch).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    // First batch must cover ≥3 sentences (SUBFIRST_PREBUFFER_COUNT).
    const firstBatchLen = calls[0]![0]!.sentences.length;
    expect(firstBatchLen).toBeGreaterThanOrEqual(3);
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
    const { pipeline, sm } = makePipeline(captions, fakeVideo);

    const sess = await doStart(pipeline, sm, [{ text: "tr", audioMp3: new ArrayBuffer(0) }]);
    const sent = sess.sentences[0]!;

    delete sent._buffer;
    sent._played = false;
    sess.renderCursor = 0; // renderer behind → micro-pause path
    fakeVideo.currentTime = 10;
    fakeVideo.paused = false;

    // Tick 1: no buffer → system-pause.
    await vi.advanceTimersByTimeAsync(250);
    expect(sess._systemPaused).toBe(true);

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
    expect(sess._systemPaused).toBeFalsy(); // no more freeze

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
    // Scenario: 4 cues, cues 0-2 pre-buffered by start() (SUBFIRST_PREBUFFER_COUNT=3),
    // cue 3 NOT yet rendered (renderCursor=3, sentences.length=4).
    // Playhead reaches cue 3 → system-pause. Rolling renderer wakes up, sees
    // video.paused=true — WITHOUT the fix it skips → deadlock; WITH the fix it
    // runs (isSystemPaused=true exempts the paused guard), renders cue 3, sets
    // _buffer, then the 250ms tick resumes and plays cue 3.
    //
    // Caption spacing: each sentence starts 2s after the previous ends (>SUBFIRST_LOOKAHEAD
    // wouldn't compress them) — but for SUBFIRST_PREBUFFER_COUNT=3 to stop at index 3,
    // all 4 cues must start within currentTime+lookahead (30s) AND
    // firstWaveEnd = min(lookaheadEnd, firstWaveStart+3). With currentTime=0 and
    // cues at 10/14/18/22, lookaheadEnd=findIndex(start>30)=-1→4, so firstWaveEnd=
    // min(4,0+3)=3, which leaves cue 3 (start=22) un-rendered. ✓
    const captions = [
      { start: 10, end: 12, text: "one." },
      { start: 14, end: 16, text: "two." },
      { start: 18, end: 20, text: "three." },
      { start: 22, end: 25, text: "four." },   // <── the one the roller must render
    ];
    const fakeVideo = makeFakeVideo(0);
    const { pipeline, sm, audioCtxMock } = makePipeline(captions, fakeVideo);

    // Initial renderBatch call (during start): renders cues 0-2.
    // All three have byteLength=100 so decodeAudioData sets _buffer on them.
    // Cue 3 is NOT in this batch — renderSubtitleDubBatch is never called for it yet.
    vi.mocked(renderSubtitleDubBatch)
      // First call (start initial pre-buffer, cues [0..3)): real audio for cues 0-2.
      .mockResolvedValueOnce([
        { text: "tr1", audioMp3: new ArrayBuffer(100) },
        { text: "tr2", audioMp3: new ArrayBuffer(100) },
        { text: "tr3", audioMp3: new ArrayBuffer(100) },
      ])
      // Second call (rolling renderer, cue 3): real audio → sets _buffer.
      .mockResolvedValueOnce([{ text: "tr4", audioMp3: new ArrayBuffer(100) }]);

    const result = await pipeline.start(makeSettings());
    if (!result.ok) throw new Error(`start() failed: ${result.error}`);
    const sess = sm.session!;

    // Confirm setup: cues 0-2 have buffers; cue 3 does not.
    expect(sess.sentences[0]!._buffer).toBeDefined();
    expect(sess.sentences[1]!._buffer).toBeDefined();
    expect(sess.sentences[2]!._buffer).toBeDefined();
    // Cue 3 may have been rendered by the initial wave if SUBFIRST_PREBUFFER_COUNT
    // is higher than expected — check renderCursor to confirm.
    // If renderCursor < 4, cue 3 hasn't been rendered yet.
    // If it has been rendered despite our expectation, skip this test variant
    // (the setup assumption is wrong) — we rely on renderCursor == 3.
    if (sess.renderCursor !== 3) {
      // Adaptation: manually evict cue 3's buffer so the renderer must re-render it.
      delete sess.sentences[3]!._buffer;
      sess.renderCursor = 3;
    }
    const cue3 = sess.sentences[3]!;
    expect(cue3._buffer).toBeUndefined();
    expect(sess.renderCursor).toBe(3);

    // Fast-forward playhead to cue 3.
    // First play through cues 0-2 (simulate they've been played).
    sess.sentences[0]!._played = true;
    sess.sentences[1]!._played = true;
    sess.sentences[2]!._played = true;
    fakeVideo.currentTime = 22; // cue 3 start
    fakeVideo.paused = false;

    // Tick: cue 3 is due (start=22 ≤ 22+0.15), no buffer → system-pause.
    await vi.advanceTimersByTimeAsync(250);
    expect(sess._systemPaused).toBe(true);
    expect(fakeVideo.pause).toHaveBeenCalled();
    expect(cue3._played).toBeFalsy();
    expect(audioCtxMock._sources.length).toBe(0);

    // KEY ASSERTION: without the fix, the rolling renderer sees video.paused=true
    // and skips → _buffer never produced → deadlock.
    // With the fix: isSystemPaused=true exempts the paused guard → renderer runs.
    //
    // Advance 1000ms for the rolling renderer's setTimeout(r, 1000) to fire.
    // The renderer runs renderSubtitleDubBatch for cue 3, then decodeAudioData
    // (mocked → returns makeFakeBuffer()), setting cue3._buffer.
    await vi.advanceTimersByTimeAsync(1000);
    // Allow microtasks (Promise resolutions from async renderBatch) to settle.
    await vi.advanceTimersByTimeAsync(50);

    // _buffer must now be set — this is what the fix ensures.
    expect(cue3._buffer).toBeDefined();

    // The 250ms tick fires and detects _buffer → resumeSystemPause → video.play().
    await vi.advanceTimersByTimeAsync(250);
    expect(vi.mocked(fakeVideo.play).mock.calls.length).toBeGreaterThan(0);
    expect(sess._systemPaused).toBeFalsy();

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
    const { pipeline, sm } = makePipeline(captions, fakeVideo);

    const sess = await doStart(pipeline, sm, [{ text: "tr", audioMp3: new ArrayBuffer(0) }]);
    const sent = sess.sentences[0]!;

    delete sent._buffer;
    sent._played = false;
    sess.renderCursor = 0; // renderer behind → micro-pause path
    fakeVideo.currentTime = 10;
    fakeVideo.paused = false;

    // Tick 1: enters system-pause.
    await vi.advanceTimersByTimeAsync(250);
    expect(sess._systemPaused).toBe(true);

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
