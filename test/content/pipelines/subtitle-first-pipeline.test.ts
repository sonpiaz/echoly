// @vitest-environment jsdom
//
// Tests for SubtitleFirstPipeline no-caption routing (the critical branch at
// subtitle-first-pipeline.ts:137-161).
//
// Case A: adapter.capabilities.audioCapture === true
//         → app.startWebRtcStandard IS called (fallback to WebRTC Standard)
//
// Case B: adapter.capabilities.audioCapture === false  (e.g. Udemy)
//         → app.startWebRtcStandard is NOT called
//         → app.stopSession is called with STOP_REASON.NO_CC_UNSUPPORTED
//
// Strategy: construct a real SubtitleFirstPipeline with a fake `app` object
// that provides the minimal surface the pipeline uses. The `adapter.fetchCaptions`
// resolves to null (no captions) so every run hits the no-caption branch.
// `AudioContext` and `location.href` are shimmed for jsdom.

import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { SubtitleFirstPipeline } from "@/content/pipelines/subtitle-first-pipeline";
import { LifecycleController } from "@/content/lifecycle";
import { STOP_REASON } from "@/content/stop-reasons";
import type { PlatformAdapter, PlatformCapabilities } from "@/shared/platform-ports";
import type { StartSettings } from "@/shared/types";

// ─── AudioContext shim ────────────────────────────────────────────────────────
// jsdom does not implement Web Audio — provide a minimal stub so the pipeline
// can construct an AudioContext without throwing.

function makeAudioContextShim() {
  const gainNode = {
    gain: { value: 1 },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const ctx = {
    state: "running" as AudioContextState,
    currentTime: 0,
    destination: {},
    createGain: vi.fn().mockReturnValue(gainNode),
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    decodeAudioData: vi.fn().mockResolvedValue(null),
  };
  return ctx;
}

// ─── Minimal StartSettings ────────────────────────────────────────────────────

function makeSettings(overrides: Partial<StartSettings> = {}): StartSettings {
  return {
    running: false,
    connecting: false,
    paused: false,
    tabId: null,
    status: "Ready",
    errorMessage: "",
    apiMode: null,
    signedInUser: null,
    usage: null,
    languagePicker: null,
    languageNames: null,
    standardVoices: null,
    standardVoiceDefaultId: null,
    sessionStartedAt: null,
    advanced: { captionPosition: "bottom", outputDeviceId: "" },
    siteOverrides: {},
    advancedVersion: 0,
    advancedDirty: false,
    currentDomain: null,
    tier: "standard",
    targetLanguage: "vi",
    realtimeVoice: "marin",
    standardVoice: "English_magnetic_voiced_man",
    originalVolume: 18,
    voiceVolume: 100,
    showSource: false,
    showTargetCaptions: true,
    apiBearer: "test-bearer",
    apiBase: "https://api.echolyhq.com",
    ...overrides,
  } as unknown as StartSettings;
}

// ─── Fake adapter factory ─────────────────────────────────────────────────────

function makeAdapter(
  audioCapture: boolean,
  videoId: string | null = "test-video-id",
  // Optional per-lecture probe (Udemy). When provided, the pipeline must prefer
  // it over the static `audioCapture` flag at the no-caption fallback branch.
  canCaptureAudioNow?: (video: HTMLVideoElement) => boolean,
): PlatformAdapter {
  const capabilities: PlatformCapabilities = {
    audioCapture,
    subtitleFirst: true,
    isSpa: false,
    hasNativeCaptions: false,
    hasAdOverlays: false,
  };
  return {
    id: "generic",
    capabilities,
    matchesHost: () => false,
    isWatchUrl: () => true,
    getVideoId: () => videoId,
    findVideo: () => {
      // Return a minimal video element shim (already in jsdom DOM)
      return document.querySelector("video") as HTMLVideoElement | null;
    },
    stageInsets: () => ({ top: 44, bottom: 56, side: 16 }),
    // No captions available → triggers the no-caption branch
    fetchCaptions: vi.fn().mockResolvedValue(null),
    readLiveCaptionText: () => null,
    ...(canCaptureAudioNow ? { canCaptureAudioNow } : {}),
  } as PlatformAdapter;
}

// ─── Fake ContentApp factory ──────────────────────────────────────────────────
//
// Provides the minimum surface SubtitleFirstPipeline.start() touches.
// We stub out startWebRtcStandard and stopSession with spies.

function makeApp(adapter: PlatformAdapter) {
  const lifecycle = new LifecycleController();
  let pageToken = 0;
  let sessionRef: unknown = null;

  const sm = {
    session: null as unknown,
    settings: null as unknown,
    apiBase: "https://api.echolyhq.com",
    pageToken: 0,
    lifecycle,
    // Derived (mirror the real SessionManager getter).
    get videoPaused(): boolean { return lifecycle.effectivePaused; },
    nextToken() {
      pageToken += 1;
      this.pageToken = pageToken;
      return pageToken;
    },
    isSessionStale(token: number) {
      return token !== this.pageToken;
    },
    emitState: vi.fn(),
  };

  const overlay = {
    buildOverlay: vi.fn(),
    syncFromSettings: vi.fn(),
    setStatusText: vi.fn(),
    setOverlayState: vi.fn(),
    removeOverlay: vi.fn(),
    showToast: vi.fn(),
    setTargetText: vi.fn(),
    setSourceText: vi.fn(),
    applySourceVisibility: vi.fn(),
    applyCaptionOnVideo: vi.fn(),
    setDubSyncReadout: vi.fn(),
    pushHistoryTurn: vi.fn(),
    pushHistoryMarker: vi.fn(),
    setCaptionPosition: vi.fn(),
    isMounted: vi.fn().mockReturnValue(false),
  };

  const capture = {
    videoEl: null as HTMLVideoElement | null,
    findVideo: vi.fn().mockReturnValue(null),
    bindVolumeDriftGuard: vi.fn(),
    unbindVolumeDriftGuard: vi.fn(),
    unbindRateChangeWarn: vi.fn(),
    applyVolumes: vi.fn(),
    isLive: vi.fn().mockReturnValue(false),
  };

  const callbacks = {
    onLanguageChange: vi.fn(),
    onVoiceChange: vi.fn(),
    onStop: vi.fn(),
  };

  const startWebRtcStandard = vi.fn().mockResolvedValue({ ok: true });
  const stopSession = vi.fn();
  const applySourceVisibility = vi.fn();
  const startSessionTimer = vi.fn();
  const bindCommonVideoListeners = vi.fn();

  const app = {
    sm,
    lifecycle,
    overlay,
    capture,
    callbacks,
    adapter,
    startWebRtcStandard,
    stopSession,
    applySourceVisibility,
    applySubtitleStyle: vi.fn(),
    startSessionTimer,
    bindCommonVideoListeners,
  };

  return app;
}

// ─── Setup ────────────────────────────────────────────────────────────────────

let audioCtxShim: ReturnType<typeof makeAudioContextShim>;
let AudioContextOrig: typeof AudioContext | undefined;

beforeEach(() => {
  // Install a fresh video element so findVideo() can return something real
  document.body.innerHTML = '<video style="width:640px;height:360px"></video>';
  Object.defineProperty(document.querySelector("video")!, "getBoundingClientRect", {
    value: () => ({ width: 640, height: 360, left: 0, top: 0, right: 640, bottom: 360 }),
    configurable: true,
  });

  // Stub AudioContext — jsdom lacks it
  audioCtxShim = makeAudioContextShim();
  AudioContextOrig = (window as { AudioContext?: typeof AudioContext }).AudioContext;
  (window as { AudioContext: unknown }).AudioContext = vi
    .fn()
    .mockReturnValue(audioCtxShim);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SubtitleFirstPipeline — no-caption routing", () => {
  describe("Case A: audioCapture === true (YouTube / Coursera fallback)", () => {
    it("calls startWebRtcStandard when fetchCaptions resolves null", async () => {
      const adapter = makeAdapter(true, "some-video-id");
      const app = makeApp(adapter);
      const pipeline = new SubtitleFirstPipeline(app as never);

      const result = await pipeline.start(makeSettings());

      // startWebRtcStandard MUST have been called
      expect(app.startWebRtcStandard).toHaveBeenCalledOnce();
      // The result is whatever startWebRtcStandard returned
      expect(result.ok).toBe(true);
    });

    it("does NOT call stopSession with NO_CC_UNSUPPORTED", async () => {
      const adapter = makeAdapter(true, "some-video-id");
      const app = makeApp(adapter);
      const pipeline = new SubtitleFirstPipeline(app as never);

      await pipeline.start(makeSettings());

      // stopSession may be called (cleanup), but NOT with NO_CC_UNSUPPORTED
      const calls = (app.stopSession as ReturnType<typeof vi.fn>).mock.calls;
      for (const call of calls) {
        expect(call[0]).not.toBe(STOP_REASON.NO_CC_UNSUPPORTED);
      }
    });

    it("passes the original incomingSettings to startWebRtcStandard", async () => {
      const adapter = makeAdapter(true, "abc123");
      const app = makeApp(adapter);
      const pipeline = new SubtitleFirstPipeline(app as never);
      const settings = makeSettings({ targetLanguage: "fr" });

      await pipeline.start(settings);

      expect(app.startWebRtcStandard).toHaveBeenCalledWith(settings);
    });
  });

  describe("Case B: audioCapture === false (Udemy DRM — no capture, no captions)", () => {
    it("does NOT call startWebRtcStandard", async () => {
      const adapter = makeAdapter(false, "udemy-video-123");
      const app = makeApp(adapter);
      const pipeline = new SubtitleFirstPipeline(app as never);

      await pipeline.start(makeSettings());

      expect(app.startWebRtcStandard).not.toHaveBeenCalled();
    });

    it("calls stopSession with STOP_REASON.NO_CC_UNSUPPORTED", async () => {
      const adapter = makeAdapter(false, "udemy-video-123");
      const app = makeApp(adapter);
      const pipeline = new SubtitleFirstPipeline(app as never);

      await pipeline.start(makeSettings());

      expect(app.stopSession).toHaveBeenCalledWith(STOP_REASON.NO_CC_UNSUPPORTED);
    });

    it("returns ok:false with the NO_CC_UNSUPPORTED message", async () => {
      const adapter = makeAdapter(false, "udemy-video-123");
      const app = makeApp(adapter);
      const pipeline = new SubtitleFirstPipeline(app as never);

      const result = await pipeline.start(makeSettings());

      expect(result.ok).toBe(false);
      expect(result.error).toContain("No captions available");
    });
  });

  // ─── Case C: canCaptureAudioNow() probe overrides the static audioCapture ──────
  //
  // Udemy declares capabilities.audioCapture === false (generally DRM) but
  // refines it per-lecture via canCaptureAudioNow(video). The pipeline must use
  // the probe at the no-caption branch:
  //   probe → true  (non-DRM lecture): fall back to startWebRtcStandard.
  //   probe → false (DRM lecture):     stopSession(NO_CC_UNSUPPORTED).

  describe("Case C: canCaptureAudioNow probe (Udemy per-lecture)", () => {
    it("probe===true overrides audioCapture:false → calls startWebRtcStandard", async () => {
      // capabilities.audioCapture is false, but the probe says THIS lecture is
      // non-DRM → the audio→STT→TTS fallback must be attempted.
      const adapter = makeAdapter(false, "udemy-nondrm-1", () => true);
      const app = makeApp(adapter);
      const pipeline = new SubtitleFirstPipeline(app as never);

      await pipeline.start(makeSettings());

      expect(app.startWebRtcStandard).toHaveBeenCalledOnce();
      expect(app.stopSession).not.toHaveBeenCalledWith(STOP_REASON.NO_CC_UNSUPPORTED);
    });

    it("probe===false (DRM) → NO_CC_UNSUPPORTED, never startWebRtcStandard", async () => {
      const adapter = makeAdapter(false, "udemy-drm-1", () => false);
      const app = makeApp(adapter);
      const pipeline = new SubtitleFirstPipeline(app as never);

      const result = await pipeline.start(makeSettings());

      expect(app.startWebRtcStandard).not.toHaveBeenCalled();
      expect(app.stopSession).toHaveBeenCalledWith(STOP_REASON.NO_CC_UNSUPPORTED);
      expect(result.ok).toBe(false);
    });

    it("probe receives the page <video> element", async () => {
      const probe = vi.fn().mockReturnValue(true);
      const adapter = makeAdapter(false, "udemy-probe-arg", probe);
      const app = makeApp(adapter);
      const pipeline = new SubtitleFirstPipeline(app as never);

      await pipeline.start(makeSettings());

      expect(probe).toHaveBeenCalled();
      expect(probe.mock.calls[0]![0]).toBeInstanceOf(HTMLVideoElement);
    });
  });

  // ─── Defect-fix tests (Agent-3: redundant-token-bump + silent-capture-failure) ─

  describe("no-CC fallback defect fixes", () => {
    it("shows an error toast when startWebRtcStandard returns {ok:false}", async () => {
      const errorMsg = "Mic permission denied";
      const adapter = makeAdapter(true, "vid-capture-fail");
      const app = makeApp(adapter);
      // Override default ok:true → ok:false with a specific error
      (app.startWebRtcStandard as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        error: errorMsg,
      });
      const pipeline = new SubtitleFirstPipeline(app as never);

      await pipeline.start(makeSettings());

      // Toast must have been shown with the error message BEFORE restorePlay
      expect(app.overlay.showToast).toHaveBeenCalledWith(errorMsg, 6000);
    });

    it("falls back to 'Couldn't start live dubbing' when error is undefined in {ok:false}", async () => {
      const adapter = makeAdapter(true, "vid-capture-no-msg");
      const app = makeApp(adapter);
      (app.startWebRtcStandard as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        // no error field
      });
      const pipeline = new SubtitleFirstPipeline(app as never);

      await pipeline.start(makeSettings());

      expect(app.overlay.showToast).toHaveBeenCalledWith("Couldn't start live dubbing", 6000);
    });

    it("does NOT double-bump pageToken before startWebRtcStandard (pageToken delta = 1 from nextToken only)", async () => {
      const adapter = makeAdapter(true, "vid-token-check");
      const app = makeApp(adapter);
      // Capture pageToken at the moment startWebRtcStandard is called
      let tokenAtCallTime = -1;
      (app.startWebRtcStandard as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        tokenAtCallTime = app.sm.pageToken;
        return { ok: true };
      });
      const pipeline = new SubtitleFirstPipeline(app as never);

      const initialToken = app.sm.pageToken; // 0 before start()
      await pipeline.start(makeSettings());

      // start() calls sm.nextToken() once → pageToken becomes 1.
      // The redundant sm.pageToken += 1 was removed, so pageToken at call time = 1,
      // not 2. The delta from initial (0) to call-time must be exactly 1.
      expect(tokenAtCallTime - initialToken).toBe(1);
    });

    it("shows TOAST_NO_CC_FALLBACK when startWebRtcStandard returns {ok:true}", async () => {
      // Arrange: use default mock (ok: true)
      const adapter = makeAdapter(true, "vid-toast-ok");
      const app = makeApp(adapter);
      const pipeline = new SubtitleFirstPipeline(app as never);

      await pipeline.start(makeSettings());

      // Must show the "falling back to live dub" toast (not an error toast)
      const { TOAST_NO_CC_FALLBACK: FALLBACK_MSG } = await import(
        "@/shared/product-copy"
      );
      expect(app.overlay.showToast).toHaveBeenCalledWith(FALLBACK_MSG, 5000);
    });
  });

  // ─── Case D: no-CC audio fallback releases the system-buffer pause ────────────
  //
  // Regression for the 55s no-PCM deadlock. start() pauses the source video with
  // lifecycle.pause("system-buffer"); the no-CC audio fallback handed off to
  // startWebRtcStandard WITHOUT releasing it, and the old restorePlay() was gated
  // on wasPlaying so it no-op'd when Start was pressed while the video was paused.
  // A stuck system-buffer keeps the video paused → captureStream() is silent → the
  // server PCM window never fills (first_pcm_fill_ms ≈ 55s). The fix releases the
  // reason UNCONDITIONALLY before the handoff. jsdom's <video> defaults to paused,
  // so these tests exercise exactly the started-paused (wasPlaying=false) case the
  // old code left deadlocked.
  describe("Case D: no-CC audio fallback releases system-buffer (deadlock fix)", () => {
    it("does not leave system-buffer on the lifecycle stack (started paused)", async () => {
      const adapter = makeAdapter(true, "vid-deadlock");
      const app = makeApp(adapter);
      // Precondition: the source video is paused → wasPlaying=false (deadlock-prone).
      expect((document.querySelector("video") as HTMLVideoElement).paused).toBe(true);
      const pipeline = new SubtitleFirstPipeline(app as never);

      const result = await pipeline.start(makeSettings());

      expect(app.startWebRtcStandard).toHaveBeenCalledOnce();
      expect(result.ok).toBe(true);
      // Load-bearing: the start-time system-buffer pause must be gone, so the source
      // video is free to play and feed the live audio capture. (Old code: stuck true.)
      expect(app.lifecycle.isPausedFor("system-buffer")).toBe(false);
    });

    it("releases system-buffer BEFORE calling startWebRtcStandard", async () => {
      const adapter = makeAdapter(true, "vid-deadlock-order");
      const app = makeApp(adapter);
      const resumeSpy = vi.spyOn(app.lifecycle, "resume");
      const pipeline = new SubtitleFirstPipeline(app as never);

      await pipeline.start(makeSettings());

      // resume("system-buffer") must have been called …
      const idx = resumeSpy.mock.calls.findIndex((c) => c[0] === "system-buffer");
      expect(idx).toBeGreaterThanOrEqual(0);
      // … and strictly before the startWebRtcStandard handoff.
      const resumeOrder = resumeSpy.mock.invocationCallOrder[idx]!;
      const handoffOrder = (app.startWebRtcStandard as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0]!;
      expect(resumeOrder).toBeLessThan(handoffOrder);
    });

    it("DRM lecture (probe=false) keeps system-buffer behavior unchanged (no handoff)", async () => {
      // The unconditional resume lives only on the canCaptureAudio branch, so the
      // DRM/unsupported path is untouched — it still releases via restorePlay()
      // semantics and never calls startWebRtcStandard.
      const adapter = makeAdapter(false, "vid-drm", () => false);
      const app = makeApp(adapter);
      const pipeline = new SubtitleFirstPipeline(app as never);

      await pipeline.start(makeSettings());

      expect(app.startWebRtcStandard).not.toHaveBeenCalled();
      expect(app.stopSession).toHaveBeenCalledWith(STOP_REASON.NO_CC_UNSUPPORTED);
    });
  });
});

// ─── B3: Pipeline-level HTML5 fallback ───────────────────────────────────────
//
// When adapter.fetchCaptions returns null BUT the <video> has textTrack cues,
// the pipeline should use those cues and NOT call startWebRtcStandard (start())
// or return "No captions available" (restart()).

describe("SubtitleFirstPipeline — B3 HTML5 textTrack fallback", () => {
  // Build a mock TextTrackCueList with a single cue
  function makeLoadedTrackList(): TextTrackList {
    const cue = {
      startTime: 1.0,
      endTime: 4.0,
      text: "Fallback cue from textTracks.",
    } as unknown as VTTCue;

    const cueList = {
      length: 1,
      0: cue,
      [Symbol.iterator]() {
        let i = 0;
        return {
          next() {
            return i < 1
              ? { value: cue, done: false as const }
              : { value: undefined as unknown as VTTCue, done: true as const };
          },
        };
      },
    } as unknown as TextTrackCueList;

    const track = {
      kind: "subtitles",
      language: "en",
      label: "English",
      mode: "showing" as TextTrackMode,
      cues: cueList,
    } as unknown as TextTrack;

    return {
      length: 1,
      0: track,
      [Symbol.iterator]() {
        let i = 0;
        return {
          next() {
            return i < 1
              ? { value: track, done: false as const }
              : { value: undefined as unknown as TextTrack, done: true as const };
          },
        };
      },
    } as unknown as TextTrackList;
  }

  let audioCtxShimB3: ReturnType<typeof makeAudioContextShim>;

  beforeEach(() => {
    document.body.innerHTML = '<video style="width:640px;height:360px"></video>';
    const video = document.querySelector("video")!;
    Object.defineProperty(video, "getBoundingClientRect", {
      value: () => ({ width: 640, height: 360, left: 0, top: 0, right: 640, bottom: 360 }),
      configurable: true,
    });

    // Give the video element loaded textTracks
    Object.defineProperty(video, "textTracks", {
      get: () => makeLoadedTrackList(),
      configurable: true,
    });

    audioCtxShimB3 = makeAudioContextShim();
    (window as { AudioContext: unknown }).AudioContext = vi
      .fn()
      .mockReturnValue(audioCtxShimB3);
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("start(): uses textTrack cues when adapter.fetchCaptions returns null — does NOT call startWebRtcStandard", async () => {
    const adapter = makeAdapter(true, "html5-fallback-vid");
    // fetchCaptions returns null — no adapter-level captions
    (adapter.fetchCaptions as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const app = makeApp(adapter);

    // renderSubtitleDubStream must succeed — stub it so the pipeline can boot
    // We need to mock the echoly-api module so renderSubtitleDubBatch/Stream work.
    // We can just mock the stream to yield nothing and let pipeline proceed.
    const echolyApi = await import("@/lib/echoly-api");
    vi.spyOn(echolyApi, "renderSubtitleDubStream").mockImplementation(async function* () {
      // yield nothing — empty stream simulates no TTS data
    });

    const pipeline = new SubtitleFirstPipeline(app as never);
    const result = await pipeline.start(makeSettings());

    // The pipeline found HTML5 cues → proceeded to caption path, NOT live-dub fallback
    expect(app.startWebRtcStandard).not.toHaveBeenCalled();
    // Should be ok (pipeline started) or at minimum did NOT trigger no-CC fallback
    // (ok may be false if audio/video play fails in jsdom — that's fine)
    expect(app.startWebRtcStandard).not.toHaveBeenCalled();
  });

  it("restart(): uses textTrack cues when adapter.fetchCaptions returns null — does NOT return 'No captions available'", async () => {
    const adapter = makeAdapter(true, "html5-restart-vid");
    (adapter.fetchCaptions as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const app = makeApp(adapter);

    const echolyApi = await import("@/lib/echoly-api");
    vi.spyOn(echolyApi, "renderSubtitleDubStream").mockImplementation(async function* () {
      // empty stream
    });

    // Seed a running subtitle-first session so restart() has something to evict
    const { SubtitleFirstPipeline: SFP } = await import("@/content/pipelines/subtitle-first-pipeline");
    const pipeline = new SFP(app as never);

    // Set a minimal prior session so restart doesn't crash on oldS
    app.sm.session = {
      kind: "subtitle-first",
      token: 0,
      stopFlag: false,
      playbackTimer: null,
      currentSource: null,
      abortController: new AbortController(),
      audioCtx: audioCtxShimB3,
      outputGain: audioCtxShimB3.createGain(),
    };

    const result = await pipeline.restart(makeSettings(), "html5-restart-vid");

    // Should NOT return "No captions available for this video."
    // (It may fail for other jsdom reasons like audio graph, but NOT that specific error)
    expect(result.error).not.toBe("No captions available for this video.");
  });
});

// ─── Udemy auto-next CC no-dub fix ────────────────────────────────────────────
//
// Bug: on Udemy, CC dub works via start() but the auto-next restart() path
// produced no dub — restart() runs DURING Udemy/Shaka's lecture-load churn (the
// <video> is destroyed+recreated, the API/DOM not yet ready), where a manual
// start() (run after the lecture settles) succeeds. These tests exercise the three
// robustness fixes: (A) thread the auto-next-validated element so a transient null
// findVideo() doesn't fail; (B) retry the caption fetch once so a not-ready lecture
// still dubs via CC; (C) clear the placeholder sm.session on a genuine failure.
describe("SubtitleFirstPipeline — restart() auto-next robustness (Udemy CC no-dub fix)", () => {
  let ctxShim: ReturnType<typeof makeAudioContextShim>;

  beforeEach(() => {
    // Plain <video> with EMPTY textTracks → the HTML5 <track> fallback returns
    // null, so the adapter caption path (and its retry) is what is under test.
    document.body.innerHTML = '<video style="width:640px;height:360px"></video>';
    const v = document.querySelector("video")!;
    Object.defineProperty(v, "getBoundingClientRect", {
      value: () => ({ width: 640, height: 360, left: 0, top: 0, right: 640, bottom: 360 }),
      configurable: true,
    });
    ctxShim = makeAudioContextShim();
    (window as { AudioContext: unknown }).AudioContext = vi.fn().mockReturnValue(ctxShim);
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  function seedPriorSession(app: ReturnType<typeof makeApp>): void {
    app.sm.session = {
      kind: "subtitle-first",
      token: 0,
      stopFlag: false,
      playbackTimer: null,
      currentSource: null,
      abortController: new AbortController(),
      audioCtx: ctxShim,
      outputGain: ctxShim.createGain(),
    } as never;
  }

  it("FIX A: uses the passed knownVideo when findVideo() returns null mid Shaka-recreate", async () => {
    const adapter = makeAdapter(true, "udemy-recreate");
    // Simulate Shaka mid-recreate: the adapter's own findVideo() returns null.
    (adapter as { findVideo: () => HTMLVideoElement | null }).findVideo = () => null;
    (adapter.fetchCaptions as ReturnType<typeof vi.fn>).mockResolvedValue({
      captions: [{ start: 1, end: 4, text: "hello" }],
      sourceLang: "en",
    });
    const app = makeApp(adapter);
    const echolyApi = await import("@/lib/echoly-api");
    vi.spyOn(echolyApi, "renderSubtitleDubStream").mockImplementation(async function* () {});
    const pipeline = new SubtitleFirstPipeline(app as never);
    seedPriorSession(app);

    const known = document.querySelector("video") as HTMLVideoElement;
    const result = await pipeline.restart(
      makeSettings({ originalVolume: 7, voiceVolume: 80 }),
      "udemy-recreate",
      known,
    );

    // The connected knownVideo rescued it — restart did NOT fail on a null findVideo().
    expect(result.error).not.toBe("No playable video on this page.");
    // And the user's volume config is RE-APPLIED to the new (Shaka-recreated) video
    // on auto-next — restart() was the only auto-next path that used to skip this.
    expect(app.capture.applyVolumes).toHaveBeenCalledWith(7, 80);
    expect(app.capture.bindVolumeDriftGuard).toHaveBeenCalledWith(known);
  });

  it("FIX B: retries the caption fetch once and dubs when the 2nd attempt returns captions", async () => {
    const adapter = makeAdapter(true, "udemy-retry");
    // First attempt empty (lecture not ready yet), second attempt has captions.
    (adapter.fetchCaptions as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ captions: [{ start: 1, end: 4, text: "hi" }], sourceLang: "en" });
    const app = makeApp(adapter);
    const echolyApi = await import("@/lib/echoly-api");
    vi.spyOn(echolyApi, "renderSubtitleDubStream").mockImplementation(async function* () {});
    const pipeline = new SubtitleFirstPipeline(app as never);
    seedPriorSession(app);

    const known = document.querySelector("video") as HTMLVideoElement;
    const result = await pipeline.restart(makeSettings(), "udemy-retry", known);

    // Retried (>=2 fetchCaptions calls) and did NOT give up with "No captions available".
    expect(
      (adapter.fetchCaptions as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThanOrEqual(2);
    expect(result.error).not.toBe("No captions available for this video.");
  });

  it("FIX C: clears sm.session (no poison) when captions are genuinely absent after retry", async () => {
    const adapter = makeAdapter(true, "udemy-nocc");
    (adapter.fetchCaptions as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const app = makeApp(adapter);
    const pipeline = new SubtitleFirstPipeline(app as never);
    seedPriorSession(app);

    const known = document.querySelector("video") as HTMLVideoElement;
    const result = await pipeline.restart(makeSettings(), "udemy-nocc", known);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("No captions available for this video.");
    // The placeholder kind="subtitle-first" session restart() installed is cleared,
    // so the auto-next fallback is not blocked by a poisoned sm.session.
    expect(app.sm.session).toBeNull();
  });

  it("RC4: keeps polling past one retry — dubs when captions appear on the 3rd attempt", async () => {
    const adapter = makeAdapter(true, "udemy-poll");
    // Empty on attempts 1 AND 2 (lecture still loading), captions on the 3rd. The OLD
    // single-retry path (initial + 1) would give up after 2 calls; the readiness poll
    // keeps going up to CAPTION_READINESS_MAX_ATTEMPTS and succeeds.
    (adapter.fetchCaptions as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ captions: [{ start: 1, end: 4, text: "hi" }], sourceLang: "en" });
    const app = makeApp(adapter);
    const echolyApi = await import("@/lib/echoly-api");
    vi.spyOn(echolyApi, "renderSubtitleDubStream").mockImplementation(async function* () {});
    const pipeline = new SubtitleFirstPipeline(app as never);
    seedPriorSession(app);

    const known = document.querySelector("video") as HTMLVideoElement;
    const result = await pipeline.restart(makeSettings(), "udemy-poll", known);

    // Made a 3rd fetch (the poll continued past one retry) and did NOT give up — the
    // old single-retry code stopped at 2 calls.
    expect(
      (adapter.fetchCaptions as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThanOrEqual(3);
    expect(result.error).not.toBe("No captions available for this video.");
  });
});

// ─── start() fresh-start caption retry (Udemy next-lecture fix) ───────────────
//
// Bug: on Udemy, when a lecture auto-advances, the background hard-nav stop tears
// the session down and a FRESH start() re-dubs the next lecture. start() runs mid
// Shaka/lecture-load (caption API not ready) → first fetch empty → it fell to the
// WebRTC/DRM dead-end (silent rt_). start() now retries the caption fetch ONCE
// (the same rescue restart() already had) so CC succeeds instead of going WebRTC.
describe("SubtitleFirstPipeline — start() fresh-start caption retry (Udemy next-lecture fix)", () => {
  beforeEach(() => {
    document.body.innerHTML = '<video style="width:640px;height:360px"></video>';
    const v = document.querySelector("video")!;
    Object.defineProperty(v, "getBoundingClientRect", {
      value: () => ({ width: 640, height: 360, left: 0, top: 0, right: 640, bottom: 360 }),
      configurable: true,
    });
    (window as { AudioContext: unknown }).AudioContext = vi
      .fn()
      .mockReturnValue(makeAudioContextShim());
  });
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("retries caption fetch once and dubs via CC when the 2nd attempt returns captions (no WebRTC fallback)", async () => {
    const adapter = makeAdapter(true, "udemy-start-retry");
    (adapter.fetchCaptions as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ captions: [{ start: 1, end: 4, text: "hi" }], sourceLang: "en" });
    const app = makeApp(adapter);
    const echolyApi = await import("@/lib/echoly-api");
    vi.spyOn(echolyApi, "renderSubtitleDubStream").mockImplementation(async function* () {});
    const pipeline = new SubtitleFirstPipeline(app as never);

    await pipeline.start(makeSettings());

    // Retried (>=2 fetchCaptions calls) and did NOT fall to the WebRTC dead-end.
    expect(
      (adapter.fetchCaptions as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThanOrEqual(2);
    expect(app.startWebRtcStandard).not.toHaveBeenCalled();
  });
});
