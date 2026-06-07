// ────────────────────────────────────────────────────────────────────────────
// Auto-start — observes chrome.tabs.onUpdated and starts a translation session
// when ALL of the following hold:
//
//   1. changeInfo.status === "complete"  (page finished loading)
//   2. tab.url is a YouTube watch page   (https://*.youtube.com/watch...)
//   3. user is signed in                  (store.state.signedInUser !== null)
//   4. autoStartHosts[host] === true      (per-host opt-in from Advanced)
//   5. no session is already running      (running OR connecting → no-op)
//
// Per-tab debounce: YouTube is a SPA — opening /watch?v=A then clicking a
// recommendation to /watch?v=B fires multiple `complete` events within seconds,
// and the existing tabs.onUpdated handler in index.ts will stop the previous
// session on URL change. We do NOT want to chain-start. A 1.5s per-tab guard
// dedupes the storm; the guard clears when the listener fires (regardless of
// whether we started — so a user who toggled the host OFF mid-storm doesn't
// see a delayed start).
// ────────────────────────────────────────────────────────────────────────────

import { normalizeDomain } from "@/shared/advanced";
import { isSupportedWatchUrl } from "@/platforms/registry";
import type { Store } from "./store";
import type { SessionCoordinator } from "./session-coordinator";

const DEBOUNCE_MS = 1500;

/** A hard-nav continuation intent is honoured only if the fresh `complete` lands
 *  within this window of the nav (loading→complete is ~1s; 12s is generous slack
 *  for a slow playlist load while still expiring a stale/abandoned intent). */
const CONTINUATION_WINDOW_MS = 12000;

/** Per-tab "last fired" timestamps. Module-scoped; the SW recycles wipe these
 *  naturally (which is correct — fresh SW boot = fresh debounce). */
const lastFireAt = new Map<number, number>();

/** Test-only: reset module state between specs. */
export function resetAutoStartState(): void {
  lastFireAt.clear();
}

/** Register the tabs.onUpdated listener. Returns the listener fn so tests can
 *  invoke it without going through chrome's event dispatch. */
export function registerAutoStart(
  store: Store,
  session: SessionCoordinator,
): (
  tabId: number,
  changeInfo: chrome.tabs.TabChangeInfo,
  tab: chrome.tabs.Tab,
) => void {
  const listener = (
    tabId: number,
    changeInfo: chrome.tabs.TabChangeInfo,
    tab: chrome.tabs.Tab,
  ): void => {
    // Gate 1 — only fire on full load. (status="loading" fires many times.)
    if (changeInfo.status !== "complete") return;
    // Gate 2 — must be a supported watch URL on any platform.
    const url = tab.url;
    if (typeof url !== "string" || !isSupportedWatchUrl(url)) return;
    let host: string | null;
    try {
      host = normalizeDomain(new URL(url).hostname);
    } catch {
      return;
    }
    if (!host) return;
    // Gate 3 — signed in (Advanced settings are server-owned).
    if (store.state.signedInUser === null) return;
    // Hard-nav continuation: a running dub that hard-navigated to another watch
    // page (playlist auto-advance) recorded an intent in nav-stop. PEEK it here —
    // do NOT clear yet (several gates below early-return; clearing now would lose
    // it on an event that never starts). A fresh same-tab intent bypasses Gate-4
    // so the dub follows the playlist even on a host that never opted into
    // auto-start. Gates 1/2/3/5 + the debounce still apply.
    const intent = store.getContinuationIntent();
    const isContinuation =
      intent !== null &&
      intent.tabId === tabId &&
      Date.now() - intent.at < CONTINUATION_WINDOW_MS;
    // Gate 4 — host opted in (bypassed for a fresh continuation).
    if (!isContinuation && store.state.advanced.autoStartHosts[host] !== true) {
      return;
    }
    // Gate 5 — nothing already running/connecting.
    if (store.state.running || store.state.connecting) return;
    // Per-tab debounce. First event ever on a tab always passes; subsequent
    // events within DEBOUNCE_MS are dropped (SPA URL change storm protection).
    const now = Date.now();
    const last = lastFireAt.get(tabId);
    if (last !== undefined && now - last < DEBOUNCE_MS) return;
    lastFireAt.set(tabId, now);

    // CONSUME the intent only now — every gate + the debounce have passed and we
    // are committed to start. Clearing here (and only here) makes a continuation
    // fire exactly once: a second `complete` for the same tab finds no intent and
    // is governed by normal Gate-4. Earlier gates never consume it.
    store.setContinuationIntent(null);
    void session.start({});
  };
  chrome.tabs.onUpdated.addListener(listener);
  return listener;
}
