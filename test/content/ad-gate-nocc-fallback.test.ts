// @vitest-environment jsdom
//
// Unit tests for:
//   (a) startSession ad-gate — stubbed adapter isAdPlaying:()=>true does NOT call
//       subtitleFirst/startWebRtcSession and emits ad-wait overlay state.
//   (b) When isAdPlaying flips true→false the normal start runs.
//   (c) No-CC live-dub fallback (forceWebRtcStandard+STANDARD): never calls
//       standardDubSync.start while remoteAudio is null; starts it once
//       remoteAudio becomes non-null.
//   (d) Ceiling-exceeded tears down with error toast.

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

// rtc-media-sync: avoid real DOM addEventListener calls.
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

// Stub the Stage-C AdWatcher so its 250ms poll setInterval doesn't run forever
// under vi.runAllTimersAsync() (these tests cover the start ad-gate, not the
// mid-session watcher — Stage C's own behavior is tested in ad-watcher.test.ts).
vi.mock("@/content/ad-watcher", () => ({
  AdWatcher: class {
    start = vi.fn();
    stop = vi.fn();
    get adActive() { return false; }
  },
}));

// ContentApp import MUST come AFTER all vi.mock() calls.
import { ContentApp } from "@/content/index";
import { STATUS_AD_WAIT } from "@/shared/product-copy";
import {
  AD_WAIT_POLL_MS,
  DUB_LIVE_TTFA_CEILING_MS,
  DUB_STANDARD_RELEASE_FLOOR_MS,
} from "@/shared/constants";
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

/** A flush helper that works with fake timers in vitest 3 */
async function flushMicrotasks() {
  await vi.advanceTimersByTimeAsync(0);
}

function makeMinimalAdapter(overrides: Partial<{
  isAdPlaying: (() => boolean) | undefined;
  subtitleFirst: boolean;
  findVideo: () => HTMLVideoElement | null;
  getVideoId: (url: string) => string | null;
}> = {}) {
  const base = {
    id: "youtube",
    capabilities: {
      audioCapture: true,
      subtitleFirst: overrides.subtitleFirst ?? false,
      isSpa: true,
      hasNativeCaptions: false,
      hasAdOverlays: true,
    },
    matchesHost: () => true,
    isWatchUrl: (url: string) => url.includes("/watch"),
    getVideoId: overrides.getVideoId ?? (() => "vid123"),
    findVideo: overrides.findVideo ?? (() => null),
    stageInsets: () => ({ top: 44, bottom: 56, side: 16 }),
    fetchCaptions: vi.fn().mockResolvedValue(null),
    readLiveCaptionText: () => null,
  };
  if (overrides.isAdPlaying !== undefined) {
    return { ...base, isAdPlaying: overrides.isAdPlaying };
  }
  return base;
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

const BASE_SETTINGS = {
  tier: "standard" as const,
  targetLanguage: "vi",
  apiBearer: "test-bearer",
  apiMode: "proxy" as const,
  originalVolume: 18,
  voiceVolume: 100,
  showSource: false,
  showTargetCaptions: true,
  standardVoice: "voice-1",
  realtimeVoice: "marin",
  standardVoices: [],
  languagePicker: [],
} as unknown as StartSettings;

function makeBaseSession(token = 1, remoteAudio: HTMLAudioElement | null = null) {
  return {
    kind: undefined,
    token,
    pipeline: "standard" as const,
    targetLanguage: "vi",
    voice: "voice-1",
    pc: { close: vi.fn(), iceConnectionState: "connected" },
    dc: null,
    stream: { getTracks: () => [] },
    remoteAudio,
    audioCtx: null,
    outputGain: null,
    rtcSessionId: null,
    apiBearer: "test-bearer",
  };
}

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
    findVideo: vi.fn().mockReturnValue(null),
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
    buildSession: vi.fn().mockResolvedValue(makeBaseSession()),
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
// A. Ad-gate: isAdPlaying=true → overlay "ad-wait", no pipeline started
// ─────────────────────────────────────────────────────────────────────────────

describe("Ad-gate — isAdPlaying=true blocks pipeline start", () => {
  it("shows ad-wait overlay state and does not call subtitleFirst.start or buildSession", async () => {
    mockDetectAdapter.mockReturnValue(makeMinimalAdapter({ isAdPlaying: () => true }));

    const app = new ContentApp();
    const promise = app.startSession(BASE_SETTINGS);

    // Flush microtasks so the ad-wait state is applied before the poll starts.
    await flushMicrotasks();

    expect(mockOverlay.setOverlayState).toHaveBeenCalledWith("ad-wait");
    expect(mockOverlay.setStatusText).toHaveBeenCalledWith(STATUS_AD_WAIT);

    // Neither pipeline should have been called yet.
    expect(mockSubtitleFirst.start).not.toHaveBeenCalled();
    expect(mockWebRtcPipeline.buildSession).not.toHaveBeenCalled();

    // Simulate Stop (bump pageToken) so the poll loop exits.
    app.sm.pageToken += 1;
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Cancelled");

    // Still no pipeline calls after cancellation.
    expect(mockSubtitleFirst.start).not.toHaveBeenCalled();
    expect(mockWebRtcPipeline.buildSession).not.toHaveBeenCalled();
  });

  it("emits ad-wait via setOverlayState (not connecting/live)", async () => {
    mockDetectAdapter.mockReturnValue(makeMinimalAdapter({ isAdPlaying: () => true }));

    const app = new ContentApp();
    const promise = app.startSession(BASE_SETTINGS);
    await flushMicrotasks();

    const states = mockOverlay.setOverlayState.mock.calls.map(
      (args: unknown[]) => args[0] as string,
    );
    expect(states).toContain("ad-wait");
    expect(states).not.toContain("connecting");
    expect(states).not.toContain("live");

    app.sm.pageToken += 1;
    await vi.runAllTimersAsync();
    await promise;
  });

  it("non-YouTube adapter without isAdPlaying skips ad-gate entirely", async () => {
    // Adapter with no isAdPlaying (generic).
    mockDetectAdapter.mockReturnValue(makeMinimalAdapter({ isAdPlaying: undefined }));
    // No video found → startWebRtcSession will fail at "No playable video" before doing much.
    mockCaptureInstance.findVideo.mockReturnValue(null);

    const app = new ContentApp();
    const promise = app.startSession(BASE_SETTINGS);
    await vi.runAllTimersAsync();
    const result = await promise;

    // Ad-wait state must NOT have been shown.
    const states = mockOverlay.setOverlayState.mock.calls.map(
      (args: unknown[]) => args[0] as string,
    );
    expect(states).not.toContain("ad-wait");
    // Result is {ok:false} because no video found (expected).
    expect(result.ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Ad-gate: isAdPlaying flips true→false → normal start runs
// ─────────────────────────────────────────────────────────────────────────────

describe("Ad-gate — ad clears and normal start runs", () => {
  it("after AD_WAIT_POLL_MS the poll detects ad ended and calls subtitleFirst.start", async () => {
    let adPlaying = true;
    const video = makeVideo();
    const adapter = makeMinimalAdapter({
      isAdPlaying: () => adPlaying,
      subtitleFirst: true,
      getVideoId: () => "vid123",
      findVideo: () => video,
    });
    mockDetectAdapter.mockReturnValue(adapter);
    mockCaptureInstance.isLive.mockReturnValue(false);
    mockCaptureInstance.findVideo.mockReturnValue(video);
    mockSubtitleFirst.start.mockResolvedValue({ ok: true });

    const app = new ContentApp();
    const promise = app.startSession(BASE_SETTINGS);

    // Flush so the ad-wait state is applied.
    await flushMicrotasks();
    expect(mockOverlay.setOverlayState).toHaveBeenCalledWith("ad-wait");

    // Flip ad state off.
    adPlaying = false;

    // Advance past AD_WAIT_POLL_MS + settle beat.
    await vi.advanceTimersByTimeAsync(AD_WAIT_POLL_MS * 3);
    await vi.runAllTimersAsync();

    const result = await promise;

    expect(mockSubtitleFirst.start).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. No-CC live-dub fallback: sync.start never called while remoteAudio=null
// ─────────────────────────────────────────────────────────────────────────────

describe("No-CC live-dub fallback — forceWebRtcStandard+STANDARD", () => {
  it("does NOT call standardDubSync.start while remoteAudio is null", async () => {
    const video = makeVideo();
    mockCaptureInstance.findVideo.mockReturnValue(video);
    mockCaptureInstance.isLive.mockReturnValue(false);

    const session = makeBaseSession(1, null); // null remoteAudio
    mockWebRtcPipeline.buildSession.mockResolvedValue(session);

    const app = new ContentApp();
    const promise = app.startWebRtcSession(BASE_SETTINGS, { forceWebRtcStandard: true });

    await flushMicrotasks();

    // Advance well before the ceiling, keeping remoteAudio null.
    await vi.advanceTimersByTimeAsync(DUB_LIVE_TTFA_CEILING_MS - 5000);

    // standardDubSync.start must NOT have been called yet.
    expect(mockStandardDubSync.start).not.toHaveBeenCalled();
    expect(mockStandardDubSync.snapPlaybackStart).not.toHaveBeenCalled();

    // Cancel to exit.
    app.sm.pageToken += 1;
    await vi.runAllTimersAsync();
    await promise;
  });

  it("starts sync once remoteAudio becomes non-null (late arrival)", async () => {
    const video = makeVideo();
    mockCaptureInstance.findVideo.mockReturnValue(video);
    mockCaptureInstance.isLive.mockReturnValue(false);

    const fakeAudio = {
      play: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(),
    } as unknown as HTMLAudioElement;

    const session = makeBaseSession(1, null); // starts null
    mockWebRtcPipeline.buildSession.mockResolvedValue(session);

    const app = new ContentApp();
    const promise = app.startWebRtcSession(BASE_SETTINGS, { forceWebRtcStandard: true });

    // Flush so buildSession + waitForPCConnected run.
    await flushMicrotasks();

    // Inject remoteAudio now (simulates server sending audio mid-poll).
    // sm.session is the same session object reference.
    session.remoteAudio = fakeAudio;
    if (app.sm.session) {
      (app.sm.session as { remoteAudio: HTMLAudioElement | null }).remoteAudio = fakeAudio;
    }

    // Advance past one poll interval (DUB_SYNC_POLL_MS = 500).
    await vi.advanceTimersByTimeAsync(700);
    await vi.runAllTimersAsync();

    const result = await promise;

    expect(result.ok).toBe(true);
    // Sync should have been started exactly once when remoteAudio arrived.
    expect(mockStandardDubSync.snapPlaybackStart).toHaveBeenCalledTimes(1);
    expect(mockStandardDubSync.start).toHaveBeenCalledTimes(1);
    expect(fakeAudio.play).toHaveBeenCalledTimes(1);
    // Video must NOT have been paused (live-style, no SF6 pause).
    expect(video.pause).not.toHaveBeenCalled();
  });

  it("video is NOT paused in forceWebRtcStandard path", async () => {
    const video = makeVideo(false); // playing
    mockCaptureInstance.findVideo.mockReturnValue(video);
    mockCaptureInstance.isLive.mockReturnValue(false);

    const fakeAudio = {
      play: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(),
    } as unknown as HTMLAudioElement;

    const session = makeBaseSession(1, fakeAudio); // audio available immediately
    mockWebRtcPipeline.buildSession.mockResolvedValue(session);

    const app = new ContentApp();
    const promise = app.startWebRtcSession(BASE_SETTINGS, { forceWebRtcStandard: true });
    await vi.runAllTimersAsync();
    await promise;

    expect(video.pause).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. Ceiling-exceeded tears down with error toast
// ─────────────────────────────────────────────────────────────────────────────

describe("No-CC live-dub fallback — ceiling exceeded", () => {
  it("shows error toast and tears down if no audio arrives in DUB_LIVE_TTFA_CEILING_MS", async () => {
    const video = makeVideo();
    mockCaptureInstance.findVideo.mockReturnValue(video);
    mockCaptureInstance.isLive.mockReturnValue(false);

    // Session with permanently null remoteAudio.
    const session = makeBaseSession(1, null);
    mockWebRtcPipeline.buildSession.mockResolvedValue(session);

    const app = new ContentApp();
    const promise = app.startWebRtcSession(BASE_SETTINGS, { forceWebRtcStandard: true });

    await flushMicrotasks();

    // Advance past the full ceiling.
    await vi.advanceTimersByTimeAsync(DUB_LIVE_TTFA_CEILING_MS + 2000);
    await vi.runAllTimersAsync();

    const result = await promise;

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/live dubbing unavailable/i);

    // Error toast must have been shown.
    expect(mockOverlay.showToast).toHaveBeenCalledWith(
      expect.stringMatching(/live dubbing unavailable/i),
      expect.any(Number),
    );

    // Sync must not have been started.
    expect(mockStandardDubSync.start).not.toHaveBeenCalled();
    expect(mockStandardDubSync.snapPlaybackStart).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. Stage D — Standard-VOD shorter gate (DUB_STANDARD_RELEASE_FLOOR_MS)
// ─────────────────────────────────────────────────────────────────────────────
//
// The normal Standard-VOD path (caption-driven, video paused on SF6) now releases
// video.play() as soon as waitForFirstDub() resolves OR the short release-floor
// elapses — whichever is FIRST — then lets bindStandardDubPlaybackSync ramp the
// playbackRate to catch up. The full DUB_TTFA_GATE_MS stays only as the absolute
// cap inside waitForFirstDub().

describe("Stage D — Standard-VOD shorter release gate", () => {
  it("releases video.play() + starts dub sync after the floor even when the first dub is slow", async () => {
    const video = makeVideo(false); // playing → SF6 pauses it
    mockCaptureInstance.findVideo.mockReturnValue(video);
    mockCaptureInstance.isLive.mockReturnValue(false);

    const fakeAudio = {
      play: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(),
    } as unknown as HTMLAudioElement;
    const session = makeBaseSession(1, fakeAudio);
    mockWebRtcPipeline.buildSession.mockResolvedValue(session);

    // waitForFirstDub is SLOW: resolves only after well past the release floor.
    // The release floor (1500ms) must win the race so play() is issued early.
    let resolveFirstDub: () => void = () => {};
    mockStandardDubSync.waitForFirstDub.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveFirstDub = () => resolve(true);
      }),
    );

    const app = new ContentApp();
    // Normal Standard-VOD path: NO forceWebRtcStandard → video is paused (SF6).
    const promise = app.startWebRtcSession(BASE_SETTINGS);

    // Let buildSession + waitForPCConnected + the SF6 pause settle.
    await flushMicrotasks();
    // SF6 paused the source video (controller-issued).
    expect(video.pause).toHaveBeenCalled();

    // Before the floor elapses, the dub sync has NOT started (still waiting).
    await vi.advanceTimersByTimeAsync(DUB_STANDARD_RELEASE_FLOOR_MS - 200);
    expect(mockStandardDubSync.start).not.toHaveBeenCalled();

    // Cross the release floor — waitForFirstDub is STILL unresolved, but the floor
    // wins the race → resume('system-buffer') issues video.play() + sync starts.
    await vi.advanceTimersByTimeAsync(400);
    await flushMicrotasks();

    expect(video.play).toHaveBeenCalled();                  // released early on the floor
    expect(mockStandardDubSync.snapPlaybackStart).toHaveBeenCalledTimes(1);
    expect(mockStandardDubSync.start).toHaveBeenCalledTimes(1); // ramp begins to catch up

    // Settle: resolve the slow dub + drain timers.
    resolveFirstDub();
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.ok).toBe(true);
  });
});
