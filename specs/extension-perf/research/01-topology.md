# 01 — Extension Network/Call Topology

Research agent: read-only. Sources: direct file reads from `extension/src/` and `server/src/`.

---

## 1. Realtime Tier — hop-by-hop diagram

```
[Video <video> element (page DOM)]
        │  HTMLVideoElement.captureStream()  [content script, capture.ts:85]
        ▼
[MediaStream — audio tracks only]
        │  addTrack() to RTCPeerConnection  [content script, webrtc-pipeline.ts:177]
        ▼
[new RTCPeerConnection()  ← CREATED IN CONTENT SCRIPT]
  webrtc-pipeline.ts:176 — content script context (NOT offscreen, NOT SW)
        │  createOffer() → SDP offer (local)
        │  HTTPS POST /v1/rtc/translate?pipeline=realtime (+ SDP body in application/sdp)
        │  Bearer = ec_session cookie, resolved by BG at Start and forwarded in StartSettings
        ▼
[Echoly API server — api.echolyhq.com]
  Route: rtc.routes.ts → RtcBridgeService (rtc-bridge.service.ts)
  Peer impl: MediasoupRtcPeer (mediasoup.peer.ts)
    - mediasoup allocates a WebRtcTransport that TERMINATES the browser peer
    - Inbound Opus/48k → @discordjs/opus decode → PCM16/24k PcmFrames
    - realtime pipeline (Max only): GptRealtimeLiveProvider.relay()
      → OpenAI Realtime WebSocket (wss://api.openai.com/v1/realtime)
    - Translated PCM returned from OpenAI, Opus-encoded → pushOutboundPcm()
      → routed back to WebRtcTransport → browser
  Server also sends metadata (partial_transcript, partial_translation, done…)
  via SCTP DataChannel "echoly-events"
        │  SDP answer (application/sdp) returned in HTTP 200
        │  DTLS/ICE/SRTP (WebRTC media) ongoing after ICE completes
        ▼
[RTCPeerConnection in content script — ICE connects]
        │  "track" event → new HTMLAudioElement (audio.srcObject = event.streams[0])
        │  + Web Audio GainNode for volume (AudioContext in content script)
        ▼
[Dubbed audio plays in page]

### Realtime control calls (all from content script, same origin):
- PRE-WARM:  POST /v1/rtc/prepare          [webrtc-pipeline.ts:142 — fire-and-forget]
- HEARTBEAT: POST /v1/rtc/translate/:id/heartbeat  [session-manager.ts:207 — every 30s]
- PAUSE:     POST /v1/rtc/translate/:id/media-pause  [rtc-media-sync.ts:86]
- RESUME:    POST /v1/rtc/translate/:id/media-resume [rtc-media-sync.ts:140]
- END:       POST /v1/rtc/translate/:id/end  [session-manager.ts:311 — on stop]
```

**Provider hop**: Browser → Echoly server (mediasoup terminates peer) → OpenAI Realtime WS.
There is NO browser-to-provider-direct path. The browser only knows `api.echolyhq.com`.

---

## 2. Standard Tier — two sub-modes

### 2a. Subtitle-first (YouTube VOD with captions — the PREFERRED path)

```
[YouTube page DOM — caption tracks]
        │  Layer-0 (MAIN world): yt-mainworld.content.ts intercepts
        │    YouTube's own /api/timedtext fetch/XHR via monkey-patching,
        │    emits CustomEvent "echoly:yt-capture" with caption body/URL + poToken.
        │  [runs in MAIN world at document_start — NO chrome.* APIs]
        │
        │  Isolated content script listens for CustomEvent, caches in
        │    platforms/youtube/caption-cache.ts (YT_CACHE_TTL_MS = 30 min)
        │  OR: background.router.ts handles GET_YT_PLAYER_RESPONSE:
        │    chrome.scripting.executeScript(world:"MAIN") → getPlayerResponse()
        │    caption track list relayed back to content via sendResponse
        ▼
[CaptionSentences — arrays of {text, start, end}]
        │  regroupToSentences()  [caption-utils.ts]
        │  renderSubtitleDubStream() — primary path (SSE)
        │  HTTPS POST /v1/translate/subtitles/stream  [echoly-api.ts:147]
        │  (fallback: POST /v1/translate/subtitles  [echoly-api.ts:47])
        │  Both calls made FROM content script, to Echoly server
        ▼
[Echoly server — subtitle-dub.routes.ts → subtitle-dub.service.ts]
  Server does: Gemini translate + MiniMax TTS per line
  Returns: SSE stream of {index, text, audio_b64, cue_start_ms, cue_end_ms}
        │  audio_b64 = MP3/Opus TTS audio, base64-encoded in the SSE payload
        ▼
[Content script decodes base64 → ArrayBuffer → AudioContext.decodeAudioData()]
        │  AudioBufferSourceNode.start() at cue time  [subtitle-first-pipeline.ts:962]
        │  played via Web Audio GainNode → AudioContext.destination (local speakers)
        ▼
[Dubbed audio plays in page — pure local Web Audio, no streaming/WebRTC]

NO WebRTC peer is created for subtitle-first. No RTCPeerConnection.
```

### 2b. Standard WebRTC fallback (no captions — live audio capture)

```
[Video <video> element (page DOM)]
        │  captureStream() → MediaStream  [capture.ts:85 — same as Realtime]
        ▼
[new RTCPeerConnection()  ← CREATED IN CONTENT SCRIPT — same webrtc-pipeline.ts]
        │  POST /v1/rtc/translate?pipeline=standard
        ▼
[Echoly server — same RTC route/bridge, but backend="minimax-chain"]
  Gemini audio-in → MiniMax TTS chain (server-side)
  Translated TTS audio pushed back via WebRTC outbound track
        │  SDP answer → WebRTC media plane established
        ▼
[Dubbed audio plays via HTMLAudioElement (remoteAudio) in content script]
```

---

## 3. Background Service Worker — role is CONTROL-PLANE ONLY

The SW (`background/index.ts` → router.ts, session-coordinator.ts, store.ts, auth.ts) handles:

- **Auth**: reads `ec_session` cookie via `chrome.cookies.get()` [auth.ts:13]. No network data-plane.
- **Start**: resolves API mode/key → injects content script if needed → relays `CONTENT_START` + `StartSettings` (including `apiBase`, `apiBearer`) to the content tab via `chrome.tabs.sendMessage` [session-coordinator.ts:251].
- **State**: receives `CONTENT_STATE` / `CONTENT_ENDED` push events from content → updates `store.ts` → broadcasts `BACKGROUND_STATE_UPDATE` to popup.
- **Settings sync**: PUT/GET `/me/settings` via `settings-client.ts` (HTTPS, background → server, auth API calls only).
- **PREPARE_INTENT relay**: on popup hover → SW resolves intent → relays `CONTENT_PREPARE_INTENT` to content tab (no network call in SW itself).
- **YouTube player response**: `GET_YT_PLAYER_RESPONSE` → `chrome.scripting.executeScript(world:"MAIN")` [router.ts:331] to read caption tracks fresh post-SPA/ad.

**No audio/translate/WebRTC data-plane traffic EVER flows through the SW.**
The SW is CONTROL-PLANE (auth, session lifecycle, settings, state broadcast).

### Message protocol (protocol.ts) — abbreviated

```
Popup  → BG:   chrome.runtime.sendMessage(PopupToBgMessage)   [START, STOP, GET_STATE, PREPARE_INTENT…]
BG     → Popup: chrome.runtime.sendMessage(BACKGROUND_STATE_UPDATE)  [broadcast]
BG     → Content: chrome.tabs.sendMessage(CONTENT_START | CONTENT_STOP | CONTENT_PREPARE_INTENT…)
Content → BG:  chrome.runtime.sendMessage(CONTENT_STATE | CONTENT_ENDED | GET_YT_PLAYER_RESPONSE…)
```

---

## 4. Offscreen Document

**None.** Zero occurrences of `chrome.offscreen` or `chrome.offscreen.createDocument` in the codebase. No offscreen document is used for any purpose. All audio capture, WebRTC, and Web Audio happen in the content script's page context.

---

## 5. Main-world Injection

File: `src/entrypoints/yt-mainworld.content.ts`
- Runs at `document_start` in `world: "MAIN"` on YouTube only.
- **Purpose**: monkey-patches `window.fetch` and `XMLHttpRequest.prototype.send` to intercept YouTube's own `/api/timedtext` and `/youtubei/v1/player` requests, which carry a valid `pot` (Proof-of-Origin) token that Echoly cannot mint independently.
- Emits a `CustomEvent("echoly:yt-capture", {detail: JSON})` with caption tracks / poToken — no `chrome.*` APIs (not available in MAIN world).
- The isolated content script listens for this event and caches the data in `platforms/youtube/caption-cache.ts`.
- Additionally, the background service worker can trigger `chrome.scripting.executeScript(world:"MAIN")` on demand (via `GET_YT_PLAYER_RESPONSE` message) to call `getPlayerResponse()` for a fresh track list post-SPA navigation or post-ad.

---

## 6. Server Gateway Topology Confirmation

From `server/src/services/rtc/mediasoup.peer.ts` and `server/src/services/rtc-bridge.service.ts`:

```
Browser WebRTC peer
  ──[ICE/DTLS/SRTP, Opus/48k]──▶  mediasoup WebRtcTransport (terminates browser peer on server)
                                         │
                         inbound Opus → @discordjs/opus decode → PCM16/24k
                                         │
                              realtime:  OpenAI Realtime WS (wss://api.openai.com)
                              standard:  Gemini audio-in → MiniMax TTS WS
                                         │
                         translated PCM → Opus encode → WebRtcTransport Consumer → browser
```

The browser peer connects to `api.echolyhq.com` (server mediasoup), NOT to OpenAI directly.
There are **two hops** on the provider side: browser→server→OpenAI (vs hypothetical browser→OpenAI direct). This is by design: server-authoritative metering requires all traffic to be observable server-side.

---

## 7. Exact file:line citations (key claims)

| Claim | File:line |
|-------|-----------|
| `new RTCPeerConnection()` created in content script | `webrtc-pipeline.ts:176` |
| `captureStream()` called in content script | `capture.ts:84-85` |
| `fetch /v1/rtc/prepare` from content | `webrtc-pipeline.ts:142` |
| `fetch /v1/rtc/translate` SDP exchange from content | `webrtc-pipeline.ts:379` |
| Heartbeat fetch from content | `session-manager.ts:207` |
| media-pause/resume fetch from content | `rtc-media-sync.ts:86, 140` |
| END fetch from content | `session-manager.ts:311` |
| SSE fetch `/v1/translate/subtitles/stream` from content | `echoly-api.ts:147` |
| Batch fetch `/v1/translate/subtitles` from content | `echoly-api.ts:47` |
| AudioBufferSourceNode.start() in content | `subtitle-first-pipeline.ts:962` |
| SW relays CONTENT_START with apiBearer | `session-coordinator.ts:251` |
| SW handles GET_YT_PLAYER_RESPONSE via executeScript MAIN | `router.ts:331` |
| MAIN-world monkey-patch of fetch/XHR | `yt-mainworld.content.ts:83-135` |
| mediasoup terminates browser peer | `mediasoup.peer.ts:1-22 (architecture comment)` |
| Server bridges to OpenAI Realtime WS | `rtc-bridge.service.ts:6-10, peer.port.ts:79-87` |
| apiBase = ECHOLY_PROXY_BASE = api.echolyhq.com/v1 | `constants.ts:15, session-manager.ts:87` |

---

## Open questions / cross-slice conflicts

1. **Standard WebRTC sub-mode**: The `subtitle-first-pipeline.ts` falls back to `startWebRtcStandard()` when captions are absent. This means on YouTube live streams or no-CC videos, a FULL WebRTC peer is created with the same content-script topology as Realtime (but pipeline=standard → Gemini+MiniMax chain on server). The boundary between "subtitle-first" and "WebRTC standard" is dynamic at runtime, determined by caption availability.

2. **The "two hops" cost for Realtime**: Browser→server (WebRTC, high-quality) → server→OpenAI (WS). There is 1 extra network hop vs hypothetical browser-direct. The server adds ~20-40ms RTT to the audio path but is architecturally required for server-authoritative metering.

3. **`sm.apiBase` default**: If the extension starts without a proper `CONTENT_START` (unlikely in production but possible in dev), `sm.apiBase` defaults to `ECHOLY_PROXY_BASE` = `api.echolyhq.com/v1` (session-manager.ts:87). There is no fallback to any direct-to-provider URL in the current codebase — BYOK/Kyma paths are fully removed.
