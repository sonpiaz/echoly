# SLICE 3 — Dub startup latency + pause/ready semantics

**Scope:** the Start path of both pipelines — `subtitle-first-pipeline.ts:start()` and the
WebRTC start in `index.ts:startWebRtcSession()` / `webrtc-pipeline.ts:buildSession()`. Goal:
minimise the video-pause on Start; when a buffer-pause IS needed, make resume + first dub
audio instantaneous and lock-step so the first line is never swallowed/lost.

**Relationship to prior work:** the *smooth-dub-wave* (specs/smooth-dub/) already shipped most
of the big startup wins — caption prefetch on nav, `SUBFIRST_PREBUFFER_COUNT 3→1`, SSE
streaming TTS (`renderSubtitleDubStream`), `DUB_TTFA_GATE_MS 14000→8000`, event-driven
`alignRealtimeVodBeforePlay` (killed the 80ms gratuitous sleep), and the A1 fix
(`snapPlaybackStart()` now sets `stopped=false`, reviving the drift corrector after the 1st
pause). This slice is the *residual* — what is still slow or still drops the first line AFTER
those landed.

---

## CURRENT BEHAVIOUR (concrete, file:line)

### A. Subtitle-first start() — `subtitle-first-pipeline.ts:61-323`

Start sequence:
1. Build overlay, create `AudioContext`, `audioCtx.resume()` fire-and-forget (`:93`).
2. `video.pause()` immediately (`:141`) — **this is the freeze moment**, before anything async.
3. Captions: consume prefetch if present (`getPrefetchedCaptions`, `:151-154`), else
   `adapter.fetchCaptions(... signal)` (`:157`). Prefetch already shipped → cache-hit is ~0ms.
4. `regroupToSentences` (`:224`), then compute the first wave window:
   - `firstWaveStart = sentences.findIndex(s => s.start >= currentTime)` (`:231`)
   - `firstWaveEnd = min(lookaheadEnd, firstWaveStart + SUBFIRST_PREBUFFER_COUNT)` with
     `SUBFIRST_PREBUFFER_COUNT = 1` (`:47`, `:235`). So the prebuffer is exactly **one line**.
5. `await this.#renderBatch(newSession, firstWaveStart, firstWaveEnd)` (`:241`) — the SINGLE
   serial blocking step: SSE POST `/v1/translate/subtitles/stream`, translate+TTS+decode the
   first line. This is the dominant start latency now (~0.8–2s server-side).
6. `audioCtx.resume()` bounded race vs 400ms (`:293-298`) — resumes the context BEFORE play so
   the first `#playbackTick` does not bail on the suspended-guard (the "video moves ~250ms
   before sound" fix). Good.
7. `await video.play()` (`:301`), start the 250ms `#playbackTick` interval (`:312`), fire one
   tick immediately (`:318`), launch `#runRollingRenderer` (`:320`).

Driver semantics (`#playbackTick`, `:733-863`):
- Plays each cue's `_buffer` IN FULL via `AudioBufferSourceNode.start()`; `onended` chains the
  next cue. Marks `_played` at `src.start()` (the "dup TTS ở cuối" play-once fix).
- Micro-pause: when the due cue is recent but not yet rendered (`idx >= renderCursor` and no
  `_buffer`), `#enterSystemPause` (`:693-705`) sets `_systemPaused=true` SYNCHRONOUSLY then
  `video.pause()`; step-1 resume-check (`:744-774`) resumes the instant `due._buffer` exists,
  bounded by `SUBFIRST_BUFFER_WAIT_MAX_MS = 8000` (`:56`) and a renderCursor "no audio will
  ever come" skip.
- `_systemPaused` is honoured by `bindCommonVideoListeners.onPause` (`index.ts:255`) and by the
  rolling renderer (`:945`) so the buffer pump keeps running while system-paused.

### B. WebRTC start() — `index.ts:404-663`

- `captureWithRetry` (`:449`), then for VOD-non-fallback `video.pause()` (`:459-466`).
- `buildSession` (`:481`) → SDP POST `/v1/rtc/translate` (consumes a `prepareId` pre-warm slot
  if `prepareIntent` ran on hover, `webrtc-pipeline.ts:350-368`).
- VOD branch (`:551`): `waitForPCConnected(3000)`, then per-pipeline:
  - **Standard-VOD** (`:607-638`): `beginStandardDubSync`, `await waitForFirstDub()`
    (`DUB_TTFA_GATE_MS = 8000`, `dub-playback-sync.ts:114`), pause dub, `video.play()`,
    `snapPlaybackStart()` + `start()` + `dub.play()`. **Video stays frozen for the full
    first-dub TTFA** (typically 3–6s) — the single biggest remaining WebRTC freeze.
  - **Realtime-VOD** (`:639-658`): `alignRealtimeVodBeforePlay` — now event-driven
    (`standard-vod-start.ts:25-86`): resolves on `canplay`/`loadedmetadata` or immediately if
    `readyState>=1`, ceiling 1000ms. The 80ms fixed sleep is gone. Good.
- prepareIntent pre-warm is wired: popup hover/focus on Start → `CONTENT_PREPARE_INTENT`
  (`popup/index.ts:869-889` → `router.ts:216` → `index.ts:1001` → `webrtc.prepareIntent`).

---

## ROOT CAUSES (ranked)

### RC1 — First caption line is SKIPPED when Start lands mid-utterance (lost first line). HIGH
`subtitle-first-pipeline.ts:231` (and the identical `:521` in `restart()`):
```
let firstWaveStart = sentences.findIndex((s) => s.start >= currentTime);
```
This picks the first cue that starts **at or after** `currentTime`. If the user presses Start
while a caption is already on screen (`s.start < currentTime <= s.end`), that in-progress line
is excluded from the prebuffer AND will be excluded by the driver: `#sentenceDueAt` (`:680-689`)
only returns unplayed cues, but `#playbackTick` step-4 (`:812-823`) will treat the prior cue as
due, find `t - due.end > SUBFIRST_DRIFT_SKIP_SEC`? — actually it is within window, so it enters
system-pause waiting for a `_buffer` that `#renderBatch` never fetched (renderCursor starts at
`firstWaveEnd`, i.e. AFTER the skipped line) → the cue's `idx < renderCursor` is **false**
(it's *below* firstWaveStart, never rendered), so it micro-pauses up to 8s then skips. Net: the
user loses the line they started on, and may eat an 8s buffering stall on the very first line.
This is the most direct "lost first dub line" cause and it is start-position-dependent (only
bites when Start is pressed mid-caption, which is common).

### RC2 — The start pause is gated on ONE serial TTS round-trip; no parallelism / no optimistic play. HIGH
`subtitle-first-pipeline.ts:241` awaits `#renderBatch(firstWaveStart, firstWaveEnd)` with
`firstWaveEnd = firstWaveStart + 1` before `video.play()`. Even though the endpoint streams
(SSE), the start path only asks for ONE line, so streaming buys nothing here — the freeze is
exactly one line's translate+TTS+decode latency (~0.8–2s). The rolling renderer
(`#runRollingRenderer`) and the `_systemPaused` micro-pause safety net only start AFTER play.
The pause could instead be removed entirely and the micro-pause trusted (research-1 §2.1, the
"start video immediately, trust `_systemPaused`" option) — but the micro-pause would then fire
on line 1 every time, which is itself a freeze. The real fix is lock-step: keep the pause, but
make resume fire the instant line-1's `_buffer` is decoded (which `#renderBatch` already
awaits) rather than after a separate `video.play()` + first-tick hop.

### RC3 — Standard-VOD (WebRTC) keeps the video frozen for the entire first-dub TTFA. HIGH
`index.ts:611` `await this.standardDubSync!.waitForFirstDub()` (up to `DUB_TTFA_GATE_MS=8000`,
`dub-playback-sync.ts:114-135`, polls until `dub.currentTime > 0.04`). The source video is
paused this whole time. Unlike Realtime (event-driven align, ≤1s ceiling) and unlike
subtitle-first (1-line prebuffer), Standard-VOD has no early-release — it is the longest
remaining frozen window in the product. The sync engine is designed to catch up via
`playbackRate` once dub starts, so the hard gate is stronger than necessary; research-1 §2.5
flags lowering/removing it and letting the corrector absorb the lag.

### RC4 — Resume after the start `video.play()` is two hops, not lock-step; brief "plays before sound". MEDIUM
In subtitle-first, after `#renderBatch` the code does `video.play()` (`:301`) and only THEN
`#playbackTick` (`:318`) creates the `AudioBufferSourceNode` and calls `src.start()`. Between
`play()` resolving and the synchronous tick there is a microtask gap; and `src.start(currentTime)`
schedules at "now", so there is a sub-frame lead where the video frame advances before the
first sample is audible. The `audioCtx.resume()` race (`:293-298`) removes the *250ms* version
of this bug, but not the residual "video starts a hair before sound". True lock-step would
start the source FIRST (or `src.start()` at a tiny `audioCtx.currentTime + ε`) and release the
video frame in the same turn. Minor but it is the "video chạy 1 tý mới thấy tiếng" tail.

### RC5 — `firstWaveStart === sentences.length` (Start after the last caption) → no prebuffer, silent start. LOW
`:231-238`: if every caption starts before `currentTime`, `firstWaveStart = length`, the clamp
`firstWaveEnd <= firstWaveStart && firstWaveStart < length` is false, so `#renderBatch(length,
length)` is a no-op, `renderCursor = length`, and nothing is ever due. The session "starts" but
is silent until a seek-back. Edge case (Start near video end) but produces a dead session with
no toast. Acceptable to defer but worth a note.

### RC6 — Drift correction after the FIRST start pause: verified fixed, but confirm coverage. LOW (regression-guard)
Prior art: smooth-dub R1 — `snapPlaybackStart()` did not clear `stopped`, killing the corrector
after the 1st pause. Fixed (A1, `dub-playback-sync.ts:141` `stopped = false`). For Standard-VOD
start this is on the happy path (`index.ts:626` calls `snapPlaybackStart()` then `start()`).
No new bug; this slice should keep a regression test so a future refactor of the start order
doesn't re-introduce it.

---

## PROPOSAL (end-to-end)

**Theme: keep the pause only as long as line-1's audio is genuinely not ready, and release in
lock-step with the decoded buffer — both pipelines — while never skipping the line the user
started on.**

1. **Fix the start-cue selection (RC1, RC5).** Replace `findIndex(s => s.start >= currentTime)`
   with a helper that picks the cue **covering** `currentTime` when one exists
   (`s.start <= currentTime + DUE_AHEAD && currentTime <= s.end + small`), else the next one;
   clamp so `firstWaveStart` is never `length` while an in-progress/last cue is playable. Apply
   identically in `start()` (`:231`) and `restart()` (`:521`). This guarantees the line the
   user started on is in the prebuffer wave and is the first thing dubbed.

2. **Lock-step resume in subtitle-first (RC2, RC4).** After `#renderBatch` returns with line-1's
   `_buffer` decoded, start the `AudioBufferSourceNode` for line-1 FIRST (or schedule at
   `audioCtx.currentTime`), THEN release `video.play()` in the same synchronous block, instead
   of `play()` → microtask → first `#playbackTick`. Concretely: extract the "create source +
   `src.start()` + `_played` + `#showCue`" body of `#playbackTick` step-4 into a
   `#startCue(s, cue)` method, call it for the prebuffered line immediately after the
   `audioCtx.resume()` race and immediately before `video.play()`. The 250ms interval +
   `onended` chain then take over for line-2+. This removes the play-before-sound tail and
   guarantees line-1 is never dropped (it is started, not "scheduled to maybe play next tick").

3. **Standard-VOD early release (RC3).** Lower the hard freeze: change `index.ts:607-638` to
   release `video.play()` as soon as `waitForFirstDub` resolves **or** a short floor elapses,
   then let `bindStandardDubPlaybackSync` catch up via `playbackRate` (it already ramps). Two
   sub-options: (a) keep `waitForFirstDub` but drop the gate to a shorter "first-audio OR Ns"
   and start the sync engine in catch-up mode; (b) start playing on `waitForPCConnected` and let
   the corrector pull the video back when dub begins (research-1 §2.5 preferred). Recommend (a)
   first — lower blast radius, keeps the "dub leads at join" guarantee — with the floor tuned so
   the typical 3–6s freeze drops toward the Realtime ~1s feel. **Do NOT touch
   `DUB_LIVE_TTFA_CEILING_MS`** (that's the no-CC live fallback, different semantics).

4. **Keep the micro-pause as the only stall mechanism (no change), and DO NOT add an eager
   resume-side micro-pause.** Prior art (regress-1 §Option B) showed the eager `onResumeCheck`
   made the pause inevitable; the start path should likewise rely on the post-play
   `#playbackTick` step-4 micro-pause as the *safety net* for line-2+, not pre-emptively pause.

5. **No server change required for the core fix.** SSE streaming + prefetch + prepare-intent are
   already shipped. The one server-adjacent lever (multi-line streamed prebuffer to overlap
   line-1 decode with line-2 fetch) is optional polish, not needed for "first line never lost".

**Net effect:** subtitle-first freeze ≈ one line's TTS RTT, released the instant its buffer is
decoded with the line itself as the first audible dub (never the *next* line); Standard-VOD
freeze drops from up-to-8s toward ~1s with the corrector absorbing residual lag; Realtime
unchanged (already event-driven); the "video moves before sound" tail closed by starting the
source before releasing the frame.

---

## FILES TO CHANGE

- `extension/src/content/pipelines/subtitle-first-pipeline.ts` — RC1 cue selection (`:231`,
  `:521`), RC2/RC4 extract `#startCue` + lock-step start (`:241`, `:293-318`), RC5 clamp.
- `extension/src/content/index.ts` — RC3 Standard-VOD early release (`:607-638`).
- `extension/src/lib/dub-playback-sync.ts` — RC3 optional: a "start in catch-up / hold" entry so
  releasing before first dub is safe; keep A1 (`:141`) intact (regression-guard).
- `extension/src/shared/constants.ts` — RC3 the Standard-VOD release floor (new const) if option
  (a) chosen; leave `DUB_TTFA_GATE_MS` as the absolute cap, `DUB_LIVE_TTFA_CEILING_MS` untouched.
- (tests) `subtitle-first` start-mid-caption + lock-step-first-line; `dub-playback-sync`
  ≥2 pause/resume drift-correct regression (guards A1).

---

## RISKS

- RC1 cue-selection change touches the seek logic invariants (`#onSeek` resets `_played` for
  `s.start >= newT`, `:894`) — the "covering cue" helper must stay consistent with onSeek or a
  seek-back could double-play / skip. Keep one shared `firstPlayableCueAt(t)` helper used by
  start, restart, and onSeek.
- RC2 lock-step `#startCue` before `video.play()`: if `video.play()` rejects (autoplay block),
  the dub would start while the video stays frozen → A/V desync. Must gate `#startCue` on the
  `play()` promise resolving, or stop the source if play() rejects (mirror the `TOAST_PRESS_PLAY`
  path `:303`).
- RC3 early release: releasing before first dub means the source audio is briefly audible before
  the dub (the very thing SF6 pause was added to avoid). The corrector + the dub leading at join
  is the mitigation; needs live verification that it doesn't feel worse than the freeze.
- All changes are start-path: high user visibility, must run the §13 PRE-BUILD smoke (real keys
  + browser) — current state of play notes live smoke has NOT run.

---

## OPEN QUESTIONS

- RC3: option (a) shorter gate vs (b) play-on-ICE + corrector-catchup — which matches the
  product's "dub must lead at join" stance? (a) is safer; confirm the desired freeze budget.
- RC1: when Start lands mid-caption, do we dub the in-progress line from its start (replay the
  already-spoken half) or skip to the next clean boundary? UX call — replaying feels more
  complete but is slightly out of sync; skipping loses content. Recommend replay-from-start of
  the covering cue for completeness (matches the "no swallowed words" ethos).
- Is there an appetite to overlap line-1 decode with a 2-line streamed prebuffer (uses the
  already-shipped SSE) to shave the freeze further, or is one-line-lock-step sufficient?
- The LIVE auto-next "no [nav] logs" issue (separate slice) means restart()'s mirrored start
  path may not be exercised at all right now — confirm slice-3 changes to restart() are testable
  independently of the nav bug.
