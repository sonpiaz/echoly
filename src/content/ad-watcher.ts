// Ad watcher — instant mid-session ad detection (SOLUTION §2).
//
// Mirrors NavigationWatcher's shape (constructor(app) → start(onAdStart, onAdEnd)
// → stop()): per-session, ContentApp-owned, re-armed on each new session and on
// auto-next restart (an ad can run on the next autoplay video).
//
// Two signals, one edge-detector:
//   • PRIMARY — a MutationObserver on the platform's ad-signal target's `class`
//     attribute (YouTube: `#movie_player`, via adapter.getAdSignalTarget()). It
//     fires the SAME microtask YouTube flips `ad-showing`/`ad-interrupting`, so
//     the dub pauses instantly — no poll latency, no dub over the ad.
//   • BACKSTOP — a ~250ms poll on adapter.isAdPlaying() for platforms with no
//     observer target, and to catch any observer miss (e.g. the target element
//     is swapped out / re-created mid-session).
//
// Both feed `#evaluate()`, which edge-detects on the `#adActive` boolean: it
// calls onAdStart() exactly once on false→true and onAdEnd() exactly once on
// true→false. Class churn that does not flip the boolean is ignored.

import type { ContentApp } from "./index";
import { AD_WAIT_POLL_MS } from "@/shared/constants";

/**
 * AdWatcher — watches for mid-session ad start/end transitions and reports each
 * exactly once.
 *
 * Lifecycle: `new AdWatcher(app) → .start(onAdStart, onAdEnd) → use → .stop()`.
 * Clean disconnect in stop() (observer + poll) — no leak across SPA navs (same
 * discipline as NavigationWatcher).
 */
export class AdWatcher {
  #app: ContentApp;

  /** MutationObserver on the ad-signal target's `class` attribute (primary). */
  #observer: MutationObserver | null = null;
  /** ~250ms poll timer (backstop). */
  #pollTimer: ReturnType<typeof setInterval> | null = null;

  /** Edge-detect state — true while an ad is currently on. */
  #adActive = false;

  #onAdStart: (() => void) | null = null;
  #onAdEnd: (() => void) | null = null;

  constructor(app: ContentApp) {
    this.#app = app;
  }

  /**
   * Begin watching. `onAdStart` fires once when an ad begins; `onAdEnd` fires
   * once when it ends (skip / natural end). Seeds `#adActive` from the current
   * ad state WITHOUT firing a callback — a session that Started during an ad has
   * already been handled by the start ad-gate, so the watcher only reports
   * subsequent transitions.
   */
  start(onAdStart: () => void, onAdEnd: () => void): void {
    this.#onAdStart = onAdStart;
    this.#onAdEnd = onAdEnd;
    // Seed from the current state so we don't fire onAdStart for an ad that the
    // start ad-gate already resolved (or onAdEnd for "no ad" at start).
    this.#adActive = this.#isAdPlaying();

    // PRIMARY: observe the ad-signal target's class attribute for instant detection.
    const target = this.#app.adapter.getAdSignalTarget?.() ?? null;
    if (target) {
      this.#observer = new MutationObserver(() => this.#evaluate());
      this.#observer.observe(target, { attributes: true, attributeFilter: ["class"] });
    }

    // BACKSTOP: ~250ms poll (also the ONLY signal for adapters with no target).
    this.#pollTimer = setInterval(() => this.#evaluate(), AD_WAIT_POLL_MS);

    console.info("[ad] watcher STARTED", {
      adActive: this.#adActive,
      hasObserver: this.#observer != null,
      adapter: this.#app.adapter.id,
    });
  }

  /** Clean up the observer + poll. Idempotent. */
  stop(): void {
    if (this.#observer) {
      this.#observer.disconnect();
      this.#observer = null;
    }
    if (this.#pollTimer !== null) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }
    this.#onAdStart = null;
    this.#onAdEnd = null;
  }

  /** True while an ad is currently active (per the last evaluated edge). */
  get adActive(): boolean {
    return this.#adActive;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  #isAdPlaying(): boolean {
    return this.#app.adapter.isAdPlaying?.() === true;
  }

  /**
   * Re-read the ad state and edge-detect. Called from BOTH the observer and the
   * poll — they converge on the same `#adActive` boolean, so a class change seen
   * by the observer in the same microtask and the poll 250ms later cannot
   * double-fire: only an actual boolean flip emits a callback.
   */
  #evaluate(): void {
    const now = this.#isAdPlaying();
    if (now === this.#adActive) return; // no boolean flip — ignore class churn
    this.#adActive = now;
    if (now) {
      console.info("[ad] ad STARTED → pause dub");
      this.#onAdStart?.();
    } else {
      console.info("[ad] ad ENDED → resume dub");
      this.#onAdEnd?.();
    }
  }
}
