// @vitest-environment jsdom
//
// D9: changing sourceLanguage mid-session triggers the live language-change path
//
// Acceptance (D9):
//   - applySettingsLive({ sourceLanguage:"en" }) when prev was "auto" AND an
//     active session exists → triggers the same handover/relay path as a
//     targetLanguage change (notifyBackground UPDATE_SETTINGS for subtitle-first,
//     or requestHandover for WebRTC).
//   - An UNCHANGED sourceLanguage does NOT trigger the handover path.
//   - targetLanguage change still works (regression guard).
//
// Strategy: use ContentApp directly with the same module-mock set as
// ad-boundary-ended.test.ts.  Install a minimal active session (subtitle-first
// OR webrtc), call applySettingsLive(), and assert notifyBackground /
// requestHandover.

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from "vitest";

// ─── Module mocks (must precede ContentApp import) ───────────────────────────

let mockOverlay: Record<string, Mock | (() => boolean)>;
const mockDetectAdapter: Mock = vi.fn();

vi.mock("@/content/overlay/overlay", () => ({
  createOverlay: () => mockOverlay,
  purgeEcholyOverlayRoots: vi.fn(),
}));
vi.mock("@/platforms/registry", () => ({
  detectAdapter: (...args: unknown[]) => mockDetectAdapter(...args),
}));
vi.mock("@/content/media-stage", () => ({
  setActiveAdapter: vi.fn(),
  findPrimaryVideo: vi.fn().mockReturnValue(null),
  getActiveAdapter: vi.fn().mockReturnValue(null),
}));
vi.mock("@/content/controller", () => ({ createController: () => ({}) }));
vi.mock("@/content/capture", () => ({
  AudioCapture: class {
    videoEl: HTMLVideoElement | null = null;
    findVideo = vi.fn().mockReturnValue(null);
    bindVolumeDriftGuard = vi.fn();
    unbindVolumeDriftGuard = vi.fn();
    bindRateChangeWarn = vi.fn();
    unbindRateChangeWarn = vi.fn();
    applyVolumes = vi.fn();
    applyOutputDevice = vi.fn();
    isLive = vi.fn().mockReturnValue(false);
  },
}));
vi.mock("@/content/pipelines/webrtc-pipeline", () => ({
  WebRtcPipeline: class {
    buildSession = vi.fn();
    requestHandover = vi.fn().mockResolvedValue({ ok: true });
  },
}));
vi.mock("@/content/pipelines/subtitle-first-pipeline", () => ({
  SubtitleFirstPipeline: class {
    start = vi.fn();
    restart = vi.fn();
    reAnchor = vi.fn();
  },
}));
vi.mock("@/lib/dub-playback-sync", () => ({
  bindStandardDubPlaybackSync: vi.fn(() => ({
    stop: vi.fn(), snapPlaybackStart: vi.fn(), start: vi.fn(),
    waitForFirstDub: vi.fn().mockResolvedValue(true),
  })),
}));
vi.mock("@/content/navigation", () => ({
  NavigationWatcher: vi.fn().mockImplementation(() => ({
    start: vi.fn(), stop: vi.fn(), notifyEnded: vi.fn(),
  })),
}));
vi.mock("@/content/auto-next", () => ({
  continueOnNewVideo: vi.fn().mockResolvedValue({ ok: true }),
}));

import { ContentApp } from "@/content/index";
import type { SubtitleFirstSession, WebRtcSession } from "@/content/session-manager";
import type { StartSettings } from "@/shared/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function installChrome() {
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: { id: "test", sendMessage: vi.fn().mockResolvedValue(undefined) },
  };
}
function uninstallChrome() {
  (globalThis as { chrome?: unknown }).chrome = undefined;
}

function makeApp(): ContentApp {
  mockDetectAdapter.mockReturnValue({
    id: "generic",
    isAdPlaying: () => false,
    getAdSignalTarget: () => null,
  });
  return new ContentApp();
}

/** Minimal active subtitle-first session. */
function makeSubtitleFirstSession(): SubtitleFirstSession {
  return {
    kind: "subtitle-first",
    token: 1,
    pc: null, dc: null, stream: null, remoteAudio: null,
    audioCtx: { state: "closed" } as unknown as AudioContext,
    outputGain: null, rtcSessionId: null, apiBearer: "b",
    abortController: new AbortController(),
    sentences: [],
    translations: [],
    currentSource: null, currentPlayingIdx: null,
    playbackTimer: null, renderCursor: 0,
    rollingInFlight: false, stopFlag: false,
    _batchRequestIds: new Map(),
    _sentBatchRanges: new Map(),
    _renderEpoch: 0,
    _pendingLines: new Set(),
    _pendingFirstQueuedAt: 0,
      _inflightRanges: new Set(),
      _resolvedAhead: new Set(),
  } as SubtitleFirstSession;
}

/** Minimal active WebRTC session. */
function makeWebRtcSession(): WebRtcSession {
  return {
    kind: undefined,
    token: 1,
    pipeline: "standard",
    targetLanguage: "vi",
    voice: "marin",
    pc: { getSenders: () => [] } as unknown as RTCPeerConnection,
    dc: null,
    stream: { getAudioTracks: () => [] } as unknown as MediaStream,
    remoteAudio: null,
    audioCtx: null,
    outputGain: null,
    rtcSessionId: "rtc-1",
    apiBearer: "bearer-1",
  } as unknown as WebRtcSession;
}

function makeSettings(overrides: Partial<StartSettings> = {}): StartSettings {
  return {
    running: false, connecting: false, paused: false, tabId: null,
    status: "Ready", errorMessage: "", apiMode: null,
    signedInUser: null, usage: null,
    languagePicker: null, languageNames: null, standardVoices: null,
    standardVoiceDefaultId: null, sessionStartedAt: null,
    advanced: { captionPosition: "bottom", outputDeviceId: "" },
    siteOverrides: {}, advancedVersion: 0, advancedDirty: false,
    currentDomain: null, tier: "standard",
    targetLanguage: "vi", sourceLanguage: "auto",
    realtimeVoice: "marin", standardVoice: "English_magnetic_voiced_man",
    originalVolume: 18, voiceVolume: 100,
    showSource: false, showTargetCaptions: true,
    apiBearer: "test-bearer", apiBase: "https://api.echolyhq.com",
    ...overrides,
  } as unknown as StartSettings;
}

beforeEach(() => {
  installChrome();
  global.fetch = vi.fn().mockResolvedValue({ ok: true });
  mockDetectAdapter.mockReset();
  mockOverlay = {
    buildOverlay: vi.fn(), syncFromSettings: vi.fn(), setStatusText: vi.fn(),
    setOverlayState: vi.fn(), removeOverlay: vi.fn(), showToast: vi.fn(),
    setTargetText: vi.fn(), setSourceText: vi.fn(), applySourceVisibility: vi.fn(),
    applyCaptionOnVideo: vi.fn(), setDubSyncReadout: vi.fn(), pushHistoryTurn: vi.fn(),
    pushHistoryMarker: vi.fn(), setCaptionPosition: vi.fn(), isMounted: () => false,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  uninstallChrome();
});

// ─────────────────────────────────────────────────────────────────────────────
// D9 — subtitle-first session path
// ─────────────────────────────────────────────────────────────────────────────

describe("D9 — applySettingsLive sourceLanguage change triggers handover (subtitle-first)", () => {
  it("D9-sf-1: sourceLanguage change 'auto'→'en' triggers UPDATE_SETTINGS notifyBackground", () => {
    const app = makeApp();
    // Seed settings with prev sourceLanguage = "auto"
    app.sm.settings = makeSettings({ sourceLanguage: "auto", targetLanguage: "vi" });
    // Arm an active subtitle-first session
    app.sm.session = makeSubtitleFirstSession();

    const notifyBgSpy = vi.fn().mockResolvedValue(undefined);
    app.sm.notifyBackground = notifyBgSpy;

    // Change sourceLanguage from "auto" to "en"
    app.applySettingsLive({ sourceLanguage: "en" });

    // Must have triggered the UPDATE_SETTINGS relay (subtitle-first path)
    expect(notifyBgSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "UPDATE_SETTINGS",
        settings: expect.objectContaining({ sourceLanguage: "en" }),
      }),
    );
  });

  it("D9-sf-2: unchanged sourceLanguage does NOT trigger UPDATE_SETTINGS", () => {
    const app = makeApp();
    app.sm.settings = makeSettings({ sourceLanguage: "auto", targetLanguage: "vi" });
    app.sm.session = makeSubtitleFirstSession();

    const notifyBgSpy = vi.fn().mockResolvedValue(undefined);
    app.sm.notifyBackground = notifyBgSpy;

    // Same value — no change
    app.applySettingsLive({ sourceLanguage: "auto" });

    // langOrVoiceChanged is false → notifyBackground not called
    expect(notifyBgSpy).not.toHaveBeenCalled();
  });

  it("D9-sf-3: targetLanguage change still triggers UPDATE_SETTINGS (regression guard)", () => {
    const app = makeApp();
    app.sm.settings = makeSettings({ sourceLanguage: "auto", targetLanguage: "vi" });
    app.sm.session = makeSubtitleFirstSession();

    const notifyBgSpy = vi.fn().mockResolvedValue(undefined);
    app.sm.notifyBackground = notifyBgSpy;

    app.applySettingsLive({ targetLanguage: "en" });

    expect(notifyBgSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "UPDATE_SETTINGS",
        settings: expect.objectContaining({ targetLanguage: "en" }),
      }),
    );
  });

  it("D9-sf-4: no active session → sourceLanguage change does NOT trigger UPDATE_SETTINGS", () => {
    const app = makeApp();
    app.sm.settings = makeSettings({ sourceLanguage: "auto", targetLanguage: "vi" });
    app.sm.session = null; // No session

    const notifyBgSpy = vi.fn().mockResolvedValue(undefined);
    app.sm.notifyBackground = notifyBgSpy;

    app.applySettingsLive({ sourceLanguage: "en" });

    // No session → langOrVoiceChanged is true but sm.session is null → no relay
    expect(notifyBgSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D9 — WebRTC session path
// ─────────────────────────────────────────────────────────────────────────────

describe("D9 — applySettingsLive sourceLanguage change triggers handover (WebRTC)", () => {
  it("D9-rtc-1: sourceLanguage change 'auto'→'en' calls webrtc.requestHandover", () => {
    const app = makeApp();
    app.sm.settings = makeSettings({ sourceLanguage: "auto", targetLanguage: "vi" });
    // WebRTC session (kind !== "subtitle-first")
    app.sm.session = makeWebRtcSession();

    // webrtc.requestHandover is a spy via the mocked WebRtcPipeline class
    const requestHandoverSpy = vi.spyOn(app.webrtc, "requestHandover").mockResolvedValue({ ok: true } as never);

    app.applySettingsLive({ sourceLanguage: "en" });

    expect(requestHandoverSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sourceLanguage: "en" }),
    );
  });

  it("D9-rtc-2: unchanged sourceLanguage does NOT call webrtc.requestHandover", () => {
    const app = makeApp();
    app.sm.settings = makeSettings({ sourceLanguage: "auto", targetLanguage: "vi" });
    app.sm.session = makeWebRtcSession();

    const requestHandoverSpy = vi.spyOn(app.webrtc, "requestHandover").mockResolvedValue({ ok: true } as never);

    // Same value — no change
    app.applySettingsLive({ sourceLanguage: "auto" });

    expect(requestHandoverSpy).not.toHaveBeenCalled();
  });

  it("D9-rtc-3: sourceLanguage change 'en'→'ja' also triggers requestHandover", () => {
    const app = makeApp();
    app.sm.settings = makeSettings({ sourceLanguage: "en", targetLanguage: "vi" });
    app.sm.session = makeWebRtcSession();

    const requestHandoverSpy = vi.spyOn(app.webrtc, "requestHandover").mockResolvedValue({ ok: true } as never);

    app.applySettingsLive({ sourceLanguage: "ja" });

    expect(requestHandoverSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sourceLanguage: "ja" }),
    );
  });
});
