// @vitest-environment jsdom
//
// Unit tests for the YouTube and generic platform adapters.
//
// Covers:
//   - youtubeAdapter.readLiveCaptionText() with .ytp-caption-segment spans present
//   - youtubeAdapter.readLiveCaptionText() with no matching elements → null
//   - genericAdapter.readLiveCaptionText() → always null
//   - D3: youtubeAdapter.fetchCaptions forwards preferLang+avoidLang to
//         fetchYouTubeCaptionsWithSettle correctly

import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { youtubeAdapter } from "@/platforms/youtube/adapter";
import { genericAdapter } from "@/platforms/generic/adapter";

// ─── D3: fetchCaptions argument forwarding ─────────────────────────────────────
// The adapter must translate opts.preferLang (default "en") + opts.avoidLang into
// the matching positional args of fetchYouTubeCaptionsWithSettle.

vi.mock("@/platforms/youtube/captions-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platforms/youtube/captions-fetch")>();
  return {
    ...actual,
    fetchYouTubeCaptionsWithSettle: vi.fn().mockResolvedValue(null),
  };
});

describe("youtubeAdapter.fetchCaptions — D3: argument forwarding", () => {
  // Import the spy AFTER the vi.mock above is in place.
  // Dynamic import inside each test ensures we see the mocked version.

  it("D3a: forwards opts.preferLang and opts.avoidLang to fetchYouTubeCaptionsWithSettle", async () => {
    const { fetchYouTubeCaptionsWithSettle } = await import(
      "@/platforms/youtube/captions-fetch"
    );
    const spy = fetchYouTubeCaptionsWithSettle as ReturnType<typeof vi.fn>;
    spy.mockClear();

    const signal = new AbortController().signal;
    await youtubeAdapter.fetchCaptions({
      videoId: "v1",
      preferLang: "en",
      avoidLang: "vi",
      signal,
    });

    expect(spy).toHaveBeenCalledOnce();
    // Positional args: (videoId, sourcePref, signal, opts?, avoidLang?)
    // adapter.ts: fetchYouTubeCaptionsWithSettle(opts.videoId, opts.preferLang, opts.signal, undefined, opts.avoidLang)
    const [calledVideoId, calledSourcePref, , , calledAvoidLang] = spy.mock.calls[0]!;
    expect(calledVideoId).toBe("v1");
    expect(calledSourcePref).toBe("en");   // sourcePref = opts.preferLang (explicit)
    expect(calledAvoidLang).toBe("vi");    // avoidLang forwarded as 5th arg
  });

  it("D3b: opts.avoidLang is forwarded even when preferLang differs from avoidLang", async () => {
    const { fetchYouTubeCaptionsWithSettle } = await import(
      "@/platforms/youtube/captions-fetch"
    );
    const spy = fetchYouTubeCaptionsWithSettle as ReturnType<typeof vi.fn>;
    spy.mockClear();

    const signal = new AbortController().signal;
    await youtubeAdapter.fetchCaptions({
      videoId: "v2",
      preferLang: "ja",
      avoidLang: "vi",
      signal,
    });

    expect(spy).toHaveBeenCalledOnce();
    const [, calledSourcePref, , , calledAvoidLang] = spy.mock.calls[0]!;
    expect(calledSourcePref).toBe("ja");
    expect(calledAvoidLang).toBe("vi");
  });

  it("D3c: when preferLang is omitted (AUTO), sourcePref is forwarded as undefined (NOT defaulted to 'en')", async () => {
    const { fetchYouTubeCaptionsWithSettle } = await import(
      "@/platforms/youtube/captions-fetch"
    );
    const spy = fetchYouTubeCaptionsWithSettle as ReturnType<typeof vi.fn>;
    spy.mockClear();

    const signal = new AbortController().signal;
    // No preferLang supplied — "auto": the adapter passes undefined so the picker
    // runs in AUTO mode (ASR/original-first) instead of forcing an explicit "en".
    await youtubeAdapter.fetchCaptions({
      videoId: "v3",
      avoidLang: "vi",
      signal,
    });

    expect(spy).toHaveBeenCalledOnce();
    const [, calledSourcePref, , , calledAvoidLang] = spy.mock.calls[0]!;
    expect(calledSourcePref).toBeUndefined();  // AUTO → undefined (no forced "en")
    expect(calledAvoidLang).toBe("vi");
  });
});

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

// ─── youtubeAdapter.readLiveCaptionText ───────────────────────────────────────

describe("youtubeAdapter.readLiveCaptionText", () => {
  it("returns the joined text when .ytp-caption-segment spans are present", () => {
    // Simulate the YouTube caption DOM: one or more .ytp-caption-segment spans
    // nested inside the player caption window.
    document.body.innerHTML = `
      <div class="ytp-caption-window-container">
        <div class="ytp-caption-segment">Hello, world!</div>
        <div class="ytp-caption-segment"> How are you?</div>
      </div>
    `;

    const result = youtubeAdapter.readLiveCaptionText();
    expect(result).not.toBeNull();
    // The adapter joins with " " and collapses whitespace runs
    expect(result).toBe("Hello, world! How are you?");
  });

  it("returns a single segment's text without spurious spaces", () => {
    document.body.innerHTML = `
      <div class="ytp-caption-segment">This is a test caption.</div>
    `;

    const result = youtubeAdapter.readLiveCaptionText();
    expect(result).not.toBeNull();
    expect(result).toBe("This is a test caption.");
  });

  it("returns null when no .ytp-caption-segment elements exist", () => {
    // Empty DOM — no caption segments at all
    document.body.innerHTML = "";
    expect(youtubeAdapter.readLiveCaptionText()).toBeNull();
  });

  it("returns null when segments exist but all have empty text", () => {
    document.body.innerHTML = `
      <div class="ytp-caption-segment">   </div>
      <div class="ytp-caption-segment"></div>
    `;
    // After trim + collapse the text is "" → adapter should return null
    expect(youtubeAdapter.readLiveCaptionText()).toBeNull();
  });

  it("collapses internal whitespace runs to a single space", () => {
    document.body.innerHTML = `
      <div class="ytp-caption-segment">One  two</div>
      <div class="ytp-caption-segment">   three</div>
    `;
    const result = youtubeAdapter.readLiveCaptionText();
    expect(result).not.toBeNull();
    expect(result).toBe("One two three");
  });
});

// ─── genericAdapter.readLiveCaptionText ──────────────────────────────────────

describe("genericAdapter.readLiveCaptionText", () => {
  it("returns null regardless of DOM content", () => {
    // Even if YT-like caption segments happen to be in the DOM, the generic
    // adapter does NOT scrape them — it always returns null.
    document.body.innerHTML = `
      <div class="ytp-caption-segment">Some text</div>
    `;
    expect(genericAdapter.readLiveCaptionText()).toBeNull();
  });

  it("returns null on an empty DOM", () => {
    document.body.innerHTML = "";
    expect(genericAdapter.readLiveCaptionText()).toBeNull();
  });
});
