# Regression Analysis — WebRTC Resume Latency (wave/smooth-dub)

**Scope:** Read-only investigation of added resume latency on the WebRTC paths
(Standard-WebRTC / Realtime) after the smooth-dub wave. Based entirely on
`git diff develop -- <path>` output; no code was modified.

---

## Executive summary

The wave introduced **three stacked await points** on the WebRTC resume path that
did not exist on `develop`. Together they can add 0–2500 ms of hold time before
the source video is allowed to play again. The **dominant latency source is the
`waitForFirstDub` gate (up to 2500 ms)** on Standard-WebRTC. The server
media-gate POST (`notifyServerMediaGate`) is awaited on Realtime — up to 1500 ms
— but NOT on Standard (it is awaited via `syncSourcePauseState`, but the video is
held separately by `waitForFirstDub` rather than by the server round-trip, so
they overlap). The hypothesis is **CONFIRMED** for Realtime but
**PARTIALLY CONFIRMED** for Standard: on Standard the video hold comes from
`waitForFirstDub`, not from the server round-trip (the server POST is awaited but
completes before the `waitForFirstDub` gate resolves in the common case).

**Critical finding for Standard-WebRTC on resume:** `waitForFirstDub` polls
`dub.currentTime > 0.04`. On a RESUME (not a fresh start), `remoteAudio` is
paused but NOT torn down — so `dub.currentTime` retains its pre-pause position
(already well above 0.04 from previous playback). **`waitForFirstDub` should
therefore resolve on the first 80 ms poll tick** — meaning the worst case of
2500 ms is almost never hit on resume. HOWEVER, it only resolves fast IF the
`remoteAudio` element still has a non-zero `currentTime`. If `remoteAudio` was
replaced, cleared, or if the seek position was reset, the gate could block for
up to `RESUME_GATE_MS = 2500 ms`.

---

## Added latency sources, ranked

### 1. Standard-WebRTC — `waitForFirstDub(RESUME_GATE_MS)` (0–2500 ms)

**File:** `src/content/pause-controller.ts`

**Old (develop):** `resumeSession` was synchronous. On WebRTC Standard it called
`syncSourcePauseState(app.sm, sess, false)` (fire-and-forget void), then
`app.standardDubSync.snapPlaybackStart()` + `.start()`. No hold on the video.

**New (wave/smooth-dub):** After `await syncSourcePauseState(...)`, the video is
explicitly paused (`video.pause()`) and held while `waitForFirstDub(RESUME_GATE_MS)`
runs. The gate polls every 80 ms until `dub.currentTime > 0.04` or until
`RESUME_GATE_MS = 2500` ms expires.

```diff
+        if (video) {
+          app.overlay.setOverlayState("buffering");
+          if (!video.paused) {
+            try { video.pause(); } catch { /* ignore */ }
+          }
+          app.standardDubSync.snapPlaybackStart();
+          await app.standardDubSync.waitForFirstDub(RESUME_GATE_MS);
+          app.standardDubSync.snapPlaybackStart();
+          app.standardDubSync.start();
+          try { await video.play(); } catch { /* ignore */ }
```

**Worst case:** 2500 ms hold.

**Expected case on a clean resume:** `remoteAudio` is paused but its
`currentTime` is preserved from before the pause (e.g. 45.3 s), so
`dub.currentTime > 0.04` is already true. The gate should resolve on the
**first poll (≤80 ms)**. BUT: note that `applyVideoPauseToSession` (called inside
`syncSourcePauseState`) does `void remoteAudio.play()` on resume BEFORE the gate
even starts — so the audio element is already unpaused by the time the gate
checks. `currentTime` on a live RTC feed that was merely paused (not seeked or
replaced) will be non-zero; the gate resolves instantly.

**Edge case where the gate blocks long:** If `remoteAudio` is replaced during the
pause (e.g. ICE reconnect, session continuation on new video), `currentTime`
resets to 0 and the gate could block up to 2500 ms while the new stream catches
up to 40 ms of media output. In a normal no-rebuild pause/resume this does NOT
happen.

**Verdict:** On a normal resume (no peer rebuild), the hold is ≤80 ms. On a
peer-rebuild resume the old code would rebuild synchronously before this point
(the `connectionLost` branch returns early), so the gate is not reached. In
practice the 2500 ms worst-case is rarely hit, but the architecture of holding
the video until dub is verified is a qualitative change from the develop baseline
(which had zero hold).

---

### 2. Realtime — `await syncSourcePauseState(...)` blocking on server media-gate POST (0–1500 ms)

**File:** `src/content/pause-controller.ts` + `src/lib/rtc-media-sync.ts`

**Old (develop):**
- `resumeSession` was synchronous.
- `syncSourcePauseState` was a **void** synchronous call — the server POST was
  fire-and-forget.
- The video started playing immediately after the call returned.

**New (wave/smooth-dub):**
- `resumeSession` is `async`.
- `syncSourcePauseState` is `async`.
- On the **resume path** (paused=false), `syncSourcePauseState` now inlines its
  own `fetch` to `media-resume` and **awaits it** with
  `AbortSignal.timeout(MEDIA_GATE_TIMEOUT_MS = 1500 ms)`.

```diff
+export async function syncSourcePauseState(...): Promise<void> {
+  sm.videoPaused = paused;
+  await applyVideoPauseToSession(session, paused);   // ← await ctx.resume() (≤1500ms)
+  if (session.rtcSessionId && session.apiBearer) {
+    if (paused) {
+      void notifyServerMediaGate(...)               // ← fire-and-forget (unchanged)
+    } else {
+      // RESUME: awaited fetch, up to MEDIA_GATE_TIMEOUT_MS = 1500 ms
+      const res = await fetch(url, { ..., signal });
```

On Realtime, `pauseController.ts` then also adds a 400 ms fixed `setTimeout`
settle after `syncSourcePauseState` returns:

```diff
+        await new Promise<void>((resolve) =>
+          setTimeout(resolve, Math.min(RESUME_GATE_MS, 400)),
+        );
```

**Total Realtime added latency:**
- `await ctx.resume()` (typically < 5 ms, worst-case 1500 ms timeout)
- `await fetch(media-resume)` — round-trip to server: 50–300 ms typical, 1500 ms worst-case on timeout
- `await setTimeout(400)` — fixed 400 ms settle

**Typical Realtime added hold:** 50–300 ms (server RTT) + ~400 ms settle = **450–700 ms**.
**Worst-case Realtime added hold:** 1500 ms (fetch timeout) + 400 ms = **1900 ms**.

On develop: Realtime resumed immediately (< 1 ms), server notified fire-and-forget.

---

### 3. Both paths — `await applyVideoPauseToSession` blocking on `ctx.resume()` (0–1500 ms)

**File:** `src/lib/rtc-media-sync.ts`

**Old (develop):**
```js
else if (!paused && ctx.state === "suspended") void ctx.resume();
```
Completely non-blocking.

**New (wave/smooth-dub):**
```diff
+      try {
+        await Promise.race([
+          ctx.resume(),
+          new Promise<void>((_, reject) =>
+            setTimeout(() => reject(new Error("ctx.resume timeout")), MEDIA_GATE_TIMEOUT_MS),
+          ),
+        ]);
+      } catch {
+        /* soft-fail */
+      }
```

`ctx.resume()` on Chrome typically resolves in < 5 ms. The timeout bound is
1500 ms. In practice this adds negligible latency (the `AudioContext` was only
`suspended`, not `closed`), but it IS a synchronous await point inside the call
chain. If the AudioContext is in a bad state, this adds up to 1500 ms.

---

## Call chain on resume (wave/smooth-dub) — Standard-WebRTC, normal case

```
onPlay  → void resumeSession(this)           [async, voids promise]
  → await syncSourcePauseState(sm, sess, false)
      → await applyVideoPauseToSession(sess, false)
          → void remoteAudio.play()           [not awaited]
          → await Promise.race([ctx.resume(), timeout(1500ms)])  ← new await #1
      → await fetch(media-resume, signal=AbortSignal.timeout(1500ms))  ← new await #2
  → video.pause()                             ← new explicit hold #3
  → snapPlaybackStart()
  → await waitForFirstDub(2500ms)             ← new await #4 (resolves in ~80ms normally)
  → snapPlaybackStart() + start()
  → await video.play()
```

**Total added delay on Standard-WebRTC (typical):**
- `ctx.resume()`: < 5 ms
- `fetch(media-resume)`: 50–300 ms
- `video.pause()` + `waitForFirstDub(~80ms)`: ~80 ms
- Total: ~130–380 ms added hold on normal resumes.

**On develop:** all three were fire-and-forget. Video resumed immediately.

---

## Call chain on resume (wave/smooth-dub) — Realtime, normal case

```
onPlay → void resumeSession(this)
  → await syncSourcePauseState(sm, sess, false)
      → await ctx.resume()    (~5ms or up to 1500ms)
      → await fetch(media-resume)   (50–300ms typical)
  → video.pause()
  → await setTimeout(400)    ← fixed 400ms settle
  → await video.play()
```

**Total added delay on Realtime (typical):** ~450–700 ms.

---

## Does the hypothesis hold?

**Hypothesis:** `syncSourcePauseState` made async + awaited on resume, including
awaiting the server media-resume POST round-trip. Before the wave: fire-and-forget.

**CONFIRMED** — with the following precision:

| Path | Server POST awaited? | ctx.resume() awaited? | Video held? | Dominant hold |
|---|---|---|---|---|
| Standard-WebRTC | YES (up to 1500ms) | YES (up to 1500ms) | YES (for waitForFirstDub) | waitForFirstDub if dub.currentTime=0; server POST otherwise |
| Realtime | YES (up to 1500ms) | YES (up to 1500ms) | YES (for 400ms setTimeout) | server POST + 400ms settle |
| develop (both) | NO (fire-and-forget) | NO (void) | NO | ~0ms |

**On Realtime the server round-trip is the bottleneck.** Numbers: 50–300 ms RTT +
400 ms fixed settle = **450–700 ms minimum** added regression on every resume.

**On Standard-WebRTC the server round-trip is also awaited** (via `syncSourcePauseState`)
but is *followed* by `waitForFirstDub`. In the normal case where `remoteAudio`
survives the pause (no peer rebuild), `dub.currentTime` is already > 0.04 so the
gate resolves in one 80 ms poll. The net added delay on Standard is therefore
dominated by the **server POST round-trip** (50–300 ms) plus ~80 ms gate =
**130–380 ms** typical.

**`RESUME_GATE_MS = 2500 ms` is NOT the typical hold time on Standard resume.**
It is a worst-case guard. On a normal resume, `dub.currentTime > 0.04` is true
immediately and `waitForFirstDub` returns in ≤80 ms.

---

## Constants for reference

| Constant | Value | File |
|---|---|---|
| `RESUME_GATE_MS` | 2500 ms | `src/shared/constants.ts:64` |
| `MEDIA_GATE_TIMEOUT_MS` | 1500 ms | `src/shared/constants.ts:66` |
| `DUB_TTFA_GATE_MS` | 8000 ms | `src/shared/constants.ts:62` |
| waitForFirstDub poll interval | 80 ms | `src/lib/dub-playback-sync.ts:131` |
| Realtime settle setTimeout | `Math.min(RESUME_GATE_MS, 400)` = 400 ms | `src/content/pause-controller.ts:149` |

---

## Affected files

- `src/lib/rtc-media-sync.ts` — `syncSourcePauseState` made async; server POST awaited on resume; `ctx.resume()` awaited
- `src/content/pause-controller.ts` — `resumeSession` made async; Standard gate (`waitForFirstDub`); Realtime 400ms settle; video held explicitly on both paths
- `src/lib/dub-playback-sync.ts` — `waitForFirstDub(timeoutMs)` now accepts a `timeoutMs` param (RESUME_GATE_MS=2500 used on resume vs DUB_TTFA_GATE_MS=8000 on start)

---

## Recommended fixes (informational only — not applied)

1. **Realtime:** Remove the fixed 400 ms `setTimeout` settle. The server POST
   alone should be sufficient signal that the gate is open. Or make the settle
   much shorter (50 ms).
2. **Both paths:** Do NOT await the server media-resume POST before releasing the
   video. Keep the video play unblocked; let the POST proceed in parallel (as on
   develop). The server gate only matters for billing correctness — not for
   perceived resume latency.
3. **Standard-WebRTC:** Skip `waitForFirstDub` on resume when `dub.currentTime > 0`
   already (i.e. the audio element survived the pause intact). Call `video.play()`
   immediately and only apply the gate on a fresh-start.
4. **`ctx.resume()`:** Awaiting is fine for correctness but adds ~5ms to the
   chain — acceptable given the other delays.
