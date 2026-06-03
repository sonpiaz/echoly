# Resume Latency Ledger — smooth-dub wave regression

**Branch:** `wave/smooth-dub`  
**Compared to:** `develop`  
**Investigator:** regress-3 (cross-cutting control-flow + holistic latency)  
**Date:** 2026-06-02

---

## TL;DR verdict

**Yes — the wave's resume gate IS the regression.** The fix for "video runs ahead of dub on resume" (correct diagnosis) was implemented by holding the video `video.pause()` until dub audio is confirmed flowing. This is the right shape of fix, but the implementation adds **serial blocking awaits totalling up to ~3.5 s in the worst case** on the critical path before the user's video plays again. The original code had **zero awaits on resume** — it was fully synchronous and returned in < 1 ms. The regression is the cure being worse than the disease.

---

## 1. BEFORE → AFTER: user-pause and user-resume control flow

### BEFORE (develop) — resumeSession

`resumeSession` was a **synchronous void function**. On the `onPlay` event:

```
onPlay fires
  → resumeSession(this)          // sync, no await
      → app.sm.userPaused = false
      → syncSourcePauseState(sm, sess, false)   // sync void
          → applyVideoPauseToSession(...)         // sync void
              → track.enabled = true              // sync
              → remoteAudio.play()                // fire-and-forget Promise
              → ctx.resume()                      // fire-and-forget Promise
          → notifyServerMediaGate(...)            // fire-and-forget Promise
      → standardDubSync.snapPlaybackStart()      // sync
      → standardDubSync.start()                  // sync
      → overlay.setOverlayState("live")          // sync
      → resumeSessionTimer()                     // sync
TOTAL blocking time: < 1 ms (all I/O is fire-and-forget)
```

The video was never re-paused. The user's press-play event caused the browser to resume playback immediately. The dub audio re-enabled tracks and re-played asynchronously in the background. The consequence: the first ~200-500 ms of video could play before the dub arrived (the original complaint), but the user felt no added delay on resume.

### AFTER (wave/smooth-dub) — resumeSession (Standard-WebRTC path)

`resumeSession` is now **async**. On the `onPlay` event the browser's default play-resume is immediately followed by `video.pause()` re-pausing the video, then a chain of awaits:

```
onPlay fires
  → void resumeSession(this)          // async, promise voided
      → app.sm.userPaused = false
      → app.sm.systemResuming = true
      → [Standard-WebRTC branch]
          ① await syncSourcePauseState(sm, sess, false)
              → await applyVideoPauseToSession(...)
                  → track.enabled = true              // sync
                  → remoteAudio.play()                // fire-and-forget
                  → await ctx.resume() with MEDIA_GATE_TIMEOUT_MS race
                    WORST CASE: 1 500 ms (if ctx stuck, hits timeout)
                    TYPICAL: ~5–50 ms (resumes quickly)
              → await fetch(media-resume POST)  with AbortSignal.timeout(MEDIA_GATE_TIMEOUT_MS)
                    WORST CASE: 1 500 ms (network/timeout)
                    TYPICAL: ~50–300 ms RTT to server
          ② video.pause()   ← re-pauses the video the user just resumed
                    OVERHEAD: ~0 ms (sync DOM call, but causes a second onPause event
                               which is now guarded by systemResuming — correct)
          ③ standardDubSync.snapPlaybackStart()   // sync, < 1 ms
          ④ await standardDubSync.waitForFirstDub(RESUME_GATE_MS)
                    WORST CASE: 2 500 ms (full gate timeout; resolves false → soft-fail)
                    TYPICAL: time until remoteAudio.currentTime > 0.04
                    NOTE: see §3 for the structural blocker analysis
          ⑤ standardDubSync.snapPlaybackStart()   // sync
          ⑥ standardDubSync.start()               // sync
          ⑦ await video.play()                    // ~0–5 ms, may reject
          ⑧ remoteAudio.play()                    // fire-and-forget (AFTER video released)
      → finally: systemResuming = false
      → overlay.setOverlayState("live")
      → resumeSessionTimer()
```

### AFTER (wave/smooth-dub) — resumeSession (Realtime path)

```
onPlay fires
  → void resumeSession(this)
      → app.sm.systemResuming = true
      → overlay.setOverlayState("buffering")
      ① await syncSourcePauseState(sm, sess, false)
              → await ctx.resume() [MEDIA_GATE_TIMEOUT_MS = 1 500 ms worst case]
              → await fetch(media-resume POST) [MEDIA_GATE_TIMEOUT_MS = 1 500 ms worst case]
              SEQUENTIAL total worst case: 3 000 ms
      ② video.pause()   ← re-pauses the video
      ③ await setTimeout(Math.min(RESUME_GATE_MS, 400))   ← 400 ms unconditional hold
      ④ await video.play()
      → finally: systemResuming = false
```

### AFTER (wave/smooth-dub) — resumeSession (Subtitle-first path)

```
onPlay fires
  → void resumeSession(this)
      → app.sm.systemResuming = true
      → overlay.setOverlayState("buffering")
      ① app.subtitleFirst.onResumeCheck()   ← synchronous; may call video.pause() internally
         (if next cue not buffered → enterSystemPause → video.pause() → up to MICRO_PAUSE_MAX_MS wait)
      → finally: systemResuming = false
      → overlay.setOverlayState("live")   ← always set after try/finally, even if micro-pause is still active
```

---

## 2. Resume latency ledger

| Step | Old (develop) | New (wave) | Worst-case cost | On critical path? |
|---|---|---|---|---|
| `app.sm.userPaused = false` | sync | sync | 0 ms | N/A |
| `app.sm.systemResuming = true` | absent | sync | 0 ms | N/A |
| `ctx.resume()` (AudioContext) | fire-and-forget | **awaited with 1500ms cap** | 1 500 ms | **YES** (blocks all subsequent steps) |
| Server media-resume POST | fire-and-forget | **awaited with 1500ms cap (sequential after ctx)** | 1 500 ms | **YES** |
| `video.pause()` re-hold | absent | added | 0 ms net (sync) | YES — video is paused waiting for gate |
| `waitForFirstDub(2500)` | absent | **await up to 2500ms** | 2 500 ms | **YES** (Standard only) |
| Unconditional `setTimeout(400)` | absent | added (Realtime path) | 400 ms | **YES** (Realtime only) |
| `standardDubSync.snapPlaybackStart()` × 2 | × 1 (sync) | × 2 (sync) | 0 ms | N/A |
| `standardDubSync.start()` | sync | sync | 0 ms | N/A |
| `video.play()` | N/A (not called) | await | ~0–5 ms | N/A (releases hold) |
| `remoteAudio.play()` | fire-and-forget in applyVideo | deferred: after video.play() | 0 ms blocking | structural issue (see §3) |

**Worst-case serial total (Standard-WebRTC):** ctx.resume(1500) + server POST(1500) + waitForFirstDub(2500) = **5 500 ms**

**Typical total (Standard-WebRTC):** ctx.resume(~10ms) + server POST(~150ms) + waitForFirstDub(~200–500ms) = **~360–660 ms felt delay** after the user presses play before the video moves again.

**Worst-case serial total (Realtime):** ctx.resume(1500) + server POST(1500) + setTimeout(400) = **3 400 ms**

**Old total:** **< 1 ms** (synchronous everywhere, zero awaits on resume path).

---

## 3. Blocking culprits: what is actually on the critical path

### Culprit 1: `syncSourcePauseState` is now fully serial (ctx + POST, both awaited)

```diff
-  syncSourcePauseState(app.sm, sess, false);   // sync, returns void immediately
+  await syncSourcePauseState(app.sm, sess, false);  // awaits ctx.resume() THEN server POST
```

In the old code, `ctx.resume()` and the server POST were both fire-and-forget. In the new code they are serial awaits before `video.pause()` even happens. The user has pressed play; the video may have already started moving (browser default); then `video.pause()` is called — but only after up to 1500 + 1500 = 3000 ms have elapsed. This is a jank-inducing sequence even before the `waitForFirstDub` gate.

The `ctx.resume()` await is partially justified (it was the audio-ctx-not-ready bug), but it should run in parallel with the POST, not serially. And the POST does not need to complete before `video.pause()`.

### Culprit 2: `waitForFirstDub(RESUME_GATE_MS=2500)` — may never resolve early

`waitForFirstDub` polls `remoteAudio.currentTime > 0.04` every 80 ms. For `remoteAudio.currentTime` to advance the element must be **playing** and audio **must be flowing from the server**. 

The `remoteAudio.play()` call happens inside `applyVideoPauseToSession` (line 50 of `rtc-media-sync.ts`) which is part of `syncSourcePauseState`. So `remoteAudio` IS playing when the gate starts. However: the server media-gate must reopen (the POST must complete AND the server must re-enable the media path) before audio flows to the element. Since `syncSourcePauseState` awaits the POST sequentially BEFORE `waitForFirstDub` starts, the gate begins with the server already open — that part is sequenced correctly.

The real worst case is network-degraded: if the POST takes 1500ms (timeout), `waitForFirstDub` starts 1500ms late, then waits another up to 2500ms. Total: 4000ms before the video plays.

Even in the typical case: ctx.resume(~10ms) + POST(~150ms) + waitForFirstDub(~300ms settling) = **~460ms** where the user sees the video frozen in "buffering" after pressing play. That is perceptible and frustrating — it feels like the app is broken.

### Culprit 3: Realtime unconditional 400ms setTimeout

```typescript
await new Promise<void>((resolve) =>
  setTimeout(resolve, Math.min(RESUME_GATE_MS, 400)),
);
```

This is a fixed 400ms sleep after the video is already paused again. There is no signal being awaited — it is pure dead time. In the original code Realtime resume was instantaneous (fire-and-forget tracks + AudioContext). Adding a mandatory 400ms hold for every Realtime resume is aggressive over-correction.

---

## 4. Is the auto-next path contaminating user-resume?

**No.** The `continueOnNewVideo` path is guarded by `if (app.sm.connectionLost && isWebRtcSession(sess))` and returns early from `resumeSession` before entering the gate logic. The `continueOnNewVideo` call in `webrtc-pipeline.ts` (navigation-driven auto-next) is a completely separate code path invoked by `NavigationWatcher`, not by `resumeSession`. The subtitle-first `restartOnNewVideo` path is also separate. The user-resume path through `onPlay → resumeSession` does not accidentally exercise auto-next logic.

---

## 5. Original complaint vs wave's fix: was it over-corrected?

**Original complaint:** After pause/resume, the video plays for ~200–500ms before the dub is heard. The video "runs ahead" of the dub at the moment of resume. This is a sync-drift problem on resume.

**Wave's fix:** Hold the video with `video.pause()` until `remoteAudio.currentTime > 0.04` (i.e., actual dub audio is confirmed flowing), then release. This is conceptually correct — it eliminates the "video ahead of dub" gap by making them start together.

**Over-correction:** Yes, brutally. The fix serializes three expensive async operations (AudioContext, server round-trip, dub-flow poll) all before the user's video plays again. The pre-wave code had 0 ms of hold; the post-wave code has 360–5500 ms of hold. The user now experiences a "frozen video" pause on every resume, which is a more visible regression than the original "slightly misaligned audio at start of resume."

The original complaint was about a ~200–500ms drift window. The cure imposes a mandatory ~360ms–5.5s freeze before the video moves. On a fast connection and healthy state, the typical case (~460ms) is already more annoying than the original bug. On a slow or degraded connection (server POST near timeout), it is catastrophic.

---

## 6. Conceptual shape of the right fix (no code)

The correct architecture keeps the original "video plays immediately" property while closing the dub-sync gap:

**A. Do NOT hold the video before the dub.** The original design was right here. Release the video immediately on the `onPlay` event (no re-`video.pause()`). The user expects their play gesture to work instantly.

**B. Fire `ctx.resume()` and the server POST in parallel and fire-and-forget, then** call `standardDubSync.snapPlaybackStart()` + `start()`. The dub-sync engine already handles catch-up rate-ramping; it will re-anchor once both the video and the dub are playing.

**C. Use `waitForFirstDub` only as a soft anchor point, not a video hold.** After `snapPlaybackStart()`, the engine should begin its rate calculation once both `video.currentTime` and `dub.currentTime` have non-trivial values. The existing tick/EMA already does this. No need to gate the video.

**D. The A1 fix (`stopped=false` in `snapPlaybackStart`) is correct and must be kept** — that was a real bug that would have permanently killed the sync engine after the first pause/resume.

**E. Realtime: remove the unconditional 400ms setTimeout entirely.** The server gate POST is already awaited (and bounded). After it returns, emit `video.play()` without additional sleep. If the server is fast, the dub is available immediately; if not, the user hears a tiny gap which is no worse than pre-wave.

**F. Keep `systemResuming` guard** — it correctly prevents the internal `video.pause()` from re-triggering `pauseSession`. If the re-pause approach is abandoned (per A above), `systemResuming` can also be removed, but it is harmless to keep.

**G. Subtitle-first `onResumeCheck` is fine** — it is synchronous and the micro-pause path (`_systemPaused`) already existed on `develop`. The wave's contribution here (proactive tick vs waiting up to 250ms) is a latency improvement, not a regression.

**Summary of conceptual fix:** Strip the `await`s from the video-hold path. Keep `syncSourcePauseState` async for safety but fire it without awaiting. Keep `snapPlaybackStart()` + `start()` on the resume path. Remove `waitForFirstDub` from the resume gate. Let the sync engine's rate-ramp do the work it was designed to do.

---

## Key diff hunks

**The gate addition (pause-controller.ts — Standard-WebRTC path):**
```typescript
// NEW — all three steps serial, video frozen throughout:
await syncSourcePauseState(app.sm, sess, false);   // ①: up to 3000ms
if (!video.paused) { video.pause(); }              // ②: re-pause
await app.standardDubSync.waitForFirstDub(RESUME_GATE_MS);  // ③: up to 2500ms
try { await video.play(); }                        // ④: release
```

**The sync to async promotion (rtc-media-sync.ts):**
```typescript
// OLD: fire-and-forget everywhere
export function syncSourcePauseState(...): void {
  applyVideoPauseToSession(session, paused);          // sync
  void notifyServerMediaGate(...).then(...);           // fire-and-forget
}

// NEW: serial awaits on resume path
export async function syncSourcePauseState(...): Promise<void> {
  await applyVideoPauseToSession(session, paused);     // awaits ctx.resume() [1500ms cap]
  // ...
  await fetch(media-resume URL, { signal });           // awaits POST [1500ms cap, sequential]
}
```

**The unconditional Realtime hold:**
```typescript
// NEW in Realtime branch — pure sleep, no signal:
await new Promise<void>((resolve) =>
  setTimeout(resolve, Math.min(RESUME_GATE_MS, 400)),  // 400ms dead time
);
```
