// ────────────────────────────────────────────────────────────────────────────
// Caption acquisition — the 3-layer fetch for the subtitle-first tier:
//   1. webRequest-intercepted signed URL (ask background GET_YT_CC_URL; if cold,
//      toggle YT's own CC button to make it fire /api/timedtext, then poll).
//   2. pre-signed baseUrl scraped from the page's ytInitialPlayerResponse DOM.
//   3. plain timedtext URL patterns (mostly empty post-2024 but cheap).
// All network fetches are abort-wired (signal) + credentials:"include".
// (legacy/content.js: getYouTubeVideoId 1400, triggerYTCCLoad 1434,
// fetchCCViaIntercept 1455, readPlayerResponseFromDom 1496, fetchYouTubeCaptions
// 1545.) Pure parsing/regrouping lives in @/lib/caption.
// ────────────────────────────────────────────────────────────────────────────

import { sendFromContent } from "@/shared/protocol";
import {
  parseJson3Events,
  pickCaptionTrack,
  type Caption,
  type CaptionTrack,
} from "@/lib/caption";
import type { Json3Event } from "@/lib/caption";

export interface CaptionResult {
  captions: Caption[];
  sourceUrl: string;
  lang?: string | null;
  kind?: string | null;
  source?: string;
}

export function getYouTubeVideoId(): string | null {
  try {
    const u = new URL(location.href);
    const v = u.searchParams.get("v");
    if (v) return v;
    const m = u.pathname.match(/\/embed\/([^/?]+)/);
    if (m) return m[1]!;
    return null;
  } catch {
    return null;
  }
}

// CC button selectors — keep multiple as fallbacks for YT UI rewrites.
const YT_CC_BUTTON_SELECTORS = [
  "button.ytp-subtitles-button",
  ".ytp-chrome-controls .ytp-subtitles-button",
  'button[aria-label*="captions" i]',
  'button[aria-label*="subtitle" i]',
];

function findYTCCButton(): HTMLElement | null {
  for (const sel of YT_CC_BUTTON_SELECTORS) {
    const btn = document.querySelector<HTMLElement>(sel);
    if (btn) return btn;
  }
  return null;
}

/** Toggling YT's CC button forces YouTube to fire its internal /api/timedtext
 *  request with a full-auth signed URL (caught by background's webRequest). */
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

function restoreYTCCButton(wasOff: boolean): void {
  if (!wasOff) return;
  const btn = findYTCCButton();
  if (btn && btn.getAttribute("aria-pressed") === "true") {
    try {
      btn.click();
    } catch {
      /* best-effort restore */
    }
  }
}

interface InterceptEntry {
  url: string;
  lang: string | null;
  kind: string | null;
  tlang: string | null;
  isAsr: boolean;
}

/** Layer 1: ask background for the most recently observed timedtext URL for
 *  this video. If cold, trigger YT's CC button and poll. */
async function fetchCCViaIntercept(
  videoId: string,
  signal: AbortSignal,
  timeoutMs = 1800,
): Promise<InterceptEntry | null> {
  const askBg = (): Promise<InterceptEntry | null> =>
    sendFromContent({ type: "GET_YT_CC_URL", videoId })
      .then((reply) =>
        reply && reply.ok ? (reply as unknown as InterceptEntry) : null,
      )
      .catch(() => null);

  // First peek — user may already have CC on (warm cache, no UI flicker).
  let entry = await askBg();
  if (entry?.url) return entry;
  if (signal?.aborted) return null;

  // Cold cache: nudge YT to load CC, then poll.
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

interface PlayerResponse {
  captions?: {
    playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] };
  };
}

/** Layer 2 source: scrape ytInitialPlayerResponse from an inline <script>
 *  (isolated world can't read the global) with a balanced-brace fallback. */
function readPlayerResponseFromDom(): PlayerResponse | null {
  const scripts = document.querySelectorAll("script");
  for (const s of scripts) {
    const t = s.textContent;
    if (!t || !t.includes("ytInitialPlayerResponse")) continue;
    const m = t.match(
      /ytInitialPlayerResponse\s*=\s*(\{[\s\S]+?\})\s*;\s*(?:var|<\/script>|window\.|$)/,
    );
    if (!m) continue;
    try {
      return JSON.parse(m[1]!) as PlayerResponse;
    } catch {
      // Lenient: balanced-brace scan from match start.
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
          return JSON.parse(raw.slice(0, end)) as PlayerResponse;
        } catch {
          /* give up on this script */
        }
      }
    }
  }
  return null;
}

/** Run the full 3-layer acquisition; return the first non-empty caption set or
 *  null. Layer order: intercept → DOM baseUrl → plain timedtext. (legacy
 *  fetchYouTubeCaptions.) */
export async function fetchYouTubeCaptions(
  videoId: string,
  targetLang: string,
  signal: AbortSignal,
): Promise<CaptionResult | null> {
  // Layer 1: webRequest-intercepted URL (most reliable).
  try {
    const entry = await fetchCCViaIntercept(videoId, signal);
    if (entry?.url) {
      const url = entry.url + (entry.url.includes("fmt=") ? "" : "&fmt=json3");
      const res = await fetch(url, { credentials: "include", signal });
      if (res.ok) {
        const json = (await res.json().catch(() => null)) as {
          events?: Json3Event[];
        } | null;
        const captions = parseJson3Events(json?.events || []);
        if (captions.length > 0) {
          return {
            captions,
            sourceUrl: url,
            lang: entry.lang,
            kind: entry.kind,
            source: "intercept",
          };
        }
      }
    }
  } catch {
    if (signal?.aborted) return null;
    // Fall through to Layer 2.
  }

  // Layer 2: pre-signed baseUrl from the page's ytInitialPlayerResponse.
  const pr = readPlayerResponseFromDom();
  const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  const picked = pickCaptionTrack(tracks, targetLang);
  if (picked?.baseUrl) {
    const url =
      picked.baseUrl + (picked.baseUrl.includes("fmt=") ? "" : "&fmt=json3");
    try {
      const res = await fetch(url, { credentials: "include", signal });
      if (res.ok) {
        const json = (await res.json().catch(() => null)) as {
          events?: Json3Event[];
        } | null;
        const captions = parseJson3Events(json?.events || []);
        if (captions.length > 0) {
          return {
            captions,
            sourceUrl: url,
            lang: picked.languageCode,
            kind: picked.kind || null,
          };
        }
      }
    } catch {
      if (signal?.aborted) return null;
    }
  }

  // Layer 3: plain URL pattern. Most videos return empty today.
  const base = "https://www.youtube.com/api/timedtext";
  const v = encodeURIComponent(videoId);
  const lang = encodeURIComponent(targetLang || "vi");
  const fallbackUrls = [
    `${base}?lang=en&v=${v}&fmt=json3`,
    `${base}?lang=${lang}&v=${v}&fmt=json3`,
    `${base}?lang=en&v=${v}&fmt=json3&kind=asr`,
  ];
  for (const url of fallbackUrls) {
    try {
      const res = await fetch(url, { credentials: "include", signal });
      if (!res.ok) continue;
      const json = (await res.json().catch(() => null)) as {
        events?: Json3Event[];
      } | null;
      const captions = parseJson3Events(json?.events || []);
      if (captions.length > 0) return { captions, sourceUrl: url };
    } catch {
      if (signal?.aborted) return null;
    }
  }
  return null;
}
