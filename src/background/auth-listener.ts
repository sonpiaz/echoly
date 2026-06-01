// ────────────────────────────────────────────────────────────────────────────
// Auth listener — closes the post-sign-in UX gap. The extension is
// the sole tab-lifecycle owner: popup sends OPEN_SIGNIN → bg opens the signin
// tab and stores its id here; when the server sets the `ec_session` cookie
// (sign-in completes on the web side) chrome.cookies.onChanged fires, we
// debounce + refreshAuth + broadcast + close the signin tab. On `removed:true`
// we take the fast path (clear local state; NO /auth/me roundtrip).
//
// Invariants:
//  • Domain match is EXACT (`echolyhq.com` or `.echolyhq.com`) — endsWith would
//    let `evil-echolyhq.com` through.
//  • Listener is registered SYNCHRONOUSLY from initBackground (M-a invariant).
//  • Debounce handle is module-scoped; a second `added` event within 250ms
//    clears the prior timer and reschedules (standard debounce).
//  • `cause === "overwrite"` is skipped explicitly — the pair removed→added
//    debounces correctly without it, but skipping avoids redundant work.
// ────────────────────────────────────────────────────────────────────────────

import { EC_SESSION_COOKIE } from "@/shared/constants";
import {
  echolySessionCookieDomains,
  isEcholyAuthedLandingUrl,
} from "@/shared/echoly-config";
import type { Store } from "./store";
import type { EcholyAuth } from "./auth";
import type { SettingsClient } from "./settings-client";
import { scheduleHydrateSignedIn, hydrateSignedIn } from "./hydrate-signed-in";

const SESSION_COOKIE_DOMAINS = echolySessionCookieDomains();
const DEBOUNCE_MS = 250;
/** chrome.storage.session key mirroring `signinTabId` across SW recycles. */
const STORAGE_KEY_SIGNIN_TAB = "ec_signin_tab_id";

let pending: ReturnType<typeof setTimeout> | null = null;
let signinTabId: number | null = null;

/** Setter used by the OPEN_SIGNIN handler in router.ts to record the freshly
 *  created tab's id. Mirrors to chrome.storage.session (fire-and-forget, callers
 *  don't await) so an MV3 service-worker recycle between OPEN_SIGNIN and the
 *  sign-in signal doesn't lose the tab id. The listeners consume it and reset to
 *  null so a second sign-in cycle starts cleanly. */
export function setSigninTabId(id: number | null): void {
  signinTabId = id;
  try {
    if (id == null) void chrome.storage.session.remove(STORAGE_KEY_SIGNIN_TAB);
    else void chrome.storage.session.set({ [STORAGE_KEY_SIGNIN_TAB]: id });
  } catch {
    // storage.session unavailable (older Chrome / test stub) — module var suffices.
  }
}

/** Read the in-memory tabId (also used by the router's dedup-focus path). */
export function getSigninTabId(): number | null {
  return signinTabId;
}

/** Repopulate the module var from storage.session after a service-worker wake.
 *  Best-effort: an event firing before this resolves simply misses that one
 *  tab-close (the next GET_STATE hydrates regardless). */
export async function restoreSigninTabId(): Promise<void> {
  try {
    const got = await chrome.storage.session.get(STORAGE_KEY_SIGNIN_TAB);
    const id = got?.[STORAGE_KEY_SIGNIN_TAB];
    if (typeof id === "number") signinTabId = id;
  } catch {
    // ignore — module var stays as-is
  }
}

/** Close the tracked signin tab and clear the id (best-effort; the tab may
 *  already be gone, which is fine). */
function closeSigninTab(): void {
  if (signinTabId == null) return;
  const id = signinTabId;
  setSigninTabId(null);
  chrome.tabs.remove(id).catch(() => {
    // Tab may already be closed by the user or the other handoff path — ignore.
  });
}

/** Test-only: reset module state between specs. */
export function resetAuthListenerState(): void {
  if (pending) clearTimeout(pending);
  pending = null;
  signinTabId = null;
}

/** Register the chrome.cookies.onChanged listener. Idempotent at the listener
 *  level (chrome dedupes the same function reference), but initBackground only
 *  calls it once anyway. `settings` is optional so existing tests (which don't
 *  exercise the sign-in sync path) keep working without a SettingsClient. */
export function installAuthListener(
  store: Store,
  auth: EcholyAuth,
  settings?: SettingsClient,
): void {
  void auth; // reserved for future auth-aware paths; kept to match contract

  // Restore any signin tab id persisted before a service-worker recycle.
  void restoreSigninTabId();

  chrome.cookies.onChanged.addListener(({ cookie, removed, cause }) => {
    if (cookie.name !== EC_SESSION_COOKIE) return;
    // EXACT domain match — endsWith would allow `evil-echolyhq.com`.
    // Dev builds additionally accept "localhost" so the local web's sign-in
    // event reaches the listener (prod build strips this branch via DCE).
    if (!SESSION_COOKIE_DOMAINS.includes(cookie.domain)) {
      return;
    }
    // Pair coalescing: the browser emits `overwrite` removed→added for an
    // update. Skip the noise — the debounced `added` covers the actual change.
    if (cause === "overwrite") return;

    if (removed) {
      // Sign-out / explicit removal — server cookie removal is authoritative.
      // Clear locally; do NOT roundtrip /auth/me.
      void store.refreshAuth().finally(() => store.broadcast());
      return;
    }

    // Sign-in detected — debounce 250ms, then coalesced hydrate (300ms) + broadcast.
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      scheduleHydrateSignedIn(store, settings);
      closeSigninTab();
    }, DEBOUNCE_MS);
  });

  // Already-signed-in handoff: when the user is already signed in on the web,
  // OPEN_SIGNIN's tab redirects straight to /account and NO cookie event fires.
  // Watch the tracked signin tab for that authenticated landing, hydrate, and
  // close it — but ONLY if hydrate confirms a session, so an unauthed /account
  // bounce (→ /signin) never false-closes the tab. (Also covers login-code
  // success redundantly with the cookie path; the double close is idempotent.)
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (!changeInfo.url) return; // URL-change events only — no stale tab.url
    if (tabId !== signinTabId) return;
    if (!isEcholyAuthedLandingUrl(changeInfo.url)) return;
    void (async () => {
      await hydrateSignedIn(store, settings);
      if (store.state.signedInUser) closeSigninTab();
    })();
  });

  // Orphan cleanup: the user closed the signin tab before finishing — drop the
  // stale id so it can't later target a recycled tab number.
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabId === signinTabId) setSigninTabId(null);
  });
}
