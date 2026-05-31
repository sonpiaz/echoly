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

import { beforeEach, describe, it, expect, vi } from "vitest";
import { SubtitleFirstPipeline } from "@/content/pipelines/subtitle-first-pipeline";
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
  } as PlatformAdapter;
}

// ─── Fake ContentApp factory ──────────────────────────────────────────────────
//
// Provides the minimum surface SubtitleFirstPipeline.start() touches.
// We stub out startWebRtcStandard and stopSession with spies.

function makeApp(adapter: PlatformAdapter) {
  let pageToken = 0;
  let sessionRef: unknown = null;

  const sm = {
    session: null as unknown,
    settings: null as unknown,
    apiBase: "https://api.echolyhq.com",
    pageToken: 0,
    videoPaused: false,
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
    overlay,
    capture,
    callbacks,
    adapter,
    startWebRtcStandard,
    stopSession,
    applySourceVisibility,
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
});
