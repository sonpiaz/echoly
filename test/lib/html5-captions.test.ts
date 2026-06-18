// @vitest-environment jsdom
//
// Unit tests for src/lib/html5-captions.ts — the shared HTML5 text-track
// caption fetcher.
//
// Covers:
//   1. already-loaded video.textTracks cues → returns CaptionCue[]
//   2. no cues, but <track src> present → fetch (credentials:"include") + parseVtt
//   3. no tracks at all → null
//   4. abort signal honored (already-aborted + mid-fetch abort)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchHtml5TextTrackCaptions } from "@/lib/html5-captions";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FIXTURE_VTT = `WEBVTT

1
00:00:01.000 --> 00:00:04.000
Hello from a track element.

2
00:00:05.000 --> 00:00:08.500
This is the second cue.
`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal mock TextTrackCueList from an array of partial VTTCue objects. */
function makeCueList(cues: Array<{ startTime: number; endTime: number; text: string }>): TextTrackCueList {
  const items = cues as unknown as VTTCue[];
  return {
    length: items.length,
    ...Object.fromEntries(items.map((c, i) => [i, c])),
    [Symbol.iterator]() {
      let i = 0;
      return {
        next() {
          return i < items.length
            ? { value: items[i++]!, done: false as const }
            : { value: undefined as unknown as VTTCue, done: true as const };
        },
      };
    },
  } as unknown as TextTrackCueList;
}

/** Build a mock TextTrackList with the given tracks. */
function makeTrackList(tracks: TextTrack[]): TextTrackList {
  return {
    length: tracks.length,
    ...Object.fromEntries(tracks.map((t, i) => [i, t])),
    [Symbol.iterator]() {
      let i = 0;
      return {
        next() {
          return i < tracks.length
            ? { value: tracks[i++]!, done: false as const }
            : { value: undefined as unknown as TextTrack, done: true as const };
        },
      };
    },
  } as unknown as TextTrackList;
}

/** Build a mock TextTrack. */
function makeTrack(
  kind: "subtitles" | "captions",
  language: string,
  label: string,
  cues: TextTrackCueList | null,
): TextTrack {
  return {
    kind,
    language,
    label,
    mode: "showing" as TextTrackMode,
    cues,
  } as unknown as TextTrack;
}

// ─── 1. Already-loaded textTracks cues ───────────────────────────────────────

describe("fetchHtml5TextTrackCaptions — loaded cues", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("returns cues from loaded textTracks (subtitles kind)", async () => {
    const video = document.createElement("video");
    document.body.appendChild(video);

    const cues = makeCueList([
      { startTime: 1.0, endTime: 4.0, text: "Hello from a track element." },
      { startTime: 5.0, endTime: 8.5, text: "This is the second cue." },
    ]);
    const track = makeTrack("subtitles", "en", "English", cues);
    const trackList = makeTrackList([track]);

    Object.defineProperty(video, "textTracks", {
      get: () => trackList,
      configurable: true,
    });

    const result = await fetchHtml5TextTrackCaptions(video, { preferLang: "en" });

    expect(result).not.toBeNull();
    expect(result!.captions).toHaveLength(2);
    expect(result!.captions[0]).toEqual({ start: 1.0, end: 4.0, text: "Hello from a track element." });
    expect(result!.captions[1]).toEqual({ start: 5.0, end: 8.5, text: "This is the second cue." });
    expect(result!.sourceLang).toBe("en");
    expect(result!.trackName).toBe("English");
  });

  it("returns cues from loaded textTracks (captions kind)", async () => {
    const video = document.createElement("video");
    document.body.appendChild(video);

    const cues = makeCueList([
      { startTime: 2.0, endTime: 5.0, text: "Caption cue text." },
    ]);
    const track = makeTrack("captions", "fr", "French", cues);
    const trackList = makeTrackList([track]);

    Object.defineProperty(video, "textTracks", {
      get: () => trackList,
      configurable: true,
    });

    const result = await fetchHtml5TextTrackCaptions(video);

    expect(result).not.toBeNull();
    expect(result!.captions).toHaveLength(1);
    expect(result!.sourceLang).toBe("fr");
  });

  it("picks the preferLang track when multiple tracks are present", async () => {
    const video = document.createElement("video");
    document.body.appendChild(video);

    const enCues = makeCueList([{ startTime: 1.0, endTime: 3.0, text: "English cue." }]);
    const viCues = makeCueList([{ startTime: 1.0, endTime: 3.0, text: "Câu tiếng Việt." }]);
    const enTrack = makeTrack("subtitles", "en", "English", enCues);
    const viTrack = makeTrack("subtitles", "vi", "Vietnamese", viCues);
    const trackList = makeTrackList([enTrack, viTrack]);

    Object.defineProperty(video, "textTracks", {
      get: () => trackList,
      configurable: true,
    });

    const result = await fetchHtml5TextTrackCaptions(video, { preferLang: "vi" });

    expect(result).not.toBeNull();
    expect(result!.sourceLang).toBe("vi");
    expect(result!.captions[0]!.text).toBe("Câu tiếng Việt.");
  });

  it("strips inline VTT tags from cue text", async () => {
    const video = document.createElement("video");
    document.body.appendChild(video);

    const cues = makeCueList([
      { startTime: 1.0, endTime: 3.0, text: "<c.color.white>Hello</c> <i>world</i>." },
    ]);
    const track = makeTrack("subtitles", "en", "English", cues);
    const trackList = makeTrackList([track]);

    Object.defineProperty(video, "textTracks", {
      get: () => trackList,
      configurable: true,
    });

    const result = await fetchHtml5TextTrackCaptions(video, { preferLang: "en" });

    expect(result).not.toBeNull();
    expect(result!.captions[0]!.text).toBe("Hello world.");
  });

  it("RC4: activates a disabled track (mode → hidden) and reads cues once they populate", async () => {
    const video = document.createElement("video");
    document.body.appendChild(video);

    // Real browsers expose cues === null on a "disabled" track and only parse them
    // once it is activated. Model that: cues appear after mode is set to hidden.
    const realCues = makeCueList([{ startTime: 1.0, endTime: 4.0, text: "Lazy-parsed cue." }]);
    let mode: TextTrackMode = "disabled";
    let parsed = false;
    let everActivated = false;
    const track = {
      kind: "subtitles",
      language: "en",
      label: "English",
      get mode() {
        return mode;
      },
      set mode(m: TextTrackMode) {
        mode = m;
        if (m === "hidden" || m === "showing") {
          parsed = true;
          everActivated = true;
        }
      },
      get cues() {
        return parsed ? realCues : null;
      },
    } as unknown as TextTrack;
    const trackList = makeTrackList([track]);

    Object.defineProperty(video, "textTracks", { get: () => trackList, configurable: true });

    const result = await fetchHtml5TextTrackCaptions(video, { preferLang: "en" });

    expect(result).not.toBeNull();
    expect(result!.captions).toHaveLength(1);
    expect(result!.captions[0]!.text).toBe("Lazy-parsed cue.");
    // It activated the disabled track to read cues (old code saw cues===null → null)…
    expect(everActivated).toBe(true);
    // …and restored the original disabled mode afterward (leave-no-trace).
    expect(mode).toBe("disabled");
  });
});

// ─── 2. No cues but <track src> present → fetch VTT ─────────────────────────

describe("fetchHtml5TextTrackCaptions — <track src> VTT fetch", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("fetches the <track src> with credentials:'include' when cues are empty", async () => {
    const video = document.createElement("video");
    document.body.appendChild(video);

    const trackEl = document.createElement("track") as HTMLTrackElement;
    trackEl.kind = "subtitles";
    trackEl.srclang = "en";
    trackEl.label = "English";
    trackEl.src = "https://cdn.example.com/en-captions.vtt";
    video.appendChild(trackEl);

    const mockTrack = {
      kind: "subtitles",
      language: "en",
      label: "English",
      mode: "disabled" as TextTrackMode,
      cues: null,
    } as unknown as TextTrack;

    Object.defineProperty(trackEl, "track", {
      get: () => mockTrack,
      configurable: true,
    });

    const trackList = makeTrackList([mockTrack]);
    Object.defineProperty(video, "textTracks", {
      get: () => trackList,
      configurable: true,
    });

    vi.mocked(fetch).mockResolvedValue(new Response(FIXTURE_VTT, { status: 200 }));

    const result = await fetchHtml5TextTrackCaptions(video, { preferLang: "en" });

    expect(result).not.toBeNull();
    expect(result!.captions).toHaveLength(2);
    expect(result!.captions[0]!.text).toBe("Hello from a track element.");
    expect(result!.sourceLang).toBe("en");

    // CRITICAL: must be called with credentials:"include"
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "https://cdn.example.com/en-captions.vtt",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("passes the AbortSignal to fetch", async () => {
    const video = document.createElement("video");
    document.body.appendChild(video);

    const trackEl = document.createElement("track") as HTMLTrackElement;
    trackEl.kind = "subtitles";
    trackEl.srclang = "en";
    trackEl.src = "https://cdn.example.com/en.vtt";
    video.appendChild(trackEl);

    const mockTrack = {
      kind: "subtitles",
      language: "en",
      label: "",
      mode: "disabled" as TextTrackMode,
      cues: null,
    } as unknown as TextTrack;

    Object.defineProperty(trackEl, "track", {
      get: () => mockTrack,
      configurable: true,
    });

    const trackList = makeTrackList([mockTrack]);
    Object.defineProperty(video, "textTracks", {
      get: () => trackList,
      configurable: true,
    });

    vi.mocked(fetch).mockResolvedValue(new Response(FIXTURE_VTT, { status: 200 }));

    const controller = new AbortController();
    await fetchHtml5TextTrackCaptions(video, { signal: controller.signal });

    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("returns null when the VTT fetch returns a non-ok status", async () => {
    const video = document.createElement("video");
    document.body.appendChild(video);

    const trackEl = document.createElement("track") as HTMLTrackElement;
    trackEl.kind = "subtitles";
    trackEl.srclang = "en";
    trackEl.src = "https://cdn.example.com/missing.vtt";
    video.appendChild(trackEl);

    const mockTrack = {
      kind: "subtitles",
      language: "en",
      label: "",
      mode: "disabled" as TextTrackMode,
      cues: null,
    } as unknown as TextTrack;

    Object.defineProperty(trackEl, "track", {
      get: () => mockTrack,
      configurable: true,
    });

    const trackList = makeTrackList([mockTrack]);
    Object.defineProperty(video, "textTracks", {
      get: () => trackList,
      configurable: true,
    });

    vi.mocked(fetch).mockResolvedValue(new Response("", { status: 404 }));

    const result = await fetchHtml5TextTrackCaptions(video, { preferLang: "en" });

    expect(result).toBeNull();
  });
});

// ─── 3. No tracks at all → null ──────────────────────────────────────────────

describe("fetchHtml5TextTrackCaptions — no tracks", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("returns null when textTracks is empty", async () => {
    const video = document.createElement("video");
    document.body.appendChild(video);

    const emptyList = makeTrackList([]);
    Object.defineProperty(video, "textTracks", {
      get: () => emptyList,
      configurable: true,
    });

    const result = await fetchHtml5TextTrackCaptions(video, { preferLang: "en" });

    expect(result).toBeNull();
  });

  it("returns null when track has no cues and no <track> element", async () => {
    const video = document.createElement("video");
    document.body.appendChild(video);

    const track = makeTrack("subtitles", "en", "English", null);
    const trackList = makeTrackList([track]);

    Object.defineProperty(video, "textTracks", {
      get: () => trackList,
      configurable: true,
    });

    // No <track> element appended to video → findTrackElement returns null

    const result = await fetchHtml5TextTrackCaptions(video);

    expect(result).toBeNull();
  });
});

// ─── 4. Abort signal honored ──────────────────────────────────────────────────

describe("fetchHtml5TextTrackCaptions — abort signal", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("returns null immediately when signal is already aborted", async () => {
    const video = document.createElement("video");
    document.body.appendChild(video);

    const controller = new AbortController();
    controller.abort();

    const result = await fetchHtml5TextTrackCaptions(video, { signal: controller.signal });

    expect(result).toBeNull();
    // fetch must NOT have been called
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("returns null when fetch throws AbortError", async () => {
    const video = document.createElement("video");
    document.body.appendChild(video);

    const trackEl = document.createElement("track") as HTMLTrackElement;
    trackEl.kind = "subtitles";
    trackEl.srclang = "en";
    trackEl.src = "https://cdn.example.com/en.vtt";
    video.appendChild(trackEl);

    const mockTrack = {
      kind: "subtitles",
      language: "en",
      label: "",
      mode: "disabled" as TextTrackMode,
      cues: null,
    } as unknown as TextTrack;

    Object.defineProperty(trackEl, "track", {
      get: () => mockTrack,
      configurable: true,
    });

    const trackList = makeTrackList([mockTrack]);
    Object.defineProperty(video, "textTracks", {
      get: () => trackList,
      configurable: true,
    });

    vi.mocked(fetch).mockRejectedValue(new DOMException("Aborted", "AbortError"));

    const controller = new AbortController();
    controller.abort();
    const result = await fetchHtml5TextTrackCaptions(video, { signal: controller.signal });

    expect(result).toBeNull();
  });
});
