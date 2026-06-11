/**
 * render-cache.ts — PAGE-LIFETIME audio render cache for SubtitleFirstPipeline.
 *
 * Each dub (re)start (pause/seek/auto-restart) previously built a fresh pipeline
 * whose _batchRequestIds map reset, causing the 30 s lookahead window to be
 * re-requested with fresh request ids and re-billed (~24–29 credits per restart;
 * one line was billed 4× across 10 restarts in the forensic session).
 *
 * This module holds a CONTENT-SCRIPT-LIFETIME Map that outlives every pipeline
 * instance. When #renderBatch checks a line before adding it to a server request,
 * a cache hit replays the decoded audio for free — zero credits, zero fetches.
 *
 * Cache key: videoId + "/" + lineIndex + "/" + shortHash(text) + "/" + targetLang
 *            + "/" + voiceId
 *   • Isolates by video: auto-next to a different video is naturally isolated.
 *   • Isolates by language/voice: changing target language or voice bypasses.
 *   • The text hash prevents a re-grouped sentence (different text at same index)
 *     from poisoning the slot.
 *
 * Bounds (FIFO/LRU cap):
 *   • MAX_ENTRIES = 300 lines.
 *   • MAX_B64_BYTES ≈ 25 MB (total b64 string lengths across all entries).
 *   On overflow the OLDEST entry is evicted first (insertion-order FIFO).
 *
 * Staleness:
 *   • clearVideoCache(videoId): called on navigation to a different video.
 *   • clearAllCache(): resets the whole map (e.g. language/voice change).
 *   • Stale-callback guard: callers must check sm.session === s before writing.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RenderCacheEntry {
  /** Base-64 encoded MP3 audio (the raw b64 string from the server). */
  audioB64: string;
  /** Translated text for this line. */
  text: string;
  /** Insertion timestamp (ms epoch) — informational only, eviction is FIFO. */
  ts: number;
  /** Pre-decoded AudioBuffer, populated on cache write to avoid re-decoding. */
  buffer?: AudioBuffer;
}

// ─── Internal state ───────────────────────────────────────────────────────────

/** Max number of cached lines (oldest evicted first on overflow). */
export const RENDER_CACHE_MAX_ENTRIES = 300;

/**
 * Max total b64 bytes (sum of audioB64.length across all entries).
 * ~25 MB: typical 30 s lookahead at 80 KB/line ≈ ~2.5 MB, so 300 lines is
 * the binding limit in practice; the byte cap is a belt-and-suspenders guard.
 */
export const RENDER_CACHE_MAX_B64_BYTES = 25 * 1024 * 1024; // 25 MB in chars

/**
 * The module-level cache map — lives for the full content-script lifetime.
 * Key: cacheKey(videoId, lineIndex, text, targetLang, voiceId).
 * Iteration order = insertion order (ES2015+), so oldest entries are first.
 */
const _cache = new Map<string, RenderCacheEntry>();

/** Running total of audioB64.length across all entries. */
let _totalB64Bytes = 0;

// ─── Key helpers ─────────────────────────────────────────────────────────────

/**
 * Short deterministic hash of `s` — 32-bit djb2 truncated to hex.
 * Collision risk is negligible at 300-entry scale.
 */
function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; // keep 32-bit unsigned
  }
  return h.toString(16);
}

/**
 * Build the cache key for a rendered line.
 *
 * @param videoId   - The same videoId the pipeline derives (adapter.getVideoId).
 * @param lineIndex - 0-based global sentence index.
 * @param text      - Original source text of the sentence.
 * @param targetLang - Target language code (e.g. "vi").
 * @param voiceId   - TTS voice id (e.g. "English_magnetic_voiced_man").
 */
export function cacheKey(
  videoId: string,
  lineIndex: number,
  text: string,
  targetLang: string,
  voiceId: string,
): string {
  return `${videoId}/${lineIndex}/${shortHash(text)}/${targetLang}/${voiceId}`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Look up a rendered line in the cache.
 * Returns the entry or `undefined` on a miss.
 */
export function cacheGet(key: string): RenderCacheEntry | undefined {
  return _cache.get(key);
}

/**
 * Write a rendered line into the cache.
 * Enforces the FIFO cap: if the cache would exceed MAX_ENTRIES or
 * MAX_B64_BYTES, the OLDEST entry is evicted until both constraints are met.
 *
 * @param key      - Result of `cacheKey(...)`.
 * @param entry    - The cache entry to store.
 */
export function cacheSet(key: string, entry: RenderCacheEntry): void {
  // If the key already exists, remove its old byte contribution first.
  const existing = _cache.get(key);
  if (existing) {
    _totalB64Bytes -= existing.audioB64.length;
    _cache.delete(key);
  }

  // Evict oldest entries until constraints satisfied.
  const incomingBytes = entry.audioB64.length;
  while (
    _cache.size >= RENDER_CACHE_MAX_ENTRIES ||
    _totalB64Bytes + incomingBytes > RENDER_CACHE_MAX_B64_BYTES
  ) {
    const oldestKey = _cache.keys().next().value;
    if (oldestKey === undefined) break; // empty map — nothing to evict
    const oldEntry = _cache.get(oldestKey)!;
    _totalB64Bytes -= oldEntry.audioB64.length;
    _cache.delete(oldestKey);
  }

  _cache.set(key, entry);
  _totalB64Bytes += incomingBytes;
}

/**
 * Remove all entries whose key starts with `videoId + "/"`.
 * Called on navigation to a different video.
 */
export function clearVideoCache(videoId: string): void {
  const prefix = videoId + "/";
  for (const [k, v] of _cache) {
    if (k.startsWith(prefix)) {
      _totalB64Bytes -= v.audioB64.length;
      _cache.delete(k);
    }
  }
}

/**
 * Wipe the entire cache (language/voice change, or unit-test teardown).
 */
export function clearAllCache(): void {
  _cache.clear();
  _totalB64Bytes = 0;
}

/**
 * Return current cache statistics — exposed for tests and debugging.
 */
export function cacheStats(): { size: number; totalB64Bytes: number } {
  return { size: _cache.size, totalB64Bytes: _totalB64Bytes };
}
