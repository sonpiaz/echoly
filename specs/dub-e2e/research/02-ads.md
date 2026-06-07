# Slice 2 — ADS: pause dub on ad, resume on skip/end (both pipelines)

**Researcher:** slice-2 (ads)
**Date:** 2026-06-05
**Repos:** `extension/` (Chrome MV3, TS+WXT), some server context.
**Scope:** ad detection + dub pause/resume on ads, for BOTH pipelines (subtitle-first VOD + webrtc Realtime/Standard). Plugs into the unified lifecycle (slice 4).

---

## TL;DR (the headline root cause)

> **There is NO mid-session ad detection. None. The only ad logic in the whole codebase is the START gate** (`startSession` in `index.ts:321-368`). Once a session is live, an ad that starts mid-watch is handled ONLY as a side-effect of `shouldIgnoreSourcePlaybackEvent` — which was designed to *prevent teardown*, not to pause the dub. The dub keeps playing straight over the ad, desyncing against the ad's timeline, and "resume" is incidental.

And the bomb under all of it, confirmed by web research:

> **YouTube uses a SINGLE `<video>` element for both ads and content.** ([vidstack discussion #1466], [DEV / js_bits_bill]) The ad does NOT play in a separate element. So during a mid-roll, `capture.videoEl.currentTime` becomes the **AD's** clock (e.g. jumps to 0→15s of a 15s ad), then jumps back to the content time when the ad ends. Every piece of our dub-sync machinery keys off `video.currentTime` — so during an ad the subtitle-first driver and the Standard drift-corrector are both anchored to the wrong clock.

The current behavior "exists today but is janky" precisely because it's not real ad handling — it's the absence of teardown plus uncontrolled audio.

---

## Current behavior, concretely (with file:line)

### A. The START ad-gate — the ONLY explicit ad code (`index.ts:321-368`)

`ContentApp.startSession` checks `this.adapter.isAdPlaying?.() === true` ONCE, before routing to a pipeline:

- builds the overlay, sets `overlay.setOverlayState("ad-wait")` + `STATUS_AD_WAIT` ("Waiting for ad to finish…", `product-copy.ts:33`).
- captures `adWaitToken = sm.pageToken` (the stale-guard), then polls `isAdPlaying()` every `AD_WAIT_POLL_MS = 250ms` (`constants.ts:68`) until the ad clears or Stop bumps the token.
- on clear: waits one more 250ms beat, re-detects the adapter, and calls `_routeStart()`.

This is correct and self-contained, but **it only runs at Start.** Nothing re-arms it for a session that's already running.

### B. `isYouTubeAdPlaying()` — the detection primitive (`platforms/youtube/ad-state.ts:5-17`)

```js
const player = document.getElementById("movie_player");
if (!player) return false;
return player.classList.contains("ad-showing")
    || player.classList.contains("ad-interrupting");
```

Confirmed canonical: YouTube toggles `ad-showing` / `ad-interrupting` on `#movie_player` only while an ad is live ([adblockplus blog], [vidstack #1466]). The code has a good comment explaining why `.video-ads.ytp-ad-module` was rejected (always present in DOM → false positives → real user pauses ignored). **This primitive is polled, never observed** — there is no MutationObserver, so reaction to an ad START is at best one poll-interval late, and currently *not polled at all mid-session*.

### C. `shouldIgnoreSourcePlaybackEvent` — the mid-session "handler" (by accident)

- Wrapper `source-playback-guards.ts:22-34` → delegates to `adapter.shouldIgnorePlaybackEvent(ev, video)`.
- YouTube impl (`adapter.ts:102-104`) returns `isYouTubeAdPlaying()` — i.e. "ignore this pause/play event iff an ad is currently showing."
- Wired in `bindCommonVideoListeners` (`index.ts:240-277`):
  - `onPause` (line 248): `if (shouldIgnoreSourcePlaybackEvent(adapter)) return;` → so when the single `<video>` fires `pause` at the ad boundary, **`pauseSession()` is NOT called.** The dub session stays "live."
  - `onPlay` (line 260): same guard → `resumeSession()` is NOT called when the video fires `play` at the ad boundary.

**This is the (b) sub-question answered:** the guard suppresses the ad pause/play so the session is not torn down and `userPaused` is not set — but it does **NOT pause the DUB.** It does the opposite: it *protects the dub from pausing.* So the dub audio keeps playing over the ad.

### D. What the dub actually does during a mid-roll ad

**Subtitle-first VOD** (`subtitle-first-pipeline.ts`, driver `#playbackTick` line 733, 250ms interval line 312):
- The driver gates on `sm.userPaused` (line 783) and `video.currentTime` (line 802). During an ad: `userPaused` is false (guard suppressed it), and `video.currentTime` is now the AD's timeline.
- `this.#sentenceDueAt(s, video.currentTime)` (line 812) looks up cues by the ad clock. A 15s ad reads `currentTime ≈ 0..15`, so it will (re)select cues near content-second 0..15 — **replaying or mis-firing dub over the ad.** If the content was at 03:20 when the mid-roll hit, the ad clock 0..15 maps to early cues → the dub speaks wrong lines over the ad.
- Drift-skip (line 815, `SUBFIRST_DRIFT_SKIP_SEC`) may mark a slew of cues `_played=true` because `t - due.end` is hugely negative/positive vs the ad clock — **silently burning cues that will never replay** once content resumes.
- Worse: ad insertion frequently fires a `seeked` event. `#onSeek` (subtitle-first) re-anchors `renderCursor` and resets `_played` flags based on the **ad** `currentTime` (`#onSeek`: `newT = video.currentTime`), corrupting the play-once bookkeeping. On ad-end it seeks back → another `#onSeek` against content time. Net = scrambled cue state, drift, possible "dup TTS" regressions reappearing.

**WebRTC Realtime / Standard** (`webrtc-pipeline.ts`, `remoteAudio` is a live `MediaStream` `<audio>`):
- `remoteAudio` is driven by the server bridge, totally independent of `video.currentTime`. During an ad **the dub audio just keeps playing** (the server keeps relaying/synthesizing from whatever the mic/tab capture feeds — and tab-capture is now capturing the AD's audio). For Realtime that means **the model starts translating the AD.** Credits burn on ad audio.
- Standard VOD drift-corrector `bindStandardDubPlaybackSync` (`dub-playback-sync.ts:70`): `tick()` keys off `opts.video.currentTime` vs `dub.currentTime`. During the ad, `video.currentTime` = ad clock → `computeVideoAheadSec` computes garbage → it ramps `video.playbackRate` to "catch up/slow down" **the AD** (line 101 sets `opts.video.playbackRate` — i.e. it will speed up or slow down the ad itself), then on ad-end the anchors are stale and it mis-corrects content. `isUserPaused()` is false throughout (the guard suppressed it), so the corrector never quiesces.

### E. The metering / cost angle

For Realtime + Standard-WebRTC, the dub is a live server pipeline. During the ad we are still **capturing the ad's audio** (the `MediaStream` from `captureStream`/tab capture follows the same element) and relaying it to OpenAI/MiniMax/Gemini. `pauseSession()` is what POSTs `media-pause` to freeze server metering (`pause-controller.ts:33` → `syncSourcePauseState`). Because `pauseSession()` is never called during an ad, **the server keeps metering credits against ad audio** and the model translates the ad. This is a real cost + correctness leak, not just cosmetic jank.

---

## Root causes (ranked)

| # | Issue | Evidence | Severity |
|---|---|---|---|
| RC-1 | **No mid-session ad detection at all** — only the Start gate. Ads that begin during an active session are never detected; the dub is never paused. | `index.ts:321-368` is the only `isAdPlaying` call besides the gate poll; `grep isAdPlaying` → 2 sites, both in the start gate. `bindCommonVideoListeners` has no ad polling. | **critical** |
| RC-2 | **The guard suppresses teardown but actively prevents the dub from pausing.** `shouldIgnoreSourcePlaybackEvent` returns early *before* `pauseSession`, so the dub keeps playing over the ad. | `index.ts:249` (`onPause` returns early), `index.ts:262` (`onPlay` returns early); `adapter.ts:102-104`. | **critical** |
| RC-3 | **Single `<video>` element ⇒ all sync keys off the AD clock during a mid-roll.** Subtitle-first driver and Standard drift-corrector both read `video.currentTime`, which is the ad's timeline during a mid-roll, replaying/skipping/mis-rating against the wrong clock. | WebSearch confirms single element ([vidstack #1466], [DEV js_bits_bill]); `subtitle-first-pipeline.ts:802,812`; `dub-playback-sync.ts:88-101`. | **critical** |
| RC-4 | **Ad-boundary `seeked` corrupts subtitle-first play-once bookkeeping.** `#onSeek` re-anchors `renderCursor` and resets `_played` against the ad `currentTime`, then again on ad-end — scrambling cue state, risking drift + dup-TTS regressions. | `#onSeek` reads `video.currentTime` with no ad guard. | **high** |
| RC-5 | **Realtime/Standard-WebRTC translate the AD + burn credits.** No `media-pause` is sent during an ad (pauseSession never fires), so the server keeps metering and the model translates ad audio. | `pause-controller.ts:33`; no ad-driven call path to `syncSourcePauseState`. | **high** |
| RC-6 | **Detection is poll-only and the primitive is fragile.** `isYouTubeAdPlaying` is class-based and only polled (250ms at the gate, 0 mid-session). No MutationObserver ⇒ reaction is inherently lagged; "instant" is impossible with the current shape. YouTube actively changes ad markup ([adblockplus]). | `ad-state.ts`; no observer anywhere; mid-session poll absent. | **medium** |
| RC-7 | **`shouldIgnorePlaybackEvent` only exists for YouTube.** Coursera/Udemy/Generic adapters have no ad notion; fine today (no ads), but the abstraction is YouTube-shaped and gives no `onAdStart/onAdEnd` signal for the lifecycle to consume. | `grep shouldIgnorePlaybackEvent` → youtube adapter only. | **low** |

---

## Proposal — instant, race-free ad→pause-dub / skip-or-end→resume-dub (both pipelines)

The fix is to introduce **real, event-driven, mid-session ad detection** and route it through the **same pause/resume primitives the user-pause path already uses** (`pauseSession`/`resumeSession`), so both pipelines and server metering are handled by one well-tested path. This plugs cleanly into the unified lifecycle (slice 4).

### 1. An `AdWatcher` — instant, observer-driven (new `content/ad-watcher.ts`)

Mirror `NavigationWatcher`'s shape (start/stop, owned by `ContentApp`, re-armed per session):

- Primary signal: **`MutationObserver` on `#movie_player`'s `class` attribute** (`attributeFilter: ['class']`) — fires synchronously on the same microtask YouTube flips `ad-showing`/`ad-interrupting`. This is the "instant" the goal asks for; polling can never match it. ([vidstack #1466] recommends exactly this.)
- Backstop: a low-frequency poll (~250ms, reuse `isAdPlaying()`) for platforms without a class signal and to catch any observer miss. Debounce both into a single edge-detector that emits `onAdStart()` / `onAdEnd()` exactly once per transition (track a `#adActive` boolean; ignore no-op class churn).
- Generalize the adapter port: add an optional `getAdSignalTarget?(): Element | null` (returns `#movie_player`) and keep `isAdPlaying()` as the poll fallback. Non-YouTube adapters return null → watcher is poll-only / no-op (they have no ads today).

### 2. Route ad edges through the existing pause/resume primitives

In `ContentApp` (wired in `startSession`, stopped in `stopSession`, parallel to `nav`):

```
this.adWatcher = new AdWatcher(this);
this.adWatcher.start({
  onAdStart: () => this.#enterAdPause(),
  onAdEnd:   () => this.#exitAdPause(),
});
```

- `#enterAdPause()`: set a new flag `sm.adActive = true`, then call **`pauseSession(this)`** — the SAME path as user-pause. That:
  - subtitle-first: driver idles on `sm.userPaused` (or a unified "effectivePaused" — see §4), dub goes silent next tick (≤250ms; with the observer, the pause flag is set *before* the ad's first audio frame in practice).
  - WebRTC: disables sender tracks (stops sending **ad audio** to the provider), pauses `remoteAudio`, suspends `AudioContext`, and POSTs `media-pause` → **server metering freezes, model stops translating the ad** (fixes RC-5).
  - Overlay: flip to `"ad-wait"` state + `STATUS_AD_WAIT` (reuse existing copy/state) instead of `"paused"`, so the user sees "Waiting for ad to finish…".
- `#exitAdPause()`: clear `sm.adActive = false`, then call **`resumeSession(this)`** (re-enables tracks, `media-resume`, re-anchors Standard drift via `snapPlaybackStart()`, restarts subtitle-first driver). For subtitle-first, on resume **re-anchor against content `currentTime`** (the ad-end seek already landed back on content time) — `resumeSession` + the driver's natural `#sentenceDueAt(video.currentTime)` recovers; ensure `#onSeek` is suppressed during the ad window (see §3) so it doesn't corrupt cue state.

### 3. Suppress the ad clock from corrupting sync (RC-3, RC-4)

The single-element problem means we must **freeze sync state across the ad**, not just mute audio:

- Subtitle-first: while `sm.adActive`, `#playbackTick` must early-return (covered if we make it gate on an `effectivePaused = userPaused || adActive`), and **`#onSeek` must be a no-op while `adActive`** (the ad-insert + ad-end seeks are not user seeks). On ad-end, do a single clean re-anchor at the (restored) content `currentTime`. This stops the wrong-cue replay and the play-once corruption.
- Standard drift-corrector: `bindStandardDubPlaybackSync.isUserPaused` currently reads `() => this.sm.videoPaused`. Change the predicate the corrector sees to `videoPaused || adActive` (or quiesce it in `#enterAdPause` like `pauseSession` already does for `pipeline==="standard"` at `pause-controller.ts:35`). On ad-end, `snapPlaybackStart()` resets anchors against content time — already the resume path. This stops it from rate-warping the ad and mis-correcting after.
- Net: the existing `pauseSession`/`resumeSession` already do 90% of this for WebRTC; the new work is (a) the watcher, (b) the `adActive` flag threaded into the subtitle-first driver + `#onSeek` + the Standard corrector predicate, (c) the "ad-wait" overlay state on the pause.

### 4. Unify the pause concept (the clean slice-4 seam)

Introduce one **`effectivePaused = userPaused || adActive`** notion (a getter on `SessionManager`). Today the driver checks `sm.userPaused` and the corrector checks `sm.videoPaused`; converging both on `effectivePaused` means ad-pause and user-pause share one quiescence path and can't fight each other (e.g. user pauses *during* an ad, or an ad starts while user-paused). Keep `userPaused`/`adActive` as the distinct *sources* so resume only un-pauses when BOTH are clear. This is the single load-bearing invariant to lock in slice-4's lifecycle contract.

### 5. Keep the START gate, simplify it to reuse the watcher

The existing `startSession` ad-gate (`index.ts:321-368`) can stay, but ideally it becomes "if `adWatcher.isAdActive()` at start, hold in `ad-wait` until `onAdEnd`" — one code path for start-ad and mid-ad, no duplicate poll loop.

### Why race-free
- The MutationObserver fires on the same DOM mutation that starts the ad → the pause flag is set before/at the ad's first frame, not one poll later.
- All state transitions funnel through `pauseSession`/`resumeSession`, which are already idempotent and token/`pageToken`-guarded.
- The `pageToken` stale-guard and per-session `AbortController` are untouched (the watcher is per-session, stopped in `stopSession` exactly like `nav`).
- One `effectivePaused` source of truth removes the user-pause-vs-ad-pause race entirely.

---

## Files to change

- `extension/src/content/ad-watcher.ts` — **NEW.** MutationObserver-on-`#movie_player`-class + poll backstop; emits `onAdStart`/`onAdEnd` once per edge.
- `extension/src/content/index.ts` — construct/start `adWatcher` in `startSession`, stop it in `stopSession` (parallel to `nav`); add `#enterAdPause`/`#exitAdPause`; have them call `pauseSession`/`resumeSession` + set `ad-wait` overlay state. Optionally fold the Start ad-gate into the watcher.
- `extension/src/content/pause-controller.ts` — accept an "ad" reason so the overlay shows `ad-wait` (not `paused`) and resume re-anchors subtitle-first against content time; ensure the Standard corrector is quiesced (already partially done at line 35).
- `extension/src/content/session-manager.ts` — add `adActive` + `effectivePaused` getter (alongside `userPaused`/`videoPaused`/`_systemPaused`).
- `extension/src/content/pipelines/subtitle-first-pipeline.ts` — gate `#playbackTick` on `effectivePaused` (line 783) and make `#onSeek` a no-op while `adActive`; clean single re-anchor on ad-end.
- `extension/src/lib/dub-playback-sync.ts` — the `isUserPaused` predicate must include `adActive` (or quiesce via pause path).
- `extension/src/shared/platform-ports.ts` — add optional `getAdSignalTarget?(): Element | null` to `PlatformAdapter`.
- `extension/src/platforms/youtube/adapter.ts` + `ad-state.ts` — implement `getAdSignalTarget()` → `#movie_player`; keep `isAdPlaying()` poll fallback. (`shouldIgnorePlaybackEvent` can be retired once the watcher owns ad pauses, or kept as belt-and-suspenders — see open question.)
- `extension/src/content/auto-next.ts` — `restart()` must (re)arm the ad watcher and not assume no ad is in progress (an ad can run on the *next* autoplay video).

---

## Risks

- **YouTube ad-markup churn:** `ad-showing`/`ad-interrupting` can change ([adblockplus blog]). Mitigate with the poll backstop + keep the class list in one place (`ad-state.ts`). Consider also observing the `ytp-ad-player-overlay` presence as a secondary signal.
- **Double-pause / flapping:** ad classes can toggle rapidly at boundaries. The watcher MUST edge-detect (`#adActive` boolean, emit once) or `pauseSession`/`resumeSession` will thrash. They are idempotent, but the overlay would flicker.
- **User pauses during an ad (and vice-versa):** the `effectivePaused = userPaused || adActive` design handles it, but resume logic must only un-pause when BOTH are clear — verify against the session-limit timer freeze/thaw (`pauseSession` calls `sm.pauseSessionTimer()`).
- **MutationObserver lifecycle:** must be disconnected in `stopSession`/unload or it leaks across SPA navigations (same discipline as `NavigationWatcher.#ytNavListener`).
- **Subtitle-first re-anchor on ad-end:** the content `currentTime` after an ad should equal the pre-ad time, but verify YouTube doesn't nudge it; the single clean `#onSeek`-style re-anchor must run exactly once, post-ad, against content time.
- **forceWebRtcStandard / live (no-CC) path:** `shouldIgnoreSourcePlaybackEvent`/`isLive` interplay — confirm ad pause is desired on live no-CC dub (probably yes: stop translating the ad). Low risk but exercise it.
- **`prevSession` during handover:** an ad arriving mid-handover (lang/voice swap rebuild) — make sure the watcher's pause targets the *current* session, not a torn-down one (guard on `sm.session`, which `pauseSession` already does).

---

## Open questions

1. **Retire `shouldIgnorePlaybackEvent` or keep it?** Once the AdWatcher owns ad pauses via `pauseSession`, the suppress-on-pause guard becomes redundant and could even fight the new path (it returns early before `pauseSession`). Recommend: **remove the early-return in `onPause`/`onPlay`** and let the watcher's `adActive` flag be the single source — but the user-pause `onPause` must still distinguish "user paused" from "ad paused" (if `adActive` is already true, the video's `pause` event is the ad → ignore for *user*-pause accounting but the dub is already ad-paused). Needs a small truth-table in slice-4.
2. **Should an ad pause freeze the 60-min session-limit timer?** `pauseSession` calls `sm.pauseSessionTimer()`. Ads probably *should* freeze it (user isn't getting dub value during the ad) — but confirm with product. (Mirrors the existing user-pause behavior, so reusing `pauseSession` gives this for free.)
3. **Realtime: pause vs. let-tail-drain?** When an ad starts mid-utterance, do we cut the dub instantly (disable tracks now) or let the current sentence ring out (~600ms drain, like the handover/end path `rtc-handover.ts`)? Instant is cleaner for "translate the ad" prevention; a short drain is smoother audibly. Recommend instant track-disable + keep `remoteAudio` element so the already-buffered tail finishes, then pause.
4. **Generic/Coursera/Udemy ads?** None today; do we need any ad abstraction beyond YouTube now, or YAGNI until a platform with ads ships? (Lean YAGNI — `getAdSignalTarget` returning null is enough.)
5. **Does the LIVE auto-next bug (the parent task's "[nav] not firing") interact here?** If `bindCommonVideoListeners`/`nav` aren't firing, the ad watcher (same wiring pattern) could share the root cause — worth confirming the listeners are actually bound on the current session before building on them.

---

## Sources

- [vidstack/player Discussion #1466 — detect YouTube ad](https://github.com/vidstack/player/discussions/1466)
- [DEV / js_bits_bill — Ad-Free YouTube With a Custom Player](https://dev.to/js_bits_bill/ad-free-youtube-with-a-custom-player-3e7h)
- [Adblock Plus blog — What's Happening with YouTube Ads](https://blog.adblockplus.org/blog/whats-happening-with-youtube-ads)
- [Medium / Uri Seroussi — Chrome Extension to Skip YouTube Ads](https://medium.com/@uriser/lets-demystify-chrome-extensions-my-first-extension-to-skip-video-ads-239dbf206942)
