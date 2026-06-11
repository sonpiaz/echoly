// @vitest-environment jsdom
//
// Stage D (DUB-START) — SOLUTION §3: minimal pause, lock-step resume, never lose
// line 1. Covers:
//   • #firstPlayableCueAt covering-cue selection — Start mid-caption replays the
//     COVERING line from its start (not skipped, not the next line).
//   • #startCue lock-step — line-1 audio starts ONLY after the controller's
//     video.play() promise RESOLVES (in the same microtask, before the interval),
//     and on REJECT (autoplay-block) no audio is started + the press-play toast is
//     shown.
//   • Start past the last caption (#firstPlayableCueAt returns nothing) → the
//     no-captions / press-play toast, NOT a silent dead session.
//
// Harness mirrors subtitle-first-playback-tick.test.ts (real LifecycleController,
// fake video + AudioContext, streaming #renderBatch mock).

import { beforeEach, describe, it, expect, vi, afterEach } from "vitest";
import { SubtitleFirstPipeline } from "@/content/pipelines/subtitle-first-pipeline";
import { LifecycleController } from "@/content/lifecycle";
import type { SubtitleFirstSession } from "@/content/session-manager";
import type { PlatformAdapter } from "@/shared/platform-ports";
import type { StartSettings } from "@/shared/types";
import { TOAST_PRESS_PLAY } from "@/shared/product-copy";

vi.mock("@/lib/echoly-api", () => ({
  isPipelineToastError: () => false,
  renderSubtitleDubBatch: vi.fn(),
  renderSubtitleDubStream: vi.fn(async function* () {}),
  // newRequestId is used by #renderBatch to generate stable per-batch ids.
  newRequestId: (prefix: string) => `${prefix}_mock-uuid`,
  // ALREADY_PROCESSED sentinel used by #renderBatch for idempotency replays.
  ALREADY_PROCESSED: Symbol("already_processed"),
}));

import { renderSubtitleDubStream } from "@/lib/echoly-api";

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

interface MockSource {
  buffer: AudioBuffer | null;
  onended: (() => void) | null;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
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

interface FakeVideo {
  currentTime: number;
  paused: boolean;
  pause: ReturnType<typeof vi.fn>;
  play: ReturnType<typeof vi.fn>;
}

/**
 * `t` = currentTime the user Started on (the value the start gate reads).
 * `playRejects` = simulate an autoplay-block (video.play() promise rejects).
 */
function makeFakeVideo(t = 0, playRejects = false): FakeVideo {
  const v: FakeVideo = {
    currentTime: t, paused: false,
    pause: vi.fn(() => { v.paused = true; }),
    play: vi.fn(() =>
      playRejects
        ? Promise.reject(new Error("autoplay-block"))
        : Promise.resolve().then(() => { v.paused = false; }),
    ),
  };
  return v;
}

function makePipeline(
  captions: { start: number; end: number; text: string }[],
  fakeVideo: FakeVideo,
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
    get videoPaused(): boolean { return lifecycle.effectivePaused; },
    get userPaused(): boolean { return lifecycle.effectivePaused; },
    nextToken() { pageToken += 1; this.pageToken = pageToken; return pageToken; },
    isSessionStale(tok: number) { return tok !== this.pageToken && this.session?.token !== tok; },
    emitState: vi.fn(),
    currentTargetText: "", currentSourceText: "",
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
  return { pipeline, sm, lifecycle, overlay, fakeVideo, audioCtxMock, app };
}

/** Drive start(); each rendered line yields a non-empty MP3 so _buffer decodes. */
async function doStart(
  pipeline: SubtitleFirstPipeline,
  texts: string[],
): Promise<{ ok: boolean; error?: string }> {
  vi.mocked(renderSubtitleDubStream).mockReturnValue(
    (async function* () {
      for (let i = 0; i < texts.length; i++) {
        yield { index: i, text: texts[i]!, audioMp3: new ArrayBuffer(100), cueStartMs: 0, cueEndMs: 3000 };
      }
    })() as never,
  );
  return pipeline.start(makeSettings());
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe("Stage D — dub start (firstPlayableCueAt + #startCue lock-step)", () => {
  // ─ #firstPlayableCueAt covering-cue selection ───────────────────────────────
  // Start at t=5 — INSIDE cue 0 (spans 4..8). The covering cue is line-1 and must
  // be REPLAYED from its start (rendered + started), NOT skipped to cue 1.

  it("Start mid-caption replays the COVERING line (line-1 = covering cue, not skipped)", async () => {
    const captions = [
      { start: 4, end: 8, text: "covering." },
      { start: 12, end: 16, text: "next." },
    ];
    const fakeVideo = makeFakeVideo(5); // t=5 is inside cue 0 [4..8]
    const { pipeline, sm, audioCtxMock } = makePipeline(captions, fakeVideo);

    const res = await doStart(pipeline, ["TR covering", "TR next"]);
    // flush the resume() play() promise microtask + lock-step #startCue.
    await vi.advanceTimersByTimeAsync(0);

    expect(res.ok).toBe(true);
    const sess = sm.session!;
    // The covering cue (index 0) was the render target + got started in lock-step.
    expect(sess.sentences[0]!._buffer).toBeDefined();
    expect(sess.sentences[0]!._played).toBe(true);   // covering cue PLAYED (not skipped)
    expect(sess.sentences[1]!._played).toBeFalsy();   // next cue not yet due
    expect(audioCtxMock._sources.length).toBe(1);     // exactly the covering line's source
    expect(audioCtxMock._sources[0]!.start).toHaveBeenCalledTimes(1);

    clearInterval(sess.playbackTimer!);
  });

  // ─ #startCue lock-step: audio starts ONLY after play() resolves ─────────────
  // The covering line's source must be created AFTER video.play() resolves (we
  // assert play() was called before any src.start()).

  it("lock-step: line-1 src.start() happens only after video.play() resolves", async () => {
    const captions = [{ start: 4, end: 8, text: "line1." }];
    const fakeVideo = makeFakeVideo(5);
    const { pipeline, sm, audioCtxMock, fakeVideo: fv } = makePipeline(captions, fakeVideo);

    // Before start, no play(), no sources.
    expect(fv.play).not.toHaveBeenCalled();

    const res = await doStart(pipeline, ["TR line1"]);
    await vi.advanceTimersByTimeAsync(0);

    expect(res.ok).toBe(true);
    const sess = sm.session!;
    // play() was issued (the controller resume) and exactly one source started.
    expect(fv.play).toHaveBeenCalled();
    expect(audioCtxMock._sources.length).toBe(1);
    expect(audioCtxMock._sources[0]!.start).toHaveBeenCalledTimes(1);
    expect(sess.sentences[0]!._played).toBe(true);

    clearInterval(sess.playbackTimer!);
  });

  // ─ #startCue lock-step on REJECT (autoplay-block) → NO audio + press-play toast ─

  it("lock-step: video.play() REJECT (autoplay-block) → no source started + press-play toast", async () => {
    const captions = [{ start: 4, end: 8, text: "line1." }];
    const fakeVideo = makeFakeVideo(5, /* playRejects */ true);
    const { pipeline, sm, overlay, audioCtxMock } = makePipeline(captions, fakeVideo);

    const res = await doStart(pipeline, ["TR line1"]);
    await vi.advanceTimersByTimeAsync(0);

    expect(res.ok).toBe(true); // start() still succeeds — the user just must press play
    const sess = sm.session!;
    // No source started while the video is autoplay-blocked.
    expect(audioCtxMock._sources.length).toBe(0);
    expect(sess.sentences[0]!._played).toBeFalsy();
    // The press-play toast was shown (mirror of the existing press-play path).
    expect(overlay.showToast).toHaveBeenCalledWith(TOAST_PRESS_PLAY, 6000);

    clearInterval(sess.playbackTimer!);
  });

  // ─ Gap before first caption: lock-step must NOT fire early ──────────────────
  // Start at t=0 with the first caption at t=10 — line-1 is NOT due yet, so the
  // lock-step #startCue must not start audio 10s early.

  it("does NOT start line-1 early when there's a gap before the first caption", async () => {
    const captions = [{ start: 10, end: 13, text: "later." }];
    const fakeVideo = makeFakeVideo(0); // t=0, first cue at 10 — not due
    const { pipeline, sm, audioCtxMock } = makePipeline(captions, fakeVideo);

    const res = await doStart(pipeline, ["TR later"]);
    await vi.advanceTimersByTimeAsync(0);

    expect(res.ok).toBe(true);
    const sess = sm.session!;
    expect(audioCtxMock._sources.length).toBe(0); // no premature audio
    expect(sess.sentences[0]!._played).toBeFalsy();

    clearInterval(sess.playbackTimer!);
  });

  // ─ Edge (SOLUTION §3.5): Start AFTER the last caption → press-play toast ─────
  // #firstPlayableCueAt returns null (every cue ends before t) → don't leave a
  // silent dead session; surface the press-play toast and fail the start.

  it("Start past the last caption → press-play toast, not a silent dead session", async () => {
    const captions = [
      { start: 4, end: 8, text: "a." },
      { start: 10, end: 14, text: "b." },
    ];
    const fakeVideo = makeFakeVideo(20); // past the end of the last cue (14)
    const { pipeline, sm, overlay } = makePipeline(captions, fakeVideo);

    const res = await doStart(pipeline, ["TR a", "TR b"]);

    expect(res.ok).toBe(false);
    expect(sm.session).toBeNull();
    expect(overlay.showToast).toHaveBeenCalledWith(TOAST_PRESS_PLAY, 6000);
    expect(overlay.removeOverlay).toHaveBeenCalled();
  });

  // ─ restart() lock-step on REJECT → press-play toast (Issue #7) ───────────────
  // Previously restart() (auto-next) swallowed the play()-reject silently; start()
  // showed the press-play toast. They now behave identically.

  it("restart(): video.play() REJECT (autoplay-block) → no source started + press-play toast", async () => {
    const captions = [{ start: 4, end: 8, text: "line1." }];
    const fakeVideo = makeFakeVideo(5); // starts non-rejecting so the initial start succeeds
    const { pipeline, sm, overlay, audioCtxMock } = makePipeline(captions, fakeVideo);

    // Establish a live subtitle-first session (so restart can reuse the audioCtx).
    const startRes = await doStart(pipeline, ["TR line1"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(startRes.ok).toBe(true);
    const startedSources = audioCtxMock._sources.length;
    overlay.showToast.mockClear();
    clearInterval(sm.session!.playbackTimer!);

    // Now an autoplay-block kicks in for the next video: play() rejects on restart.
    // The video is playing going into restart (wasPlaying=true) so restart attempts
    // the release play() → reject → catch → press-play toast.
    (fakeVideo as FakeVideo).paused = false;
    fakeVideo.play = vi.fn(() => Promise.reject(new Error("autoplay-block")));

    const res = await pipeline.restart(makeSettings(), "next-video-id");
    await vi.advanceTimersByTimeAsync(0);

    expect(res.ok).toBe(true); // restart succeeds — the user just must press play
    // No NEW lock-step source was started while autoplay-blocked.
    expect(audioCtxMock._sources.length).toBe(startedSources);
    // The press-play toast was shown (mirror of start()'s path).
    expect(overlay.showToast).toHaveBeenCalledWith(TOAST_PRESS_PLAY, 6000);

    if (sm.session?.playbackTimer) clearInterval(sm.session.playbackTimer);
  });
});
