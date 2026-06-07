// @vitest-environment jsdom
//
// Keep-alive auto-next (replaces the removed Stage-B SOFT-STOP fork).
//
// The soft-stop fork was built on a wrong premise: it forked stopSession on a
// "continuable server stop" (BACKEND_STOP), but the only producer of CONTENT_STOP
// is the popup Stop + the background coordinator's authoritative stop() — BOTH
// terminal. There is no continuable server-stop signal. So the fork was harmful
// (it could keep a session alive on a real user Stop) and has been removed.
//
// The REAL auto-next mechanism is keep-alive:
//   • At VOD video-end the source <video> fires 'ended' → nav.notifyEnded() ONLY.
//     stopSession is NOT called, so sm.session stays alive and the 500ms URL poll
//     drives continueOnNewVideo() onto the auto-advanced next video.
//   • A user Stop (CONTENT_STOP → USER_STOP) tears the session down FULLY.
//
// These tests lock that contract:
//   1. video-end keeps the session alive (no teardown) → the nav URL-poll fires
//      {continue} for the next video.
//   2. a user Stop tears down fully (session nulled, nav stopped, controller
//      parked terminal).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WebRtcSession, SubtitleFirstSession } from "@/content/session-manager";
import { STOP_REASON } from "@/content/stop-reasons";

// ─── Module mocks (DOM / chrome / native boundaries) ─────────────────────────
//
// Plain module-scope consts: the vi.mock factories close over them and read them
// LAZILY (the factory body runs when the mocked function is first CALLED, by which
// point these are initialized) — same pattern as the rest of the content tests.

const overlayState: { lastState: string | null } = { lastState: null };
const adapterFlags = { isWatch: true, videoId: "vid-1" };

vi.mock("@/content/overlay/overlay", () => ({
  createOverlay: () => ({
    buildOverlay: vi.fn(),
    syncFromSettings: vi.fn(),
    setStatusText: vi.fn(),
    setOverlayState: vi.fn((s: string) => {
      overlayState.lastState = s;
    }),
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
  }),
  purgeEcholyOverlayRoots: vi.fn(),
}));

// Adapter whose isWatchUrl is toggled per-test via a module-level flag.
vi.mock("@/platforms/registry", () => ({
  detectAdapter: () => ({
    id: "youtube",
    capabilities: { audioCapture: true, subtitleFirst: true, isSpa: true, hasNativeCaptions: false, hasAdOverlays: false },
    matchesHost: () => true,
    isWatchUrl: () => adapterFlags.isWatch,
    getVideoId: () => adapterFlags.videoId,
    findVideo: () => null,
    stageInsets: () => ({ top: 44, bottom: 56, side: 16 }),
    fetchCaptions: async () => null,
    readLiveCaptionText: () => null,
  }),
}));

vi.mock("@/content/media-stage", () => ({
  setActiveAdapter: vi.fn(),
  findPrimaryVideo: vi.fn().mockReturnValue(null),
  getActiveAdapter: vi.fn().mockReturnValue(null),
}));

vi.mock("@/content/controller", () => ({
  createController: () => ({}),
}));

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
    captureWithRetry = vi.fn();
    waitForPCConnected = vi.fn();
  },
}));

vi.mock("@/content/pipelines/webrtc-pipeline", () => ({
  WebRtcPipeline: class {
    buildSession = vi.fn();
    requestHandover = vi.fn();
    continueOnNewVideo = vi.fn().mockResolvedValue({ ok: true });
  },
}));

vi.mock("@/content/pipelines/subtitle-first-pipeline", () => ({
  SubtitleFirstPipeline: class {
    start = vi.fn();
    restart = vi.fn().mockResolvedValue({ ok: true });
  },
}));

// Mock the heavy real modules out of ContentApp's import graph. We never call
// startSession in these tests, so their factories just need to exist.
vi.mock("@/content/auto-next", () => ({
  continueOnNewVideo: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/content/navigation", () => ({
  NavigationWatcher: class {
    start = vi.fn();
    stop = vi.fn();
    notifyEnded = vi.fn();
  },
}));

// Controllable NavigationWatcher fake (built inline, NOT the mocked class): its
// start() captures the wired onEvent callback so a test can drive {continue}/
// {stop} directly; notifyEnded() is a no-op on the session (mirrors the real
// watcher: 'ended' arms a timer only — it NEVER tears the session down). This
// locks the keep-alive contract: video-end does not stop the session; the
// URL-poll continue does.
type NavEventLite =
  | { kind: "continue"; videoId: string }
  | { kind: "stop"; reason: string };
const navHandles: {
  onEvent: ((e: NavEventLite) => void) | null;
  notifyEndedCalls: number;
} = { onEvent: null, notifyEndedCalls: 0 };

function makeNavFake() {
  return {
    start(onEvent: (e: NavEventLite) => void): void {
      navHandles.onEvent = onEvent;
    },
    stop: vi.fn(),
    notifyEnded: vi.fn(() => {
      navHandles.notifyEndedCalls += 1;
    }),
  };
}

/** Local spy for the auto-next continuation (the wired continue callback calls it). */
const continueOnNewVideo = vi.fn().mockResolvedValue(undefined);

import { ContentApp } from "@/content/index";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setHref(url: string) {
  Object.defineProperty(window, "location", {
    value: { href: url },
    writable: true,
    configurable: true,
  });
}

function makeRemoteAudio() {
  return {
    pause: vi.fn(),
    remove: vi.fn(),
    srcObject: {} as MediaStream | null,
    play: vi.fn().mockResolvedValue(undefined),
  } as unknown as HTMLAudioElement;
}

function makeWebRtcSession(token: number): WebRtcSession {
  return {
    kind: undefined,
    token,
    pipeline: "realtime",
    targetLanguage: "vi",
    voice: "marin",
    pc: null,
    dc: null,
    stream: null,
    remoteAudio: makeRemoteAudio(),
    audioCtx: null,
    outputGain: { gain: { value: 1 } } as unknown as GainNode,
    rtcSessionId: "sess-1",
    apiBearer: "bearer-1",
  } as WebRtcSession;
}

function makeSubtitleFirstSession(token: number): SubtitleFirstSession {
  return {
    kind: "subtitle-first",
    token,
    pc: null,
    dc: null,
    stream: null,
    remoteAudio: null,
    audioCtx: { state: "running", close: vi.fn() } as unknown as AudioContext,
    outputGain: null,
    rtcSessionId: null,
    apiBearer: "b",
    abortController: new AbortController(),
    sentences: [],
    translations: [],
    currentSource: {
      stop: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as AudioBufferSourceNode,
    currentPlayingIdx: 3,
    playbackTimer: setInterval(() => {}, 250) as ReturnType<typeof setInterval>,
    renderCursor: 0,
    rollingInFlight: false,
    stopFlag: false,
  } as unknown as SubtitleFirstSession;
}

function installChrome() {
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: { id: "test", sendMessage: vi.fn().mockResolvedValue(undefined) },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Keep-alive auto-next — video-end does NOT stop the session", () => {
  let app: ContentApp;

  beforeEach(() => {
    vi.useFakeTimers();
    installChrome();
    adapterFlags.isWatch = true;
    adapterFlags.videoId = "vid-1";
    overlayState.lastState = null;
    navHandles.onEvent = null;
    navHandles.notifyEndedCalls = 0;
    setHref("https://www.youtube.com/watch?v=vid-1");
    continueOnNewVideo.mockClear();
    continueOnNewVideo.mockResolvedValue(undefined);
    app = new ContentApp();
    // Arm the controllable nav fake — its start() captures navHandles.onEvent.
    app.nav = makeNavFake() as unknown as typeof app.nav;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    (globalThis as { chrome?: unknown }).chrome = undefined;
  });

  it("VOD video-end keeps the realtime session alive (nothing terminally stops it)", () => {
    const stopSpy = vi.spyOn(app, "stopSession");
    const session = makeWebRtcSession(1);
    app.sm.session = session;
    app.sm.pageToken = 1;
    app.lifecycle.transition("starting");
    app.lifecycle.transition("dubbing");

    // 'ended' fires → notifyEnded() ONLY (no stopSession). Session stays alive.
    app.nav!.notifyEnded();

    expect(navHandles.notifyEndedCalls).toBe(1);
    expect(stopSpy).not.toHaveBeenCalled();
    expect(app.sm.session).toBe(session);
    expect(app.lifecycle.state).toBe("dubbing");
  });

  it("after video-end, a {continue} nav event drives continueOnNewVideo (keep-alive)", () => {
    const session = makeWebRtcSession(1);
    app.sm.session = session;
    app.sm.pageToken = 1;
    app.lifecycle.transition("starting");
    app.lifecycle.transition("dubbing");

    // Wire the dispatch exactly like startSession does.
    app.nav!.start((e) => {
      if (e.kind === "continue") void continueOnNewVideo(app, e.videoId);
      else app.stopSession(e.reason as never);
    });

    // Video ended — session stays alive, watcher awaiting next.
    app.nav!.notifyEnded();
    expect(app.sm.session).toBe(session);

    // The URL poll detects the auto-advanced next video → emits {continue}.
    navHandles.onEvent!({ kind: "continue", videoId: "vid-2" });

    expect(continueOnNewVideo).toHaveBeenCalledWith(app, "vid-2");
  });

  it("subtitle-first session also stays alive across video-end (no teardown)", () => {
    const stopSpy = vi.spyOn(app, "stopSession");
    const session = makeSubtitleFirstSession(2);
    app.sm.session = session;
    app.sm.pageToken = 2;
    app.lifecycle.transition("starting");
    app.lifecycle.transition("dubbing");

    app.nav!.notifyEnded();

    expect(stopSpy).not.toHaveBeenCalled();
    expect(app.sm.session).toBe(session);
    // The playback driver is NOT cleared by the ended path (no soft-stop silence).
    expect(session.playbackTimer).not.toBeNull();
  });
});

describe("User Stop is terminal — full teardown", () => {
  let app: ContentApp;

  beforeEach(() => {
    vi.useFakeTimers();
    installChrome();
    adapterFlags.isWatch = true;
    adapterFlags.videoId = "vid-1";
    setHref("https://www.youtube.com/watch?v=vid-1");
    app = new ContentApp();
    app.nav = { stop: vi.fn() } as unknown as typeof app.nav;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    (globalThis as { chrome?: unknown }).chrome = undefined;
  });

  it("USER_STOP on a watch URL: terminal teardown (session nulled, nav stopped, /end ran)", () => {
    const endSpy = vi.spyOn(app.sm, "endRtcSession").mockResolvedValue(undefined as never);
    const navStop = app.nav!.stop as ReturnType<typeof vi.fn>;
    const session = makeWebRtcSession(1);
    app.sm.session = session;
    app.sm.pageToken = 1;
    app.lifecycle.transition("starting");
    app.lifecycle.transition("dubbing");

    app.stopSession(STOP_REASON.USER_STOP);

    // Full teardown despite being on a watch URL — there is no soft fork anymore.
    expect(app.sm.session).toBeNull();
    expect(navStop).toHaveBeenCalledTimes(1);
    // Realtime /end ran (release the live slot).
    expect(endSpy).toHaveBeenCalledTimes(1);
    // Controller parked in a terminal state so the next session resets cleanly.
    expect(app.lifecycle.state).toBe("stopped");
  });

  it("USER_STOP from a paused session is still terminal", () => {
    const navStop = app.nav!.stop as ReturnType<typeof vi.fn>;
    const session = makeWebRtcSession(2);
    app.sm.session = session;
    app.sm.pageToken = 2;
    app.lifecycle.transition("starting");
    app.lifecycle.transition("dubbing");
    app.lifecycle.transition("paused");

    app.stopSession(STOP_REASON.USER_STOP);

    expect(app.sm.session).toBeNull();
    expect(navStop).toHaveBeenCalledTimes(1);
    expect(app.lifecycle.state).toBe("stopped");
  });

  it("after a terminal stop, a fresh session can start again (resetForNewSession)", () => {
    const session = makeWebRtcSession(3);
    app.sm.session = session;
    app.sm.pageToken = 3;
    app.lifecycle.transition("starting");
    app.lifecycle.transition("dubbing");
    app.stopSession(STOP_REASON.USER_STOP);
    expect(app.lifecycle.state).toBe("stopped");

    // The next session resets the controller out of the terminal state.
    app.lifecycle.resetForNewSession();
    expect(app.lifecycle.state).toBe("idle");
    // …and can walk the happy path again without throwing.
    expect(() => {
      app.lifecycle.transition("starting");
      app.lifecycle.transition("dubbing");
    }).not.toThrow();
  });
});
