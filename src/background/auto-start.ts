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
import type { Store } from "./store";
import type { SessionCoordinator } from "./session-coordinator";

const DEBOUNCE_MS = 1500;

/** Per-tab "last fired" timestamps. Module-scoped; the SW recycles wipe these
 *  naturally (which is correct — fresh SW boot = fresh debounce). */
const lastFireAt = new Map<number, number>();

/** Test-only: reset module state between specs. */
export function resetAutoStartState(): void {
  lastFireAt.clear();
}

function isYouTubeWatchUrl(url: string | undefined): url is string {
  if (typeof url !== "string") return false;
  // /watch path on any youtube.com subdomain. The legacy isYouTubeUrl matches
  // any path under youtube.com; for auto-start we restrict to /watch so a YT
  // homepage tab doesn't auto-fire on every reload.
  return /^https?:\/\/[^/]*youtube\.com\/watch\b/.test(url);
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
    // Gate 2 — must be a YT /watch URL.
    const url = tab.url;
    if (!isYouTubeWatchUrl(url)) return;
    let host: string | null;
    try {
      host = normalizeDomain(new URL(url).hostname);
    } catch {
      return;
    }
    if (!host) return;
    // Gate 3 — signed in. Auto-start does NOT support BYOK guests (Advanced
    // settings are server-owned; a guest has no autoStartHosts entry).
    if (store.state.signedInUser === null) return;
    // Gate 4 — host opted in.
    if (store.state.advanced.autoStartHosts[host] !== true) return;
    // Gate 5 — nothing already running/connecting.
    if (store.state.running || store.state.connecting) return;
    // Per-tab debounce. First event ever on a tab always passes; subsequent
    // events within DEBOUNCE_MS are dropped (SPA URL change storm protection).
    const now = Date.now();
    const last = lastFireAt.get(tabId);
    if (last !== undefined && now - last < DEBOUNCE_MS) return;
    lastFireAt.set(tabId, now);

    void session.start({});
  };
  chrome.tabs.onUpdated.addListener(listener);
  return listener;
}
