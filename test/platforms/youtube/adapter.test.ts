// @vitest-environment jsdom
//
// Unit tests for the YouTube and generic platform adapters.
//
// Covers:
//   - youtubeAdapter.readLiveCaptionText() with .ytp-caption-segment spans present
//   - youtubeAdapter.readLiveCaptionText() with no matching elements → null
//   - genericAdapter.readLiveCaptionText() → always null

import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { youtubeAdapter } from "@/platforms/youtube/adapter";
import { genericAdapter } from "@/platforms/generic/adapter";

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
