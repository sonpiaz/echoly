// YouTube caption acquisition (3-layer: MAIN-world → intercept → DOM scrape).
//
// Moved from `src/content/pipelines/youtube-captions-fetch.ts`.
// Returns the `CaptionFetchResult` shape from `@/shared/platform-ports`
// (field `captions`, not `cues`).
//
// Layer order (newest first):
//   0. Captured page network (MAIN-world hook) — PRIMARY, pot-proof: reuse the
//      caption request/response the YouTube player itself made (carries a valid
//      `pot` token). This is the only reliable path since YouTube began returning
//      empty bodies for pot-less caption fetches (mid-2025).
//   1. webRequest intercept cache (via background SW) — signed+pot URL fallback
//   2. Static DOM ytInitialPlayerResponse scrape — initial-load fallback (no pot → usually empty)
//   3. Public /api/timedtext (last resort; dead without pot, kept for diagnostics)
// Every layer's fetch is logged via cclog (status + cue count) so a failing
// layer is visible in the [echoly-cc] console trace.

import { sendFromContent } from "@/shared/protocol";
import {
  getYouTubeVideoId,
  parseJson3Events,
  parseTimedtextBody,
  pickCaptionTrack,
} from "./captions";
import { getYtMainWorldData } from "./yt-mainworld-cache";
import type { CaptionFetchResult } from "@/shared/platform-ports";
import type { CaptionCue } from "@/shared/platform-ports";

export type { CaptionFetchResult };

const YT_CC_BUTTON_SELECTORS = [
  "button.ytp-subtitles-button",
  ".ytp-chrome-controls .ytp-subtitles-button",
  'button[aria-label*="captions" i]',
  'button[aria-label*="subtitle" i]',
];

function findYTCCButton(): HTMLElement | null {
  for (const sel of YT_CC_BUTTON_SELECTORS) {
    const btn = document.querySelector(sel);
    if (btn instanceof HTMLElement) return btn;
  }
  return null;
}

function triggerYTCCLoad(): { triggered: boolean; wasOff: boolean } {
  const btn = findYTCCButton();
  if (!btn) return { triggered: false, wasOff: false };
  const wasOff = btn.getAttribute("aria-pressed") !== "true";
  if (wasOff) {
    try {
      btn.click();
    } catch {
      return { triggered: false, wasOff };
    }
  }
  return { triggered: true, wasOff };
}

/**
 * Force a YouTube timedtext URL to JSON3 format.
 *
 * YouTube's own caption request (which we intercept in layer 1) is usually
 * `fmt=srv3` (XML) — and `captionTracks[].baseUrl` from the player response
 * often carries no `fmt` or a non-json3 one. The previous code only appended
 * `&fmt=json3` when NO `fmt` was present, so an intercepted `fmt=srv3` URL was
 * left as XML and then failed `res.json()` → silently treated as "no captions".
 * We always normalize to json3 (fmt is not part of YouTube's URL signature, so
 * overriding it is safe — the existing append-when-absent code already relied on
 * that).
 */
export function normalizeToJson3(rawUrl: string): string {
  try {
    const u = new URL(rawUrl, location.origin);
    u.searchParams.set("fmt", "json3");
    return u.toString();
  } catch {
    if (/[?&]fmt=/.test(rawUrl)) return rawUrl.replace(/([?&]fmt=)[^&]*/, "$1json3");
    return rawUrl + (rawUrl.includes("?") ? "&" : "?") + "fmt=json3";
  }
}

/** Diagnostic logger for the caption waterfall (visible in the page console). */
function cclog(...args: unknown[]): void {
  console.info("[echoly-cc]", ...args);
}

function restoreYTCCButton(wasOff: boolean): void {
  if (!wasOff) return;
  const btn = findYTCCButton();
  if (btn && btn.getAttribute("aria-pressed") === "true") {
    try {
      btn.click();
    } catch {
      /* ignore */
    }
  }
}

async function fetchCCViaIntercept(
  videoId: string,
  signal: AbortSignal | undefined,
  timeoutMs = 1800,
): Promise<{ url: string; lang: string | null; kind: string | null } | null> {
  const askBg = async () => {
    try {
      const reply = await sendFromContent({ type: "GET_YT_CC_URL", videoId });
      return reply.ok && reply.url ? reply : null;
    } catch {
      return null;
    }
  };

  let entry = await askBg();
  if (entry?.url) return entry;
  if (signal?.aborted) return null;

  const { triggered, wasOff } = triggerYTCCLoad();
  if (!triggered) return null;

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 100));
    if (signal?.aborted) {
      restoreYTCCButton(wasOff);
      return null;
    }
    entry = await askBg();
    if (entry?.url) {
      restoreYTCCButton(wasOff);
      return entry;
    }
  }
  restoreYTCCButton(wasOff);
  return null;
}

export function readPlayerResponseFromDom(): Record<string, unknown> | null {
  const scripts = document.querySelectorAll("script");
  for (const s of scripts) {
    const t = s.textContent;
    if (!t || !t.includes("ytInitialPlayerResponse")) continue;
    const m = t.match(
      /ytInitialPlayerResponse\s*=\s*(\{[\s\S]+?\})\s*;\s*(?:var|<\/script>|window\.|$)/,
    );
    if (!m) continue;
    try {
      return JSON.parse(m[1]!) as Record<string, unknown>;
    } catch {
      const raw = m[1]!;
      let depth = 0;
      let end = -1;
      for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) {
            end = i + 1;
            break;
          }
        }
      }
      if (end > 0) {
        try {
          return JSON.parse(raw.slice(0, end)) as Record<string, unknown>;
        } catch {
          /* try next script */
        }
      }
    }
  }
  return null;
}

async function fetchJson3Url(
  url: string,
  signal: AbortSignal | undefined,
): Promise<CaptionCue[] | null> {
  const res = await fetch(url, { credentials: "include", signal });
  if (!res.ok) {
    cclog("fetchJson3Url not-ok", { status: res.status, host: safeHost(url) });
    return null;
  }
  const json = (await res.json().catch(() => null)) as {
    events?: Parameters<typeof parseJson3Events>[0];
  } | null;
  const captions = parseJson3Events(json?.events || []);
  // Distinguish "200 but empty body" (YouTube pot/signature rejection) from real cues.
  cclog("fetchJson3Url", {
    status: res.status,
    host: safeHost(url),
    rawEvents: json?.events?.length ?? 0,
    cues: captions.length,
  });
  return captions.length > 0 ? captions : null;
}

function safeHost(url: string): string {
  try {
    return new URL(url, location.origin).host;
  } catch {
    return "?";
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

function langFromUrl(url: string): string | null {
  try {
    return new URL(url, location.origin).searchParams.get("lang");
  } catch {
    return null;
  }
}

/**
 * Read BOTH `lang` and `tlang` query params from a YouTube timedtext URL.
 * A YouTube auto-translated track URL looks like: `...&lang=<source>&tlang=<target>`
 * so reading only `lang` misses auto-translations.
 */
function captureLangs(url: string): { lang: string | null; tlang: string | null } {
  try {
    const u = new URL(url, location.origin);
    return { lang: u.searchParams.get("lang"), tlang: u.searchParams.get("tlang") };
  } catch {
    return { lang: null, tlang: null };
  }
}

function primarySubtag(lang: string | null | undefined): string | null {
  if (!lang) return null;
  return lang.toLowerCase().split("-")[0] ?? null;
}

/**
 * Layer-0 (PRIMARY, pot-proof): use caption data captured from the page's OWN
 * network traffic by the MAIN-world hook (yt-mainworld.content.ts). Since 2025/26
 * YouTube returns an empty body for any caption fetch lacking a valid `pot`
 * token, the ONLY reliable path is to reuse what the player itself fetched.
 * Order: (a) the player's own timedtext response BODY (zero refetch); (b) refetch
 * the player's pot'd timedtext URL forcing json3; (c) captionTracks + poToken.
 * If nothing is captured yet, nudge CC on so the player fetches, then poll.
 */
async function fetchViaCapturedNetwork(
  videoId: string,
  sourcePref: string | undefined,
  signal?: AbortSignal,
  avoidLang?: string,
): Promise<CaptionFetchResult | null> {
  let cap = getYtMainWorldData(videoId);

  // Nudge: if nothing captured yet, turn CC on so the player issues its caption
  // request (our MAIN-world hook captures it), poll up to ~1.8s, restore button.
  // Only poll if the CC button was actually found+triggered — otherwise there is
  // no way to make the player fetch, so don't waste time waiting.
  if (!cap.ccBodies.length && !cap.ccUrls.length && !cap.captionTracks?.length) {
    const { triggered, wasOff } = triggerYTCCLoad();
    if (triggered) {
      const start = Date.now();
      while (Date.now() - start < 1800) {
        await sleep(120);
        if (signal?.aborted) {
          restoreYTCCButton(wasOff);
          return null;
        }
        cap = getYtMainWorldData(videoId);
        if (cap.ccBodies.length || cap.ccUrls.length || cap.captionTracks?.length) break;
      }
      restoreYTCCButton(wasOff);
    }
  }
  if (signal?.aborted) return null;

  const avoidCode = primarySubtag(avoidLang);
  // EXPLICIT source: the user chose a specific source language (not "auto"). The
  // captured Layer-0 track is whatever the YouTube player itself fetched (the CC
  // track it shows / its default) — which is NOT necessarily the user's choice. So
  // when an explicit source is set, ONLY accept a captured track in that language;
  // otherwise skip Layer-0 and fall through to captionTracks / DOM / timedtext,
  // which can target the requested language. AUTO (sourceCode === null) keeps the
  // original behavior (accept the player's track, only avoiding the output lang).
  const sourceCode = primarySubtag(sourcePref);
  /** True iff this captured-track URL must be skipped (avoid lang, or explicit-source mismatch). */
  const skipCaptured = (url: string): boolean => {
    const { lang, tlang } = captureLangs(url);
    if (avoidCode && (primarySubtag(lang) === avoidCode || primarySubtag(tlang) === avoidCode)) {
      cclog("layer0 captured SKIPPED (avoidLang)", { lang, tlang, avoidLang });
      return true;
    }
    if (sourceCode && primarySubtag(lang) !== sourceCode) {
      cclog("layer0 captured SKIPPED (explicit source mismatch)", { lang, sourcePref });
      return true;
    }
    return false;
  };

  // (a) Zero-refetch: parse the player's own timedtext response body (pot-proof).
  for (const rec of cap.ccBodies) {
    if (skipCaptured(rec.url)) continue;
    const cues = parseTimedtextBody(rec.body);
    cclog("layer0 captured cc-body", { cues: cues.length, host: safeHost(rec.url) });
    if (cues.length) return { captions: cues, sourceLang: langFromUrl(rec.url) };
  }

  // (b) Refetch the player's own pot'd timedtext URL, forcing json3 (pot/sig
  // survive an fmt swap — fmt is not part of YouTube's URL signature).
  for (const url of cap.ccUrls) {
    if (skipCaptured(url)) continue;
    if (signal?.aborted) return null;
    try {
      const cues = await fetchJson3Url(normalizeToJson3(url), signal);
      cclog("layer0 captured cc-url", { found: !!cues, host: safeHost(url) });
      if (cues) return { captions: cues, sourceLang: langFromUrl(url) };
    } catch (err) {
      if (signal?.aborted) return null;
      console.warn("[echoly] caption fetch failed (captured cc-url)", err);
    }
  }

  // (c) captionTracks + poToken from the captured /youtubei/v1/player response.
  if (cap.captionTracks?.length) {
    const picked = pickCaptionTrack(cap.captionTracks, sourcePref, avoidLang);
    if (picked?.baseUrl) {
      let url = normalizeToJson3(picked.baseUrl);
      if (cap.poToken) url += `&c=WEB&pot=${encodeURIComponent(cap.poToken)}`;
      try {
        const cues = await fetchJson3Url(url, signal);
        cclog("layer0 captured player-track", {
          found: !!cues,
          hasPot: !!cap.poToken,
          lang: picked.languageCode,
        });
        if (cues) {
          return {
            captions: cues,
            sourceLang: picked.languageCode ?? null,
            trackName: picked.kind ? `YouTube (${picked.kind})` : undefined,
          };
        }
      } catch (err) {
        if (signal?.aborted) return null;
        console.warn("[echoly] caption fetch failed (captured player-track)", err);
      }
    }
  }
  return null;
}

export async function fetchYouTubeCaptions(
  videoId: string,
  sourcePref: string | undefined,
  signal?: AbortSignal,
  avoidLang?: string,
): Promise<CaptionFetchResult | null> {
  // ── Layer 0: captured page network (pot-proof, PRIMARY) ───────────────────
  try {
    const captured = await fetchViaCapturedNetwork(videoId, sourcePref, signal, avoidLang);
    if (signal?.aborted) return null;
    if (captured) return captured;
  } catch (err) {
    if (signal?.aborted) return null;
    console.warn("[echoly] caption fetch layer failed (captured network)", err);
  }

  // ── Layer 1: webRequest intercept cache ───────────────────────────────────
  try {
    const entry = await fetchCCViaIntercept(videoId, signal);
    if (entry?.url) {
      const url = normalizeToJson3(entry.url);
      const captions = await fetchJson3Url(url, signal);
      cclog("layer1 intercept", { videoId, found: !!captions, lang: entry.lang, kind: entry.kind });
      if (captions) {
        return {
          captions,
          sourceLang: entry.lang,
          trackName: entry.kind ? `YouTube (${entry.kind})` : undefined,
        };
      }
    } else {
      cclog("layer1 intercept: no cached timedtext URL", { videoId });
    }
  } catch (err) {
    if (signal?.aborted) return null;
    console.warn("[echoly] caption fetch layer failed (intercept)", err);
  }

  // ── Layer 2: static DOM ytInitialPlayerResponse scrape ────────────────────
  const pr = readPlayerResponseFromDom();
  const tracks = (
    pr?.captions as { playerCaptionsTracklistRenderer?: { captionTracks?: unknown } }
  )?.playerCaptionsTracklistRenderer?.captionTracks as
    | Array<{ languageCode?: string; kind?: string; baseUrl?: string }>
    | undefined;
  cclog("layer2 DOM playerResponse", {
    videoId,
    hasPlayerResponse: !!pr,
    trackCount: tracks?.length ?? 0,
  });
  const picked = pickCaptionTrack(tracks || [], sourcePref, avoidLang);
  if (picked?.baseUrl) {
    const url = normalizeToJson3(picked.baseUrl);
    try {
      const captions = await fetchJson3Url(url, signal);
      cclog("layer2 DOM track fetch", { found: !!captions, lang: picked.languageCode });
      if (captions) {
        return {
          captions,
          sourceLang: picked.languageCode ?? null,
          trackName: picked.kind ? `YouTube (${picked.kind})` : undefined,
        };
      }
    } catch (err) {
      if (signal?.aborted) return null;
      console.warn("[echoly] caption fetch layer failed (DOM track)", err);
    }
  }

  // ── Layer 3: public /api/timedtext (last resort) ─────────────────────────
  // Restored: this was in the last-known-working build. Fetched from the
  // youtube.com page origin with credentials it can still return cues in some
  // regions/videos. Cheap relative to "no captions → live dub". If YouTube has
  // locked it (pot/signature), fetchJson3Url logs the 200-but-empty case so we
  // can see it in the [echoly-cc] trace.
  // Use the SOURCE language (sourcePref || "en") — never the output/target language.
  const base = "https://www.youtube.com/api/timedtext";
  const v = encodeURIComponent(videoId);
  const lang = encodeURIComponent(sourcePref || "en");
  const fallbackUrls = [
    `${base}?lang=en&v=${v}&fmt=json3`,
    `${base}?lang=${lang}&v=${v}&fmt=json3`,
    `${base}?lang=en&v=${v}&fmt=json3&kind=asr`,
  ];
  for (const url of fallbackUrls) {
    try {
      const captions = await fetchJson3Url(url, signal);
      if (captions) {
        cclog("layer3 public timedtext", { found: true });
        return { captions, sourceLang: null };
      }
    } catch (err) {
      if (signal?.aborted) return null;
      console.warn("[echoly] caption fetch layer failed (timedtext API)", err);
    }
  }

  cclog("ALL LAYERS FAILED — reporting no captions", { videoId });
  return null;
}

// ─── Helpers for settle-retry ─────────────────────────────────────────────────

/**
 * Check whether the DOM / intercept cache looks "not ready yet" for this
 * videoId — i.e. the DOM has no captionTracks (could be post-ad stale state)
 * AND the background intercept cache is empty. If either has data, we treat a
 * null result as a genuine "no captions" rather than a transient lag.
 *
 * This is called synchronously (no async); the intercept-cache check is
 * fire-and-forget via a message to the background SW, so we inspect the DOM
 * synchronously here and rely on the background check being resolved by the
 * next retry via `fetchCCViaIntercept`.
 */
function isDomNotReadyYet(): boolean {
  const pr = readPlayerResponseFromDom();
  const tracks = (
    pr?.captions as { playerCaptionsTracklistRenderer?: { captionTracks?: unknown } }
  )?.playerCaptionsTracklistRenderer?.captionTracks as
    | Array<unknown>
    | undefined;
  // If the DOM has no captionTracks at all, the page may not be settled yet.
  return !tracks || tracks.length === 0;
}

export interface FetchYouTubeCaptionsWithSettleOpts {
  /** How many total attempts (default 2 — MAIN-world as primary reduces need for retries). */
  maxAttempts?: number;
  /** Delay in ms between attempts (default 500). */
  delayMs?: number;
}

/**
 * Settle-retry wrapper around `fetchYouTubeCaptions`.
 *
 * Retries the 3-layer caption fetch (MAIN-world → intercept → DOM) up to
 * `maxAttempts` times (default 2) with `delayMs` (default 500 ms) between
 * attempts, but ONLY when:
 *   (a) the result is null/empty, AND
 *   (b) the DOM looks "not settled yet" (no captionTracks present).
 *
 * Between retries, `triggerYTCCLoad()` is called to nudge YouTube into
 * requesting the real video's timedtext URL (which the background SW then
 * intercepts). The CC button is ALWAYS restored to its prior state after the
 * nudge so native CC is never left enabled.
 *
 * If the DOM clearly has captionTracks but the fetch returned empty (true
 * failure), we still retry up to the attempt limit — exhausted attempts return
 * null so the caller can fall through to live-dub as today.
 *
 * Honors the AbortSignal: bail immediately if aborted before or between
 * attempts.
 */
export async function fetchYouTubeCaptionsWithSettle(
  videoId: string,
  sourcePref: string | undefined,
  signal?: AbortSignal,
  opts?: FetchYouTubeCaptionsWithSettleOpts,
  avoidLang?: string,
): Promise<CaptionFetchResult | null> {
  const maxAttempts = opts?.maxAttempts ?? 2;
  const delayMs = opts?.delayMs ?? 500;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) return null;

    const result = await fetchYouTubeCaptions(videoId, sourcePref, signal, avoidLang);

    if (signal?.aborted) return null;

    // Success: captions returned and non-empty.
    if (result && result.captions.length > 0) return result;

    // Last attempt — return whatever we got (null or empty).
    if (attempt === maxAttempts - 1) return result;

    // Decide whether to retry: always retry when result is empty.
    // Re-trigger the CC load to nudge YouTube into emitting the timedtext URL,
    // then RESTORE the button to its prior state — native CC must never be left ON.
    const domNotReady = isDomNotReadyYet();
    if (domNotReady) {
      // DOM is not settled — most likely post-ad stale ytInitialPlayerResponse.
      const { wasOff } = triggerYTCCLoad();
      // Wait before next attempt, honoring the abort signal.
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        const timer = setTimeout(resolve, delayMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      }).catch(() => null); // AbortError → null return below

      // Restore the CC button state regardless of abort outcome.
      restoreYTCCButton(wasOff);
    } else {
      // DOM already has tracks (true miss) — just wait.
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        const timer = setTimeout(resolve, delayMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      }).catch(() => null);
    }

    if (signal?.aborted) return null;
  }

  return null;
}

export function isYouTubeWatchPage(): boolean {
  return location.hostname.includes("youtube.com") && !!getYouTubeVideoId();
}
