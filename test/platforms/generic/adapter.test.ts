// @vitest-environment jsdom
//
// Unit tests for src/platforms/generic/adapter.ts.
//
// Verifies:
//   - subtitleFirst === true (pipeline-level HTML5 fallback enabled for generic sites)
//   - getVideoId returns a non-null stable id for a video page URL
//   - getVideoId returns null for root/bare-origin URLs
//   - Other capability flags and basic adapter behaviour

import { describe, it, expect } from "vitest";
import { genericAdapter } from "@/platforms/generic/adapter";

// ─── Capabilities ─────────────────────────────────────────────────────────────

describe("genericAdapter — capabilities", () => {
  it("subtitleFirst is true (pipeline-level HTML5 fallback enabled)", () => {
    expect(genericAdapter.capabilities.subtitleFirst).toBe(true);
  });

  it("audioCapture is true (standard HTML5 video, no DRM assumed)", () => {
    expect(genericAdapter.capabilities.audioCapture).toBe(true);
  });

  it("isSpa is false", () => {
    expect(genericAdapter.capabilities.isSpa).toBe(false);
  });

  it("hasNativeCaptions is false", () => {
    expect(genericAdapter.capabilities.hasNativeCaptions).toBe(false);
  });

  it("hasAdOverlays is false", () => {
    expect(genericAdapter.capabilities.hasAdOverlays).toBe(false);
  });

  it("id is 'generic'", () => {
    expect(genericAdapter.id).toBe("generic");
  });
});

// ─── matchesHost ──────────────────────────────────────────────────────────────

describe("genericAdapter.matchesHost", () => {
  it("always returns false (never registered in ADAPTERS array)", () => {
    expect(genericAdapter.matchesHost("example.com")).toBe(false);
    expect(genericAdapter.matchesHost("www.example.com")).toBe(false);
    expect(genericAdapter.matchesHost("")).toBe(false);
  });
});

// ─── isWatchUrl ───────────────────────────────────────────────────────────────

describe("genericAdapter.isWatchUrl", () => {
  it("returns true for any URL (optimistically — no structural knowledge)", () => {
    expect(genericAdapter.isWatchUrl("https://example.com/videos/123")).toBe(true);
    expect(genericAdapter.isWatchUrl("https://example.com/")).toBe(true);
  });
});

// ─── getVideoId ───────────────────────────────────────────────────────────────

describe("genericAdapter.getVideoId", () => {
  it("returns a non-null id for a video page URL", () => {
    const id = genericAdapter.getVideoId("https://example.com/videos/my-lecture");
    expect(id).not.toBeNull();
    expect(typeof id).toBe("string");
    expect(id!.length).toBeGreaterThan(0);
  });

  it("uses the pathname as the stable id", () => {
    const id = genericAdapter.getVideoId("https://example.com/course/lesson/42");
    expect(id).toBe("course/lesson/42");
  });

  it("returns null for a root/bare-origin URL (empty pathname after stripping slashes)", () => {
    const id = genericAdapter.getVideoId("https://example.com/");
    expect(id).toBeNull();
  });

  it("returns null for an invalid URL", () => {
    const id = genericAdapter.getVideoId("not-a-url");
    expect(id).toBeNull();
  });

  it("produces the same id for the same URL (stable)", () => {
    const url = "https://example.com/watch/video-abc";
    expect(genericAdapter.getVideoId(url)).toBe(genericAdapter.getVideoId(url));
  });

  it("produces different ids for different paths on the same origin", () => {
    const id1 = genericAdapter.getVideoId("https://example.com/videos/alpha");
    const id2 = genericAdapter.getVideoId("https://example.com/videos/beta");
    expect(id1).not.toBe(id2);
  });
});

// ─── fetchCaptions ────────────────────────────────────────────────────────────

describe("genericAdapter.fetchCaptions", () => {
  it("returns null (generic adapter has no platform-specific caption API)", async () => {
    const signal = new AbortController().signal;
    const result = await genericAdapter.fetchCaptions({
      videoId: "some-path",
      signal,
    });
    expect(result).toBeNull();
  });
});

// ─── readLiveCaptionText ──────────────────────────────────────────────────────

describe("genericAdapter.readLiveCaptionText", () => {
  it("returns null", () => {
    expect(genericAdapter.readLiveCaptionText()).toBeNull();
  });
});

// ─── stageInsets ─────────────────────────────────────────────────────────────

describe("genericAdapter.stageInsets", () => {
  it("returns conservative default insets", () => {
    const video = document.createElement("video");
    const insets = genericAdapter.stageInsets(video);
    expect(insets.bottom).toBe(56);
    expect(insets.top).toBe(44);
    expect(insets.side).toBe(16);
  });
});
