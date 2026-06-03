# Research: Pause/Resume A/V Sync — "video races ahead of dub on resume"

**Slice:** Pause/Resume A/V sync  
**Date:** 2026-06-02  
**Symptom:** On RESUME after pause, "chưa thấy tiếng đến mà video đã chạy trước" — the dubbed audio
has not yet arrived but the video has already started playing. Video races ahead of the dub.

---

## 1. Resume flow traced end-to-end

### Entry point
The source `<video>` fires a `play` DOM event → `bindSourceVideoPlayback` listener in
`content/index.ts:250–255` → calls `resumeSession(app)` in `content/pause-controller.ts:54`.

### `resumeSession` (pause-controller.ts:54–101)

```
resumeSession(app)
  ├── if connectionLost && WebRTC  → continueOnNewVideo (peer rebuild path)
  ├── sm.userPaused = false                        ← cleared immediately
  ├── if WebRTC
  │   ├── syncSourcePauseState(sm, sess, false)    ← re-enables tracks + remoteAudio.play()
  │   └── if pipeline === "standard"
  │       ├── standardDubSync?.snapPlaybackStart() ← re-anchor drift sync
  │       └── standardDubSync?.start()             ← restart 500ms poll
  └── (subtitle-first) — comment: "driver's next 250ms tick resumes naturally — no action needed"
```

**The video is NOT held back here.** `resumeSession` fires because the `play` event has
already fired — meaning `video.play()` has already been called and granted. There is no
gate that waits for dub audio to be ready before allowing the video to proceed.

---

## 2. The race condition — precise description

### Standard WebRTC (remoteAudio, `dub-playback-sync.ts`)

`resumeSession` calls `syncSourcePauseState(sm, sess, false)` which in
`rtc-media-sync.ts:46` does:

```typescript
else void session.remoteAudio.play().catch(() => {});
```

This fires `remoteAudio.play()` concurrently with the video that is already running.
The dub `<audio>` element's MediaStream buffer had been paused. After a long pause, the
server's WebRTC media-gate stream may have drained or the server-side buffer window may
need to warm up. The `remoteAudio.play()` returns a Promise that may take dozens to
hundreds of milliseconds to produce audible output, but the video is already running.

Additionally, `syncSourcePauseState` also calls `ctx.resume()` on the AudioContext which
was suspended — `ctx.resume()` is asynchronous (returns a Promise, not awaited here:
`void ctx.resume()`). During the time the AudioContext is resuming (can take 10–50ms+ on
some browsers), no audio flows through the WebAudio graph, so even if `remoteAudio` is
playing, the output gain is silent until the context is fully running.

Then `standardDubSync?.snapPlaybackStart()` / `.start()` are called. `snapPlaybackStart`
nulls both anchors:

```typescript
// dub-playback-sync.ts:137
snapPlaybackStart(): void {
  videoAnchor = null;
  dubAnchor = null;
  ...
}
```

The very first `tick()` after start checks:

```typescript
// dub-playback-sync.ts:77
if (vAnchor == null || dAnchor == null) {
  if (dub.currentTime < 0.05 || opts.video.paused) return; // ← nothing happens
  vAnchor = opts.video.currentTime;
  dAnchor = dub.currentTime;
  ...
  return;  // ← just captures anchors, does not correct
}
```

After resume, `dub.currentTime` can be 0 or near-zero if the `<audio>` element was paused
and its position reset (MediaStream sources do not maintain a meaningful `currentTime` when
paused). This means the anchor snapshot in the first tick captures incorrect values — the
sync engine then computes the wrong `ahead` delta, potentially in a large positive direction
(video is far "ahead" of the dub), triggering a slow/hard throttle on the video, or in a
large negative direction if `dub.currentTime` is stale.

**Root race: video.play() fires → video starts immediately → `remoteAudio.play()` + 
`ctx.resume()` are async and complete later → video is already N seconds ahead before
the first dub sample arrives.**

### Realtime WebRTC

The same `syncSourcePauseState` is called:

```typescript
// pause-controller.ts:88
syncSourcePauseState(app.sm, sess, false);
```

For Realtime (no `standardDubSync`), `remoteAudio.play()` is called but there is
**no gate at all** — no `waitForFirstDub`, no `alignRealtimeVodBeforePlay`, no micro-pause.
The video is already playing before the first translated audio byte arrives from the server.

The server `media-resume` POST is fire-and-forget (`void notifyServerMediaGate(...)`). The
server needs to process this POST and re-open the media gate before it resumes sending RTP
audio. The round-trip latency (client → server → server resumes sending → audio arrives
back at client) is typically 50–300ms minimum. During that window the video runs ahead
uncorrected.

For Realtime VOD at *initial* start, `alignRealtimeVodBeforePlay` is called (waits up to 2s
for `remoteAudio` to appear, plus `REALTIME_VOD_PLAY_ALIGN_MS=80ms`). **No equivalent
realign gate exists on resume.**

### Subtitle-first (Standard VOD)

`pauseSession` calls `app.standardDubSync?.stop()` (pause-controller.ts:36).  
`resumeSession` does NOT call anything on subtitle-first (pause-controller.ts:95 comment:
"subtitle-first: the driver's next 250ms tick resumes naturally — no action needed").

The subtitle-first dub does NOT use `remoteAudio` at all — it uses `AudioBufferSourceNode`
scheduled via WebAudio (subtitle-first-pipeline.ts:664). The `_systemPaused` mechanism
holds the **video** paused while waiting for a cue buffer at *initial scheduling*, but on
a user-resume there is no such hold. The next `#playbackTick` fires within 250ms and plays
whatever cue is due.

On a long pause, the `renderCursor` has already been advanced by the rolling renderer. The
next cue's `_buffer` is very likely already decoded. So subtitle-first is the **least
affected** tier — the 250ms latency is bounded and the audio graph never drains. However
if the user paused on a cue boundary and seeks slightly, `#sentenceDueAt` may need to pick
up mid-gap, which is fine.

**For subtitle-first there is no video-hold-until-buffer-ready on resume.** The video
resumes immediately on user play and the 250ms tick catches up. This is acceptable for most
cases since buffers are preloaded, but for a pause right before an un-buffered cue (e.g.
pause near a live-translated sentence gap) the video will start before the dub arrives.

---

## 3. Clock source / sync scheduling model

### Standard WebRTC (dub-playback-sync)

The sync engine is **relative anchor** based, not wall-clock:

```typescript
// dub-playback-sync.ts:37
computeVideoAheadSec(videoCurrentSec, dubCurrentSec, videoAnchorSec, dubAnchorSec):
  expectedVideo = videoAnchorSec + (dubCurrentSec - dubAnchorSec)
  return videoCurrentSec - expectedVideo
```

Clock source = `video.currentTime` vs `dub.currentTime`. Both are element clocks. The
anchor pair is captured once and the drift is computed relative to that snapshot.

After `snapPlaybackStart()` on resume, anchors are null. The first tick that sees
`dub.currentTime > 0.05` AND `!video.paused` re-anchors. But if `dub.currentTime` is 0
or near-0 (fresh MediaStream resume), the anchor captures (video: e.g. 1234.5s, dub: 0.01s)
giving an inflated `expectedVideo` and a large negative `ahead` → catchup mode → video
speeds up. This is the opposite of the problem but creates sync oscillation. If instead
`dub.currentTime` reflects the stream position correctly (e.g. 1230.0s), re-anchoring is
fine but video may already be 1–3s ahead before the tick fires.

**The sync engine has no concept of "buffer not yet ready" — it only measures drift after
both clocks are ticking.**

### Subtitle-first

Clock source = `video.currentTime` only. Each cue has a `.start` time in video seconds.
The playback tick decides if `cue.start <= video.currentTime + 0.15` (SUBFIRST_DUE_AHEAD_SEC).
No dub audio clock — the dub is triggered by the video clock, not the other way around.

---

## 4. Hold-video-until-first-chunk-ready mechanisms

### At initial session start — Standard WebRTC (index.ts:465–496)

```typescript
// index.ts:468–476
this.beginStandardDubSync(video);
overlay.setStatusText("Preparing dub");
await this.standardDubSync!.waitForFirstDub();  // polls dub.currentTime > 0.04
if (token !== sm.pageToken) ...
const dub = sm.session?.remoteAudio;
if (dub) dub.pause();                           // ← ensures dub is paused at anchor
```

Then at play time (index.ts:492–496):
```typescript
await video.play();
this.standardDubSync.snapPlaybackStart();
this.standardDubSync.start();
void dub.play();
```

So `video.play()` fires BEFORE `dub.play()`. The anchor snapshot happens at the same tick
as video starts (anchors are reset by `snapPlaybackStart` immediately before play). This
means the first tick sees correct anchors within 500ms. **This is the correct pattern.**

### At initial session start — Realtime VOD (index.ts:482–489)

```typescript
await alignRealtimeVodBeforePlay(() => sm.session?.remoteAudio ?? null);
// waits up to 2s for remoteAudio to appear + 80ms settle
await video.play();
```

**This gate exists at start but NOT on resume.**

### At initial session start — Subtitle-first (subtitle-first-pipeline.ts:196–257)

The pipeline awaits `#renderBatch` for `SUBFIRST_PREBUFFER_COUNT=3` sentences before
`video.play()`. So 3 cues are decoded before the video starts. The `#playbackTick` fires
immediately after `video.play()`. The `_systemPaused` micro-pause mechanism is for
*mid-session* starvation, not for initial start.

### ON RESUME — all tiers

**None.** There is no buffer-readiness gate before the video resumes. The video fires
the `play` event (because the browser allowed it to play), `resumeSession` is called
reactively, and the dub is simply unblocked asynchronously.

---

## 5. Current micro-pause / buffering-aware logic and why it fails on resume

The `_systemPaused` + `#enterSystemPause` mechanism in subtitle-first-pipeline.ts only
runs inside `#playbackTick` as a *forward* starvation check (step 1 of the tick):

- It is triggered when a due cue has no `_buffer` yet and the renderer is still working.
- It pauses the video **after the video is already running**, not proactively on resume.

For a user resume (as opposed to a system starvation during normal playback), the mechanism
is not invoked because:
1. `pauseSession` clears `app.sm.userPaused = true` (pause-controller.ts:27)
2. On resume, `resumeSession` clears `sm.userPaused = false` (pause-controller.ts:83) —
   this happens in reaction to the `play` event, meaning the video is already playing
3. The next `#playbackTick` tick checks `sm.userPaused` first (step 2, line 613),
   and since it is `false`, proceeds normally
4. The `_systemPaused` check in step 1 only re-gates the video if a due cue has no
   `_buffer` — but on resume the rolling renderer has been running during the pause
   (subtitle-first-pipeline.ts:772: `if (sm.userPaused ... ) continue` — rolling renderer
   idles during user pause), so buffers that were pre-loaded before the pause are still
   there; the *next* upcoming cue that was not pre-loaded before the pause may stall and
   trigger a micro-pause, but only after the video has been running for 250ms+ already.

**The micro-pause mechanism thus provides no protection for the first 0–250ms window
on resume (the inter-tick gap), nor for the WebRTC tiers at all.**

---

## 6. Summary of race conditions, by tier

| Tier | Race condition | Severity |
|---|---|---|
| **Realtime WebRTC** | `remoteAudio.play()` + `ctx.resume()` both async, no gate. Server `media-resume` POST round-trip adds 50–300ms of silence. Video runs ahead by RT latency + network round-trip. No corrective mechanism. | High |
| **Standard WebRTC** | Same as Realtime for the first ~500ms (before first `tick()`). `snapPlaybackStart` re-anchors with potentially zero `dub.currentTime` → wrong initial drift → sync oscillation. No hold-video gate. | High |
| **Subtitle-first** | 250ms max latency (inter-tick gap). Rolling renderer idles during pause so a cue near the resume boundary may lack a buffer and trigger micro-pause ~250ms late. Not the reported "video races ahead" symptom but same family. | Low–Medium |

---

## 7. Concrete fixes

### Fix A — Standard WebRTC: hold video until dub buffer is ready on resume
**File: `src/content/pause-controller.ts`, `resumeSession` function (line 85–100)**

On resume, before allowing the video to play, gate on the dub being ready.
The existing `standardDubSync.waitForFirstDub()` (polls `dub.currentTime > 0.04`) is
the correct primitive. On resume:

1. `sm.userPaused = false` (no change)
2. Call `syncSourcePauseState(sm, sess, false)` to re-enable tracks + call `remoteAudio.play()`
   and `ctx.resume()` — but do NOT yet call `video.play()`.
3. **New:** call `video.pause()` first (it may already be paused — no-op if so), then
   `await standardDubSync.waitForFirstDub(timeoutMs = 5000)`.
4. Only after the gate: `await video.play()`, `snapPlaybackStart()`, `start()`.

This mirrors exactly how initial session start works in `index.ts:468–496`.

However: `resumeSession` currently fires **reactively** from the `play` DOM event —
the video is already running when it's called. To hold the video, the approach must be:
- Register a `waitingForDub` flag that blocks the `onPlay` callback from calling
  `resumeSession` until the dub is ready, OR
- Use `video.pause()` inside `resumeSession` and re-trigger `video.play()` only after the
  gate passes — but this would re-fire the `play` event creating a loop.

**Better pattern: proactive resume with video hold.**

In `resumeSession`:
1. Do NOT wait for the `play` event to fire `resumeSession`. Instead, intercept the
   `play` event and:
   - If `sm.userPaused` and WebRTC standard: immediately `event.preventDefault()` or
     call `video.pause()` synchronously (before the browser starts decoding frames),
     set a flag `sm.resumePending = true`, then do the async dub-readiness check.
   - After gate passes, call `video.play()` explicitly and clear the flag.

Or more simply:

```typescript
// In resumeSession, Standard WebRTC path:
if (sess.pipeline === "standard" && this.standardDubSync) {
  // Re-enable the dub tracks so data starts flowing
  syncSourcePauseState(sm, sess, false);
  // Hold the video while the dub warms up
  if (!video.paused) {
    try { video.pause(); } catch {}
  }
  sm.userPaused = false;
  // snapPlaybackStart so dub.currentTime is measured from the right origin
  this.standardDubSync.snapPlaybackStart();
  // Wait for first dub chunk (up to 5s, then proceed anyway)
  await this.standardDubSync.waitForFirstDub(5000);
  // Now re-anchor and start video
  this.standardDubSync.snapPlaybackStart(); // re-snap after dub has currentTime > 0
  this.standardDubSync.start();
  try { await video.play(); } catch {}
}
```

Note: `pauseSession` must set a marker (e.g. `s._pausedForResume = true` on the
`SubtitleFirstSession`-equivalent) so the `pause` DOM event fired by the internal
`video.pause()` call does NOT re-trigger `pauseSession`. The existing `_systemPaused`
pattern is the right model.

### Fix B — Realtime WebRTC: re-align before resume play
**File: `src/content/pause-controller.ts`, `resumeSession`, Realtime branch**

The existing `alignRealtimeVodBeforePlay` used at initial start is the right primitive.
On resume:

```typescript
if (isWebRtcSession(sess) && sess.pipeline === "realtime") {
  syncSourcePauseState(sm, sess, false); // enables tracks + remoteAudio.play()
  sm.userPaused = false;
  // Hold video until remoteAudio is receiving data again
  await alignRealtimeVodBeforePlay(() => sm.session?.remoteAudio ?? null, 200);
  // At this point the dub is flowing; play video
  if (video.paused) {
    try { await video.play(); } catch {}
  }
}
```

A 200ms align is shorter than the initial 80ms + 2s poll because ICE is still live;
the server just needs to see the `media-resume` POST and re-open the gate. The
`notifyServerMediaGate` round-trip should be awaited (not fire-and-forget) so the video
hold accounts for actual server latency:

```typescript
// In resumeSession:
await notifyServerMediaGate(sm.apiBase, sess.rtcSessionId, sess.apiBearer, false);
// then alignRealtimeVodBeforePlay
```

**Cross-slice concern:** `syncSourcePauseState` currently does `void notifyServerMediaGate`
(fire-and-forget). This should be changed to awaitable for the resume path, or a separate
awaitable helper should be created for the resume gate.

### Fix C — Standard WebRTC: fix `dub.currentTime` re-anchor on resume
**File: `src/lib/dub-playback-sync.ts`, `tick()` (line 77–86)**

The anchor-capture guard `if (dub.currentTime < 0.05 ...) return` is designed for initial
start where `dub.currentTime` starts at 0. After resume, `dub.currentTime` on a
MediaStream element depends on browser behaviour — it may be 0, or it may reflect the
stream position. The guard should be:

```typescript
// Instead of: if (dub.currentTime < 0.05 || opts.video.paused) return;
// Use a time-based gate: wait up to 2 ticks (1000ms) for dub to produce audio
if (opts.video.paused) return;
if (dub.currentTime < 0.05) {
  // dub hasn't started yet — skip this tick (don't anchor to zero)
  return;
}
```

This is already correct but relies on Fix A holding the video long enough for
`dub.currentTime > 0.05` to be true by the time the anchor is captured.

Without Fix A, `dub.currentTime` is often `< 0.05` for multiple ticks after resume,
so the anchor is never captured during the critical "is video ahead?" window.

### Fix D — `pauseSession` marker to prevent re-entrant pause on internal `video.pause()`
**File: `src/content/session-manager.ts` or `pause-controller.ts`**

Add a `sm.systemResuming = true` flag (or reuse the SF-style `_systemPaused` pattern)
that the `onPause` listener in `index.ts:239–249` checks before calling `pauseSession`:

```typescript
// index.ts onPause handler:
onPause: () => {
  if (shouldIgnoreSourcePlaybackEvent(adapter)) return;
  if (sm.systemResuming) return;        // ← guard for resume-hold video.pause()
  const sess = this.sm.session;
  if (!sess) return;
  if (isSubtitleFirstSession(sess) && sess._systemPaused) return;
  pauseSession(this);
},
```

### Fix E — Subtitle-first: proactive micro-pause on resume if next cue unbuffered
**File: `src/content/pipelines/subtitle-first-pipeline.ts`, `#playbackTick`**

Currently, the micro-pause (`#enterSystemPause`) is triggered by the tick loop only after
a due cue with no buffer is found. On resume, the first tick fires 0–250ms after play
starts. Add a proactive check immediately upon resume:

In `resumeSession` (pause-controller.ts), for subtitle-first sessions:
```typescript
if (isSubtitleFirstSession(sess)) {
  // Proactively check if the next due cue has a buffer; if not, 
  // fire a #playbackTick which will trigger the micro-pause immediately
  app.subtitleFirst.onResumeCheck(sess);
}
```

This avoids the 250ms wait before the interval fires.

---

## 8. Cross-slice concerns

1. **`notifyServerMediaGate` async on resume** — the fire-and-forget pattern in
   `rtc-media-sync.ts:93` (`void notifyServerMediaGate(...)`) means the server may not
   have re-opened the gate when the video is already playing. Fix B requires this to be
   awaited in the resume path. The pause path can remain fire-and-forget.

2. **`dub-playback-sync.ts` `stop()` sets `stopped = true`** (line 156) but there is no
   corresponding `restart()` — `start()` guards on `if (timer != null) return` but does
   NOT reset `stopped`. After `stop()` + `start()`, the tick immediately exits:
   ```typescript
   const tick = (): void => {
     if (stopped || opts.isUserPaused()) return;
   ```
   **This is a bug:** `pauseSession` calls `stop()` (pause-controller.ts:36) setting
   `stopped = true`. Then `resumeSession` calls `snapPlaybackStart()` + `start()` — but
   `start()` creates a new interval, the new tick checks `stopped` which is `true`,
   and immediately returns. **The sync engine is permanently stopped after the first
   pause/resume cycle.**

   **Fix:** `snapPlaybackStart()` or `start()` must reset `stopped = false`. Or `stop()`
   should not set `stopped = true` on a user-pause (only on session teardown). A simple
   fix is adding `stopped = false` at the top of `snapPlaybackStart()`.

   This is likely the root cause of why the sync engine fails to correct drift after
   resume even if the video hold were implemented.

3. **`beginStandardDubSync` in ContentApp** uses `isUserPaused: () => this.sm.videoPaused`
   (index.ts:164) but `pauseSession` sets `sm.userPaused` (not `sm.videoPaused` — that is
   set by `syncSourcePauseState`). For subtitle-first sessions, `syncSourcePauseState` is
   NOT called, so `sm.videoPaused` may lag `sm.userPaused`. However `beginStandardDubSync`
   is only used for WebRTC Standard sessions, so this is a naming confusion rather than
   a functional bug.

4. **AudioContext suspend on pause / resume on resume** — `ctx.suspend()` is called on
   pause, `ctx.resume()` on resume (rtc-media-sync.ts:49–53). Both are async Promises
   that are not awaited. On Firefox and some mobile Chromium builds, `ctx.resume()` can
   take 50–150ms. During this window `tick()` in `dub-playback-sync.ts` reads
   `dub.currentTime` from the audio element, but no audio flows through the graph, so
   the sync measurement is meaningless. Fix: resume ctx before starting the sync loop.

---

## 9. Priority order

1. **[Critical] Bug in `dub-playback-sync.ts`: `stopped` flag not reset on resume.**
   (`src/lib/dub-playback-sync.ts` — `snapPlaybackStart` or `start` must reset `stopped`.)
   This silently disables ALL rate correction after the first pause.

2. **[High] Standard WebRTC: hold video until `dub.currentTime > 0.04` on resume.**
   (`src/content/pause-controller.ts` — `resumeSession`, add `waitForFirstDub` gate.)

3. **[High] Realtime WebRTC: await `notifyServerMediaGate` and align before resume play.**
   (`src/lib/rtc-media-sync.ts` + `src/content/pause-controller.ts`)

4. **[Medium] Subtitle-first: proactive resume tick to check next cue's buffer.**
   (`src/content/pause-controller.ts` + `src/content/pipelines/subtitle-first-pipeline.ts`)

5. **[Low] AudioContext `resume()` not awaited before sync measurement.**
   (`src/lib/rtc-media-sync.ts:53` — `applyVideoPauseToSession`)
