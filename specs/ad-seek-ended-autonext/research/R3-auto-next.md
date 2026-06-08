# R3 — Auto-Next / Auto-Start Analysis

## Executive Summary

On a YouTube SPA auto-advance, the **content-side `continueOnNewVideo`** is the INTENDED
winner — `nav-stop.ts` correctly SKIPs the stop for a running session navigating to another
watch page. However, the bug is that a **background `CONTENT_STOP`** arrives (via the
`nav-stop` non-watch-URL-flicker path or the `session-coordinator.stop()` relay, as traced by R1)
**between** the video-end event and the URL-change detection, which tears the content session
down and kills the content-side NavigationWatcher. Once the watcher is dead, the URL-poll
that would have fired `{kind:"continue"}` never fires, so `continueOnNewVideo` never runs.
The background's `auto-start.ts` then fires a **fresh session** on the next
`tabs.onUpdated status:"complete"` event — explaining the observed `[nav] watcher STARTED` /
`[ad] watcher STARTED` log sequence.

There is NO double-start for the auto-start path (Gate 5 prevents it). There IS a silent
no-continue window when the background stop arrives before the URL flips, leaving the user
with a blank (stopped) overlay until auto-start fires ~1-2s later.

---

## 1. Mechanism Decision Boundary

### SPA auto-advance (intended path)

On a YouTube SPA navigation (history.pushState, no page reload), `changeInfo.status` is
**never** set to `"loading"` on the `tabs.onUpdated` event that carries the URL change.

`nav-stop.ts` (lines 80–85) gates the SPA-nav stop:
```typescript
if (
  (store.state.running || store.state.connecting) &&
  isSupportedWatchUrl(changeInfo.url)   // new URL is still a watch page
) {
  return;  // ← SKIP the stop; NavigationWatcher owns this transition
}
```

So on a clean `watch?v=A → watch?v=B` SPA nav with `running=true`:
- **nav-stop correctly skips** the background stop.
- The content-side `NavigationWatcher` fires `{kind:"continue", videoId}` after the 700ms
  poll debounce (or 100ms after `yt-navigate-finish`).
- `continueOnNewVideo` takes over — no teardown, no new CONTENT_START.

`auto-start.ts` is irrelevant in this path: Gate 5 (`store.state.running || connecting`)
blocks it while the session is live.

### The race that breaks it (actual bug path)

The trouble is the **timing gap** between `video.ended` and the URL flip:

1. Video (or ad video element) fires `ended` → `notifyEnded()` arms the 45s window.
2. Before the URL changes (0–500ms gap), a **background stop arrives** (CONTENT_STOP from
   one of the paths R1 traced — most likely nav-stop's non-watch URL flicker, or a race
   with nav-stop's SPA branch when `running` was already cleared by an earlier stop).
3. Content `stopSession(USER_STOP)` runs unconditionally (index.ts:1192–1199):
   - `this.nav?.stop()` (index.ts:875) clears `#awaitingNext`, kills the 45s timer, and
     **destroys the NavigationWatcher**.
   - `sm.session = null` (index.ts:995).
   - Overlay removed; `emitEnded` → background receives `CONTENT_ENDED`.
4. The URL NOW changes (YouTube auto-advances). `NavigationWatcher` is dead — its poll
   interval was cleared. **`continueOnNewVideo` never fires.**
5. `tabs.onUpdated` fires with `status:"complete"` for the new video's page load.
   `auto-start.ts` Gate 5 now passes (`running=false`), and if auto-start is enabled or
   a continuation intent was set (see §4 below), `session.start({})` fires → fresh session.
6. `startSession` creates a new `NavigationWatcher` + `AdWatcher` → `[nav] watcher STARTED`
   / `[ad] watcher STARTED` in logs.

This perfectly matches the observed log sequence.

---

## 2. What Happens When Background Sends CONTENT_STOP Mid-Continuation

### Does `continueOnNewVideo` get aborted?

**Only if it already started.** `continueOnNewVideo` (auto-next.ts:54) increments
`activeGen` at entry. If `CONTENT_STOP` arrives BEFORE `continueOnNewVideo` is called
(i.e., before the NavigationWatcher's URL poll fires `{kind:"continue"}`), the function is
never called at all — no abort needed; it simply doesn't start.

If `continueOnNewVideo` IS running when `CONTENT_STOP` arrives:
- `stopSession` is called from `index.ts:1198`.
- `stopSession` bumps `sm.pageToken` (index.ts:877).
- Inside `continueOnNewVideo`, the `myGen !== activeGen` guard (auto-next.ts:98, 122, 145,
  187, 220) catches the generation mismatch at the next async boundary and returns early.
- `stopSession` also calls `nav.stop()` which sets `#onEvent = null`, so even if the
  NavigationWatcher were still ticking, its emit would go nowhere.
- So `continueOnNewVideo` IS safely aborted via the generation counter — **no orphaned
  sub-tasks**.

However, if `continueOnNewVideo` itself called `app.stopSession` (e.g. for failure), that
is guarded by `myGen === activeGen` (auto-next.ts:240) — safe.

### Does auto-start fire a duplicate fresh start?

**No double-start.** There is one `session.start({})` call from auto-start.ts:99 and it
passes through `SessionCoordinator.start()` (session-coordinator.ts:156–158):
```typescript
if (state.running || state.connecting) {
  return { ok: false, error: "Session already running." };
}
```

Separately, content-side `startSession` (index.ts:431) guards:
```typescript
if (sm.session) return { ok: false, error: "Session already running." };
```

These two guards are independent but complementary: the background guard blocks a second
`session.start()` from auto-start; the content guard blocks a second `CONTENT_START` relay.
No double-start.

### Dropped-start window

There IS a **~1.5s window** after the CONTENT_STOP tears down the session and before
`auto-start.ts` fires (the 1.5s per-tab debounce at auto-start.ts:91). During this window:
- `running = false`, overlay removed.
- `auto-start.ts` hasn't yet fired its start.
- The user sees a blank/stopped page.

If `status:"complete"` fires within the debounce window and the debounce drops it, the start
is lost entirely — auto-start silently no-ops until the next qualifying `complete` event on
this tab. This is the "dropped-start window" (auto-start.ts:91–92).

---

## 3. Does `continueOnNewVideo` Re-arm AdWatcher and Rebind Video Listeners Correctly?

**AdWatcher:** Yes, correctly re-armed. auto-next.ts:229:
```typescript
app.startAdWatcher();
```
This is called at Step 5 (success block) of `continueOnNewVideo`, AFTER the pipeline
restart completes. `startAdWatcher()` (index.ts:318–327) does `this.ad?.stop()` first
(idempotent) then creates and starts a new `AdWatcher`. YouTube re-creates `#movie_player`
across SPA navs, so the new observer re-attaches correctly.

**Video listeners:** NOT re-bound directly by `continueOnNewVideo`. The comment at
auto-next.ts:132–137 explains this intentionally:
> "for the subtitle-first path, the proper `onSeeked`/`onEndedBefore` listeners are bound
> inside `restart()` itself — binding an empty set here would clobber them. For the WebRTC
> path, `webrtc.continueOnNewVideo` binds its own listeners internally."

So `bindCommonVideoListeners` is called inside:
- `subtitleFirst.restart()` for the subtitle-first path.
- `webrtc.continueOnNewVideo()` for the WebRTC path.

This means the video element is correctly updated (`app.capture.videoEl = video` at
auto-next.ts:139, `app.lifecycle.setVideo(video)` at auto-next.ts:142,
`app.capture.bindVolumeDriftGuard(video)` at auto-next.ts:143), and listeners are rebound
by the respective pipeline. The design is correct IF `continueOnNewVideo` actually runs.

---

## 4. Continuation-Intent Lifecycle

### When set
`nav-stop.ts:55` — `store.setContinuationIntent({ tabId, at: Date.now() })` — ONLY when:
- `changeInfo.status === "loading"` (hard nav, not SPA)
- AND `store.state.running || store.state.connecting`
- AND `isSupportedWatchUrl(changeInfo.url)`

**Critical:** the intent is set ONLY on hard-nav (`status:"loading"`). SPA auto-advance
does NOT set a continuation intent. SPA auto-advance is supposed to be handled entirely
by `continueOnNewVideo`, never by auto-start.

### When cleared
- `auto-start.ts:98` — ONLY once all gates pass and we are committed to `session.start({})`.
- `store.setContinuationIntent(null)` — also called by nav-stop when the destination URL is
  NOT a supported watch page (nav-stop.ts:57 path: `else { store.setContinuationIntent(null) }`).
- Implicitly by the `CONTINUATION_WINDOW_MS = 12_000ms` check in auto-start.ts:80 — stale
  intents expire silently.

### Stale-intent scenario (silent no-continue)

If the hard-nav continuation intent is set but the `status:"complete"` event never fires
within 12s (e.g. slow playlist load), `isContinuation` becomes false (auto-start.ts:80–81)
and Gate 4 blocks the start (auto-start.ts:82–84):
```typescript
if (!isContinuation && store.state.advanced.autoStartHosts[host] !== true) return;
```
If the host is not in `autoStartHosts`, a slow-loading hard-nav continuation silently fails.

### Fire-twice scenario

The intent is PEEKed at auto-start.ts:76 (`store.getContinuationIntent()`) but NOT cleared
until auto-start.ts:98. Multiple `tabs.onUpdated` events on the same tab can arrive before
the first one clears the intent. However, the per-tab debounce (auto-start.ts:91) and the
`running` Gate 5 guard prevent double-fire: once the first `session.start()` succeeds,
`store.state.running = true` blocks the second. Safe.

---

## 5. Re-entrancy: Can Guards Reject Legitimate Continuations?

### `startSession` guard (index.ts:431)
```typescript
if (sm.session) return { ok: false, error: "Session already running." };
```
This guards against a CONTENT_START arriving while a session is already live. In the
`continueOnNewVideo` path, NO new CONTENT_START is sent — `continueOnNewVideo` calls
pipeline methods directly and never re-enters `startSession`. So this guard is NOT hit.

**But there is a subtle problem:** if `stopSession` runs (from CONTENT_STOP) and then
auto-start fires `session.start({})`, the `SessionCoordinator.start()` method sends a fresh
`CONTENT_START` to the content script (session-coordinator.ts:251). At this point
`sm.session = null` (from stopSession), so the guard passes. Correct.

### `continueOnNewVideo` generation guard
The `activeGen` counter (auto-next.ts:29) is module-level, persisting across sessions.
On the NEXT session, if `continueOnNewVideo` is somehow invoked twice rapidly (two URL
changes in quick succession), the older call's `myGen !== activeGen` catches it. Safe.

However: if `continueOnNewVideo` bumps `activeGen` and then `stopSession` is called (which
does NOT reset `activeGen`), the counter stays at the bumped value. If a NEW session starts
and a NEW auto-next happens, `myGen = ++activeGen` correctly advances. No stale rejection.

### `SessionCoordinator.start()` guard (session-coordinator.ts:156–158)
```typescript
if (state.running || state.connecting) return { ok: false, error: "Session already running." };
```
This is the background guard. If `continueOnNewVideo` is running and auto-start
simultaneously fires, auto-start sees `running=true` (the session is live for the
coordinator) and no-ops. However, in the bug scenario, `stopSession` was already called
from CONTENT_STOP → `CONTENT_ENDED` → `store.setRunning(false)`, so auto-start's Gate 5
sees `running=false` and proceeds. This is the correct path for the fresh-start case.

### The "token-bump race" risk
`continueOnNewVideo` does NOT use `sm.pageToken` for its generation guard (by design —
see auto-next.ts:21–27 comment). The pipeline's `restart()`/`continueOnNewVideo()` methods
internally bump the token. As long as `continueOnNewVideo` owns the session, the token bump
is local and does not conflict with a concurrent fresh start (which won't happen because
the background Guard-5 blocks it). Safe.

---

## Root Causes (Ranked)

### Root Cause 1 — CONTENT_STOP arrives before URL flip, killing the NavigationWatcher (CRITICAL)

**File:line:** `src/background/nav-stop.ts:86`, `src/background/session-coordinator.ts:306`,
`src/content/index.ts:875` (nav.stop() inside stopSession), `src/content/index.ts:1198`
(CONTENT_STOP handler unconditionally calls stopSession).

The background fires `session.stop()` → `relayToContent(CONTENT_STOP)` when the YouTube
tab briefly shows a non-watch URL (ad transition flicker, or another nav-stop trigger).
Content receives CONTENT_STOP → `stopSession` → `nav.stop()` → watcher dead.
The NavigationWatcher that would have detected the video-ID change and emitted `{continue}`
is gone. Auto-start fires instead.

This is the PRIMARY bug. It is a stop-authority conflict where the background's stop
authority has no awareness of the content-side "awaiting next" state.

### Root Cause 2 — Spurious `ended` event fires during ad→content transition (CONTRIBUTING)

**File:line:** `src/content/index.ts:298–305` (onEnded → notifyEnded).

The `ended` event fires on the video element during the ad→content transition (ad video
clips's natural end, or YouTube seek artefact). `notifyEnded()` correctly arms the 45s
window, but that window is content-side only and is destroyed by Root Cause 1's CONTENT_STOP.
This contributes because it sets `#awaitingNext` in the wrong state, potentially allowing
`nav-stop` to see `running=true` with a URL that is briefly non-watch, triggering the stop.

### Root Cause 3 — Auto-start fires fresh session instead of soft-continue (CONSEQUENCE)

**File:line:** `src/background/auto-start.ts:99` (`session.start({})`).

Once Root Cause 1 has destroyed the watcher and the session, auto-start correctly fires a
fresh session. This is not a bug in auto-start itself — it is behaving correctly given the
torn-down state. The console log `[nav] watcher STARTED` / `[ad] watcher STARTED` is the
symptom of this fresh start.

---

## Double-Start / Dropped-Start Windows

| Window | Location | Risk |
|---|---|---|
| CONTENT_STOP tears down → auto-start debounce (1.5s) | auto-start.ts:25, 91 | User sees blank overlay for ~1.5s |
| CONTENT_STOP tears down → `status:"complete"` never fires within 12s | auto-start.ts:80 | Silent no-continue if host not in autoStartHosts |
| Two rapid `tabs.onUpdated` before running=true | auto-start.ts:86, session-coordinator:158 | Gate-5 prevents double-start; safe |
| continueOnNewVideo superseded by CONTENT_STOP | auto-next.ts:98,122,145,187,220 | Generation guard bails cleanly; no orphan |
| nav-stop SPA-skip branch races with running=false from earlier stop | nav-stop.ts:80–85 | If running was already cleared, the SPA-nav skip does NOT fire; falls through to session.stop() → second CONTENT_STOP |

The last row is a secondary race: if the background cleared `running=false` eagerly (nav-stop
does this at nav-stop.ts:69–70 for hard-nav: `store.setRunning(false)` synchronously before
`session.stop()` settles), then a subsequent SPA URL change sees `running=false` → the skip
condition fails → `session.stop()` fires again → second CONTENT_STOP to content. Content's
`stopSession` is idempotent (`sm.session` is already null) but the second `CONTENT_STOP` is
still sent to the tab and content still calls `stopSession` with USER_STOP a second time
(running through the full teardown with no session). Harmless but noisy.

---

## Fix Options

### Fix A — Guard `nav-stop` non-watch-URL SPA branch with a short debounce (RECOMMENDED, LOW RISK)

**Target:** `src/background/nav-stop.ts:80–86`

Add a 600ms debounce before `session.stop()` on the SPA non-watch-URL branch. Before
firing, re-check the current tab URL via `chrome.tabs.get()`. If the URL recovered to a
watch page, skip the stop.

```typescript
// nav-stop.ts — SPA non-watch branch (after line 85)
// Guard against ad-transition URL flickers (tab briefly shows non-watch URL).
// A 600ms re-check absorbs the flicker without delaying legitimate leave-watch stops.
if (debounceTimer) clearTimeout(debounceTimer);
debounceTimer = setTimeout(() => {
  debounceTimer = null;
  void chrome.tabs.get(tabId).then((tab) => {
    if (tab?.url && isSupportedWatchUrl(tab.url)) return; // recovered
    void session.stop();
  }).catch(() => void session.stop()); // tab gone → stop
}, 600);
return;
```

**Files touched:** `src/background/nav-stop.ts` only.

**Tradeoffs:**
- Adds 600ms delay to legitimate "user navigated away from YouTube" stops. Acceptable — the
  overlay hangs for 0.6s on a leave-watch nav.
- Does NOT fix Root Cause 2 (spurious `ended`).
- Requires careful scoping: the debounce timer must be per-tab (or reset on the `loading`
  branch) to avoid stale carryover.
- **Does NOT help if the stop comes from another path** (popup Stop button, overlay Stop
  button, tabs.onRemoved). Those are correct user-intentional stops.

### Fix B — Content sends `awaitingNext` state to background; background blocks non-user stops during pending-next (THOROUGH, HIGHER RISK)

**Target:** Multiple files.

When `notifyEnded()` arms the 45s window, content sends a new `CONTENT_AWAITING_NEXT`
message to background. Background stores a flag in the Store. `nav-stop.ts` and
`session-coordinator.stop()` check the flag and skip (or delay) the stop when the session
is in a "pending next" state. Content clears the flag when `#awaitingNext` is resolved
(continue or terminal-idle timeout).

**Files touched:**
- `src/shared/protocol.ts` — new message type `CONTENT_AWAITING_NEXT`
- `src/background/store.ts` — `awaitingNext: boolean` field + setter
- `src/content/navigation.ts` — emit `CONTENT_AWAITING_NEXT(true)` in `notifyEnded()`,
  `CONTENT_AWAITING_NEXT(false)` in `#clearTerminalIdle()` and resolution path
- `src/background/nav-stop.ts` — gate SPA stop on `!store.state.awaitingNext`
- `src/background/session-coordinator.ts` — gate non-user-initiated `stop()` on flag

**Tradeoffs:**
- Most complete fix — blocks ALL non-user stops during the pending-next window.
- Race risk: if `CONTENT_AWAITING_NEXT(true)` arrives after the stop was already sent,
  the flag helps nothing. Needs careful ordering.
- Must NOT block user-intentional stops (popup Stop, overlay Stop button). Differentiate
  by stop source (add `force?: boolean` to `stop()`).
- If the flag gets stuck (e.g. content crashes before clearing), background can never stop
  the (now-dead) session. Mitigate with a background-side timeout mirroring
  `TERMINAL_IDLE_TIMEOUT_MS` (45s).

### Fix C — Guard `onEnded` against ad-transition events in `bindCommonVideoListeners` (PARTIAL, SMALLEST)

**Target:** `src/content/index.ts:298–305`

In the `onEnded` handler inside `bindCommonVideoListeners`, add a guard: if the AdWatcher
was just active (within 500ms), skip `notifyEnded()`. This prevents spurious `ended` events
from the ad video element from arming the terminal-idle window at all.

```typescript
onEnded: () => {
  if (this.ad?.recentAdEnd()) return; // suppress ended during ad transition
  console.info("[nav] source video 'ended' event fired → notifyEnded");
  extra.onEndedBefore?.();
  this.nav?.notifyEnded();
},
```
Add `recentAdEnd(): boolean` on `AdWatcher` that returns true for 500ms after `onAdEnd`.

**Files touched:** `src/content/index.ts`, `src/content/ad-watcher.ts`.

**Tradeoffs:**
- Simplest change. Addresses Root Cause 2 only.
- Does NOT prevent Root Cause 1 (CONTENT_STOP from nav-stop URL flicker).
- Risk: if the REAL content video also ends during the 500ms window, its `ended` event is
  suppressed. This is an edge case (video ends exactly as an ad ends).
- Best used as a layer-1 defence in combination with Fix A.

---

## Cross-Slice Conflicts

### With R1 (stop-authority)

Fix A (debounce in nav-stop) is the direct solution to R1's identified root cause
(nav-stop URL flicker). These two fixes target the same code path and should be
implemented together, not independently.

R1's Fix B (background `awaitingNext` flag) maps exactly to this file's Fix B.
The signal protocol change touches `shared/protocol.ts` — coordinate with R4 on any
protocol additions.

### With R4 (start-config)

Auto-start's Gate 4 (host opt-in bypass for continuation) is correct. Fix A or B does not
change auto-start logic. However, if Fix B adds a `force` parameter to `stop()` in
`session-coordinator.ts`, that interface change must be cross-checked against all callers.

The `CONTINUATION_WINDOW_MS = 12_000ms` in auto-start.ts:29 is critical for playlist
hard-nav continuation. Any change to when the intent is set/cleared (e.g. Fix B's
background flag) must preserve this window's semantics.

### With R2 (ad-detection)

Fix C directly depends on `AdWatcher` exposing a `recentAdEnd()` method. R2's research on
ad-detection should confirm whether `AdWatcher` has a suitable hook or whether adding one
is clean.

The `#exitAdPause()` path at index.ts:379–419 calls `lifecycle.resume("ad")` → this may
call `video.play()` which can trigger the spurious `ended` sequence. Fix C's `recentAdEnd()`
flag should be set BEFORE `lifecycle.resume("ad")` in `#exitAdPause()`, not after.

---

## File References

| File | Lines | Role |
|---|---|---|
| `src/content/auto-next.ts` | 29 | `activeGen` module counter |
| `src/content/auto-next.ts` | 44–244 | `continueOnNewVideo` full flow |
| `src/content/auto-next.ts` | 54 | `myGen = ++activeGen` — entry |
| `src/content/auto-next.ts` | 98,122,145,187,220 | Generation guard bailout points |
| `src/content/auto-next.ts` | 229 | `app.startAdWatcher()` — re-arm on success |
| `src/content/index.ts` | 431 | `startSession` re-entry guard (`sm.session`) |
| `src/content/index.ts` | 448–452 | New `NavigationWatcher` created each `startSession` |
| `src/content/index.ts` | 875 | `this.nav?.stop()` inside `stopSession` — kills watcher |
| `src/content/index.ts` | 877 | `sm.pageToken += 1` — token bump on teardown |
| `src/content/index.ts` | 1192–1199 | `CONTENT_STOP` handler → unconditional `stopSession` |
| `src/content/navigation.ts` | 89–115 | `start()` — polls 500ms + yt-navigate-finish |
| `src/content/navigation.ts` | 117–130 | `stop()` — clears all timers, kills watcher |
| `src/content/navigation.ts` | 147–197 | `notifyEnded()` — arms 45s terminal-idle |
| `src/content/navigation.ts` | 273–302 | `#handleStableUrl` — emits `{continue}` for active session |
| `src/background/nav-stop.ts` | 36–91 | Full stop listener |
| `src/background/nav-stop.ts` | 40–72 | Hard-nav (`loading`) branch — sets continuation intent |
| `src/background/nav-stop.ts` | 80–86 | SPA-nav skip branch (CORRECT for watch→watch) |
| `src/background/nav-stop.ts` | 86 | `void session.stop()` — SPA non-watch URL path |
| `src/background/auto-start.ts` | 25 | `DEBOUNCE_MS = 1500` |
| `src/background/auto-start.ts` | 76–84 | Continuation intent check + Gate 4 bypass |
| `src/background/auto-start.ts` | 86 | Gate 5: `store.state.running || connecting` |
| `src/background/auto-start.ts` | 91–92 | Per-tab debounce (1.5s) |
| `src/background/auto-start.ts` | 98–99 | Intent consumed + `session.start({})` |
| `src/background/session-coordinator.ts` | 156–158 | Background `start()` re-entry guard |
| `src/background/session-coordinator.ts` | 306 | `relayToContent(CONTENT_STOP)` |
| `src/background/store.ts` | 76 | `continuationIntent` field |
| `src/background/store.ts` | 356–364 | `getContinuationIntent()` / `setContinuationIntent()` |
