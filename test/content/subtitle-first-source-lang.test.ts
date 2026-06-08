// @vitest-environment jsdom
//
// D7: SubtitleFirstPipeline maps sourceLanguage → preferLang/avoidLang correctly
//
// The pipeline's start() and restart() call adapter.fetchCaptions with:
//   - sourceLanguage "auto"  → { preferLang: undefined, avoidLang: targetLanguage }
//   - sourceLanguage "en"    → { preferLang: "en",      avoidLang: targetLanguage }
//
// Strategy: construct a real SubtitleFirstPipeline with a fake app whose
// adapter.fetchCaptions is a vi.fn() spy.  Drive pipeline.start() with
// different sourceLanguage values and assert the captured args.
//
// The pipeline falls through to startWebRtcStandard when fetchCaptions → null
// (no captions), but the fetchCaptions spy records the args before that branch.

import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { SubtitleFirstPipeline } from "@/content/pipelines/subtitle-first-pipeline";
import { LifecycleController } from "@/content/lifecycle";
import type { PlatformAdapter, PlatformCapabilities } from "@/shared/platform-ports";
import type { StartSettings } from "@/shared/types";

// ─── AudioContext shim ────────────────────────────────────────────────────────

function makeAudioContextShim() {
  const gainNode = {
    gain: { value: 1 },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  return {
    state: "running" as AudioContextState,
    currentTime: 0,
    destination: {},
    createGain: vi.fn().mockReturnValue(gainNode),
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    decodeAudioData: vi.fn().mockResolvedValue(null),
  };
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
    sourceLanguage: "auto",
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

// ─── Fake adapter factory with a controllable fetchCaptions spy ───────────────

function makeFetchCaptureSpy() {
  return vi.fn().mockResolvedValue(null); // null → no captions → pipeline falls to startWebRtcStandard
}

function makeAdapter(fetchCaptionsSpy: ReturnType<typeof vi.fn>): PlatformAdapter {
  const capabilities: PlatformCapabilities = {
    audioCapture: true,  // allows fallback to startWebRtcStandard (no stopSession path)
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
    getVideoId: () => "test-video",
    findVideo: () => document.querySelector("video") as HTMLVideoElement | null,
    stageInsets: () => ({ top: 44, bottom: 56, side: 16 }),
    fetchCaptions: fetchCaptionsSpy,
    readLiveCaptionText: () => null,
  } as PlatformAdapter;
}

// ─── Fake ContentApp factory ──────────────────────────────────────────────────

function makeApp(adapter: PlatformAdapter) {
  const lifecycle = new LifecycleController();
  let pageToken = 0;

  const sm = {
    session: null as unknown,
    settings: null as unknown,
    apiBase: "https://api.echolyhq.com",
    pageToken: 0,
    lifecycle,
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

  return {
    sm,
    lifecycle,
    overlay,
    capture,
    callbacks,
    adapter,
    startWebRtcStandard: vi.fn().mockResolvedValue({ ok: true }),
    stopSession: vi.fn(),
    applySourceVisibility: vi.fn(),
    startSessionTimer: vi.fn(),
    bindCommonVideoListeners: vi.fn(),
  };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

let AudioContextOrig: typeof AudioContext | undefined;

beforeEach(() => {
  document.body.innerHTML = '<video style="width:640px;height:360px"></video>';
  Object.defineProperty(document.querySelector("video")!, "getBoundingClientRect", {
    value: () => ({ width: 640, height: 360, left: 0, top: 0, right: 640, bottom: 360 }),
    configurable: true,
  });
  AudioContextOrig = (window as { AudioContext?: typeof AudioContext }).AudioContext;
  (window as { AudioContext: unknown }).AudioContext = vi
    .fn()
    .mockReturnValue(makeAudioContextShim());
});

afterEach(() => {
  (window as { AudioContext?: unknown }).AudioContext = AudioContextOrig;
  vi.restoreAllMocks();
});

// ─── D7 Tests ─────────────────────────────────────────────────────────────────

describe("SubtitleFirstPipeline — D7: sourceLanguage → fetchCaptions arg mapping", () => {
  it("D7a: sourceLanguage='auto' → fetchCaptions receives preferLang:undefined, avoidLang:targetLanguage", async () => {
    const fetchSpy = makeFetchCaptureSpy();
    const adapter = makeAdapter(fetchSpy);
    const app = makeApp(adapter);
    const pipeline = new SubtitleFirstPipeline(app as never);

    const settings = makeSettings({ sourceLanguage: "auto", targetLanguage: "vi" });
    await pipeline.start(settings);

    // fetchCaptions must have been called at least once (the spy may be skipped
    // only if a prefetch cache hit occurs — but there is no YouTube adapter here).
    expect(fetchSpy).toHaveBeenCalled();

    // The FIRST call is the one inside start() (before the html5 fallback).
    const firstCall = fetchSpy.mock.calls[0]![0] as {
      preferLang?: string;
      avoidLang?: string;
      videoId?: string;
    };
    // "auto" must translate to preferLang OMITTED / undefined
    expect(firstCall.preferLang).toBeUndefined();
    // avoidLang must be the target language
    expect(firstCall.avoidLang).toBe("vi");
  });

  it("D7b: sourceLanguage='en' → fetchCaptions receives preferLang:'en', avoidLang:targetLanguage", async () => {
    const fetchSpy = makeFetchCaptureSpy();
    const adapter = makeAdapter(fetchSpy);
    const app = makeApp(adapter);
    const pipeline = new SubtitleFirstPipeline(app as never);

    const settings = makeSettings({ sourceLanguage: "en", targetLanguage: "vi" });
    await pipeline.start(settings);

    expect(fetchSpy).toHaveBeenCalled();
    const firstCall = fetchSpy.mock.calls[0]![0] as {
      preferLang?: string;
      avoidLang?: string;
    };
    expect(firstCall.preferLang).toBe("en");
    expect(firstCall.avoidLang).toBe("vi");
  });

  it("D7c: sourceLanguage='ja' + targetLanguage='vi' → preferLang:'ja', avoidLang:'vi'", async () => {
    const fetchSpy = makeFetchCaptureSpy();
    const adapter = makeAdapter(fetchSpy);
    const app = makeApp(adapter);
    const pipeline = new SubtitleFirstPipeline(app as never);

    const settings = makeSettings({ sourceLanguage: "ja", targetLanguage: "vi" });
    await pipeline.start(settings);

    expect(fetchSpy).toHaveBeenCalled();
    const firstCall = fetchSpy.mock.calls[0]![0] as {
      preferLang?: string;
      avoidLang?: string;
    };
    expect(firstCall.preferLang).toBe("ja");
    expect(firstCall.avoidLang).toBe("vi");
  });

  it("D7d: avoidLang is always the targetLanguage regardless of sourceLanguage", async () => {
    for (const [src, tgt] of [
      ["auto", "en"],
      ["vi", "en"],
      ["auto", "ja"],
    ] as const) {
      const fetchSpy = makeFetchCaptureSpy();
      const adapter = makeAdapter(fetchSpy);
      const app = makeApp(adapter);
      const pipeline = new SubtitleFirstPipeline(app as never);

      const settings = makeSettings({ sourceLanguage: src, targetLanguage: tgt });
      await pipeline.start(settings);

      expect(fetchSpy).toHaveBeenCalled();
      const firstCall = fetchSpy.mock.calls[0]![0] as { avoidLang?: string };
      expect(firstCall.avoidLang).toBe(tgt);
    }
  });
});
