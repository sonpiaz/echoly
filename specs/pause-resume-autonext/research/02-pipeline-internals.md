# 02 — Pipeline Internals: Pause / Resume / Auto-Next Research

Slice: internal pipeline mechanics — what pause/resume/restart actually touches in each tier.

---

## 1. Subtitle-First Pipeline (`src/content/pipelines/subtitle-first-pipeline.ts`)

### 1a. Structure map

| Concept | Location |
|---|---|
| `start()` | Lines 43–258. Fetches captions, pre-renders 3 sentences, starts `setInterval` (250ms) + `#runRollingRenderer` loop |
| `AbortController` | `newSession.abortController` — created at line 85; `.abort()` called in `stopSession` |
| `playbackTimer` | `setInterval(() => #playbackTick(s), 250)` — line 247; cleared in `stopSession` |
| `#playbackTick()` | Lines 370–496. Four-step: (1) system-pause resume check, (2) external-pause guard, (3) AudioContext health, (4) advance pointer + start cue |
| `#runRollingRenderer()` | Lines 555–609. `while` loop checking `sm.session === s && !s.stopFlag`; inner guard at line 576: `if (sm.videoPaused \|\| (video.paused && !isSystemPaused)) continue` |
| `_systemPaused` | Boolean on `SubtitleFirstSession`; set synchronously BEFORE `video.pause()` in `#enterSystemPause()` (line 335) so DOM `pause` event arrives with flag already true |
| `_bufferWaitStartedAt` | `performance.now()` timestamp for stall cap (SUBFIRST_BUFFER_WAIT_MAX_MS = 8000ms) |
| `_played` flag | Per-sentence boolean; set AT `src.start()` time (line 477), NOT deferred to `onended` |
| `_buffer` | Per-sentence `AudioBuffer | undefined`; populated by `audioCtx.decodeAudioData()` in `#renderBatch()` |
| `sentences[]` | `CaptionSentence[]` with `.start`, `.end`, `.text`, `._played`, `._buffer` |
| `translations[]` | `string[]` parallel array to `sentences[]` |
| `renderCursor` | Index pointing to next sentence to render; initialized to `firstWaveEnd` (line 217) |
| `currentSource` | `AudioBufferSourceNode | null` — the actively-playing node |
| `currentPlayingIdx` | Index of `currentSource` in `sentences[]` |
| `rollingInFlight` | Boolean locking concurrent `#renderBatch` calls in the rolling renderer |
| `stopFlag` | Boolean; set true in `stopSession`; guards `#runRollingRenderer` and `#renderBatch` |

### 1b. Pause idle behavior (user pauses video)

When the user pauses the `<video>` element:

1. The DOM `pause` event fires → `bindCommonVideoListeners.onPause` (index.ts:237) → BUT: the current code calls `stopSession(STOP_REASON.VIDEO_PAUSED)` (index.ts:249). **There is NO idle-on-pause path today.** The session is fully torn down.
2. Before teardown, if `sess._systemPaused === true`, the guard at index.ts:244 short-circuits and skips `stopSession`. This correctly prevents driver-issued pauses from killing the session.
3. The `#playbackTick` step 2 (line 416) also checks `video.paused`: if true, it calls `#stopCurrent(s)` (stops the in-flight clip) and returns. So IF a pause-without-teardown path existed, the driver would naturally go silent — no clip plays while paused.
4. The `#runRollingRenderer` also idles: line 576 `if (sm.videoPaused || (video.paused && !isSystemPaused)) continue` — but `sm.videoPaused` is WebRTC-only (never set by subtitle-first). The `video.paused && !isSystemPaused` term would idle the renderer on a genuine user pause **if the session survived**.

**Conclusion**: The driver behavior on pause is **correct and clean**, but it is unreachable today because `onPause` calls `stopSession` before the tick can observe `video.paused`. The `#playbackTick` and rolling renderer both idle correctly — they only need the session to not be torn down.

### 1c. System-pause vs user-pause distinction

| | `_systemPaused` | User pause |
|---|---|---|
| Source | `#enterSystemPause()` called by the driver itself | User or external event |
| Flag state | `s._systemPaused === true` synchronously before `video.pause()` | `_systemPaused` remains `false` |
| Guard in index.ts `onPause` | Line 244: guard fires, `stopSession` is skipped | No guard, `stopSession` fires |
| Guard in `#playbackTick` step 1 | Runs resume check on every tick | Step 1 is skipped (`_systemPaused` false); step 2 stops the clip |
| Guard in rolling renderer | Line 576: `isSystemPaused === true` exempts this from the idle | `video.paused && !isSystemPaused === true` → renderer idles |

**There is NO current notion of "user paused" as a named state** beyond the natural `video.paused === true` + `_systemPaused === false` combination. There is no `userPaused` boolean, no overlay "Paused" state, and no resume path in the subtitle-first pipeline.

### 1d. Restart-in-place for a new videoId: exact field reset list

To restart subtitle-first for a new video WITHOUT recreating the session object (session.token + audioCtx + outputGain reused), every field below must be reset before re-entering the fetch/render/play sequence:

| Field | Reset to | Why |
|---|---|---|
| `abortController` | `new AbortController()` | The old controller is aborted; all in-flight fetches would get signal cancelled |
| `sentences` | `[]` (then repopulated from new captions) | Old cues must not replay |
| `translations` | `new Array(sentences.length)` | Stale translations from old video |
| `currentSource` | Stop + disconnect the playing node, then null | Old audio clip must not continue |
| `currentPlayingIdx` | `null` | Staleness guard for `onended` |
| `playbackTimer` | `clearInterval(session.playbackTimer)`, then recreate after new prebuffer | Old interval drives old `sentences[]` |
| `renderCursor` | `0` (or `firstWaveEnd` from new video) | Rolling renderer would skip rendering if left at old position |
| `rollingInFlight` | `false` | Any in-flight render for old sentences must be aborted (via new abortController) |
| `stopFlag` | `false` | If set true the rolling renderer loop exits immediately |
| `_systemPaused` | `false` | Must not carry over a buffering-wait state |
| `_bufferWaitStartedAt` | `undefined` | Stall cap must not fire immediately on new video |
| `videoTitle` | re-read from `adapter.getVideoTitle()` | New video has a different title |
| `_onSeeked` | Rebind to new `onSeek` closure (captures new `session` ref) | Old closure points at old sentences[] |
| Per-sentence `._played` | N/A — `sentences[]` is replaced entirely | |
| Per-sentence `._buffer` | N/A — `sentences[]` is replaced entirely | |

**NOT reset / shared across restart**:
- `token` — bump `sm.nextToken()` to invalidate all callbacks that close over old token
- `audioCtx` / `outputGain` — can be reused if not `"closed"` (saves ~80ms re-creation latency). Must call `audioCtx.resume()` if suspended.
- `apiBearer` — same credentials, no change needed
- `kind: "subtitle-first"` — invariant

---

## 2. WebRTC Pipeline (`src/content/pipelines/webrtc-pipeline.ts`)

### 2a. Structure map

| Concept | Location |
|---|---|
| `buildSession()` | Lines 115–336. Creates `RTCPeerConnection`, adds capture tracks, creates DataChannel, wires `track` + `iceconnectionstatechange` events, POSTs SDP to `/rtc/translate`, returns `WebRtcSession` |
| `handleMetadataEvent()` | Lines 338–385. Early returns on `sm.isSessionStale(token)` AND `sm.videoPaused` (line 341). This is the primary gate that silences live translation deltas while paused |
| `requestHandover()` | Lines 387–399. Guard `#handoverInFlight`; delegates to `#requestHandoverInner` |
| `#requestHandoverInner()` | Lines 401–504. Detaches old peer (`detachOutgoingPeer`), calls `buildSession` on same `session.stream`, swaps `sm.session`, re-starts heartbeat, calls `alignRealtimeVodBeforePlay` or `completeStandardHandover` |
| `detachOutgoingPeer()` (lib/rtc-handover.ts) | Drains remoteAudio, removes tracks, closes pc+dc+audioCtx+outputGain, leaves `session.stream` alive |
| `sm.videoPaused` | Set by `syncSourcePauseState()` in `index.ts:onPlay` handler; gating `handleMetadataEvent` |
| Session token guard in `buildSession` | Lines 282, 313, 329: `token !== sm.pageToken` checks |

### 2b. Can handover machinery serve "continue on next video"?

The handover path in `#requestHandoverInner` does:
1. `detachOutgoingPeer(session)` — closes old pc/dc/audioCtx, leaves `session.stream` live
2. `buildSession(newToken, session.stream, {...newOpts})` — POSTs new SDP, returns new WebRtcSession
3. `sm.session = newSession`, re-wire heartbeat, `alignRealtimeVodBeforePlay` or `completeStandardHandover`

**For "continue on next video" this machinery is ALMOST reusable**, with two critical differences:

- The **capture stream** in a handover is the SAME `session.stream` (same tab audio). On a new video the source element changes; whether the stream changes depends on whether `captureWithRetry` was called on the old or new `<video>` element. If the new video is a different `<video>` DOM element, `session.stream` tracks would already be from the old element and might go silent or produce no audio — the stream must be re-acquired via `capture.captureWithRetry(newVideo)`.
- **durationHintSec** must be recomputed from the new video's duration.
- `sm.nextToken()` must be called to invalidate stale callbacks.
- For Standard-WebRTC only: `stopStandardDubSync()` must be called, then `beginStandardDubSync(newVideo)` after the new session is built.

The existing handover path does NOT update `capture.videoEl`, does NOT rebind volume drift guard, and does NOT rebind `bindCommonVideoListeners`. All three must happen for a proper "new video" restart.

**Short answer**: The peer-swap machinery is reusable as a template, but a new-video restart is not a pure handover — it requires re-acquiring capture + rebinding listeners.

### 2c. Does Realtime care about videoId?

No. Realtime WebRTC translates whatever audio flows through the captured `MediaStream`. The pipeline does NOT inspect `videoId`, `location.href`, or caption state. Session-id is a metering handle (`rtcSessionId` from the server). The pipeline will continue translating new video content without knowing the video changed.

**Implication**: for Realtime, "auto-next" is close to free at the pipeline level — the WebRTC bridge keeps streaming. The only actions needed are: reset `sm.currentTargetText`, `sm.currentSourceText`, emit overlay status, optionally call `/end` + open a new session for metering accuracy (depends on product decision), and rebind video listeners to the new `<video>` element.

### 2d. `applyVideoPauseToSession` / `syncSourcePauseState` — what they gate, resume completeness

`applyVideoPauseToSession` (rtc-media-sync.ts:30–54):
- Disables/re-enables audio tracks on the sender (`pc.getSenders()`) and on `session.stream`
- Pauses or resumes `session.remoteAudio` (the dub `<audio>`)
- Suspends/resumes `session.audioCtx`

`syncSourcePauseState` (rtc-media-sync.ts:73–88):
- Sets `sm.videoPaused = paused`
- Calls `applyVideoPauseToSession`
- Fires `notifyServerMediaGate` (POST `/rtc/translate/{id}/media-pause` or `media-resume`)

**Called from**: `index.ts:onPlay` handler (line 260) — only for WebRTC sessions (subtitle-first is guarded out at line 259). The `onPlay` call passes `paused = false` i.e. resume.

**Pause path (where is `syncSourcePauseState(paused=true)` called?)**:
Searching the codebase: the `onPause` handler in `index.ts:237–249` currently calls `stopSession(STOP_REASON.VIDEO_PAUSED)` rather than `syncSourcePauseState`. There is NO current call to `syncSourcePauseState(sm, sess, true)`. The server's `media-pause` endpoint is never invoked on pause — only on resume (but resume path also doesn't exist since stop fires first).

**Resume path completeness**:
The `onPlay` handler (index.ts:250–264) does call `syncSourcePauseState(sm, sess, false)` — this is the resume path. It is wired correctly for WebRTC sessions. However it is currently dead code because pause always calls `stopSession`, so `sm.session` is always `null` by the time `onPlay` would fire after a pause.

**Conclusion for the feature**: Both `applyVideoPauseToSession` and `syncSourcePauseState` are already written with the correct semantics for pause/resume — they just need to be called (pause path: replace `stopSession` with `syncSourcePauseState(sm, sess, true)` + overlay state update, and the resume path already works).

---

## 3. Capture Layer (`src/content/capture.ts`, `src/content/media-stage.ts`)

### 3a. Capture method: captureStream on the video element

Audio is captured via `HTMLVideoElement.captureStream()` (or `mozCaptureStream`) — line 85 in capture.ts. This is **video-element-bound**, not tab-level `chrome.tabCapture`. The stream is acquired by `captureWithRetry()` which:
- Nudge-plays the video element if paused
- Calls `video.captureStream()` and waits for audio tracks to appear (retry loop, max 9s)
- Returns `new MediaStream(stream.getAudioTracks())` — only audio tracks

### 3b. Does the stream survive navigation?

The captured `MediaStream` is tied to the specific `HTMLVideoElement` DOM node. It does **NOT** survive:
- SPA navigation where YouTube replaces the `<video>` element (the old `captureStream()` stream goes silent)
- The video element being removed and re-added to the DOM

The current SPA watcher (index.ts:753–763) detects URL change via `location.href` polling (500ms) and calls `stopSession(STOP_REASON.SPA_NAVIGATION)` — i.e. it already tears down on navigation. There is no reuse.

### 3c. `videoEl`, `isLive()`, `waitForPCConnected`, `applyVolumes`, drift/rate guards

| | Details |
|---|---|
| `capture.videoEl` | Set at pipeline start (subtitle-first:52, webrtc:354); nulled in `stopSession` (index.ts:523). The single source of truth for the active video element |
| `isLive()` | Returns `!video \|\| !isFinite(video.duration)`. Drives SF6 pause-before-connect skip, dub-sync skip, drain strategy |
| `waitForPCConnected()` | Polls `pc.connectionState`; resolves true on "connected", false on "failed"/"closed"/timeout (3s). Called before `video.play()` in WebRTC start |
| `applyVolumes()` | Reads `session.outputGain` (Web Audio path) or `session.remoteAudio` (fallback). Sets `video.volume` + `video.muted`. Also updates `desiredOriginalVol` for the drift guard |
| `bindVolumeDriftGuard()` | `volumechange` listener on the video element — snaps `video.volume` back to `desiredOriginalVol` when YouTube drifts it. Detached via `unbindVolumeDriftGuard()` |
| `bindRateChangeWarn()` | `ratechange` listener — toasts when `playbackRate !== 1×`. Only bound for Realtime (line 369) |

### 3d. What must be re-acquired on a new video?

On a new video element (same or different URL, same `<video>` replaced in DOM):
1. `capture.videoEl` — must be set to the new element
2. `capture.captureWithRetry(newVideo)` — must be called; the old `session.stream` tracks are from the old element and will produce silence or errors
3. `capture.unbindVolumeDriftGuard()` then `capture.bindVolumeDriftGuard(newVideo)` — old listener holds a ref to old element
4. `capture.bindRateChangeWarn(newVideo)` (Realtime only) — same reason
5. `unbindSourcePlayback` + `bindCommonVideoListeners(newVideo, ...)` — old pause/play/ended/seeked listeners are attached to the old element

---

## 4. Session Object & Token Guard (`src/content/session-manager.ts`)

### 4a. `pageToken` stale-guard pattern

`sm.pageToken` is an integer counter, monotonically incremented by `sm.nextToken()` each time a new session or handover begins. Every async callback that was started before the bump closes over the old token and calls `sm.isSessionStale(token)` to detect staleness.

`isSessionStale(token)` (line 150):
```
return token !== this.pageToken && this.session?.token !== token;
```
The handover-safe second clause (`session?.token !== token`) keeps the new session's token alive even after the pageToken moves again.

**Bumping `pageToken` (via `nextToken()`) invalidates**:
- All `#renderBatch` fetch chains (check `sm.session !== s || s.stopFlag`)
- All `buildSession` SDP / ICE async steps (check `token !== sm.pageToken`)
- All `handleMetadataEvent` calls (check `sm.isSessionStale(token)`)
- The `#runRollingRenderer` `while` loop (check `sm.session === s && !s.stopFlag`)
- ICE disconnect timer (check `sm.isSessionStale(token)`)

### 4b. Session union type

```typescript
type Session = WebRtcSession | SubtitleFirstSession
```

`WebRtcSession` fields: `token, pc, dc, stream, remoteAudio, audioCtx, outputGain, rtcSessionId, apiBearer, pipeline, targetLanguage, voice`

`SubtitleFirstSession` adds: `kind:"subtitle-first", abortController, sentences, translations, currentSource, currentPlayingIdx, playbackTimer, renderCursor, rollingInFlight, stopFlag, _onSeeked, _systemPaused, _bufferWaitStartedAt, videoTitle`

### 4c. `sm.videoPaused`

WebRTC-only gate (comment at line 97: "ignore live metadata updates"). Set by `syncSourcePauseState`. Never set to `true` by the current code (see §2d). In `#runRollingRenderer` line 576, the check `sm.videoPaused` would idle the rolling renderer but this path is also currently dead.

### 4d. Heartbeat (`startHeartbeat` / `stopHeartbeat`) — Realtime only

`startHeartbeat()` calls `POST /rtc/translate/{rtcSessionId}/heartbeat` every `HEARTBEAT_MS`. It is Realtime-only (started at index.ts:444 guarded by `pipeline === TIER_REALTIME`). Standard and subtitle-first never start it. `stopHeartbeat()` is called in `stopSession` (index.ts:511).

**For pause/resume**: if the session is kept alive during a user pause, the heartbeat must keep running (it holds the server's live reservation). For a genuine idle pause this is fine — the heartbeat POST is cheap. Stopping it during pause would forfeit the server slot.

### 4e. Session timer (`startSessionTimer` / `clearSessionTimer`)

`warningTimer` (toasts at SESSION_WARNING_MS) and `limitTimer` (auto-stop at SESSION_LIMIT_MS). Both are cleared in `stopSession`. If a pause-without-teardown path is built, the session timer must be paused (or the 60-min clock runs while the user is watching paused video). This is a product decision: pause the timer during video pause, or let it keep counting.

### 4f. `emitState` / `notifyBackground` in a restart

`emitState` sends `CONTENT_STATE` to the background with `running, paused, status`. For a restart-in-place:
- When pause fires: emit `{ running: true, paused: true, status: "Paused" }` (new behavior)
- When new video starts: emit `{ running: true, paused: false, status: "Translating" }` (same as today)
- `notifyBackground({ type: "UPDATE_SETTINGS", settings })` is sent on handover to keep popup in sync

---

## 5. Standard VOD Dub-Sync (`lib/dub-playback-sync.ts`, `lib/dub-sync-engine.ts`, `lib/standard-vod-start.ts`)

### 5a. When does Standard use WebRTC + dub-sync vs subtitle-first?

Decision is in `startSession()` (index.ts:306–319):

```
if (
  tier === TIER_STANDARD &&
  !opts?.forceWebRtcStandard &&
  adapter.capabilities.subtitleFirst &&       // platform has captions
  adapter.getVideoId(location.href) &&        // URL has a video id
  videoProbe &&
  !liveProbe                                  // not a live stream
) → subtitleFirst.start()
```

Otherwise: `startWebRtcSession()` → WebRTC Standard (Gemini audio-in → TTS). Platforms currently with `subtitleFirst: true`: YouTube VOD, Coursera VOD. Udemy: DRM, `audioCapture: false`, falls through from subtitle-first to `NO_CC_UNSUPPORTED`. Live streams always use WebRTC.

### 5b. Pause/resume interaction with dub-sync engine

`bindStandardDubPlaybackSync` (dub-playback-sync.ts) returns a handle with `start()`, `stop()`, `snapPlaybackStart()`, `waitForFirstDub()`.

The `tick()` function (line 70):
```typescript
if (stopped || opts.isUserPaused()) return;
```
`isUserPaused` is the closure `() => this.sm.videoPaused` (index.ts:161). So the dub-sync tick already idles when `sm.videoPaused === true`. **This is already correctly gated** — IF `sm.videoPaused` is set true during a user pause, the sync engine stops adjusting `video.playbackRate` automatically.

`snapPlaybackStart()` resets `videoAnchor`, `dubAnchor`, `aheadEma`, `syncMode`, `appliedRate` and restores `video.playbackRate = 1`. It must be called on resume (before `video.play()` + `dub.play()`) to re-anchor the sync at the new joint start point.

`stop()` also resets all state and restores `playbackRate = 1`. Called in `stopStandardDubSync()` which is called in `stopSession` and `prepareStandardHandover`.

**For pause/resume with Standard WebRTC**: on pause, call `sync.stop()` (resets rate to 1 so video doesn't keep slow/catching up while paused). On resume, call `sync.snapPlaybackStart()` + `sync.start()` to re-anchor at the resume point. Do NOT call `snapPlaybackStart` before the dub actually resumes playing or the anchor will be wrong.

**`isUserPaused`**: this is the correct hook for the sync engine to idle, but currently `sm.videoPaused` is never set true (see §2d). The hook is already wired — it just needs the pause path to set `sm.videoPaused = true`.

---

## 6. Recommended Minimal Restart Per Tier

### 6a. Subtitle-first — restart for a new video

**Context**: subtitle-first binds audio to sentence arrays from a specific video's captions. A new video requires entirely new sentences. The session object (audioCtx, token) can be reused; the peer infrastructure is just the AudioContext (no WebRTC).

Minimal restart sequence:
1. Stop and disconnect `session.currentSource` (if any)
2. `clearInterval(session.playbackTimer); session.playbackTimer = null`
3. `session.abortController.abort(); session.abortController = new AbortController()`
4. `session.stopFlag = false` — rolling renderer loop exits on `stopFlag`; but since we're NOT exiting the session, instead the `sm.session === s` check keeps the renderer alive. Actually: the rolling renderer is a self-driven `while` loop started by `start()` and checks `sm.session === s` — it must be allowed to exit and restarted for the new video. Set `session.stopFlag = true` briefly to kill the old renderer, then reset to `false` before starting the new loop.
5. Reset sentence arrays: `session.sentences = []; session.translations = []`
6. `session.renderCursor = 0; session.rollingInFlight = false`
7. `session.currentSource = null; session.currentPlayingIdx = null`
8. `session._systemPaused = false; session._bufferWaitStartedAt = undefined`
9. `session.videoTitle = undefined` (re-read after new captions)
10. `session._onSeeked` will be rebound by `bindCommonVideoListeners`
11. Bump `sm.nextToken()` to invalidate any in-flight fetches
12. Update `capture.videoEl` to new video; rebind `bindVolumeDriftGuard`, `unbindSourcePlayback`
13. Fetch new captions, pre-render first batch, restart `playbackTimer`
14. Restart `#runRollingRenderer` with new session ref

**Must NOT destroy**:
- `session.audioCtx` / `session.outputGain` — reuse; call `audioCtx.resume()` if suspended
- `sm.session` pointer itself — must not be nulled (or stopSession would fire)
- The overlay — stays mounted, update status text only
- `sm.pageToken` (bumped by `nextToken()`, not reset)

### 6b. Standard-WebRTC — restart for a new video

Standard-WebRTC uses: a captured `MediaStream` from `captureWithRetry`, a `RTCPeerConnection` to the server, an optional `StandardDubPlaybackSyncHandle`, and no sentence arrays.

Minimal restart sequence:
1. `stopStandardDubSync()` — stops dub-sync, resets playbackRate
2. `detachOutgoingPeer(session)` — drains remoteAudio, closes pc/dc/audioCtx/outputGain, leaves `session.stream` intact IF it's still valid for the new video element. If the `<video>` element changed, stop the old stream tracks too.
3. Re-acquire audio if video element changed: `stream = await capture.captureWithRetry(newVideo)`
4. Bump `sm.nextToken()`
5. Update `capture.videoEl`, rebind `bindVolumeDriftGuard`, `unbindSourcePlayback`
6. `buildSession(newToken, stream, {...opts, durationHintSec: computedFromNewVideo})`
7. `sm.session = newSession`
8. `beginStandardDubSync(newVideo)` + `waitForFirstDub()` + `snapPlaybackStart()` + `start()`
9. Resume `video.play()` + `dub.play()`, emit state

**Key difference from handover**: Handover reuses `session.stream` (same video element, same `<video>` captureStream, only language/voice changes). A new-video restart requires re-acquiring the stream because `captureStream()` is element-bound.

### 6c. Realtime — restart for a new video

Realtime is the simplest case at the pipeline level because it is video-content-agnostic:

Option A (soft restart — keep the WebRTC session, just update text state):
1. Reset `sm.currentTargetText = ""; sm.currentSourceText = ""; sm.translationUtteranceOpen = false; sm.translationSegmentId = null`
2. Update `capture.videoEl`, rebind `bindVolumeDriftGuard`, `unbindSourcePlayback`
3. Overlay: clear captions, `setStatusText("Translating")`, `setOverlayState("live")`
4. Emit `{ running: true, paused: false, status: "Translating" }`

Option B (hard restart — end old session, start new one, for clean metering):
1. Same as Standard-WebRTC restart but without dub-sync steps
2. `sm.stopHeartbeat()`; send `/end` to old session
3. `detachOutgoingPeer(session)`; re-acquire stream if video element changed
4. Bump `sm.nextToken()`
5. `buildSession(newToken, stream, {pipeline:"realtime", ...})` 
6. `sm.session = newSession`; `sm.startHeartbeat(newSession.rtcSessionId, ...)`
7. `alignRealtimeVodBeforePlay(...)` + `video.play()`

**Product recommendation**: Option B for metering accuracy (old video's session committed/ended, new video gets its own metering slot). Option A for pure UX continuity (zero reconnect latency, but the old session's metering window continues accumulating against the new video's content).

---

## 7. Shared State That Must NOT Be Destroyed During Restart

The following are shared by the background channel and/or the overlay session and must persist across an in-place restart:

| State | Location | Why it must survive |
|---|---|---|
| `sm.pageToken` | SessionManager | Must be bumped via `nextToken()`, not reset to 0 — old callbacks use token value comparison |
| `overlay` instance | ContentApp | Overlay DOM is mounted; removing it tears down the UI. Update status text in place |
| `sm.settings` | SessionManager | Settings (target language, voice, bearer, apiBase) are reused or updated in place |
| `sm.apiBase` | SessionManager | Same proxy endpoint |
| `sm.history` | SessionManager | Should be preserved (user can review history across video transitions) — product decision |
| `sm.runtimeAlive` | SessionManager (private) | Runtime liveness; if the runtime died mid-session, restart is moot |
| `capture.lastAppliedSinkId` | AudioCapture | Avoids redundant `setSinkId` on restart |
| Background `state.isRunning` | Background (separate) | The popup shows "Running" — keep it consistent with emitState |

**Token bump propagation**: calling `sm.nextToken()` causes all closures over the old token to self-invalidate via `sm.isSessionStale(old_token)`. This is the correct mechanism; do NOT null out `sm.session` before the new session is ready (that would cause `onPause` / `onPlay` DOM events to be ignored because `!sess` returns early).

---

## 8. Key Findings Summary

### Pause idle behavior per tier (current code)

| Tier | Current behavior on video pause | Correct idle behavior (what code does if session survives) |
|---|---|---|
| Subtitle-first | `stopSession(VIDEO_PAUSED)` — full teardown | `#playbackTick` step 2 stops current clip; `#runRollingRenderer` idles — CORRECT, just unreachable |
| WebRTC Standard | `stopSession(VIDEO_PAUSED)` — full teardown | `syncSourcePauseState(paused=true)` disables tracks + pauses dub + suspends AudioCtx + notifies server; dub-sync `isUserPaused()` idles rate adjust — WIRED, not called |
| Realtime | `stopSession(VIDEO_PAUSED)` — full teardown | Same as Standard WebRTC; additionally `handleMetadataEvent` gates on `sm.videoPaused` already — WIRED |

**Root cause**: `index.ts:onPause` (line 248) calls `stopSession` unconditionally. This is a single-line change to enable pause: replace with `syncSourcePauseState(sm, sess, true)` + overlay update for WebRTC, or set a user-pause flag + overlay update for subtitle-first.

### Is resume already wired?

| Tier | Resume path |
|---|---|
| Subtitle-first | `onPlay` in index.ts:259 guards out subtitle-first (returns early). The `#playbackTick` step 2 will naturally resume on next 250ms tick when `video.paused` becomes false. AudioContext resumes via step 3. **Effectively wired but never exercised** |
| WebRTC Standard | `onPlay` calls `syncSourcePauseState(sm, sess, false)` at line 260 — this re-enables tracks, calls `remoteAudio.play()`, resumes AudioCtx, notifies server. **Resume path is complete and correct** |
| Realtime | Same as Standard WebRTC for the media layer. `handleMetadataEvent` will un-gate on `sm.videoPaused = false`. **Complete** |

For Standard WebRTC on resume: `snapPlaybackStart()` + `sync.start()` must also be called to re-anchor the dub-sync at the new resume point — this is the one missing piece in the current resume path.

### Exact reset lists for restart (new video)

**Subtitle-first**: abortController (new), sentences[], translations[], renderCursor=0, rollingInFlight=false, currentSource=null, currentPlayingIdx=null, playbackTimer (clear+restart), stopFlag=false, _systemPaused=false, _bufferWaitStartedAt=undefined, videoTitle (re-read), _onSeeked (rebind), pageToken (bump). Preserve: audioCtx, outputGain, token (use nextToken), apiBearer, overlay, settings.

**Standard-WebRTC**: stopStandardDubSync(), detachOutgoingPeer(), re-acquire stream (if new `<video>`), pageToken (bump), rebuild session via buildSession(), beginStandardDubSync(), snapPlaybackStart()+start(). Rebind: capture.videoEl, bindVolumeDriftGuard, bindCommonVideoListeners.

**Realtime** (hard restart): stopHeartbeat(), endRtcSession(), detachOutgoingPeer(), re-acquire stream (if new `<video>`), pageToken (bump), buildSession(), startHeartbeat(). Rebind: capture.videoEl, bindVolumeDriftGuard, bindCommonVideoListeners. Reset: currentTargetText, currentSourceText, translationUtteranceOpen, translationSegmentId.

### Shared state that a restart must NOT destroy

overlay instance, sm.settings, sm.apiBase, sm.pageToken monotonicity (bump, don't reset), capture.lastAppliedSinkId, sm.runtimeAlive, background running state (emitState must keep `running: true`).
