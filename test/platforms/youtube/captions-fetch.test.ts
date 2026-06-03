// @vitest-environment jsdom
//
// Unit tests for fetchYouTubeCaptionsWithSettle (settle-retry wrapper) and
// honest-error logging in fetchYouTubeCaptions.
//
// Because fetchYouTubeCaptionsWithSettle calls the private fetchYouTubeCaptions
// directly (same-file sibling — ES module live bindings cannot intercept this),
// we mock at the I/O boundary instead:
//
//   • global.fetch  → controls the timedtext / json3 HTTP responses
//   • @/shared/protocol sendFromContent → controls the background-SW intercept +
//     MAIN-world layer (GET_YT_CC_URL and GET_YT_PLAYER_RESPONSE)
//   • document.body.innerHTML → controls the DOM / ytInitialPlayerResponse layer
//
// This makes the tests more realistic (they exercise the actual retry loop) and
// avoids the vi.spyOn-on-sibling anti-pattern.
//
// DEFAULT mock for sendFromContent:
//   { ok: false } for ANY message type (covers both GET_YT_PLAYER_RESPONSE and
//   GET_YT_CC_URL) — existing tests opt in to a real URL by overriding in doMock.

import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import type { CaptionFetchResult } from "@/shared/platform-ports";

// ── Shared fake caption data ──────────────────────────────────────────────────

const FAKE_CAPTIONS: CaptionFetchResult = {
  captions: [{ start: 0, end: 2, text: "Hello world" }],
  sourceLang: "en",
};

/** A valid json3 response payload that parses to FAKE_CAPTIONS[0]. */
const FAKE_JSON3_BODY = {
  events: [{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: "Hello world" }] }],
};

/** Build a fake fetch Response for a json3 payload. */
function fakeJsonResponse(body: unknown, ok = true) {
  return {
    ok,
    json: vi.fn().mockResolvedValue(body),
  };
}

// ── Helper: build an AbortSignal that is already aborted ─────────────────────

function abortedSignal(): AbortSignal {
  const ctrl = new AbortController();
  ctrl.abort();
  return ctrl.signal;
}

// ── DOM helper: inject a ytInitialPlayerResponse script with captionTracks ───

function injectDomWithCaptionTracks(videoId: string): void {
  const script = document.createElement("script");
  script.textContent = `var ytInitialPlayerResponse = ${JSON.stringify({
    videoDetails: { videoId, title: "Test Video" },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          {
            languageCode: "en",
            kind: "asr",
            baseUrl: `https://www.youtube.com/api/timedtext?lang=en&v=${videoId}&fmt=json3`,
          },
        ],
      },
    },
  })};`;
  document.head.appendChild(script);
}

/** DOM has no captionTracks (simulates mid-ad / post-ad stale state). */
function injectDomWithNoCaptionTracks(): void {
  const script = document.createElement("script");
  script.textContent = `var ytInitialPlayerResponse = ${JSON.stringify({
    videoDetails: { title: "Ad" },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [] } },
  })};`;
  document.head.appendChild(script);
}

// ─────────────────────────────────────────────────────────────────────────────
// fetchYouTubeCaptionsWithSettle — settle-retry behavior
// ─────────────────────────────────────────────────────────────────────────────

describe("fetchYouTubeCaptionsWithSettle", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    // Default: sendFromContent returns "no cached URL" (intercept cache miss).
    vi.doMock("@/shared/protocol", () => ({
      sendFromContent: vi.fn().mockResolvedValue({ ok: false }),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });

  it("returns captions when the 1st attempt is empty (not-ready) but the 2nd DOM attempt succeeds", async () => {
    // Attempt 1: DOM has no captionTracks → all layers miss → null.
    // Attempt 2: DOM now has captionTracks (simulate settle) → layer-2 hits.
    let fetchCallCount = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        fetchCallCount++;
        // Only succeed on the 2nd fetch call (after retry injects DOM caption).
        if (fetchCallCount === 1) {
          return fakeJsonResponse(null, false); // timedtext fallback fails on attempt 1
        }
        return fakeJsonResponse(FAKE_JSON3_BODY); // succeeds on attempt 2
      }),
    );

    // On the first attempt the DOM is empty → settles after first attempt.
    // We inject captionTracks before the test starts but clear them to simulate
    // "not ready yet" on attempt 1 by starting with no DOM.
    // After the retry delay, we inject the DOM captionTracks to simulate settle.
    let attempt = 0;
    vi.doMock("@/shared/protocol", () => ({
      sendFromContent: vi.fn().mockImplementation(async () => {
        attempt++;
        if (attempt === 1) {
          // First attempt — no intercept URL yet.
          return { ok: false };
        }
        // Second attempt — intercept cache has the URL.
        return {
          ok: true,
          url: "https://www.youtube.com/api/timedtext?lang=en&v=vid-settle&fmt=json3",
          lang: "en",
          kind: null,
        };
      }),
    }));

    const mod = await import("@/platforms/youtube/captions-fetch");

    const result = await mod.fetchYouTubeCaptionsWithSettle("vid-settle", "en", undefined, {
      maxAttempts: 3,
      delayMs: 10,
    });

    expect(result).not.toBeNull();
    expect(result?.captions.length).toBeGreaterThan(0);
  });

  it("stops and returns null when genuinely no captions across all attempts", async () => {
    // All layers always miss: intercept cache empty, DOM no tracks, timedtext 404.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeJsonResponse(null, false)));

    const mod = await import("@/platforms/youtube/captions-fetch");

    const result = await mod.fetchYouTubeCaptionsWithSettle("vid-nocc", "en", undefined, {
      maxAttempts: 3,
      delayMs: 10,
    });

    expect(result).toBeNull();
  });

  it("aborts immediately when given an already-aborted signal", async () => {
    // Stub fetch to succeed — if it's called the test is broken.
    const fetchMock = vi.fn().mockResolvedValue(fakeJsonResponse(FAKE_JSON3_BODY));
    vi.stubGlobal("fetch", fetchMock);

    const mod = await import("@/platforms/youtube/captions-fetch");

    const signal = abortedSignal();
    const result = await mod.fetchYouTubeCaptionsWithSettle("vid123", "en", signal, {
      maxAttempts: 3,
      delayMs: 10,
    });

    expect(result).toBeNull();
    // fetch should never be called — we bailed before the first attempt.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts between attempts when the signal fires during the wait", async () => {
    // First attempt: all layers miss (no captions). Then AbortController aborts
    // during the delay before attempt 2. Attempt 2 should never run.
    let fetchCallCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        fetchCallCount++;
        return fakeJsonResponse(null, false);
      }),
    );

    const ctrl = new AbortController();

    // Abort after a short delay (during the 200ms retry wait).
    setTimeout(() => ctrl.abort(), 30);

    const mod = await import("@/platforms/youtube/captions-fetch");

    const result = await mod.fetchYouTubeCaptionsWithSettle("vid123", "en", ctrl.signal, {
      maxAttempts: 3,
      delayMs: 200, // longer than the abort timeout above
    });

    expect(result).toBeNull();
    // Only the timedtext fallback URLs from attempt 1 were tried (3 URLs); no
    // attempt-2 calls. We just check the result is null and the test completed
    // without hanging (the signal was honored).
  });

  it("returns captions on the first attempt without retrying", async () => {
    // Intercept cache hits immediately on attempt 1.
    vi.doMock("@/shared/protocol", () => ({
      sendFromContent: vi.fn().mockResolvedValue({
        ok: true,
        url: "https://www.youtube.com/api/timedtext?lang=en&v=vid-ok&fmt=json3",
        lang: "en",
        kind: null,
      }),
    }));

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeJsonResponse(FAKE_JSON3_BODY)));

    const mod = await import("@/platforms/youtube/captions-fetch");

    const result = await mod.fetchYouTubeCaptionsWithSettle("vid-ok", "en", undefined, {
      maxAttempts: 3,
      delayMs: 10,
    });

    expect(result).not.toBeNull();
    expect(result?.captions.length).toBe(1);
    expect(result?.captions[0]?.text).toBe("Hello world");
    // fetch should be called exactly once (intercept hit → json3 fetch → success).
    expect(vi.mocked(globalThis.fetch as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fetchYouTubeCaptions — honest error logging (console.warn with cause)
// ─────────────────────────────────────────────────────────────────────────────

describe("fetchYouTubeCaptions — honest error logging", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    vi.doMock("@/shared/protocol", () => ({
      sendFromContent: vi.fn().mockResolvedValue({ ok: false }),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });

  it("logs console.warn with the cause when the timedtext fetch layer throws", async () => {
    // Inject DOM caption tracks so layer-2 has a baseUrl to fetch → throws.
    // (Layer-3 / public timedtext fallback was removed; fetch must be triggered
    //  by a real baseUrl in one of the remaining layers.)
    injectDomWithCaptionTracks("vid-err");

    // All fetch calls throw (network error).
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fetch failed")));

    const mod = await import("@/platforms/youtube/captions-fetch");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await mod.fetchYouTubeCaptions("vid-err", "en");
    expect(result).toBeNull();

    // At least one [echoly] warning was emitted.
    const echolyWarns = warnSpy.mock.calls.filter(
      (args) => typeof args[0] === "string" && (args[0] as string).startsWith("[echoly]"),
    );
    expect(echolyWarns.length).toBeGreaterThan(0);

    // Each warn must include the error cause as a second argument.
    for (const warnArgs of echolyWarns) {
      expect(warnArgs[1]).toBeInstanceOf(Error);
    }

    warnSpy.mockRestore();
  });

  it("does NOT call console.warn when captions are fetched successfully via intercept", async () => {
    vi.doMock("@/shared/protocol", () => ({
      sendFromContent: vi.fn().mockResolvedValue({
        ok: true,
        url: "https://www.youtube.com/api/timedtext?lang=en&v=vid-ok&fmt=json3",
        lang: "en",
        kind: null,
      }),
    }));

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeJsonResponse(FAKE_JSON3_BODY)));

    const mod = await import("@/platforms/youtube/captions-fetch");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await mod.fetchYouTubeCaptions("vid-ok", "en");
    expect(result).not.toBeNull();

    const echolyWarns = warnSpy.mock.calls.filter(
      (args) => typeof args[0] === "string" && (args[0] as string).startsWith("[echoly]"),
    );
    expect(echolyWarns.length).toBe(0);

    warnSpy.mockRestore();
  });

  it("logs console.warn when the DOM track fetch throws", async () => {
    // Inject a DOM with a captionTracks entry whose baseUrl we'll make throw.
    injectDomWithCaptionTracks("vid-dom-err");

    // Protocol returns cache miss; fetch throws on json3 URL fetch.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("dom track fetch failed")));

    const mod = await import("@/platforms/youtube/captions-fetch");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await mod.fetchYouTubeCaptions("vid-dom-err", "en");
    expect(result).toBeNull();

    const echolyWarns = warnSpy.mock.calls.filter(
      (args) => typeof args[0] === "string" && (args[0] as string).startsWith("[echoly]"),
    );
    expect(echolyWarns.length).toBeGreaterThan(0);
    // The second argument is the thrown Error.
    expect(echolyWarns[0]?.[1]).toBeInstanceOf(Error);

    warnSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// youtubeAdapter.isAdPlaying — delegates to isYouTubeAdPlaying
// ─────────────────────────────────────────────────────────────────────────────

describe("youtubeAdapter.isAdPlaying", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("returns false when #movie_player is absent", async () => {
    const { youtubeAdapter } = await import("@/platforms/youtube/adapter");
    expect(youtubeAdapter.isAdPlaying?.()).toBe(false);
  });

  it("returns true when #movie_player has class ad-showing", async () => {
    document.body.innerHTML = '<div id="movie_player" class="ad-showing"></div>';
    const { youtubeAdapter } = await import("@/platforms/youtube/adapter");
    expect(youtubeAdapter.isAdPlaying?.()).toBe(true);
  });

  it("returns true when #movie_player has class ad-interrupting", async () => {
    document.body.innerHTML = '<div id="movie_player" class="ad-interrupting"></div>';
    const { youtubeAdapter } = await import("@/platforms/youtube/adapter");
    expect(youtubeAdapter.isAdPlaying?.()).toBe(true);
  });

  it("returns false when #movie_player has neither ad class", async () => {
    document.body.innerHTML = '<div id="movie_player" class="playing-mode"></div>';
    const { youtubeAdapter } = await import("@/platforms/youtube/adapter");
    expect(youtubeAdapter.isAdPlaying?.()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// readPlayerResponseFromDom — DOM scraping helper
// ─────────────────────────────────────────────────────────────────────────────

describe("readPlayerResponseFromDom", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
  });
  afterEach(() => {
    document.head.innerHTML = "";
  });

  it("returns null when no ytInitialPlayerResponse script is present", async () => {
    const { readPlayerResponseFromDom } = await import("@/platforms/youtube/captions-fetch");
    expect(readPlayerResponseFromDom()).toBeNull();
  });

  it("returns the parsed object when a valid ytInitialPlayerResponse script is present", async () => {
    injectDomWithCaptionTracks("vid-dom");
    const { readPlayerResponseFromDom } = await import("@/platforms/youtube/captions-fetch");
    const pr = readPlayerResponseFromDom();
    expect(pr).not.toBeNull();
    const tracks = (pr?.captions as { playerCaptionsTracklistRenderer?: { captionTracks?: unknown[] } })
      ?.playerCaptionsTracklistRenderer?.captionTracks;
    expect(Array.isArray(tracks)).toBe(true);
    expect((tracks as unknown[]).length).toBe(1);
  });

  it("returns an object with empty captionTracks when DOM has none", async () => {
    injectDomWithNoCaptionTracks();
    const { readPlayerResponseFromDom } = await import("@/platforms/youtube/captions-fetch");
    const pr = readPlayerResponseFromDom();
    expect(pr).not.toBeNull();
    const tracks = (pr?.captions as { playerCaptionsTracklistRenderer?: { captionTracks?: unknown[] } })
      ?.playerCaptionsTracklistRenderer?.captionTracks;
    expect(Array.isArray(tracks) && (tracks as unknown[]).length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// normalizeToJson3 — direct unit tests (via observable fetch URL behavior)
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizeToJson3 — direct", () => {
  // The exact srv3→json3 bug that broke YouTube CC: a captured/baseUrl with a
  // non-json3 fmt was left untouched and failed res.json(). Guard it directly.
  it("replaces fmt=srv3 with fmt=json3", async () => {
    const { normalizeToJson3 } = await import("@/platforms/youtube/captions-fetch");
    const out = normalizeToJson3(
      "https://www.youtube.com/api/timedtext?v=abc&lang=en&fmt=srv3&signature=sig",
    );
    const u = new URL(out);
    expect(u.searchParams.get("fmt")).toBe("json3");
    // other params preserved
    expect(u.searchParams.get("signature")).toBe("sig");
    expect(u.searchParams.get("v")).toBe("abc");
  });

  it("adds fmt=json3 when no fmt is present", async () => {
    const { normalizeToJson3 } = await import("@/platforms/youtube/captions-fetch");
    const out = normalizeToJson3("https://www.youtube.com/api/timedtext?v=abc&lang=en");
    expect(new URL(out).searchParams.get("fmt")).toBe("json3");
  });

  it("is a no-op when fmt is already json3", async () => {
    const { normalizeToJson3 } = await import("@/platforms/youtube/captions-fetch");
    const out = normalizeToJson3("https://www.youtube.com/api/timedtext?v=abc&fmt=json3");
    expect(new URL(out).searchParams.get("fmt")).toBe("json3");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fetchYouTubeCaptionsWithSettle — restore bug fix
// ─────────────────────────────────────────────────────────────────────────────

describe("fetchYouTubeCaptionsWithSettle — CC button restore fix", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });

  it("restores the CC button to OFF after a between-retry nudge (never left ON)", async () => {
    // Set up a CC button that starts OFF (aria-pressed="false").
    // triggerYTCCLoad toggles it ON; the fix ensures restoreYTCCButton puts it back OFF.
    //
    // To isolate the settle-loop nudge from fetchCCViaIntercept's internal nudge
    // we make GET_YT_CC_URL return an immediate cache HIT on every call so
    // fetchCCViaIntercept exits before polling the button — yet the json3 fetch
    // returns empty so the attempt still fails and triggers a retry nudge.
    const INTERCEPT_URL = "https://www.youtube.com/api/timedtext?lang=en&v=vid-restore&fmt=json3";
    vi.doMock("@/shared/protocol", () => ({
      sendFromContent: vi.fn().mockImplementation(async (msg: { type: string }) => {
        if (msg.type === "GET_YT_PLAYER_RESPONSE") return { ok: false };
        // Immediate CC URL hit → fetchCCViaIntercept returns without polling the button.
        return { ok: true, url: INTERCEPT_URL, lang: "en", kind: null };
      }),
    }));

    const btn = document.createElement("button");
    btn.className = "ytp-subtitles-button";
    btn.setAttribute("aria-pressed", "false");
    btn.addEventListener("click", () => {
      // Toggle aria-pressed on each click (simulates real button behavior).
      const current = btn.getAttribute("aria-pressed") === "true";
      btn.setAttribute("aria-pressed", current ? "false" : "true");
    });
    document.body.appendChild(btn);

    // No DOM captionTracks → isDomNotReadyYet() = true → settle nudge fires.
    // json3 fetch fails so every attempt returns null → retry.
    injectDomWithNoCaptionTracks();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeJsonResponse(null, false)));

    const mod = await import("@/platforms/youtube/captions-fetch");
    await mod.fetchYouTubeCaptionsWithSettle("vid-restore", "en", undefined, {
      maxAttempts: 2,
      delayMs: 10,
    });

    // KEY INVARIANT: native CC must never be left ON — button must be back to its
    // original OFF state after settle completes.
    expect(btn.getAttribute("aria-pressed")).toBe("false");
  });

  it("the settle loop does NOT add an extra CC nudge when DOM already has captionTracks", async () => {
    // DOM has tracks → isDomNotReadyYet() = false → settle loop's domNotReady branch
    // is skipped (no triggerYTCCLoad from the settle-loop level).
    // We verify the button ends in its original state regardless.
    vi.doMock("@/shared/protocol", () => ({
      sendFromContent: vi.fn().mockImplementation(async (msg: { type: string }) => {
        if (msg.type === "GET_YT_PLAYER_RESPONSE") return { ok: false };
        // Immediate CC hit → fetchCCViaIntercept doesn't poll.
        const INTERCEPT_URL =
          "https://www.youtube.com/api/timedtext?lang=en&v=vid-nodelay&fmt=json3";
        return { ok: true, url: INTERCEPT_URL, lang: "en", kind: null };
      }),
    }));

    const btn = document.createElement("button");
    btn.className = "ytp-subtitles-button";
    btn.setAttribute("aria-pressed", "false");
    btn.addEventListener("click", () => {
      const current = btn.getAttribute("aria-pressed") === "true";
      btn.setAttribute("aria-pressed", current ? "false" : "true");
    });
    document.body.appendChild(btn);

    injectDomWithCaptionTracks("vid-nodelay");
    // fetch returns empty (no captions) → triggers retry.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeJsonResponse(null, false)));

    const mod = await import("@/platforms/youtube/captions-fetch");
    await mod.fetchYouTubeCaptionsWithSettle("vid-nodelay", "en", undefined, {
      maxAttempts: 2,
      delayMs: 10,
    });

    // Button must still be OFF — never left ON by the fetch/settle path.
    expect(btn.getAttribute("aria-pressed")).toBe("false");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fetchYouTubeCaptions — captured page network (layer-0, pot-proof)
// ─────────────────────────────────────────────────────────────────────────────

describe("fetchYouTubeCaptions — captured page network (layer-0)", () => {
  async function seedCapture(detail: Record<string, unknown>): Promise<void> {
    const cache = await import("@/platforms/youtube/yt-mainworld-cache");
    cache.__resetYtMainWorldCache();
    cache.installYtMainWorldBridge();
    document.dispatchEvent(
      new CustomEvent("echoly:yt-capture", { detail: JSON.stringify(detail) }),
    );
  }

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });

  it("(a) parses the captured timedtext BODY with zero refetch (pot-proof)", async () => {
    vi.doMock("@/shared/protocol", () => ({
      sendFromContent: vi.fn().mockResolvedValue({ ok: false }),
    }));
    const fetchSpy = vi.fn().mockResolvedValue(fakeJsonResponse(null, false));
    vi.stubGlobal("fetch", fetchSpy);

    await seedCapture({
      kind: "cc-body",
      url: "https://www.youtube.com/api/timedtext?v=vidA&lang=en&fmt=json3",
      body: JSON.stringify(FAKE_JSON3_BODY),
    });

    const mod = await import("@/platforms/youtube/captions-fetch");
    const result = await mod.fetchYouTubeCaptions("vidA", "en");

    expect(result?.captions.length).toBe(1);
    expect(result?.captions[0]?.text).toBe("Hello world");
    expect(result?.sourceLang).toBe("en");
    // Zero refetch — the body was reused directly.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("(b) refetches the captured pot'd timedtext URL forcing json3", async () => {
    vi.doMock("@/shared/protocol", () => ({
      sendFromContent: vi.fn().mockResolvedValue({ ok: false }),
    }));
    const captured: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        captured.push(url);
        return fakeJsonResponse(FAKE_JSON3_BODY);
      }),
    );

    await seedCapture({
      kind: "cc-url",
      url: "https://www.youtube.com/api/timedtext?v=vidB&lang=en&fmt=srv3&pot=POT_B&signature=sig",
    });

    const mod = await import("@/platforms/youtube/captions-fetch");
    const result = await mod.fetchYouTubeCaptions("vidB", "en");

    expect(result?.captions.length).toBeGreaterThan(0);
    expect(captured[0]).toContain("fmt=json3");
    expect(captured[0]).not.toContain("fmt=srv3");
    // The captured pot survives the fmt swap.
    expect(captured[0]).toContain("pot=POT_B");
  });

  it("(c) fetches captionTracks baseUrl with appended &pot= from the player response", async () => {
    vi.doMock("@/shared/protocol", () => ({
      sendFromContent: vi.fn().mockResolvedValue({ ok: false }),
    }));
    const captured: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        captured.push(url);
        return fakeJsonResponse(FAKE_JSON3_BODY);
      }),
    );

    await seedCapture({
      kind: "player",
      videoId: "vidC",
      poToken: "POT_C",
      captionTracks: [
        { baseUrl: "https://www.youtube.com/api/timedtext?v=vidC&lang=en", languageCode: "en", kind: "asr" },
      ],
    });

    const mod = await import("@/platforms/youtube/captions-fetch");
    const result = await mod.fetchYouTubeCaptions("vidC", "en");

    expect(result?.captions.length).toBeGreaterThan(0);
    expect(result?.sourceLang).toBe("en");
    expect(captured[0]).toContain("fmt=json3");
    expect(captured[0]).toContain("pot=POT_C");
    expect(captured[0]).toContain("c=WEB");
  });

  it("falls through to the intercept layer when nothing is captured (and no CC button)", async () => {
    const INTERCEPT_URL = "https://www.youtube.com/api/timedtext?lang=en&v=vidD&fmt=json3&pot=POT_D";
    vi.doMock("@/shared/protocol", () => ({
      sendFromContent: vi.fn().mockImplementation(async (msg: { type: string }) => {
        if (msg.type === "GET_YT_CC_URL") {
          return { ok: true, url: INTERCEPT_URL, lang: "en", kind: null };
        }
        return { ok: false };
      }),
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeJsonResponse(FAKE_JSON3_BODY)));

    // No seedCapture → layer-0 cache empty; no CC button in jsdom → layer-0 returns fast.
    const mod = await import("@/platforms/youtube/captions-fetch");
    const result = await mod.fetchYouTubeCaptions("vidD", "en");

    expect(result?.captions.length).toBeGreaterThan(0);
  });
});
