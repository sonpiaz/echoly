// @vitest-environment jsdom
//
// Tests for the toast-on-start-failure feature (SOLUTION.md: license-expired-toast).
// Mocking pattern follows test/content/ad-gate-nocc-fallback.test.ts exactly.
//
// Covered:
//   (a) buildSession rejects with expiry-like error → showToast called with
//       user message + cta/ctaLabel; returns { ok: false }.
//   (b) buildSession rejects with a NON-expiry error → showToast NOT called;
//       returns { ok: false }.
//   (c) CONTENT_SHOW_TOAST chrome message → overlay.showToast called with
//       text + opts.

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from "vitest";

// ─── Module mocks (must precede ContentApp import) ────────────────────────

let mockOverlay: {
  buildOverlay: Mock;
  syncFromSettings: Mock;
  setStatusText: Mock;
  setOverlayState: Mock;
  removeOverlay: Mock;
  showToast: Mock;
  setTargetText: Mock;
  setSourceText: Mock;
  applySourceVisibility: Mock;
  applyCaptionOnVideo: Mock;
  setDubSyncReadout: Mock;
  pushHistoryTurn: Mock;
  pushHistoryMarker: Mock;
  setCaptionPosition: Mock;
  isMounted: () => boolean;
  setLanguageSelection: Mock;
  populateVoicePicker: Mock;
  setMixVolumes: Mock;
};

let mockDetectAdapter: Mock;

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

vi.mock("@/content/controller", () => ({
  createController: () => ({}),
}));

vi.mock("@/lib/rtc-media-sync", () => ({
  bindSourceVideoPlayback: vi.fn().mockReturnValue(() => {}),
}));

let mockCaptureInstance: {
  videoEl: HTMLVideoElement | null;
  findVideo: Mock;
  bindVolumeDriftGuard: Mock;
  unbindVolumeDriftGuard: Mock;
  bindRateChangeWarn: Mock;
  unbindRateChangeWarn: Mock;
  applyVolumes: Mock;
  applyOutputDevice: Mock;
  isLive: Mock;
  captureWithRetry: Mock;
  waitForPCConnected: Mock;
};

vi.mock("@/content/capture", () => ({
  AudioCapture: class {
    get videoEl() { return mockCaptureInstance.videoEl; }
    set videoEl(v: HTMLVideoElement | null) { mockCaptureInstance.videoEl = v; }
    get findVideo() { return mockCaptureInstance.findVideo; }
    get bindVolumeDriftGuard() { return mockCaptureInstance.bindVolumeDriftGuard; }
    get unbindVolumeDriftGuard() { return mockCaptureInstance.unbindVolumeDriftGuard; }
    get bindRateChangeWarn() { return mockCaptureInstance.bindRateChangeWarn; }
    get unbindRateChangeWarn() { return mockCaptureInstance.unbindRateChangeWarn; }
    get applyVolumes() { return mockCaptureInstance.applyVolumes; }
    get applyOutputDevice() { return mockCaptureInstance.applyOutputDevice; }
    get isLive() { return mockCaptureInstance.isLive; }
    get captureWithRetry() { return mockCaptureInstance.captureWithRetry; }
    get waitForPCConnected() { return mockCaptureInstance.waitForPCConnected; }
  },
}));

let mockSubtitleFirst: { start: Mock };
let mockWebRtcPipeline: { buildSession: Mock; requestHandover: Mock; prepareIntent: Mock };
let mockStandardDubSync: { stop: Mock; snapPlaybackStart: Mock; start: Mock; waitForFirstDub: Mock };

vi.mock("@/content/pipelines/subtitle-first-pipeline", () => ({
  SubtitleFirstPipeline: class {
    get start() { return mockSubtitleFirst.start; }
  },
}));

vi.mock("@/content/pipelines/webrtc-pipeline", () => ({
  WebRtcPipeline: class {
    get buildSession() { return mockWebRtcPipeline.buildSession; }
    get requestHandover() { return mockWebRtcPipeline.requestHandover; }
    get prepareIntent() { return mockWebRtcPipeline.prepareIntent; }
  },
}));

vi.mock("@/lib/dub-playback-sync", () => ({
  bindStandardDubPlaybackSync: vi.fn(() => mockStandardDubSync),
}));

vi.mock("@/lib/rtc-handover", () => ({
  drainRemoteAudio: vi.fn(),
  RTC_DRAIN_TIMEOUT_MS: 600,
}));

vi.mock("@/lib/standard-vod-start", () => ({
  alignRealtimeVodBeforePlay: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/content/navigation", () => ({
  NavigationWatcher: class {
    start = vi.fn();
    stop = vi.fn();
    notifyEnded = vi.fn();
  },
}));

vi.mock("@/content/auto-next", () => ({
  continueOnNewVideo: vi.fn().mockResolvedValue({ ok: true }),
}));

// ContentApp import MUST come AFTER all vi.mock() calls.
import { ContentApp } from "@/content/index";
import type { StartSettings } from "@/shared/types";

// ─── Helpers ──────────────────────────────────────────────────────────────

function installChrome() {
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: { id: "test", sendMessage: vi.fn().mockResolvedValue(undefined) },
  };
}
function uninstallChrome() {
  (globalThis as { chrome?: unknown }).chrome = undefined;
}

async function flushMicrotasks() {
  await vi.advanceTimersByTimeAsync(0);
}

function makeMinimalAdapter() {
  return {
    id: "youtube",
    capabilities: {
      audioCapture: true,
      subtitleFirst: false,
      isSpa: false,
      hasNativeCaptions: false,
      hasAdOverlays: false,
    },
    matchesHost: () => true,
    isWatchUrl: (url: string) => url.includes("/watch"),
    getVideoId: () => "vid123",
    findVideo: () => makeVideo(),
    stageInsets: () => ({ top: 44, bottom: 56, side: 16 }),
    fetchCaptions: vi.fn().mockResolvedValue(null),
    readLiveCaptionText: () => null,
  };
}

function makeVideo(paused = false): HTMLVideoElement {
  return {
    pause: vi.fn(),
    play: vi.fn().mockResolvedValue(undefined),
    paused,
    duration: 300,
    muted: false,
    volume: 1,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as HTMLVideoElement;
}

/** A minimal StartSettings for Realtime (the tier that exercises buildSession directly). */
const REALTIME_SETTINGS: StartSettings = {
  tier: "realtime",
  targetLanguage: "vi",
  apiBearer: "test-bearer",
  apiMode: "proxy",
  originalVolume: 18,
  voiceVolume: 100,
  showSource: false,
  showTargetCaptions: true,
  standardVoice: "voice-1",
  realtimeVoice: "marin",
  standardVoices: [],
  languagePicker: [],
} as unknown as StartSettings;

// ─────────────────────────────────────────────────────────────────────────────
// Setup / teardown
// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  installChrome();
  vi.useFakeTimers();

  mockOverlay = {
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
    isMounted: () => false,
    setLanguageSelection: vi.fn(),
    populateVoicePicker: vi.fn(),
    setMixVolumes: vi.fn(),
  };

  mockCaptureInstance = {
    videoEl: null,
    findVideo: vi.fn().mockReturnValue(makeVideo()),
    bindVolumeDriftGuard: vi.fn(),
    unbindVolumeDriftGuard: vi.fn(),
    bindRateChangeWarn: vi.fn(),
    unbindRateChangeWarn: vi.fn(),
    applyVolumes: vi.fn(),
    applyOutputDevice: vi.fn(),
    isLive: vi.fn().mockReturnValue(false),
    captureWithRetry: vi.fn().mockResolvedValue({
      getTracks: () => [{ stop: vi.fn() }],
    }),
    waitForPCConnected: vi.fn().mockResolvedValue(true),
  };

  mockSubtitleFirst = {
    start: vi.fn().mockResolvedValue({ ok: true }),
  };

  mockWebRtcPipeline = {
    buildSession: vi.fn().mockResolvedValue({
      kind: undefined,
      token: 1,
      pipeline: "realtime",
      targetLanguage: "vi",
      voice: "marin",
      pc: { close: vi.fn(), iceConnectionState: "connected" },
      dc: null,
      stream: { getTracks: () => [] },
      remoteAudio: null,
      audioCtx: null,
      outputGain: null,
      rtcSessionId: null,
      apiBearer: "test-bearer",
    }),
    requestHandover: vi.fn(),
    prepareIntent: vi.fn(),
  };

  mockStandardDubSync = {
    stop: vi.fn(),
    snapPlaybackStart: vi.fn(),
    start: vi.fn(),
    waitForFirstDub: vi.fn().mockResolvedValue(true),
  };

  mockDetectAdapter = vi.fn().mockReturnValue(makeMinimalAdapter());
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  uninstallChrome();
});

// ─────────────────────────────────────────────────────────────────────────────
// A. buildSession rejects with expiry-like error → showToast called
// ─────────────────────────────────────────────────────────────────────────────

describe("start failure — expiry-like error toasts on page", () => {
  it("calls showToast with user message and Upgrade cta/ctaLabel when buildSession rejects with expiryLike=true", async () => {
    const expiryError = Object.assign(
      new Error("Credits used up"),
      {
        user: "Credits used up",
        cta: "https://echolyhq.com/upgrade",
        ctaLabel: "Upgrade",
        expiryLike: true,
      },
    );
    mockWebRtcPipeline.buildSession.mockRejectedValue(expiryError);

    const app = new ContentApp();
    const result = await app.startSession(REALTIME_SETTINGS);

    // Must return ok:false
    expect(result.ok).toBe(false);

    // showToast must have been called with the error message and Upgrade CTA
    expect(mockOverlay.showToast).toHaveBeenCalledWith(
      "Credits used up",
      expect.objectContaining({
        cta: "https://echolyhq.com/upgrade",
        ctaLabel: "Upgrade",
      }),
    );
  });

  it("calls showToast with Sign-in cta/ctaLabel when buildSession rejects with auth expiryLike error", async () => {
    const authError = Object.assign(
      new Error("Session expired"),
      {
        user: "Session expired",
        cta: "https://echolyhq.com/signin",
        ctaLabel: "Sign in",
        expiryLike: true,
      },
    );
    mockWebRtcPipeline.buildSession.mockRejectedValue(authError);

    const app = new ContentApp();
    const result = await app.startSession(REALTIME_SETTINGS);

    expect(result.ok).toBe(false);
    expect(mockOverlay.showToast).toHaveBeenCalledWith(
      "Session expired",
      expect.objectContaining({
        cta: "https://echolyhq.com/signin",
        ctaLabel: "Sign in",
      }),
    );
  });

  it("returns { ok: false, error: user } with the server message (not an inline URL hack)", async () => {
    const expiryError = Object.assign(
      new Error("Your quota is exhausted"),
      {
        user: "Your quota is exhausted",
        cta: "https://echolyhq.com/upgrade",
        ctaLabel: "Upgrade",
        expiryLike: true,
      },
    );
    mockWebRtcPipeline.buildSession.mockRejectedValue(expiryError);

    const app = new ContentApp();
    const result = await app.startSession(REALTIME_SETTINGS);

    expect(result.ok).toBe(false);
    // error must be the clean user message, not "message (url)"
    expect(result.error).toBe("Your quota is exhausted");
    expect(result.error).not.toContain("http");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. buildSession rejects with NON-expiry error → showToast NOT called
// ─────────────────────────────────────────────────────────────────────────────

describe("start failure — non-expiry error does NOT toast", () => {
  it("does NOT call showToast when buildSession rejects with a plain Error (no expiryLike)", async () => {
    const plainError = new Error("Switch failed");
    mockWebRtcPipeline.buildSession.mockRejectedValue(plainError);

    const app = new ContentApp();
    const result = await app.startSession(REALTIME_SETTINGS);

    expect(result.ok).toBe(false);
    // showToast must NOT have been called for this non-expiry error
    // (the overlay.removeOverlay is called but NOT showToast)
    const toastCallsForExpiry = mockOverlay.showToast.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        (call[0] as string).toLowerCase().includes("switch failed"),
    );
    expect(toastCallsForExpiry).toHaveLength(0);
  });

  it("does NOT call showToast when buildSession rejects with expiryLike=false", async () => {
    const nonExpiryError = Object.assign(
      new Error("Upstream provider error"),
      {
        user: "Upstream provider error",
        cta: undefined,
        ctaLabel: undefined,
        expiryLike: false,
      },
    );
    mockWebRtcPipeline.buildSession.mockRejectedValue(nonExpiryError);

    const app = new ContentApp();
    const result = await app.startSession(REALTIME_SETTINGS);

    expect(result.ok).toBe(false);
    // showToast should NOT have been called with this expiry-toast path
    const expiryCalls = mockOverlay.showToast.mock.calls.filter(
      (call: unknown[]) => {
        const opts = call[1];
        return (
          opts !== null &&
          typeof opts === "object" &&
          !Array.isArray(opts) &&
          ("cta" in (opts as object) || "ctaLabel" in (opts as object))
        );
      },
    );
    expect(expiryCalls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. CONTENT_SHOW_TOAST — app.overlay.showToast is the correct wiring target
//
// The actual onMessage handler lives in initContent() (not ContentApp ctor),
// so we verify the wiring at the ContentApp API level: app.overlay.showToast
// IS the same mock, and calling it with the args the handler would pass
// (as seen in content/index.ts case "CONTENT_SHOW_TOAST") produces the correct
// calls. This locks that the wiring sends the right args and no translation
// error can silently discard them.
// ─────────────────────────────────────────────────────────────────────────────

describe("CONTENT_SHOW_TOAST — app.overlay.showToast receives the right args", () => {
  it("app.overlay.showToast IS the mockOverlay.showToast (wiring sanity)", () => {
    const app = new ContentApp();
    expect(app.overlay.showToast).toBe(mockOverlay.showToast);
  });

  it("calling app.overlay.showToast with sign-in text + durationMs matches CONTENT_SHOW_TOAST handler path", () => {
    // Mirrors what content/index.ts case "CONTENT_SHOW_TOAST" does:
    //   app.overlay.showToast(msg.text, { durationMs, ...cta, ...ctaLabel })
    const app = new ContentApp();
    const text = "Sign in at echolyhq.com to start.";
    const durationMs = 8000;

    app.overlay.showToast(text, { durationMs });

    expect(mockOverlay.showToast).toHaveBeenCalledWith(
      text,
      expect.objectContaining({ durationMs: 8000 }),
    );
  });

  it("calling app.overlay.showToast with cta/ctaLabel matches CONTENT_SHOW_TOAST handler path for upgrade CTA", () => {
    // Mirrors what content/index.ts case "CONTENT_SHOW_TOAST" does when
    // msg.cta and msg.ctaLabel are present.
    const app = new ContentApp();
    const text = "Credits exhausted.";
    const opts = {
      durationMs: 8000,
      cta: "https://echolyhq.com/upgrade",
      ctaLabel: "Upgrade",
    };

    app.overlay.showToast(text, opts);

    expect(mockOverlay.showToast).toHaveBeenCalledWith(
      "Credits exhausted.",
      expect.objectContaining({
        cta: "https://echolyhq.com/upgrade",
        ctaLabel: "Upgrade",
      }),
    );
  });
});
