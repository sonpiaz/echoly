// @vitest-environment jsdom
//
// Unit tests for the Udemy platform adapter.
//
// - Capabilities (DRM guard: audioCapture===false, subtitleFirst===true)
// - matchesHost / isWatchUrl / getVideoId
// - fetchCaptions: (a) happy path with DOM fixture + mocked API + mocked VTT
//                  (b) null when asset.captions is empty/absent
// - readLiveCaptionText → null
//
// All fetch calls are intercepted with vi.stubGlobal("fetch", ...).
// No real network calls are made.

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { udemyAdapter } from "@/platforms/udemy/adapter";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SAMPLE_VTT = `WEBVTT

1
00:00:01.000 --> 00:00:03.500
Hello and welcome to this lecture.

2
00:00:04.000 --> 00:00:07.000
Today we cover arrays and loops.
`;

/** A minimal api-2.0 lecture response with one English caption track. */
function makeLectureJson(captions: unknown[]): Record<string, unknown> {
  return {
    _class: "lecture",
    id: 99991234,
    asset: {
      asset_type: "Video",
      captions,
    },
  };
}

/** Install .ud-app-loader with courseId=42 into the DOM. */
function installAppLoader(courseId: number | string = 42): void {
  const el = document.createElement("div");
  el.className = "ud-app-loader";
  el.setAttribute(
    "data-module-args",
    JSON.stringify({ courseId, initialCurriculumItemId: 99991234 }),
  );
  document.body.appendChild(el);
}

/** Mock global fetch with a sequence of responses. */
function mockFetch(responses: Array<{ ok: boolean; body: unknown }>): void {
  let callIndex = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, _init?: unknown) => {
      const resp = responses[callIndex] ?? responses[responses.length - 1]!;
      callIndex += 1;
      return {
        ok: resp.ok,
        json: async () => resp.body,
        text: async () => (typeof resp.body === "string" ? resp.body : JSON.stringify(resp.body)),
      };
    }),
  );
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Capabilities ─────────────────────────────────────────────────────────────

describe("capabilities", () => {
  it("audioCapture is false (DRM guard — Widevine blocks captureStream)", () => {
    expect(udemyAdapter.capabilities.audioCapture).toBe(false);
  });

  it("subtitleFirst is true (caption-driven dub is the only viable path)", () => {
    expect(udemyAdapter.capabilities.subtitleFirst).toBe(true);
  });

  it("isSpa is true (React SPA with history.pushState navigation)", () => {
    expect(udemyAdapter.capabilities.isSpa).toBe(true);
  });

  it("hasNativeCaptions is true", () => {
    expect(udemyAdapter.capabilities.hasNativeCaptions).toBe(true);
  });

  it("hasAdOverlays is false", () => {
    expect(udemyAdapter.capabilities.hasAdOverlays).toBe(false);
  });

  it("id is 'udemy'", () => {
    expect(udemyAdapter.id).toBe("udemy");
  });
});

// ─── matchesHost ──────────────────────────────────────────────────────────────

describe("matchesHost", () => {
  it("returns true for 'udemy.com'", () => {
    expect(udemyAdapter.matchesHost("udemy.com")).toBe(true);
  });

  it("returns true for 'www.udemy.com'", () => {
    expect(udemyAdapter.matchesHost("www.udemy.com")).toBe(true);
  });

  it("returns true for subdomains like 'business.udemy.com'", () => {
    expect(udemyAdapter.matchesHost("business.udemy.com")).toBe(true);
  });

  it("returns false for 'youtube.com'", () => {
    expect(udemyAdapter.matchesHost("youtube.com")).toBe(false);
  });

  it("returns false for 'notudemy.com'", () => {
    expect(udemyAdapter.matchesHost("notudemy.com")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(udemyAdapter.matchesHost("")).toBe(false);
  });
});

// ─── isWatchUrl ───────────────────────────────────────────────────────────────

describe("isWatchUrl", () => {
  it("returns true for a lecture URL", () => {
    expect(
      udemyAdapter.isWatchUrl("https://www.udemy.com/course/python-bootcamp/learn/lecture/123"),
    ).toBe(true);
  });

  it("returns true for a lecture URL with trailing slash", () => {
    expect(
      udemyAdapter.isWatchUrl("https://www.udemy.com/course/some-course/learn/lecture/456789/"),
    ).toBe(true);
  });

  it("returns false for the course listing root", () => {
    expect(udemyAdapter.isWatchUrl("https://www.udemy.com/course/python-bootcamp/")).toBe(false);
  });

  it("returns false for /learn/ without /lecture/", () => {
    expect(
      udemyAdapter.isWatchUrl("https://www.udemy.com/course/python-bootcamp/learn/"),
    ).toBe(false);
  });

  it("returns false for the Udemy homepage", () => {
    expect(udemyAdapter.isWatchUrl("https://www.udemy.com/")).toBe(false);
  });

  it("returns false for a quiz URL", () => {
    expect(
      udemyAdapter.isWatchUrl("https://www.udemy.com/course/python-bootcamp/learn/quiz/123456/"),
    ).toBe(false);
  });

  it("returns false for an invalid URL string", () => {
    expect(udemyAdapter.isWatchUrl("not-a-url")).toBe(false);
  });
});

// ─── getVideoId ───────────────────────────────────────────────────────────────

describe("getVideoId", () => {
  it("extracts the lecture id from a standard lecture URL", () => {
    expect(
      udemyAdapter.getVideoId("https://www.udemy.com/course/python-bootcamp/learn/lecture/123"),
    ).toBe("123");
  });

  it("extracts a longer numeric lecture id", () => {
    expect(
      udemyAdapter.getVideoId(
        "https://www.udemy.com/course/react-course/learn/lecture/98765432/",
      ),
    ).toBe("98765432");
  });

  it("returns null for a non-lecture URL", () => {
    expect(
      udemyAdapter.getVideoId("https://www.udemy.com/course/python-bootcamp/learn/"),
    ).toBeNull();
  });

  it("returns null for the homepage", () => {
    expect(udemyAdapter.getVideoId("https://www.udemy.com/")).toBeNull();
  });

  it("returns null for an invalid URL", () => {
    expect(udemyAdapter.getVideoId("not-a-url")).toBeNull();
  });
});

// ─── fetchCaptions — happy path ───────────────────────────────────────────────

describe("fetchCaptions — happy path", () => {
  it("parses English captions when preferLang matches locale_id prefix", async () => {
    installAppLoader(42);

    const captions = [
      { locale_id: "en_US", video_label: "English", url: "https://cdn.udemy.com/captions/en.vtt", title: "English (auto)" },
      { locale_id: "es_ES", video_label: "Spanish", url: "https://cdn.udemy.com/captions/es.vtt", title: "Spanish" },
    ];

    mockFetch([
      { ok: true, body: makeLectureJson(captions) },
      { ok: true, body: SAMPLE_VTT },
    ]);

    const signal = new AbortController().signal;
    const result = await udemyAdapter.fetchCaptions({
      videoId: "99991234",
      preferLang: "en",
      signal,
    });

    expect(result).not.toBeNull();
    expect(result!.captions.length).toBeGreaterThan(0);
    expect(result!.captions[0]!.start).toBeCloseTo(1.0);
    expect(result!.captions[0]!.end).toBeCloseTo(3.5);
    expect(result!.captions[0]!.text).toBe("Hello and welcome to this lecture.");
    expect(result!.sourceLang).toBe("en_US");
    expect(result!.trackName).toBe("English (auto)");
  });

  it("picks the Spanish track when preferLang='es'", async () => {
    installAppLoader(42);

    const SPANISH_VTT = `WEBVTT

1
00:00:01.000 --> 00:00:03.000
Hola y bienvenidos.
`;

    const captions = [
      { locale_id: "en_US", video_label: "English", url: "https://cdn.udemy.com/captions/en.vtt" },
      { locale_id: "es_ES", video_label: "Spanish", url: "https://cdn.udemy.com/captions/es.vtt", title: "Spanish" },
    ];

    mockFetch([
      { ok: true, body: makeLectureJson(captions) },
      { ok: true, body: SPANISH_VTT },
    ]);

    const signal = new AbortController().signal;
    const result = await udemyAdapter.fetchCaptions({
      videoId: "99991234",
      preferLang: "es",
      signal,
    });

    expect(result).not.toBeNull();
    expect(result!.sourceLang).toBe("es_ES");
    expect(result!.captions[0]!.text).toBe("Hola y bienvenidos.");
  });

  it("falls back to the first track when preferLang has no match", async () => {
    installAppLoader(42);

    const captions = [
      { locale_id: "pt_BR", video_label: "Portuguese", url: "https://cdn.udemy.com/captions/pt.vtt", title: "Portuguese" },
    ];

    mockFetch([
      { ok: true, body: makeLectureJson(captions) },
      { ok: true, body: SAMPLE_VTT },
    ]);

    const signal = new AbortController().signal;
    const result = await udemyAdapter.fetchCaptions({
      videoId: "99991234",
      preferLang: "zh",
      signal,
    });

    expect(result).not.toBeNull();
    expect(result!.sourceLang).toBe("pt_BR");
  });

  it("calls the api-2.0 endpoint with the correct courseId and lectureId", async () => {
    installAppLoader(7777);

    const captions = [
      { locale_id: "en_US", url: "https://cdn.udemy.com/captions/en.vtt" },
    ];

    const fetchMock = vi.fn(async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes("api-2.0")) {
        return { ok: true, json: async () => makeLectureJson(captions), text: async () => "" };
      }
      return { ok: true, json: async () => ({}), text: async () => SAMPLE_VTT };
    });
    vi.stubGlobal("fetch", fetchMock);

    const signal = new AbortController().signal;
    await udemyAdapter.fetchCaptions({ videoId: "12345", preferLang: "en", signal });

    const firstCall = fetchMock.mock.calls[0]![0] as string;
    expect(firstCall).toContain("/7777/");
    expect(firstCall).toContain("/12345/");
    expect(firstCall).toContain("fields[asset]=captions");
  });
});

// ─── fetchCaptions — null / no-caption cases ──────────────────────────────────

describe("fetchCaptions — no captions (null path)", () => {
  it("returns null when asset.captions is an empty array", async () => {
    installAppLoader(42);

    mockFetch([{ ok: true, body: makeLectureJson([]) }]);

    const signal = new AbortController().signal;
    const result = await udemyAdapter.fetchCaptions({ videoId: "99991234", signal });

    expect(result).toBeNull();
  });

  it("returns null when asset.captions is absent", async () => {
    installAppLoader(42);

    mockFetch([
      { ok: true, body: { _class: "lecture", asset: { asset_type: "Video" } } },
    ]);

    const signal = new AbortController().signal;
    const result = await udemyAdapter.fetchCaptions({ videoId: "99991234", signal });

    expect(result).toBeNull();
  });

  it("returns null when the asset field itself is absent", async () => {
    installAppLoader(42);

    mockFetch([{ ok: true, body: { _class: "lecture" } }]);

    const signal = new AbortController().signal;
    const result = await udemyAdapter.fetchCaptions({ videoId: "99991234", signal });

    expect(result).toBeNull();
  });

  it("returns null when no .ud-app-loader is in the DOM (courseId not found)", async () => {
    // Do NOT call installAppLoader — empty DOM
    const signal = new AbortController().signal;
    const result = await udemyAdapter.fetchCaptions({ videoId: "99991234", signal });

    expect(result).toBeNull();
  });

  it("returns null when the API returns a non-ok status", async () => {
    installAppLoader(42);
    mockFetch([{ ok: false, body: { detail: "Authentication credentials were not provided." } }]);

    const signal = new AbortController().signal;
    const result = await udemyAdapter.fetchCaptions({ videoId: "99991234", signal });

    expect(result).toBeNull();
  });

  it("returns null when fetch throws (e.g. AbortError)", async () => {
    installAppLoader(42);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation was aborted.", "AbortError");
      }),
    );

    const signal = new AbortController().signal;
    const result = await udemyAdapter.fetchCaptions({ videoId: "99991234", signal });

    expect(result).toBeNull();
  });

  it("returns null when the VTT fetch fails", async () => {
    installAppLoader(42);

    const captions = [{ locale_id: "en_US", url: "https://cdn.udemy.com/captions/en.vtt" }];

    mockFetch([
      { ok: true, body: makeLectureJson(captions) },
      { ok: false, body: "Not Found" },
    ]);

    const signal = new AbortController().signal;
    const result = await udemyAdapter.fetchCaptions({ videoId: "99991234", signal });

    expect(result).toBeNull();
  });

  it("returns null when the VTT is empty / yields no parseable cues", async () => {
    installAppLoader(42);

    const captions = [{ locale_id: "en_US", url: "https://cdn.udemy.com/captions/en.vtt" }];

    mockFetch([
      { ok: true, body: makeLectureJson(captions) },
      { ok: true, body: "WEBVTT\n\n" }, // valid header but no cues
    ]);

    const signal = new AbortController().signal;
    const result = await udemyAdapter.fetchCaptions({ videoId: "99991234", signal });

    expect(result).toBeNull();
  });
});

// ─── readLiveCaptionText ──────────────────────────────────────────────────────

describe("readLiveCaptionText", () => {
  it("returns null (no live-caption DOM scraping on Udemy)", () => {
    expect(udemyAdapter.readLiveCaptionText()).toBeNull();
  });
});

// ─── findVideo ───────────────────────────────────────────────────────────────

describe("findVideo", () => {
  it("returns the video element when present", () => {
    const video = document.createElement("video");
    document.body.appendChild(video);
    expect(udemyAdapter.findVideo()).toBe(video);
  });

  it("returns null when no video element is in the DOM", () => {
    expect(udemyAdapter.findVideo()).toBeNull();
  });
});

// ─── stageInsets ─────────────────────────────────────────────────────────────

describe("stageInsets", () => {
  it("returns the expected Udemy player chrome insets", () => {
    const video = document.createElement("video");
    const insets = udemyAdapter.stageInsets(video);
    expect(insets).toEqual({ top: 12, bottom: 72, side: 16 });
  });
});

// ─── VTT fetch credentials bug fix ───────────────────────────────────────────
//
// The VTT fetch must include credentials:"include" to avoid silent 403 errors
// on CDN URLs that rely on session cookies.

describe("fetchCaptions — VTT fetch credentials", () => {
  it("calls the VTT URL with credentials:'include'", async () => {
    installAppLoader(42);

    const captions = [
      { locale_id: "en_US", video_label: "English", url: "https://cdn.udemy.com/captions/en.vtt", title: "English" },
    ];

    const fetchMock = vi.fn(async (url: unknown, init?: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes("api-2.0")) {
        return {
          ok: true,
          json: async () => makeLectureJson(captions),
          text: async () => "",
        };
      }
      // VTT fetch
      return {
        ok: true,
        json: async () => ({}),
        text: async () => SAMPLE_VTT,
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const signal = new AbortController().signal;
    await udemyAdapter.fetchCaptions({ videoId: "99991234", preferLang: "en", signal });

    // Find the VTT fetch call (second call, to cdn.udemy.com)
    const vttCall = fetchMock.mock.calls.find(
      (call) => String(call[0]).includes("cdn.udemy.com"),
    );
    expect(vttCall).toBeDefined();
    expect(vttCall![1]).toMatchObject({ credentials: "include" });
  });
});

// ─── suppressNativeCaptions ──────────────────────────────────────────────────

describe("suppressNativeCaptions", () => {
  it("hides a showing TextTrack and restore re-enables it", () => {
    const video = document.createElement("video");
    document.body.appendChild(video);

    // jsdom's TextTrack support is minimal — fake a track object
    const fakeTrack = { mode: "showing" as TextTrackMode };
    Object.defineProperty(video, "textTracks", {
      value: [fakeTrack],
      configurable: true,
    });

    const restore = udemyAdapter.suppressNativeCaptions!();
    expect(fakeTrack.mode).toBe("hidden");

    restore();
    expect(fakeTrack.mode).toBe("showing");
  });

  it("does not touch tracks that are already hidden/disabled", () => {
    const video = document.createElement("video");
    document.body.appendChild(video);

    const fakeTrack = { mode: "disabled" as TextTrackMode };
    Object.defineProperty(video, "textTracks", {
      value: [fakeTrack],
      configurable: true,
    });

    const restore = udemyAdapter.suppressNativeCaptions!();
    expect(fakeTrack.mode).toBe("disabled"); // unchanged

    restore();
    expect(fakeTrack.mode).toBe("disabled"); // still unchanged
  });

  it("is a no-op when no video element exists", () => {
    // No video in DOM — should not throw
    expect(() => {
      const restore = udemyAdapter.suppressNativeCaptions!();
      restore();
    }).not.toThrow();
  });
});
