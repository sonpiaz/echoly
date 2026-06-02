// @vitest-environment jsdom
//
// AC#12 — stopSession drain BRANCHING integration test.
//
// SOLUTION §3.2a specifies:
//   • stopSession(VIDEO_ENDED) on a WebRTC session → DEFERS remoteAudio teardown
//     via drainRemoteAudio (remoteAudio is NOT torn down until RTC_DRAIN_TIMEOUT_MS).
//   • stopSession(<any other reason>) on a WebRTC session → cuts IMMEDIATELY
//     (remoteAudio.pause() called synchronously; no drain).
//
// This test constructs a real ContentApp instance (mocking only the module
// boundaries that touch the DOM / chrome extension APIs / native build) and
// exercises the stopSession code path at the remoteAudio teardown branch.
//
// We spy on drainRemoteAudio to assert defer vs immediate-cut. Fake timers
// confirm that the deferred path does NOT call remoteAudio.pause() until the
// drain window has elapsed.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WebRtcSession } from "@/content/session-manager";
import { STOP_REASON, type StopReason } from "@/content/stop-reasons";
import { RTC_DRAIN_TIMEOUT_MS } from "@/lib/rtc-handover";

// ─── Mock heavy module-level side-effects so ContentApp can be constructed ───

// overlay/overlay: createOverlay() is called in the ContentApp constructor.
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

// platforms/registry: detectAdapter() is called in constructor and startSession.
vi.mock("@/platforms/registry", () => ({
  detectAdapter: () => ({
    id: "generic",
    capabilities: { audioCapture: true, subtitleFirst: false, isSpa: false, hasNativeCaptions: false, hasAdOverlays: false },
    matchesHost: () => false,
    isWatchUrl: () => false,
    getVideoId: () => null,
    findVideo: () => null,
    stageInsets: () => ({ top: 44, bottom: 56, side: 16 }),
    fetchCaptions: async () => null,
    readLiveCaptionText: () => null,
  }),
}));

// media-stage: setActiveAdapter is called during stopSession teardown.
vi.mock("@/content/media-stage", () => ({
  setActiveAdapter: vi.fn(),
  findPrimaryVideo: vi.fn().mockReturnValue(null),
  getActiveAdapter: vi.fn().mockReturnValue(null),
}));

// controller: createController is called in constructor.
vi.mock("@/content/controller", () => ({
  createController: () => ({}),
}));

// capture: AudioCapture constructor side-effects.
vi.mock("@/content/capture", () => ({
  AudioCapture: class {
    videoEl = null;
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

// webrtc-pipeline: WebRtcPipeline constructor.
vi.mock("@/content/pipelines/webrtc-pipeline", () => ({
  WebRtcPipeline: class {
    buildSession = vi.fn();
    requestHandover = vi.fn();
  },
}));

// subtitle-first-pipeline: SubtitleFirstPipeline constructor.
vi.mock("@/content/pipelines/subtitle-first-pipeline", () => ({
  SubtitleFirstPipeline: class {
    start = vi.fn();
  },
}));

// Spy on drainRemoteAudio — but allow it to run so we can test timing too.
import * as rtcHandover from "@/lib/rtc-handover";

// ContentApp import MUST come AFTER all vi.mock() calls.
import { ContentApp } from "@/content/index";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeFakeRemoteAudio() {
  return {
    pause: vi.fn(),
    remove: vi.fn(),
    srcObject: {} as MediaStream | null,
    play: vi.fn().mockResolvedValue(undefined),
  } as unknown as HTMLAudioElement;
}

function makeWebRtcSession(token: number): WebRtcSession {
  return {
    kind: undefined, // isWebRtcSession checks kind !== "subtitle-first"
    token,
    pipeline: "realtime",
    targetLanguage: "vi",
    voice: "marin",
    pc: null,
    dc: null,
    stream: null,
    remoteAudio: makeFakeRemoteAudio(),
    audioCtx: null,
    outputGain: null,
    rtcSessionId: null,
    apiBearer: "test-bearer",
  } as WebRtcSession;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ContentApp.stopSession — drain BRANCHING (AC#12)", () => {
  let app: ContentApp;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let drainSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    // Install chrome mock (SessionManager.notifyBackground uses chrome.runtime).
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { id: "test", sendMessage: vi.fn().mockResolvedValue(undefined) },
    };
    app = new ContentApp();
    drainSpy = vi.spyOn(rtcHandover, "drainRemoteAudio") as ReturnType<typeof vi.fn>;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    (globalThis as { chrome?: unknown }).chrome = undefined;
  });

  // ─────────────────────────────────────────────────────────────────────────
  // AC#12(a): VIDEO_ENDED → DEFER teardown — drainRemoteAudio called; remoteAudio
  // is NOT paused/removed until RTC_DRAIN_TIMEOUT_MS has elapsed.
  // ─────────────────────────────────────────────────────────────────────────

  it("AC#12(a): VIDEO_ENDED defers WebRTC remoteAudio teardown — not torn down until drain timeout", async () => {
    const session = makeWebRtcSession(1);
    const remoteAudio = session.remoteAudio!;
    app.sm.session = session;
    app.sm.pageToken = 1;

    // stopSession(VIDEO_ENDED) — should call drainRemoteAudio, NOT remoteAudio.pause().
    app.stopSession(STOP_REASON.VIDEO_ENDED);

    // drainRemoteAudio must have been called.
    expect(drainSpy).toHaveBeenCalledTimes(1);
    expect(drainSpy).toHaveBeenCalledWith(remoteAudio, RTC_DRAIN_TIMEOUT_MS);

    // Immediately after stopSession: audio still playing (no pause yet).
    expect(remoteAudio.pause).not.toHaveBeenCalled();
    expect(remoteAudio.remove).not.toHaveBeenCalled();

    // Before the drain timeout elapses: still no teardown.
    await vi.advanceTimersByTimeAsync(RTC_DRAIN_TIMEOUT_MS - 1);
    expect(remoteAudio.pause).not.toHaveBeenCalled();

    // After the drain timeout: teardown fires.
    await vi.advanceTimersByTimeAsync(1);
    expect(remoteAudio.pause).toHaveBeenCalledTimes(1);
    expect(remoteAudio.remove).toHaveBeenCalledTimes(1);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // AC#12(b): user STOP → IMMEDIATE cut — drainRemoteAudio NOT called;
  // remoteAudio.pause() fired synchronously inside stopSession.
  // ─────────────────────────────────────────────────────────────────────────

  it("AC#12(b): user STOP cuts WebRTC remoteAudio immediately — no drain", () => {
    const session = makeWebRtcSession(2);
    const remoteAudio = session.remoteAudio!;
    app.sm.session = session;
    app.sm.pageToken = 2;

    app.stopSession(STOP_REASON.USER_STOP);

    // No drain — immediate teardown.
    expect(drainSpy).not.toHaveBeenCalled();
    expect(remoteAudio.pause).toHaveBeenCalledTimes(1);
    expect(remoteAudio.remove).toHaveBeenCalledTimes(1);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // AC#12(c): CONNECTION_LOST → IMMEDIATE cut (not drain).
  // The drain test is reason-agnostic for non-VIDEO_ENDED reasons; CONNECTION_LOST
  // is a representative non-VIDEO_ENDED reason that exercises the immediate path.
  // ─────────────────────────────────────────────────────────────────────────

  it("AC#12(c): CONNECTION_LOST cuts immediately — no drain", () => {
    const session = makeWebRtcSession(3);
    const remoteAudio = session.remoteAudio!;
    app.sm.session = session;
    app.sm.pageToken = 3;

    app.stopSession(STOP_REASON.CONNECTION_LOST);

    expect(drainSpy).not.toHaveBeenCalled();
    expect(remoteAudio.pause).toHaveBeenCalledTimes(1);
    expect(remoteAudio.remove).toHaveBeenCalledTimes(1);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Sanity: RTC_DRAIN_TIMEOUT_MS constant is 600ms (contract check).
  // ─────────────────────────────────────────────────────────────────────────

  it("RTC_DRAIN_TIMEOUT_MS is 600 (contract)", () => {
    expect(RTC_DRAIN_TIMEOUT_MS).toBe(600);
  });
});
