# SOLUTION — Auto-next continuation across a HARD navigation (playlist auto-advance)

Repo: extension (branch develop), background-only change. Builds on the shipped SPA-path fixes.

## Problem & root cause (evidence-backed)
YouTube **playlist** auto-advance (`watch?v=…&list=…&index=N`) is intermittently a **GENUINE HARD NAVIGATION**
(full document load), NOT an SPA pushState. Proof: the live trace shows `stopSession ← handleUnload ← onUnload`,
and `beforeunload`/`pagehide` (the only events wired to `onUnload`, index.ts:1161-1166) **cannot** fire on a
`history.pushState` SPA nav per spec — so the document is genuinely unloading. The content script (ContentApp) is
destroyed; a fresh one re-inits with no session. The shipped fixes (content NavigationWatcher keep-alive, nav-stop
SPA-skip, CONTENT_STOP→USER_STOP) **only cover the SPA (`status:"loading"`-absent) branch**. On a hard nav both
sides terminate (content unload + `nav-stop` `session.stop()` on `status:"loading"`), and nothing restarts the dub
because `auto-start` is blocked by **Gate-4** (`autoStartHosts[host] !== true`) — an active dub ≠ a fresh
per-host opt-in.

## Chosen approach — a background "continuation intent" (the bg is the only survivor of a hard nav)
Do **NOT** guard `handleUnload` (the document is genuinely gone — the old ContentApp must terminate cleanly).
Instead the durable background process records intent at the hard-nav moment and restarts on the fresh content
script. The two nav types remain mutually exclusive: SPA fires no `status:"loading"` (handled by content
NavigationWatcher, untouched); hard nav fires `status:"loading"` (set intent) then `status:"complete"` (consume).

### Contract / data model
```ts
// src/shared/types.ts — bg-internal ONLY; NOT added to the broadcast State/INITIAL_STATE
export interface ContinuationIntent { tabId: number; at: number; } // at = Date.now()
```
- Stored as a **private in-memory field on `Store`** (not `chrome.storage.session`): the SW is active across a
  single nav's `loading`→`complete` (it just processed `loading`; `complete` follows ~1s later), so the field
  survives. An SW recycle in that ~1s window is highly unlikely and degrades **gracefully** to normal Gate-4
  behavior (no continuation, never a wrong start). Async storage would force `await` into the synchronous
  onUpdated listeners for negligible benefit. *(Limitation noted in §Known limitations.)*
- Intent is **just `{tabId, at}`** — settings are NOT stashed: `session.start({})` already replays the store's
  last-used tier/lang/voice (`session-coordinator` builds startSettings from `store.snapshot()`).

### Store API (src/background/store.ts) — PEEK + CLEAR (not read-and-clear; critic Gap-2)
```ts
private continuationIntent: ContinuationIntent | null = null;
getContinuationIntent(): ContinuationIntent | null { return this.continuationIntent; } // PEEK, no clear
setContinuationIntent(i: ContinuationIntent | null): void { this.continuationIntent = i; } // set / clear(null)
```
A read-and-clear `take()` is WRONG here: auto-start's listener runs on multiple onUpdated events and several gates
early-return — a `take()` before those gates would consume the intent on an event that never starts a session,
losing it before the real start. So we PEEK for the Gate-4 decision and CLEAR (`setContinuationIntent(null)`) only
once we're committed to `session.start()` (after the debounce passes).

### SET — `src/background/nav-stop.ts` (the `status:"loading"` branch, before `session.stop()`)
```ts
if (changeInfo.status === "loading") {
  if (store.state.running && isSupportedWatchUrl(changeInfo.url)) {
    store.setContinuationIntent({ tabId, at: Date.now() }); // running dub hard-navigating to another watch page
  } else {
    store.setContinuationIntent(null); // leaving the dub context → no continuation
  }
  // Pre-clear running/connecting SYNCHRONOUSLY (critic Gap-3): `session.stop()` is async and clears running only
  // after its relay to the now-dead content script settles; a fast new-page load could fire `complete` before that,
  // making auto-start's Gate-5 (!running) spuriously block the continuation. The content script is already gone on a
  // hard nav, so clearing eagerly is safe. (Verify session.stop()'s wasActive-gated cleanup still runs — if it
  // depends on running being true, snapshot wasActive BEFORE clearing and pass it through, or await session.stop().)
  store.setRunning(false);
  store.setConnecting(false);
  void session.stop();
  return;
}
```
Structurally distinguishes nav-teardown from a user Stop: a user Stop (popup STOP / on-page Stop) produces **no**
`tabs.onUpdated status:"loading"` event, so the intent is never set on a user Stop.

### CONSUME — `src/background/auto-start.ts` (extend `registerAutoStart`, NOT a second listener → no double-start race)
```ts
const CONTINUATION_WINDOW_MS = 12000;
// ...inside the listener, AFTER Gate-3 (signed-in), BEFORE Gate-4 (autoStartHosts):
const intent = store.getContinuationIntent(); // PEEK — do NOT clear yet (critic Gap-2)
const isContinuation =
  intent !== null && intent.tabId === tabId && Date.now() - intent.at < CONTINUATION_WINDOW_MS;
// Gate-4 bypassed for a continuation; Gates 1(complete)/2(watch-url)/3(signed-in)/5(!running) still apply:
if (!isContinuation && store.state.advanced.autoStartHosts[host] !== true) return;
if (store.state.running || store.state.connecting) return;        // Gate-5
// ...existing per-tab DEBOUNCE_MS guard (lastFireAt) ...
store.setContinuationIntent(null); // CONSUME now — committed to start; once-per-nav, can't leak to a later event
void session.start({});
```
The intent is CLEARED only here (after every gate + the debounce pass), so it is consumed exactly once and only on
the event that truly starts a session — no earlier gate/early-return or extra `complete` event can lose or
double-spend it. Gate-5 (`!running && !connecting`) + `session.start()`'s own running/connecting guard are the
double-start backstops. The per-tab debounce collapses multiple `complete` events into one start.

### CLEAR on a genuine user Stop (so a Stop after a nav started can't trigger continuation)
- `src/background/router.ts` STOP case (popup): `store.setContinuationIntent(null);` before `session.stop()`.
- `src/background/router.ts` CONTENT_STOP_REQUEST (on-page Stop): `deps.store.setContinuationIntent(null);` before `session.stop()`.
- `src/background/index.ts` `chrome.tabs.onRemoved` (tab closed): `store.setContinuationIntent(null)` (tidy).

### Untouched
The SPA path (content NavigationWatcher + nav-stop SPA-skip). `handleUnload` stays a clean terminal teardown.

## Acceptance criteria (testable)
1. nav-stop SETS the intent when `status:"loading"` + `running` + supported watch URL; CLEARS it on an
   unsupported destination URL; does NOT set when `!running`.
2. auto-start BYPASSES Gate-4 when a fresh same-tab intent exists → `session.start({})` fires on a host NOT in
   `autoStartHosts`; an expired (`> CONTINUATION_WINDOW_MS`) or wrong-tab intent is ignored (normal Gate-4 rules).
3. The intent is consumed once: a second `complete` event for the same tab does NOT start a second session.
4. A user Stop (popup STOP / CONTENT_STOP_REQUEST) clears the intent → no continuation after a user Stop.
5. Gates 1/2/3/5 still hold for a continuation (loaded + supported + signed-in + nothing running).
6. tsc 0 + vitest green; new unit tests on the extracted listeners (nav-stop + auto-start invoke their listeners
   directly today).

## Rejected alternatives
- **Guard `handleUnload`** — wrong: the document is genuinely unloading; nothing to keep alive.
- **Trigger from `CONTENT_ENDED`** — unreliable (best-effort send from a dying page) and it has already lost the
  raw stop reason (UNLOAD≡USER_STOP≡DEFAULT all map to the "Stopped" message), so it can't distinguish nav from
  user-stop. nav-stop's `loading` branch is the durable, reason-bearing capture point.
- **`chrome.storage.session` for the intent** — async-in-listener complexity for a window the SW stays alive
  through anyway; in-memory degrades gracefully.

## Known limitations
- Continuation is best-effort across a simultaneous **SW recycle** in the ~1s loading→complete window (rare;
  degrades to normal Gate-4, never a wrong start).
- **Behavior change:** bypassing Gate-4 means a host NOT opted into auto-start WILL auto-dub the next playlist
  video after a hard-nav — this is the intended "active dub follows the playlist" semantics the user asked for.
- Not live-smoked.
