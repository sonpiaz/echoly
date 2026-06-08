// @vitest-environment jsdom
//
// ad-boundary-ended.test.ts — Fix A: onEnded gate + stopSession de-alarm.
//
// Acceptance criteria covered:
//   A1 — onEnded with ad.adActive===true does NOT call nav.notifyEnded().
//   A2 — onEnded within AD_END_GRACE_MS of lastAdEndAt does NOT call nav.notifyEnded().
//   A3 — onEnded at genuine end (no ad, lastAdEndAt stale/null) DOES call notifyEnded().
//   A5 — stopSession(USER_STOP|VIDEO_ENDED) logs at info; error reasons keep the stack.
//
// Strategy: use ContentApp directly (same pattern as ad-pause-integration.test.ts)
// with the same module-mock set. Drive bindCommonVideoListeners with a real <video>
// element and dispatch the 'ended' DOM event; then assert on nav.notifyEnded spy.

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
let mockNav: { start: Mock; stop: Mock; notifyEnded: Mock };

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
  NavigationWatcher: vi.fn().mockImplementation(() => mockNav),
}));
vi.mock("@/content/auto-next", () => ({
  continueOnNewVideo: vi.fn().mockResolvedValue({ ok: true }),
}));

import { ContentApp } from "@/content/index";
import { AdWatcher } from "@/content/ad-watcher";
import { STOP_REASON } from "@/content/stop-reasons";
import { AD_END_GRACE_MS } from "@/shared/constants";
import type { PlatformAdapter } from "@/shared/platform-ports";
import type { WebRtcSession } from "@/content/session-manager";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function installChrome() {
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: { id: "test", sendMessage: vi.fn().mockResolvedValue(undefined) },
  };
}
function uninstallChrome() {
  (globalThis as { chrome?: unknown }).chrome = undefined;
}

function makeAdapter(isAdPlayingFn: () => boolean): PlatformAdapter {
  return {
    id: "youtube",
    isAdPlaying: isAdPlayingFn,
    getAdSignalTarget: () => null, // poll-only for determinism
  } as unknown as PlatformAdapter;
}

function makeSession(): WebRtcSession {
  return {
    kind: undefined,
    token: 1,
    pipeline: "realtime",
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

function makeApp(isAdPlayingFn: () => boolean = () => false): ContentApp {
  const adapter = makeAdapter(isAdPlayingFn);
  mockDetectAdapter.mockReturnValue(adapter);
  const app = new ContentApp();
  app.adapter = adapter;
  return app;
}

/** Create a fake video element with controllable currentTime/duration. */
function makeVideo(opts: { currentTime?: number; duration?: number } = {}): HTMLVideoElement {
  const video = document.createElement("video");
  Object.defineProperty(video, "currentTime", {
    value: opts.currentTime ?? 100,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(video, "duration", {
    value: opts.duration ?? 120,
    writable: true,
    configurable: true,
  });
  video.play = vi.fn().mockResolvedValue(undefined);
  video.pause = vi.fn();
  return video;
}

beforeEach(() => {
  installChrome();
  vi.useFakeTimers();
  global.fetch = vi.fn().mockResolvedValue({ ok: true });
  mockDetectAdapter.mockReset();
  mockNav = {
    start: vi.fn(),
    stop: vi.fn(),
    notifyEnded: vi.fn(),
  };
  mockOverlay = {
    buildOverlay: vi.fn(), syncFromSettings: vi.fn(), setStatusText: vi.fn(),
    setOverlayState: vi.fn(), removeOverlay: vi.fn(), showToast: vi.fn(),
    setTargetText: vi.fn(), setSourceText: vi.fn(), applySourceVisibility: vi.fn(),
    applyCaptionOnVideo: vi.fn(), setDubSyncReadout: vi.fn(), pushHistoryTurn: vi.fn(),
    pushHistoryMarker: vi.fn(), setCaptionPosition: vi.fn(), isMounted: () => false,
  };
  mockStandardDubSync = {
    stop: vi.fn(), snapPlaybackStart: vi.fn(), start: vi.fn(),
    waitForFirstDub: vi.fn().mockResolvedValue(true),
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  uninstallChrome();
});

// ─────────────────────────────────────────────────────────────────────────────
// A1 — adActive===true → onEnded does NOT arm nav.notifyEnded
// ─────────────────────────────────────────────────────────────────────────────

describe("Fix A — onEnded ad-boundary gate", () => {
  it("A1: onEnded with ad.adActive===true does NOT call nav.notifyEnded()", () => {
    const app = makeApp(() => true); // ad is playing
    const session = makeSession();
    app.sm.session = session;

    // Arm the ad watcher so app.ad is a real AdWatcher seeded with adActive=true.
    app.startAdWatcher();
    expect(app.ad?.adActive).toBe(true);

    // Wire the nav watcher (NavigationWatcher mock is injected by the module mock).
    app.nav = { start: vi.fn(), stop: vi.fn(), notifyEnded: mockNav.notifyEnded } as never;

    const video = makeVideo();
    app.bindCommonVideoListeners(video, session);

    // Dispatch the spurious 'ended' event (the ad's natural end).
    video.dispatchEvent(new Event("ended"));

    // The gate must suppress it.
    expect(mockNav.notifyEnded).not.toHaveBeenCalled();

    app.stopAdWatcher();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // A2 — lastAdEndAt within AD_END_GRACE_MS → onEnded suppressed
  // ─────────────────────────────────────────────────────────────────────────

  it("A2: onEnded within AD_END_GRACE_MS of lastAdEndAt does NOT call nav.notifyEnded()", () => {
    const app = makeApp(() => false); // no ad currently
    const session = makeSession();
    app.sm.session = session;

    // Arm a stopped ad watcher and manually set lastAdEndAt to "just now".
    app.startAdWatcher();
    app.nav = { start: vi.fn(), stop: vi.fn(), notifyEnded: mockNav.notifyEnded } as never;

    const video = makeVideo();
    app.bindCommonVideoListeners(video, session);

    // Simulate: the ad just ended (lastAdEndAt set to now, within the grace window).
    app.ad!.lastAdEndAt = Date.now(); // still within AD_END_GRACE_MS

    // Dispatch 'ended' — this is the spurious one that fires immediately after
    // lastAdEndAt is set (same synchronous tick as ad-end callback chain).
    video.dispatchEvent(new Event("ended"));

    expect(mockNav.notifyEnded).not.toHaveBeenCalled();

    app.stopAdWatcher();
  });

  it("A2 (negative): onEnded AFTER AD_END_GRACE_MS has elapsed DOES call nav.notifyEnded()", () => {
    const app = makeApp(() => false);
    const session = makeSession();
    app.sm.session = session;
    app.startAdWatcher();
    app.nav = { start: vi.fn(), stop: vi.fn(), notifyEnded: mockNav.notifyEnded } as never;

    // Video at full duration so the secondary (seek-to-end) guard doesn't fire.
    const video = makeVideo({ currentTime: 120, duration: 120 });
    app.bindCommonVideoListeners(video, session);

    // Set lastAdEndAt to well in the past (stale — grace period has expired).
    app.ad!.lastAdEndAt = Date.now() - (AD_END_GRACE_MS + 5000);

    video.dispatchEvent(new Event("ended"));

    // Grace has expired → genuine end → notifyEnded must be called.
    expect(mockNav.notifyEnded).toHaveBeenCalledTimes(1);

    app.stopAdWatcher();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // A3 — genuine end (no ad, lastAdEndAt null/stale) DOES call notifyEnded
  // ─────────────────────────────────────────────────────────────────────────

  it("A3: genuine video end with no ad and stale/null lastAdEndAt calls nav.notifyEnded()", () => {
    const app = makeApp(() => false);
    const session = makeSession();
    app.sm.session = session;
    app.startAdWatcher();
    app.nav = { start: vi.fn(), stop: vi.fn(), notifyEnded: mockNav.notifyEnded } as never;

    // Video with currentTime ≈ duration (at the genuine end).
    const video = makeVideo({ currentTime: 119.8, duration: 120 });
    app.bindCommonVideoListeners(video, session);

    // lastAdEndAt is null (no ad has ended in this session).
    expect(app.ad?.lastAdEndAt).toBeNull();
    expect(app.ad?.adActive).toBe(false);

    video.dispatchEvent(new Event("ended"));

    // Genuine end — must arm the nav window.
    expect(mockNav.notifyEnded).toHaveBeenCalledTimes(1);

    app.stopAdWatcher();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A5 — stopSession de-alarm: info for normal reasons, warn+stack for errors
// ─────────────────────────────────────────────────────────────────────────────

describe("Fix A (de-alarm) — stopSession log level by reason", () => {
  it("A5a: USER_STOP logs at info without an Error stack", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const app = makeApp();
    app.stopSession(STOP_REASON.USER_STOP);

    // Should have logged info with "stopSession" (no stack).
    const infoCalls = infoSpy.mock.calls.map((args) => args[0]);
    expect(infoCalls.some((msg) => typeof msg === "string" && msg.includes("[session] stopSession"))).toBe(true);
    // Must NOT have warned (no stack).
    const warnCalls = warnSpy.mock.calls.map((args) => args[0]);
    expect(warnCalls.some((msg) => typeof msg === "string" && msg.includes("[session] stopSession"))).toBe(false);
  });

  it("A5b: VIDEO_ENDED logs at info without an Error stack", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const app = makeApp();
    app.stopSession(STOP_REASON.VIDEO_ENDED);

    const infoCalls = infoSpy.mock.calls.map((args) => args[0]);
    expect(infoCalls.some((msg) => typeof msg === "string" && msg.includes("[session] stopSession"))).toBe(true);
    const warnCalls = warnSpy.mock.calls.map((args) => args[0]);
    expect(warnCalls.some((msg) => typeof msg === "string" && msg.includes("[session] stopSession"))).toBe(false);
  });

  it("A5c: SERVER_ERROR logs at warn WITH an Error stack", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const app = makeApp();
    app.stopSession(STOP_REASON.SERVER_ERROR);

    // Must have warned.
    const warnCalls = warnSpy.mock.calls;
    const sessionWarn = warnCalls.find((args) => typeof args[0] === "string" && args[0].includes("[session] stopSession"));
    expect(sessionWarn).toBeDefined();
    // The last argument must be an Error stack string.
    if (sessionWarn) {
      const lastArg = sessionWarn[sessionWarn.length - 1];
      expect(typeof lastArg).toBe("string");
      expect(lastArg).toMatch(/Error/);
    }
    // Must NOT have logged at info for the session line.
    const infoCalls = infoSpy.mock.calls.map((args) => args[0]);
    expect(infoCalls.some((msg) => typeof msg === "string" && msg.includes("[session] stopSession"))).toBe(false);
  });

  it("A5d: CONNECTION_LOST logs at warn WITH an Error stack", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const app = makeApp();
    app.stopSession(STOP_REASON.CONNECTION_LOST);

    const warnCalls = warnSpy.mock.calls;
    const sessionWarn = warnCalls.find((args) => typeof args[0] === "string" && args[0].includes("[session] stopSession"));
    expect(sessionWarn).toBeDefined();
    if (sessionWarn) {
      const lastArg = sessionWarn[sessionWarn.length - 1];
      expect(typeof lastArg).toBe("string");
      expect(lastArg).toMatch(/Error/);
    }
  });

  it("A5e: HANDOVER_FAILED logs at warn WITH an Error stack", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const app = makeApp();
    app.stopSession(STOP_REASON.HANDOVER_FAILED);

    const warnCalls = warnSpy.mock.calls;
    const sessionWarn = warnCalls.find((args) => typeof args[0] === "string" && args[0].includes("[session] stopSession"));
    expect(sessionWarn).toBeDefined();
    if (sessionWarn) {
      const lastArg = sessionWarn[sessionWarn.length - 1];
      expect(typeof lastArg).toBe("string");
      expect(lastArg).toMatch(/Error/);
    }
  });
});
