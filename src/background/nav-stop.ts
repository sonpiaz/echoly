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
//   • Leaving the dubbable context (watch→home/search, or another site) → stop.
//   • Url change while NOT running/connecting → stop (nothing for the watcher to
//     continue; clean up any stale state).
//
// Extracted from index.ts (inline listener) so it is unit-testable the same way
// registerAutoStart is — the returned listener can be invoked directly with
// synthetic onUpdated payloads.
// ────────────────────────────────────────────────────────────────────────────

import { isSupportedWatchUrl } from "@/platforms/registry";
import type { Store } from "./store";
import type { SessionCoordinator } from "./session-coordinator";

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
      return;
    }
    void session.stop();
  };

  chrome.tabs.onUpdated.addListener(listener);
  return listener;
}
