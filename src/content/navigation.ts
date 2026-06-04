// Navigation watcher — SPA URL change detection + onEnded pending-next window.
//
// Replaces the old ContentApp.startSpaWatcher() polling (the WIRE agent removes
// that method). Emits NavEvents to a callback; the callback dispatches to
// continueOnNewVideo or stopSession.
//
// B4: Also kicks off an eager caption prefetch when a new YouTube videoId is
// detected AND no session is active, so Start does not pay the caption-fetch
// latency. The result is stored in the prefetch caption cache (caption-cache.ts)
// and consumed by the subtitle-first pipeline via `getPrefetchedCaptions`.

import { STOP_REASON, type StopReason } from "./stop-reasons";
import type { ContentApp } from "./index";
import {
  setPrefetchedCaptions,
  clearPrefetchedCaptions,
} from "@/platforms/youtube/caption-cache";

/** Emitted by NavigationWatcher when it detects a relevant URL change or video end. */
export type NavEvent =
  | { kind: "continue"; videoId: string }
  | { kind: "stop"; reason: StopReason };

// How long (ms) to poll location.href for URL changes.
const URL_POLL_MS = 500;
// Debounce window (ms) before treating a new videoId as stable.
// The poll-path uses the full 700ms to coalesce rapid playlist skips.
// The yt-navigate-finish event path uses a much shorter debounce (~100ms)
// since the event is single-fire per SPA navigation — 700ms adds unnecessary
// dead time to every auto-next transition.
const NAV_DEBOUNCE_MS = 700;
const NAV_DEBOUNCE_YT_EVENT_MS = 100;
// After `onEnded`: wait this long for a follow-up navigation before stopping.
const PENDING_NEXT_TIMEOUT_MS = 8_000;

/**
 * NavigationWatcher — watches for SPA navigations and video-end transitions.
 *
 * Start lifecycle:
 *   new NavigationWatcher(app) → .start(callback) → use → .stop()
 *
 * `notifyEnded()` must be called from the source <video> `ended` event handler.
 */
export class NavigationWatcher {
  #app: ContentApp;
  #pollTimer: ReturnType<typeof setInterval> | null = null;
  #debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Source that started the current debounce ('poll' uses long window; 'yt-event' uses short). */
  #debounceSource: 'poll' | 'yt-event' = 'poll';
  #pendingNextTimer: ReturnType<typeof setTimeout> | null = null;
  #onEvent: ((e: NavEvent) => void) | null = null;

  #lastUrl: string = location.href;
  #lastVideoId: string | null = null;
  /** True when a pending-next window is open (notifyEnded was called and not resolved). */
  #pendingNext = false;
  /** Guard: true while an emit is in progress (prevents re-entrant double-emit). */
  #emitting = false;

  // YouTube yt-navigate-finish listener (best-effort, cleaned up in stop()).
  #ytNavListener: (() => void) | null = null;

  // ── B4: eager caption prefetch ────────────────────────────────────────────
  /** AbortController for the in-flight prefetch (one per videoId). */
  #prefetchAbort: AbortController | null = null;
  /** videoId currently being prefetched (guards against duplicate triggers). */
  #prefetchingForId: string | null = null;

  constructor(app: ContentApp) {
    this.#app = app;
  }

  /**
   * Begin watching for navigation events and arm the video-end handler.
   * `onEvent` will receive at most one event per detected navigation.
   */
  start(onEvent: (e: NavEvent) => void): void {
    this.#onEvent = onEvent;
    this.#lastUrl = location.href;
    this.#lastVideoId = this.#app.adapter.getVideoId(location.href);
    this.#emitting = false;
    this.#pendingNext = false;

    // 500ms href poll — cross-platform baseline.
    this.#pollTimer = setInterval(() => {
      this.#checkUrl('poll');
    }, URL_POLL_MS);

    // YouTube: also subscribe to yt-navigate-finish for lower latency.
    // Only install when the active adapter is YouTube (feature-detect by id).
    if (this.#app.adapter.id === "youtube") {
      const handler = (): void => {
        // Use a short debounce (~100ms): yt-navigate-finish is single-fire per
        // SPA navigation so we don't need the 700ms coalescing window.
        this.#checkUrl('yt-event');
      };
      document.addEventListener("yt-navigate-finish", handler);
      this.#ytNavListener = () => {
        document.removeEventListener("yt-navigate-finish", handler);
      };
    }
  }

  /** Clean up all timers and event listeners. */
  stop(): void {
    if (this.#pollTimer !== null) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }
    this.#clearDebounce();
    this.#clearPendingNext();
    this.#cancelPrefetch();
    this.#ytNavListener?.();
    this.#ytNavListener = null;
    this.#onEvent = null;
  }

  /**
   * Called from the source <video> `ended` event handler.
   * Arms a ~8s pending-next window: if a qualifying navigation occurs within it,
   * the continue path handles it naturally; if the timer fires with no navigation,
   * emits {stop, VIDEO_ENDED}.
   */
  notifyEnded(): void {
    // If a pending-next window is already open, ignore (shouldn't happen, but safe).
    if (this.#pendingNext) return;
    this.#pendingNext = true;

    this.#pendingNextTimer = setTimeout(() => {
      this.#pendingNextTimer = null;
      if (!this.#pendingNext) return; // already resolved by a navigation
      this.#pendingNext = false;
      this.#emit({ kind: "stop", reason: STOP_REASON.VIDEO_ENDED });
    }, PENDING_NEXT_TIMEOUT_MS);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  #checkUrl(source: 'poll' | 'yt-event' = 'poll'): void {
    const currentUrl = location.href;
    if (currentUrl === this.#lastUrl) return;

    // URL changed — update lastUrl but wait for debounce before acting.
    this.#lastUrl = currentUrl;

    // If not a watch page, stop immediately (no debounce needed).
    if (!this.#app.adapter.isWatchUrl(currentUrl)) {
      this.#clearDebounce();
      // Only stop if a session is running.
      if (this.#app.sm.session != null) {
        this.#emit({ kind: "stop", reason: STOP_REASON.SPA_NAVIGATION });
      }
      return;
    }

    // Watch URL — debounce to let the URL settle.
    // poll-path: 700ms to coalesce rapid playlist skips.
    // yt-event path: 100ms — single-fire per SPA nav, no coalescing needed.
    const debounceDuration =
      source === 'yt-event' ? NAV_DEBOUNCE_YT_EVENT_MS : NAV_DEBOUNCE_MS;

    // If a yt-event fires while a poll debounce is in-flight, the yt-event wins
    // (shorter window). If a poll fires while a yt-event debounce is in-flight,
    // keep the shorter window.
    const shouldReplace =
      this.#debounceTimer === null ||
      source === 'yt-event' ||
      this.#debounceSource === 'poll';
    if (!shouldReplace) return;

    this.#clearDebounce();
    this.#debounceSource = source;
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      this.#handleStableUrl(location.href);
    }, debounceDuration);
  }

  #handleStableUrl(stableUrl: string): void {
    // Re-check after debounce: must still be a watch URL.
    if (!this.#app.adapter.isWatchUrl(stableUrl)) {
      if (this.#app.sm.session != null) {
        this.#emit({ kind: "stop", reason: STOP_REASON.SPA_NAVIGATION });
      }
      return;
    }

    const newId = this.#app.adapter.getVideoId(stableUrl);

    // Must have a valid id that differs from the last-known id.
    if (!newId || newId === this.#lastVideoId) return;

    // B4: Eager caption prefetch — kick off regardless of session state.
    // • Idle (no session): prefetch so cold-start doesn't pay caption-fetch latency.
    // • Active session (auto-next): prefetch IN PARALLEL before emitting continue,
    //   so restart() consumes the cached result instead of fetching serially at the
    //   worst possible time (while the video is trying to play).
    if (this.#app.sm.session == null) {
      // Update tracking so the next navigation starts fresh.
      this.#lastVideoId = newId;
      // Trigger prefetch only for adapters with subtitle-first capability.
      if (this.#app.adapter.capabilities.subtitleFirst) {
        this.#startPrefetch(newId);
      }
      return;
    }

    // Active session — resolve the pending-next window (if any) first.
    this.#clearPendingNext();
    this.#pendingNext = false;

    // Kick off the eager prefetch IN PARALLEL so restart() can consume it via
    // getPrefetchedCaptions().  We pass `forActiveSession: true` so the guard
    // inside #startPrefetch skips the "no session" check.
    if (this.#app.adapter.capabilities?.subtitleFirst) {
      this.#startPrefetch(newId, true);
    }

    // Update tracking.
    this.#lastVideoId = newId;

    this.#emit({ kind: "continue", videoId: newId });
  }

  #emit(event: NavEvent): void {
    // Re-entrant guard: if the callback somehow triggers another URL check and
    // a second emit before returning, suppress it. Normal navigations are
    // independent — #emitting resets after the callback returns.
    if (this.#emitting) return;
    this.#emitting = true;
    try {
      this.#onEvent?.(event);
    } finally {
      this.#emitting = false;
    }
  }

  // ── B4: prefetch helpers ─────────────────────────────────────────────────

  /**
   * Start an eager caption prefetch for `videoId` if no prefetch is already
   * in-flight for this video.  Each call gets its own AbortController; a
   * subsequent call for a different videoId aborts the previous one first so
   * rapid playlist skipping does not accumulate stale fetches.
   *
   * @param forActiveSession  When true, skip the "no session" guard so the
   *   prefetch runs in parallel with the active-session auto-next transition.
   *   restart() will consume the result via getPrefetchedCaptions().
   */
  #startPrefetch(videoId: string, forActiveSession = false): void {
    // Guard: don't re-fetch what we're already fetching.
    if (this.#prefetchingForId === videoId) return;

    // Abort any previous in-flight prefetch (different videoId).
    this.#cancelPrefetch();

    // Guard: if a session started while the debounce was running, skip —
    // UNLESS we're intentionally prefetching for the active-session auto-next.
    if (!forActiveSession && this.#app.sm.session != null) return;

    const ac = new AbortController();
    this.#prefetchAbort = ac;
    this.#prefetchingForId = videoId;

    // Clear any previous prefetch result for this videoId — a new navigation
    // to the same video should get fresh captions.
    clearPrefetchedCaptions(videoId);

    void this.#app.adapter
      .fetchCaptions({ videoId, signal: ac.signal })
      .then((result) => {
        // Bail out if cancelled or videoId changed.
        if (ac.signal.aborted) return;
        if (this.#prefetchingForId !== videoId) return;
        // For idle prefetch, discard if a session started in the meantime
        // (the session will fetch its own captions).  For active-session
        // prefetch (forActiveSession), ALWAYS store — restart() will consume it.
        if (!forActiveSession && this.#app.sm.session != null) return;
        if (result) {
          setPrefetchedCaptions(videoId, result);
        }
      })
      .catch(() => {
        // Network error or aborted — silently swallow; Start will fetch normally.
      })
      .finally(() => {
        if (this.#prefetchingForId === videoId) {
          this.#prefetchAbort = null;
          this.#prefetchingForId = null;
        }
      });
  }

  /** Cancel the current in-flight prefetch (if any). */
  #cancelPrefetch(): void {
    if (this.#prefetchAbort !== null) {
      this.#prefetchAbort.abort();
      this.#prefetchAbort = null;
      this.#prefetchingForId = null;
    }
  }

  // ── Debounce / pending-next helpers ──────────────────────────────────────

  #clearDebounce(): void {
    if (this.#debounceTimer !== null) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = null;
    }
  }

  #clearPendingNext(): void {
    if (this.#pendingNextTimer !== null) {
      clearTimeout(this.#pendingNextTimer);
      this.#pendingNextTimer = null;
    }
  }
}
