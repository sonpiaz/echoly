// Unit tests for the platform adapter registry.
//
// Verifies: detectAdapter, detectAdapterForUrl, isSupportedWatchUrl
// — pure function tests, no DOM, no Chrome API needed.

import { describe, it, expect } from "vitest";
import {
  detectAdapter,
  detectAdapterForUrl,
  isSupportedWatchUrl,
} from "@/platforms/registry";

// ─── detectAdapter ────────────────────────────────────────────────────────────

describe("detectAdapter", () => {
  it("returns the youtube adapter for www.youtube.com", () => {
    expect(detectAdapter("www.youtube.com").id).toBe("youtube");
  });

  it("returns the coursera adapter for www.coursera.org", () => {
    expect(detectAdapter("www.coursera.org").id).toBe("coursera");
  });

  it("returns the udemy adapter for www.udemy.com", () => {
    expect(detectAdapter("www.udemy.com").id).toBe("udemy");
  });

  it("returns the generic adapter for an unknown host", () => {
    expect(detectAdapter("example.com").id).toBe("generic");
  });

  it("returns the youtube adapter for bare youtube.com (no www)", () => {
    expect(detectAdapter("youtube.com").id).toBe("youtube");
  });

  it("returns the udemy adapter for a subdomain (business.udemy.com)", () => {
    expect(detectAdapter("business.udemy.com").id).toBe("udemy");
  });
});

// ─── detectAdapterForUrl ─────────────────────────────────────────────────────

describe("detectAdapterForUrl", () => {
  it("returns the coursera adapter for a Coursera lecture URL", () => {
    expect(
      detectAdapterForUrl("https://www.coursera.org/learn/x/lecture/y").id,
    ).toBe("coursera");
  });

  it("returns the youtube adapter for a YouTube watch URL", () => {
    expect(
      detectAdapterForUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ").id,
    ).toBe("youtube");
  });

  it("returns the udemy adapter for a Udemy lecture URL", () => {
    expect(
      detectAdapterForUrl(
        "https://www.udemy.com/course/python-bootcamp/learn/lecture/12345",
      ).id,
    ).toBe("udemy");
  });

  it("returns the generic adapter for an unparseable URL", () => {
    expect(detectAdapterForUrl("not-a-url").id).toBe("generic");
  });

  it("returns the generic adapter for an unknown host", () => {
    expect(detectAdapterForUrl("https://example.com/video/123").id).toBe("generic");
  });
});

// ─── isSupportedWatchUrl ──────────────────────────────────────────────────────

describe("isSupportedWatchUrl", () => {
  it("returns true for a YouTube /watch?v= URL", () => {
    expect(
      isSupportedWatchUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    ).toBe(true);
  });

  it("returns true for a Coursera lecture URL", () => {
    expect(
      isSupportedWatchUrl(
        "https://www.coursera.org/learn/machine-learning/lecture/abc123",
      ),
    ).toBe(true);
  });

  it("returns true for a Udemy lecture URL", () => {
    expect(
      isSupportedWatchUrl(
        "https://www.udemy.com/course/python-bootcamp/learn/lecture/456789",
      ),
    ).toBe(true);
  });

  it("returns false for a YouTube non-watch page (channel page)", () => {
    expect(isSupportedWatchUrl("https://www.youtube.com/c/SomeChannel")).toBe(
      false,
    );
  });

  it("returns false for a Coursera home/week page", () => {
    expect(
      isSupportedWatchUrl(
        "https://www.coursera.org/learn/machine-learning/home/welcome",
      ),
    ).toBe(false);
  });

  it("returns false for a Udemy course root (not a lecture)", () => {
    expect(
      isSupportedWatchUrl("https://www.udemy.com/course/python-bootcamp/"),
    ).toBe(false);
  });
});
