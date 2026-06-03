// webRequest cache for signed YouTube /api/timedtext URLs (subtitle-first layer 1).
//
// Moved from `src/background/youtube-caption-cache.ts`.
// Export names are preserved so `background/router.ts` and `background/index.ts`
// can be re-pointed to this path by owner D.
//
// Also exports the **prefetch caption cache** — a small in-memory
// Map<videoId, CaptionFetchResult> populated by the NavigationWatcher when it
// detects a new YouTube video and no session is active. The subtitle-first
// pipeline reads from this cache via `getPrefetchedCaptions(videoId)` to skip
// the caption-fetch step on Start.

import { YT_CACHE_GC_MS, YT_CACHE_TTL_MS } from "@/shared/constants";
import type { CaptionFetchResult } from "@/shared/platform-ports";

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

// ── Prefetch caption cache (B4) ───────────────────────────────────────────────
//
// A small in-memory map populated by NavigationWatcher when a new YouTube video
// is detected AND no session is active. The subtitle-first pipeline can call
// `getPrefetchedCaptions(videoId)` to skip the caption fetch on Start.
//
// Lifecycle:
//   - Written by `setPrefetchedCaptions(videoId, result)` from navigation.ts.
//   - Read by `getPrefetchedCaptions(videoId)` from the subtitle-first pipeline
//     (Agent E / integration wires this; this module only provides the cache).
//   - Cleared for a specific videoId by `clearPrefetchedCaptions(videoId)` after
//     the pipeline consumes it (one-shot use).
//   - Replaced when a newer prefetch for the same videoId succeeds.
//
// The map is intentionally small (at most a handful of recent videoIds) and
// never GC'd automatically — entries are consumed once (cleared on use).

/** Maximum number of prefetch entries to keep in memory (LRU-evict oldest). */
const PREFETCH_MAX = 4;

interface PrefetchEntry {
  result: CaptionFetchResult;
  fetchedAt: number;
}

const prefetchCaptionCache = new Map<string, PrefetchEntry>();

/**
 * Store a successfully prefetched caption result for `videoId`.
 * Evicts the oldest entry when the cache reaches PREFETCH_MAX.
 */
export function setPrefetchedCaptions(
  videoId: string,
  result: CaptionFetchResult,
): void {
  // Evict oldest if at capacity (and not the same key being updated).
  if (prefetchCaptionCache.size >= PREFETCH_MAX && !prefetchCaptionCache.has(videoId)) {
    const oldest = prefetchCaptionCache.keys().next().value;
    if (oldest !== undefined) prefetchCaptionCache.delete(oldest);
  }
  prefetchCaptionCache.set(videoId, { result, fetchedAt: Date.now() });
}

/**
 * Retrieve a previously prefetched caption result for `videoId`, or `null`
 * if no prefetch is available.
 *
 * NOTE: this does NOT consume (clear) the entry — call
 * `clearPrefetchedCaptions(videoId)` after use to free the memory and
 * prevent stale data from being re-used on a subsequent Start.
 */
export function getPrefetchedCaptions(videoId: string): CaptionFetchResult | null {
  return prefetchCaptionCache.get(videoId)?.result ?? null;
}

/**
 * Remove the prefetch entry for `videoId` (call after the pipeline has
 * consumed the result so stale data is not re-used).
 */
export function clearPrefetchedCaptions(videoId: string): void {
  prefetchCaptionCache.delete(videoId);
}
