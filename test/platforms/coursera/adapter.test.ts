// @vitest-environment jsdom
//
// Unit tests for the Coursera platform adapter.
// Uses jsdom DOM fixtures + mocked fetch — no live network calls.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { courseraAdapter } from "@/platforms/coursera/adapter";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FIXTURE_VTT = `WEBVTT

1
00:00:01.000 --> 00:00:04.500
Welcome to this lecture on machine learning.

2
00:00:05.000 --> 00:00:09.000
Today we will cover supervised learning algorithms.

3
00:00:10.000 --> 00:00:14.000
Let's start with linear regression.
`;

const FIXTURE_VTT_EMPTY = `WEBVTT

`;

// Coursera onDemandLectureVideos.v1 API response fixture
const FIXTURE_API_RESPONSE = {
  elements: [
    {
      id: "lecture-abc123",
      subtitlesVtt: {
        en: "https://api.coursera.org/vtt/en-lecture-abc123.vtt",
        vi: "https://api.coursera.org/vtt/vi-lecture-abc123.vtt",
      },
      subtitles: {
        en: "https://api.coursera.org/subs/en-lecture-abc123.vtt",
      },
    },
  ],
};

// ─── matchesHost ──────────────────────────────────────────────────────────────

describe("courseraAdapter.matchesHost", () => {
  it("matches bare coursera.org", () => {
    expect(courseraAdapter.matchesHost("coursera.org")).toBe(true);
  });

  it("matches www.coursera.org", () => {
    expect(courseraAdapter.matchesHost("www.coursera.org")).toBe(true);
  });

  it("matches subdomain like es.coursera.org", () => {
    expect(courseraAdapter.matchesHost("es.coursera.org")).toBe(true);
  });

  it("does not match udemy.com", () => {
    expect(courseraAdapter.matchesHost("udemy.com")).toBe(false);
  });

  it("does not match youtube.com", () => {
    expect(courseraAdapter.matchesHost("youtube.com")).toBe(false);
  });

  it("does not match a domain that contains coursera.org as substring but is different", () => {
    expect(courseraAdapter.matchesHost("notcoursera.org")).toBe(false);
  });
});

// ─── isWatchUrl ───────────────────────────────────────────────────────────────

describe("courseraAdapter.isWatchUrl", () => {
  it("returns true for a lecture URL with item-id only", () => {
    expect(
      courseraAdapter.isWatchUrl(
        "https://www.coursera.org/learn/machine-learning/lecture/abc123",
      ),
    ).toBe(true);
  });

  it("returns true for a lecture URL with title slug", () => {
    expect(
      courseraAdapter.isWatchUrl(
        "https://www.coursera.org/learn/deep-learning/lecture/xyz789/intro-to-cnn",
      ),
    ).toBe(true);
  });

  it("returns false for a home/week page", () => {
    expect(
      courseraAdapter.isWatchUrl(
        "https://www.coursera.org/learn/machine-learning/home/welcome",
      ),
    ).toBe(false);
  });

  it("returns false for a supplement page", () => {
    expect(
      courseraAdapter.isWatchUrl(
        "https://www.coursera.org/learn/machine-learning/supplement/abc123/reading",
      ),
    ).toBe(false);
  });

  it("returns false for a quiz page", () => {
    expect(
      courseraAdapter.isWatchUrl(
        "https://www.coursera.org/learn/machine-learning/exam/abc123/final-exam",
      ),
    ).toBe(false);
  });

  it("returns false for the browse/catalog page", () => {
    expect(
      courseraAdapter.isWatchUrl("https://www.coursera.org/browse/computer-science"),
    ).toBe(false);
  });

  it("returns false for the root page", () => {
    expect(courseraAdapter.isWatchUrl("https://www.coursera.org/")).toBe(false);
  });
});

// ─── getVideoId ───────────────────────────────────────────────────────────────

describe("courseraAdapter.getVideoId", () => {
  it("extracts the lecture item-id from a lecture URL", () => {
    expect(
      courseraAdapter.getVideoId(
        "https://www.coursera.org/learn/machine-learning/lecture/abc123",
      ),
    ).toBe("abc123");
  });

  it("extracts the item-id when a title slug is present", () => {
    expect(
      courseraAdapter.getVideoId(
        "https://www.coursera.org/learn/deep-learning/lecture/xyz789/intro-to-cnn",
      ),
    ).toBe("xyz789");
  });

  it("returns null for a non-lecture URL", () => {
    expect(
      courseraAdapter.getVideoId(
        "https://www.coursera.org/learn/machine-learning/home/welcome",
      ),
    ).toBeNull();
  });

  it("returns null for a browse page URL", () => {
    expect(
      courseraAdapter.getVideoId("https://www.coursera.org/browse/data-science"),
    ).toBeNull();
  });
});

// ─── fetchCaptions — Strategy 1: already-loaded textTracks ───────────────────

describe("courseraAdapter.fetchCaptions — textTracks (in-memory cues)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("reads cues directly from video.textTracks when already loaded", async () => {
    // Create a real <video> element with a <track> injected
    const video = document.createElement("video");
    document.body.appendChild(video);

    // Build a mock TextTrack with pre-loaded cues.
    // jsdom supports basic TextTrack but won't auto-parse VTT; we mock the
    // textTracks property directly for reliability.
    const mockCue1 = {
      startTime: 1.0,
      endTime: 4.5,
      text: "Welcome to this lecture on machine learning.",
    } as VTTCue;
    const mockCue2 = {
      startTime: 5.0,
      endTime: 9.0,
      text: "Today we will cover supervised learning.",
    } as VTTCue;

    const mockCueList = {
      length: 2,
      0: mockCue1,
      1: mockCue2,
      [Symbol.iterator]() {
        let i = 0;
        const arr = [mockCue1, mockCue2];
        return {
          next() {
            return i < arr.length
              ? { value: arr[i++]!, done: false }
              : { value: undefined, done: true as const };
          },
        };
      },
    } as unknown as TextTrackCueList;

    const mockTrack = {
      kind: "subtitles",
      language: "en",
      label: "English",
      mode: "showing" as TextTrackMode,
      cues: mockCueList,
    } as TextTrack;

    const mockTrackList = {
      length: 1,
      0: mockTrack,
      [Symbol.iterator]() {
        let i = 0;
        const arr = [mockTrack];
        return {
          next() {
            return i < arr.length
              ? { value: arr[i++]!, done: false }
              : { value: undefined, done: true as const };
          },
        };
      },
    } as unknown as TextTrackList;

    Object.defineProperty(video, "textTracks", {
      get: () => mockTrackList,
      configurable: true,
    });

    const signal = new AbortController().signal;
    const result = await courseraAdapter.fetchCaptions({
      videoId: "abc123",
      preferLang: "en",
      signal,
    });

    expect(result).not.toBeNull();
    expect(result!.captions).toHaveLength(2);
    expect(result!.captions[0]).toEqual({
      start: 1.0,
      end: 4.5,
      text: "Welcome to this lecture on machine learning.",
    });
    expect(result!.captions[1]).toEqual({
      start: 5.0,
      end: 9.0,
      text: "Today we will cover supervised learning.",
    });
    expect(result!.sourceLang).toBe("en");
    expect(result!.trackName).toBe("English");
  });

  it("prefers the preferLang track when multiple tracks are available", async () => {
    const video = document.createElement("video");
    document.body.appendChild(video);

    const enCue = { startTime: 1.0, endTime: 3.0, text: "Hello world." } as VTTCue;
    const viCue = { startTime: 1.0, endTime: 3.0, text: "Xin chào thế giới." } as VTTCue;

    const makeCueList = (cue: VTTCue) =>
      ({
        length: 1,
        0: cue,
        [Symbol.iterator]() {
          let i = 0;
          return {
            next() {
              return i < 1 ? { value: cue, done: false as const } : { value: undefined, done: true as const };
            },
          };
        },
      }) as unknown as TextTrackCueList;

    const enTrack = {
      kind: "subtitles",
      language: "en",
      label: "English",
      mode: "showing" as TextTrackMode,
      cues: makeCueList(enCue),
    } as TextTrack;

    const viTrack = {
      kind: "subtitles",
      language: "vi",
      label: "Vietnamese",
      mode: "showing" as TextTrackMode,
      cues: makeCueList(viCue),
    } as TextTrack;

    const mockTrackList = {
      length: 2,
      0: enTrack,
      1: viTrack,
      [Symbol.iterator]() {
        let i = 0;
        const arr = [enTrack, viTrack];
        return {
          next() {
            return i < arr.length ? { value: arr[i++]!, done: false as const } : { value: undefined, done: true as const };
          },
        };
      },
    } as unknown as TextTrackList;

    Object.defineProperty(video, "textTracks", {
      get: () => mockTrackList,
      configurable: true,
    });

    const signal = new AbortController().signal;
    const result = await courseraAdapter.fetchCaptions({
      videoId: "abc123",
      preferLang: "vi",
      signal,
    });

    expect(result).not.toBeNull();
    expect(result!.sourceLang).toBe("vi");
    expect(result!.captions[0]!.text).toBe("Xin chào thế giới.");
  });
});

// ─── fetchCaptions — Strategy 2: fetch <track>.src VTT ───────────────────────

describe("courseraAdapter.fetchCaptions — <track> src fetch", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("fetches and parses VTT from <track>.src when cues are empty", async () => {
    const video = document.createElement("video");
    document.body.appendChild(video);

    // <track> element with a src but no loaded cues (cues = null / empty)
    const trackEl = document.createElement("track") as HTMLTrackElement;
    trackEl.kind = "subtitles";
    trackEl.srclang = "en";
    trackEl.label = "English";
    trackEl.src = "https://d3c33hcgiwev3.cloudfront.net/en-captions.vtt";
    video.appendChild(trackEl);

    // Mock textTracks: has a track but with no cues
    const mockTrack = {
      kind: "subtitles",
      language: "en",
      label: "English",
      mode: "disabled" as TextTrackMode,
      cues: null,
    } as unknown as TextTrack;

    // Make el.track point to the mock track
    Object.defineProperty(trackEl, "track", {
      get: () => mockTrack,
      configurable: true,
    });

    const mockTrackList = {
      length: 1,
      0: mockTrack,
      [Symbol.iterator]() {
        let i = 0;
        return {
          next() {
            return i < 1
              ? { value: mockTrack, done: false as const }
              : { value: undefined, done: true as const };
          },
        };
      },
    } as unknown as TextTrackList;

    Object.defineProperty(video, "textTracks", {
      get: () => mockTrackList,
      configurable: true,
    });

    // Mock fetch to return the VTT fixture
    vi.mocked(fetch).mockImplementation(async (url: RequestInfo | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes("cloudfront.net")) {
        return new Response(FIXTURE_VTT, { status: 200 });
      }
      return new Response("", { status: 404 });
    });

    const signal = new AbortController().signal;
    const result = await courseraAdapter.fetchCaptions({
      videoId: "abc123",
      preferLang: "en",
      signal,
    });

    expect(result).not.toBeNull();
    expect(result!.captions).toHaveLength(3);
    expect(result!.captions[0]!.text).toBe(
      "Welcome to this lecture on machine learning.",
    );
    expect(result!.sourceLang).toBe("en");
  });
});

// ─── fetchCaptions — Strategy 3: Coursera API fallback ───────────────────────

describe("courseraAdapter.fetchCaptions — API fallback", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("falls back to api.coursera.org JSON → VTT fetch → parsed cues", async () => {
    // No video in the DOM → textTracks path is skipped
    vi.mocked(fetch).mockImplementation(async (url: RequestInfo | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes("onDemandLectureVideos")) {
        return new Response(JSON.stringify(FIXTURE_API_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (urlStr.includes("vtt/en-")) {
        return new Response(FIXTURE_VTT, { status: 200 });
      }
      return new Response("", { status: 404 });
    });

    const signal = new AbortController().signal;
    const result = await courseraAdapter.fetchCaptions({
      videoId: "lecture-abc123",
      preferLang: "en",
      signal,
    });

    expect(result).not.toBeNull();
    expect(result!.captions).toHaveLength(3);
    expect(result!.captions[0]!.start).toBeCloseTo(1.0);
    expect(result!.captions[0]!.end).toBeCloseTo(4.5);
    expect(result!.captions[0]!.text).toBe(
      "Welcome to this lecture on machine learning.",
    );
    expect(result!.sourceLang).toBe("en");
    expect(result!.trackName).toBe("en");
  });

  it("prefers the preferLang from the API response", async () => {
    vi.mocked(fetch).mockImplementation(async (url: RequestInfo | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes("onDemandLectureVideos")) {
        return new Response(JSON.stringify(FIXTURE_API_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (urlStr.includes("vtt/vi-")) {
        return new Response(FIXTURE_VTT, { status: 200 });
      }
      return new Response("", { status: 404 });
    });

    const signal = new AbortController().signal;
    const result = await courseraAdapter.fetchCaptions({
      videoId: "lecture-abc123",
      preferLang: "vi",
      signal,
    });

    expect(result).not.toBeNull();
    expect(result!.sourceLang).toBe("vi");
    // confirm the vi URL was requested
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      expect.stringContaining("vtt/vi-"),
      expect.any(Object),
    );
  });

  it("returns null when API returns a non-ok status", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("", { status: 404 }));

    const signal = new AbortController().signal;
    const result = await courseraAdapter.fetchCaptions({
      videoId: "nonexistent-lecture",
      signal,
    });

    expect(result).toBeNull();
  });

  it("returns null when API returns an empty elements array", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ elements: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const signal = new AbortController().signal;
    const result = await courseraAdapter.fetchCaptions({
      videoId: "lecture-no-elements",
      signal,
    });

    expect(result).toBeNull();
  });

  it("returns null when API element has no subtitlesVtt and no subtitles", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ elements: [{ id: "x" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const signal = new AbortController().signal;
    const result = await courseraAdapter.fetchCaptions({
      videoId: "lecture-no-subs",
      signal,
    });

    expect(result).toBeNull();
  });

  it("returns null when neither textTracks nor API yields anything", async () => {
    // No DOM video, API returns empty subtitlesVtt
    vi.mocked(fetch).mockImplementation(async (url: RequestInfo | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes("onDemandLectureVideos")) {
        return new Response(
          JSON.stringify({ elements: [{ id: "x", subtitlesVtt: {} }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("", { status: 404 });
    });

    const signal = new AbortController().signal;
    const result = await courseraAdapter.fetchCaptions({
      videoId: "lecture-empty-subs",
      signal,
    });

    expect(result).toBeNull();
  });

  it("returns null when fetch is aborted", async () => {
    const controller = new AbortController();
    vi.mocked(fetch).mockImplementation(async () => {
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    });

    const result = await courseraAdapter.fetchCaptions({
      videoId: "lecture-abc123",
      signal: controller.signal,
    });

    expect(result).toBeNull();
  });
});

// ─── Other adapter methods ────────────────────────────────────────────────────

describe("courseraAdapter — capabilities and other methods", () => {
  it("has the correct capability flags", () => {
    expect(courseraAdapter.id).toBe("coursera");
    expect(courseraAdapter.capabilities.audioCapture).toBe(true);
    expect(courseraAdapter.capabilities.subtitleFirst).toBe(true);
    expect(courseraAdapter.capabilities.isSpa).toBe(true);
    expect(courseraAdapter.capabilities.hasNativeCaptions).toBe(true);
    expect(courseraAdapter.capabilities.hasAdOverlays).toBe(false);
  });

  it("readLiveCaptionText returns null", () => {
    expect(courseraAdapter.readLiveCaptionText()).toBeNull();
  });

  it("stageInsets returns expected defaults", () => {
    const video = document.createElement("video");
    const insets = courseraAdapter.stageInsets(video);
    expect(insets.top).toBe(12);
    expect(insets.bottom).toBe(56);
    expect(insets.side).toBe(16);
  });

  it("findVideo returns null when no video in DOM", () => {
    document.body.innerHTML = "";
    expect(courseraAdapter.findVideo()).toBeNull();
  });

  it("findVideo returns the video element when present", () => {
    document.body.innerHTML = "";
    const video = document.createElement("video");
    document.body.appendChild(video);
    expect(courseraAdapter.findVideo()).toBe(video);
    document.body.innerHTML = "";
  });
});

// ─── suppressNativeCaptions ───────────────────────────────────────────────────

describe("courseraAdapter.suppressNativeCaptions", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("hides track elements and restores them on the returned fn call", () => {
    const video = document.createElement("video");
    document.body.appendChild(video);

    // Create a <track> with a mock TextTrack mode
    const trackEl = document.createElement("track") as HTMLTrackElement;
    trackEl.kind = "subtitles";
    video.appendChild(trackEl);

    const mockTrack = { mode: "showing" as TextTrackMode };
    Object.defineProperty(trackEl, "track", {
      get: () => mockTrack,
      configurable: true,
    });

    const restore = courseraAdapter.suppressNativeCaptions!();
    expect(mockTrack.mode).toBe("hidden");

    restore();
    expect(mockTrack.mode).toBe("showing");
  });

  it("returns a no-op restore fn gracefully when no video is in the DOM", () => {
    document.body.innerHTML = "";
    expect(() => {
      const restore = courseraAdapter.suppressNativeCaptions!();
      restore();
    }).not.toThrow();
  });
});
