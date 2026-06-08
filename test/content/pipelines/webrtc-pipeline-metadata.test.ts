// @vitest-environment jsdom
//
// Tests for WebRtcPipeline.handleMetadataEvent — the quota_exhausted
// data-channel error frame path (credit-unify hardening, SOLUTION-FIX.md §D1).
//
// Context: the server now sends {type:"error", code:"quota_exhausted", ...} on the
// WebRTC data-channel when the server-authoritative floor timer exhausts credits.
// This is the ONLY mid-stream exhaustion signal after D2 (heartbeat is now
// liveness/pause-only, never returns 402). The same frame shape is also used by
// the standard-live segment tick (#onStandardSegmentTick on the server side).
//
// Covered:
//   A. quota_exhausted frame → showToast with Upgrade CTA + stopSession + post(CONTENT_QUOTA)
//   B. tier_locked frame → showToast with Upgrade CTA + stopSession + post(CONTENT_QUOTA)
//   C. unauthorized frame → showToast with Sign-in CTA + stopSession + post(CONTENT_QUOTA)
//   D. Generic error (no code / unknown code) → stopSession; no toast; no CONTENT_QUOTA post
//   E. Stale token guard — all branches are no-op when token is stale
//   F. startHeartbeat fires-and-forgets; no 402 inspection (liveness-only per D2)
//   G. partial_translation frame → overlay updated; no stop; no toast (regression guard)

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import type { ContentApp } from "@/content/index";
import { WebRtcPipeline } from "@/content/pipelines/webrtc-pipeline";
import { STOP_REASON } from "@/content/stop-reasons";

// ─── Mock @/shared/protocol so post() doesn't need chrome.runtime ────────────

// vi.hoisted: vi.mock is hoisted above declarations, so the factory's referenced
// vars must be hoisted too (else "Cannot access 'mockPost' before initialization").
const { mockPost } = vi.hoisted(() => ({
  mockPost: vi.fn<(msg: Record<string, unknown>) => boolean>().mockReturnValue(true),
}));

vi.mock("@/shared/protocol", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return { ...original, post: mockPost };
});

// ─── Mock @/shared/echoly-config for stable billing URL ──────────────────────

vi.mock("@/shared/echoly-config", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    ECHOLY_WEB_URLS: {
      accountBilling: () => "https://echolyhq.com/account#billing",
      signin: () => "https://echolyhq.com/signin",
      account: () => "https://echolyhq.com/account",
    },
  };
});

// ─── Minimal fake app ─────────────────────────────────────────────────────────
//
// Only the surface that handleMetadataEvent touches: sm (session state) +
// overlay (UI) + stopSession + pushHistoryTurn.

type FakeApp = {
  sm: {
    isSessionStale: Mock;
    videoPaused: boolean;
    translationSegmentId: number | null;
    translationUtteranceOpen: boolean;
    currentTargetText: string;
    currentSourceText: string;
    settings: { showSource: boolean } | null;
  };
  overlay: {
    setStatusText: Mock;
    showToast: Mock;
    setTargetText: Mock;
    setOverlayState: Mock;
    setSourceText: Mock;
  };
  stopSession: Mock;
  pushHistoryTurn: Mock;
};

function makeApp(stale = false): FakeApp {
  return {
    sm: {
      isSessionStale: vi.fn().mockReturnValue(stale),
      videoPaused: false,
      translationSegmentId: null,
      translationUtteranceOpen: false,
      currentTargetText: "",
      currentSourceText: "",
      settings: { showSource: false },
    },
    overlay: {
      setStatusText: vi.fn(),
      showToast: vi.fn(),
      setTargetText: vi.fn(),
      setOverlayState: vi.fn(),
      setSourceText: vi.fn(),
    },
    stopSession: vi.fn(),
    pushHistoryTurn: vi.fn(),
  };
}

function makePipeline(app: FakeApp): WebRtcPipeline {
  // Pass the fake app; cast to satisfy the TS type — we only exercise
  // handleMetadataEvent which uses only the surface provided above.
  return new WebRtcPipeline(app as unknown as ContentApp);
}

// ─── JSON frame helpers ───────────────────────────────────────────────────────

function errorFrame(
  code: string,
  message = "Some error.",
  retryable = false,
): string {
  return JSON.stringify({ type: "error", code, message, retryable });
}

function errorFrameNoCode(message = "Generic upstream error."): string {
  return JSON.stringify({ type: "error", message });
}

function partialTranslationFrame(text: string, isFinal = false, segmentId = 1): string {
  return JSON.stringify({ type: "partial_translation", text, isFinal, segmentId });
}

const TOKEN = 1;

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockPost.mockReset();
  mockPost.mockReturnValue(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// A. quota_exhausted frame
// ─────────────────────────────────────────────────────────────────────────────

describe("handleMetadataEvent: quota_exhausted data-channel error frame", () => {
  it("shows a toast with the server message and an Upgrade CTA", () => {
    const app = makeApp();
    const pipeline = makePipeline(app);

    pipeline.handleMetadataEvent(
      errorFrame("quota_exhausted", "Monthly quota exhausted."),
      TOKEN,
    );

    expect(app.overlay.showToast).toHaveBeenCalledOnce();
    const [toastMsg, toastOpts] = app.overlay.showToast.mock.calls[0] as [
      string,
      { cta?: string; ctaLabel?: string; durationMs?: number },
    ];
    expect(toastMsg).toBe("Monthly quota exhausted.");
    expect(toastOpts).toMatchObject({
      cta: "https://echolyhq.com/account#billing",
      ctaLabel: "Upgrade",
    });
    // Toast should linger long enough for the user to read it.
    expect((toastOpts.durationMs ?? 0)).toBeGreaterThanOrEqual(8000);
  });

  it("calls stopSession(SERVER_ERROR)", () => {
    const app = makeApp();
    const pipeline = makePipeline(app);

    pipeline.handleMetadataEvent(
      errorFrame("quota_exhausted", "Monthly quota exhausted."),
      TOKEN,
    );

    expect(app.stopSession).toHaveBeenCalledOnce();
    expect(app.stopSession).toHaveBeenCalledWith(STOP_REASON.SERVER_ERROR);
  });

  it("posts CONTENT_QUOTA to background to reflect exhaustion in the popup", () => {
    const app = makeApp();
    const pipeline = makePipeline(app);

    pipeline.handleMetadataEvent(
      errorFrame("quota_exhausted", "Monthly quota exhausted."),
      TOKEN,
    );

    expect(mockPost).toHaveBeenCalledOnce();
    expect(mockPost).toHaveBeenCalledWith({ type: "CONTENT_QUOTA" });
  });

  it("falls back to 'Translation error' when the message field is absent", () => {
    const app = makeApp();
    const pipeline = makePipeline(app);

    pipeline.handleMetadataEvent(
      JSON.stringify({ type: "error", code: "quota_exhausted" }),
      TOKEN,
    );

    expect(app.overlay.showToast).toHaveBeenCalledOnce();
    const [toastMsg] = app.overlay.showToast.mock.calls[0] as [string, unknown];
    expect(toastMsg).toBe("Translation error");
    expect(app.stopSession).toHaveBeenCalledWith(STOP_REASON.SERVER_ERROR);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. tier_locked frame → Upgrade CTA
// ─────────────────────────────────────────────────────────────────────────────

describe("handleMetadataEvent: tier_locked data-channel error frame", () => {
  it("shows a toast with Upgrade CTA and posts CONTENT_QUOTA", () => {
    const app = makeApp();
    const pipeline = makePipeline(app);

    pipeline.handleMetadataEvent(
      errorFrame("tier_locked", "This feature requires a higher plan."),
      TOKEN,
    );

    expect(app.overlay.showToast).toHaveBeenCalledOnce();
    const [, opts] = app.overlay.showToast.mock.calls[0] as [
      string,
      { ctaLabel?: string },
    ];
    expect(opts).toMatchObject({ ctaLabel: "Upgrade" });
    expect(app.stopSession).toHaveBeenCalledWith(STOP_REASON.SERVER_ERROR);
    expect(mockPost).toHaveBeenCalledWith({ type: "CONTENT_QUOTA" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. unauthorized frame → Sign-in CTA
// ─────────────────────────────────────────────────────────────────────────────

describe("handleMetadataEvent: unauthorized data-channel error frame", () => {
  it("shows a toast with Sign-in CTA and posts CONTENT_QUOTA", () => {
    const app = makeApp();
    const pipeline = makePipeline(app);

    pipeline.handleMetadataEvent(
      errorFrame("unauthorized", "Session expired."),
      TOKEN,
    );

    expect(app.overlay.showToast).toHaveBeenCalledOnce();
    const [, opts] = app.overlay.showToast.mock.calls[0] as [
      string,
      { ctaLabel?: string },
    ];
    expect(opts).toMatchObject({ ctaLabel: "Sign in" });
    expect(app.stopSession).toHaveBeenCalledWith(STOP_REASON.SERVER_ERROR);
    expect(mockPost).toHaveBeenCalledWith({ type: "CONTENT_QUOTA" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. Generic error (no code / unknown code) → stopSession; NO toast; NO post
// ─────────────────────────────────────────────────────────────────────────────

describe("handleMetadataEvent: generic error frame (non-expiry)", () => {
  it("does NOT show a toast for a plain error frame without code", () => {
    const app = makeApp();
    const pipeline = makePipeline(app);

    pipeline.handleMetadataEvent(errorFrameNoCode("Upstream provider error."), TOKEN);

    expect(app.overlay.showToast).not.toHaveBeenCalled();
    expect(app.stopSession).toHaveBeenCalledWith(STOP_REASON.SERVER_ERROR);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("does NOT show a toast for an error frame with an unknown non-expiry code", () => {
    const app = makeApp();
    const pipeline = makePipeline(app);

    pipeline.handleMetadataEvent(
      errorFrame("internal_error", "An internal error occurred."),
      TOKEN,
    );

    expect(app.overlay.showToast).not.toHaveBeenCalled();
    expect(app.stopSession).toHaveBeenCalledWith(STOP_REASON.SERVER_ERROR);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("does NOT show a toast for too_many_inflight (transient, not expiry)", () => {
    const app = makeApp();
    const pipeline = makePipeline(app);

    pipeline.handleMetadataEvent(
      errorFrame("too_many_inflight", "Too many requests."),
      TOKEN,
    );

    expect(app.overlay.showToast).not.toHaveBeenCalled();
    expect(app.stopSession).toHaveBeenCalledWith(STOP_REASON.SERVER_ERROR);
    expect(mockPost).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. Stale token guard — all branches no-op when token is stale
// ─────────────────────────────────────────────────────────────────────────────

describe("handleMetadataEvent: stale token guard", () => {
  it("is a complete no-op for quota_exhausted when session is stale", () => {
    const app = makeApp(/* stale= */ true);
    const pipeline = makePipeline(app);

    pipeline.handleMetadataEvent(
      errorFrame("quota_exhausted", "Monthly quota exhausted."),
      TOKEN,
    );

    expect(app.overlay.showToast).not.toHaveBeenCalled();
    expect(app.stopSession).not.toHaveBeenCalled();
    expect(app.overlay.setStatusText).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("is a complete no-op for partial_translation when session is stale", () => {
    const app = makeApp(/* stale= */ true);
    const pipeline = makePipeline(app);

    pipeline.handleMetadataEvent(
      partialTranslationFrame("Xin chào"),
      TOKEN,
    );

    expect(app.overlay.setTargetText).not.toHaveBeenCalled();
    expect(app.stopSession).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F. startHeartbeat is now liveness-only; no 402/quota handling present
//    (D2: heartbeat demoted — always returns {ok:true}; the server timer
//    is the sole exhaustion enforcer).
// ─────────────────────────────────────────────────────────────────────────────

describe("SessionManager.startHeartbeat: liveness-only, no quota path", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("fires a POST to the heartbeat URL and ignores the response", async () => {
    const { SessionManager } = await import("@/content/session-manager");
    const sm = new SessionManager();

    // Set a minimal session so the guard `if (!this.session) return` passes.
    sm.session = { kind: "webrtc" } as unknown as (typeof sm)["session"];

    // Stub fetch to return a 200.
    const mockFetch = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    globalThis.fetch = mockFetch;

    vi.useFakeTimers();
    sm.startHeartbeat("sess-abc", "bearer-xyz");

    // Advance past one heartbeat interval (30 000 ms is the constant HEARTBEAT_MS).
    await vi.advanceTimersByTimeAsync(30001);

    expect(mockFetch).toHaveBeenCalled();
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain("sess-abc/heartbeat");

    sm.stopHeartbeat();
  });

  it("does NOT post CONTENT_QUOTA even when fetch would return 402", async () => {
    const { SessionManager } = await import("@/content/session-manager");
    const sm = new SessionManager();

    // Set a minimal session so the guard passes.
    sm.session = { kind: "webrtc" } as unknown as (typeof sm)["session"];

    // Simulate a 402 response (old heartbeat model) to confirm no handling.
    // D2: the heartbeat route always returns 200 now, but even a 402 must have
    // no side-effects in the client (the response is fully ignored via .catch(() => {})).
    const mockFetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 402, json: async () => ({}) });
    globalThis.fetch = mockFetch;

    vi.useFakeTimers();
    sm.startHeartbeat("sess-def", "bearer-uvw");
    await vi.advanceTimersByTimeAsync(30001);

    // No CONTENT_QUOTA posted — heartbeat response is fire-and-forget.
    expect(mockPost).not.toHaveBeenCalled();

    sm.stopHeartbeat();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G. partial_translation frame — overlay updated; no stop; no toast (regression)
// ─────────────────────────────────────────────────────────────────────────────

describe("handleMetadataEvent: partial_translation (regression guard)", () => {
  it("updates overlay text and does NOT call stopSession or showToast", () => {
    const app = makeApp();
    const pipeline = makePipeline(app);

    pipeline.handleMetadataEvent(
      partialTranslationFrame("Xin chào thế giới", false, 42),
      TOKEN,
    );

    expect(app.overlay.setTargetText).toHaveBeenCalledWith("Xin chào thế giới");
    expect(app.overlay.setOverlayState).toHaveBeenCalledWith("live");
    expect(app.stopSession).not.toHaveBeenCalled();
    expect(app.overlay.showToast).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  });
});
