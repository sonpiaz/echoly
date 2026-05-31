// webRequest cache for signed YouTube /api/timedtext URLs (subtitle-first layer 1).

import { YT_CACHE_GC_MS, YT_CACHE_TTL_MS } from "@/shared/constants";

export interface YtCaptionCacheEntry {
  url: string;
  lang: string | null;
  kind: string | null;
  tlang: string | null;
  isAsr: boolean;
  capturedAt: number;
}

const ytCaptionCache = new Map<string, YtCaptionCacheEntry>();

export function getYtCaptionCache(videoId: string): YtCaptionCacheEntry | undefined {
  return ytCaptionCache.get(videoId);
}

export function installYoutubeCaptionCache(): void {
  if (typeof chrome.webRequest?.onCompleted?.addListener !== "function") return;

  chrome.webRequest.onCompleted.addListener(
    (details) => {
      try {
        if (details.statusCode !== 200) return;
        const u = new URL(details.url);
        const videoId = u.searchParams.get("v");
        if (!videoId) return;
        const isAsr = u.searchParams.get("kind") === "asr";
        const existing = ytCaptionCache.get(videoId);
        if (existing && !existing.isAsr && isAsr) return;
        ytCaptionCache.set(videoId, {
          url: details.url,
          lang: u.searchParams.get("lang"),
          kind: u.searchParams.get("kind"),
          isAsr,
          tlang: u.searchParams.get("tlang"),
          capturedAt: Date.now(),
        });
      } catch {
        /* ignore malformed URLs */
      }
    },
    {
      urls: [
        "*://*.youtube.com/api/timedtext*",
        "*://*.youtube-nocookie.com/api/timedtext*",
      ],
    },
  );

  setInterval(() => {
    const cutoff = Date.now() - YT_CACHE_TTL_MS;
    for (const [id, v] of ytCaptionCache) {
      if (v.capturedAt < cutoff) ytCaptionCache.delete(id);
    }
  }, YT_CACHE_GC_MS);
}
