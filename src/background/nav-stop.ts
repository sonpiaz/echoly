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

/** Time window (ms) the background waits for the content NavigationWatcher to CLAIM
 *  a watch→watch nav before treating a status:"loading" on a watch page as a genuine
 *  hard nav. Must exceed the content URL poll (URL_POLL_MS=500) + claim latency. The
 *  only cost is a ~CLAIM_WINDOW_MS delay before a GENUINE hard-nav re-dub; SPA navs
 *  are cancelled instantly by the claim. */
export const CLAIM_WINDOW_MS = 900;

/** Per-tab last CONTENT_NAV_CLAIM time — proof the content script SURVIVED a
 *  watch→watch SPA nav and is handling it in-place. */
const recentNavClaim = new Map<number, number>();

/**
 * Honor a content nav-claim: the SURVIVING content NavigationWatcher is handling a
 * watch→watch SPA transition in-place (continueOnNewVideo). Cancels any pending
 * claim-aware stop for the tab and clears the continuation-intent (no
 * background-forced fresh start). Called by the message router on CONTENT_NAV_CLAIM.
 */
export function navStopOnClaim(tabId: number, store: Store): void {
  recentNavClaim.set(tabId, Date.now());
  const pending = pendingDeferredStop.get(tabId);
  if (pending !== undefined) {
    clearTimeout(pending);
    pendingDeferredStop.delete(tabId);
  }
  store.setContinuationIntent(null);
}

/** Test-only: reset module state between specs. */
export function resetNavStopState(): void {
  for (const timer of pendingDeferredStop.values()) clearTimeout(timer);
  pendingDeferredStop.clear();
  recentNavClaim.clear();
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
    // ── Phase-1 instrumentation ("đo đạc") ──────────────────────────────────────
    // Log EXACTLY what the background nav authority observes per nav so the
    // two-authority race (RC1/RC2) can be tuned for Option A. The key fact this
    // captures: whether the platform's SPA pushState spuriously emits
    // status:"loading" (Chromium bug) — which decides whether the hard-nav branch
    // below wrongly fires on a watch→watch SPA nav the content side is handling.
    console.info("[nav-stop] onUpdated", {
      status: changeInfo.status ?? "(none)",
      url: changeInfo.url,
      running: store.state.running,
      connecting: store.state.connecting,
      isWatch: isSupportedWatchUrl(changeInfo.url),
    });
    // Hard navigation (full page load / reload / cross-origin): `status:"loading"`
    // accompanies the url change. The content script is being replaced, so the
    // background is the authority → stop. YouTube's history.pushState SPA
    // navigations (watch→watch autoplay/next) do NOT set status:"loading".
    if (changeInfo.status === "loading") {
      // A fresh signal supersedes any pending deferred-stop check for this tab.
      const pending = pendingDeferredStop.get(tabId);
      if (pending !== undefined) {
        clearTimeout(pending);
        pendingDeferredStop.delete(tabId);
      }

      const watchActive =
        (store.state.running || store.state.connecting) &&
        isSupportedWatchUrl(changeInfo.url);

      if (watchActive) {
        // ── Two-authority handshake (RC1/RC2 fix) ────────────────────────────────
        // Chrome emits a SPURIOUS status:"loading" on history.pushState (Chromium
        // bug), so a watch→watch SPA nav where the content script SURVIVES looks
        // IDENTICAL to a genuine hard nav here. Stopping immediately is what killed
        // the in-place auto-next (continueOnNewVideo) the content side was about to
        // run on Udemy/Coursera. Instead: record the continuation-intent (used ONLY
        // if this really is a hard nav) and DEFER a claim-aware stop. The SURVIVING
        // content NavigationWatcher sends CONTENT_NAV_CLAIM (→ navStopOnClaim cancels
        // this) within ~URL_POLL_MS, in which case we do NOT stop and the dub
        // continues in-place. If NO claim arrives (the document truly reloaded — no
        // content script left to claim), the deferred stop fires and the
        // continuation-intent re-dubs the fresh page (the old hard-nav behavior,
        // just CLAIM_WINDOW_MS later). YouTube SPA navs never reach here (clean
        // pushState → no status:"loading" → the SPA-skip branch below), so this only
        // changes the spurious-loading case (Udemy/Coursera) + delays a GENUINE
        // hard-nav stop by ~CLAIM_WINDOW_MS.
        store.setContinuationIntent({ tabId, at: Date.now() });

        // Content may have already claimed (its poll beat our onUpdated).
        const claimedAt = recentNavClaim.get(tabId);
        if (claimedAt !== undefined && Date.now() - claimedAt < CLAIM_WINDOW_MS) {
          console.info("[nav-stop] loading-on-watch: content already CLAIMED -> defer to content (no stop)", {
            url: changeInfo.url,
          });
          store.setContinuationIntent(null);
          return;
        }

        console.info("[nav-stop] loading-on-watch: DEFER claim-aware stop", {
          url: changeInfo.url,
          windowMs: CLAIM_WINDOW_MS,
        });
        const timer = setTimeout(() => {
          pendingDeferredStop.delete(tabId);
          void (async () => {
            const claim = recentNavClaim.get(tabId);
            if (claim !== undefined && Date.now() - claim < CLAIM_WINDOW_MS + 300) {
              // A claim landed during the window — the surviving content owns the nav.
              console.info("[nav-stop] claim landed during window -> defer to content (no stop)", {
                url: changeInfo.url,
              });
              store.setContinuationIntent(null);
              return;
            }
            if (
              store.state.tabId !== tabId ||
              (!store.state.running && !store.state.connecting)
            ) {
              return; // session already ended / a different session owns the tab
            }
            // No claim → the document really reloaded (no content script survived) →
            // genuine hard nav. Stop + clear running synchronously so auto-start's
            // Gate-5 (!running) can pass on the page's status:"complete".
            console.info("[nav-stop] no claim in window -> genuine hard nav, session.stop()", {
              url: changeInfo.url,
            });
            void session.stop();
            store.setRunning(false);
            store.setConnecting(false);
            // The page's status:"complete" may have ALREADY fired during the defer
            // (fast reload), in which case auto-start was blocked by Gate-5 (running
            // was still true then) and will NOT re-fire. If the document has finished
            // loading and the continuation-intent is still fresh, trigger the
            // continuation directly. Idempotent with auto-start: whichever runs first
            // consumes the intent / sets running, so the other no-ops (Gate-5).
            try {
              const tab = await chrome.tabs.get(tabId);
              const intent = store.getContinuationIntent();
              if (
                tab.status === "complete" &&
                typeof tab.url === "string" &&
                isSupportedWatchUrl(tab.url) &&
                intent !== null &&
                intent.tabId === tabId &&
                !store.state.running &&
                !store.state.connecting
              ) {
                console.info("[nav-stop] page already complete -> trigger continuation directly", {
                  url: tab.url,
                });
                store.setContinuationIntent(null);
                void session.start({});
              }
            } catch {
              // tab closed/removed — nothing to continue.
            }
          })();
        }, CLAIM_WINDOW_MS);
        if (typeof timer.unref === "function") timer.unref();
        pendingDeferredStop.set(tabId, timer);
        return;
      }

      // Non-watch hard nav — genuinely leaving the dub context (watch→home/another
      // site). Stop immediately (unchanged behavior); no content claim is possible.
      store.setContinuationIntent(null);
      console.info("[nav-stop] HARD-NAV (non-watch) -> session.stop()", {
        url: changeInfo.url,
      });
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
      console.info("[nav-stop] SPA watch->watch: SKIP stop, defer to content NavigationWatcher", {
        url: changeInfo.url,
      });
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
