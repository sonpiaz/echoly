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

/** Install the CURRENT taking-page element [data-module-id="course-taking"]. */
function installCourseTaking(courseId: number | string = 555): void {
  const el = document.createElement("div");
  el.setAttribute("data-module-id", "course-taking");
  el.setAttribute(
    "data-module-args",
    JSON.stringify({ courseId, initialCurriculumItemId: 99991234 }),
  );
  document.body.appendChild(el);
}

/** Embed a bootstrap <script> JSON blob carrying "courseId":N. */
function installScriptBootstrap(courseId: number | string = 8888): void {
  const s = document.createElement("script");
  s.textContent = `window.__INITIAL__ = {"course":{"courseId":${courseId},"title":"x"}};`;
  document.body.appendChild(s);
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
  // innerHTML="" clears CHILDREN but not body ATTRIBUTES — the data-course-id /
  // data-clp-course-id fallback fixtures would otherwise leak across tests.
  document.body.removeAttribute("data-course-id");
  document.body.removeAttribute("data-clp-course-id");
  // Reset the URL so extractSlug() is null by default (each slug-test sets its own).
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

/** Point the jsdom URL at a Udemy lecture so extractSlug() resolves <slug>. */
function setLectureUrl(slug: string, lectureId = "12345"): void {
  window.history.replaceState(null, "", `/course/${slug}/learn/lecture/${lectureId}`);
}

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

// ─── VTT fetch credentials ───────────────────────────────────────────────────
//
// The VTT lives on a CROSS-ORIGIN CloudFront host (vtt-c.udemycdn.com) served
// with a wildcard `Access-Control-Allow-Origin`; per the Fetch spec a credentialed
// request to a `*`-ACAO response is blocked ("Access-Control-Allow-Credentials …
// must be 'true'"). The signed URL (Expires/Signature/Key-Pair-Id) is self-
// authenticating, so the CDN GET must use credentials:"omit". The SAME-ORIGIN
// api-2.0 metadata call (www.udemy.com) keeps "include" so its session cookies
// flow. (Earlier this asserted "include" on the VTT — that WAS the CORS bug.)

describe("fetchCaptions — VTT fetch credentials", () => {
  it("uses credentials:'omit' for the cross-origin VTT but 'include' for api-2.0", async () => {
    installAppLoader(42);

    const captions = [
      {
        locale_id: "en_US",
        video_label: "English",
        url: "https://vtt-c.udemycdn.com/captions/en.vtt?Expires=1&Signature=sig&Key-Pair-Id=kp",
        title: "English",
      },
    ];

    const fetchMock = vi.fn(async (url: unknown, _init?: unknown) => {
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

    const apiCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("api-2.0"));
    const vttCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("udemycdn.com"));
    expect(apiCall).toBeDefined();
    expect(apiCall![1]).toMatchObject({ credentials: "include" });
    expect(vttCall).toBeDefined();
    expect(vttCall![1]).toMatchObject({ credentials: "omit" });
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

// ─── extractCourseId waterfall (the real bug) ─────────────────────────────────
//
// The reported defect: on the current React taking page, courseId lives in
// [data-module-id="course-taking"], NOT the legacy `.ud-app-loader`. These tests
// pin every step of the waterfall so the primary path is exercised.

describe("courseId extraction waterfall", () => {
  it("PRIMARY: reads courseId from [data-module-id='course-taking']", async () => {
    installCourseTaking(555);
    const captions = [{ locale_id: "en_US", url: "https://cdn.udemy.com/captions/en.vtt" }];
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes("api-2.0")) {
        return { ok: true, json: async () => makeLectureJson(captions), text: async () => "" };
      }
      return { ok: true, json: async () => ({}), text: async () => SAMPLE_VTT };
    });
    vi.stubGlobal("fetch", fetchMock);

    await udemyAdapter.fetchCaptions({ videoId: "12345", preferLang: "en", signal: new AbortController().signal });

    expect(String(fetchMock.mock.calls[0]![0])).toContain("/555/");
  });

  it("FALLBACK: legacy .ud-app-loader still works when course-taking is absent", async () => {
    installAppLoader(42);
    const captions = [{ locale_id: "en_US", url: "https://cdn.udemy.com/captions/en.vtt" }];
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes("api-2.0")) {
        return { ok: true, json: async () => makeLectureJson(captions), text: async () => "" };
      }
      return { ok: true, json: async () => ({}), text: async () => SAMPLE_VTT };
    });
    vi.stubGlobal("fetch", fetchMock);

    await udemyAdapter.fetchCaptions({ videoId: "12345", preferLang: "en", signal: new AbortController().signal });

    expect(String(fetchMock.mock.calls[0]![0])).toContain("/42/");
  });

  it("FALLBACK: regex over <script> JSON when no module element exists", async () => {
    installScriptBootstrap(8888);
    const captions = [{ locale_id: "en_US", url: "https://cdn.udemy.com/captions/en.vtt" }];
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes("api-2.0")) {
        return { ok: true, json: async () => makeLectureJson(captions), text: async () => "" };
      }
      return { ok: true, json: async () => ({}), text: async () => SAMPLE_VTT };
    });
    vi.stubGlobal("fetch", fetchMock);

    await udemyAdapter.fetchCaptions({ videoId: "12345", preferLang: "en", signal: new AbortController().signal });

    expect(String(fetchMock.mock.calls[0]![0])).toContain("/8888/");
  });

  it("FALLBACK: body[data-course-id] when nothing else is present", async () => {
    document.body.setAttribute("data-course-id", "31337");
    const captions = [{ locale_id: "en_US", url: "https://cdn.udemy.com/captions/en.vtt" }];
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes("api-2.0")) {
        return { ok: true, json: async () => makeLectureJson(captions), text: async () => "" };
      }
      return { ok: true, json: async () => ({}), text: async () => SAMPLE_VTT };
    });
    vi.stubGlobal("fetch", fetchMock);

    await udemyAdapter.fetchCaptions({ videoId: "12345", preferLang: "en", signal: new AbortController().signal });

    expect(String(fetchMock.mock.calls[0]![0])).toContain("/31337/");
  });

  it("course-taking takes priority over the legacy loader when both exist", async () => {
    installCourseTaking(555);
    installAppLoader(42);
    const captions = [{ locale_id: "en_US", url: "https://cdn.udemy.com/captions/en.vtt" }];
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes("api-2.0")) {
        return { ok: true, json: async () => makeLectureJson(captions), text: async () => "" };
      }
      return { ok: true, json: async () => ({}), text: async () => SAMPLE_VTT };
    });
    vi.stubGlobal("fetch", fetchMock);

    await udemyAdapter.fetchCaptions({ videoId: "12345", preferLang: "en", signal: new AbortController().signal });

    expect(String(fetchMock.mock.calls[0]![0])).toContain("/555/");
  });
});

// ─── ROBUST PATH: slug → courseId via subscribed-courses list API ─────────────
//
// The real bug (yt-dlp #15681): DOM courseId scraping is unreliable on the
// current Udemy taking page. When no DOM courseId is found, resolve the numeric
// courseId from the URL slug via the enrollment-list API, then call captions.

describe("courseId via subscribed-courses API (no DOM)", () => {
  it("resolves courseId from slug when the DOM has no courseId", async () => {
    // empty DOM, but the URL carries the slug
    setLectureUrl("the-complete-guide", "777");
    const enrollments = {
      results: [
        { id: 111, published_title: "some-other-course", url: "/course/some-other-course/" },
        { id: 4242, published_title: "the-complete-guide", url: "/course/the-complete-guide/" },
      ],
    };
    const captions = [{ locale_id: "en_US", source: "manual", url: "https://cdn.udemy.com/en.vtt" }];

    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("subscribed-courses/?") || (u.includes("subscribed-courses/") && u.includes("page_size"))) {
        return { ok: true, json: async () => enrollments, text: async () => "" };
      }
      if (u.includes("/lectures/")) {
        return { ok: true, json: async () => makeLectureJson(captions), text: async () => "" };
      }
      return { ok: true, json: async () => ({}), text: async () => SAMPLE_VTT };
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await udemyAdapter.fetchCaptions({
      videoId: "777",
      preferLang: "en",
      signal: new AbortController().signal,
    });

    expect(result).not.toBeNull();
    // First call = enrollment list; the lecture call must use the matched courseId 4242.
    expect(calls[0]).toContain("subscribed-courses/?");
    const lectureCall = calls.find((u) => u.includes("/lectures/777"));
    expect(lectureCall).toContain("/4242/");
  });

  it("returns null + logs when the slug is not in the enrollment list (not enrolled)", async () => {
    setLectureUrl("a-course-i-do-not-own", "999");
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes("subscribed-courses/?")) {
        return { ok: true, json: async () => ({ results: [{ id: 1, published_title: "other" }] }), text: async () => "" };
      }
      return { ok: true, json: async () => ({}), text: async () => "" };
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await udemyAdapter.fetchCaptions({ videoId: "999", signal: new AbortController().signal });

    expect(result).toBeNull();
    expect(infoSpy).toHaveBeenCalledWith(
      "[echoly-cc]", "udemy:", "slug not found in subscribed-courses (not enrolled / preview?)",
      expect.objectContaining({ slug: "a-course-i-do-not-own" }),
    );
    // The lecture caption endpoint must NOT be called without a courseId.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/lectures/"))).toBe(false);
    infoSpy.mockRestore();
  });

  it("logs the status when the enrollment-list API returns non-ok (e.g. 403)", async () => {
    setLectureUrl("gated-course", "1");
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => "" })));

    await udemyAdapter.fetchCaptions({ videoId: "1", signal: new AbortController().signal });

    expect(infoSpy).toHaveBeenCalledWith(
      "[echoly-cc]", "udemy:", "subscribed-courses list non-ok",
      expect.objectContaining({ status: 403 }),
    );
    infoSpy.mockRestore();
  });

  it("prefers the DOM fast-path and skips the enrollment API when courseId is in the DOM", async () => {
    setLectureUrl("has-dom-courseid", "5");
    installCourseTaking(8080);
    const captions = [{ locale_id: "en_US", source: "manual", url: "https://cdn.udemy.com/en.vtt" }];
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: unknown) => {
      calls.push(String(url));
      if (String(url).includes("/lectures/")) {
        return { ok: true, json: async () => makeLectureJson(captions), text: async () => "" };
      }
      return { ok: true, json: async () => ({}), text: async () => SAMPLE_VTT };
    });
    vi.stubGlobal("fetch", fetchMock);

    await udemyAdapter.fetchCaptions({ videoId: "5", preferLang: "en", signal: new AbortController().signal });

    // No enrollment-list call — DOM courseId 8080 used directly.
    expect(calls.some((u) => u.includes("subscribed-courses/?"))).toBe(false);
    expect(calls[0]).toContain("/8080/");
  });
});

// ─── caption sends x-udemy-cache-logged-in header ─────────────────────────────

describe("fetchCaptions — request headers", () => {
  it("sends x-udemy-cache-logged-in:1 on the api-2.0 call", async () => {
    installCourseTaking(555);
    const captions = [{ locale_id: "en_US", url: "https://cdn.udemy.com/captions/en.vtt" }];
    const fetchMock = vi.fn(async (url: unknown, _init?: unknown) => {
      if (String(url).includes("api-2.0")) {
        return { ok: true, json: async () => makeLectureJson(captions), text: async () => "" };
      }
      return { ok: true, json: async () => ({}), text: async () => SAMPLE_VTT };
    });
    vi.stubGlobal("fetch", fetchMock);

    await udemyAdapter.fetchCaptions({ videoId: "12345", preferLang: "en", signal: new AbortController().signal });

    const apiCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("api-2.0"));
    expect((apiCall![1] as RequestInit).headers).toMatchObject({
      "x-udemy-cache-logged-in": "1",
    });
  });
});

// ─── track selection: prefer genuine source over auto-translations ────────────

describe("fetchCaptions — track selection (non-auto / avoidLang)", () => {
  it("prefers the non-auto source track over an auto-translation", async () => {
    installCourseTaking(555);
    const EN_VTT = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nHello\n";
    const captions = [
      { locale_id: "vi", source: "auto", is_translation: true, url: "https://cdn.udemy.com/auto-vi.vtt", title: "Vietnamese [Auto]" },
      { locale_id: "en_US", source: "manual", is_translation: false, url: "https://cdn.udemy.com/en.vtt", title: "English [CC]" },
    ];
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes("api-2.0")) {
        return { ok: true, json: async () => makeLectureJson(captions), text: async () => "" };
      }
      return { ok: true, json: async () => ({}), text: async () => EN_VTT };
    });
    vi.stubGlobal("fetch", fetchMock);

    // preferLang undefined (auto) — should still pick the genuine English [CC].
    const result = await udemyAdapter.fetchCaptions({
      videoId: "12345",
      avoidLang: "vi",
      signal: new AbortController().signal,
    });

    expect(result!.sourceLang).toBe("en_US");
    expect(result!.trackName).toBe("English [CC]");
    // The VTT fetched must be the English one, not the auto-vi one.
    const vttCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("cdn.udemy.com"));
    expect(String(vttCall![0])).toContain("en.vtt");
  });

  it("never selects the avoidLang (target) track when another source exists", async () => {
    installCourseTaking(555);
    const captions = [
      { locale_id: "vi", source: "manual", is_translation: false, url: "https://cdn.udemy.com/vi.vtt" },
      { locale_id: "en_US", source: "manual", is_translation: false, url: "https://cdn.udemy.com/en.vtt" },
    ];
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes("api-2.0")) {
        return { ok: true, json: async () => makeLectureJson(captions), text: async () => "" };
      }
      return { ok: true, json: async () => ({}), text: async () => "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nx\n" };
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await udemyAdapter.fetchCaptions({
      videoId: "12345",
      avoidLang: "vi",
      signal: new AbortController().signal,
    });

    expect(result!.sourceLang).toBe("en_US");
  });

  it("reads the nested locale object when locale_id is absent", async () => {
    installCourseTaking(555);
    const captions = [
      { locale: { locale: "en_US" }, source: "manual", url: "https://cdn.udemy.com/en.vtt" },
    ];
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes("api-2.0")) {
        return { ok: true, json: async () => makeLectureJson(captions), text: async () => "" };
      }
      return { ok: true, json: async () => ({}), text: async () => "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nx\n" };
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await udemyAdapter.fetchCaptions({
      videoId: "12345",
      preferLang: "en",
      signal: new AbortController().signal,
    });

    expect(result!.sourceLang).toBe("en_US");
  });

  it("returns null when the ONLY track is the avoidLang (forces audio fallback)", async () => {
    installCourseTaking(555);
    const captions = [
      { locale_id: "vi", source: "manual", is_translation: false, url: "https://cdn.udemy.com/vi.vtt" },
    ];
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes("api-2.0")) {
        return { ok: true, json: async () => makeLectureJson(captions), text: async () => "" };
      }
      return { ok: true, json: async () => ({}), text: async () => "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nxin chào\n" };
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await udemyAdapter.fetchCaptions({
      videoId: "12345",
      avoidLang: "vi",
      signal: new AbortController().signal,
    });

    // MUST be null — never dub vi→vi; the VTT must NOT even be fetched.
    expect(result).toBeNull();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("cdn.udemy.com"))).toBe(false);
    // And the no-usable-track diagnostic is logged.
    expect(infoSpy).toHaveBeenCalledWith(
      "[echoly-cc]", "udemy:", "no usable caption track after pick", expect.anything(),
    );
    infoSpy.mockRestore();
  });
});

// ─── diagnostics: every failure logs a distinct [echoly-cc] line ──────────────

describe("fetchCaptions — [echoly-cc] diagnostics", () => {
  it("logs when no courseId can be extracted (empty DOM + no slug in URL)", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    // empty DOM + URL reset to "/" → no DOM courseId, no slug
    const result = await udemyAdapter.fetchCaptions({ videoId: "12345", signal: new AbortController().signal });

    expect(result).toBeNull();
    expect(infoSpy).toHaveBeenCalledWith("[echoly-cc]", "udemy:", "no courseId — DOM probes missed and no slug in URL");
    infoSpy.mockRestore();
  });

  it("logs when asset.captions is empty", async () => {
    installCourseTaking(555);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    mockFetch([{ ok: true, body: makeLectureJson([]) }]);

    const result = await udemyAdapter.fetchCaptions({ videoId: "12345", signal: new AbortController().signal });

    expect(result).toBeNull();
    expect(infoSpy).toHaveBeenCalledWith("[echoly-cc]", "udemy:", "asset.captions is empty/absent", expect.anything());
    infoSpy.mockRestore();
  });

  it("logs the api status on a non-ok response", async () => {
    installCourseTaking(555);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => "" })));

    await udemyAdapter.fetchCaptions({ videoId: "12345", signal: new AbortController().signal });

    expect(infoSpy).toHaveBeenCalledWith(
      "[echoly-cc]", "udemy:", "api-2.0 lecture request non-ok",
      expect.objectContaining({ status: 403 }),
    );
    infoSpy.mockRestore();
  });
});

// ─── canCaptureAudioNow — runtime DRM probe ───────────────────────────────────

describe("canCaptureAudioNow (per-lecture DRM probe)", () => {
  it("returns true when no EME mediaKeys are attached (non-DRM lecture)", () => {
    const video = document.createElement("video");
    Object.defineProperty(video, "mediaKeys", { value: null, configurable: true });
    expect(udemyAdapter.canCaptureAudioNow!(video)).toBe(true);
  });

  it("returns false when EME mediaKeys are attached (Widevine DRM lecture)", () => {
    const video = document.createElement("video");
    Object.defineProperty(video, "mediaKeys", { value: {}, configurable: true });
    expect(udemyAdapter.canCaptureAudioNow!(video)).toBe(false);
  });

  it("treats undefined mediaKeys as non-DRM (== null)", () => {
    const video = document.createElement("video");
    // jsdom default: mediaKeys undefined → `== null` true → allow attempt.
    expect(udemyAdapter.canCaptureAudioNow!(video)).toBe(true);
  });
});
