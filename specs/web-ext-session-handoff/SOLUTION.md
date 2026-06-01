# SOLUTION — Complete the web↔extension session handoff

Slug: `web-ext-session-handoff`  ·  Scope: extension/ ONLY (no web, no server, no perms)

## 1. Problem & why
The extension shares the web `ec_session` cookie (read via `chrome.cookies.get`,
no re-login needed). But the OPEN_SIGNIN → signin-tab → cookie-onChanged path has
gaps when the user is **already signed in on web**, plus orphan-tab issues:

- **Gap A (main):** already signed-in → click "Sign in" in popup → OPEN_SIGNIN
  opens `/signin` → web pre-check redirects to `/account` → **no cookie is added**
  → `cookies.onChanged"added"` never fires → tab never closes, extension state not
  refreshed via this path (orphan tab). (`auth-listener.ts` cookie-only signal.)
- **Gap B:** OPEN_SIGNIN never pre-checks an existing session before opening a tab.
- **Gap C:** clicking Sign in twice opens two tabs (no dedup); only the latest is
  tracked, the first orphans.
- **Gap D:** manually closing the signin tab leaves `signinTabId` stale.
- **Gap E:** `signinTabId` is module-scoped — an MV3 SW recycle between OPEN_SIGNIN
  and a (delayed) sign-in loses it, so even the normal flow's tab-close is unreliable.

## 2. Chosen approach (+ rejected)
Extension-only, zero new permissions, no web change. Three mechanisms combined:
- **(a) Pre-check in OPEN_SIGNIN** — already-signed-in / cookie-present → hydrate,
  broadcast, DON'T open a tab.
- **(b) `chrome.tabs.onUpdated` watcher** on the owned signin tab — when it lands on
  the authenticated landing URL (`${WEB}/account`), hydrate; close the tab ONLY if
  hydrate confirms a session (avoids false-close when `/account` bounces back to
  `/signin` for an unauthed visit). This is the universal "signed-in" signal that
  covers BOTH already-signed-in redirect AND login-code success.
- **(c) `cookies.onChanged`** — UNCHANGED, still the primary signal for fresh login.

Plus: `tabs.onRemoved` clears `signinTabId` (Gap D); OPEN_SIGNIN dedups/focuses an
existing signin tab (Gap C); `signinTabId` persisted to `chrome.storage.session`
and restored on listener install (Gap E).

_Rejected:_ content script on echolyhq.com (overkill, persistent script on marketing
site); a `?from=extension` web marker (unnecessary — `/account` landing suffices,
keeps web untouched); re-setting the cookie to force an event (hacky).
_Out of scope (intentional):_ cookie `cause==="overwrite"` (sliding re-issue) does
NOT hydrate — same user, redundant; left as-is.

## 3. Interfaces / contracts (foundation, locked first)
`src/shared/echoly-config.ts`:
```ts
/** The authenticated landing URL the web app redirects to once signed in. */
export const ECHOLY_WEB_PATHS = { ..., account: "/account" }   // add if missing
export const ECHOLY_WEB_URLS = { ..., account: () => webUrl(ECHOLY_WEB_PATHS.account) }
/** True if `url` is the Echoly web authenticated landing (…/account[...]). */
export function isEcholyAuthedLandingUrl(url: string | undefined): boolean
```
`src/background/auth-listener.ts` — signin-tab state API (module var + storage.session mirror):
```ts
function setSigninTabId(id: number | null): void        // writes module + storage.session (fire-and-forget)
function getSigninTabId(): number | null                 // sync module read (events use this)
async function restoreSigninTabId(): Promise<void>       // storage.session → module; called on install (SW wake)
// installAuthListener() additionally registers chrome.tabs.onUpdated + chrome.tabs.onRemoved
```
`src/background/router.ts` — OPEN_SIGNIN gains the pre-check + dedup (uses deps.auth/store/settings + getSigninTabId + a focusTab helper).

`STORAGE_KEY_SIGNIN_TAB = "ec_signin_tab_id"` in `chrome.storage.session`.

`isEcholyAuthedLandingUrl(url)` MUST match by exact pathname on the web origin —
`new URL(url).origin === ECHOLY_WEB_ORIGIN && new URL(url).pathname === "/account"`
(NOT startsWith — avoids `/accountsettings` and `evil.com/account` matches). Returns
false on parse error / empty.

**Permissions (critic-1):** add `"tabs"` EXPLICITLY to `wxt.config.ts` permissions.
It is ALREADY auto-injected today (WXT detects `chrome.tabs.query({})` in
session-coordinator.ts) and `chrome.tabs.onUpdated` is already used in index.ts, so
making it explicit adds NO new install warning — it just removes the fragile
implicit dependency. `chrome.windows.update`/`tabs.update`/`tabs.get` need no extra
permission. `changeInfo.url` is delivered because echolyhq.com is in host_permissions.

## 4. Behavior spec
**OPEN_SIGNIN handler** — wrapped in a module-level `openSigninInFlight` guard
(critic-2): if `openSigninInFlight` is already true, return `{ok:true}` immediately
(a concurrent open is in progress). Else set it true, run steps 1–3 in `try`, clear
it in `finally`. This serializes same-burst double-clicks (popup has no disabled
guard), fully closing Gap C.
1. If `store.state.signedInUser` set → `store.broadcast()`, return `{ok:true}` (no tab).
2. Else `token = await auth.getSessionToken()`; if token → `await hydrateSignedIn(store, settings)`; if now `store.state.signedInUser` → return `{ok:true}` (no tab).
3. Else open the tab: if `getSigninTabId()` non-null AND `await chrome.tabs.get(id)` succeeds → focus it (`tabs.update(id,{active:true})` + `windows.update(tab.windowId,{focused:true})`), return `{ok:true}`; else `tabs.create({url:signin(),active:true})` + `setSigninTabId(tab.id)`. (Uses only non-privileged tab fields; `tabs.get` existence-check tolerates the stripped url.)

**`tabs.onUpdated(tabId, changeInfo, tab)` listener:** `if (!changeInfo.url) return`
(critic-4: gate on the URL-change event only, no stale `tab.url` fallback). If
`tabId===getSigninTabId()` and `isEcholyAuthedLandingUrl(changeInfo.url)` →
`await hydrateSignedIn(store, settings)`; if `store.state.signedInUser` →
`chrome.tabs.remove(tabId).catch(()=>{})` + `setSigninTabId(null)`. (No-op close if
hydrate found no session — prevents false-close on an unauthed `/account` bounce.)

**`tabs.onRemoved(tabId)` listener:** if `tabId===getSigninTabId()` → `setSigninTabId(null)`.

**`cookies.onChanged` (existing):** unchanged; still closes tab on added + propagates
removed. On a login-code success BOTH (b) onUpdated→/account and (c) cookie-added
fire; they are NOT strictly deduped — whichever runs first closes the tab + nulls
signinTabId, the other's `tabs.remove` throws "no such tab" and is swallowed by
`.catch(()=>{})`; `hydrateInFlight` makes the two hydrate calls non-concurrent +
broadcast-idempotent. No infinite loop (broadcast triggers no tab/cookie event). (critic-7)

**Install:** `installAuthListener` stays idempotent; registers cookies.onChanged (existing) + tabs.onUpdated + tabs.onRemoved synchronously at top level (MV3), and kicks `void restoreSigninTabId()`.

## 5. Acceptance criteria (testable)
- AC1 OPEN_SIGNIN w/ `store.signedInUser` set → `tabs.create` NOT called; broadcast; `{ok:true}`.
- AC2 OPEN_SIGNIN w/ store empty but cookie present → `getSessionToken`→`hydrateSignedIn`→ if signed-in, no tab; broadcast.
- AC3 OPEN_SIGNIN not signed in → opens tab; second OPEN_SIGNIN with the tab still open → focuses it (`tabs.create` called once total).
- AC4 signin tab `onUpdated`→`/account` AND hydrate confirms session → `tabs.remove` + signinTabId cleared; if hydrate finds NO session → tab NOT removed.
- AC5 `tabs.onRemoved(signinTabId)` → signinTabId becomes null.
- AC6 `setSigninTabId` writes storage.session; `restoreSigninTabId` repopulates the
  module var (SW-recycle survival). RESIDUAL race acknowledged (critic-3): if the SW
  wakes BECAUSE an onUpdated/cookie event fires, the event may run before the
  `storage.session.get` resolves → that one close is missed. Benign: storage.session
  is in-memory (<5ms) vs page-load/cookie-set latency (100s ms); the very next
  GET_STATE/popup-open hydrates regardless. Gap E is NARROWED, not eliminated.
- AC7 no regression: cookie-added (login-code) still closes tab + hydrates; cookie-removed still clears `signedInUser` + broadcasts.
- AC8 `"tabs"` added EXPLICITLY to wxt.config (already auto-injected → no new install
  warning); no OTHER new permissions; no web/ or server/ files changed. AC3 dedup uses
  only non-privileged tab ops.
- AC9 extension `tsc`/wxt typecheck clean; new vitest specs A–E pass; existing auth-listener/router/hydrate/store/auth tests green.
```
