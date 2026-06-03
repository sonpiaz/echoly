# Regression: subtitle-first pause→resume latency (smooth-dub wave)

**Branch under investigation:** `wave/smooth-dub` (uncommitted changes on top of `develop`)
**Baseline:** `develop` tip (commit `50fdbfe`)
**Path:** Standard subtitle-first (YouTube VOD caption-dub)

---

## Summary verdict

Yes — the smooth-dub wave made subtitle-first resume **measurably slower** in the common case. There are **three compounding sources** of added latency, ranked below.

---

## Source 1 — `onResumeCheck()` enters `#enterSystemPause` on resume (PRIMARY culprit)

**Impact: high. Latency added: up to `SUBFIRST_BUFFER_WAIT_MAX_MS` = 8 000 ms in the worst case; in the typical case, the duration of one TTS round-trip for the next cue.**

### OLD behavior (develop)

`resumeSession` for subtitle-first was literally a no-op body:

```diff
-  // subtitle-first: the driver's next 250ms tick resumes naturally — no action needed.
```

`sm.userPaused` was cleared, overlay flipped to "live", done. The 250ms `#playbackTick` interval, which was already running, saw `sm.userPaused === false` on its next tick and started the next cue — delay ≤ 250 ms.

### NEW behavior (wave)

`resumeSession` (now async) calls `app.subtitleFirst.onResumeCheck()` before returning.  
`onResumeCheck` at `subtitle-first-pipeline.ts:506–528`:

```ts
const due = this.#sentenceDueAt(sf, video.currentTime);
if (due && !due._buffer) {
  // Next due cue has not been decoded yet — enter micro-pause immediately
  this.#enterSystemPause(sf);
} else {
  // Buffer is ready (or nothing is due yet) — fire one tick to start audio promptly.
  this.#playbackTick(sf);
}
```

`#enterSystemPause` (`subtitle-first-pipeline.ts:619–631`) calls `video.pause()` synchronously.

### Why this is almost always hit on resume

During the user pause, the rolling renderer **idles**. The rolling renderer at line 868:

```ts
if (sm.userPaused || (video.paused && !isSystemPaused)) continue;
```

`sm.userPaused` is `true` for the entire duration of the user pause → the renderer skips every 1-second iteration → **no new cue buffers are produced while the video is paused**. `renderCursor` does not advance.

On resume, `#sentenceDueAt(sf, video.currentTime)` typically returns the very next cue — the one at `currentTime` — whose `_buffer` has not been decoded yet because the renderer has been idle. So `onResumeCheck` almost always takes the `due && !due._buffer` branch and immediately calls `#enterSystemPause`, which:
1. Sets `s._systemPaused = true`
2. Calls `this.app.overlay.setOverlayState("buffering")`
3. Calls `video.pause()`

The video is now **held paused** until `#playbackTick` (on the 250ms timer) detects the buffer has arrived or times out. Total added latency = time for the rolling renderer to complete one TTS render for the next cue after resume (typically 500 ms–2 s network round-trip) + up to 250 ms tick jitter.

**Before the wave:** no micro-pause on resume. The video simply continued; if the buffer wasn't ready the existing `#playbackTick` step 4 would have entered `#enterSystemPause` at that point anyway — BUT the cue at `currentTime` was typically already buffered by the rolling renderer lookahead (30 s ahead), so the micro-pause was rarely triggered. The wave made it trigger on every single resume.

### Why the buffer is almost never ready at resume

The wave did NOT change the rolling renderer's idle condition during user pause — it still skips every tick while `sm.userPaused` is true. What changed is that `onResumeCheck` now proactively checks and acts **immediately** (before the first tick fires), catching the window where `renderCursor` has stalled. Previously the playback tick simply picked up naturally and usually found the next cue pre-buffered from before the pause.

---

## Source 2 — `setOverlayState("buffering")` before `onResumeCheck()` call (MINOR, visual only)

**Impact: visual/UX — not an audio delay, but visible to user.**

At `pause-controller.ts:167`:

```ts
app.overlay.setOverlayState("buffering");
app.subtitleFirst.onResumeCheck();
```

The wave unconditionally emits `"buffering"` state on every subtitle-first resume, then immediately calls `onResumeCheck` which (if the buffer IS ready) calls `#playbackTick` and plays the cue normally. `pause-controller.ts:176` then sets `"live"`. So even in the happy path (buffer ready) there is a brief flicker: `paused → buffering → live`. The old code went `paused → live` in one shot with no intermediate state.

This is cosmetic-only if `onResumeCheck` takes the `else` branch (buffer ready), but contributes to perceived delay in the `#enterSystemPause` branch.

---

## Source 3 — AudioContext await on initial start (startup only, not pause/resume)

**Impact: none for pause→resume; relevant only for first-start latency.**

The wave added at `subtitle-first-pipeline.ts:259–265`:

```ts
if (audioCtx.state === "suspended") {
  await Promise.race([
    audioCtx.resume().catch(() => {}),
    new Promise((r) => setTimeout(r, 400)),
  ]);
}
```

This only runs during `startSession` (initial start), NOT during `resumeSession`. It is bounded at 400 ms and applies to initial startup only. No effect on pause→resume regression.

---

## Source 4 — `resumeSession` is now async and `void`-ed (re-entrancy, minor)

**Impact: negligible for latency; subtle correctness risk.**

Old `onPlay` handler: `resumeSession(this)` (sync, return value used).  
New `onPlay` handler: `void resumeSession(this)` (async, promise discarded).

```diff
-  resumeSession(this);
+  void resumeSession(this);
```

The subtitle-first branch of `resumeSession` is effectively synchronous (no await — `onResumeCheck` is sync), so making `resumeSession` async adds zero await latency on this path. The `finally { sm.systemResuming = false }` runs synchronously after `onResumeCheck()` returns.

---

## Root cause summary

| # | Source | File:Line | Added latency | Path |
|---|--------|-----------|---------------|------|
| 1 | `onResumeCheck` enters `#enterSystemPause` on resume when buffer not ready — which is almost always on resume because the rolling renderer idles during pause | `subtitle-first-pipeline.ts:520–524`, `pause-controller.ts:168` | 500 ms – 8 000 ms (TTS round-trip + tick jitter) | **SUBTITLE-FIRST** |
| 2 | Unconditional `"buffering"` overlay before `onResumeCheck` | `pause-controller.ts:167` | ~0 ms audio; cosmetic flicker | SUBTITLE-FIRST |
| 3 | Async `audioCtx.resume()` await on startSession | `subtitle-first-pipeline.ts:259–265` | 0 ms on resume path | n/a (start only) |
| 4 | `resumeSession` async + void | `pause-controller.ts:68`, `index.ts:258` | 0 ms on subtitle-first path | all tiers |

---

## The fix direction

The fundamental problem is that `onResumeCheck` is correct in concept (avoid racing video ahead of an unbuffered cue) but is triggered in a context where the buffer is guaranteed to be cold — the rolling renderer has idled for the full user-pause duration.

Two options:

**Option A (minimal):** Let the rolling renderer run one iteration on resume BEFORE calling `onResumeCheck`. Clear `sm.userPaused` first, wait one rolling-renderer tick (≤1 s), then call `onResumeCheck`. The renderer will buffer the next cue(s) and `onResumeCheck` will take the `else` path.

**Option B (preferred):** Remove `onResumeCheck` from `resumeSession` for subtitle-first entirely. The old behavior was correct: `sm.userPaused = false` → rolling renderer unblocks on its next 1-second iteration → `#playbackTick` fires within 250 ms → enters `#enterSystemPause` only if the cue is STILL not buffered after the renderer had a chance to run. Adding the eager `onResumeCheck` call optimistically fires a micro-pause before the renderer has had any time to catch up, making the pause inevitable rather than conditional. The `#playbackTick` at step 4 already handles the "not buffered yet" case identically and is the right place for it.

**Option C:** Keep `onResumeCheck` but make the rolling renderer run at least one catch-up iteration synchronously (or fire a forced tick with `rollingInFlight` guard released) BEFORE `onResumeCheck` is called, so the buffer is likely ready by the time the check runs.
