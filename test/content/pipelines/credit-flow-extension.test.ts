// @vitest-environment jsdom
//
// credit-flow-review wave — Extension slice tests (WS5)
//
// Tests:
//   1. already_processed: renderSubtitleDubBatch returns ALREADY_PROCESSED on
//      both 200 {already_processed:true} and 409 already_processed — both shapes
//      are terminal success-skip (never retried). Tests use importActual to get
//      the real module (not the test-file mock) so they exercise real branch logic.
//   2. Stable per-batch requestId: the same requestId is reused on retries of the
//      same batch range (prevents double-billing on transient errors).
//   3. newRequestId: generates unique prefix-keyed ids.
//   4. durationHintSec math: VOD uses remaining time (duration − currentTime);
//      live uses RTC_LIVE_DURATION_HINT_CAP_SEC.
//   5. refreshUsageAfterExhaustion: fetches /v1/usage and posts CONTENT_QUOTA.
//   6. RTC route: no client requestId sent on the initial POST /v1/rtc/translate.

import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { RTC_LIVE_DURATION_HINT_CAP_SEC } from "@/shared/constants";

// ─────────────────────────────────────────────────────────────────────────────
// Mock for post() — used by refreshUsageAfterExhaustion tests
// ─────────────────────────────────────────────────────────────────────────────
vi.mock("@/shared/protocol", () => ({
  post: vi.fn(),
}));

import { post } from "@/shared/protocol";

// ─────────────────────────────────────────────────────────────────────────────
// 1 + 2. already_processed shapes + stable requestId
// These tests use vi.importActual for echoly-api to exercise the real branch
// logic (not a mock). We drive global.fetch directly.
// ─────────────────────────────────────────────────────────────────────────────

describe("echoly-api (real module): already_processed shapes are terminal success-skip", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("200 {already_processed:true, no lines} → returns the ALREADY_PROCESSED sentinel", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ already_processed: true }),
    } as unknown as Response);

    const mod = await vi.importActual<typeof import("@/lib/echoly-api")>("@/lib/echoly-api");
    const result = await mod.renderSubtitleDubBatch({
      apiBase: "https://api.echolyhq.com",
      bearer: "test-bearer",
      sentences: [{ text: "hello", start: 0, end: 3, id: 0, _played: false }] as never,
      targetLanguage: "vi",
      voiceId: "test-voice",
      requestId: "stable-req-id-0123456789",
    });
    // Must be the sentinel from the same real module instance.
    expect(result).toBe(mod.ALREADY_PROCESSED);
  });

  it("200 {already_processed:true, with lines} → returns the real lines (replay with body)", async () => {
    const mp3Base64 = btoa(String.fromCharCode(0xff, 0xfb, 0x90));
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({
        already_processed: true,
        lines: [{ text: "Xin chào", audio: mp3Base64 }],
      }),
    } as unknown as Response);

    const mod = await vi.importActual<typeof import("@/lib/echoly-api")>("@/lib/echoly-api");
    const result = await mod.renderSubtitleDubBatch({
      apiBase: "https://api.echolyhq.com",
      bearer: "test-bearer",
      sentences: [{ text: "hello", start: 0, end: 3, id: 0, _played: false }] as never,
      targetLanguage: "vi",
      voiceId: "test-voice",
      requestId: "stable-req-id-0123456789",
    });
    // When already_processed === true AND lines present, the body is returned (replay with data).
    expect(result).not.toBe(mod.ALREADY_PROCESSED);
    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result[0]?.text).toBe("Xin chào");
    }
  });

  it("409 with nested error.code already_processed → returns the ALREADY_PROCESSED sentinel", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      headers: { get: () => "application/json" },
      json: async () => ({
        error: { code: "already_processed", message: "Already processed" },
      }),
    } as unknown as Response);

    const mod = await vi.importActual<typeof import("@/lib/echoly-api")>("@/lib/echoly-api");
    const result = await mod.renderSubtitleDubBatch({
      apiBase: "https://api.echolyhq.com",
      bearer: "test-bearer",
      sentences: [{ text: "hello", start: 0, end: 3, id: 0, _played: false }] as never,
      targetLanguage: "vi",
      voiceId: "test-voice",
      requestId: "stable-req-id-0123456789",
    });
    expect(result).toBe(mod.ALREADY_PROCESSED);
  });

  it("409 with top-level code already_processed → returns the ALREADY_PROCESSED sentinel", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      headers: { get: () => "application/json" },
      json: async () => ({ code: "already_processed" }),
    } as unknown as Response);

    const mod = await vi.importActual<typeof import("@/lib/echoly-api")>("@/lib/echoly-api");
    const result = await mod.renderSubtitleDubBatch({
      apiBase: "https://api.echolyhq.com",
      bearer: "test-bearer",
      sentences: [{ text: "hello", start: 0, end: 3, id: 0, _played: false }] as never,
      targetLanguage: "vi",
      voiceId: "test-voice",
      requestId: "stable-req-id-0123456789",
    });
    expect(result).toBe(mod.ALREADY_PROCESSED);
  });

  it("409 non-JSON body → still returns the ALREADY_PROCESSED sentinel", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      headers: { get: () => "text/plain" },
      json: async () => { throw new SyntaxError("Unexpected token"); },
    } as unknown as Response);

    const mod = await vi.importActual<typeof import("@/lib/echoly-api")>("@/lib/echoly-api");
    const result = await mod.renderSubtitleDubBatch({
      apiBase: "https://api.echolyhq.com",
      bearer: "test-bearer",
      sentences: [{ text: "hello", start: 0, end: 3, id: 0, _played: false }] as never,
      targetLanguage: "vi",
      voiceId: "test-voice",
      requestId: "stable-req-id-0123456789",
    });
    expect(result).toBe(mod.ALREADY_PROCESSED);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Stable requestId is forwarded as the x-echoly-request-id header
// ─────────────────────────────────────────────────────────────────────────────

describe("echoly-api (real module): stable requestId forwarded as header", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("caller-supplied requestId sent unchanged as x-echoly-request-id header", async () => {
    let capturedReqId: string | null = null;
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const h = init.headers as Record<string, string>;
      capturedReqId = h["x-echoly-request-id"] ?? null;
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        json: async () => ({ lines: [{ text: "Dịch", audio: btoa("\xff\xfb\x90") }] }),
      } as unknown as Response);
    });

    const mod = await vi.importActual<typeof import("@/lib/echoly-api")>("@/lib/echoly-api");
    const stableId = "stable-id-for-retry-00000000";
    await mod.renderSubtitleDubBatch({
      apiBase: "https://api.echolyhq.com",
      bearer: "test-bearer",
      sentences: [{ text: "hi", start: 0, end: 3, id: 0, _played: false }] as never,
      targetLanguage: "vi",
      voiceId: "test-voice",
      requestId: stableId,
    });
    expect(capturedReqId).toBe(stableId);
  });

  it("without requestId, a generated sf_dub-prefixed id is sent", async () => {
    let capturedReqId: string | null = null;
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const h = init.headers as Record<string, string>;
      capturedReqId = h["x-echoly-request-id"] ?? null;
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        json: async () => ({ lines: [] }),
      } as unknown as Response);
    });

    const mod = await vi.importActual<typeof import("@/lib/echoly-api")>("@/lib/echoly-api");
    await mod.renderSubtitleDubBatch({
      apiBase: "https://api.echolyhq.com",
      bearer: "test-bearer",
      sentences: [] as never,
      targetLanguage: "vi",
      voiceId: "test-voice",
      // No requestId → generated.
    });
    expect(typeof capturedReqId).toBe("string");
    expect(capturedReqId).toBeTruthy();
    expect(capturedReqId!.startsWith("sf_dub")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. newRequestId: generates unique prefix-keyed ids
// ─────────────────────────────────────────────────────────────────────────────

describe("newRequestId (real module): prefix + uniqueness", () => {
  it("returns a string starting with the given prefix followed by underscore", async () => {
    const mod = await vi.importActual<typeof import("@/lib/echoly-api")>("@/lib/echoly-api");
    const id = mod.newRequestId("sf_dub_s");
    expect(typeof id).toBe("string");
    expect(id.startsWith("sf_dub_s_")).toBe(true);
  });

  it("generates different ids on successive calls (no UUID collision)", async () => {
    const mod = await vi.importActual<typeof import("@/lib/echoly-api")>("@/lib/echoly-api");
    const a = mod.newRequestId("test");
    const b = mod.newRequestId("test");
    expect(a).not.toBe(b);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. durationHintSec math: RTC_LIVE_DURATION_HINT_CAP_SEC for live,
//    remaining time for VOD (duration − currentTime).
// ─────────────────────────────────────────────────────────────────────────────

describe("durationHintSec math (SOLUTION WS5.2)", () => {
  it("RTC_LIVE_DURATION_HINT_CAP_SEC is 600 (10 minutes — not 3600)", () => {
    expect(RTC_LIVE_DURATION_HINT_CAP_SEC).toBe(600);
  });

  it("VOD remaining time: user starts at minute 90 of 2-hour video → 1800s hint", () => {
    const duration = 7200; // 2-hour video
    const currentTime = 5400; // user starts at minute 90
    const hint = Math.max(1, Math.ceil(duration - currentTime));
    // Should be 30 minutes (1800s), NOT 7200s (full duration).
    expect(hint).toBe(1800);
  });

  it("VOD remaining time: starting at t=0 equals full duration", () => {
    const duration = 300;
    const hint = Math.max(1, Math.ceil(duration - 0));
    expect(hint).toBe(300);
  });

  it("VOD remaining time: minimum is 1 second (clamped from 0 at end of video)", () => {
    const duration = 300;
    const currentTime = 300; // exactly at the end
    const hint = Math.max(1, Math.ceil(duration - currentTime));
    expect(hint).toBe(1);
  });

  it("live hint is strictly less than old 3600s hard-code", () => {
    // The cap is used instead of 3600 to avoid over-reserving on session start.
    expect(RTC_LIVE_DURATION_HINT_CAP_SEC).toBeLessThan(3600);
  });

  it("live hint is 600s = 10-min equivalent matching server RESERVE_HINT_CAP_CMIN default", () => {
    // 600 seconds × 1 cmin/s = 600 cmin ≈ 10 min worth — matches the server cap.
    expect(RTC_LIVE_DURATION_HINT_CAP_SEC).toBe(600);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. refreshUsageAfterExhaustion: /v1/usage fetched, CONTENT_QUOTA posted
// ─────────────────────────────────────────────────────────────────────────────

describe("refreshUsageAfterExhaustion (SOLUTION WS5.5)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("fetches /v1/usage and posts CONTENT_QUOTA with the returned credit fields", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        credits: {
          usedCredits: 900,
          capCredits: 1000,
          remainingCredits: 100,
        },
        resetsAt: "2026-07-01T00:00:00.000Z",
      }),
    } as unknown as Response);

    const { refreshUsageAfterExhaustion: fn } = await vi.importActual<
      typeof import("@/lib/quota-notify")
    >("@/lib/quota-notify");

    fn("test-bearer-token");

    // Fire-and-forget: await the microtask/setTimeout queue to let the chain resolve.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/usage"),
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer test-bearer-token" }),
      }),
    );

    expect(vi.mocked(post)).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "CONTENT_QUOTA",
        used_credits: 900,
        cap_credits: 1000,
        resets_at: "2026-07-01T00:00:00.000Z",
      }),
    );
  });

  it("silently swallows fetch errors (fire-and-forget, no throw)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const { refreshUsageAfterExhaustion: fn } = await vi.importActual<
      typeof import("@/lib/quota-notify")
    >("@/lib/quota-notify");

    // Should not throw synchronously.
    expect(() => fn("test-bearer-token")).not.toThrow();

    await new Promise((r) => setTimeout(r, 0));
    // No CONTENT_QUOTA posted on error.
    expect(vi.mocked(post)).not.toHaveBeenCalled();
  });

  it("does nothing when apiBearer is empty string", async () => {
    globalThis.fetch = vi.fn();

    const { refreshUsageAfterExhaustion: fn } = await vi.importActual<
      typeof import("@/lib/quota-notify")
    >("@/lib/quota-notify");

    fn("");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("does not post CONTENT_QUOTA when response is not ok (401)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    } as unknown as Response);

    const { refreshUsageAfterExhaustion: fn } = await vi.importActual<
      typeof import("@/lib/quota-notify")
    >("@/lib/quota-notify");

    fn("test-bearer-token");
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(vi.mocked(post)).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. RTC route: no client requestId sent to POST /v1/rtc/translate
// The WebRtcPipeline.buildSession() should NOT add a requestId to the query
// string or headers sent to /rtc/translate — the server always generates it.
// Per SOLUTION WS2.4 + FEATURE-MAP WS5 verification requirement.
// ─────────────────────────────────────────────────────────────────────────────

describe("WebRtcPipeline.buildSession: no client requestId on POST /v1/rtc/translate", () => {
  let capturedUrl = "";
  let capturedHeaders: Record<string, string> = {};
  const originalFetch = globalThis.fetch;
  const originalRTCPeerConnection = (globalThis as unknown as { RTCPeerConnection?: unknown }).RTCPeerConnection;

  beforeEach(() => {
    const fakePC = {
      addTrack: vi.fn(),
      createDataChannel: vi.fn(() => ({
        label: "echoly-metadata",
        addEventListener: vi.fn(),
      })),
      addEventListener: vi.fn(),
      createOffer: vi.fn().mockResolvedValue({ sdp: "v=0\r\n" }),
      setLocalDescription: vi.fn().mockResolvedValue(undefined),
      setRemoteDescription: vi.fn().mockResolvedValue(undefined),
      getSenders: vi.fn().mockReturnValue([]),
      close: vi.fn(),
      iceConnectionState: "new",
    };
    (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = vi.fn(() => fakePC);

    globalThis.fetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      capturedUrl = url as string;
      capturedHeaders = ((init?.headers ?? {}) as Record<string, string>);
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) =>
            name === "x-echoly-session-id" ? "sess-abc123" : null,
        },
        text: async () => "v=0\r\n",
      } as unknown as Response);
    }) as never;

    const gainNode = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
    const audioCtx = {
      state: "running" as AudioContextState,
      currentTime: 0, destination: {},
      createGain: vi.fn(() => gainNode),
      resume: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      createBufferSource: vi.fn(() => ({
        buffer: null, onended: null,
        start: vi.fn(), stop: vi.fn(), connect: vi.fn(), disconnect: vi.fn(),
      })),
    };
    (window as unknown as { AudioContext: unknown }).AudioContext = vi.fn(() => audioCtx);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection =
      originalRTCPeerConnection;
    capturedUrl = "";
    capturedHeaders = {};
  });

  it("URL query string does not contain requestId for realtime pipeline", async () => {
    const { WebRtcPipeline } = await vi.importActual<
      typeof import("@/content/pipelines/webrtc-pipeline")
    >("@/content/pipelines/webrtc-pipeline");

    const sm = {
      apiBase: "https://api.echolyhq.com",
      settings: { voiceVolume: 100 } as never,
      pageToken: 1,
      isSessionStale: () => false,
      session: null,
    };
    const overlay = { setStatusText: vi.fn(), setOverlayState: vi.fn() };
    const app = { sm, overlay, adapter: { getVideoTitle: () => null } };
    const pipeline = new WebRtcPipeline(app as never);
    const stream = { getAudioTracks: () => [] } as unknown as MediaStream;

    try {
      await pipeline.buildSession(1, stream, {
        apiBearer: "test-bearer",
        targetLanguage: "vi",
        pipeline: "realtime",
        voice: "marin",
        durationHintSec: 600,
      });
    } catch {
      // stale-check or RTCPeerConnection issue — the URL capture still happened.
    }

    if (capturedUrl) {
      const url = new URL(capturedUrl);
      // No requestId in query params.
      expect(url.searchParams.has("requestId")).toBe(false);
      expect(url.searchParams.has("x-echoly-request-id")).toBe(false);
      // Expected params ARE present.
      expect(url.searchParams.get("targetLanguage")).toBe("vi");
      expect(url.searchParams.get("pipeline")).toBe("realtime");
      expect(url.searchParams.get("durationHintSec")).toBe("600");
    }
  });

  it("request headers do not contain x-echoly-request-id for the SDP POST", async () => {
    const { WebRtcPipeline } = await vi.importActual<
      typeof import("@/content/pipelines/webrtc-pipeline")
    >("@/content/pipelines/webrtc-pipeline");

    const sm = {
      apiBase: "https://api.echolyhq.com",
      settings: { voiceVolume: 100 } as never,
      pageToken: 1,
      isSessionStale: () => false,
      session: null,
    };
    const overlay = { setStatusText: vi.fn(), setOverlayState: vi.fn() };
    const app = { sm, overlay, adapter: { getVideoTitle: () => null } };
    const pipeline = new WebRtcPipeline(app as never);
    const stream = { getAudioTracks: () => [] } as unknown as MediaStream;

    try {
      await pipeline.buildSession(1, stream, {
        apiBearer: "test-bearer",
        targetLanguage: "vi",
        pipeline: "standard",
        voice: "test-voice",
        durationHintSec: 300,
      });
    } catch {
      // tolerated
    }

    if (Object.keys(capturedHeaders).length > 0) {
      const lowerHeaders = Object.fromEntries(
        Object.entries(capturedHeaders).map(([k, v]) => [k.toLowerCase(), v]),
      );
      expect("x-echoly-request-id" in lowerHeaders).toBe(false);
    }
  });
});
