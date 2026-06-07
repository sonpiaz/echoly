# SLICE 1 — Auto-Next Continuation (both pipelines)

Research findings. Repos: `extension/` (TS+WXT MV3). All paths absolute under
`/root/develop/echoly-workspace/extension`.

## Goal restated

When YouTube auto-advances to the next video, the dub must auto-continue WITHOUT
manual restart: keep the session alive, PAUSE the current dub during the
transition, and dub the next video as soon as its captions are ready.

LIVE SYMPTOM (the bug we must explain): user sees `[echoly-cc]` capture logs but
NO `[nav]` logs, and a dub request gets aborted at video-end with no
`[nav] video ENDED` log. Auto-next never fires.

---

## The detection → continuation pipeline as built today

1. `ContentApp.startSession` (`src/content/index.ts:302-306`) constructs a fresh
   `NavigationWatcher` and starts it with a callback:
   `{continue} → continueOnNewVideo(this, e.videoId)`, `{stop} → stopSession(reason)`.
2. `NavigationWatcher.start` (`src/content/navigation.ts:77-103`) logs
   `[nav] watcher STARTED`, snapshots `#lastVideoId`, installs a 500ms `location.href`
   poll (`#checkUrl('poll')`) and a `yt-navigate-finish` listener
   (`#checkUrl('yt-event')`).
3. `#checkUrl` (`navigation.ts:142-181`) detects a URL diff, debounces
   (700ms poll / 100ms yt-event), then `#handleStableUrl`.
4. `#handleStableUrl` (`navigation.ts:183-235`): if `sm.session == null` → idle path
   (prefetch only, NO continue, `navigation.ts:208-217`); if a session is active and
   the videoId changed → `#emit({continue})` (`navigation.ts:233-234`).
5. `continueOnNewVideo` (`src/content/auto-next.ts:44`) → overlay "switching" →
   9s video-ready poll (`auto-next.ts:69-90`) → dispatch by tier →
   `subtitleFirst.restart()` (`subtitle-first-pipeline.ts:334`) or
   `webrtc.continueOnNewVideo()` (`webrtc-pipeline.ts:486`).
6. Video-end path: `bindCommonVideoListeners.onEnded` (`index.ts:267-274`) logs
   `[nav] source video 'ended' event fired` and calls `nav.notifyEnded()`, which
   opens an 8s PENDING_NEXT window (`navigation.ts:125-138`).

---

## ROOT CAUSE — why it is NOT firing live

The decisive evidence is the **log asymmetry**: `[echoly-cc]` present, `[nav]`
absent, and even `[nav] source video 'ended' event fired` absent.

### Where `[echoly-cc]` comes from (rules out "watcher never created")

`[echoly-cc]` is emitted by `cclog` in
`src/platforms/youtube/captions-fetch.ts:84-85`, which runs inside
`fetchYouTubeCaptionsWithSettle` — the body of `adapter.fetchCaptions`. That is
called from THREE places: (a) the session-start caption fetch
(`subtitle-first-pipeline.ts:157`), (b) `restart()` (`subtitle-first-pipeline.ts:475`),
and (c) the NavigationWatcher's eager prefetch `#startPrefetch`
(`navigation.ts:281-282`). So `[echoly-cc]` alone does NOT prove the watcher ran —
the most likely emitter is the **session-start fetch on the FIRST video**, which is
unrelated to navigation.

### The killer: `stopSession` fires at video-end and calls `nav.stop()` BEFORE the URL changes

`ContentApp.stopSession` (`index.ts:667`) calls `this.nav?.stop()` at line 674.
`NavigationWatcher.stop` (`navigation.ts:106-117`) clears the poll timer, the
yt-event listener, the pending-next timer, and nulls `#onEvent`. After that the
watcher is **deaf** — no `[nav]` log can ever fire again for that session.

So if ANY `stopSession` runs at/just-before video-end, the watcher is dead and the
subsequent SPA navigation to the next video is invisible. The absence of even the
`[nav] source video 'ended' event fired` log (which is in the `onEnded` handler,
`index.ts:268`) tells us the teardown is NOT coming through `notifyEnded` — the
`<video>`'s `ended` event is not what's killing the session. Candidates, in order
of likelihood:

**(b1) WebRTC / Realtime sessions — `ended` never arms a window, AND `stopSession`
can come from the server.** For a Realtime or Standard-WebRTC session at video-end,
the design relies SOLELY on the `<video>` `ended` event → `notifyEnded` → 8s window.
But two things break this:
  - If the session is Realtime, the server-side bridge can emit a backend stop
    (`CONTENT_STOP` → `stopSession(BACKEND_STOP)`, `index.ts:989-991`) when the
    realtime duration hint elapses or the provider closes — killing `nav` before
    autoplay navigates. This is consistent with "a dub request gets aborted at
    video-end."
  - Even absent a backend stop, YouTube does NOT reliably fire a DOM `ended` on the
    `<video>` during instant-autoplay. YouTube's Polymer player frequently
    **SPA-navigates and swaps the media source BEFORE the old media reaches its
    natural end** (the "instant" autoplay rolled out 2024-2025 starts the next video
    early / on a countdown), so `ended` may never fire — `notifyEnded` is never
    called, the 8s window never opens, and the only safety net is the URL poll. The
    URL poll WOULD catch it… **unless the session was already stopped** by something
    else first (b2/b3).

**(b2) Subtitle-first: the request abort at video-end is the OLD driver being
evicted — but the session may also be getting torn down.** In the subtitle-first
path the dub is aborted at end via `session.abortController.abort()` inside
`stopSession` (`index.ts:708`) OR inside `restart()`'s evict block
(`subtitle-first-pipeline.ts:361`). "A dub request gets aborted at video-end with
no `[nav]` log" is the signature of `stopSession` running (which aborts the
controller at `index.ts:708`) rather than `restart()` (which would log
`[auto-next] continueOnNewVideo START`). Since no `[auto-next]` log is reported
either, the path is **stopSession, not continueOnNewVideo**.

**(b3) Idle-path trap: if the session ends a beat before the URL settles, the
navigation is permanently demoted to "prefetch only."** Even in the lucky case
where the poll survives, `#handleStableUrl` branches on `sm.session == null`
(`navigation.ts:208`). The order of operations at autoplay is racy:
  - `stopSession` (video-end teardown) sets `sm.session = null` (`index.ts:793`)
    and `nav.stop()` (`index.ts:674`) — after which the watcher is dead anyway.
  - But consider a watcher that is somehow still alive (e.g. teardown came from a
    path that did NOT call `nav.stop()` — there is none today, but a fix must not
    reintroduce one): if the debounce fires while `sm.session` is briefly null, the
    code takes the idle branch (prefetch only) and updates `#lastVideoId = newId`
    (`navigation.ts:211`). The videoId is now "consumed" — a later continue can
    never fire for it (`newId === this.#lastVideoId` guard, `navigation.ts:198`).
    So a single mistimed teardown turns auto-next into a silent prefetch.

### Synthesis

The auto-next machine is **structurally coupled to the session staying alive across
the transition**, but every video-end teardown path funnels through `stopSession`,
and `stopSession` unconditionally kills the watcher (`nav.stop()`, `index.ts:674`)
and the session (`sm.session = null`, `index.ts:793`). The "keep alive across
auto-advance" half of the design exists ONLY inside the 8s pending-next window,
which is itself armed ONLY by the `<video>` `ended` event — an event YouTube does
NOT reliably deliver on instant-autoplay. Result: in the common case the session
is gone before the new video's URL is detected, so neither `[nav]` nor `[auto-next]`
ever logs. That is exactly the live symptom.

---

## KEY QUESTIONS — answered

**(a) Does YouTube autoplay fire the `<video>` "ended" event, or SPA-navigate
first?** Not reliably. There is no public spec guaranteeing it, and the web search
returned no authoritative doc (only that `ended` is generally fire-once and is
suppressed by `loop`/background-tab quirks). Empirically YouTube's modern
"instant/auto" advance starts the next item on a countdown and SPA-swaps the media
source; the `ended` event on the original element is frequently skipped or fires
AFTER the navigation. **A correct fix must NOT depend on `ended`.** (Confirmed by
the live trace: the `[nav] source video 'ended' event fired` log — `index.ts:268` —
does NOT appear.)

**(b) Does the session STOP before the navigation is detected?** YES — this is the
core bug. `stopSession` runs at video-end (subtitle-first abort signature at
`index.ts:708`; or a Realtime BACKEND_STOP / duration-hint close, `index.ts:989`),
calling `nav.stop()` (`index.ts:674`) and nulling `sm.session` (`index.ts:793`).
After that the watcher is deaf (`#onEvent = null`, `navigation.ts:116`) and
`#handleStableUrl` would take the idle/prefetch branch even if alive
(`navigation.ts:208`). **Which stopSession fires:** for VOD subtitle-first, the
likeliest trigger is NOT the `<video>` `ended` (its log is absent) — it is a stop
coming through another route (see open questions). For WebRTC/Realtime, a backend
stop or the realtime duration-hint elapsing is the prime suspect.

**(c) Is 8s enough for YouTube autoplay?** Mostly yes for the *transition itself*
(URL swap + element ready is typically 1-4s), but it is the WRONG mechanism: the 8s
PENDING_NEXT window (`PENDING_NEXT_TIMEOUT_MS`, `navigation.ts:34`) only opens if
`notifyEnded` is called, and (a) shows it usually isn't. When YouTube shows an
"Up next" countdown the user can sit on it >8s, so even when `ended` DOES fire the
window can expire and emit `{stop, VIDEO_ENDED}` (`navigation.ts:136`) before the
user lets it advance. So 8s is both unreachable (no `ended`) and too short
(countdown). The fix should not rely on a fixed window from `ended` at all.

**(d) Could the session end when captions are exhausted, killing the watcher before
the next video loads?** YES — this is a real second failure mode for subtitle-first.
When the last cue plays out, the natural end of the dub coincides with the
`<video>` approaching its end. The subtitle-first driver itself does not call
`stopSession` on cue-exhaustion (the 250ms `#playbackTick` just goes idle — see
`#sentenceDueAt` returning null, `subtitle-first-pipeline.ts:680-689`), so
exhaustion alone is benign. BUT the surrounding lifecycle DOES stop on the
`<video>` `ended`/duration boundary, and the deferred ring-out teardown in
`stopSession` (`index.ts:721-747`) is explicitly designed for VIDEO_ENDED — meaning
the codebase already expects the session to be torn down at the video boundary.
That teardown kills `nav`. So the answer is: captions-exhausted by itself is fine,
but the **video-end boundary teardown that follows it kills the watcher**, which is
the same root cause as (b).

---

## PROPOSAL — an end-to-end fix NOT dependent on the fragile `ended` event

Principle: **the NavigationWatcher and the session must survive the auto-advance
boundary.** Detect the new video by URL/videoId change regardless of `ended`;
pause-then-dub-immediately; identical for both pipelines.

### P1 — Decouple the watcher's lifetime from the per-video session (CRITICAL)

The watcher must NOT die when the current video's dub ends. Two viable shapes:

- **Preferred:** make the NavigationWatcher **session-independent** — start it once
  when a dub is first requested and keep it running across video boundaries; stop
  it only on a genuine terminal stop (user Stop, SPA-away from watch pages, unload,
  60-min cap). Concretely: do NOT call `nav.stop()` inside `stopSession` for the
  VIDEO_ENDED reason. Today `nav.stop()` is unconditional at `index.ts:674`; gate
  it so video-end / "expected continuation" reasons leave the watcher armed, while
  USER_STOP / BACKEND_STOP / SPA_NAVIGATION / UNLOAD / AUTO_STOP_60MIN /
  NO_CC_UNSUPPORTED still stop it.

- This requires that "the dub ended for THIS video" no longer routes through the
  full `stopSession`. Introduce an internal **soft-end** that quiesces audio +
  overlay (→ a "waiting for next video" state) WITHOUT `nav.stop()` /
  `sm.session = null` / `setActiveAdapter(null)`. The watcher stays alive and, on
  the next videoId, drives `continueOnNewVideo`.

### P2 — Detect the next video by videoId change, never by `ended`

The 500ms URL poll + `yt-navigate-finish` already do this and are the right
primitive. Keep them, but:
- Remove the dependency on `notifyEnded`/the 8s PENDING_NEXT window as the
  *trigger* for continuation. The window can stay ONLY as a fallback timeout to
  declare a true stop when the user genuinely leaves a finished video idle (and even
  that should key off "video at/near end AND no nav for N seconds AND user not on an
  Up-Next countdown"), not as the path to auto-next.
- Fix the **idle-path videoId-consumption trap** (`navigation.ts:211`): when the
  watcher is kept alive in a "waiting for next" state (P1), `#handleStableUrl` must
  treat that as an ACTIVE-continuation state, not the `sm.session == null` idle
  branch. Add an explicit `#awaitingNext` flag so a soft-ended session still emits
  `{continue}` instead of demoting to prefetch-only.

### P3 — Pause-then-dub-immediately (both pipelines)

On `{continue}`:
- Enter a "switching" overlay state (already done, `auto-next.ts:60-62`) and ensure
  the CURRENT dub audio is silenced immediately (subtitle-first already stops
  `currentSource` in `restart()` evict, `subtitle-first-pipeline.ts:354-358`;
  WebRTC `detachOutgoingPeer` in `continueOnNewVideo`, `webrtc-pipeline.ts:509`).
- Then dub the new video as soon as captions are ready. The **B4 eager prefetch**
  (`navigation.ts:262-304`, consumed at `subtitle-first-pipeline.ts:469-472`) is the
  right latency optimization and should be PRESERVED — but it must run for the
  active-session continue path (`forActiveSession: true`, `navigation.ts:226-228`),
  which currently only triggers if `#handleStableUrl` reaches the active branch.
  With P1/P2 keeping the watcher alive, this prefetch will actually fire.

### P4 — Interaction with the ad-gate + start-pause (note, don't break)

- **Ad-gate:** between two videos YouTube often plays a pre-roll. The 9s ready-poll
  in `continueOnNewVideo` already filters ads via `shouldIgnoreSourcePlaybackEvent`
  (`auto-next.ts:84`, → `isYouTubeAdPlaying`, `ad-state.ts:5-15`). But 9s
  (`MAX_WAIT_MS`, `auto-next.ts:69`) can be too short if a 15-30s unskippable ad
  plays before the next video. The ready-poll should treat "ad is playing" as
  "keep waiting" with a MUCH longer ceiling (or no ceiling while an ad is detected),
  not count it against the 9s budget. Mirror the start ad-gate
  (`index.ts:323-368`) which polls without a hard fail.
- **Start-pause / `_systemPaused`:** `restart()` already sets `_systemPaused = true`
  synchronously before `video.pause()` (`subtitle-first-pipeline.ts:460-465`) and
  clears it before `play()` (`subtitle-first-pipeline.ts:584`), so the bound
  `onPause` handler (`index.ts:255`) stays a no-op during the transition. PRESERVE
  this. The WebRTC continue path does not pause the new video (it's already playing)
  — fine; just ensure the dub is silenced during switch so there's no double-audio.
- **pageToken vs activeGen:** auto-next uses a module-level `activeGen`
  (`auto-next.ts:29,54`) deliberately decoupled from `sm.pageToken` so that
  `restart()`/`continueOnNewVideo` token bumps don't falsely supersede the success
  block. PRESERVE — do not reintroduce a pageToken guard around the success
  transition (`auto-next.ts:181-187`).

### P5 — Realtime/Standard-WebRTC parity

The WebRTC continue path (`webrtc-pipeline.ts:486-604`) is sound once the watcher
survives. The only WebRTC-specific risk is a server-driven BACKEND_STOP at
video-end racing the URL change. Mitigate by: (1) not relying on the realtime
duration-hint as a hard kill, and (2) treating a BACKEND_STOP that arrives while
`#awaitingNext`/within the switching window as a soft-end, not a terminal stop —
OR coordinate with SLICE covering server metering so the server does not close the
realtime session at video boundary when the client intends to continue. (Flag to
the server-side slice; do not solve unilaterally here.)

### Net behavioral contract after the fix

1. Dub starts on video A (either pipeline).
2. Video A reaches its end → dub for A soft-ends (audio silenced, overlay →
   "switching/loading next"), session NOT torn down, watcher STILL armed.
3. YouTube autoplay SPA-navigates to video B (URL/videoId changes) — detected by
   the poll/`yt-navigate-finish` regardless of whether `ended` fired.
4. `{continue}` → `continueOnNewVideo` → wait video B ready (ad-aware, generous
   ceiling) → `restart()` (subtitle-first) / `webrtc.continueOnNewVideo()` →
   dub B starts, prefetched captions consumed for minimal latency.
5. Only a genuine terminal event (user Stop, navigate off watch pages, unload,
   60-min cap, or N seconds idle on a finished video with no navigation) calls the
   full `stopSession` and kills the watcher.

---

## Files to change (this slice)

- `src/content/index.ts` — gate `nav.stop()` and `sm.session = null` by reason
  (`stopSession`, ~`index.ts:667-836`); introduce a soft-end path used at the
  video-end boundary instead of the full teardown; keep `onEnded` only as a
  best-effort hint, not the sole trigger (`index.ts:267-274`); keep
  `bindCommonVideoListeners` and `_systemPaused` semantics intact.
- `src/content/navigation.ts` — add an `#awaitingNext` state so a soft-ended
  session still emits `{continue}` (fix the `sm.session == null` idle demotion at
  `navigation.ts:208`); decouple continuation from `notifyEnded`/the 8s window
  (`navigation.ts:125-138`); ensure active-session prefetch
  (`forActiveSession: true`) fires on the continue path.
- `src/content/auto-next.ts` — make the 9s ready-poll ad-aware (longer/no ceiling
  while `isYouTubeAdPlaying`) (`auto-next.ts:69-90`); preserve the `activeGen` guard.
- `src/content/stop-reasons.ts` — possibly add a `VIDEO_ENDED_SOFT` / classify
  reasons into "terminal vs continuable" so `stopSession` can branch cleanly.
- `src/content/pipelines/subtitle-first-pipeline.ts` — minor: ensure `restart()`'s
  evict/rebuild assumes the watcher is alive; no structural change required.
- `src/content/pipelines/webrtc-pipeline.ts` — minor: `continueOnNewVideo` already
  correct; only the BACKEND_STOP-at-boundary interaction (P5) may need a guard.

---

## Risks

- **Keeping the session alive across video-end changes the teardown invariants.**
  The deferred subtitle-first ring-out (`index.ts:721-747`) and the Realtime drain
  (`index.ts:769-778`) are tuned for VIDEO_ENDED meaning "full stop." Soft-end must
  silence/quiesce audio cleanly WITHOUT closing the AudioContext / peer prematurely,
  or the next video's `restart()` (which reuses `audioCtx`/`outputGain`,
  `subtitle-first-pipeline.ts:367-406`) will glitch.
- **Server live-session slot leak (Realtime).** Today `stopSession` posts `/end`
  for realtime (`index.ts:798-800`). A soft-end that skips `/end` could leak the
  `MAX_CONCURRENT_LIVE_SESSIONS` slot for the OLD video while the NEW one builds.
  The WebRTC continue path already `/end`s the old realtime session
  (`webrtc-pipeline.ts:502-503`), so the soft-end must NOT double-`/end` nor skip it.
- **Watcher running with no session = resource/log noise.** A long-lived watcher
  polling every 500ms is cheap, but the prefetch logic must not accumulate stale
  AbortControllers (already guarded by `#cancelPrefetch`, `navigation.ts:307-313`).
- **False auto-next on user-initiated navigation.** If the user manually clicks a
  different video (not autoplay) while a dub is "soft-ended," we'd auto-continue —
  which is arguably desirable, but must be reconciled with the SPA_NAVIGATION stop
  for non-watch URLs (`navigation.ts:151-158`).
- **Ad-aware longer ready-poll** could hang the overlay on "switching" if ad
  detection is wrong; needs an absolute upper bound (e.g. 60s) as a last resort.

## Open questions

- **Which exact `stopSession` reason fires at VOD video-end today?** The trace shows
  no `[nav] source video 'ended'` log, so it is NOT the `<video>` `ended` handler.
  Need a live trace of `[session] stopSession called {reason}` (already logged at
  `index.ts:668`) to confirm whether it is BACKEND_STOP, AUTO_STOP, or another path.
  This determines exactly which reasons the soft-end branch must intercept.
- **Does the Realtime server close the session at the duration hint / video end?**
  If so, the client soft-end is insufficient without a coordinated server change
  (cross-slice with the server metering / realtime-bridge slice).
- **Is the `[echoly-cc]` the user sees the session-start fetch or a prefetch?** If
  prefetch logs ARE appearing, the watcher IS alive at some point — narrowing the
  bug to the idle-path demotion (P2) rather than a dead watcher (P1). A live trace
  distinguishing `[nav] watcher STARTED` presence/absence resolves this.
- **Should manual next-video clicks also auto-continue, or only autoplay?** Affects
  whether `#awaitingNext` is required or whether any new videoId while a (alive)
  session exists should continue.
