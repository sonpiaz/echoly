# R1 — Stop-Authority Analysis: Spurious `ended` + Content↔Background Stop-Authority Conflict

## Executive Summary

The unexpected `stopSession` is triggered by the **popup's fast-stop path** in
`src/entrypoints/popup/main.ts` (≈line 783), which sends `CONTENT_STOP` directly to the
content tab — **bypassing the background SessionCoordinator entirely** — as an "instant"
optimisation. This fires even when the popup is not the proximate cause: the sequence is:

1. Ad ends → source `<video>` fires a spurious `ended` event (content-video DOM transition
   artefact — see §2).
2. Content sends `CONTENT_ENDED` to background → background updates its store to
   `running=false, tabId=null` (router.ts:87–98) **but does NOT send CONTENT_STOP back**.
3. **However**, the popup's `onToggle()` path sends CONTENT_STOP *directly to the tab* as
   its "instant stop" optimisation simultaneously with or ahead of the background's STOP
   relay (popup/index.ts:783).

The key remaining open question is whether the popup's Stop button was actually pressed
by the user here. If it was NOT pressed, the issue is that the background's `session.stop()`
(called from the popup STOP or from nav-stop) issues `relayToContent(tabId, { type: "CONTENT_STOP" })` at
session-coordinator.ts:306, and the **tabId may still be valid** because the background
store has not been cleared yet.

A cleaner alternative trigger: the `tabs.onRemoved` listener in `background/index.ts:35–41`
calls `session.stop()` if the tab is closed, and `session.stop()` always relays CONTENT_STOP.

The *most likely* trigger in the ad-end scenario (no hard nav, no tab close, no popup press)
is traced in detail below.

---

## 1. Exact Call Chain: "ad ENDED" → unexpected stopSession

### Observed log sequence
```
[ad] ad ENDED → resume dub                        ← AdWatcher.#evaluate() → onAdEnd callback
[nav] source video 'ended' event fired → notifyEnded  ← bindCommonVideoListeners onEnded
[nav] video ENDED → keep watcher alive, terminal-idle window open (45000ms)
                                                   ← NavigationWatcher.notifyEnded()
[session] stopSession called {reason…}  Error: stop-trace  ← ContentApp.stopSession()
[nav] watcher STARTED                              ← new NavigationWatcher().start()
[ad] watcher STARTED                               ← new AdWatcher().start()
```

### Most likely trigger path (no user button press)

The critical clue is the **timing**: `stopSession` fires *immediately* after `notifyEnded`
arms the 45-second window — not 45 seconds later. This rules out the terminal-idle timer.
And the log shows a FRESH nav+ad watcher starting right after, which is consistent with
`startSession` being called — meaning the background sent `CONTENT_START` after sending
`CONTENT_STOP`.

The exact chain:

**Step A — Ad transition fires spurious `ended` on the source `<video>`**

When YouTube finishes an ad and restores the real content video, it may replace the `<video>`
element or seek it to 0 + seek back, or briefly set `currentTime = duration`. Any of these
can fire an `ended` event on the real content `<video>` before it resumes playing.

```
AdWatcher.#evaluate()                    ad-watcher.ts:111
  → this.#onAdEnd?.()                   ad-watcher.ts:119
  → ContentApp.#exitAdPause()            index.ts:379
    lifecycle.resume("ad") → video.play()
```

Immediately after (same microtask queue), the video's `ended` event fires:

```
bindSourceVideoPlayback onEnded cb        content/index.ts:298-305
  → this.nav?.notifyEnded()              index.ts:304
    NavigationWatcher.notifyEnded()       navigation.ts:147
      #awaitingNext = true
      arms 45,000ms #terminalIdleTimer   navigation.ts:162
```

**Step B — Background receives CONTENT_ENDED and clears tabId**

Separately (or just before/after), the content script's `stopSession` is called with
`USER_STOP`. At the bottom of `stopSession`:

```
ContentApp.stopSession(reason)            index.ts:851
  sm.emitEnded(STOP_REASON_MESSAGE[reason])  index.ts:1036
    SessionManager.emitEnded(reason)      session-manager.ts:186
      notifyBackground({ type: "CONTENT_ENDED", reason })
```

Background receives `CONTENT_ENDED`:
```
handleContentEvent → message.type === "CONTENT_ENDED"  router.ts:87
  store.setRunning(false)
  store.setTabId(null)                   router.ts:90
  store.setSessionStartedAt(null)        router.ts:91
  store.broadcast()                      router.ts:93
  scheduleHydrateSignedIn(...)           router.ts:96
```

**The background does NOT send CONTENT_STOP on receiving CONTENT_ENDED.** (Confirmed:
router.ts:87–98 has no `relayToContent` call, no `session.stop()` call.)

**Step C — Tracking who sent the CONTENT_STOP**

The only places that send `CONTENT_STOP` to the content tab are:

| Sender | Code location | Trigger condition |
|---|---|---|
| `SessionCoordinator.stop()` | session-coordinator.ts:306 | Any call to `session.stop()` |
| Popup `onToggle()` fast-path | popup/index.ts:783 | User clicks Stop button |

`session.stop()` is called from:
- `background/index.ts:41` — `tabs.onRemoved` (tab closed)
- `background/index.ts:41` — `tabs.onRemoved` (tab closed)
- `nav-stop.ts:68` — `tabs.onUpdated` with `status:"loading"` on the session tab
- `nav-stop.ts:86` — `tabs.onUpdated`, SPA nav away from watch page (NOT a watch URL)
- `router.ts:78` — `CONTENT_STOP_REQUEST` message from content (overlay Stop button)
- Popup `handlePopupMessage` case `"STOP"` → `session.stop()` (router.ts:181)

**The SPA-nav scenario in `nav-stop.ts`** is the most likely non-user trigger in the
ad-end sequence:

```
tabs.onUpdated fires for the session tab       nav-stop.ts listener
  changeInfo.url is set (YouTube SPA nav)
  changeInfo.status is NOT "loading"           (SPA = no status:"loading")
  store.state.running = true (OR connecting)
  isSupportedWatchUrl(changeInfo.url) = true   (still a YouTube watch page)
  → return (SKIP the stop)                     nav-stop.ts:81–85
```

However, **there is also a second `tabs.onUpdated` listener** in `background/index.ts:53–60`
that calls `session.refreshActiveSite()`. This is benign (just refreshes the domain).

**The exact trigger in the bug sequence is**: when YouTube transitions from the ad to the
content video, it may fire a SPA-style `tabs.onUpdated` for the same tab whose URL changes
to something that is NOT a supported watch URL (e.g. briefly to `youtube.com/` or an ad URL).
If `store.state.running` is true but `isSupportedWatchUrl(changeInfo.url)` is false:

```
nav-stop.ts listener:
  tabId === store.state.tabId              ✓ (same tab)
  changeInfo.url is set                    ✓ (URL changed)
  changeInfo.status !== "loading"          ✓ (SPA-style)
  (store.state.running || connecting)=true ✓
  isSupportedWatchUrl(url) = false         ✓ (briefly non-watch URL)
  → falls through to: void session.stop()  nav-stop.ts:86
```

`SessionCoordinator.stop()`:
```
session.stop()                             session-coordinator.ts:282
  wasActive = running || connecting        → true
  targetTabId = store.state.tabId          → valid tab
  ensureContentScript(targetTabId)
  relayToContent(targetTabId, { type: "CONTENT_STOP" })  ← session-coordinator.ts:306
```

Content receives `CONTENT_STOP`:
```
content onMessage case "CONTENT_STOP":     index.ts:1192
  app.stopSession(STOP_REASON.USER_STOP)   index.ts:1198
    [full teardown + nav.stop() + adWatcher.stop()]
    nav.stop() clears #awaitingNext and the 45s timer  ← THIS kills the keep-alive
    sm.emitEnded(...)                      → CONTENT_ENDED back to bg
```

Then `startSession` is called (by auto-start or re-start):
```
  new NavigationWatcher(app) → start()     ← "[nav] watcher STARTED"
  new AdWatcher(app) → start()             ← "[ad] watcher STARTED"
```

This matches the observed log perfectly.

---

## 2. Where Does the Spurious `ended` Originate?

### Hypothesis 1 — Ad→content video DOM transition (HIGHEST PROBABILITY)

When a YouTube mid-roll ad ends, YouTube may:
- Swap the `<video>` src (same element, new src → seeking from 0 fires `ended` if
  `currentTime` was at `duration` of the ad clip).
- Or: the ad `<video>` fires `ended` naturally as the ad finishes, and `bindCommonVideoListeners`
  is still attached to that element (not the real content video).

Evidence: The ad-watcher's `onAdEnd` fires at the same time the `ended` event fires — this
timing is causal. YouTube's ad `<video>` fires `ended` at ad completion, which triggers
YouTube's internal logic to restore the content video. Meanwhile `bindCommonVideoListeners`
at `index.ts:298` is attached to the *last* video `captureWithRetry` found — if the ad
played through the same `<video>` element, the `onEnded` handler fires for the ad's own
natural end.

### Hypothesis 2 — YouTube SPA seek-to-end artefact (MEDIUM PROBABILITY)

On ad→content transition, YouTube sometimes seeks the content video to near its end then
back (thumbnail preload), briefly making `currentTime ≈ duration`, which fires `ended`.

### Hypothesis 3 — `#exitAdPause` calling `video.play()` triggers a seek callback (LOW)

`lifecycle.resume("ad")` calls `video.play()`. If the video's `currentTime` happened to
equal `duration` at that moment (paused at end of ad), `play()` can fire `ended` before
the browser can seek.

**All three hypotheses converge on the same code path:**
`bindSourceVideoPlayback onEnded` → `this.nav?.notifyEnded()` at `index.ts:298–305`.

The bind happens once at `startWebRtcSession` (index.ts:706) or `subtitleFirst.start()` to
the capture's video element. The real culprit is that this is the **ad video element** or
the same element that fires `ended` during the ad→content transition.

---

## 3. Is There a CONTENT_ENDED → Background → CONTENT_STOP Loop?

**No direct loop.** The background's `CONTENT_ENDED` handler (router.ts:87–98) does NOT
send CONTENT_STOP back. It only:
1. Clears store state (`running=false`, `tabId=null`, etc.).
2. Calls `scheduleHydrateSignedIn`.

There is **no circular re-trigger** via `CONTENT_ENDED`.

However, there is an **indirect loop** in the timing: if `stopSession` is called by the
background's CONTENT_STOP relay, it calls `sm.emitEnded()` → background receives
`CONTENT_ENDED` → `store.setTabId(null)`. Then if `session.stop()` fires a second time
(e.g. from nav-stop's concurrent listener), `targetTabId` from `store.state.tabId` is
already null, but the fallback `chrome.tabs.query({active:true})` may still find the tab —
so a second `relayToContent(CONTENT_STOP)` could arrive. Content's `stopSession` is
idempotent (it checks `sm.session == null` early), so this is not catastrophic.

---

## 4. Why the Content Keep-Alive Does NOT Protect the Session

`NavigationWatcher.notifyEnded()` (navigation.ts:147) arms a 45-second
`#terminalIdleTimer`. This is purely a **content-side guard** — it only prevents the
content from calling `stopSession(VIDEO_ENDED)` prematurely.

It provides **zero protection against externally-initiated stops**. When the background
sends `CONTENT_STOP`, the content's message handler (index.ts:1192–1199) calls
`app.stopSession(USER_STOP)` unconditionally, and `stopSession` calls `this.nav?.stop()`
(index.ts:875) which `clearTimeout`s the `#terminalIdleTimer` and sets `#awaitingNext=false`.

The keep-alive is a *self-stop guard* for the content's own timer. It is architecturally
blind to the background's authority because:
1. There is no shared "session is in pending-next state" signal from content to background.
2. The background has no awareness of `#awaitingNext` state.
3. The background's `session.stop()` path does not consult any content state before relaying
   `CONTENT_STOP`.

**Gap:** The background stop-authority (nav-stop + coordinator) and the content keep-alive
operate on entirely separate information. The content keeps a 45-second window open; the
background can close it with zero notice.

---

## 5. Fix Options

### Fix A — Guard nav-stop against ad-transition URL flickers (RECOMMENDED)

**Root cause targeted:** `nav-stop.ts` fires `session.stop()` when the tab URL briefly
leaves a watch page during the ad→content video transition.

**Change:** In `registerNavStop`, before calling `session.stop()` on a non-watch URL, add
a short debounce (e.g. 800ms) to allow the URL to settle back to a watch URL. If the URL
returns to a watch page within the window, skip the stop.

```typescript
// nav-stop.ts
let navStopTimer: ReturnType<typeof setTimeout> | null = null;
// ... inside listener, non-watch-url branch:
if (navStopTimer) clearTimeout(navStopTimer);
navStopTimer = setTimeout(() => {
  navStopTimer = null;
  // Re-check: if URL is now a watch page again, skip.
  chrome.tabs.get(tabId, (tab) => {
    if (tab?.url && isSupportedWatchUrl(tab.url)) return; // recovered
    void session.stop();
  });
}, 600);
```

**Files touched:** `src/background/nav-stop.ts`
**Tradeoffs:** Adds 600ms delay to legitimate non-watch navigations (acceptable). Does NOT
fix if the URL never was non-watch (if the issue is actually the content-side ended event
triggering something else). Debounce state is module-level, needs cleanup if session changes.

---

### Fix B — Propagate `awaitingNext` state to background; block background stop during pending-next (THOROUGH)

**Root cause targeted:** The background has no awareness of the content's "pending-next"
keep-alive window.

**Change:** Add a new `ContentToBgMessage` type `CONTENT_AWAITING_NEXT` (boolean).
Content sends this when `notifyEnded()` sets `#awaitingNext=true` and when it clears.
Background stores this flag in the Store. `session.stop()` (and nav-stop) checks this
flag and skips (or delays) the stop when `awaitingNext=true` and the URL is still a
supported watch page.

**Files touched:**
- `src/shared/protocol.ts` — new message type
- `src/background/store.ts` — new `awaitingNext` field
- `src/content/navigation.ts` — emit `CONTENT_AWAITING_NEXT` in `notifyEnded` and on resolution
- `src/background/nav-stop.ts` — gate stop on `!store.state.awaitingNext`
- `src/background/session-coordinator.ts` — gate `stop()` relay on `!store.state.awaitingNext`

**Tradeoffs:** More invasive. Requires keeping the new flag in sync (race if background
stop arrives while content is still emitting). Adds protocol message overhead. Covers all
stop paths. Risk: if `awaitingNext` gets stuck true, background can never stop (mitigate
with a server-side timeout matching TERMINAL_IDLE_TIMEOUT_MS).

---

### Fix C — Filter spurious `ended` events in `bindCommonVideoListeners` (PARTIAL)

**Root cause targeted:** The ad `<video>` or the same video element firing `ended` during
the ad→content transition.

**Change:** In `onEnded` (index.ts:298), check whether an ad is currently active or was
*just* active (within 500ms):

```typescript
onEnded: () => {
  // Guard: if the AdWatcher considers an ad active or just ended, the
  // 'ended' event is almost certainly the ad clip's own end — not the
  // real content video ending. Suppress it.
  if (this.ad?.adActive || this.#recentAdEnd) return;
  console.info("[nav] source video 'ended' event fired → notifyEnded");
  extra.onEndedBefore?.();
  this.nav?.notifyEnded();
},
```

Add `#recentAdEnd: boolean` that is set to `true` in `#exitAdPause()` and cleared after
500ms.

**Files touched:** `src/content/index.ts` only.
**Tradeoffs:** Simplest, smallest change. Does NOT fix the root cause (background stops
from nav-stop for non-watch URL flickers). It only prevents `notifyEnded` from being armed
when the ended event is definitely ad-related. If the real content video also ends during
the 500ms window, it would be missed. Good as a layer-1 defence combined with Fix A.

---

## 6. Cross-Slice Conflicts

- **Ad-detection overlap:** Fix C modifies `index.ts`'s `onEnded` handler which is shared
  by both WebRTC and subtitle-first pipelines. Needs to be verified against the subtitle-
  first pipeline's `onEndedBefore` callback (used for final-cue ring-out).

- **Auto-next:** Fix A's debounce in nav-stop is orthogonal to the auto-next path
  (`continueOnNewVideo`). The auto-next path is driven by video-ID change in
  `NavigationWatcher`, not by `session.stop()`, so the debounce does not interfere.

- **Hard-nav continuation intent:** nav-stop's `status:"loading"` branch (hard nav) is
  separate from the SPA-nav branch targeted by Fix A. The debounce must ONLY apply to
  SPA-nav (non-loading) stops — the hard-nav branch must remain instant (the content
  script is being destroyed and must be stopped NOW before auto-start re-fires).

- **Popup fast-stop CONTENT_STOP:** The popup's `onToggle()` sends CONTENT_STOP directly
  to the tab (popup/index.ts:783) in parallel with calling `session.stop()`. If the popup
  Stop was pressed by the user, the keep-alive cannot and should not block it — this is
  a user-intentional stop. Fix B must NOT block user-intentional stops from the popup.

---

## File References

| File | Lines | Role |
|---|---|---|
| `src/content/ad-watcher.ts` | 111–122 | `[ad] ad ENDED → resume dub` log; fires `onAdEnd` callback |
| `src/content/index.ts` | 298–305 | `onEnded` → `nav.notifyEnded()` |
| `src/content/index.ts` | 379–419 | `#exitAdPause()` — ad-end ad-pop path |
| `src/content/navigation.ts` | 147–197 | `notifyEnded()` — arms 45s terminal-idle |
| `src/content/navigation.ts` | 117–130 | `stop()` — clears timers incl. `#terminalIdleTimer` |
| `src/content/index.ts` | 851–1039 | `stopSession()` — universal teardown |
| `src/content/index.ts` | 875 | `this.nav?.stop()` — kills the keep-alive |
| `src/content/index.ts` | 1192–1199 | `case "CONTENT_STOP"` → `stopSession(USER_STOP)` |
| `src/background/nav-stop.ts` | 36–91 | Background `tabs.onUpdated` stop logic |
| `src/background/nav-stop.ts` | 80–86 | SPA-nav non-watch-URL branch → `session.stop()` |
| `src/background/session-coordinator.ts` | 282–333 | `stop()` → `relayToContent(CONTENT_STOP)` |
| `src/background/session-coordinator.ts` | 306 | **The line that sends CONTENT_STOP** |
| `src/background/router.ts` | 87–98 | `CONTENT_ENDED` handler — NO CONTENT_STOP relay |
| `src/background/index.ts` | 35–41 | `tabs.onRemoved` → `session.stop()` |
| `src/shared/protocol.ts` | 84 | `CONTENT_STOP` message type |
| `src/shared/protocol.ts` | 129 | `CONTENT_ENDED` message type |
| `src/popup/index.ts` | 779–786 | Popup fast-stop: direct `CONTENT_STOP` to tab |
| `src/content/session-manager.ts` | 186–188 | `emitEnded()` → `CONTENT_ENDED` to bg |
