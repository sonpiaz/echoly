// @vitest-environment jsdom
//
// GAP-3 unit tests — pause-controller, SessionManager timer freeze/thaw,
// NavigationWatcher, auto-next GAP-1 regression, and subtitle-first.restart eviction.
//
// Tests are deterministic: fake timers (vi.useFakeTimers), mocked fetch, no real
// network. Each describe block is self-contained with its own beforeEach/afterEach.

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from "vitest";

// ─── Module mocks must come before ContentApp / pipeline imports ───────────────

vi.mock("@/content/overlay/overlay", () => ({
  createOverlay: () => ({
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
  }),
  purgeEcholyOverlayRoots: vi.fn(),
}));

vi.mock("@/platforms/registry", () => ({
  detectAdapter: () => ({
    id: "youtube",
    capabilities: {
      audioCapture: true,
      subtitleFirst: true,
      isSpa: true,
      hasNativeCaptions: false,
      hasAdOverlays: false,
    },
    matchesHost: () => true,
    isWatchUrl: (url: string) => url.includes("/watch"),
    getVideoId: (url: string) => {
      const m = url.match(/[?&]v=([^&]+)/);
      return m ? m[1]! : null;
    },
    findVideo: () => null,
    stageInsets: () => ({ top: 44, bottom: 56, side: 16 }),
    fetchCaptions: vi.fn().mockResolvedValue(null),
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

// ─── Subject imports ──────────────────────────────────────────────────────────

import { SessionManager } from "@/content/session-manager";
import type { WebRtcSession, SubtitleFirstSession } from "@/content/session-manager";
import { pauseSession, resumeSession } from "@/content/pause-controller";
import { LifecycleController } from "@/content/lifecycle";
import type { ContentApp } from "@/content/index";
import { NavigationWatcher } from "@/content/navigation";
import { STOP_REASON } from "@/content/stop-reasons";
import { STATUS_PAUSED_VIDEO } from "@/shared/product-copy";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function installChrome() {
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: { id: "test", sendMessage: vi.fn().mockResolvedValue(undefined) },
  };
}

function uninstallChrome() {
  (globalThis as { chrome?: unknown }).chrome = undefined;
}

function makeWebRtcSession(token: number): WebRtcSession {
  return {
    kind: undefined,
    token,
    pipeline: "realtime",
    targetLanguage: "vi",
    voice: "marin",
    pc: {
      getSenders: vi.fn().mockReturnValue([]),
      iceConnectionState: "connected",
    } as unknown as RTCPeerConnection,
    dc: null,
    stream: {
      getAudioTracks: vi.fn().mockReturnValue([]),
    } as unknown as MediaStream,
    remoteAudio: {
      pause: vi.fn(),
      play: vi.fn().mockResolvedValue(undefined),
    } as unknown as HTMLAudioElement,
    audioCtx: {
      state: "running",
      suspend: vi.fn().mockResolvedValue(undefined),
      resume: vi.fn().mockResolvedValue(undefined),
    } as unknown as AudioContext,
    outputGain: null,
    rtcSessionId: "sess-1",
    apiBearer: "test-bearer",
  };
}

/** Minimal ContentApp-like facade for pause-controller tests.
 *  userPaused/videoPaused/connectionLost are now DERIVED getters over the
 *  LifecycleController's reason stack — tests drive pause state through
 *  `lifecycle.pause(reason)`/`resume(reason)`, not by writing the flags. */
function makeFakeApp(sess: WebRtcSession | SubtitleFirstSession | null) {
  const sm = new SessionManager();
  const lifecycle = new LifecycleController();
  sm.lifecycle = lifecycle;
  sm.session = sess;
  if (sess) {
    sm.pageToken = sess.token;
  }
  const overlay = {
    setOverlayState: vi.fn(),
    setStatusText: vi.fn(),
  };
  const standardDubSync = {
    stop: vi.fn(),
    snapPlaybackStart: vi.fn(),
    start: vi.fn(),
    waitForFirstDub: vi.fn().mockResolvedValue(true),
  };
  const webrtc = {
    continueOnNewVideo: vi.fn().mockResolvedValue({ ok: true }),
  };
  // capture.videoEl = null means no video available → gates will skip hold
  const capture = { videoEl: null as HTMLVideoElement | null };
  // subtitleFirst stub with onResumeCheck
  const subtitleFirst = { onResumeCheck: vi.fn() };
  const stopSession = vi.fn();
  // Use `unknown` intermediary so the partial fake satisfies the ContentApp parameter type.
  const asApp = {
    sm,
    lifecycle,
    overlay,
    standardDubSync,
    webrtc,
    capture,
    subtitleFirst,
    stopSession,
  } as unknown as ContentApp;
  return Object.assign(asApp, { sm, lifecycle, overlay, standardDubSync, webrtc, capture, subtitleFirst, stopSession });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. pause-controller — pauseSession + resumeSession
// ─────────────────────────────────────────────────────────────────────────────

describe("pause-controller — pauseSession", () => {
  beforeEach(() => {
    installChrome();
    vi.useFakeTimers();
    // Suppress fetch calls from syncSourcePauseState
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    uninstallChrome();
  });

  it("sets sm.userPaused=true and emits paused state (WebRTC session)", () => {
    const sess = makeWebRtcSession(1);
    const app = makeFakeApp(sess);
    pauseSession(app);

    expect(app.sm.userPaused).toBe(true);
    expect(app.overlay.setOverlayState).toHaveBeenCalledWith("paused");
    expect(app.overlay.setStatusText).toHaveBeenCalledWith(STATUS_PAUSED_VIDEO);
  });

  it("emitState carries {running:true, paused:true} (WebRTC session)", () => {
    const sess = makeWebRtcSession(2);
    const app = makeFakeApp(sess);
    const emitSpy = vi.spyOn(app.sm, "emitState");
    pauseSession(app);

    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({ running: true, paused: true }),
    );
  });

  it("calls standardDubSync.stop() for a Standard-WebRTC session", () => {
    const sess = makeWebRtcSession(3);
    (sess as unknown as { pipeline: string }).pipeline = "standard";
    const app = makeFakeApp(sess);
    pauseSession(app);

    expect(app.standardDubSync.stop).toHaveBeenCalledTimes(1);
  });

  it("does NOT call standardDubSync.stop() for a Realtime session", () => {
    const sess = makeWebRtcSession(4); // pipeline = "realtime"
    const app = makeFakeApp(sess);
    pauseSession(app);

    expect(app.standardDubSync.stop).not.toHaveBeenCalled();
  });

  it("is idempotent — second call is a no-op", () => {
    const sess = makeWebRtcSession(5);
    const app = makeFakeApp(sess);
    pauseSession(app);
    pauseSession(app);

    expect(app.overlay.setOverlayState).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when no session is active", () => {
    const app = makeFakeApp(null);
    pauseSession(app);
    expect(app.overlay.setOverlayState).not.toHaveBeenCalled();
  });

  it("for subtitle-first session does NOT call standardDubSync.stop()", () => {
    const sfSess = {
      kind: "subtitle-first",
      token: 6,
      pc: null,
      dc: null,
      stream: null,
      remoteAudio: null,
      audioCtx: null,
      outputGain: null,
      rtcSessionId: null,
      apiBearer: "",
      abortController: new AbortController(),
      sentences: [],
      translations: [],
      currentSource: null,
      currentPlayingIdx: null,
      playbackTimer: null,
      renderCursor: 0,
      rollingInFlight: false,
      stopFlag: false,
      _batchRequestIds: new Map(),
      _sentBatchRanges: new Map(),
      _renderEpoch: 0,
      _pendingLines: new Set(),
      _pendingFirstQueuedAt: 0,
    } as SubtitleFirstSession;
    const app = makeFakeApp(sfSess);
    pauseSession(app);

    expect(app.sm.userPaused).toBe(true);
    expect(app.standardDubSync.stop).not.toHaveBeenCalled();
    expect(app.overlay.setOverlayState).toHaveBeenCalledWith("paused");
  });
});

describe("pause-controller — resumeSession", () => {
  beforeEach(() => {
    installChrome();
    vi.useFakeTimers();
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    uninstallChrome();
  });

  it("sets sm.userPaused=false and emits live state for WebRTC", async () => {
    const sess = makeWebRtcSession(1);
    const app = makeFakeApp(sess);
    app.lifecycle.pause("user"); // simulate already paused
    const emitSpy = vi.spyOn(app.sm, "emitState");
    await resumeSession(app);

    expect(app.sm.userPaused).toBe(false);
    expect(app.overlay.setOverlayState).toHaveBeenCalledWith("live");
    expect(app.overlay.setStatusText).toHaveBeenCalledWith("Translating");
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({ running: true, paused: false }),
    );
  });

  it("re-anchors standardDubSync on Standard resume", async () => {
    const sess = makeWebRtcSession(2);
    (sess as unknown as { pipeline: string }).pipeline = "standard";
    const app = makeFakeApp(sess);
    app.lifecycle.pause("user");
    await resumeSession(app);

    expect(app.standardDubSync.snapPlaybackStart).toHaveBeenCalledTimes(1);
    expect(app.standardDubSync.start).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — no-op when not paused", async () => {
    const sess = makeWebRtcSession(3);
    const app = makeFakeApp(sess);
    // not paused (default state — no reason on the stack)
    await resumeSession(app);

    expect(app.overlay.setOverlayState).not.toHaveBeenCalled();
  });

  it("connectionLost=true → attempts webrtc.continueOnNewVideo rebuild (ok → live)", async () => {
    const sess = makeWebRtcSession(4);
    const app = makeFakeApp(sess);
    app.lifecycle.pause("user");
    app.lifecycle.pause("connection-lost");
    app.sm.settings = {
      apiBearer: "b",
      targetLanguage: "vi",
    } as Parameters<typeof resumeSession>[0]["sm"]["settings"];
    app.webrtc.continueOnNewVideo.mockResolvedValueOnce({ ok: true });

    void resumeSession(app);

    // Allow the promise to resolve
    await vi.runAllTimersAsync();

    expect(app.webrtc.continueOnNewVideo).toHaveBeenCalledTimes(1);
    expect(app.sm.connectionLost).toBe(false);
    expect(app.sm.userPaused).toBe(false);
  });

  it("connectionLost=true → continueOnNewVideo fails → stopSession(CONNECTION_LOST)", async () => {
    const sess = makeWebRtcSession(5);
    const app = makeFakeApp(sess);
    app.lifecycle.pause("user");
    app.lifecycle.pause("connection-lost");
    app.sm.settings = {
      apiBearer: "b",
      targetLanguage: "vi",
    } as Parameters<typeof resumeSession>[0]["sm"]["settings"];
    app.webrtc.continueOnNewVideo.mockResolvedValueOnce({ ok: false, error: "WebRTC failed." });

    void resumeSession(app);
    await vi.runAllTimersAsync();

    expect(app.stopSession).toHaveBeenCalledWith(STOP_REASON.CONNECTION_LOST);
  });

  // ── Resume is NON-BLOCKING (regression fix): no video hold, no dub-buffer gate ──

  it("Standard-WebRTC resume: re-anchors + restarts the drift engine WITHOUT a waitForFirstDub hold", () => {
    const sess = makeWebRtcSession(10);
    (sess as unknown as { pipeline: string }).pipeline = "standard";
    const app = makeFakeApp(sess);
    app.lifecycle.pause("user");

    const fakeVideo = {
      paused: false,
      play: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(),
    } as unknown as HTMLVideoElement;
    app.capture.videoEl = fakeVideo;

    resumeSession(app);

    // The drift corrector is re-anchored + restarted (snapPlaybackStart resets
    // stopped=false so it actually ticks again — the genuine bug fix we keep).
    expect(app.standardDubSync.snapPlaybackStart).toHaveBeenCalledTimes(1);
    expect(app.standardDubSync.start).toHaveBeenCalledTimes(1);
    // NO dub-buffer gate on resume (that froze the video — the regression).
    expect(app.standardDubSync.waitForFirstDub).not.toHaveBeenCalled();
    // The video is NEVER re-paused on resume.
    expect(fakeVideo.pause).not.toHaveBeenCalled();
    // userPaused cleared, overlay → live (no "buffering" churn on resume).
    expect(app.sm.userPaused).toBe(false);
    expect(app.overlay.setOverlayState).toHaveBeenCalledWith("live");
    expect(app.overlay.setOverlayState).not.toHaveBeenCalledWith("buffering");
  });

  it("Realtime resume: fires media-resume in the background and goes live immediately (no settle sleep, no hold)", () => {
    const sess = makeWebRtcSession(12);
    expect(sess.pipeline).toBe("realtime");
    const app = makeFakeApp(sess);
    app.lifecycle.pause("user");

    const fakeVideo = {
      paused: false,
      play: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(),
    } as unknown as HTMLVideoElement;
    app.capture.videoEl = fakeVideo;

    // Synchronous return = no awaited server round-trip / settle on the resume path.
    resumeSession(app);

    expect(app.sm.userPaused).toBe(false);
    expect(fakeVideo.pause).not.toHaveBeenCalled();
    expect(app.overlay.setOverlayState).toHaveBeenCalledWith("live");
    expect(app.overlay.setOverlayState).not.toHaveBeenCalledWith("buffering");
  });

  it("subtitle-first resume: no proactive micro-pause — just clears userPaused + goes live", () => {
    const sess = { kind: "subtitle-first" } as unknown as ReturnType<typeof makeWebRtcSession>;
    const app = makeFakeApp(sess);
    app.lifecycle.pause("user");

    resumeSession(app);

    // The old wave called onResumeCheck (which could re-pause); we no longer do.
    expect(app.subtitleFirst.onResumeCheck).not.toHaveBeenCalled();
    expect(app.sm.userPaused).toBe(false);
    expect(app.overlay.setOverlayState).toHaveBeenCalledWith("live");
    expect(app.overlay.setOverlayState).not.toHaveBeenCalledWith("buffering");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. SessionManager.pauseSessionTimer / resumeSessionTimer (timer freeze/thaw)
// ─────────────────────────────────────────────────────────────────────────────

describe("SessionManager — timer freeze/thaw", () => {
  let sm: SessionManager;

  beforeEach(() => {
    installChrome();
    vi.useFakeTimers();
    sm = new SessionManager();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    uninstallChrome();
  });

  it("limit timer fires at SESSION_LIMIT_MS when not paused", async () => {
    const onLimit = vi.fn();
    const onWarning = vi.fn();
    // We don't need the exact constant value — use 1000ms for a fast test.
    const LIMIT_MS = 1000;
    const WARN_MS = 800;
    // Override the timeout via direct setTimeout (simulating startSessionTimer)
    sm["_onWarning"] = onWarning;
    sm["_onLimit"] = onLimit;
    sm["_warningDeadline"] = Date.now() + WARN_MS;
    sm["_limitDeadline"] = Date.now() + LIMIT_MS;
    sm.warningTimer = setTimeout(() => { sm.warningShown = true; onWarning(); }, WARN_MS);
    sm.limitTimer = setTimeout(() => { onLimit(); }, LIMIT_MS);

    await vi.advanceTimersByTimeAsync(LIMIT_MS + 1);
    expect(onLimit).toHaveBeenCalledTimes(1);
  });

  it("pauseSessionTimer freezes: advance far past limit while paused → limit NOT fired", async () => {
    const onLimit = vi.fn();
    const onWarning = vi.fn();
    const LIMIT_MS = 1000;
    const WARN_MS = 800;
    sm["_onWarning"] = onWarning;
    sm["_onLimit"] = onLimit;
    sm["_warningDeadline"] = Date.now() + WARN_MS;
    sm["_limitDeadline"] = Date.now() + LIMIT_MS;
    sm.warningTimer = setTimeout(() => { sm.warningShown = true; onWarning(); }, WARN_MS);
    sm.limitTimer = setTimeout(() => { onLimit(); }, LIMIT_MS);

    // Pause partway through
    await vi.advanceTimersByTimeAsync(500);
    sm.pauseSessionTimer();

    // Advance 10× the remaining time while paused
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onLimit).not.toHaveBeenCalled();
  });

  it("resumeSessionTimer re-arms: after resume, fires at ~remaining from pause point", async () => {
    const onLimit = vi.fn();
    const onWarning = vi.fn();
    const LIMIT_MS = 1000;
    const WARN_MS = 800;
    sm["_onWarning"] = onWarning;
    sm["_onLimit"] = onLimit;
    sm["_warningDeadline"] = Date.now() + WARN_MS;
    sm["_limitDeadline"] = Date.now() + LIMIT_MS;
    sm.warningTimer = setTimeout(() => { sm.warningShown = true; onWarning(); }, WARN_MS);
    sm.limitTimer = setTimeout(() => { onLimit(); }, LIMIT_MS);

    // Pause at 400ms (600ms remaining)
    await vi.advanceTimersByTimeAsync(400);
    sm.pauseSessionTimer();

    // Paused for 5000ms
    await vi.advanceTimersByTimeAsync(5000);
    expect(onLimit).not.toHaveBeenCalled();

    // Resume — limit should fire after ~600ms
    sm.resumeSessionTimer();
    await vi.advanceTimersByTimeAsync(590);
    expect(onLimit).not.toHaveBeenCalled(); // not yet
    await vi.advanceTimersByTimeAsync(20);
    expect(onLimit).toHaveBeenCalledTimes(1);
  });

  it("warning timer is also frozen/re-armed across a pause", async () => {
    const onLimit = vi.fn();
    const onWarning = vi.fn();
    const LIMIT_MS = 1000;
    const WARN_MS = 500;
    sm["_onWarning"] = onWarning;
    sm["_onLimit"] = onLimit;
    sm["_warningDeadline"] = Date.now() + WARN_MS;
    sm["_limitDeadline"] = Date.now() + LIMIT_MS;
    sm.warningTimer = setTimeout(() => { sm.warningShown = true; onWarning(); }, WARN_MS);
    sm.limitTimer = setTimeout(() => { onLimit(); }, LIMIT_MS);

    // Pause at 200ms
    await vi.advanceTimersByTimeAsync(200);
    sm.pauseSessionTimer();

    // Advance far past warn deadline while paused
    await vi.advanceTimersByTimeAsync(5000);
    expect(onWarning).not.toHaveBeenCalled();

    // Resume — warning fires after ~300ms
    sm.resumeSessionTimer();
    await vi.advanceTimersByTimeAsync(290);
    expect(onWarning).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    expect(onWarning).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. NavigationWatcher — classify / debounce / pending-next
// ─────────────────────────────────────────────────────────────────────────────

describe("NavigationWatcher", () => {
  let originalHref: string;

  function setHref(url: string) {
    Object.defineProperty(window, "location", {
      value: { href: url },
      writable: true,
      configurable: true,
    });
  }

  function makeWatcherApp(
    currentHref = "https://www.youtube.com/watch?v=abc123",
  ) {
    setHref(currentHref);
    const sm = { session: { token: 1 } as WebRtcSession };
    const adapter = {
      id: "youtube",
      isWatchUrl: (url: string) => url.includes("/watch"),
      getVideoId: (url: string) => {
        const m = url.match(/[?&]v=([^&]+)/);
        return m ? m[1]! : null;
      },
    };
    const fakeApp = { sm, adapter } as unknown as import("@/content/index").ContentApp;
    return fakeApp;
  }

  beforeEach(() => {
    installChrome();
    vi.useFakeTimers();
    originalHref = "https://www.youtube.com/watch?v=abc123";
    setHref(originalHref);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    uninstallChrome();
    setHref(originalHref);
  });

  it("non-watch URL → emits {stop, SPA_NAVIGATION} immediately", async () => {
    const app = makeWatcherApp();
    const watcher = new NavigationWatcher(app);
    const events: import("@/content/navigation").NavEvent[] = [];
    watcher.start((e) => events.push(e));

    setHref("https://www.youtube.com/");
    await vi.advanceTimersByTimeAsync(600); // past poll interval

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ kind: "stop", reason: STOP_REASON.SPA_NAVIGATION });
    watcher.stop();
  });

  it("watch URL with new videoId → emits {continue, videoId} after 700ms debounce", async () => {
    const app = makeWatcherApp("https://www.youtube.com/watch?v=abc123");
    const watcher = new NavigationWatcher(app);
    const events: import("@/content/navigation").NavEvent[] = [];
    watcher.start((e) => events.push(e));

    setHref("https://www.youtube.com/watch?v=def456");
    // Poll fires at 500ms → sees URL change → starts 700ms debounce.
    // Debounce fires at 500+700=1200ms. Advance past 1200ms.
    await vi.advanceTimersByTimeAsync(500); // poll fired, debounce started
    expect(events).toHaveLength(0); // still debouncing

    await vi.advanceTimersByTimeAsync(750); // total 1250ms — debounce has fired
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ kind: "continue", videoId: "def456" });
    watcher.stop();
  });

  it("rapid navigations within 700ms coalesce to the final videoId", async () => {
    const app = makeWatcherApp("https://www.youtube.com/watch?v=abc123");
    const watcher = new NavigationWatcher(app);
    const events: import("@/content/navigation").NavEvent[] = [];
    watcher.start((e) => events.push(e));

    // Three rapid changes
    setHref("https://www.youtube.com/watch?v=v1");
    await vi.advanceTimersByTimeAsync(200);
    setHref("https://www.youtube.com/watch?v=v2");
    await vi.advanceTimersByTimeAsync(200);
    setHref("https://www.youtube.com/watch?v=v3");
    await vi.advanceTimersByTimeAsync(800); // debounce settles on v3

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ kind: "continue", videoId: "v3" });
    watcher.stop();
  });

  it("notifyEnded keeps the session alive for ~45s then emits {stop, VIDEO_ENDED} if no nav", async () => {
    // Stage B: `ended` is NO LONGER an 8s teardown. notifyEnded arms a LONG
    // terminal-idle window (~45s) and ONLY stops if no navigation arrives AND a
    // session is still alive. The session must NOT be torn down early.
    const app = makeWatcherApp();
    const watcher = new NavigationWatcher(app);
    const events: import("@/content/navigation").NavEvent[] = [];
    watcher.start((e) => events.push(e));

    watcher.notifyEnded();
    // Well past the OLD 8s window — the session must STILL be alive (no stop).
    await vi.advanceTimersByTimeAsync(9000);
    expect(events).toHaveLength(0);
    // Just before the 45s terminal-idle deadline — still alive.
    await vi.advanceTimersByTimeAsync(35_999);
    expect(events).toHaveLength(0);
    // Terminal-idle deadline crosses 45s with no navigation → terminal stop.
    await vi.advanceTimersByTimeAsync(5);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ kind: "stop", reason: STOP_REASON.VIDEO_ENDED });
    watcher.stop();
  });

  it("video-end then auto-advance: session stays alive, {continue} fires WITHOUT depending on 'ended'", async () => {
    // The core Stage-B acceptance case (SOLUTION §1 + §7.1). The source video
    // reports `ended`, then YouTube autoplays the next video (URL flips). The
    // watcher must keep the session alive and emit {continue} for the new
    // videoId — NOT a {stop} — even though the 8s legacy window is long gone.
    const app = makeWatcherApp("https://www.youtube.com/watch?v=abc123");
    const watcher = new NavigationWatcher(app);
    const events: import("@/content/navigation").NavEvent[] = [];
    watcher.start((e) => events.push(e));

    // 1) Video ends — watcher arms the long terminal-idle window, stays alive.
    watcher.notifyEnded();
    // Let plenty of time pass (past the old 8s window) BEFORE the navigation.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events).toHaveLength(0); // session still alive, no stop

    // 2) YouTube auto-advances to the next video (URL flips, no further 'ended').
    setHref("https://www.youtube.com/watch?v=next777");
    // Poll fires at +500ms → 700ms debounce → settles at +1200ms.
    await vi.advanceTimersByTimeAsync(1300);

    // The auto-advance is detected by URL change alone → {continue}, no stop.
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ kind: "continue", videoId: "next777" });

    // 3) The terminal-idle timer must NOT fire a late stop — it was resolved.
    await vi.advanceTimersByTimeAsync(45_000);
    expect(events).toHaveLength(1);
    watcher.stop();
  });

  it("notifyEnded then a qualifying nav cancels the terminal-idle window (no double stop)", async () => {
    const app = makeWatcherApp("https://www.youtube.com/watch?v=abc123");
    const watcher = new NavigationWatcher(app);
    const events: import("@/content/navigation").NavEvent[] = [];
    watcher.start((e) => events.push(e));

    watcher.notifyEnded(); // pending-next armed (8s timer)

    // Navigate to a new video within the 8s window.
    // Poll fires at 500ms → debounce starts → fires at 500+700=1200ms.
    setHref("https://www.youtube.com/watch?v=next999");
    await vi.advanceTimersByTimeAsync(1300); // past debounce settle (1200ms)

    // Should have exactly one continue event, no stop
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ kind: "continue", videoId: "next999" });

    // Let the 8s timer expire — should NOT emit another stop (cleared by the nav)
    await vi.advanceTimersByTimeAsync(8000);
    expect(events).toHaveLength(1);
    watcher.stop();
  });

  it("stop() clears all timers — no late emit after stop()", async () => {
    const app = makeWatcherApp("https://www.youtube.com/watch?v=abc123");
    const watcher = new NavigationWatcher(app);
    const events: import("@/content/navigation").NavEvent[] = [];
    watcher.start((e) => events.push(e));

    watcher.notifyEnded();
    watcher.stop();

    // Advance past both pending-next and debounce timeouts
    await vi.advanceTimersByTimeAsync(20_000);
    expect(events).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. auto-next GAP-1 regression — success block runs after restart bumps pageToken
// ─────────────────────────────────────────────────────────────────────────────

describe("auto-next — GAP-1 regression: success block reachable after pageToken bump", () => {
  // We import the live module. The vi.mock() calls at the top of the file mock
  // the pipelines, so subtitleFirst.restart is a vi.fn() that returns {ok:true}
  // and also bumps sm.pageToken (simulating the real restart internals).
  // The point: even though pageToken changes inside restart(), the overlay MUST
  // still transition to "live" because the generation guard (myGen/activeGen)
  // is independent of pageToken.

  let ContentApp: typeof import("@/content/index").ContentApp;

  beforeEach(async () => {
    installChrome();
    vi.useFakeTimers();
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
    // Dynamic import so all mocks have been registered first
    ({ ContentApp } = await import("@/content/index"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    uninstallChrome();
    vi.resetModules();
  });

  it("overlay transitions to 'live' even when restart() bumps sm.pageToken internally", async () => {
    const app = new ContentApp();
    // Stub the Stage-C AdWatcher arm so its 250ms poll setInterval doesn't run
    // forever under vi.runAllTimersAsync() (the watcher is re-armed on the
    // auto-next success path; its own behavior is tested in ad-watcher.test.ts).
    app.startAdWatcher = vi.fn();

    // Set up a running subtitle-first session
    const sfSess: SubtitleFirstSession = {
      kind: "subtitle-first",
      token: 1,
      pc: null,
      dc: null,
      stream: null,
      remoteAudio: null,
      audioCtx: { state: "running" } as AudioContext,
      outputGain: null,
      rtcSessionId: null,
      apiBearer: "b",
      abortController: new AbortController(),
      sentences: [],
      translations: [],
      currentSource: null,
      currentPlayingIdx: null,
      playbackTimer: null,
      renderCursor: 0,
      rollingInFlight: false,
      stopFlag: false,
      _batchRequestIds: new Map(),
      _sentBatchRanges: new Map(),
      _renderEpoch: 0,
      _pendingLines: new Set(),
      _pendingFirstQueuedAt: 0,
    };
    app.sm.session = sfSess;
    app.sm.pageToken = 1;
    app.sm.settings = {
      apiBearer: "b",
      targetLanguage: "vi",
      tier: "standard",
    } as unknown as Parameters<typeof pauseSession>[0]["sm"]["settings"];

    // Make adapter report a YouTube-like watch URL with a stable videoId
    app.adapter = {
      id: "youtube",
      capabilities: { subtitleFirst: true, audioCapture: true },
      isWatchUrl: () => true,
      getVideoId: () => "next-video",
      findVideo: () => {
        // Return a fake video element that passes the ready check
        const v = document.createElement("video");
        Object.defineProperty(v, "readyState", { value: 3, configurable: true });
        Object.defineProperty(v, "currentTime", { value: 1, configurable: true });
        return v;
      },
    } as unknown as typeof app.adapter;

    app.capture.isLive = vi.fn().mockReturnValue(false);
    app.capture.bindVolumeDriftGuard = vi.fn();

    // subtitleFirst.restart resolves ok=true AND bumps pageToken (the real implementation
    // calls sm.nextToken() internally via the new token assignment)
    (app.subtitleFirst.restart as Mock).mockImplementationOnce(async () => {
      // Simulate what the real restart() does: bump sm.pageToken
      app.sm.nextToken();
      return { ok: true };
    });

    // bindCommonVideoListeners must exist
    app.bindCommonVideoListeners = vi.fn();

    const { continueOnNewVideo } = await import("@/content/auto-next");
    const promise = continueOnNewVideo(app, "next-video");
    await vi.runAllTimersAsync();
    await promise;

    // KEY ASSERTION: overlay must have received setOverlayState("live")
    expect(app.overlay.setOverlayState).toHaveBeenCalledWith("live");
    expect(app.overlay.setStatusText).toHaveBeenCalledWith("Translating");
  });

  it("ad-aware ready-poll: a long pre-roll between videos does NOT fail as NEXT_VIDEO_LOAD_FAILED", async () => {
    const app = new ContentApp();
    // Stub the AdWatcher arm — see note above (avoids a perpetual poll interval).
    app.startAdWatcher = vi.fn();

    const sfSess: SubtitleFirstSession = {
      kind: "subtitle-first",
      token: 1,
      pc: null,
      dc: null,
      stream: null,
      remoteAudio: null,
      audioCtx: { state: "running" } as AudioContext,
      outputGain: null,
      rtcSessionId: null,
      apiBearer: "b",
      abortController: new AbortController(),
      sentences: [],
      translations: [],
      currentSource: null,
      currentPlayingIdx: null,
      playbackTimer: null,
      renderCursor: 0,
      rollingInFlight: false,
      stopFlag: false,
      _batchRequestIds: new Map(),
      _sentBatchRanges: new Map(),
      _renderEpoch: 0,
      _pendingLines: new Set(),
      _pendingFirstQueuedAt: 0,
    };
    app.sm.session = sfSess;
    app.sm.pageToken = 1;
    app.sm.settings = {
      apiBearer: "b",
      targetLanguage: "vi",
      tier: "standard",
    } as unknown as Parameters<typeof pauseSession>[0]["sm"]["settings"];

    // The video is "ready" by readyState/currentTime the whole time, but an AD is
    // playing for the first ~14s (shouldIgnorePlaybackEvent → true). The poll must
    // KEEP waiting (not fail at 9s) until the ad clears, then succeed.
    const readyVideo = document.createElement("video");
    Object.defineProperty(readyVideo, "readyState", { value: 3, configurable: true });
    Object.defineProperty(readyVideo, "currentTime", { value: 1, configurable: true });

    let adPlaying = true;
    app.adapter = {
      id: "youtube",
      capabilities: { subtitleFirst: true, audioCapture: true },
      isWatchUrl: () => true,
      getVideoId: () => "next-video",
      findVideo: () => readyVideo,
      // shouldIgnorePlaybackEvent gates shouldIgnoreSourcePlaybackEvent → "ad".
      shouldIgnorePlaybackEvent: () => adPlaying,
    } as unknown as typeof app.adapter;

    app.capture.isLive = vi.fn().mockReturnValue(false);
    app.capture.bindVolumeDriftGuard = vi.fn();
    app.capture.findVideo = vi.fn().mockReturnValue(readyVideo);
    app.bindCommonVideoListeners = vi.fn();

    (app.subtitleFirst.restart as Mock).mockResolvedValue({ ok: true });

    // Clear the ad ~14s in — PAST the 9s base budget, so the OLD logic would have
    // failed. The ad-aware loop keeps polling because adPlaying is still true.
    setTimeout(() => {
      adPlaying = false;
    }, 14_000);

    const { continueOnNewVideo } = await import("@/content/auto-next");
    const promise = continueOnNewVideo(app, "next-video");
    await vi.runAllTimersAsync();
    await promise;

    // Did NOT fail — restart ran and the overlay went live.
    expect(app.subtitleFirst.restart).toHaveBeenCalledTimes(1);
    expect(app.overlay.setOverlayState).toHaveBeenCalledWith("live");
    expect(app.overlay.setOverlayState).not.toHaveBeenCalledWith("idle");
  });

  it("ad-aware ready-poll: a video that never becomes ready DOES fail at the absolute cap", async () => {
    const app = new ContentApp();

    const sfSess: SubtitleFirstSession = {
      kind: "subtitle-first",
      token: 1,
      pc: null, dc: null, stream: null, remoteAudio: null,
      audioCtx: { state: "running" } as AudioContext,
      outputGain: null, rtcSessionId: null, apiBearer: "b",
      abortController: new AbortController(),
      sentences: [], translations: [], currentSource: null, currentPlayingIdx: null,
      playbackTimer: null, renderCursor: 0, rollingInFlight: false, stopFlag: false,
      _batchRequestIds: new Map(),
      _sentBatchRanges: new Map(),
      _renderEpoch: 0,
      _pendingLines: new Set(),
      _pendingFirstQueuedAt: 0,
    };
    app.sm.session = sfSess;
    app.sm.pageToken = 1;
    app.sm.settings = {
      apiBearer: "b", targetLanguage: "vi", tier: "standard",
    } as unknown as Parameters<typeof pauseSession>[0]["sm"]["settings"];

    // Ad never clears AND no playable video → must fail at the ~60s absolute cap.
    app.adapter = {
      id: "youtube",
      capabilities: { subtitleFirst: true, audioCapture: true },
      isWatchUrl: () => true,
      getVideoId: () => "next-video",
      findVideo: () => null,
      shouldIgnorePlaybackEvent: () => true, // ad forever
    } as unknown as typeof app.adapter;
    app.capture.isLive = vi.fn().mockReturnValue(false);
    app.capture.findVideo = vi.fn().mockReturnValue(null);
    const stopSpy = vi.spyOn(app, "stopSession");

    const { continueOnNewVideo } = await import("@/content/auto-next");
    const promise = continueOnNewVideo(app, "next-video");
    await vi.runAllTimersAsync();
    await promise;

    expect(stopSpy).toHaveBeenCalledWith(STOP_REASON.NEXT_VIDEO_LOAD_FAILED);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. subtitle-first.restart — eviction side-effects
// ─────────────────────────────────────────────────────────────────────────────

describe("SubtitleFirstPipeline.restart — old driver eviction", () => {
  // We test the eviction side-effects by using vi.importActual() to get the
  // REAL SubtitleFirstPipeline (bypassing the vi.mock() at the top of this file).
  // The real restart() evicts the old session synchronously before the async
  // caption fetch, so we can assert eviction state before the fetch resolves.

  beforeEach(() => {
    installChrome();
    vi.useFakeTimers();
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    uninstallChrome();
  });

  it("sets old session stopFlag=true and clears playbackTimer on restart", async () => {
    // Get the REAL SubtitleFirstPipeline module (not the mock at the top of this file).
    const { SubtitleFirstPipeline: RealSFP } = await vi.importActual<
      typeof import("@/content/pipelines/subtitle-first-pipeline")
    >("@/content/pipelines/subtitle-first-pipeline");

    const sm = new SessionManager();
    const lifecycle = new LifecycleController();
    sm.lifecycle = lifecycle;
    const overlay = {
      setStatusText: vi.fn(),
      setOverlayState: vi.fn(),
      buildOverlay: vi.fn(),
      syncFromSettings: vi.fn(),
      removeOverlay: vi.fn(),
      showToast: vi.fn(),
      applySourceVisibility: vi.fn(),
      applyCaptionOnVideo: vi.fn(),
    };
    const fetchCaptionsMock = vi.fn().mockResolvedValue(null); // null → no captions
    // Provide a minimal fake video element so restart() doesn't null-out sm.session
    // at the "No playable video" guard (before the caption fetch).
    const fakeVideo = document.createElement("video");
    const adapter = {
      id: "youtube",
      capabilities: { subtitleFirst: true, audioCapture: true },
      isWatchUrl: () => true,
      getVideoId: () => "next-v",
      findVideo: () => fakeVideo,
      fetchCaptions: fetchCaptionsMock,
      getVideoTitle: () => null,
    };
    const capture = { findVideo: vi.fn().mockReturnValue(null), videoEl: null };
    const fakeApp = { sm, lifecycle, overlay, adapter, capture } as unknown as ContentApp;

    const pipeline = new RealSFP(fakeApp);

    // Build an old session that is currently "running" (has a live playbackTimer)
    const timerHandle = setInterval(() => {}, 250) as ReturnType<typeof setInterval>;
    const oldSess: SubtitleFirstSession = {
      kind: "subtitle-first",
      token: 1,
      pc: null,
      dc: null,
      stream: null,
      remoteAudio: null,
      audioCtx: { state: "running", createGain: vi.fn(), close: vi.fn() } as unknown as AudioContext,
      outputGain: { gain: { value: 1 } } as unknown as GainNode,
      rtcSessionId: null,
      apiBearer: "b",
      abortController: new AbortController(),
      sentences: [],
      translations: [],
      currentSource: null,
      currentPlayingIdx: null,
      playbackTimer: timerHandle,
      renderCursor: 0,
      rollingInFlight: false,
      stopFlag: false,
      _batchRequestIds: new Map(),
      _sentBatchRanges: new Map(),
      _renderEpoch: 0,
      _pendingLines: new Set(),
      _pendingFirstQueuedAt: 0,
    };
    sm.session = oldSess;
    sm.pageToken = 1;

    const settings = { apiBearer: "b", targetLanguage: "vi" } as unknown as import("@/shared/types").StartSettings;

    // Call restart — eviction runs synchronously at the top of restart() before
    // the async caption fetch. We await the full promise; fetchCaptions returns
    // null so restart returns {ok:false} without starting the rolling renderer.
    const result = await pipeline.restart(settings, "next-v");

    // ── Eviction assertions ────────────────────────────────────────────────
    expect(oldSess.stopFlag).toBe(true);
    expect(oldSess.playbackTimer).toBeNull();

    // sm.session must be a DIFFERENT object (the fresh session built by restart)
    expect(sm.session).not.toBe(oldSess);
    expect(sm.session?.kind).toBe("subtitle-first");

    // restart returned ok:false because fetchCaptions returned null (no captions)
    expect(result.ok).toBe(false);
  });
});
