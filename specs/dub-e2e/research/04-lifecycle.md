# SLICE 4 — Unified pause/resume/ready lifecycle state machine

> Research findings for the "chuẩn hóa" backbone. Problems 1 (auto-next not
> firing), 2 (ads), 3 (start-pause) are all manifestations of a scattered,
> ad-hoc pause/resume/ready lifecycle with no single owner of `video.pause()`/
> `video.play()` and no explicit state. This doc maps every pause source + resume
> trigger, the flags/guards in play, the conflicts/races between them, then
> proposes one explicit state machine + a single playback owner with a reason-stack.

All file refs are absolute-from-repo-root under
`/root/develop/echoly-workspace/extension/`.

---

## 1. The cast — who owns what today

| Concern | Owner today | File |
|---|---|---|
| Active session + flags (`userPaused`, `videoPaused`, `connectionLost`, `pageToken`) | `SessionManager` | `src/content/session-manager.ts` |
| Start router / ad-gate / WebRTC start / `stopSession` / `bindCommonVideoListeners` | `ContentApp` | `src/content/index.ts` |
| User pause/resume (per-tier) | `pauseSession` / `resumeSession` | `src/content/pause-controller.ts` |
| SPA-nav + video-end detection + pending-next + prefetch | `NavigationWatcher` | `src/content/navigation.ts` |
| Auto-next continuation (restart-in-place) | `continueOnNewVideo` | `src/content/auto-next.ts` |
| Subtitle-first driver (250ms tick, `_systemPaused` micro-pause) | `SubtitleFirstPipeline` | `src/content/pipelines/subtitle-first-pipeline.ts` |
| WebRTC start / handover / continueOnNewVideo | `WebRtcPipeline` | `src/content/pipelines/webrtc-pipeline.ts` |
| Ad detection / spurious-pause guard | YouTube adapter | `src/platforms/youtube/ad-state.ts`, `.../adapter.ts:98-104` |
| Low-level pause/resume of tracks+ctx+server gate | `applyVideoPauseToSession` / `syncSourcePauseState` | `src/lib/rtc-media-sync.ts` |

**There is no single state variable.** "What is the dub doing right now" is a
derived guess from `{ sm.session != null, sm.userPaused, sm.videoPaused,
sm.connectionLost, session._systemPaused, sm.pageToken, NavigationWatcher
#pendingNext/#emitting, auto-next activeGen, overlay state string }` spread across
8 files. Every bug below is two of these getting out of sync.

---

## 2. PAUSE SOURCES — complete map

Every code path that results in the source `<video>` being paused OR the dub being
silenced, and what flag it sets.

| # | Pause source | Trigger | Who calls `video.pause()` | Flag set (synchronously?) | Dub action |
|---|---|---|---|---|---|
| P1 | **User pause** | User clicks pause on the player | nobody (user did it) → fires `pause` DOM event → `onPause` (`index.ts:248`) → `pauseSession` | `sm.userPaused=true` (set INSIDE `pauseSession`, AFTER the event, `pause-controller.ts:27`) + `sm.videoPaused=true` via `syncSourcePauseState` | WebRTC: disable tracks, pause remoteAudio, suspend ctx, POST media-pause. SubFirst: tick idles on `userPaused`. |
| P2 | **System buffer-pause @ start (Standard-VOD)** | Wait for first dub before play | `index.ts:461` (`startWebRtcSession`, `!live && !forceWebRtcStandard`) | none — but listeners not yet bound, so no `onPause` fires | video held paused until `waitForFirstDub` resolves, then `video.play()` (`index.ts:624`) |
| P3 | **System buffer-pause @ start (SubFirst)** | Render first cue before play | `subtitle-first-pipeline.ts:141` (`start()`) | none yet — `bindCommonVideoListeners` is called LATER at `:280`, so the start-pause precedes listener binding | video held paused until first batch rendered, then `video.play()` (`:301`) |
| P4 | **System micro-pause (SubFirst mid-playback)** | Due cue's `_buffer` not ready | `#enterSystemPause` → `videoEl?.pause()` (`subtitle-first-pipeline.ts:701`) | `_systemPaused=true` set SYNCHRONOUSLY before pause (`:694`) — THIS is the one correct synchronous guard | overlay → "buffering"; tick keeps polling; resumes via `#resumeSystemPause` |
| P5 | **Ad-pause** | YouTube mid-roll swaps to ad `<video>`, fires `pause` on the real element | nobody — YouTube does it | NONE. Guard is `shouldIgnoreSourcePlaybackEvent(adapter)` at `onPause` (`index.ts:249`) which returns `isYouTubeAdPlaying()` | `onPause` early-returns → dub NOT paused (keeps playing over the ad) |
| P6 | **Ad-gate @ start** | Ad already playing when Start pressed | nobody pauses; pipeline START is deferred | `adWaitToken = sm.pageToken` captured; poll loop (`index.ts:323-368`) | overlay "ad-wait"; no session yet |
| P7 | **Auto-next transition pause (SubFirst restart)** | New video, restart-in-place | `restart()` `video.pause()` (`subtitle-first-pipeline.ts:462`) | `_systemPaused=true` set synchronously before (`:460`) | render first batch, then `video.play()` (`:587`) |
| P8 | **Realtime-VOD align-pause @ start** | Wait for ICE + first dub | `index.ts:461` (same `!live` branch) | none | `alignRealtimeVodBeforePlay` then `video.play()` (`:649`) |
| P9 | **Standard handover pause** | lang/voice swap rebuilds peer | (no pause in `completeStandardHandover` — "video keeps playing"); `#requestHandoverInner` may pause (`webrtc-pipeline.ts:699` restores only if `!wasPaused`) | reads `wasPaused = video.paused` | quiesce dub-sync, rebuild peer, re-sync |
| P10 | **Stop / teardown** | `stopSession(reason)` | does NOT pause video — restores `muted=false; volume=1.0` (`index.ts:686`) | bumps `pageToken`, `userPaused=false`, `videoPaused=false` | tears down everything |

**Key observation:** Of 10 pause sources, only **P4 and P7** set their flag
**synchronously before** `video.pause()`. P1 sets `userPaused` *after* the event
(inside `pauseSession`). P2/P3/P8 set NO flag at all and rely on listeners not
being bound yet — a timing assumption, not a guard.

---

## 3. RESUME TRIGGERS — complete map

| # | Resume trigger | Detected via | Who calls `video.play()` | Guard before resume |
|---|---|---|---|---|
| R1 | **User play** | `play` DOM event → `onPlay` (`index.ts:260`) → `resumeSession` | user did it (the event is post-hoc) | `shouldIgnoreSourcePlaybackEvent` (ad) at `:262`; `resumeSession` no-ops if `!userPaused` (`pause-controller.ts:68`) |
| R2 | **System resume @ start** | inline await completes | `index.ts:624 / 649`, `subtitle-first-pipeline.ts:301` | `token !== sm.pageToken` checks |
| R3 | **System micro-pause resume (SubFirst)** | buffer arrived / stall-cap / cue skipped | `#resumeSystemPause` → `videoEl?.play()` (`subtitle-first-pipeline.ts:715`) | runs in `#playbackTick` step 1, BEFORE the userPaused guard |
| R4 | **Ad ended** | poll `!isAdPlaying()` (`index.ts:347`) | re-probe; pipeline starts fresh | `adWaitToken === sm.pageToken` |
| R5 | **Auto-next restart resume** | `restart()` after first batch | `subtitle-first-pipeline.ts:587` (`if wasPlaying`) | `_systemPaused` cleared FIRST (`:584`), then play |
| R6 | **Peer-death recovery resume** | `resumeSession` sees `connectionLost` | `webrtc.continueOnNewVideo` rebuilds | `connectionLost && isWebRtcSession` (`pause-controller.ts:71`) |
| R7 | **Connection lost during pause** | media-gate POST non-ok → `connectionLost=true` | deferred to next R1/R6 | — |

---

## 4. THE LIVE BUG — auto-next not firing (no `[nav]` logs at all)

Symptom (from task): user sees `[echoly-cc]` capture logs (so the page IS
YouTube and the MAIN-world caption hook IS running) but **NO `[nav]` logs** —
not "watcher STARTED", not "video ENDED", not "URL changed" — and a dub request
is aborted at video-end. This is the smoking gun.

`NavigationWatcher.start()` logs `[nav] watcher STARTED` unconditionally at
`navigation.ts:83`. The `onEnded` handler logs `[nav] source video 'ended'` at
`index.ts:268`. If NEITHER appears, the most likely root causes, ranked:

### 4a. (most likely) The running content script is a STALE build — `nav` wiring never executed
The `[nav]`/`[auto-next]`/`[session]` diagnostic logs are **uncommitted this
session** (per task context). `[echoly-cc]` is the older MAIN-world caption hook
(`installYtMainWorldBridge`, committed). The version guard
`initContent` (`index.ts:931`):
```
if (Reflect.get(window, CONTENT_GLOBAL_KEY) === ECHOLY_VERSION) return;
```
short-circuits re-init when `ECHOLY_VERSION` is unchanged. If the new code was
loaded but `ECHOLY_VERSION` was NOT bumped, a previously-injected OLD ContentApp
(without the nav logs, possibly without `this.nav` wired the same way) stays
resident and the new `initContent` returns early → you get `[echoly-cc]` (page
hook re-installs idempotently) but no `[nav]`. **First thing to verify live:
confirm `ECHOLY_VERSION` bumped + hard-reload the extension + reload the tab.**
This single fact explains "no nav logs of ANY kind" better than any code race.

### 4b. The `ended` event never fires on the bound `<video>` (YouTube autoplay)
Even with fresh code, on a YouTube **playlist / autoplay** transition, YouTube
frequently advances to the next video **without** the current `<video>` element
firing an `ended` event — it swaps `.src` / seeks and starts the next item, or
the `ended`→next gap is sub-frame. So `onEnded` (`index.ts:267`) may simply never
run. The intended fallback for that case is the `NavigationWatcher` **URL poll**
(`#checkUrl` every 500ms) + `yt-navigate-finish`, which would log
`[nav] URL changed` and then emit `continue`. If THOSE logs are also absent, the
watcher isn't running (→ 4a) OR `#lastUrl` already equals the new URL.

### 4c. The dub "aborted at video-end" with no `[nav] video ENDED`
On a real `ended` with the watcher alive, `notifyEnded()` opens an 8s pending-next
window — it does NOT abort the dub. The abort the user sees is the **subtitle-first
batch fetch** being cut. That abort comes from `stopSession` (`abortController.abort()`,
`index.ts:708`) OR from `restart()` aborting the OLD session (`subtitle-first-pipeline.ts:361`).
If a dub fetch is aborted but no `[nav] video ENDED` and no `[session] stopSession`
log appears, the abort is coming from a path that bypasses both — i.e. the
**stale build** again (old `stopSession` without the `[session]` log), reinforcing 4a.

### 4d. Secondary: even if nav fires, `restart()` rebinds listeners on the WRONG token window
`continueOnNewVideo` → `restart()` calls `sm.nextToken()` (`subtitle-first-pipeline.ts:378`)
which **bumps `pageToken`**. `bindCommonVideoListeners` rebinds `onEnded` →
`this.nav?.notifyEnded()`. `this.nav` is the SAME watcher (created once per
`startSession`, `index.ts:302`), and it is NOT re-`start()`ed across auto-next, so
its `#lastVideoId` is updated inside `#handleStableUrl` (`:231`) — OK. But the
`#emitting` re-entrancy guard (`navigation.ts:241`) and `activeGen` (auto-next)
are independent counters that can disagree on rapid skips (see §5). Not the
primary cause of "no logs", but a latent correctness gap once 4a is fixed.

**Conclusion for the live bug:** order of investigation is **4a → 4b → 4d**. The
"no `[nav]` logs of any kind" symptom is almost certainly a stale/cached content
script (version-guard early return), NOT a logic race. The state machine below
removes the class of bug regardless, but the immediate live fix is a version bump
+ clean reload, then re-test with the diagnostics live.

---

## 5. CONFLICTS & RACES — the real reason to standardize

### C1. Ad-pause vs user-pause clobber each other (no reason stack)
`shouldIgnoreSourcePlaybackEvent` (`index.ts:249,262`) is the ONLY thing
separating an ad-pause (P5) from a user-pause (P1). It reads
`isYouTubeAdPlaying()` **at event time**. Race: user pauses *during* an ad, or an
ad starts *while* the user is paused. There is no record of "who paused" — just a
single boolean `isAdPlaying()` sampled now. If the ad-class is set when the user's
genuine pause fires, the user-pause is **ignored** (dub keeps playing over a
paused video). If the user resumes during an ad, `onPlay` is ignored and the dub
never re-enables. **A reason-stack (`{user, ad, system, buffer}`) is exactly the
missing structure.** Today two independent pause causes share one `video.paused`
bit and one sampled ad-flag.

### C2. `_systemPaused` not reset on an early-return → video stuck paused
`restart()` sets `_systemPaused=true` (`:460`) then `video.pause()` (`:462`).
Every early-exit path AFTER that goes through `restorePlay()` which clears the
flag (`:451`) — GOOD, this was a prior fix. BUT: `restart()` builds a NEW
`newSession` and swaps `sm.session = newSession` at `:433`, while the OLD
session's `_systemPaused` is irrelevant. The risk window: if
`continueOnNewVideo`'s generation guard (`activeGen`) supersedes this restart
mid-flight (`auto-next.ts:146,179`), `restart()` may `return` from a DEEP `if
(myGen !== activeGen) return` **in auto-next, NOT inside restart** — restart
itself runs to completion and DOES clear the flag. The genuinely dangerous case
is the START pauses (P2/P3/P8) which set **no flag at all**: if a stale-token
early return happens between `video.pause()` and `video.play()` (e.g.
`index.ts:553` returns "Cancelled before play."), the video is left **paused with
no flag, no overlay reset, and the session already torn down by Stop** → user sees
a frozen video. There is no single "ensure video resumed on abort" guarantee.

### C3. `onPause`/`onPlay` fighting the system during start
During P2/P3 the start code calls `video.pause()` then later `video.play()`.
Listeners are bound (subfirst) at `:280` — AFTER the start `video.pause()` at
`:141` but the subsequent `video.play()` at `:301` fires a `play` event that hits
`onPlay`→`resumeSession`, which no-ops (`!userPaused`). Mostly benign today, but
it means the "system is driving playback" and "user is driving playback" go
through the SAME unguarded handlers. Any future async gap where `userPaused`
happens to be true turns a system `play()` into a spurious resume.

### C4. `restart()` vs `stopSession` ordering (token + abort)
`stopSession` bumps `pageToken` FIRST (`index.ts:675`) then aborts
(`:708`). `restart()` checks `sm.isSessionStale(token)` at each boundary. If Stop
races an in-flight auto-next: `continueOnNewVideo` is mid-`await restart()`,
`stopSession` bumps token + sets `sm.session=null`. `restart()`'s next
`isSessionStale` returns true → bails via `restorePlay()` → but `sm.session` is
already null and `restorePlay` calls `video.play()` on a video whose session is
dead → dub may briefly resume on a stopped session. The `activeGen` guard in
auto-next and the `pageToken` guard in restart are **two different supersession
mechanisms** that must both agree; they can disagree by one tick.

### C5. AbortController aborts at the wrong time (video-end)
On a real `ended`, `notifyEnded()` opens an 8s window and does NOT abort. But if
the 8s expires → `stopSession(VIDEO_ENDED)` → `abortController.abort()` cuts any
in-flight batch fetch. If autoplay navigates at ~7.9s, the `continue` path fires
`restart()` which ALSO aborts the old controller (`:361`). Either way the abort is
correct, BUT the user-visible "dub request aborted at video-end" is the
**pending-next 8s timeout firing because the `continue` was never emitted** (→
§4, the nav watcher wasn't running). The abort is a *symptom* of nav not firing,
not an independent bug.

### C6. Two resume paths in `#playbackTick` (system vs user) ordered by comment, not by type
`#playbackTick` step 1 (system-pause resume, `:744`) runs BEFORE step 2 (user-pause
idle, `:783`). This ordering is load-bearing and only documented in a comment. A
`_systemPaused` micro-pause that overlaps a genuine user pause is resolved purely
by this ordering. An explicit state (`paused{reason}`) makes this a type check,
not a statement-order invariant.

### C7. `videoPaused` vs `userPaused` — two flags for one fact
`sm.videoPaused` (set in `syncSourcePauseState`, rtc only) and `sm.userPaused`
(set in `pauseSession`, all tiers) are "set in lockstep" per the comment
(`session-manager.ts:99`) but via DIFFERENT code paths — `pauseSession` sets
`userPaused` then calls `syncSourcePauseState` which sets `videoPaused`. SubFirst
NEVER sets `videoPaused`. So `videoPaused` is true only for WebRTC pauses. Any
code reading `videoPaused` (e.g. `beginStandardDubSync`'s `isUserPaused`,
`index.ts:173`) is WebRTC-correct but SubFirst-blind. Two flags, one truth, drift
guaranteed.

---

## 6. PROPOSAL — one explicit lifecycle state machine + one playback owner

### 6.1 States
```
idle        — no session, overlay not mounted
starting    — start router running (ad-gate, capture, build, first-dub gate)
dubbing     — session live, video playing, dub flowing       (the steady state)
paused      — video paused; carries a non-empty reason STACK  (see 6.3)
switching   — auto-next / handover in flight (old session draining, new building)
stopping    — teardown in progress (token bumped, aborts firing)
stopped     — terminal for this session; → idle after overlay removal
```
Transitions (only legal edges):
```
idle      → starting        (CONTENT_START)
starting  → dubbing         (first dub gate passed, video.play() ok)
starting  → stopped         (cancel / error / no-cc-unsupported)
dubbing   → paused          (any PAUSE source pushes a reason)
paused    → dubbing         (reason stack becomes empty)
dubbing   → switching       (nav "continue" / lang-voice handover)
paused    → switching       (auto-next while paused — rare)
switching → dubbing         (restart/continue ok)
switching → stopped         (restart failed → NEXT_VIDEO_LOAD_FAILED)
dubbing   → stopping        (stopSession any reason)
paused    → stopping
switching → stopping
*         → stopping        (UNLOAD / BACKEND_STOP always legal)
stopping  → stopped → idle
```

### 6.2 ONE owner of `video.pause()` / `video.play()` — `PlaybackController`
No other module calls `video.pause()`/`video.play()` directly. All current call
sites (`index.ts:461/624/649`, `subtitle-first-pipeline.ts:141/301/462/587/701/715`,
`webrtc-pipeline.ts:699`, `pause-controller.ts` via rtc-media-sync) route through
it. The controller holds the reason-stack and is the SINGLE place that decides
whether the video should be playing.

### 6.3 Reason-stack (fixes C1, C6, C7)
```ts
type PauseReason = "user" | "ad" | "system-buffer" | "switching" | "connection-lost";
```
- `pause(reason)` pushes the reason; if the stack was empty, actually pauses the
  video + freezes the dub + freezes the session timer.
- `resume(reason)` removes that reason; if the stack becomes empty, actually plays
  the video + thaws the dub + thaws the timer.
- The video is paused **iff the stack is non-empty**. Ad-pause (`"ad"`) and
  user-pause (`"user"`) coexist: an ad starting while the user is paused pushes
  `"ad"`; the user resuming pops `"user"` but the video stays paused because
  `"ad"` remains — exactly correct. The ad ending pops `"ad"`; now empty → resume.
- This replaces `userPaused`/`videoPaused`/`_systemPaused`/`connectionLost` (which
  become DERIVED: `userPaused = stack.has("user")`, etc.) — one source of truth.
- The synchronous-flag-before-`video.pause()` pattern (P4/P7) is preserved by the
  controller setting its stack BEFORE issuing the DOM pause, so the bound
  `onPause`/`onPlay` handlers can ask the controller "did I cause this?" and
  no-op, instead of each pause source inventing its own flag.

### 6.4 `onPause`/`onPlay` become thin (fixes C2, C3)
```
onPause: if controller.isSelfIssued() return;       // system/switch/ad we caused
         if adapter.shouldIgnore() controller.push("ad"); return;  // ad → ad reason
         controller.push("user");
onPlay:  if controller.isSelfIssued() return;
         controller.pop("user");                    // (and pop "ad" if ad gone)
```
The controller guarantees: **on any abort/teardown, if it issued a pause it MUST
issue the matching resume or mark the video user-controllable** — a single
`finally`-style invariant that eliminates the "video stuck paused on early return"
class (C2). This is the one place to enforce "never leave the video frozen."

### 6.5 ONE supersession token (fixes C4)
Collapse `pageToken` (SessionManager) + `activeGen` (auto-next) + `#emitting`
(nav) into a single monotonic `epoch` owned by the lifecycle machine. `switching`
captures `epoch`; any newer `startSession`/`stopSession`/auto-next bumps it; every
async boundary checks `epoch === myEpoch`. One mechanism, no two-counter
disagreement. (`session.token` stays for the handover-safe stale check.)

### 6.6 Controller interface the other slices plug into
```ts
interface LifecycleController {
  // state
  readonly state: LifecycleState;
  is(state: LifecycleState): boolean;

  // playback ownership (ONLY caller of video.pause/play)
  bindVideo(video: HTMLVideoElement): void;        // (re)bind pause/play/ended/seeked
  pause(reason: PauseReason): void;                // push reason; pause iff was empty
  resume(reason: PauseReason): void;               // pop reason; play iff now empty
  isSelfIssued(): boolean;                         // did WE just pause/play?

  // lifecycle transitions (guarded; illegal edges throw in dev)
  toStarting(): void;
  toDubbing(): void;
  toSwitching(): void;
  toStopping(reason: StopReason): void;

  // supersession
  readonly epoch: number;
  bumpEpoch(): number;                             // returns new epoch
  isStale(epoch: number): boolean;

  // events (so overlay/timer/metering subscribe instead of being poked imperatively)
  on(ev: "enter" | "pauseChanged" | "stop", cb: (s: LifecycleState) => void): void;
}
```
- **Subtitle-first pipeline** calls `controller.pause("system-buffer")` /
  `resume("system-buffer")` instead of `#enterSystemPause`/`#resumeSystemPause`
  touching the video directly; the `_systemPaused`/`_bufferWaitStartedAt` flags
  move into the controller's reason metadata.
- **pause-controller.ts** (`pauseSession`/`resumeSession`) becomes the tier-specific
  dub freeze/thaw ONLY (tracks/ctx/server-gate), driven by the controller's
  `pauseChanged` event — it no longer owns `userPaused` or the timer.
- **auto-next.ts** uses `controller.epoch`/`isStale` instead of `activeGen`, and
  drives `toSwitching()`/`toDubbing()`/`toStopping()` instead of poking overlay
  strings + `emitState` by hand.
- **NavigationWatcher** emits the same `NavEvent`s; the callback maps them to
  controller transitions. `#emitting` is subsumed by the epoch.
- **Ad-gate @ start** pushes `controller.pause("ad")` and removes it when the ad
  poll clears — same mechanism as a mid-roll, so start-time and mid-stream ads are
  one code path.
- **Overlay** subscribes to `on("enter")`/`on("pauseChanged")` → it maps
  `state + topmost reason` to its existing visual states (live/paused/buffering/
  switching/ad-wait/connecting) — no more imperative `setOverlayState(...)` strewn
  across 6 files.

### 6.7 Why this makes all 3 problems correct + instant
- **Auto-next (P1):** one epoch means `restart()` and `continueOnNewVideo` can't
  disagree on supersession; `toSwitching → toDubbing` is an explicit edge with a
  single log site, so the live "no transition" symptom is observable in one place.
- **Ads (P5):** ad-pause and user-pause are distinct stack entries; neither
  clobbers the other; ad-end always resumes iff nothing else holds the video.
- **Start-pause (P2/P3/P8):** the controller owns the start pause as a
  `"system-buffer"` reason; the "ensure resumed on abort" invariant guarantees no
  frozen-video early-return — the entire class C2 disappears.

---

## 7. FILES TO CHANGE (for the build slice, not this research)
- NEW `src/content/lifecycle.ts` — `LifecycleController` + reason-stack + epoch.
- `src/content/index.ts` — route `onPause`/`onPlay`/`onEnded` + all `video.pause()/play()` + `stopSession` through the controller; replace ad-gate inline pause.
- `src/content/pause-controller.ts` — reduce to tier dub freeze/thaw driven by `pauseChanged`.
- `src/content/auto-next.ts` — epoch instead of `activeGen`; explicit transitions.
- `src/content/navigation.ts` — map events to transitions; drop `#emitting`.
- `src/content/session-manager.ts` — `userPaused/videoPaused/connectionLost/pageToken` become controller-derived (keep for compat or remove).
- `src/content/pipelines/subtitle-first-pipeline.ts` — `#enterSystemPause`/`#resumeSystemPause` → `controller.pause/resume("system-buffer")`.
- `src/content/pipelines/webrtc-pipeline.ts` — handover/continue use controller epoch + transitions.

## 8. OPEN QUESTIONS
- Should `videoPaused`/`userPaused` be physically removed or kept as derived
  getters for one release (less churn in metering/heartbeat readers)?
- Heartbeat sends `{ paused: userPaused }` (`session-manager.ts:183`) — with a
  reason-stack, what counts as "paused" for billing freeze? Proposal: `paused =
  stack.has("user") || stack.has("ad")` (don't bill ad/user idle) but NOT
  `system-buffer` (still actively translating). Needs confirming against the
  server media-gate semantics.
- Does YouTube actually fire `ended` on playlist autoplay, or must we rely 100% on
  the nav URL poll? (Determines whether `onEnded`/`notifyEnded` is even reachable —
  see §4b. Verify live.)
- The LIVE bug (§4) is most likely a stale build (version guard), independent of
  this refactor — confirm `ECHOLY_VERSION` bump + clean reload BEFORE attributing
  it to a logic race.
