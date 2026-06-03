# Standard-WebRTC Bug Investigation — wave/smooth-dub

**Branch:** `wave/smooth-dub` (uncommitted changes on top of `develop`)  
**Date:** 2026-06-02  
**Scope:** Read-only. No code was modified.  
**Report type:** Ranked root-cause list with file:line citations; wave-regression vs pre-existing flag; confirmation symptoms.

---

## Preamble — what the path IS

Standard-WebRTC is taken when:
- `tier = "standard"` AND
- **either** the subtitle-first pipeline finds no captions (YouTube VOD, no CC) → falls back via `subtitleFirst.start()` → `app.startWebRtcStandard(incomingSettings)` at `subtitle-first-pipeline.ts:182`
- **or** the page has no subtitle-first capability (non-YouTube, non-Coursera, etc.)

Route: `POST /v1/rtc/translate?pipeline=standard&voice=...&targetLanguage=vi` → 200 (confirmed working). Client-side: `WebRtcPipeline.buildSession()` → ICE → `waitForFirstDub(8000ms)` gate → `video.play()` → `standardDubSync` rate-corrector.

The **subtitle-first fallback to Standard-WebRTC is the most common path** on YouTube when the video has no captions (or captions failed to load), which is the user's reported scenario.

---

## Pre-start mechanics (clarification)

Before WebRTC is set up:

1. `subtitle-first-pipeline.ts:140` calls `video.pause()` — video frozen while captions are fetched.
2. If no captions: `sm.session = null; sm.pageToken += 1; overlay.removeOverlay()` — subtitle-first session abandoned.
3. `startWebRtcStandard(incomingSettings)` is called. Video is still paused.
4. Inside `startWebRtcSession`, `captureWithRetry(video)` calls `nudgePlay(video)` (since video is paused) — `video.play()` for ≤250 ms so `captureStream()` returns audio tracks.
5. **SF6**: `video.pause()` immediately after capture — video frozen again.
6. `buildSession()` starts ICE negotiation. Capture tracks now carry PCM from a paused video (silence).

The server receives silence PCM until `video.play()` is called later. The `MediaPlayoutScheduler` media clock advances from silence bytes; real speech is processed in later STT windows.

---

## Ranked root causes

### CAUSE 1 — The `dub.currentTime > 0.04` gate resolves on wall-clock time, not first-audio-data

**Rank: Most likely cause of confusion / apparent breakage.**  
**Classification: Pre-existing by design, but the 8s→8s DUB_TTFA_GATE_MS change surfaces it differently.**

**Files:**
- `src/lib/dub-playback-sync.ts:114-134` — `waitForFirstDub` polls `dub.currentTime > 0.04`
- `src/content/index.ts:478-518` — Standard VOD TTFA block
- `src/shared/constants.ts:62` — `DUB_TTFA_GATE_MS = 8000` (was 14000 on develop)

**Mechanism:** For a WebRTC `srcObject` MediaStream, `audio.currentTime` advances in wall-clock real time once the element is in "playing" state — it does NOT require actual RTP audio data to arrive. The `track` event fires when ICE/DTLS completes (~2–4s after `buildSession`). The handler in `webrtc-pipeline.ts:248-254` creates the `<audio>` element, calls `audio.play()`, and sets `newSession.remoteAudio = audio`. From this moment, `currentTime` advances in real time. `waitForFirstDub` resolves `true` within ≤80ms (one poll tick), NOT when dubbed audio actually arrives.

This means:
- The gate is effectively an **ICE-connect gate**, not a "first TTS audio" gate.
- After the gate resolves, `dub.pause()` is called on the `<audio>` element that has `currentTime ≈ 0.04s` — no real audio yet.
- `video.play()` runs. Real audio flows to server.
- `dub.play()` — the element plays silence for ~1.75s while the server processes speech + TTS.
- `standardDubSync` ticks. It waits for `dub.currentTime ≥ 0.05` (its own internal gate) before setting anchors. Since `currentTime` advances in wall-clock time, anchors are set almost immediately — but the audio hasn't arrived yet.

**The net result:** `standardDubSync` anchors against an audio element that's playing silence. When the first TTS RTP arrives (~1.75s after video.play()), the `unmute` event fires and audio becomes audible. But the sync engine has already committed to anchors based on stale timing — potential A/V desync on first segment.

**Wave regression:** `DUB_TTFA_GATE_MS` was reduced from 14000 → 8000 (`constants.ts:62`). This is NOT the problem — the gate already resolves instantly at ICE connect (not 8s). The 8000 is an irrelevant ceiling for the normal path. The number change is sound.

**Confirming symptom:** User sees video frozen for ~3–4s (ICE time), then video.play() runs. Dub is SILENT for ~1.75s after play begins, then suddenly audio starts. If the user stops before the ~1.75s, they see "Translating" but no sound.

---

### CAUSE 2 — `standardDubSync.snapPlaybackStart()` + `start()` race against `syncSourcePauseState` fire-and-forget on RESUME

**Rank: Definite bug for PAUSE/RESUME path, not initial start.**  
**Classification: Wave regression (non-blocking resume was a deliberate design choice that introduced a race).**

**Files:**
- `src/content/pause-controller.ts:96-103` — `resumeSession` Standard-WebRTC branch
- `src/lib/rtc-media-sync.ts:145-160` — `syncSourcePauseState` async, fire-and-forget on resume

**Mechanism:**
```js
// pause-controller.ts:96-103
void syncSourcePauseState(app.sm, sess, false);  // fire-and-forget
if (sess.pipeline === "standard") {
  app.standardDubSync?.snapPlaybackStart();  // runs IMMEDIATELY
  app.standardDubSync?.start();              // starts ticking IMMEDIATELY
}
```

`syncSourcePauseState` (now async) does: `void remoteAudio.play()`, `await ctx.resume()` (up to 1500ms), then POST media-resume to server. All of this happens in the background. Meanwhile:

- `snapPlaybackStart()` resets anchors (`videoAnchor = null, dubAnchor = null`).
- `start()` calls `setInterval(tick, DUB_SYNC_POLL_MS)` and calls `tick()` immediately.
- `tick()` runs: `getDubAudio()` returns `remoteAudio`. `dub.currentTime` is non-zero (preserved from before pause). `opts.video.paused` — is the video playing yet? The `onPlay` handler called `resumeSession`, which means the video IS now playing (the browser fired `play` event). So `video.paused = false`.
- `tick()` sets the anchors: `videoAnchor = video.currentTime; dubAnchor = dub.currentTime`.
- But `remoteAudio` is still PAUSED (AudioContext not yet resumed, `remoteAudio.play()` not yet awaited) — `dub.currentTime` IS non-zero (timeline position preserved) but the audio is still inaudible.

The anchor is set while the audio is still paused/silent (AudioContext suspended, remoteAudio paused). When audio finally resumes (after ctx.resume() completes), `dub.currentTime` may jump if the audio context was suspended (missed time), or the anchor timing may be off.

**A1 fix** (`dub-playback-sync.ts:138-141` — `stopped = false` in `snapPlaybackStart()`) correctly ensures the engine ticks after resume. But the stale anchor issue remains.

**Exact fix:** After `syncSourcePauseState` completes (i.e., after `ctx.resume()` finishes and `remoteAudio.play()` resolves), call `snapPlaybackStart()` + `start()` instead of before. Since the wave made `resumeSession` non-blocking (by design — see the comment at `pause-controller.ts:49-62`), the fix requires either: (a) accepting the stale anchor and relying on the rate corrector to smooth it, or (b) doing a short `setTimeout(0)` defer to let the microtask queue process `remoteAudio.play()` before anchoring.

**Confirming symptom:** After a pause → resume, the dub audio returns but is misaligned with the video for the first 2–5 seconds, then gradually corrects via the rate ramp.

---

### CAUSE 3 — `prepareIntent` for Standard pipeline may race the `buildSession` cold path

**Rank: Possible additional bug; depends on whether popup hover fires before Start.**  
**Classification: Wave regression (new feature from workstream D).**

**Files:**
- `src/content/index.ts:851-877` — `CONTENT_PREPARE_INTENT` handler
- `src/content/pipelines/webrtc-pipeline.ts:134-162` — `prepareIntent` sets `#pendingPrepareId`
- `src/content/pipelines/webrtc-pipeline.ts:349-367` — `buildSession` consumes `prepareId`
- `src/http/routes/rtc.routes.ts:429-467` — server `claimWarmSlot` + `answerWarm`

**Mechanism:** When the popup Start button is hovered (or focused), `PREPARE_INTENT` fires → background relays `CONTENT_PREPARE_INTENT` → content calls `app.webrtc.prepareIntent({ pipeline: s.tier, ... })` → fetches `/v1/rtc/prepare?pipeline=standard` → server allocates a warm transport → returns `prepare_id` → stored in `#pendingPrepareId`.

When `buildSession` runs, it consumes `#pendingPrepareId` and sends `?prepareId=<id>` in the SDP POST. Server calls `rtcPeer.claimWarmSlot()` → `rtcPeer.answerWarm(warmSlot.session, offer, ...)`.

**For dev environment (`RTC_PEER_IMPL=mock`):** The mock warm session (`MockRtcSession`) is never `.markConnected()`. `BridgeRun.run()` calls `this.session.waitConnected(10_000)` which returns `false` immediately (`mock.peer.ts:134-137`). The bridge sends `{ type: "error", code: "peer_connect_timeout" }` via the data channel and closes. The client's `handleMetadataEvent` receives the error and calls `this.app.stopSession(STOP_REASON.SERVER_ERROR)`. **Session immediately fails silently after HTTP 200.**

**For production (`RTC_PEER_IMPL=mediasoup`):** `answerWarm` sets up the warm transport and calls `_attach()`, which wires the DTLS state change → `_resumeOutboundConsumer()` → `_markConnected()`. `waitConnected()` is event-driven and will resolve once DTLS connects. This should work correctly.

**Confirming symptom (dev mode):** Session starts, overlay shows "Connecting", then immediately stops/disappears with no toast. Background state resets to "Stopped". The HTTP 200 is visible in server logs but no audio plays.

**Note:** This is a dev-only regression. Prod uses mediasoup and should be unaffected by the mock peer issue. However, if the developer is testing locally with `RTC_PEER_IMPL=mock`, this IS the cause of "mode broken" for any session started after a popup Start-button hover.

---

### CAUSE 4 — Subtitle-first fallback to Standard-WebRTC clears and re-initializes session state mid-start

**Rank: Potential source of state contamination; pre-existing by design.**  
**Classification: Pre-existing. Not a wave regression.**

**File:** `src/content/pipelines/subtitle-first-pipeline.ts:173-188`

**Mechanism:** When captions are absent, `subtitleFirst.start()` does:
```js
this.#teardownAudio(newSession);     // closes AudioContext
sm.session = null;                   // clears session reference
sm.pageToken += 1;                   // bumps token (any in-flight ops cancelled)
overlay.removeOverlay();             // tears down overlay
const result = await this.app.startWebRtcStandard(incomingSettings);
```

`startWebRtcStandard` then calls `startWebRtcSession`, which:
- Rebuilds the overlay
- Re-sets `sm.settings`
- Calls `sm.nextToken()` again (token is bumped a second time)
- Re-captures the video (including `nudgePlay` since video was paused)

This works correctly. The caption fetch latency (200ms–2s on YouTube, or 0ms if `getPrefetchedCaptions` hits) is the dominant latency for the subtitle-first path. If `fetchCaptions` throws or times out, the fallback to Standard-WebRTC can take up to 5+ seconds before WebRTC even starts.

**Wave note:** `B4` (eager caption prefetch from `NavigationWatcher`) reduces this latency to ~0ms for YouTube VOD if the prefetch completed before Start. Not a regression.

---

### CAUSE 5 — `waitForFirstDub` resolves via `currentTime` on a paused-then-played audio element: `dub.pause()` may interfere with `unmute` routing

**Rank: Subtle; may cause first-segment audio to be inaudible.**  
**Classification: Pre-existing design issue, slightly exacerbated by the wave's C2 delay.**

**Files:**
- `src/content/index.ts:485-492` — `dub.pause()` after `waitForFirstDub`
- `src/content/pipelines/webrtc-pipeline.ts:256-283` — `unmute` event handler

**Mechanism:** After `waitForFirstDub` resolves (ICE connect gate), `dub.pause()` is called on the `<audio>` element. Then `video.play()` runs, then `dub.play()`. The element is in a pause→play cycle. 

The `unmute` event on the remote track fires when the server sends the FIRST real RTP packet (~1.75s after video.play()). The `unmute` handler sets up WebAudio routing (or sets `audio.muted = false`). If `dub.play()` was called BEFORE `unmute` fires, the element is playing but muted. When `unmute` fires, it calls `audio.play()` again to ensure playback. This is generally fine.

However, the `preCtx` (AudioContext) created in `buildSession:189-200` may still be in a `"suspended"` state (Chrome autoplay policy). The `unmute` handler calls `void newSession.audioCtx!.resume().catch(() => {})` (fire-and-forget). If `resume()` fails silently, the WebAudio graph is silent: `dubWebAudioSrc → outputGain → ctx.destination` produces no output. The fallback (`audio.muted = false; audio.volume = dubVol`) is only reached in the `catch` block of the WebAudio setup.

**Wave change:** C2 (`overlay.setOverlayState("connecting")` through the TTFA wait) does not affect AudioContext policy. The `audioCtx.resume()` fire-and-forget in `buildSession:190` may fail before a user gesture.

**Confirming symptom:** Dub audio is completely silent even though `remoteAudio.currentTime` is advancing and the `unmute` event fired. Checking `session.audioCtx.state` would show `"suspended"`.

---

### CAUSE 6 — `StandardDubSync` tick anchors against `remoteAudio` before first RTP arrives

**Rank: Drift issue on initial start; pre-existing with slight wave exacerbation.**  
**Classification: Pre-existing by design.**

**File:** `src/lib/dub-playback-sync.ts:70-110` — `tick()` function

**Mechanism:** After `snapPlaybackStart()` + `start()` (called after video.play() at `index.ts:505-506`), the sync engine begins ticking. `tick()` at line 78: "if `dub.currentTime < 0.05 || opts.video.paused) return`". `currentTime` advances in wall clock (≥0.04s from when `waitForFirstDub` resolved). On the second tick (~100ms later), `currentTime ≥ 0.05` and the anchor is set: `videoAnchor = video.currentTime; dubAnchor = dub.currentTime`.

But at this point the server has NOT yet produced TTS audio (it takes ~1.75s). `dubCurrentTime` will be wall-clock time that does NOT correspond to any actual audio. When TTS audio eventually arrives and starts playing, the anchor is wrong.

**In practice:** The anchor recalibrates on the NEXT tick after audio actually arrives. The `ahead` computation will show a large discrepancy → `aheadEma` spikes → `syncMode` transitions to `catchup` → `playbackRate` is increased to 1.02. This self-corrects within a few seconds but causes a brief stutter/speed-up in the first few seconds of dub playback.

**Confirming symptom:** After 1.75s, the dub starts playing but at 1.02× speed (video playing faster) for ~3–5 seconds before settling. Observable on the overlay's lag readout.

---

### CAUSE 7 — Server voice `English_magnetic_voiced_man`: NOT an issue

**Voice ID is valid.** `resolveStandardVoiceId("English_magnetic_voiced_man")` (`core/src/domain/rtc-pipeline.ts:61`) checks against `STANDARD_VOICE_IDS` from `standard-voices.ts`. `English_magnetic_voiced_man` is `DEFAULT_STANDARD_VOICE_ID` (`standard-voices.ts:4`) and is in the allowlist. Server uses it as-is.

---

## Summary table

| # | Issue | Path | Wave regression? | Severity |
|---|---|---|---|---|
| 1 | `waitForFirstDub` is wall-clock gate, not audio-data gate; sync engine anchors before TTS arrives | Initial start | No (pre-existing, DUB_TTFA_GATE_MS reduction is neutral) | Medium — 1.75s of silent dub + drift correction stutter |
| 2 | `snapPlaybackStart` + `start()` run before `syncSourcePauseState` completes on resume | Pause/resume | YES — non-blocking resume race condition | Medium — A/V desync for ~2–5s after every resume |
| 3 | Mock peer warm slot never connected → immediate `peer_connect_timeout` error | Initial start (dev + popup hover) | YES — new `prepareIntent` + `answerWarm` path | Critical for dev (`RTC_PEER_IMPL=mock`); no-op for prod |
| 4 | Subtitle-first caption fetch → no captions → WebRTC fallback: sequential latency | Initial start | No (pre-existing) | Low — adds 0–2s to start |
| 5 | `AudioContext` stays suspended; `unmute` handler's `resume()` is fire-and-forget | Initial start | No (pre-existing) | High — total silence if AudioContext won't resume |
| 6 | `standardDubSync` anchors against wall-clock `currentTime` before TTS arrives | Initial start | No (pre-existing) | Low — self-corrects in ~3–5s |

---

## Most likely cause of the reported user failure

If testing on the **production server** (mediasoup peer): **Cause 5** (AudioContext suspended → silent dub) is the most likely reason the user hears nothing after HTTP 200. The `AudioContext` is created in `buildSession` outside a user-gesture context (the START relay comes via background message, not direct click). Chrome's autoplay policy may block `resume()`. If this is the case, the `unmute` path silently falls back to `audio.muted = false` (WebAudio setup fails → catch → direct volume), and the dub IS audible. So Cause 5 may not be the culprit either.

**If testing on dev (mock peer) with the popup Start button (hover/focus before click):** **Cause 3** is definitive. The warm slot's mock session is never connected. The bridge closes with `peer_connect_timeout` immediately. This causes a silent stop after HTTP 200.

**If testing on dev (mock peer) WITHOUT popup hover (on-page launcher or direct popup click without hover):** The cold path is used (no prepareId). The mock peer's `waitConnected()` still returns `false` immediately. This means ALL Standard-WebRTC sessions on mock peer fail immediately. This is NOT a wave regression — it's a pre-existing state of the mock peer. BUT the user was testing and it "used to work" → implies `RTC_PEER_IMPL=mock` breaks ALL WebRTC sessions deterministically.

**The MOST LIKELY cause of the user's report ("connects but no dub audio"):**
The HTTP 200 + session setup works. The bridge runs. But the PCM input is silence (video SF6-paused during ICE setup). The server produces no TTS audio. The client's `waitForFirstDub` resolves quickly (ICE-connect wall clock), video plays, sync engine starts. Server then processes first real speech window (~1.75s after video.play()) and sends first TTS audio. **The 1.75s delay between video.play() and first audible dub** is perceived as "no dub audio" if the user stops early or if the AudioContext doesn't resume.

---

## Exact fixes (DO NOT APPLY — read-only report)

### Fix for Cause 2 (wave regression — resume race):
In `pause-controller.ts` `resumeSession`, the `snapPlaybackStart` + `start()` calls need to happen AFTER `syncSourcePauseState` finishes (at least after `applyVideoPauseToSession` completes). Either:
- Make `resumeSession` async and `await syncSourcePauseState(...)`, OR
- Use a `setTimeout(0)` defer to let the microtask queue process `remoteAudio.play()` first, OR  
- Call `snapPlaybackStart()` inside `syncSourcePauseState`'s resolved state (pass a callback)

The cleanest fix: keep resumeSession synchronous (fire-and-forget intent), but defer the `snapPlaybackStart` + `start()` call:
```js
void syncSourcePauseState(app.sm, sess, false).then(() => {
  if (app.sm.session === sess && sess.pipeline === "standard") {
    app.standardDubSync?.snapPlaybackStart();
    app.standardDubSync?.start();
  }
});
```

### Fix for Cause 3 (wave regression — dev mock peer):
In `mock.peer.ts` `prepare()` (line 254), call `session.markConnected()` after creating the session:
```js
// mock.peer.ts:268-270
const session = new MockRtcSession(sessionId);
session.markConnected();  // ← ADD THIS
```

This mirrors the behavior of `answer()` in test harnesses that call `markConnected()` after the answer is returned.

OR: add `markConnected()` inside `answerWarm()` for the mock peer, mirroring the DTLS-connect-triggered path in the mediasoup peer.

### Fix for Cause 1 / Cause 6 (pre-existing — sync anchor timing):
In `standardDubSync.tick()` (`dub-playback-sync.ts:78`), add a check that the dub audio element has actually received media (not just wall-clock time). The `unmute` event on the remote track is the correct signal:
```js
// Add to WebRtcSession:
dubAudioUnmuted: boolean;

// In webrtc-pipeline.ts track.addEventListener("unmute"):
newSession.dubAudioUnmuted = true;

// In dub-playback-sync.ts tick():
if (dub.currentTime < 0.05 || opts.video.paused || !opts.isDubUnmuted?.()) return;
```

---

## Additional symptom info needed to confirm each cause

| Cause | Confirming information needed |
|---|---|
| 1 | Console log showing `remoteAudio.currentTime` advancing before TTS arrives (wall-clock behavior). Check that `unmute` event fires only after ~1.75s of video playback. |
| 2 | After pause → resume, `standardDubSync`'s readout shows a large lag (>1s) immediately on resume that slowly corrects. A/V drift visible in first 2–5s. |
| 3 | Check `RTC_PEER_IMPL` env var on dev server. If `mock`, check if popup Start button was hovered before clicking. Look for `{ type: "error", code: "peer_connect_timeout" }` in the data-channel sentFrames or in content-script console. |
| 4 | Time the `subtitleFirst.start()` caption fetch step in the console. |
| 5 | In browser devtools: `document.querySelectorAll("audio[src]")[0]?.srcObject?.getAudioTracks()[0]?.muted` — should be `false` after unmute. Check `session.audioCtx.state` === `"suspended"` after the dub starts (or fails to start). |
| 6 | Enable overlay's `onReadout` log. A lag spike >2s immediately after first play, followed by rate=1.02 catch-up mode, confirms this cause. |

---

## Files examined

- `src/content/index.ts` — `startWebRtcSession`, `waitForFirstDub` block, C2 overlay changes
- `src/content/pause-controller.ts` — `resumeSession` non-blocking design
- `src/content/pipelines/webrtc-pipeline.ts` — `buildSession`, `prepareIntent`, `#pendingPrepareId`, `track`/`unmute` handlers
- `src/lib/dub-playback-sync.ts` — `waitForFirstDub`, `snapPlaybackStart` (A1 fix), `tick`
- `src/lib/rtc-media-sync.ts` — `syncSourcePauseState` async, `applyVideoPauseToSession` async
- `src/shared/constants.ts` — `DUB_TTFA_GATE_MS = 8000`, `MEDIA_GATE_TIMEOUT_MS = 1500`
- `src/content/launcher.ts` — `START_REQUEST` path
- `src/background/router.ts` — `START_REQUEST` handler → `session.start()` with stored settings
- `src/background/session-coordinator.ts` — `start()` builds `StartSettings` from snapshot
- `src/content/pipelines/subtitle-first-pipeline.ts` — fallback to `startWebRtcStandard` on no-captions
- `server/src/http/routes/rtc.routes.ts` — `handleRtcTranslate`, `prepareId` claim, `answerWarm`
- `server/src/services/rtc-bridge.service.ts` — `BridgeRun.run()`, `#runMinimaxChain()`
- `server/src/providers/translate/audio.pipeline.ts` — `MiniMaxChainAudioProvider.translate()`, `#pcmWindows()`
- `server/src/services/media-playout-scheduler.ts` — playout timing against inbound PCM clock
- `server/src/services/rtc/mock.peer.ts` — `prepare()`, `answerWarm()`, `waitConnected()` → immediate false
- `server/src/services/rtc/mediasoup.peer.ts` — `prepare()`, `claimWarmSlot()`, `answerWarm()`, `_resumeOutboundConsumer()`
- `core/src/domain/standard-voices.ts` — voice allowlist (`English_magnetic_voiced_man` = default, valid)
- `core/src/domain/rtc-pipeline.ts` — `resolveStandardVoiceId`, `isRtcClipShape(standard) = true`
