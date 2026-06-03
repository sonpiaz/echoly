# Diagnostic: Standard Mode Start/Stop Responsiveness
**Date:** 2026-06-02  
**Branch:** `wave/smooth-dub` (all wave edits in working tree, uncommitted)  
**Verdict type:** BRUTALLY HONEST — read-only, no changes

---

## Executive summary

The wave **did not meaningfully improve Standard subtitle-first Start latency** and **did not improve Stop responsiveness**. All of the wave's real wins are for (a) Realtime VOD start (`alignRealtimeVodBeforePlay` event-driven fix = up to 2 s saved, Realtime only), (b) pause/resume sync correctness for all tiers, and (c) SSE streaming so the first cue's buffer is available ~line-0 latency sooner — but the video still does NOT release until `SUBFIRST_PREBUFFER_COUNT` complete lines are decoded (still 2 lines, was 3). The core "freeze until N lines are TTS'd" architecture is unchanged.

---

## A. Standard Start — "press Start → first dubbed audio"

### Complete trace with timing

#### A.1 Popup → background → content (shared)

| # | What happens | File:line | Time (estimate) |
|---|---|---|---|
| 1 | User clicks "Start dubbing" in popup | `src/popup/index.ts:772` `onToggle()` | 0 ms |
| 2 | `toggleBtn.disabled = true` — button goes inert (UI feedback) | `src/popup/index.ts:773` | ~0 ms (sync) |
| 3 | `await send({ type: "START", settings })` — runtime.sendMessage to SW | `src/popup/index.ts:793` | **+0 to 1500 ms** (SW cold start penalty; warm: ~2–5 ms). This is the FIRST async gate. The popup is frozen on `await` — no visual feedback update until the SW responds. |
| 4 | SW routes to `session.start(settings)` | `src/background/router.ts:165` | ~0 ms |
| 5 | `persistSettings` → chrome.storage.local write | `src/background/session-coordinator.ts:161` | ~5–20 ms (serial) |
| 6 | `resolveApiMode()` — if signedInUser already in store: reads cookie (~5–15 ms). If cold: full `GET /v1/session/bootstrap` | `src/background/session-coordinator.ts:168` | **+5 ms to 500 ms** (worst: user not cached) |
| 7 | `sessionTabForStart()` — two `chrome.tabs.query` calls | `src/background/session-coordinator.ts:114–127` | ~5–15 ms |
| 8 | `ensureContentScript()` — PING; if no reply, `chrome.scripting.executeScript` injection | `src/background/session-coordinator.ts:132–153` | Warm (already injected): ~2–5 ms. Cold injection: **+100–300 ms** |
| 9 | `store.setConnecting(true)` + `store.broadcast()` → popup shows "Connecting" status | `src/background/session-coordinator.ts:193–195` | **First popup visual change** |
| 10 | `relayToContent(tabId, { type: "CONTENT_START", settings })` | `src/background/session-coordinator.ts:219` | SW awaits this — it blocks until content replies `{ok:true}`. ~1–5 ms IPC. |

**Gap before ANY visible change:** Between step 1 (click) and step 9 (popup shows "Connecting") there is a dead zone of **10 ms to 2 s** where the button is just disabled — no overlay appears, no video freezes, nothing. The user has no evidence anything is happening.

#### A.2 Content script — subtitle-first start()

After `CONTENT_START` arrives at content script (`src/content/index.ts:822`):

| # | What happens | File:line | Time |
|---|---|---|---|
| 11 | `startSession()` → subtitle-first path detected | `src/content/index.ts:315–326` | sync |
| 12 | `buildOverlay()` — DOM injection | `src/content/overlay/overlay.ts` | ~5–10 ms sync |
| 13 | `overlay.setStatusText("Loading captions")` + `setOverlayState("connecting")` | `src/content/pipelines/subtitle-first-pipeline.ts:71–74` | **First on-page visual: overlay appears** |
| 14 | `video.pause()` — source video freezes | `src/content/pipelines/subtitle-first-pipeline.ts:131–134` | **User's video FREEZES HERE. Sync.** |
| 15 | Caption fetch: B4 prefetch cache hit OR `adapter.fetchCaptions()` | `subtitle-first-pipeline.ts:141–155` | Cache hit (B4): **~0–5 ms**. Cache miss: **50–1800 ms** (YT intercept + DOM scrape) |
| 16 | `regroupToSentences()` | `src/lib/caption-utils.ts` | ~1–5 ms |
| 17 | `overlay.setStatusText("Translating N lines")` | `subtitle-first-pipeline.ts:182` | Second on-page text change |
| 18 | `await this.#renderBatch(newSession, firstWaveStart, firstWaveEnd)` | `subtitle-first-pipeline.ts:213–227` | **THE DOMINANT FREEZE. Described below.** |
| 19 | `video.play()` — video unfreezes | `subtitle-first-pipeline.ts:253–258` | Async |
| 20 | `#playbackTick()` fires immediately, plays first `AudioBufferSourceNode` | `subtitle-first-pipeline.ts:270–271` | **First dubbed audio** |

**Total Standard start latency (typical, captions cached):**
- Steps 1–10 (warm SW, already injected): ~20–50 ms
- Steps 1–10 (SW cold start + cold injection): ~500–2000 ms
- Step 15 (caption fetch): ~0 ms (B4 hit) to ~1800 ms (miss)
- Step 18 (#renderBatch): **1500–4000 ms** (dominant, unavoidable in current design)
- **Total (best case, B4 hit, warm SW):** ~2–4.5 s of frozen video
- **Total (worst case, cold SW, caption miss):** ~4–8 s

### A.3 The #renderBatch freeze — the real dominant cause

`#renderBatch(newSession, firstWaveStart, firstWaveEnd)` at `subtitle-first-pipeline.ts:518`.

The wave changed `SUBFIRST_PREBUFFER_COUNT` from **3 to 2** (committed change in `src/shared/constants.ts`). The loop inside `#renderBatch` now iterates over `SUBFIRST_BATCH_SIZE` chunks (check value), sending each to the new `renderSubtitleDubStream()` SSE generator.

The SSE streaming path (wave Workstream E) **does** help — it populates `s.sentences[idx]._buffer` as each line arrives from the SSE stream rather than waiting for all N lines in one blob. HOWEVER:

**The critical gate is still here:**
```
subtitle-first-pipeline.ts:213:
  await this.#renderBatch(newSession, firstWaveStart, firstWaveEnd);
```

**`video.play()` at line 253 only runs after `#renderBatch` completes.** The streaming path fills buffers incrementally, but the `for await` loop inside `#renderBatch` still blocks until ALL lines in `[firstWaveStart, firstWaveEnd)` have been decoded. The video is held frozen for the duration of the complete prebuffer batch, not just until line 0 is ready.

With `SUBFIRST_PREBUFFER_COUNT=2`, the prebuffer is 2 lines instead of 3. If each line takes ~750–1500 ms (server translate+TTS), this saves approximately 750–1500 ms compared to count=3. But:
1. All 2 lines are still in a SERIAL SSE stream (server synthesizes line 0, then line 1)
2. The extension still waits for BOTH before calling `video.play()`
3. The user still sees frozen video for `~1.5–3 s` even at count=2

**The SSE streaming's real win is for the rolling renderer** (lines beyond the prebuffer) — those start populating sooner. But the initial freeze duration is cut only by the reduction from 3→2 lines, not by the streaming property of the protocol.

### A.4 B4 caption prefetch — real win, conditional

The wave adds eager caption prefetch in `NavigationWatcher` when `sm.session == null` (navigation.ts). This is a genuine speedup on **YouTube** when:
- The user navigated to the video, then waited a few seconds before clicking Start
- The prefetch completed before Start was clicked

If the prefetch hit: step 15 drops from up to 1800 ms to ~0 ms. This is a **real 0–1800 ms win** on first Start. However:
- No benefit on auto-play / immediate Start after navigation
- No benefit on non-YouTube platforms
- The prefetch is cleared on-consume, so rapid re-start uses the normal path

### A.5 What about visible feedback before the freeze?

The overlay now appears (step 13) and shows "Loading captions" **before** `video.pause()` (step 14). This is 2–3 ms earlier than before, essentially negligible. The video still pauses synchronously right after the overlay appears.

**The "nothing happens" gap between click and ANY visible feedback** is the period between step 1 and step 13:
- With warm SW + already injected content script: **~15–40 ms** (negligible — the overlay appears almost instantly after click)
- With cold SW: **~200–2000 ms of total darkness** — button disabled, nothing else changes

The wave's B3 optimistic popup render helps mask SW cold-start for the popup shell itself, but the button-disabled→"Connecting" state transition still takes the full SW round-trip before the popup updates and still requires a second relay to content before the overlay appears.

### A.6 Wave changes that DO touch Standard start — honest impact

| Wave change | Touches Standard start? | Real impact |
|---|---|---|
| B4: caption prefetch | YES | Saves 0–1800 ms on caption fetch step. Conditional (YouTube only, if prefetch completed). |
| E: SSE streaming in `#renderBatch` | YES | Does NOT reduce the freeze duration at start (video.play() still waits for full prebuffer). Reduces rolling renderer latency only. |
| `SUBFIRST_PREBUFFER_COUNT` 3→2 | YES | Saves 1 TTS line worth of time (~750–1500 ms). Meaningful but still leaves 1.5–3 s freeze. |
| `DUB_TTFA_GATE_MS` 14000→8000 | NO (Standard WebRTC fallback only) | Only affects Standard WebRTC (no-CC fallback), not subtitle-first. |
| B3: optimistic popup render | MARGINAL | Only helps popup shell paint. No effect on video freeze duration. |
| B1: event-driven `alignRealtimeVodBeforePlay` | NO | Realtime path only. Zero effect on subtitle-first start. |
| A1/A2/A3: resume correctness | NO | Pause/resume path only. Not on initial start. |
| D: PREPARE_INTENT pre-warm | NO | Realtime only (guard in `maybeSendPrepareIntent`: `if (tierSelect.value !== TIER_REALTIME) return`). Standard gets no pre-warm benefit. |

**Honest verdict on Start:** The wave saves 0–2800 ms of latency at best (caption prefetch + 1 less TTS line). The **dominant felt freeze** (video paused for 1.5–3 s while 2 TTS calls complete) is unchanged in architecture. If the server is slow or the user just navigated, the experience is essentially the same as before.

---

## B. Standard Stop — "press Stop → audio actually stops"

### Complete trace

#### B.1 Click path

| # | What happens | File:line | Time |
|---|---|---|---|
| 1 | User clicks "Stop dubbing" in popup | `src/popup/index.ts:772` | 0 ms |
| 2 | `toggleBtn.disabled = true` | `src/popup/index.ts:773` | ~0 ms sync |
| 3 | `await send({ type: "STOP" })` — runtime.sendMessage to SW | `src/popup/index.ts:776` | **+2–1500 ms** (SW cold start if idle; warm: ~2–5 ms). Popup is frozen on await. |
| 4 | SW `session.stop()` — sends `CONTENT_STOP` to content script | `src/background/session-coordinator.ts:273` | |
| 5 | SW calls `ensureContentScript(targetTabId)` — PING to content | `src/background/session-coordinator.ts:271–276` | +2–5 ms (warm); +100–300 ms (cold inject) |
| 6 | SW calls `relayToContent(targetTabId, { type: "CONTENT_STOP" })` | `src/background/session-coordinator.ts:273` | ~1–5 ms IPC |
| 7 | Content `app.stopSession(STOP_REASON.BACKEND_STOP)` | `src/content/index.ts:826–828` | Sync — **audio stops here** |
| 8 | `sendResponse({ ok: true })` — content replies to SW | `src/content/index.ts:827` | ~1 ms |
| 9 | SW gets reply, updates store (running=false etc.), broadcasts to popup | `src/background/session-coordinator.ts:282–289` | ~2 ms |
| 10 | Popup `applyState()` — shows idle state | `src/popup/index.ts:777` | sync render |

**Total latency from click to audio silent:**
- Steps 1–7, warm SW + content already injected: **~10–20 ms** → audio stops
- Steps 1–7, cold SW: **~200–1500 ms** → audio plays for this entire duration after Stop click

### B.2 What `stopSession()` does to audio — is it instant?

At `src/content/index.ts:526` (the `stopSession` method):

```
// For subtitle-first on user Stop (reason !== VIDEO_ENDED):
if (session.playbackTimer) {
  clearInterval(session.playbackTimer);  // interval cleared synchronously
  session.playbackTimer = null;
}
session.stopFlag = true;
session.abortController.abort();

// For non-VIDEO_ENDED stop:
if (currentSrc) {
  currentSrc.stop();   // <-- AudioBufferSourceNode.stop() — sync, immediate
  currentSrc.disconnect();
}
session.currentSource = null;
```

**For user Stop (reason `BACKEND_STOP`):** The code falls into the `else` branch (line 609–622 approximately) and calls `currentSrc.stop()` synchronously. **Audio stops immediately when `stopSession()` is called**, not deferred.

However, `stopSession()` is only called AFTER the multi-hop relay: popup → SW → content. If the SW is warm and content is injected, total latency to audio silence is ~10–20 ms, which is imperceptible. If SW is cold, audio can play for 200–1500 ms after the button was clicked.

### B.3 Mechanism details — is there any lag after stopSession() is called?

1. **`session.abortController.abort()`** — aborts any in-flight `renderSubtitleDubStream` SSE generator. The SSE `reader.read()` call throws/breaks. Any ongoing TTS fetch is cancelled. This is synchronous signal-set; the actual request cancellation depends on the network stack but is typically very fast (~ms).

2. **`clearInterval(session.playbackTimer)`** — sync. The 250ms tick will never fire again.

3. **`currentSrc.stop()`** — `AudioBufferSourceNode.stop()` is synchronous from the JS perspective. The Web Audio spec says it schedules the stop at the current `AudioContext.currentTime`, which means it stops within the next audio render quantum (~5.3 ms at 48kHz/256 frames). **This is effectively immediate.**

4. **`session.audioCtx.close()`** — closes the AudioContext, releasing all Web Audio resources. This is what truly silences everything.

**Verdict:** On the content-script side, Stop IS synchronous and immediate once `stopSession()` is invoked. The lag is entirely in the MV3 message chain (popup → SW → content), not in the audio teardown.

### B.4 Stop path — what the wave changed

The wave made NO changes to the Stop path for Standard. The `session.stop()` in session-coordinator.ts is unchanged. The `stopSession()` method handling for `BACKEND_STOP` is unchanged. 

**The overlay Stop button** (`createController` in `controller.ts:62`) calls:
```
app.stopSession(STOP_REASON.USER_STOP);
post({ type: "CONTENT_STOP_REQUEST" });
```
This IS a local shortcut — clicking Stop on the overlay calls `stopSession` SYNCHRONOUSLY without waiting for a SW round-trip. Audio stops immediately. Then it fires `CONTENT_STOP_REQUEST` to notify the background (fire-and-forget for state sync). **This path is actually instant for the user.** 

**The popup Stop button** goes through the full SW relay (popup → SW → content → audio stop), adding ~10–1500 ms depending on SW warmth.

### B.5 Wave's contribution to Stop

None. The wave touched none of the Stop code path for Standard. Stop responsiveness for Standard is the same as before, for better or worse.

---

## C. Honest Verdict + Concrete High-Impact Fixes

### C.1 Did the wave meaningfully improve Standard Start/Stop responsiveness?

**Start: Partially. Not enough to feel different.**
- The B4 caption prefetch is the best Standard start win in the wave, but only kicks in on YouTube and only when the user waits a few seconds before clicking Start. On immediate Start (user navigates and clicks right away), it provides zero benefit.
- The SSE streaming change (`renderSubtitleDubStream`) does NOT make the initial freeze shorter — the `for await` loop in `#renderBatch` still blocks until all `SUBFIRST_PREBUFFER_COUNT` lines are decoded before `video.play()` is called. Streaming helps the rolling renderer (subsequent lines come in sooner) but not the felt startup pause.
- Reducing SUBFIRST_PREBUFFER_COUNT from 3→2 saves ~750–1500 ms of freeze time. This IS meaningful — potentially cutting felt freeze from 3.5 s to 2.5 s. But a 2.5 s frozen video still feels wrong.

**Stop: No change.** Audio teardown on the content-script side was already synchronous and instant. The lag is in the MV3 message path, which the wave did not change.

**The wave optimized primarily for:**
1. Realtime resume sync correctness (A1/A2/A3) — real bugs, real fixes
2. Realtime start latency (B1 event-driven align, D pre-warm) — real wins, Realtime only
3. Branded UX feedback (C1/C2/C3) — UX polish, no actual latency reduction

Standard subtitle-first felt latency was the stated problem but received only marginal, conditional improvements.

---

### C.2 Ranked dominant causes

#### For Standard START

| Rank | Cause | File:line | Estimated contribution |
|---|---|---|---|
| 1 | **Prebuffer freeze: video held until N lines TTS'd** | `subtitle-first-pipeline.ts:213` `await this.#renderBatch(...)` then `video.play()` at line 253 | **1.5–4 s** of frozen video. The entire user-visible pause. |
| 2 | **Caption fetch (no B4 hit)** | `subtitle-first-pipeline.ts:141–155` → `adapter.fetchCaptions()` | **0–1800 ms** (avoided by B4 prefetch only when prefetch completed) |
| 3 | **SW cold start + ensureContentScript** | `session-coordinator.ts:132–153` | **0–1500 ms** (0 if warm, significant if cold) |
| 4 | **"Nothing happens" gap** (click → popup shows "Connecting") | `popup/index.ts:793` `await send(START)` | **0–2 s** depending on SW warmth. User sees disabled button only. |

#### For Standard STOP

| Rank | Cause | File:line | Estimated contribution |
|---|---|---|---|
| 1 | **SW round-trip before audio stops** | `popup/index.ts:776` `await send(STOP)` → `session-coordinator.ts:273` `relayToContent` → `content/index.ts:826` `stopSession()` | **2–1500 ms** (warm: ~10 ms, cold SW: up to 1.5 s) |
| 2 | (Non-issue) Audio teardown once `stopSession()` is reached | `content/index.ts:609–622` `currentSrc.stop()` | ~5 ms (Web Audio render quantum). Not felt. |

---

### C.3 Top concrete high-impact fixes

#### Fix 1: Optimistic Start — play video immediately after line 0 buffer is ready (NOT after all N lines)

**What:** Instead of `await this.#renderBatch(firstWaveStart, firstWaveEnd)` then `video.play()`, restructure so that:
- `video.play()` is called as soon as **line 0's `_buffer` is populated** (the first SSE item decode completes)
- Lines 1, 2, … continue filling in via the still-running SSE stream
- If line 1 is not ready when the playback tick fires, the existing `#enterSystemPause` mechanism holds the video briefly (max `SUBFIRST_BUFFER_WAIT_MAX_MS = 8000 ms`) until it arrives

This works because the SSE generator already yields `item.index = 0` first (strict index order per E-5). `decodeAudioData` for line 0 is the only blocking gate needed.

**File:line:** `subtitle-first-pipeline.ts:213–228` — restructure the `#renderBatch` call into a streaming loop that calls `video.play()` after index 0 is decoded.

**Implementation sketch:**
```
// Instead of: await this.#renderBatch(firstWaveStart, firstWaveEnd);
// Do:
const renderDone = this.#renderBatch(newSession, firstWaveStart, firstWaveEnd);
// Wait only until line 0 is buffered, then release the video
await this.#waitForFirstBuffer(newSession, firstWaveStart);
// video.play() immediately — remaining lines fill in async
// the system-pause mechanism will hold if line 1 isn't ready
```

**Where `#waitForFirstBuffer` is:** A new private helper that polls/waits until `sentences[firstWaveStart]._buffer !== undefined` (set by `#renderBatch`'s `decodeAudioData`). Timeout cap: `SUBFIRST_BUFFER_WAIT_MAX_MS`. After timeout, fall through to `video.play()` anyway and let the drift-skip logic handle missing lines.

**Risk:** If TTS quality for line 0 is bad/garbled, it plays while lines 1+ are still loading. Also, if line 0 completes very fast but line 1 lags >8 s, the system-pause will hold the video up to 8 s — but that's the same worst case as now.

**Felt improvement:** Video unfreezes ~750–1500 ms sooner per saved line. With count=2, this saves the second line's complete wait time. **Felt start: drops from ~2.5 s to ~1–1.5 s** on warm cache.

#### Fix 2: Reduce SUBFIRST_PREBUFFER_COUNT to 1 (with Fix 1, this becomes the only gate)

**What:** Set `SUBFIRST_PREBUFFER_COUNT = 1`. With Fix 1 (video releases on line 0 ready), prebuffer=1 means the initial wait is purely the first TTS call. Count=2 means the second TTS call also blocks before video releases.

**File:line:** `subtitle-first-pipeline.ts:44` (after wave: line ~44, `const SUBFIRST_PREBUFFER_COUNT = 2`)

**Risk:** Slightly more "Buffering…" micro-pauses during the first few lines of playback if the rolling renderer can't stay ahead. The `SUBFIRST_BUFFER_WAIT_MAX_MS = 8000 ms` cap bounds the worst case.

**Felt improvement:** Combined with Fix 1, this means the video freeze duration equals the latency of exactly ONE translate+TTS call (~750 ms–1.5 s typical). Down from 2–4 s today.

#### Fix 3: Instant content-script Stop (bypass SW relay)

**What:** The overlay's Stop button already calls `app.stopSession()` locally (no SW round-trip, audio stops instantly). But the popup's Stop button goes popup → SW → content. Fix: add a `CONTENT_EMERGENCY_STOP` message that the popup can send directly to the content tab (using `chrome.tabs.sendMessage` from the popup, NOT via SW), which calls `stopSession` immediately.

This requires the popup to know the current `tabId` (it receives it in state as `state.tabId`). The popup can fire `chrome.tabs.sendMessage(state.tabId, { type: "CONTENT_EMERGENCY_STOP" })` directly, bypassing the service worker entirely. Then separately fire `send({ type: "STOP" })` to clean up the SW state.

**File:line changes:**
- `popup/index.ts:771–778` — in `onToggle()`, on the Stop branch, fire an immediate `chrome.tabs.sendMessage` to content if `state.tabId` is known, then fire `send(STOP)` for SW cleanup
- `content/index.ts` message router — handle `CONTENT_EMERGENCY_STOP` with `app.stopSession(STOP_REASON.BACKEND_STOP); sendResponse({ok:true})`
- `shared/protocol.ts` — add the message type

**Risk:** Small: the SW state may briefly be out of sync for the ~10–50 ms before `send(STOP)` completes. The SW then re-syncs. No metering impact (metering is on the server; the TTS SSE abort signal is already threaded).

**Felt improvement:** Popup Stop becomes instant (audio stops in ~5 ms instead of ~10–1500 ms).

#### Fix 4: Non-blocking popup feedback before SW reply (for Start)

**What:** Immediately on Start click, before `await send(START)`, set the button to "Stopping…" / "Starting…" and emit an optimistic CONNECTING status to the popup itself (without waiting for the SW). This is purely cosmetic but eliminates the "button disabled and nothing happens" gap.

This is partially done already (`toggleBtn.disabled = true` at line 773) but the status text still shows whatever it was before (e.g. "Ready."). Adding `statusEl.textContent = "Connecting…"` and `setStateClass("connecting")` locally before the `await` would give the user immediate feedback.

**File:line:** `popup/index.ts:771–793` — add 2 lines before the `await send(START)`:
```
statusEl.textContent = "Connecting…";
setStateClass("connecting");
```

**Risk:** Zero — purely cosmetic, overwritten by the real state when the SW replies.

**Felt improvement:** The "nothing happening" dead zone after click is replaced with visible "Connecting…" feedback. No latency reduction, but felt responsiveness improves significantly.

---

### C.4 Wave changes that ADDED latency or complexity to Standard path without benefit

1. **`resumeSession` is now `async`** (`pause-controller.ts`). The caller in `index.ts` now does `void resumeSession(this)` (fire-and-forget). For Standard subtitle-first, `resumeSession` now calls `app.subtitleFirst.onResumeCheck()` and emits a buffering state. This is correct and not harmful — but the async chain and the brief `"buffering"` overlay state emission means there is a flash of "buffering" state on every resume that wasn't there before. This is a minor aesthetic regression for a user who resumes and the next cue is already buffered (the common case).

2. **`CONTENT_PREPARE_INTENT` message + `prepareIntent()` in WebRtcPipeline** — these are wired for Standard too (the guard `if (tierSelect.value !== TIER_REALTIME) return` in the popup is correct, but the content-side `CONTENT_PREPARE_INTENT` handler calls `app.webrtc.prepareIntent()` with `pipeline = s.tier ?? TIER_REALTIME`). Since Standard is never `TIER_REALTIME`, the guard in popup means PREPARE_INTENT is never sent for Standard. Net: zero Standard overhead, but this is also zero benefit for Standard.

3. **The standard-vod-start.ts change** (B1 event-driven `alignRealtimeVodBeforePlay`) has `const ceiling = Math.max(alignMs, 2000)` which actually keeps a 2000 ms hard ceiling. This is unchanged worst-case from before for Realtime, but the fix is Realtime-only and does not affect Standard subtitle-first at all.

---

## Summary table

| Issue | Root cause | File:line | Wave fix? | Recommended fix |
|---|---|---|---|---|
| Video frozen 1.5–4 s on Start | `#renderBatch` blocks `video.play()` until N lines decoded | `subtitle-first-pipeline.ts:213,253` | PARTIAL (count 3→2, saves ~1 line) | Fix 1+2: release video after line 0 ready |
| "Nothing happens" after click | SW round-trip before popup updates | `popup/index.ts:793` | NOT FIXED | Fix 4: optimistic UI update before await |
| Caption fetch adds 0–1800 ms | 3-layer sequential caption fetch | `subtitle-first-pipeline.ts:141–155` | PARTIAL (B4 prefetch, conditional) | B4 is correct; also parallelize CC layers |
| Stop not immediate from popup | 2-hop SW relay before audio stops | `popup/index.ts:776`, `session-coordinator.ts:273` | NOT FIXED | Fix 3: popup direct tab message |
| Stop IS instant from overlay | `controller.ts:62` calls `stopSession()` directly | `controller.ts:62` | Pre-existing win | Document and rely on it |
