// YouTube caption acquisition (3-layer: intercept → DOM → plain timedtext).
//
// Moved from `src/content/pipelines/youtube-captions-fetch.ts`.
// Returns the `CaptionFetchResult` shape from `@/shared/platform-ports`
// (field `captions`, not `cues`).

import { sendFromContent } from "@/shared/protocol";
import { getYouTubeVideoId, parseJson3Events, pickCaptionTrack } from "./captions";
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
  if (!res.ok) return null;
  const json = (await res.json().catch(() => null)) as {
    events?: Parameters<typeof parseJson3Events>[0];
  } | null;
  const captions = parseJson3Events(json?.events || []);
  return captions.length > 0 ? captions : null;
}

export async function fetchYouTubeCaptions(
  videoId: string,
  targetLang: string,
  signal?: AbortSignal,
): Promise<CaptionFetchResult | null> {
  try {
    const entry = await fetchCCViaIntercept(videoId, signal);
    if (entry?.url) {
      const url = entry.url + (entry.url.includes("fmt=") ? "" : "&fmt=json3");
      const captions = await fetchJson3Url(url, signal);
      if (captions) {
        return {
          captions,
          sourceLang: entry.lang,
          trackName: entry.kind ? `YouTube (${entry.kind})` : undefined,
        };
      }
    }
  } catch {
    if (signal?.aborted) return null;
  }

  const pr = readPlayerResponseFromDom();
  const tracks = (
    pr?.captions as { playerCaptionsTracklistRenderer?: { captionTracks?: unknown } }
  )?.playerCaptionsTracklistRenderer?.captionTracks as
    | Array<{ languageCode?: string; kind?: string; baseUrl?: string }>
    | undefined;
  const picked = pickCaptionTrack(tracks || [], targetLang);
  if (picked?.baseUrl) {
    const url = picked.baseUrl + (picked.baseUrl.includes("fmt=") ? "" : "&fmt=json3");
    try {
      const captions = await fetchJson3Url(url, signal);
      if (captions) {
        return {
          captions,
          sourceLang: picked.languageCode ?? null,
          trackName: picked.kind ? `YouTube (${picked.kind})` : undefined,
        };
      }
    } catch {
      if (signal?.aborted) return null;
    }
  }

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
      const captions = await fetchJson3Url(url, signal);
      if (captions) return { captions, sourceLang: null };
    } catch {
      if (signal?.aborted) return null;
    }
  }
  return null;
}

export function isYouTubeWatchPage(): boolean {
  return location.hostname.includes("youtube.com") && !!getYouTubeVideoId();
}
