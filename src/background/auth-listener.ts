// ────────────────────────────────────────────────────────────────────────────
// Auth listener — closes the post-magic-link sign-in UX gap. The extension is
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
import type { Store } from "./store";
import type { EcholyAuth } from "./auth";
import type { SettingsClient } from "./settings-client";

const COOKIE_DOMAIN_APEX = "echolyhq.com";
const COOKIE_DOMAIN_DOT = ".echolyhq.com";
// Dev-only: the local web (`localhost:4321`) sets cookies scoped to "localhost".
// import.meta.env.DEV is statically replaced at build time — the prod bundle
// has `false` here and the localhost branch is dead-code-eliminated.
const COOKIE_DOMAIN_DEV = "localhost";
const DEBOUNCE_MS = 250;

let pending: ReturnType<typeof setTimeout> | null = null;
let signinTabId: number | null = null;

/** Setter used by the OPEN_SIGNIN handler in router.ts to record the freshly
 *  created tab's id. The listener consumes it on the next `added` event and
 *  resets it to null so a second sign-in cycle starts cleanly. */
export function setSigninTabId(id: number | null): void {
  signinTabId = id;
}

/** Test-only: peek at the in-memory tabId. Not exported via barrel. */
export function getSigninTabId(): number | null {
  return signinTabId;
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
  chrome.cookies.onChanged.addListener(({ cookie, removed, cause }) => {
    if (cookie.name !== EC_SESSION_COOKIE) return;
    // EXACT domain match — endsWith would allow `evil-echolyhq.com`.
    // Dev builds additionally accept "localhost" so the local web's sign-in
    // event reaches the listener (prod build strips this branch via DCE).
    if (
      cookie.domain !== COOKIE_DOMAIN_APEX &&
      cookie.domain !== COOKIE_DOMAIN_DOT &&
      !(import.meta.env.DEV && cookie.domain === COOKIE_DOMAIN_DEV)
    ) {
      return;
    }
    // Pair coalescing: the browser emits `overwrite` removed→added for an
    // update. Skip the noise — the debounced `added` covers the actual change.
    if (cause === "overwrite") return;

    if (removed) {
      // Sign-out / explicit removal — server cookie removal is authoritative.
      // Clear locally; do NOT roundtrip /auth/me.
      store.clearAuth();
      store.broadcast();
      return;
    }

    // Sign-in detected — debounce 250ms, then refresh + sync settings +
    // broadcast + close tab. Settings sync runs alongside refreshAuth so the
    // popup renders user-customized Advanced values right after sign-in
    // (otherwise it shows defaults until the next GET_STATE).
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      void (async () => {
        try {
          await store.refreshAuth();
          if (settings) {
            const bundle = await settings.fetchBundle().catch(() => null);
            if (bundle) {
              store.applyServerBundle(bundle);
              await store.persistAdvanced();
            }
          }
        } finally {
          store.broadcast();
        }
      })();
      if (signinTabId != null) {
        const id = signinTabId;
        signinTabId = null;
        chrome.tabs.remove(id).catch(() => {
          // Tab may already be closed by the user — ignore.
        });
      }
    }, DEBOUNCE_MS);
  });
}
