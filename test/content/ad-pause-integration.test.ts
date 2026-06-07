// @vitest-environment jsdom
//
// Stage C (ADS) integration — ContentApp wires the AdWatcher to the lifecycle.
//
// Drives a controllable ad state through a real AdWatcher (armed via
// app.startAdWatcher()) and asserts:
//   • onAdStart → lifecycle.pause('ad') (controller owns video.pause()).
//   • WebRTC ad-pause disables sender tracks + POSTs media-pause → server
//     metering freezes — via the SAME syncSourcePauseState path the user uses.
//   • onAdEnd → lifecycle.resume('ad'); overlay back to 'live'.
//   • user-pause DURING an ad + ad DURING a user-pause: resume only when BOTH
//     reasons clear (reason-stack AND semantics).

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
let mockStandardDubSync: { stop: Mock; snapPlaybackStart: Mock; start: Mock; waitForFirstDub: Mock };

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
    isLive = vi.fn().mockReturnValue(false);
  },
}));
vi.mock("@/content/pipelines/webrtc-pipeline", () => ({
  WebRtcPipeline: class { buildSession = vi.fn(); requestHandover = vi.fn(); },
}));
vi.mock("@/content/pipelines/subtitle-first-pipeline", () => ({
  SubtitleFirstPipeline: class { start = vi.fn(); restart = vi.fn(); reAnchor = vi.fn(); },
}));
vi.mock("@/lib/dub-playback-sync", () => ({
  bindStandardDubPlaybackSync: vi.fn(() => mockStandardDubSync),
}));
vi.mock("@/content/navigation", () => ({
  NavigationWatcher: class { start = vi.fn(); stop = vi.fn(); notifyEnded = vi.fn(); },
}));
vi.mock("@/content/auto-next", () => ({
  continueOnNewVideo: vi.fn().mockResolvedValue({ ok: true }),
}));

import { ContentApp } from "@/content/index";
import { STATUS_AD_WAIT } from "@/shared/product-copy";
import { AD_WAIT_POLL_MS } from "@/shared/constants";
import type { WebRtcSession } from "@/content/session-manager";
import type { PlatformAdapter } from "@/shared/platform-ports";

// ─── Helpers ───────────────────────────────────────────────────────────────────

function installChrome() {
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: { id: "test", sendMessage: vi.fn().mockResolvedValue(undefined) },
  };
}
function uninstallChrome() {
  (globalThis as { chrome?: unknown }).chrome = undefined;
}

/** A WebRTC session with a spy-able pc / stream / remoteAudio for metering checks. */
function makeWebRtcSession(): WebRtcSession & {
  _audioSender: { track: { enabled: boolean; kind: string } };
} {
  const audioTrack = { enabled: true, kind: "audio" };
  const sender = { track: audioTrack };
  return {
    kind: undefined,
    token: 1,
    pipeline: "realtime",
    targetLanguage: "vi",
    voice: "marin",
    pc: { getSenders: () => [sender] } as unknown as RTCPeerConnection,
    dc: null,
    stream: { getAudioTracks: () => [audioTrack] } as unknown as MediaStream,
    remoteAudio: { pause: vi.fn(), play: vi.fn().mockResolvedValue(undefined) } as unknown as HTMLAudioElement,
    audioCtx: { state: "running", suspend: vi.fn().mockResolvedValue(undefined), resume: vi.fn().mockResolvedValue(undefined) } as unknown as AudioContext,
    outputGain: null,
    rtcSessionId: "rtc-1",
    apiBearer: "bearer-1",
    _audioSender: sender,
  } as unknown as WebRtcSession & { _audioSender: { track: { enabled: boolean; kind: string } } };
}

/** Build a ContentApp wired to a controllable ad state + a live session. */
function makeAppWithSession(getAd: () => boolean) {
  const adapter = {
    id: "youtube",
    isAdPlaying: getAd,
    getAdSignalTarget: () => null, // poll-only → deterministic under fake timers
  } as unknown as PlatformAdapter;
  mockDetectAdapter.mockReturnValue(adapter);

  const app = new ContentApp();
  app.adapter = adapter;
  return app;
}

beforeEach(() => {
  installChrome();
  vi.useFakeTimers();
  global.fetch = vi.fn().mockResolvedValue({ ok: true });
  mockDetectAdapter.mockReset();
  mockOverlay = {
    buildOverlay: vi.fn(), syncFromSettings: vi.fn(), setStatusText: vi.fn(),
    setOverlayState: vi.fn(), removeOverlay: vi.fn(), showToast: vi.fn(),
    setTargetText: vi.fn(), setSourceText: vi.fn(), applySourceVisibility: vi.fn(),
    applyCaptionOnVideo: vi.fn(), setDubSyncReadout: vi.fn(), pushHistoryTurn: vi.fn(),
    pushHistoryMarker: vi.fn(), setCaptionPosition: vi.fn(), isMounted: () => false,
  };
  mockStandardDubSync = { stop: vi.fn(), snapPlaybackStart: vi.fn(), start: vi.fn(), waitForFirstDub: vi.fn().mockResolvedValue(true) };
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  uninstallChrome();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Ad pause routes through lifecycle.pause('ad') + WebRTC metering freeze
// ─────────────────────────────────────────────────────────────────────────────

describe("Stage C — ad pause routes through the lifecycle", () => {
  it("onAdStart → lifecycle.pause('ad') + overlay ad-wait; onAdEnd → resume('ad') + live", async () => {
    let ad = false;
    const app = makeAppWithSession(() => ad);
    app.sm.session = makeWebRtcSession();
    app.startAdWatcher();

    // Ad starts.
    ad = true;
    vi.advanceTimersByTime(AD_WAIT_POLL_MS);
    expect(app.lifecycle.isPausedFor("ad")).toBe(true);
    expect(app.lifecycle.effectivePaused).toBe(true);
    expect(mockOverlay.setOverlayState).toHaveBeenCalledWith("ad-wait");
    expect(mockOverlay.setStatusText).toHaveBeenCalledWith(STATUS_AD_WAIT);

    // Ad ends.
    ad = false;
    vi.advanceTimersByTime(AD_WAIT_POLL_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(app.lifecycle.isPausedFor("ad")).toBe(false);
    expect(app.lifecycle.effectivePaused).toBe(false);
    expect(mockOverlay.setOverlayState).toHaveBeenCalledWith("live");

    app.stopAdWatcher();
  });

  it("WebRTC ad-pause disables the outbound sender track AND POSTs media-pause (metering freezes)", async () => {
    let ad = false;
    const app = makeAppWithSession(() => ad);
    const sess = makeWebRtcSession();
    app.sm.session = sess;
    app.sm.apiBase = "https://api.test/v1";
    app.startAdWatcher();

    ad = true;
    vi.advanceTimersByTime(AD_WAIT_POLL_MS);
    await vi.advanceTimersByTimeAsync(0);

    // The ad is NOT sent to the provider — sender + stream audio tracks disabled.
    expect(sess._audioSender.track.enabled).toBe(false);
    // remoteAudio paused so the dub stops over the ad.
    expect(sess.remoteAudio!.pause).toHaveBeenCalled();
    // media-pause POSTed → server metering freezes.
    const fetchMock = global.fetch as unknown as Mock;
    const calledUrls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calledUrls.some((u) => u.includes("/rtc/translate/rtc-1/media-pause"))).toBe(true);

    // On ad-end the tracks re-enable + media-resume is POSTed.
    ad = false;
    vi.advanceTimersByTime(AD_WAIT_POLL_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(sess._audioSender.track.enabled).toBe(true);
    const calledUrls2 = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calledUrls2.some((u) => u.includes("/rtc/translate/rtc-1/media-resume"))).toBe(true);

    app.stopAdWatcher();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Coexistence — user + ad reasons (resume only when BOTH clear)
// ─────────────────────────────────────────────────────────────────────────────

describe("Stage C — user-pause + ad coexist via the reason stack", () => {
  it("user-pause DURING an ad (real DOM 'pause'): video stays paused after the ad ends until the user resumes", async () => {
    // A real <video>, bound through bindCommonVideoListeners, so a GENUINE DOM
    // 'pause' event flows through the onPause handler (no longer dropped by the
    // removed shouldIgnoreSourcePlaybackEvent secondary guard). isAdPlaying is
    // true the whole time the ad runs.
    let ad = false;
    const app = makeAppWithSession(() => ad);
    const session = makeWebRtcSession();
    app.sm.session = session;
    app.sm.settings = { tier: "realtime" } as never; // resumeSession reads settings
    app.startAdWatcher();

    const video = document.createElement("video");
    // jsdom doesn't implement play()/pause() — stub them so the controller's
    // self-issued ops + the user pause/resume don't throw.
    Object.defineProperty(video, "paused", { value: true, writable: true, configurable: true });
    video.play = vi.fn(() => { (video as { paused: boolean }).paused = false; return Promise.resolve(); });
    video.pause = vi.fn(() => { (video as { paused: boolean }).paused = true; });
    app.bindCommonVideoListeners(video, session);

    // Ad starts → AdWatcher holds 'ad' (controller-issued pause; self-issued).
    ad = true;
    vi.advanceTimersByTime(AD_WAIT_POLL_MS);
    await vi.advanceTimersByTimeAsync(0);
    // Let the self-issued guard clear so the user's DOM pause is NOT mistaken for ours.
    await vi.advanceTimersByTimeAsync(1);
    expect(app.lifecycle.isPausedFor("ad")).toBe(true);

    // The user presses pause DURING the ad → a real DOM 'pause' event.
    (video as { paused: boolean }).paused = true;
    video.dispatchEvent(new Event("pause"));
    expect(app.lifecycle.isPausedFor("user")).toBe(true); // the real user pause was NOT swallowed

    // Ad ends → 'ad' popped, but 'user' still held → the video STAYS paused.
    ad = false;
    vi.advanceTimersByTime(AD_WAIT_POLL_MS);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(app.lifecycle.isPausedFor("ad")).toBe(false);
    expect(app.lifecycle.isPausedFor("user")).toBe(true);
    expect(app.lifecycle.effectivePaused).toBe(true); // resume only when BOTH clear
    expect(video.paused).toBe(true); // the controller did NOT un-pause the video

    // The user resumes (real DOM 'play') → now fully clear + video plays.
    (video as { paused: boolean }).paused = false;
    video.dispatchEvent(new Event("play"));
    await vi.advanceTimersByTimeAsync(1);
    expect(app.lifecycle.isPausedFor("user")).toBe(false);
    expect(app.lifecycle.effectivePaused).toBe(false);

    app.stopAdWatcher();
  });

  it("ad DURING a user-pause: user resumes but the ad still holds → stays paused until the ad ends", async () => {
    let ad = false;
    const app = makeAppWithSession(() => ad);
    app.sm.session = makeWebRtcSession();
    app.startAdWatcher();

    // User pauses first.
    app.lifecycle.pause("user");
    expect(app.lifecycle.effectivePaused).toBe(true);

    // An ad starts while user-paused → 'ad' added (no double video.pause; stack was non-empty).
    ad = true;
    vi.advanceTimersByTime(AD_WAIT_POLL_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(app.lifecycle.isPausedFor("ad")).toBe(true);
    expect(app.lifecycle.isPausedFor("user")).toBe(true);

    // User resumes, but the ad is still on → STILL paused.
    await app.lifecycle.resume("user");
    expect(app.lifecycle.isPausedFor("user")).toBe(false);
    expect(app.lifecycle.effectivePaused).toBe(true); // ad still holds

    // Ad ends → fully clear.
    ad = false;
    vi.advanceTimersByTime(AD_WAIT_POLL_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(app.lifecycle.effectivePaused).toBe(false);

    app.stopAdWatcher();
  });
});
