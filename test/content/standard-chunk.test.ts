// @vitest-environment jsdom
// Layer B (i)+(ii) — processStandardChunk credit-burn protection:
//   (i) no-ops after a mid-pipeline pageToken/session flip, AND the per-await
//       guard predicate (isChunkStale) is invoked after EACH of its 5 awaits.
//   (ii) Stop ⇒ abortController.abort() fires and every wired fetch receives the
//        session's abort signal.
// Uses the hand-rolled chrome.* mock (test/setup.ts) + a minimal fake app that
// exposes only what processStandardChunk reads (sm / overlay / pushHistoryTurn).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionManager } from "@/content/session-manager";
import type { StandardSession } from "@/content/session-manager";
import { StandardChunkedPipeline } from "@/content/pipelines/standard-chunked";
import type { OverlayView } from "@/shared/ports";
import type { StartSettings } from "@/shared/types";
import { DEFAULT_SETTINGS } from "@/shared/types";

function noopOverlay(): OverlayView {
  return {
    buildOverlay: vi.fn(),
    removeOverlay: vi.fn(),
    setOverlayState: vi.fn(),
    setStatusText: vi.fn(),
    setTargetText: vi.fn(),
    setSourceText: vi.fn(),
    setLanguageSelection: vi.fn(),
    applySourceVisibility: vi.fn(),
    pushHistoryTurn: vi.fn(),
    pushHistoryMarker: vi.fn(),
    showToast: vi.fn(),
    populateVoicePicker: vi.fn(),
    isMounted: vi.fn(() => true),
  };
}

/** A minimal AudioContext stub for the chunk's decode + scheduling path. */
function fakeAudioCtx(): AudioContext {
  return {
    currentTime: 0,
    decodeAudioData: vi.fn(async () => ({ duration: 1.0 }) as AudioBuffer),
    createBufferSource: vi.fn(() => ({
      buffer: null,
      connect: vi.fn(),
      start: vi.fn(),
    })),
  } as unknown as AudioContext;
}

function makeSession(sm: SessionManager): StandardSession {
  const s: StandardSession = {
    token: sm.nextToken(),
    type: "standard",
    pc: null,
    dc: null,
    stream: null,
    remoteAudio: null,
    audioCtx: fakeAudioCtx(),
    outputGain: { } as GainNode,
    kymaSessionId: null,
    kymaKey: "test-bearer",
    recorderMime: "audio/webm",
    activeRecorder: null,
    nextPlayAt: 0,
    stopFlag: false,
    abortController: new AbortController(),
  };
  sm.session = s;
  return s;
}

/** A blob whose arrayBuffer() resolves; size > STANDARD_MIN_CHUNK_BYTES. */
function fakeBlob(size = 5000): Blob {
  return {
    size,
    type: "audio/webm",
    arrayBuffer: async () => new ArrayBuffer(8),
  } as unknown as Blob;
}

function buildApp(sm: SessionManager): {
  app: {
    sm: SessionManager;
    overlay: OverlayView;
    pushHistoryTurn: ReturnType<typeof vi.fn>;
  };
  pipeline: StandardChunkedPipeline;
} {
  const app = {
    sm,
    overlay: noopOverlay(),
    pushHistoryTurn: vi.fn(),
  };
  const pipeline = new StandardChunkedPipeline(
    app as unknown as ConstructorParameters<typeof StandardChunkedPipeline>[0],
  );
  return { app, pipeline };
}

function settings(): StartSettings {
  return { ...DEFAULT_SETTINGS, apiBase: "https://api.test/v1" } as StartSettings;
}

describe("processStandardChunk — guard after every await + happy path", () => {
  beforeEach(() => {
    // Stub the wav re-encode by stubbing decodeAudioData via fakeAudioCtx; the
    // understand+tts fetches return ok with a JSON answer / mp3 bytes.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const url = String(_url);
        if (url.endsWith("/audio/understand")) {
          return new Response(JSON.stringify({ answer: "xin chào" }), {
            status: 200,
          });
        }
        if (url.endsWith("/audio/speech")) {
          return new Response(new ArrayBuffer(16), { status: 200 });
        }
        return new Response("", { status: 200 });
      }),
    );
  });

  it("runs all 5 post-await guard checks on the happy path", async () => {
    const sm = new SessionManager();
    sm.apiBase = "https://api.test/v1";
    sm.settings = settings();
    const s = makeSession(sm);
    const { pipeline } = buildApp(sm);
    const spy = vi.spyOn(sm, "isChunkStale");

    await pipeline.processStandardChunk(s, fakeBlob());

    // 5 post-await guards: after wav, understand-fetch, tts-fetch, arraybuf, decode.
    expect(spy).toHaveBeenCalledTimes(5);
  });

  it("NO-OPS after a mid-pipeline pageToken flip (session swapped away)", async () => {
    const sm = new SessionManager();
    sm.apiBase = "https://api.test/v1";
    sm.settings = settings();
    const s = makeSession(sm);
    const { app, pipeline } = buildApp(sm);

    // Flip on the FIRST post-await guard check: detach this chunk's session.
    let calls = 0;
    vi.spyOn(sm, "isChunkStale").mockImplementation((chunk, t) => {
      calls++;
      if (calls === 1) sm.session = null; // user hit Stop mid-pipeline
      return chunk !== sm.session || chunk.token !== t;
    });

    await pipeline.processStandardChunk(s, fakeBlob());

    // It bailed at the first guard → never reached the understand fetch, never
    // pushed history. (Only the wav re-encode ran before the flip.)
    expect(app.pushHistoryTurn).not.toHaveBeenCalled();
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const understandCalled = fetchMock.mock.calls.some((c) =>
      String(c[0]).endsWith("/audio/understand"),
    );
    expect(understandCalled).toBe(false);
  });

  it("skips sub-MIN_CHUNK_BYTES blobs without any fetch", async () => {
    const sm = new SessionManager();
    sm.settings = settings();
    const s = makeSession(sm);
    const { pipeline } = buildApp(sm);
    await pipeline.processStandardChunk(s, fakeBlob(100)); // < 2000
    expect((fetch as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("wires BOTH credit-burning fetches to the session abort signal", async () => {
    const sm = new SessionManager();
    sm.apiBase = "https://api.test/v1";
    sm.settings = settings();
    const s = makeSession(sm);
    const { pipeline } = buildApp(sm);

    await pipeline.processStandardChunk(s, fakeBlob());

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const wired = fetchMock.mock.calls.filter(
      (c) =>
        String(c[0]).endsWith("/audio/understand") ||
        String(c[0]).endsWith("/audio/speech"),
    );
    expect(wired.length).toBe(2);
    for (const call of wired) {
      const init = call[1] as RequestInit;
      expect(init.signal).toBe(s.abortController.signal);
    }
  });

  it("an aborted session (Stop) makes the wired fetch bail silently — no history", async () => {
    const sm = new SessionManager();
    sm.apiBase = "https://api.test/v1";
    sm.settings = settings();
    const s = makeSession(sm);
    const { app, pipeline } = buildApp(sm);

    // Simulate Stop: abort the session's controller so the understand fetch
    // rejects like a real aborted request (the catch{return} path).
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        return new Response(JSON.stringify({ answer: "x" }), { status: 200 });
      }),
    );
    s.abortController.abort();

    await pipeline.processStandardChunk(s, fakeBlob());
    expect(app.pushHistoryTurn).not.toHaveBeenCalled();
  });
});
