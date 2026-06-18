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
// Terminal idle timeout (ms). `notifyEnded` arms this LONG window; it only fires
// a {stop, VIDEO_ENDED} if NO navigation happened AND the video is genuinely
// finished. The 500ms URL poll + yt-navigate-finish are the REAL continuation
// trigger (they detect the auto-advance by videoId change regardless of whether
// the source <video> ever fired 'ended'). The long window lets a user who
// lingers on the up-next screen ≤45s still auto-continue when YouTube advances.
const TERMINAL_IDLE_TIMEOUT_MS = 45_000;

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
  #terminalIdleTimer: ReturnType<typeof setTimeout> | null = null;
  #onEvent: ((e: NavEvent) => void) | null = null;

  #lastUrl: string = location.href;
  #lastVideoId: string | null = null;
  /**
   * True from the moment the source video reports `ended` (notifyEnded) until the
   * next qualifying navigation resolves it. While this is set AND a session is
   * still alive, the watcher is "awaiting next": the URL poll / yt-navigate-finish
   * must emit {continue} for the next videoId — the idle branch (sm.session==null)
   * can NEVER consume it, and a still-alive session does not get torn down early.
   * The long terminal-idle timer is the only thing that can clear it without a nav.
   */
  #awaitingNext = false;
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
    this.#awaitingNext = false;
    console.info("[nav] watcher STARTED", { lastVideoId: this.#lastVideoId, adapter: this.#app.adapter.id });

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
    this.#clearTerminalIdle();
    this.#awaitingNext = false;
    this.#cancelPrefetch();
    this.#ytNavListener?.();
    this.#ytNavListener = null;
    this.#onEvent = null;
  }

  /**
   * Called from the source <video> `ended` event handler.
   *
   * NOTE: `ended` is NO LONGER the continuation trigger — YouTube frequently does
   * NOT fire it on autoplay, so the 500ms URL poll + yt-navigate-finish are what
   * actually detect the auto-advance (by videoId change, independent of `ended`).
   *
   * All `notifyEnded` does now is:
   *   1. Mark the watcher as "awaiting next" so the still-alive session keeps the
   *      watcher armed and the idle branch cannot consume the next videoId; and
   *   2. Arm a LONG terminal-idle timer (~45s). That timer ONLY emits a terminal
   *      {stop, VIDEO_ENDED} if NO navigation happened in the window AND the video
   *      is genuinely finished (ended + not mid-buffer of a new clip). A user who
   *      lingers ≤45s on the up-next screen still auto-continues when the URL flips.
   */
  notifyEnded(): void {
    // If we're already awaiting the next video, just keep the existing window.
    if (this.#awaitingNext) return;
    this.#awaitingNext = true;
    console.info("[nav] video ENDED → keep watcher alive, terminal-idle window open (%dms)", TERMINAL_IDLE_TIMEOUT_MS);

    // Capture the live session identity at arm time. If 'ended' fired AFTER the URL
    // already advanced (a NEW session is in flight), the session we'd be stopping is
    // NOT the one that ended — guard the timer on this identity so a stale 'ended'
    // can never terminate a fresh session. pageToken is the monotonic per-session
    // identity (bumped on every stop/start); session.token pins the exact session.
    const armedPageToken = this.#app.sm.pageToken;
    const armedSessionToken = this.#app.sm.session?.token ?? null;

    this.#clearTerminalIdle();
    this.#terminalIdleTimer = setTimeout(() => {
      this.#terminalIdleTimer = null;
      // Resolved by a navigation in the meantime → nothing to do.
      if (!this.#awaitingNext) return;
      // No session left to continue → nothing to stop.
      if (this.#app.sm.session == null) {
        this.#awaitingNext = false;
        return;
      }
      // A NEW session started after this 'ended' was armed (post-URL-change race):
      // the page advanced, a fresh session is live, and this stale terminal-idle
      // timer must NOT emit VIDEO_ENDED against it. Silently discard.
      if (
        this.#app.sm.pageToken !== armedPageToken ||
        (armedSessionToken !== null && this.#app.sm.session?.token !== armedSessionToken)
      ) {
        console.info("[nav] terminal-idle: session changed since 'ended' armed → discard (stale)");
        this.#awaitingNext = false;
        return;
      }
      // Still on a watch URL with a NEW video loaded? Then YouTube swapped the
      // clip without us seeing a URL change yet — let the poll/continue path own
      // it instead of terminating. (Defensive; the poll normally fires first.)
      const currentUrl = location.href;
      if (
        this.#app.adapter.isWatchUrl(currentUrl) &&
        this.#app.adapter.getVideoId(currentUrl) !== this.#lastVideoId
      ) {
        console.info("[nav] terminal-idle: new videoId already on page → defer to continue path");
        return;
      }
      this.#awaitingNext = false;
      console.warn("[nav] terminal-idle EXPIRED (no navigation in %dms) → STOP session", TERMINAL_IDLE_TIMEOUT_MS);
      this.#emit({ kind: "stop", reason: STOP_REASON.VIDEO_ENDED });
    }, TERMINAL_IDLE_TIMEOUT_MS);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  #checkUrl(source: 'poll' | 'yt-event' = 'poll'): void {
    const currentUrl = location.href;
    if (currentUrl === this.#lastUrl) return;

    console.info("[nav] URL changed", { source, from: this.#lastUrl, to: currentUrl, hasSession: this.#app.sm.session != null });
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

    // Watch→watch SPA nav while WE (the surviving content script) are alive with a
    // session (or awaiting the next video after an 'ended'). CLAIM this nav so the
    // background nav-stop does NOT tear the session down on its (often spurious
    // status:"loading") tabs.onUpdated — we own this transition in-place
    // (continueOnNewVideo). Sent EARLY here (pre-debounce) so it beats the bg's
    // claim window despite the poll latency. Only a surviving content script can
    // send this → it is also proof the document was not reloaded.
    if (this.#app.sm.session != null || this.#awaitingNext) {
      try {
        void chrome.runtime.sendMessage({ type: "CONTENT_NAV_CLAIM" });
      } catch {
        // SW asleep / no receiver — harmless; the bg simply falls back to its
        // claim-aware deferred stop (and a fresh re-dub if the doc really reloaded).
      }
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
    console.info("[nav] url stable", {
      newId, lastVideoId: this.#lastVideoId, hasSession: this.#app.sm.session != null,
    });

    // Must have a valid id that differs from the last-known id.
    if (!newId || newId === this.#lastVideoId) {
      console.info("[nav] skip (no id or same id)", { newId });
      return;
    }

    // B4: Eager caption prefetch — kick off regardless of session state.
    // • Idle (no session): prefetch so cold-start doesn't pay caption-fetch latency.
    // • Active session (auto-next): prefetch IN PARALLEL before emitting continue,
    //   so restart() consumes the cached result instead of fetching serially at the
    //   worst possible time (while the video is trying to play).
    //
    // GUARD: the idle branch (prefetch-only, consumes the videoId) must run ONLY
    // when there is genuinely no live session AND we are not awaiting the next
    // video. A still-alive session — even one whose source video already fired
    // `ended` (#awaitingNext) — must ALWAYS emit {continue} so the dub continues;
    // it must never be demoted to a prefetch that consumes the id.
    if (this.#app.sm.session == null && !this.#awaitingNext) {
      console.info("[nav] idle path (no active session) → prefetch only, NO auto-next continue");
      // Update tracking so the next navigation starts fresh.
      this.#lastVideoId = newId;
      // Trigger prefetch only for adapters with subtitle-first capability.
      if (this.#app.adapter.capabilities.subtitleFirst) {
        this.#startPrefetch(newId);
      }
      return;
    }

    // Active (or awaiting-next) session — the navigation is the auto-advance we
    // were waiting for: resolve the terminal-idle window and clear awaitingNext
    // so the continuation owns the transition.
    this.#clearTerminalIdle();
    this.#awaitingNext = false;

    // Kick off the eager prefetch IN PARALLEL so restart() can consume it via
    // getPrefetchedCaptions().  We pass `forActiveSession: true` so the guard
    // inside #startPrefetch skips the "no session" check.
    if (this.#app.adapter.capabilities?.subtitleFirst) {
      this.#startPrefetch(newId, true);
    }

    // Update tracking.
    this.#lastVideoId = newId;

    console.info("[nav] ACTIVE session + new video → emit CONTINUE (auto-next)", { newId });
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

    // Thread the source/target language hints so the prefetched track matches what
    // start()/restart() would pick. Without these the prefetch fetched with NO
    // preferLang, and restart() consumes that cached result FIRST — so auto-next
    // could silently dub from a WRONG source-language track. settings is present
    // on the active-session (auto-next) path; on an idle prefetch it may be null
    // (then these are undefined — same as before, harmless).
    const settings = this.#app.sm.settings;
    const preferLang =
      settings?.sourceLanguage && settings.sourceLanguage !== "auto"
        ? settings.sourceLanguage
        : undefined;
    const avoidLang = settings?.targetLanguage;

    void this.#app.adapter
      .fetchCaptions({ videoId, preferLang, avoidLang, signal: ac.signal })
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

  #clearTerminalIdle(): void {
    if (this.#terminalIdleTimer !== null) {
      clearTimeout(this.#terminalIdleTimer);
      this.#terminalIdleTimer = null;
    }
  }
}
