# Research Report: Startup Latency — "Start Dubbing" to First Audio

**Researcher:** Agent (read-only research slice)
**Date:** 2026-06-02
**Scope:** Both tiers — Standard subtitle-first (YouTube VOD) and Realtime WebRTC.
**Goal:** Identify every latency source between pressing "Start dubbing" and first audible dubbed audio.

---

## 1. Complete Numbered Timeline: Popup → First Audio

### 1A. Shared Path (both tiers — steps 1–8)

| Step | What happens | File : line | Blocking nature |
|------|-------------|-------------|-----------------|
| 1 | User clicks "Start dubbing" button in popup | `src/popup/index.ts:792` | JS microtask (instantaneous) |
| 2 | `onToggle()` sends `{type: "START", settings}` to background via `chrome.runtime.sendMessage` | `src/popup/index.ts:741`, `src/shared/protocol.ts` | Async IPC round-trip to SW. Typically ~2–5 ms when SW is warm; **up to 1–2 s if the MV3 service worker has been terminated** (cold start). SERIAL. |
| 3 | Background `router.ts:handlePopupMessage` receives START, calls `session.start(settings)` | `src/background/router.ts:165` | Routing only (sync) |
| 4 | `session-coordinator.start()`: `persistSettings` (chrome.storage.local write) | `src/background/session-coordinator.ts:161` | Async disk I/O ~5–20 ms. SERIAL. |
| 5 | `resolveApiMode()` — reads session token from cookie store. If SW is warm and `cachedUser` is already populated, just reads cookie (fast: ~5–15 ms). If no cached user, calls `auth.fetchUser(token)` which is a full `GET /v1/session/bootstrap` HTTP round-trip. | `src/lib/api-mode.ts:33–46`, `src/background/session-coordinator.ts:168` | **Potentially SERIAL network round-trip (100–500 ms) if user not cached in store.** Can be avoided if store already has signedInUser. |
| 6 | `sessionTabForStart()` — two `chrome.tabs.query` calls to find the video tab | `src/background/session-coordinator.ts:114–127` | Two async API calls ~2–10 ms each. SERIAL. |
| 7 | `ensureContentScript()` — PING to content script; if no reply, injects `content-scripts/content.js` via `chrome.scripting.executeScript` | `src/background/session-coordinator.ts:132–153` | Injection can take 100–300 ms on large pages. SERIAL. Idempotent — fast (one message round-trip) if already injected. |
| 8 | Background sets `connecting=true`, broadcasts to popup → popup shows "Connecting" | `src/background/session-coordinator.ts:193–195` | First visible UI feedback to user. |
| 9 | `relayToContent(tabId, {type: "CONTENT_START", settings})` — SW → content script IPC | `src/background/session-coordinator.ts:219` | ~1–5 ms IPC. SERIAL (SW awaits `reply.ok`). |

---

### 1B. Standard Subtitle-First Pipeline (YouTube VOD) — after step 9

| Step | What happens | File : line | Blocking nature |
|------|-------------|-------------|-----------------|
| 10 | `content/index.ts → startSession()` → detects subtitle-first path → calls `subtitleFirst.start()` | `src/content/index.ts:311–321` | Sync |
| 11 | `buildOverlay()` — DOM construction + layout injection | `src/content/overlay/overlay.ts:572–717` | Sync DOM work, fast (<10 ms) |
| 12 | Overlay shows **"Loading captions"** | `src/content/pipelines/subtitle-first-pipeline.ts:65` | First user feedback on-page |
| 13 | `video.pause()` — video is stopped immediately | `src/content/pipelines/subtitle-first-pipeline.ts:122–126` | Sync; **the user's video pauses here** — the "freeze" moment |
| 14 | `adapter.fetchCaptions()` → `fetchYouTubeCaptions()`: 3-layer acquisition (intercept cache → DOM script scrape → timedtext fallback). Intercept first asks background cache, then may trigger CC button click and poll 100 ms intervals up to 1800 ms. DOM scrape is synchronous. Fallback is up to 3 sequential HTTP fetches. | `src/platforms/youtube/captions-fetch.ts:55–206`, `src/platforms/youtube/captions-fetch.ts:144–206` | **SERIAL. Worst-case ~2–3 s** (intercept timeout 1800 ms + fallback fetches). Best case (cache hit): ~15–30 ms. |
| 15 | `regroupToSentences()` — parse + group caption cues | `src/lib/caption-utils.ts` | CPU-only, fast (<5 ms) |
| 16 | Overlay shows "Translating N lines" | `src/content/pipelines/subtitle-first-pipeline.ts:182` | |
| 17 | **`#renderBatch()`** — POST `/v1/translate/subtitles` with first `SUBFIRST_PREBUFFER_COUNT=3` sentences. Server does Gemini translate + MiniMax TTS for each line, returns base64 MP3 audio. | `src/content/pipelines/subtitle-first-pipeline.ts:195–209`, `src/lib/echoly-api.ts:44–85` | **DOMINANT LATENCY. SERIAL. One HTTP round-trip serving translate+TTS for 3 sentences. Realistically 1.5–4 s** (server LLM + TTS latency). |
| 18 | `audioCtx.decodeAudioData()` on each returned MP3 | `src/content/pipelines/subtitle-first-pipeline.ts:494` | CPU-bound per buffer decode, ~5–30 ms each. Done inside renderBatch, same await. |
| 19 | `video.play()` — video resumes | `src/content/pipelines/subtitle-first-pipeline.ts:236` | Async |
| 20 | `#playbackTick()` fires immediately — plays first buffered cue via `AudioBufferSourceNode.start()` | `src/content/pipelines/subtitle-first-pipeline.ts:253` | **First dubbed audio** |

**Standard subtitle-first total (typical YouTube with cached captions):**
- Steps 1–9: ~200–500 ms (background path + content inject if warm)
- Step 14: 15–1800 ms (caption fetch, best/worst)
- Step 17: 1500–4000 ms (translate+TTS batch)
- **Total: ~2–5 s** from click to first audio. Video is paused for steps 13–19.

---

### 1C. Realtime WebRTC Pipeline — after step 9

| Step | What happens | File : line | Blocking nature |
|------|-------------|-------------|-----------------|
| 10 | `content/index.ts → startSession()` → falls through to `startWebRtcSession()` | `src/content/index.ts:324` | Sync |
| 11 | `buildOverlay()` + `overlay.syncFromSettings()` | `src/content/index.ts:364–374` | Sync DOM work |
| 12 | Overlay shows **"Acquiring audio"** | `src/content/index.ts:375` | First on-page feedback |
| 13 | `capture.captureWithRetry(video, 9000)` — calls `video.captureStream()`. Retries 300 ms intervals for up to 9 s if stream has no audio tracks. | `src/content/capture.ts:66–93` | **SERIAL. Usually 0–300 ms on a playing video; up to 9 s worst-case (video not playing / media pipeline not hot).** |
| 14 | For VOD: `video.pause()` | `src/content/index.ts:387` | Sync; **the user's video pauses here** |
| 15 | `new RTCPeerConnection()` + `addTrack()` + `createDataChannel()` + `new AudioContext()` | `src/content/pipelines/webrtc-pipeline.ts:128–155` | Sync ~1–5 ms |
| 16 | `pc.createOffer()` | `src/content/pipelines/webrtc-pipeline.ts:295` | Async ~5–20 ms |
| 17 | **POST `/v1/rtc/translate?pipeline=realtime&…` with SDP offer body** — server provisions OpenAI WebRTC relay, returns SDP answer + session id | `src/content/pipelines/webrtc-pipeline.ts:321–325` | **SERIAL. Dominant network round-trip: ~200–600 ms** (server-side mediasoup + OpenAI relay setup). |
| 18 | `pc.setRemoteDescription()` → ICE candidate gathering begins | `src/content/pipelines/webrtc-pipeline.ts:347` | Async, begins ICE |
| 19 | `waitForPCConnected(pc, 3000)` — waits for ICE `connected` state | `src/content/index.ts:463` | **SERIAL. Typically 200–800 ms** (ICE + DTLS handshake). Timeout 3 s. |
| 20 | For Realtime VOD: `alignRealtimeVodBeforePlay()` — polls up to 2 s for remoteAudio element to appear, then adds a fixed `REALTIME_VOD_PLAY_ALIGN_MS = 80 ms` sleep | `src/content/index.ts:483`, `src/lib/standard-vod-start.ts:12–22` | **SERIAL intentional delay: 80–2080 ms**. Designed to let the inbound WebAudio track settle. This is a gratuitous fixed sleep. |
| 21 | `video.play()` resumes source video | `src/content/index.ts:491` | Async |
| 22 | `track.unmute` event fires on remote track → Web Audio graph connected → audio flows | `src/content/pipelines/webrtc-pipeline.ts:209–236` | Event-driven; no additional delay once ICE is connected |
| 23 | `sm.emitState({ running: true })` → background marks running, popup shows "Translating" | `src/content/index.ts:505` | IPC message, fast |

**Realtime total (VOD, happy path):**
- Steps 1–9: ~200–500 ms
- Step 13: 0–300 ms (captureStream, playing video)
- Step 16–17: ~250–650 ms (createOffer + SDP round-trip)
- Step 19: ~200–800 ms (ICE)
- Step 20: 80–2080 ms (alignRealtimeVodBeforePlay — mostly gratuitous)
- **Total: ~800 ms – 3.5 s** from click to first audio

**Realtime total (Live stream, happy path):**
- No video.pause()/play() gate (step 14 skipped)
- captureStream is fast
- Same SDP+ICE (~450–1300 ms)
- No `alignRealtimeVodBeforePlay` call (live path goes straight to `sm.emitState`)
- **Total: ~700 ms – 1.5 s**

---

### 1D. Standard WebRTC Fallback (no captions available)

When `fetchCaptions()` returns empty, the subtitle-first pipeline falls back to `startWebRtcStandard()` (same as Realtime but `pipeline=standard`). In this case:

- All steps 1–14 of subtitle-first already ran (including caption fetch timeout)
- Then full WebRTC flow restarts: `buildSession` + additional gate `waitForFirstDub(14_000)` (up to 14 s TTFA gate)
- **Total worst-case: 3–20 s**

---

## 2. Top 5 Latency Culprits (Ranked by Impact)

### #1 — `#renderBatch()`: Initial TTS Batch (Standard subtitle-first)
**Estimated latency: 1.5–4 s (SERIAL, unavoidable in current design)**

`src/content/pipelines/subtitle-first-pipeline.ts:195–209` and `src/lib/echoly-api.ts:44–85`

The pipeline sends a POST to `/v1/translate/subtitles` requesting translation + TTS audio for `SUBFIRST_PREBUFFER_COUNT=3` sentences before unpausing video. This is the longest single blocking step. The entire startup is gated on this one HTTP round-trip because `video.pause()` happens at step 13 and `video.play()` only runs after the batch returns.

**Optimization opportunities:**
- **Opportunistic prefetch on hover/focus:** Begin `fetchCaptions()` when the user opens the popup (before clicking Start). The caption fetch result could be cached page-side.
- **Reduce prebuffer count:** `SUBFIRST_PREBUFFER_COUNT=3` means 3 lines of TTS before first audio. Reducing to 1 would cut this to ~800 ms–1.5 s, at risk of buffer starvation on very dense captions.
- **Start video immediately with 1 pre-buffered sentence:** Play video right after the first sentence's buffer is ready, while rolling renderer fetches ahead. The `_systemPaused` stall mechanism already handles buffer starvation — trust it.
- **Streaming response from server:** If `/v1/translate/subtitles` could stream results (NDJSON or chunked), the first audio buffer could be decoded while translation of later sentences is still in flight.
- **Cross-slice concern (server):** The server's translate+TTS endpoint is not streaming today. This is the single highest-impact change.

---

### #2 — `alignRealtimeVodBeforePlay()`: Fixed 80ms Sleep + 2s Polling (Realtime VOD)
**Estimated latency: 80 ms to 2.08 s (SERIAL, entirely avoidable)**

`src/lib/standard-vod-start.ts:12–22`, called from `src/content/index.ts:483`

```ts
while (Date.now() < deadline) {
  if (getDubAudio()) break;
  await sleep(40);
}
if (alignMs > 0) await sleep(alignMs); // REALTIME_VOD_PLAY_ALIGN_MS = 80
```

This waits up to 2 s for `remoteAudio` to appear, then unconditionally sleeps an additional 80 ms. The `remoteAudio` element is set in the `pc.ontrack` handler (`webrtc-pipeline.ts:199`), which fires when the server sends its first media track. If ICE is connected (step 19 already awaited this), the `ontrack` event typically has ALREADY fired — the sleep loop exits on the first poll. Then an extra 80 ms is added regardless.

**Optimization opportunities:**
- **Event-driven instead of polling:** Attach a one-shot `ontrack` listener that resolves the promise, with a timeout fallback. No polling, no fixed delay needed.
- **Eliminate the 80 ms fixed sleep:** The comment says "lets the inbound track + WebAudio graph settle." Once `track.unmute` fires and the WebAudio graph is built (`webrtc-pipeline.ts:209–236`), the graph IS settled. The 80 ms is a pure guess with no empirical basis in the TS codebase.
- **On Realtime Live:** This function is not called (step 20 is skipped for live). The 80 ms only affects VOD. But for VOD, eliminating it saves a guaranteed 80 ms plus the polling window.

---

### #3 — Service Worker Cold Start Latency (both tiers)
**Estimated latency: 0 ms (warm) to 1.5 s (cold SW restart)**

`src/popup/index.ts:741` → `sendToBackground()` → `chrome.runtime.sendMessage`

MV3 service workers are terminated after ~30 s of inactivity. When the popup opens after a period of idle, the first `sendMessage` must wake the SW. The `chrome.runtime.sendMessage` call will hang until the SW is running. The browser typically restarts an MV3 SW in 200–800 ms, but on some systems can reach 1–1.5 s.

**Optimization opportunities:**
- **Keep-alive on popup open:** When the popup opens (`GET_STATE`), send a no-op keepalive ping immediately before the state query. This doesn't speed up the cold start itself but is the first access point.
- **Optimistic UI render:** The popup can render its last-known cached state from `chrome.storage.local` synchronously before waiting for `GET_STATE` to return. Currently the popup shows "loading" skeleton until `GET_STATE` resolves.
- **SW wake-up on popup open (MV3 best practice):** Use `chrome.storage.local` writes from the popup to trigger SW wake-up as a side-effect before `sendMessage`.

---

### #4 — Caption Fetch via Intercept/Fallback (Standard subtitle-first)
**Estimated latency: 15 ms (cache hit) to ~3 s (full fallback chain)**

`src/platforms/youtube/captions-fetch.ts:55–206`

`fetchYouTubeCaptions` runs up to 3 layers:
1. Background cache (fast if YT network request was intercepted)
2. CC button trigger + polling loop: up to 1800 ms (`timeoutMs=1800`, 100 ms intervals)
3. DOM `ytInitialPlayerResponse` scrape (sync, fast)
4. Up to 3 sequential `fetch()` calls to timedtext API

The intercept-based approach (layer 1+2) is the primary path. The polling loop (`while (Date.now() - start < timeoutMs)` in `fetchCCViaIntercept`) introduces up to 1.8 s of delay when the background has no cached URL and the CC button click must trigger a new network request.

**Optimization opportunities:**
- **Prefetch on video navigation:** When the content script detects navigation to a new video (which `NavigationWatcher` already does), eagerly trigger `fetchCaptions()` in the background and cache the result before the user hits Start. If the user starts within ~5 s of navigation, captions are already ready.
- **Reduce CC intercept timeout:** The 1800 ms intercept timeout is very generous. The DOM scrape fallback (`readPlayerResponseFromDom`) succeeds quickly when `ytInitialPlayerResponse` is available (which it almost always is on YT watch pages). Trigger the DOM scrape in parallel with the intercept instead of sequentially.
- **Parallel DOM scrape:** Currently layers are tried in series. Layer 2 (DOM scrape) could start at the same time as layer 1 (background cache check), with first-to-succeed wins.

---

### #5 — `waitForFirstDub()` TTFA Gate (Standard WebRTC fallback)
**Estimated latency: up to 14 s (hard cap)**

`src/lib/dub-playback-sync.ts:114`, called from `src/content/index.ts:468–469`
`DUB_TTFA_GATE_MS = 14_000` (constants.ts:62)

For Standard WebRTC mode (when subtitle-first falls back, or on non-YouTube platforms), the startup is gated on `waitForFirstDub()` which polls every 80 ms until `dub.currentTime > 0.04`, up to 14 seconds. The video stays paused during this entire wait. In practice, first dub audio appears within 3–6 s, but 14 s is the theoretical cap.

**Optimization opportunities:**
- **Lower the timeout:** 14 s is user-hostile. 6–8 s is more appropriate; let the rolling renderer handle starvation.
- **Play video earlier:** Instead of waiting for `dub.currentTime > 0.04` (i.e., actual audio data from the remote), start video play as soon as ICE is `connected`. The dub-sync engine will detect lag and adjust playback rate. This removes the absolute hard gate.
- **Optimistic UI:** Show "Synchronising dub..." overlay state to signal the system is working, rather than keeping the video frozen with no feedback during this entire window.

---

## 3. Serial vs Parallel Analysis

The startup sequence has several operations that could be parallelized but currently run serially:

| Operations (currently serial) | Could run in parallel | Savings |
|---|---|---|
| `persistSettings` + `sessionTabForStart()` | Yes — storage write and tabs.query are independent | ~5–20 ms |
| `caption fetch` layer 1 (background) + layer 2 (DOM scrape) | Yes — currently sequential waterfall | saves up to 1.8 s |
| `captureWithRetry` + `buildOverlay` (WebRTC path) | Yes — overlay build is sync DOM work, can proceed while capture awaits | saves ~5–10 ms (minor) |
| `fetchCaptions` + caption pre-rendering (warm user, before Start) | Yes if started pre-emptively | saves entire caption fetch time |
| The entire caption fetch + first batch fetch | Partially — could prefetch at page load/popup open | saves 2–5 s |

---

## 4. UX Feedback Analysis: What the User Sees During the Wait

| Phase | Overlay status text | Popup status | Notes |
|---|---|---|---|
| Steps 1–8 (SW/injection) | Not yet shown | "Connecting" | Popup may take 200–500 ms to show Connecting if SW cold-starts |
| Step 12 (subtitle-first) | "Loading captions" | "Connecting" | First on-page feedback |
| Step 13 | — | — | **VIDEO FREEZES HERE (both tiers)** |
| Steps 14–16 (subtitle-first) | "Loading captions" → "Translating N lines" | "Connecting" | User sees frozen video + loading text. No progress indicator. |
| Step 17 (renderBatch, 1.5–4 s) | "Translating N lines" | "Connecting" | **The dead zone: nothing changes for 1.5–4 s.** |
| Step 17 complete | "Translating" | "Connecting" | Just before video plays |
| Step 20 | "Translating" | "Dubbing to [lang]" | First audio |

For Realtime:
- Overlay shows "Acquiring audio" → "Connecting" → "Almost ready" → "Translating"
- The "Connecting" → "Almost ready" transition spans ICE (200–800 ms) + alignRealtimeVodBeforePlay (80–2080 ms)
- No progress indication during ICE setup

**UX gap:** The overlay status text changes (from "Loading captions" to "Translating N lines") but there is no progress bar, countdown, or animated indicator during the 1.5–4 s TTS batch wait. Users interpret static text as a hang.

---

## 5. Concrete Optimization Opportunities (Summary)

### Immediate (extension-only, no server changes):

1. **Prefetch captions on video navigation** (`NavigationWatcher` already detects this). Cache result in content-script memory. When user presses Start, captions are already available → caption fetch step drops to near-zero.
   - Files: `src/content/navigation.ts`, `src/content/pipelines/subtitle-first-pipeline.ts`

2. **Reduce `SUBFIRST_PREBUFFER_COUNT` from 3 to 1** and start video sooner — trust the `_systemPaused` stall mechanism to buffer-wait on the first cue if needed.
   - File: `src/content/pipelines/subtitle-first-pipeline.ts:34`

3. **Eliminate the 80 ms fixed sleep in `alignRealtimeVodBeforePlay`** and replace the polling loop with an event-driven promise resolved by the `ontrack` → `unmute` event.
   - File: `src/lib/standard-vod-start.ts`

4. **Parallelize caption fetch layers**: start DOM scrape concurrently with background cache check rather than sequentially.
   - File: `src/platforms/youtube/captions-fetch.ts`

5. **Optimistic popup UI**: render last-known state from `chrome.storage.local` immediately on popup open, before `GET_STATE` resolves.
   - File: `src/popup/index.ts`

6. **Reduce `DUB_TTFA_GATE_MS` from 14,000 to 7,000 ms** for Standard WebRTC fallback.
   - File: `src/shared/constants.ts:62`

7. **Progress indicator during TTS batch**: animate the "Translating N lines" overlay status (e.g., dots or a spinner) so the frozen video doesn't feel like a crash.
   - File: `src/content/overlay/overlay.ts` + `overlay.css`

### Requires server coordination:

8. **Stream `/v1/translate/subtitles` responses** (NDJSON or chunked) — first sentence result returns as soon as it's ready; extension decodes and can start audio before remaining lines are done. This is the highest-impact change.

9. **Server-side SDP offer pre-warming** (Realtime) — endpoint could accept a "warm" flag to pre-allocate the mediasoup worker slot; the extension exchanges SDP only when the user actually presses Start.

---

## 6. Cross-Slice Concerns for Orchestrator

- **Server (realtime-v2 / `POST /v1/rtc/translate`)**: SDP round-trip latency (step 17, ~200–600 ms) is the main latency for Realtime. If server-side mediasoup worker pool is pre-warmed, this drops significantly. Flag for server slice.
- **Server (`POST /v1/translate/subtitles`)**: Streaming response is the #1 win for Standard. Currently this endpoint returns the full batch as one JSON blob. Flag for server slice.
- **Sync engine / dub-playback-sync**: The `waitForFirstDub` gate (step for Standard WebRTC) could be removed if the sync engine is adapted to handle "dub not yet started" gracefully by catching up once audio begins. Flag for sync slice.
- **Extension UX**: The UX gap during TTS batch is a "polish" fix that can be done by this wave's extension agent without server changes.

---

## 7. File References Summary

| File | Relevance |
|------|-----------|
| `src/popup/index.ts:720–757` | `onToggle()` — the click handler, START message dispatch |
| `src/background/router.ts:164–165` | Routes START to `session.start()` |
| `src/background/session-coordinator.ts:156–245` | Full `start()` method: auth check, tabs, inject, relay |
| `src/background/session-coordinator.ts:132–153` | `ensureContentScript()` — PING + inject |
| `src/lib/api-mode.ts:32–46` | `resolveApiMode()` — auth/user resolution (may be slow if cold) |
| `src/content/index.ts:271–507` | `startSession()` + `startWebRtcSession()` — full session start |
| `src/content/pipelines/subtitle-first-pipeline.ts:43–257` | `SubtitleFirstPipeline.start()` — caption fetch + TTS batch + playback |
| `src/content/pipelines/subtitle-first-pipeline.ts:34` | `SUBFIRST_PREBUFFER_COUNT = 3` |
| `src/content/pipelines/webrtc-pipeline.ts:117–349` | `buildSession()` — SDP/ICE negotiation |
| `src/content/capture.ts:66–93` | `captureWithRetry()` — captureStream, up to 9 s timeout |
| `src/content/capture.ts:97–119` | `waitForPCConnected()` — ICE gate, 3 s default |
| `src/lib/standard-vod-start.ts:12–22` | `alignRealtimeVodBeforePlay()` — 80 ms gratuitous sleep |
| `src/lib/dub-playback-sync.ts:114–135` | `waitForFirstDub()` — TTFA gate up to 14 s |
| `src/lib/echoly-api.ts:44–85` | `renderSubtitleDubBatch()` — POST /v1/translate/subtitles |
| `src/platforms/youtube/captions-fetch.ts:55–206` | `fetchYouTubeCaptions()` — 3-layer caption acquisition |
| `src/shared/constants.ts:62,64` | `DUB_TTFA_GATE_MS=14000`, `REALTIME_VOD_PLAY_ALIGN_MS=80` |
