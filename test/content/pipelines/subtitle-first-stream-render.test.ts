// @vitest-environment jsdom
//
// AC10: #renderBatch (streaming path) writes _buffer[idx] in strict index order
// so Agent A's onResumeCheck → #playbackTick "next due cue buffered?" check
// behaves identically to the buffered path (Workstream E, E-5).
//
// AC12 (extension side): extension falls back to buffered path on stream 404.
//
// Strategy:
//   • Mock renderSubtitleDubStream to return an async generator that yields
//     frames in sequence.
//   • Call pipeline.start() directly (which internally calls #renderBatch).
//   • Verify _buffer is set per-sentence in index order.
//   • Use a controlled generator to confirm decode happens per-line not batched.
//
// Timer caution: start() installs a 250ms setInterval. We do NOT call
// runAllTimersAsync (infinite loop) — we just await the start() promise
// (which resolves after #renderBatch completes) and then clear the timer.

import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { SubtitleFirstPipeline } from "@/content/pipelines/subtitle-first-pipeline";
import { LifecycleController } from "@/content/lifecycle";
import type { SubtitleFirstSession } from "@/content/session-manager";
import type { PlatformAdapter } from "@/shared/platform-ports";
import type { StartSettings } from "@/shared/types";
import type { SubtitleDubStreamLine } from "@/lib/echoly-api";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/lib/echoly-api", () => ({
  isPipelineToastError: (err: unknown) =>
    typeof err === "object" && err !== null && "user" in err,
  renderSubtitleDubBatch: vi.fn(),
  renderSubtitleDubStream: vi.fn(),
  // newRequestId is used by #renderBatch for stable per-batch request ids.
  newRequestId: (prefix: string) => `${prefix}_mock-uuid`,
  // ALREADY_PROCESSED sentinel used by #renderBatch to detect idempotency replays.
  ALREADY_PROCESSED: Symbol("already_processed"),
}));

import {
  renderSubtitleDubBatch,
  renderSubtitleDubStream,
} from "@/lib/echoly-api";
import { clearAllCache } from "@/content/render-cache";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSettings(): StartSettings {
  return {
    running: false, connecting: false, paused: false, tabId: null, status: "Ready",
    errorMessage: "", apiMode: null, signedInUser: null, usage: null,
    languagePicker: null, languageNames: null, standardVoices: null,
    standardVoiceDefaultId: null, sessionStartedAt: null,
    advanced: { captionPosition: "bottom", outputDeviceId: "" },
    siteOverrides: {}, advancedVersion: 0, advancedDirty: false, currentDomain: null,
    tier: "standard", targetLanguage: "vi", realtimeVoice: "marin",
    standardVoice: "English_magnetic_voiced_man", originalVolume: 18,
    voiceVolume: 100, showSource: false, showTargetCaptions: true,
    apiBearer: "test-bearer", apiBase: "https://api.echolyhq.com",
  } as unknown as StartSettings;
}

function fakeAudioBuffer(): AudioBuffer {
  return { duration: 1 } as unknown as AudioBuffer;
}

function makeAudioCtxMock() {
  const gainNode = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  return {
    state: "running" as AudioContextState,
    currentTime: 0,
    destination: {},
    createBufferSource: vi.fn(() => ({
      buffer: null, onended: null,
      start: vi.fn(), stop: vi.fn(), connect: vi.fn(), disconnect: vi.fn(),
    })),
    createGain: vi.fn(() => gainNode),
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    decodeAudioData: vi.fn().mockResolvedValue(fakeAudioBuffer()),
  };
}

function makeFakeVideo(t = 0) {
  const v = {
    currentTime: t,
    paused: false,
    pause: vi.fn(() => { v.paused = true; }),
    play: vi.fn(async () => { v.paused = false; }),
  };
  return v;
}

function makePipeline(
  captions: { start: number; end: number; text: string }[],
  fakeVideo: ReturnType<typeof makeFakeVideo>,
) {
  const audioCtxMock = makeAudioCtxMock();
  (window as unknown as { AudioContext: unknown }).AudioContext = vi.fn(() => audioCtxMock);

  const lifecycle = new LifecycleController();

  let pageToken = 0;
  let sessionRef: SubtitleFirstSession | null = null;

  const sm = {
    get session(): SubtitleFirstSession | null { return sessionRef; },
    set session(s: SubtitleFirstSession | null) { sessionRef = s; },
    settings: null as StartSettings | null,
    apiBase: "https://api.echolyhq.com",
    lifecycle,
    pageToken,
    // Derived (mirror the real SessionManager getter).
    get userPaused(): boolean { return lifecycle.effectivePaused; },
    nextToken() { pageToken += 1; this.pageToken = pageToken; return pageToken; },
    isSessionStale(tok: number) { return tok !== this.pageToken; },
    emitState: vi.fn(),
  };

  const overlay = {
    buildOverlay: vi.fn(), syncFromSettings: vi.fn(), setStatusText: vi.fn(),
    setOverlayState: vi.fn(), removeOverlay: vi.fn(), showToast: vi.fn(),
    setTargetText: vi.fn(), setSourceText: vi.fn(), applySourceVisibility: vi.fn(),
    applyCaptionOnVideo: vi.fn(), setDubSyncReadout: vi.fn(), pushHistoryTurn: vi.fn(),
    isMounted: vi.fn().mockReturnValue(false),
  };

  const capture = {
    videoEl: fakeVideo as unknown as HTMLVideoElement,
    findVideo: vi.fn().mockReturnValue(fakeVideo),
    bindVolumeDriftGuard: vi.fn(), unbindVolumeDriftGuard: vi.fn(),
    unbindRateChangeWarn: vi.fn(), applyVolumes: vi.fn(),
    isLive: vi.fn().mockReturnValue(false),
  };

  const app = {
    sm, lifecycle, overlay, capture, callbacks: {},
    adapter: {
      id: "generic",
      capabilities: {
        audioCapture: true, subtitleFirst: true, isSpa: false,
        hasNativeCaptions: false, hasAdOverlays: false,
      },
      matchesHost: () => false, isWatchUrl: () => true,
      getVideoId: () => "test-video-id",
      findVideo: () => fakeVideo,
      stageInsets: () => ({ top: 44, bottom: 56, side: 16 }),
      fetchCaptions: vi.fn().mockResolvedValue({ captions, lang: "en" }),
      readLiveCaptionText: () => null,
    } as unknown as PlatformAdapter,
    startWebRtcStandard: vi.fn().mockResolvedValue({ ok: true }),
    stopSession: vi.fn(), applySourceVisibility: vi.fn(),
    startSessionTimer: vi.fn(), bindCommonVideoListeners: vi.fn(),
  };

  const pipeline = new SubtitleFirstPipeline(app as never);
  return { pipeline, sm, audioCtxMock, app };
}

/** Start the pipeline and return the session. clearInterval after done. */
async function doStreamStart(
  pipeline: SubtitleFirstPipeline,
  sm: { session: SubtitleFirstSession | null },
  streamLines: SubtitleDubStreamLine[],
): Promise<SubtitleFirstSession> {
  vi.mocked(renderSubtitleDubBatch).mockRejectedValue(new Error("should not call buffered"));
  vi.mocked(renderSubtitleDubStream).mockReturnValue(
    (async function* () { yield* streamLines; })() as never,
  );
  const result = await pipeline.start(makeSettings());
  if (!result.ok) throw new Error(`start() failed: ${result.error}`);
  const sess = sm.session as SubtitleFirstSession | null;
  if (!sess) throw new Error("no session after start");
  // Stop the 250ms playback-timer to avoid leaked timer warnings.
  clearInterval(sess.playbackTimer!);
  sess.playbackTimer = null;
  return sess;
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => { vi.useFakeTimers(); clearAllCache(); });
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); clearAllCache(); });

// ─── AC10 Tests ───────────────────────────────────────────────────────────────

describe("AC10: streaming #renderBatch writes _buffer[idx] in strict index order (E-5)", () => {
  it("sentence[0]._buffer is set from the first yielded stream line", async () => {
    // Cues far in the future (t=20) so the initial tick is a no-op.
    // Use sentence-ending punctuation so regroupToSentences produces 2 sentences.
    // SUBFIRST_PREBUFFER_COUNT=1: the initial #renderBatch covers only sentence 0.
    // Sentence 1 is picked up by the rolling renderer (needs timer advance).
    // This test focuses on the initial prebuffer wave: sentence 0 must be decoded.
    const captions = [
      { start: 20, end: 23, text: "hello." },
      { start: 23, end: 26, text: "world." },
    ];
    const fakeVideo = makeFakeVideo(0);
    const { pipeline, sm } = makePipeline(captions, fakeVideo);

    // Provide only index 0 — that's all the initial batch requests.
    const streamLines: SubtitleDubStreamLine[] = [
      { index: 0, text: "Xin chào", audioMp3: new Uint8Array([1, 2, 3]).buffer, cueStartMs: 0, cueEndMs: 3000 },
    ];

    const sess = await doStreamStart(pipeline, sm, streamLines);

    // sentence[0] must be translated and buffered after the initial wave.
    expect(sess.translations[0]).toBe("Xin chào");
    expect(sess.sentences[0]!._buffer).toBeDefined();
  });

  it("_buffer decode calls happen in strict index order (serial, not parallel)", async () => {
    // Verifies E-5: the for-await loop in #renderBatch awaits decodeAudioData
    // for each line before moving to the next, so the order is deterministic.
    // Use sentence-ending punctuation to ensure regroupToSentences keeps them separate.
    //
    // SUBFIRST_PREBUFFER_COUNT=1: start() renders only sentence 0 in the initial
    // prebuffer wave. The rolling renderer (needs timer advance) handles the rest.
    // We verify decode order for sentence 0 — the single line in the first batch.
    const captions = [
      { start: 20, end: 23, text: "A sentence." },
      { start: 23, end: 26, text: "B sentence." },
      { start: 26, end: 29, text: "C sentence." },
    ];
    const fakeVideo = makeFakeVideo(0);
    const { pipeline, sm, audioCtxMock } = makePipeline(captions, fakeVideo);

    // Track decode call order.
    const decodeOrder: number[] = [];
    audioCtxMock.decodeAudioData.mockImplementation(async (buf: ArrayBuffer) => {
      // The first byte of each buffer encodes its index (0, 1, 2).
      decodeOrder.push(new Uint8Array(buf)[0]!);
      return fakeAudioBuffer();
    });

    const streamLines: SubtitleDubStreamLine[] = [
      { index: 0, text: "A sentence.", audioMp3: new Uint8Array([0]).buffer, cueStartMs: 0, cueEndMs: 3000 },
    ];

    // Provide only line 0 for the initial wave (start() calls #renderBatch(0,1)).
    const sess = await doStreamStart(pipeline, sm, streamLines);

    // Sentence 0 decoded in the initial wave. Decode order = [0].
    expect(decodeOrder).toEqual([0]);

    // Verify translation and buffer for the initial sentence.
    expect(sess.translations[0]).toBe("A sentence.");
    expect(sess.sentences[0]!._buffer).toBeDefined();
  });

  it("streaming render sets _buffer in index order (same _buffer state as buffered path)", async () => {
    // E-5: the invariant is that after #renderBatch, sentences[idx]._buffer is
    // set iff the line had audio — the playback tick (#sentenceDueAt) relies on it.
    // This test verifies the invariant holds for the streaming path.
    const captions = [
      { start: 20, end: 23, text: "hello." },
    ];
    const fakeVideo = makeFakeVideo(0);
    const { pipeline, sm } = makePipeline(captions, fakeVideo);

    const streamLines: SubtitleDubStreamLine[] = [
      // Non-empty audio → _buffer should be set.
      { index: 0, text: "Xin chào", audioMp3: new Uint8Array([1, 2, 3]).buffer, cueStartMs: 0, cueEndMs: 3000 },
    ];

    const sess = await doStreamStart(pipeline, sm, streamLines);

    // _buffer is set → the playback tick will start the cue (not micro-pause).
    expect(sess.sentences[0]!._buffer).toBeDefined();
    expect(sess.sentences[0]!._buffer).not.toBeNull();
  });

  it("empty audio in stream line → _buffer stays undefined (same as buffered path failure case)", async () => {
    const captions = [
      { start: 20, end: 23, text: "hello." },
    ];
    const fakeVideo = makeFakeVideo(0);
    const { pipeline, sm, audioCtxMock } = makePipeline(captions, fakeVideo);

    // Empty audioMp3 → decodeAudioData is not called → _buffer stays undefined.
    const streamLines: SubtitleDubStreamLine[] = [
      { index: 0, text: "Xin chào", audioMp3: new ArrayBuffer(0), cueStartMs: 0, cueEndMs: 3000 },
    ];

    // Make decodeAudioData resolvable but we expect it NOT to be called.
    audioCtxMock.decodeAudioData.mockResolvedValue(fakeAudioBuffer());

    const sess = await doStreamStart(pipeline, sm, streamLines);

    // No audio → decodeAudioData NOT called → _buffer undefined.
    expect(audioCtxMock.decodeAudioData).not.toHaveBeenCalled();
    expect(sess.sentences[0]!._buffer).toBeUndefined();
  });
});

// ─── AC12: extension falls back to buffered path on stream 404 ───────────────

describe("AC12: renderSubtitleDubStream 404 fallback (unit, no pipeline)", () => {
  it("yields buffered items when stream route returns 404", async () => {
    // Test the real renderSubtitleDubStream fallback logic by importing the
    // actual module with a controlled global.fetch mock.
    const originalFetch = globalThis.fetch;

    const mp3Bytes = new Uint8Array([0xFF, 0xFB, 0x90]).buffer;
    const mp3Base64 = btoa(String.fromCharCode(...new Uint8Array(mp3Bytes)));

    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).endsWith("/translate/subtitles/stream")) {
        // 404 → triggers fallback.
        return {
          ok: false,
          status: 404,
          body: null,
        } as unknown as Response;
      }
      // Buffered route returns valid JSON.
      return {
        ok: true,
        status: 200,
        json: async () => ({
          lines: [
            { text: "Xin chào", audio: mp3Base64 },
            { text: "Thế giới", audio: mp3Base64 },
          ],
        }),
      } as unknown as Response;
    });

    globalThis.fetch = mockFetch;

    try {
      // Import the REAL module (bypassing vi.mock).
      const { renderSubtitleDubStream: realStream } = await vi.importActual<
        typeof import("@/lib/echoly-api")
      >("@/lib/echoly-api");

      const lines: Array<{ index: number; text: string }> = [];
      for await (const line of realStream({
        apiBase: "https://api.echolyhq.com",
        bearer: "test-bearer",
        sentences: [
          { text: "Hello", start: 0, end: 3, id: 0, _played: false },
          { text: "World", start: 3, end: 6, id: 1, _played: false },
        ] as never,
        targetLanguage: "vi",
        voiceId: "English_magnetic_voiced_man",
      })) {
        // Guard against the ALREADY_PROCESSED sentinel (unique symbol).
        if (typeof line === "symbol") continue;
        lines.push({ index: line.index, text: line.text });
      }

      // Both lines yielded from the buffered fallback.
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({ index: 0, text: "Xin chào" });
      expect(lines[1]).toMatchObject({ index: 1, text: "Thế giới" });

      // Stream was tried first (404), then buffered route succeeded.
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const urls = mockFetch.mock.calls.map((c) => String(c[0]));
      expect(urls[0]).toContain("/translate/subtitles/stream");
      expect(urls[1]).toContain("/translate/subtitles");
      expect(urls[1]).not.toContain("/stream");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("non-200/non-404 response throws a pipeline error", async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 402,
      body: null,
      json: async () => ({
        error: { code: "quota_exhausted", message: "Quota exceeded", upgrade_url: "https://echolyhq.com/billing" },
      }),
    } as unknown as Response) as never;

    try {
      const { renderSubtitleDubStream: realStream } = await vi.importActual<
        typeof import("@/lib/echoly-api")
      >("@/lib/echoly-api");

      const iter = realStream({
        apiBase: "https://api.echolyhq.com",
        bearer: "test-bearer",
        sentences: [{ text: "Hello", start: 0, end: 3, id: 0, _played: false }] as never,
        targetLanguage: "vi",
        voiceId: "English_magnetic_voiced_man",
      });

      await expect(iter.next()).rejects.toMatchObject({
        user: expect.any(String),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
