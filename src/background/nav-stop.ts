// ────────────────────────────────────────────────────────────────────────────
// Nav-stop — observes chrome.tabs.onUpdated on the SESSION tab and decides
// whether a url change should tear the session down.
//
//   • Hard navigation (full page load / reload / cross-origin) — `status:"loading"`
//     accompanies the url change. The content script is being replaced, so the
//     background is the authority → stop.
//   • SPA url change (YouTube history.pushState watch→watch autoplay/next) with an
//     ACTIVE session and the new url still a supported watch page → SKIP the stop.
//     The content NavigationWatcher owns this watch→watch transition
//     (continueOnNewVideo / auto-next). Stopping here would tear the session down
//     before the watcher can continue the dub — this was why auto-next never fired
//     (bg killed the session on the very navigation the content side needed).
//   • SPA url change to a NON-watch url while a session is ACTIVE → DEFERRED stop.
//     Instead of stopping immediately (which would tear down a session during a
//     transient ad→content URL flicker), we schedule a re-check after
//     NAV_STOP_RECHECK_MS. At expiry, we call chrome.tabs.get(tabId) to read the
//     live url. If the tab has returned to a supported watch page, the transient
//     resolved and we cancel the stop. If the session is no longer active or the
//     tab belongs to a different session, we also cancel. Only if the url is still
//     non-watch and the same session is active do we call session.stop().
//   • Leaving the dubbable context (watch→home/search, or another site) → stop
//     (after the re-check window).
//   • Url change while NOT running/connecting → stop immediately (nothing for the
//     watcher to continue; clean up any stale state).
//
// Extracted from index.ts (inline listener) so it is unit-testable the same way
// registerAutoStart is — the returned listener can be invoked directly with
// synthetic onUpdated payloads.
// ────────────────────────────────────────────────────────────────────────────

import { isSupportedWatchUrl } from "@/platforms/registry";
import { NAV_STOP_RECHECK_MS } from "@/shared/constants";
import type { Store } from "./store";
import type { SessionCoordinator } from "./session-coordinator";

/** Per-tab pending deferred-stop timers.  Module-scoped; mirrors `lastFireAt` in
 *  auto-start.ts.  Keyed by tabId so simultaneous sessions on different tabs are
 *  isolated.  The SW recycles these naturally. */
const pendingDeferredStop = new Map<number, ReturnType<typeof setTimeout>>();

/** Test-only: reset module state between specs. */
export function resetNavStopState(): void {
  for (const timer of pendingDeferredStop.values()) clearTimeout(timer);
  pendingDeferredStop.clear();
}

/** Register the session-tab tabs.onUpdated stop listener. Returns the listener
 *  fn so tests can invoke it without going through chrome's event dispatch. */
export function registerNavStop(
  store: Store,
  session: SessionCoordinator,
): (tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => void {
  const listener = (
    tabId: number,
    changeInfo: chrome.tabs.TabChangeInfo,
  ): void => {
    if (tabId !== store.state.tabId || !changeInfo.url) return;
    // Hard navigation (full page load / reload / cross-origin): `status:"loading"`
    // accompanies the url change. The content script is being replaced, so the
    // background is the authority → stop. YouTube's history.pushState SPA
    // navigations (watch→watch autoplay/next) do NOT set status:"loading".
    if (changeInfo.status === "loading") {
      // A genuine hard nav supersedes any pending deferred-stop check for this tab.
      const pending = pendingDeferredStop.get(tabId);
      if (pending !== undefined) {
        clearTimeout(pending);
        pendingDeferredStop.delete(tabId);
      }
      // Record a continuation intent so auto-start re-dubs the fresh page (playlist
      // auto-advance is intermittently a GENUINE hard nav that destroys the content
      // script — the bg is the only survivor). Only when a dub is actually active
      // (running OR connecting — symmetric with the SPA-skip branch below and the
      // pre-clear, so a hard nav mid-connect still continues) and the destination is
      // still a supported watch page; otherwise clear any stale intent (leaving the
      // dub context → no continuation). A user Stop emits no status:"loading" event,
      // so the intent is never set on a user Stop.
      if (
        (store.state.running || store.state.connecting) &&
        isSupportedWatchUrl(changeInfo.url)
      ) {
        store.setContinuationIntent({ tabId, at: Date.now() });
      } else {
        store.setContinuationIntent(null);
      }
      // session.stop() captures `wasActive = running || connecting` SYNCHRONOUSLY at
      // the top of its body (before its first await), so call it FIRST — it then
      // performs the right relay/cleanup for the (now-dead) content script.
      // Immediately AFTER, pre-clear running/connecting synchronously: stop() is
      // async and would otherwise only flip running=false after its relay to the
      // dead content script settles; a fast new-page load could fire `complete`
      // before then, making auto-start's Gate-5 (!running) spuriously block the
      // continuation. The content script is already gone on a hard nav, so clearing
      // eagerly is safe.
      void session.stop();
      store.setRunning(false);
      store.setConnecting(false);
      return;
    }
    // SPA url change with an ACTIVE session and the new url still a supported
    // watch page → SKIP the stop. The content NavigationWatcher owns this
    // watch→watch transition (continueOnNewVideo / auto-next). Stopping here
    // would tear the session down before the watcher can continue the dub —
    // this was why auto-next never fired (bg killed the session on the very
    // navigation the content side needed). Leaving the dubbable context
    // (watch→home/search, or another site) still falls through to stop.
    if (
      (store.state.running || store.state.connecting) &&
      isSupportedWatchUrl(changeInfo.url)
    ) {
      // The transient resolved back to a watch page — cancel any pending deferred
      // stop so we do not tear down a session that should continue.
      const pending = pendingDeferredStop.get(tabId);
      if (pending !== undefined) {
        clearTimeout(pending);
        pendingDeferredStop.delete(tabId);
      }
      return;
    }

    // Not running/connecting — no active session to guard; stop immediately.
    if (!store.state.running && !store.state.connecting) {
      void session.stop();
      return;
    }

    // Active session + SPA nav to a non-watch URL.  Instead of stopping
    // immediately (which would tear down the session during a transient
    // ad→content URL flicker), schedule a deferred re-check.  A new
    // onUpdated event for this tab (arriving before expiry) will:
    //   • cancel the timer if the new URL is a watch page (transient resolved), OR
    //   • reschedule it for the new non-watch URL.
    const existing = pendingDeferredStop.get(tabId);
    if (existing !== undefined) clearTimeout(existing);

    const timer = setTimeout(() => {
      pendingDeferredStop.delete(tabId);
      void (async () => {
        try {
          const tab = await chrome.tabs.get(tabId);
          if (tab.url && isSupportedWatchUrl(tab.url)) {
            // URL recovered to a watch page — transient resolved; do not stop.
            return;
          }
          if (
            store.state.tabId !== tabId ||
            (!store.state.running && !store.state.connecting)
          ) {
            // A different session now owns this tab, or the session already ended
            // via another path — stale guard; do not issue a double-stop.
            return;
          }
          void session.stop();
        } catch {
          // chrome.tabs.get threw — the tab was closed/removed while we were
          // waiting.  Clean up whatever session state is left.
          void session.stop();
        }
      })();
    }, NAV_STOP_RECHECK_MS);

    pendingDeferredStop.set(tabId, timer);
  };

  chrome.tabs.onUpdated.addListener(listener);
  return listener;
}
