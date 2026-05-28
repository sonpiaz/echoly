// ────────────────────────────────────────────────────────────────────────────
// YouTube CC URL cache (legacy/background.js:29-71). Populated by the
// webRequest.onCompleted listener whenever YouTube itself fires a
// /api/timedtext request (when the user or our content script toggles the
// captions button). These URLs are signed with the full YouTube session context
// — Echoly can re-fetch them reliably where a manually-constructed plain URL
// returns 0-byte responses.
//
// Keyed by videoId. Manual-sub URLs are preferred over ASR: a manual entry is
// NEVER overwritten by an ASR one (the "don't downgrade" rule). TTL 30 min,
// GC every 5 min. The Map is in-memory and dies with the SW — re-fills by
// passive observation; the GC is cosmetic (TTL is also enforced... well, the
// legacy GC deletes by TTL; reads return whatever is present). Verbatim.
// ────────────────────────────────────────────────────────────────────────────

import { YT_CACHE_TTL_MS, YT_CACHE_GC_MS } from "@/shared/constants";
import type { YtCaptionEntry } from "@/shared/types";

const TIMEDTEXT_URLS = [
  "*://*.youtube.com/api/timedtext*",
  "*://*.youtube-nocookie.com/api/timedtext*",
];

export class CaptionCache {
  private readonly cache = new Map<string, YtCaptionEntry>();

  /** Look up a cached signed CC URL by videoId (legacy GET_YT_CC_URL branch). */
  get(videoId: string): YtCaptionEntry | undefined {
    return this.cache.get(videoId);
  }

  /** Record one observed /api/timedtext response. No-ops on non-200, missing
   *  videoId, or a bad URL. Never downgrades a manual entry to an ASR one
   *  (legacy 35-52). */
  record(details: chrome.webRequest.WebResponseCacheDetails): void {
    try {
      if (details.statusCode !== 200) return;
      const u = new URL(details.url);
      const videoId = u.searchParams.get("v");
      if (!videoId) return;
      const isAsr = u.searchParams.get("kind") === "asr";
      const existing = this.cache.get(videoId);
      // Don't downgrade a manual-sub cache entry to an ASR one.
      if (existing && !existing.isAsr && isAsr) return;
      this.cache.set(videoId, {
        url: details.url,
        lang: u.searchParams.get("lang") || null,
        kind: u.searchParams.get("kind") || null,
        tlang: u.searchParams.get("tlang") || null,
        isAsr,
        capturedAt: Date.now(),
      });
    } catch {
      // Bad URL or odd request shape — ignore, doesn't impact other captures.
    }
  }

  /** Delete entries older than the TTL (legacy GC body 65-70). */
  gc(now: number = Date.now()): void {
    const cutoff = now - YT_CACHE_TTL_MS;
    for (const [id, v] of this.cache) {
      if (v.capturedAt < cutoff) this.cache.delete(id);
    }
  }

  /** Register the webRequest listener + start the GC interval. Must be called
   *  SYNCHRONOUSLY at SW init so a woken SW catches the request. Guarded by the
   *  same typeof check as legacy (webRequest may be unavailable). */
  register(): void {
    if (typeof chrome.webRequest?.onCompleted?.addListener !== "function") {
      return;
    }
    chrome.webRequest.onCompleted.addListener(
      (details) => {
        this.record(details);
      },
      { urls: TIMEDTEXT_URLS },
    );
    setInterval(() => {
      this.gc();
    }, YT_CACHE_GC_MS);
  }
}
