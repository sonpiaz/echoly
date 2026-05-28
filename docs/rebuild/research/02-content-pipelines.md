# Research 02 — content.js PIPELINE / LOGIC layer

**Agent 2 of 5 · feature-wave: rebuild Echoly into modular TS+Vite, preserving 100% of 0.6.3 behavior.**
**Slice:** the audio + network + async-correctness logic of `content.js` (NOT the overlay DOM/CSS/popup — Agent 3 owns those).
**Baseline:** committed 0.6.3, working tree at exactly that. `content.js` = 2406 lines, plain JS, single IIFE, no build step.
All line refs are `content.js:N` unless prefixed `background.js:N`.

> Note on naming: file declares `ECHOLY_VERSION = "0.6.1"` (`content.js:10`) while `manifest.json` says `0.6.3`. The internal version string is the F9 guard key, intentionally decoupled from the manifest version. **Preserve the literal string `"0.6.1"`** — see F9 risk below.

---

## 0. File shape & what belongs to this slice

`content.js` is one IIFE (`content.js:8`) holding ALL module-private state as `let` closures. There is no class structure. The logic this slice owns:

- **Audio capture** — `findVideo`, `isLive`, `nudgePlay`, `captureWithRetry` (`content.js:509-541`); Web Audio graph + gain (`computeGain` `content.js:831`, `applyVolumes` `content.js:835`, `VOICE_GAIN_MAX` `content.js:30`).
- **Realtime tier (WebRTC)** — `buildRealtimeSession` (`content.js:637-797`), `handleRealtimeEvent` (`content.js:799-829`), `waitForPCConnected` (`content.js:616-634`), `requestHandover` (`content.js:930-1004`).
- **Standard tier (chunked)** — `startStandardSession` (`content.js:1011-1101`), `runChunkLoop` (`content.js:1188-1228`), `processStandardChunk` (`content.js:1230-1380`), audio re-encode helpers (`content.js:1103-1182`).
- **Subtitle-first tier** — `startSubtitleFirstSession` (`content.js:1744-1948`) + the whole CC-fetch / batch-translate / rolling-renderer machinery (`content.js:1387-2084`). **This tier is NOT mentioned in the task brief but is real, shipped, and is the default path for non-live YouTube Standard sessions.** It must be preserved.
- **Session lifecycle** — `startSession` router (`content.js:2087-2237`), `stopSession` (`content.js:2239-2314`), `applySettingsLive` (`content.js:2316-2352`), timers (`content.js:566-598`), heartbeat (`content.js:567-580`), Kyma session end (`content.js:601-610`).
- **Correctness patterns** — F6 token guard, per-session AbortController, F9 version guard, runtime-alive guard, SPA nav watcher, unload hooks.
- **Network** — every `fetch` and the `apiBase` resolution.
- **SF3/SF8 video-side guards** — volume drift (`content.js:877-897`), rate-change warn (`content.js:902-927`). These manipulate the YT `<video>` element (logic), not the overlay DOM, so they're ours; the **toast they emit** is Agent 3's UI primitive (`showToast`).

**Seam with Agent 3 (UI):** the logic calls these UI functions throughout — `buildOverlay`, `removeOverlay`, `setStatusText`, `setOverlayState`, `setTargetText`, `showToast`, `pushHistoryTurn`, `renderHistory`, `populateVoicePicker`, `applySourceVisibility`, `elements.*` reads/writes. Plus the source-caption pane writes (`elements.source.textContent`). These are the contract surface to lock with Agent 3.

---

## 1. Audio capture

### Video element acquisition
- `findVideo()` (`content.js:509-511`): `video.html5-main-video` then any `video`. Called eagerly in `applyVolumes` (`content.js:840`) so the slider works pre-session.
- `videoEl` module global (`content.js:85`) is set on session start and nulled in `stopSession` (`content.js:2264`). Listeners (`onYTPause/onYTPlay/onYTEnded/_onSeeked`) hang off it.
- `isLive(video)` (`content.js:516-518`): `!isFinite(video.duration)`. Gates: skip subtitle-first for live (`content.js:2108`); skip non-live pause-sync for live realtime (`content.js:2140`). **Load-bearing — pausing a live stream evicts the viewer from the live edge permanently.**

### F5 captureStream retry (`captureWithRetry`, `content.js:525-541`)
- Throws if neither `captureStream` nor `mozCaptureStream` exists (`content.js:526-527`).
- Loop until `timeoutMs` (default 9000): if paused, `nudgePlay`; call `captureStream`; if it has audio tracks, return `new MediaStream(getAudioTracks())`; else stop tracks and `sleep(300)` and retry.
- `nudgePlay` (`content.js:519-524`): `video.play()` raced against a 250ms timeout, swallowing rejection — handles autoplay-policy edge.
- **Why retry exists:** YouTube's `captureStream` returns an empty (track-less) stream for a window after navigation/ad until the media pipeline is hot. Throws a user-facing "Press play, then Start again." on timeout.

### Web Audio graph + gain
- `VOICE_GAIN_MAX = 2.0` (`content.js:30`): unity at slider 50, 2× at 100.
- `computeGain(v)` (`content.js:831-833`): `v===0 ? 0 : (v/100)*VOICE_GAIN_MAX`.
- `applyVolumes(orig, voice)` (`content.js:835-870`):
  - **Original audio** = the YT `<video>.volume` (0..1, default 18%), with `muted` when 0. Records `desiredOriginalVol` + `lastOriginalWriteAt` for the SF3 drift guard.
  - **Voice (dub)** path A: Web Audio `GainNode` with `cancelScheduledValues`/`setValueAtTime`/`linearRampToValueAtTime(target, now+0.04)` ramp (anti-crackle). Falls back to direct `gain.value = target` if scheduling throws.
  - Voice path B (HTMLAudio fallback): `session.remoteAudio.volume = min(v/100, 1.0)` capped at unity (no boost possible without Web Audio).
- **Three places build a Web Audio graph** (audioCtx + gain→destination): realtime pre-create (`content.js:690-702`), standard (`content.js:1035-1046`), subtitle-first (`content.js:1758-1764`). All use `window.AudioContext || window.webkitAudioContext` and resume-if-suspended. → factor into one `createAudioGraph()` helper.

### Playback of translated audio
- **Realtime:** remote MediaStream → either Web Audio (`createMediaStreamSource → outputGain`, muted `<audio>` element kept only as a stream sink) OR HTMLAudio fallback (`audio.muted=false`, volume capped 1.0). The `<audio>` element is `document.body.appendChild`-ed (`content.js:724`). Graph is **pre-created before `ontrack`** (`content.js:684-702`) so the slider has a target during the 2-5s realtime cold start (SF3 fix).
- **Standard:** each TTS mp3 → `decodeAudioData` → `createBufferSource` scheduled against `s.nextPlayAt` tail (`content.js:1371-1377`). Stale-tail reset: if `nextPlayAt < currentTime`, reset to 0 (`content.js:1371`).
- **Subtitle-first:** pre-rendered `AudioBuffer`s scheduled at `audioOffset + sentence.start` (`scheduleWindow`, `content.js:1990-2009`), tracked in `pendingSources[]` for seek-cancel.

---

## 2. Realtime tier (WebRTC) — full lifecycle

`buildRealtimeSession(token, audioStream, opts)` `content.js:637-797`:

1. **Mint client secret** — `POST {apiBase}/realtime/translations/client_secrets` with `Authorization: Bearer <kymaKey>`, body `{session:{model:"gpt-realtime-translate", audio:{output:{language, voice?}}}}` (`content.js:647-656`). Network error → `"Network error reaching Kyma."`. Non-OK → `parseKymaError` → throws with `.cta`/`.ctaLabel`.
2. Extract `clientSecret = mint.value`, `kymaSessionId = mint.kyma_session_id` (`content.js:671-673`).
3. `new RTCPeerConnection()` (no ICE servers configured — default). `addTrack` for each captured audio track (`content.js:675-676`).
4. `createDataChannel("oai-events")` (`content.js:678`); `message` handler → `handleRealtimeEvent` (token-guarded, `content.js:679-682`).
5. **Pre-create AudioContext + gain** (`content.js:690-702`) before `ontrack`.
6. Build `newSession` object (`content.js:704-714`): `{token, pc, dc, stream, remoteAudio:null, audioCtx, outputGain, kymaSessionId, kymaKey, targetLanguage, realtimeVoice}`.
7. `ontrack` (`content.js:716-757`): wire remote stream to Web Audio or HTMLAudio fallback (see §1).
8. `iceconnectionstatechange` (`content.js:759-768`): on `closed/failed/disconnected`, **only if `newSession === session`** → `stopSession("connection-lost")` + `emitEnded("Connection lost.")`. The `newSession===session` check prevents a stale handover candidate from killing the live session.
9. **SDP offer/answer** (`content.js:770-794`): `createOffer` → `setLocalDescription` → `POST OPENAI_CALLS_URL` (`https://api.openai.com/v1/realtime/translations/calls`, `content.js:24`) with `Authorization: Bearer <clientSecret>`, `Content-Type: application/sdp`, body `offer.sdp`. **This POST goes DIRECT to OpenAI, not to apiBase** (client-direct WebRTC seam — the legacy/BYOK design). On failure: close pc, `endKymaSession`, throw `SDP exchange <status>`. Then `setRemoteDescription({type:"answer", sdp: answerSdp})`.
10. Returns `newSession`. **Note: NOT assigned to `session` here** — caller (`startSession`/`requestHandover`) assigns after token recheck.

`handleRealtimeEvent(raw, token)` `content.js:799-829`:
- Token-guarded (`content.js:800`). Parses JSON; `type==="error"` → status "Translation error".
- **Delta** event types accepted (`content.js:807-811`): `session.output_transcript.delta`, `response.audio_transcript.delta`, `response.output_audio_transcript.delta`, `response.text.delta`. Appends `evt.delta` to `currentTargetText`, sets target text, state "live".
- **Done** types (`content.js:818-822`): same four families `.done` / `response.text.done`. If `evt.transcript`, replaces text; calls `pushHistoryTurn()`. **The multi-name acceptance handles OpenAI Realtime API event-name drift across versions — preserve all variants exactly.**

`waitForPCConnected(pc, 3000)` `content.js:616-634`: resolves true on `connected`, false on `failed/closed`/timeout. Gates `video.play()` on non-live realtime (SF6, `content.js:2220`).

**REALTIME_VOICES** (`content.js:42-45`): `marin, alloy, ash, ballad, coral, echo, sage, shimmer, verse`. Default `"marin"` (`content.js:314`). UI adds an "Auto" option = empty string (Agent 3 owns picker; logic owns the voice → `audio.output.voice` mapping where empty omits the field, `content.js:653`).

**Teardown** is in `stopSession` (§5) + the handover swap (`content.js:984-999`).

---

## 3. Standard tier (chunked STT→translate→TTS)

`startStandardSession` `content.js:1011-1101`. NOTE: the chunked pipeline is **2-step, not 3** — comment header says whisper→gpt→minimax but the code uses Gemini audio-understand (translate-in-one) + MiniMax TTS. The "whisper" step was collapsed into `/audio/understand` (Vertex Gemini, 2026-05-16, `content.js:1250-1256`).

Pipeline:
- `pickRecorderMime()` (`content.js:1103-1109`) from `STANDARD_RECORDER_MIMES` (`content.js:62-67`).
- Session object (`content.js:1049-1069`): `type:"standard"`, holds `recorderMime`, `activeRecorder`, `nextPlayAt`, `stopFlag`, and **`abortController: new AbortController()`**.
- `runChunkLoop(s)` (`content.js:1188-1228`): self-rescheduling `cycle()`. Skips while `videoEl.paused` (silence → wasted call, `content.js:1193`). Creates a fresh `MediaRecorder` per window (self-contained blob whisper can decode). `stop` after `STANDARD_CHUNK_MS` (5000ms, `content.js:60`). On `stop`, if parts → `processStandardChunk(s, blob)`, then `cycle()` again. The stop+start-per-window design accepts a <10ms inter-chunk gap.
- `processStandardChunk(s, blob)` (`content.js:1230-1380`):
  1. Guard `s !== session || s.token !== pageToken` (`content.js:1231`); skip if `blob.size < STANDARD_MIN_CHUNK_BYTES` (2000, silence, `content.js:1232`).
  2. `webmBlobToWav` (`content.js:1117-1132`) — decode + `downmixAndResample` to 16kHz mono → 16-bit PCM WAV (`content.js:1134-1182`). Kyma audio gateway whitelists mp3/wav/m4a only; MediaRecorder emits webm/mp4.
  3. **Call 1** `POST {apiBase}/audio/understand` (multipart FormData: `file`, `model:"gemini-3-flash-audio"`, `duration_sec`, `question` prompt) with `Authorization: Bearer <kymaKey>`, **`signal: s.abortController.signal`** (`content.js:1278-1283`). `answer` is the translated text.
  4. Adaptive TTS speed by `queueDepth = nextPlayAt - currentTime` (`content.js:1317-1326`): >10 hard-skip; >6→1.30; >4→1.20; >2→1.10; >1→1.05. SF7 anti-drift.
  5. **Call 2** `POST {apiBase}/audio/speech` (JSON `{model:"minimax-speech-turbo", input, voice_id, response_format:"mp3", speed}`) + abort signal (`content.js:1330-1343`). → `arrayBuffer` → `decodeAudioData` → schedule on `nextPlayAt` tail.
- After each await: re-guard `s !== session || s.token !== t` (8 separate rechecks — see F6 table).

**STANDARD_VOICES** (`content.js:48-55`): 5 MiniMax `speech-02-turbo` IDs, default `English_magnetic_voiced_man` (`content.js:55`). Cross-language: one voice handles all 13 targets. Lang/voice change applies on next chunk, NO teardown (`content.js:255-261`, `content.js:2343`).

---

## 3b. Subtitle-first tier (default for non-live YT Standard) — DO NOT DROP

Router (`content.js:2097-2112`): `tier==="standard"` + youtube.com host + `!isLive` → `startSubtitleFirstSession`; else `startStandardSession`. So **subtitle-first is the normal Standard path**; chunked is its live-stream / no-caption fallback.

`startSubtitleFirstSession` (`content.js:1744-1948`):
- Get `videoId` (`getYouTubeVideoId`, `content.js:1400-1411`). Build Web Audio graph. New session `type:"subtitle-first"` with its own `abortController`, `sentences[]`, `translations[]`, `pendingSources[]`, `audioOffset`, `renderCursor`, `stopFlag`, `_onSeeked` (`content.js:1772-1792`).
- **Pauses the video** (`content.js:1808`) while it fetches+translates+renders the first ~30s; tracks `wasPlaying` + `restorePlay()` for failure recovery.
- `fetchYouTubeCaptions` (`content.js:1545-1608`) — **3-layer caption acquisition:**
  1. **webRequest intercept** (`fetchCCViaIntercept`, `content.js:1455-1486`): asks background `GET_YT_CC_URL`; if cold, toggles YT's own CC button (`triggerYTCCLoad`/`restoreYTCCButton`, `content.js:1434-1450`) to make YT fire `/api/timedtext`, polls bg cache.
  2. **DOM player-response** (`readPlayerResponseFromDom`, `content.js:1496-1526`): scrapes `ytInitialPlayerResponse` from inline `<script>` (isolated-world can't read the global), with a balanced-brace fallback parser. `pickCaptionTrack` scores native-target > en > manual-over-asr (`content.js:1528-1543`).
  3. **plain timedtext URLs** (`content.js:1588-1606`) — mostly empty post-2024 but cheap.
  - All fetches pass `signal` + `credentials:"include"`. `parseJson3Events` (`content.js:1610-1621`).
- No captions → tears down audioCtx, `session=null`, **`pageToken += 1`** to invalidate this token, `removeOverlay()`, then `await startStandardSession()` and toast "No captions… using live mode" (`content.js:1821-1843`). Ordering comment is load-bearing: must NOT removeOverlay before the toast would render against a rebuilt panel.
- `regroupToSentences` (`content.js:1647-1665`) via `mergeWithDedupe` (`content.js:1633-1645`, collapses ASR sliding-window repeats). Constants `content.js:1394-1398`.
- First wave: starts at the **playhead** not index 0 (`content.js:1850-1872`), capped at 2 sentences (SF6 — keeps await chain under Chrome's transient-activation window so `video.play()` isn't blocked).
- `translateBatch` (`content.js:1950-1960`) → `batchTranslateSubtitles` (`content.js:1671-1722`, `POST {apiBase}/chat/completions`, `gemini-2.5-flash`, json_object). `renderWaveTTS` (`content.js:1962-1988`, `SUBFIRST_RENDER_CONCURRENCY=5` workers) → `renderTTSForSentence` (`content.js:1724-1742`, `/audio/speech`).
- `audioOffset = audioCtx.currentTime - video.currentTime` (`content.js:1903`) — recomputed on play/seek. `scheduleWindow` (`content.js:1990-2009`) skips cues already >0.5s past.
- Listeners: pause/play/**seeked**(`onYTSeeked`→`cancelPendingSources`+reschedule, `content.js:1924-1928`)/ended.
- `runRollingRenderer` (`content.js:2052-2084`): 1s-tick loop, renders `SUBFIRST_LOOKAHEAD_MS` (30s) ahead of playhead, never crashes the session.

---

## 4. Correctness patterns — INVARIANTS (must be preserved exactly)

### F6 — token-guarded async (`pageToken`, `content.js:69-73`)
`pageToken` is bumped on **every** `startSession` (`++pageToken` at `content.js:1048, 1145→2145, 1770`), every `requestHandover` (`content.js:950`), and **`stopSession` (`pageToken += 1`, `content.js:2240`)**, plus the subtitle-first→standard fallback (`content.js:1829`). Each async callback captures the token in closure and bails if it no longer matches. **Stop works by bumping the token — every in-flight callback then silently no-ops.** Enumeration of every guard and the stale-state bug it prevents:

| # | Location | Guard | Prevents |
|---|---|---|---|
| 1 | `content.js:660` | after client_secret fetch `token!==pageToken` → throw Stale | applying a mint result to a torn-down/superseded session |
| 2 | `content.js:670` | after `mintResp.json()` | same, post-parse |
| 3 | `content.js:680` | dc message: `token!==pageToken && session?.token!==token` | stale realtime transcript writing to a new session's overlay |
| 4 | `content.js:760` | iceconnectionstatechange same dual-guard + `newSession===session` | a dead handover candidate killing the live session |
| 5 | `content.js:771` | after createOffer | abandon SDP for superseded session |
| 6 | `content.js:779` | after SDP POST → close pc + throw | leaking a PeerConnection for a stale session |
| 7 | `content.js:790` | after `sdpResp.text()` → close pc | same |
| 8 | `content.js:800` | `handleRealtimeEvent` entry, dual-guard | stale event mutating `currentTargetText`/overlay |
| 9 | `content.js:963` | handover: `newToken!==pageToken` → close pc, abandon | swapping in a session the user already navigated past |
| 10 | `content.js:969` | handover catch: `newToken!==pageToken` → silent return | error toast for a session that no longer matters |
| 11 | `content.js:1190` | chunk `cycle`: `s!==session \|\| s.stopFlag` | recorder loop continuing after stop/new session |
| 12 | `content.js:1212` | recorder `stop` handler same | processing a chunk after teardown |
| 13 | `content.js:1231` | `processStandardChunk` entry: `s!==session \|\| s.token!==pageToken` | wasting Kyma calls on a dead session |
| 14 | `content.js:1248,1287,1348,1356,1364` | after each await (wav/understand/tts/arraybuf/decode) `s!==session \|\| s.token!==t` | playing/displaying a chunk whose session ended mid-pipeline |
| 15 | `content.js:1816,1877,1889,1897` | subtitle-first stage gates `token!==pageToken \|\| stopFlag` | committing caption/translate/TTS work to a cancelled session |
| 16 | `content.js:1953,1957,1973,1979,2055,2073,2075` | `translateBatch`/`renderWaveTTS`/`runRollingRenderer` `s!==session \|\| s.stopFlag` | background renderer mutating a dead session |

**Two-layer guard idiom:** realtime callbacks use **`token !== pageToken && session?.token !== token`** (note `&&`): the callback runs if EITHER the global token matches OR it belongs to the *current* session. This lets a just-swapped handover session keep receiving its own dc events during the 400ms swap window. Chunked/subtitle use the simpler `s !== session` identity check (they hold the session object directly). **Preserve BOTH idioms — they are not interchangeable.**

### per-session AbortController (Stop cancels in-flight fetches → no burned credits)
- Created per Standard session (`content.js:1068`) and per subtitle-first session (`content.js:1771,1783`). **Realtime tier has NO AbortController** (its fetches are the short mint+SDP handshake; the PC teardown is the cancellation mechanism).
- `stopSession` aborts it for standard (`content.js:2275-2277`) and subtitle-first (`content.js:2284-2286`).
- Fetches wired to the signal (these are the credit-burning ones):
  - `content.js:1282` — `/audio/understand` (standard)
  - `content.js:1343` — `/audio/speech` (standard TTS)
  - `content.js:1553,1574,1598` — caption fetches (subtitle-first, via `signal` param)
  - `content.js:1698` — `/chat/completions` batch translate (via `signal`)
  - `content.js:1735` — `/audio/speech` subtitle-first TTS (via `signal`)
- The `catch{}` after an aborted fetch returns silently (`content.js:1285` comment: "network blip OR aborted via Stop").
- **NOT abort-wired (intentionally):** heartbeat (`content.js:572`), `endKymaSession` (`content.js:604`, fire-and-forget keepalive), realtime mint/SDP. Preserve this split.

### F9 — idempotent version guard (`content.js:9-15`)
`window[GLOBAL_KEY="__echolyContentVersion"] === ECHOLY_VERSION ("0.6.1")` → early `return`. Else removes any stale `.ec-root` from an older copy and stamps the global. Prevents double-install when background re-injects via `chrome.scripting` over an already-present script. **In TS+Vite this guard must survive bundling** — the bundle still runs as one IIFE in the page; the constant and the early-return-from-module-init semantics must be preserved (an ES-module content script that throws on re-eval is NOT equivalent).

### Runtime-alive guard (`content.js:115-127`)
`notifyBackground` wraps `chrome.runtime.sendMessage` in try/catch because after an extension reload the handle is invalidated and sendMessage throws **synchronously** (`.catch` can't catch it). On "Extension context invalidated" it sets `runtimeAlive=false` and calls `handleUnload()` so an orphaned script stops emitting / tears down the Kyma session. **Preserve — this is the only defense against zombie content scripts after dev reload / Chrome auto-update.**

### F3 — source captions (logic side)
`startCaptionPoll`/`stopCaptionPoll`/`readYTCaptions` (`content.js:477-502`). Polls `.ytp-caption-segment` every `CAPTION_POLL_MS` (350ms) only when `settings.showSource`; dedupes on `lastSeenCaption`; writes `currentSourceText` and `elements.source.textContent` (the latter is the Agent-3 seam). Independent of the translation pipeline — even the audio-understand path keeps source captions backed by YT's native CC (`content.js:1297-1301`).

### F4 — handover (logic side)
`requestHandover(partial)` (`content.js:930-1004`): realtime-only zero-gap lang/voice swap. No-op if unchanged. Marks a history turn with a `→` chip, bumps token, builds a **new** parallel realtime session, then swaps (`prevSession=session; session=newSession`), and 400ms later tears down `prevSession` (audio + pc + `endKymaSession`). On build failure it KEEPS the old session running (`content.js:968-975`). Standard tier never calls this — it mutates settings in place (`content.js:255-261, 2343-2348`).

---

## 5. Session lifecycle / limits / state reporting

- Constants: `SESSION_LIMIT_MS=60min` (`content.js:25`), `SESSION_WARNING_MS=55min` (`content.js:26`), `HEARTBEAT_MS=30s` (`content.js:27`), `CAPTION_POLL_MS=350ms` (`content.js:28`), `HISTORY_MAX=16` (`content.js:29`).
- `startSessionTimer` (`content.js:582-594`): one-shot 55-min warning toast + 60-min `stopSession("auto-stop-60min")`+`emitEnded`. `warningShown` one-shot flag.
- `startHeartbeat(kymaSessionId, kymaKey)` (`content.js:567-580`): 30s `POST {apiBase}/.../sessions/<id>/heartbeat`. Only realtime has a `kymaSessionId` so only realtime heartbeats (standard/subtitle pass null). `endKymaSession` (`content.js:601-610`) — `keepalive:true` POST `/end`, fire-and-forget.
- `stopSession(reason)` (`content.js:2239-2314`): the universal teardown. Order: bump token → clear timers/heartbeat/captionpoll → remove video listeners (pause/play/seeked/ended) → unbind SF3 drift + SF8 rate guards → reset video `muted=false, volume=1.0` → null videoEl → per-type stop (standard: stopFlag+abort+stop recorder; subtitle: stopFlag+abort+cancelPendingSources) → close remoteAudio/gain/audioCtx/dc/pc/stream → `endKymaSession` if `kymaSessionId` → null session → tear down `prevSession` → reset history/text → `removeOverlay()`.
- **CONTENT_STATE / CONTENT_ENDED → background** (`emitState`/`emitEnded`, `content.js:128-133`): partial `{running?,paused?,status?,errorMessage?}`. Emitted on: live ready (`content.js:1099,1946,2235`), pause/play (every tier's `onYTPause/onYTPlay`), the Stop button (`content.js:282`), auto-stop/video-end/nav/connection-lost/etc. Background's `handleContentEvent` (`background.js:407-423`) merges these into `state.*` and `broadcastToPopup()`.

---

## 6. Network call table

apiBase resolution: `KYMA_BASE = "https://api.kymaapi.com/v1"` (`content.js:22`); `apiBase = settings.apiBase || KYMA_BASE` set once per `startSession` (`content.js:2092`). Background injects `apiBase` + the bearer as `kymaKey` (BYOK→Kyma direct, proxy→Echoly server, `background.js:301-308`). **content.js is mode-agnostic** — same code path for both.

| # | Call | URL | Method | Auth header | Body / payload | Abort-wired? | Tier |
|---|---|---|---|---|---|---|---|
| 1 | mint client_secret | `{apiBase}/realtime/translations/client_secrets` | POST | `Bearer kymaKey` | JSON `{session:{model,audio:{output:{language,voice?}}}}` | no | realtime |
| 2 | SDP exchange | `https://api.openai.com/v1/realtime/translations/calls` (`OPENAI_CALLS_URL`) | POST | `Bearer clientSecret` | `offer.sdp` (Content-Type sdp) | no | realtime — **DIRECT to OpenAI, NOT apiBase** |
| 3 | heartbeat | `{apiBase}/realtime/translations/sessions/{id}/heartbeat` | POST | `Bearer kymaKey` | none | no | realtime |
| 4 | end session | `{apiBase}/realtime/translations/sessions/{id}/end` | POST | `Bearer kymaKey` | none, `keepalive:true` | no | realtime |
| 5 | audio understand | `{apiBase}/audio/understand` | POST | `Bearer kymaKey` | FormData(file,model,duration_sec,question) | **yes** | standard |
| 6 | TTS (chunk) | `{apiBase}/audio/speech` | POST | `Bearer kymaKey` | JSON `{model,input,voice_id,response_format,speed}` | **yes** | standard |
| 7 | batch translate | `{apiBase}/chat/completions` | POST | `Bearer kymaKey` | JSON `{model:gemini-2.5-flash,messages,temperature,response_format}` | **yes** | subtitle-first |
| 8 | TTS (sentence) | `{apiBase}/audio/speech` | POST | `Bearer kymaKey` | JSON `{model,input,voice_id,response_format}` (no speed) | **yes** | subtitle-first |
| 9 | YT captions (intercept) | `<signed timedtext url>` + `&fmt=json3` | GET | none, `credentials:"include"` | — | **yes** | subtitle-first |
| 10 | YT captions (DOM baseUrl) | `<baseUrl>&fmt=json3` | GET | `credentials:"include"` | — | **yes** | subtitle-first |
| 11 | YT captions (plain) | `https://www.youtube.com/api/timedtext?...` | GET | `credentials:"include"` | — | **yes** | subtitle-first |

`parseKymaError` (`content.js:544-564`) maps status/body → `{user, cta?, ctaLabel?}` for `insufficient_balance` / `too_many_sessions` / `upstream_error` / `rate_limited` / generic. **Keep the literal codes/copy** — host_permissions and the proxy contract both depend on these endpoints/error shapes.

---

## 7. Risks & open questions for the TS/Vite split

**Tight coupling / shared state crossing concerns:**
1. **All session state is module-global `let`s** (`content.js:73-107`): `pageToken, session, prevSession, settings, history, currentTargetText, currentSourceText`, all the timers, `videoEl`, the video-listener fn refs, `desiredOriginalVol/lastOriginalWriteAt`, `lastRateToastAt`. A clean split is a `SessionController` owning `session/prevSession/pageToken` and an injected `Overlay`/UI port. **`pageToken` is global, not per-session** — Stop bumps it to invalidate ALL pipelines at once. If a TS refactor moves it onto the session object, F6 breaks for the build-in-progress (no session yet) and for the no-captions fallback. **Keep `pageToken` module-scoped.**
2. **`settings` is read live, mutated in place** by pipelines (`settings.targetLanguage = newLang` `content.js:256`), the message router, and `applySettingsLive`. A `readonly` TS type or a copy-on-write store would change timing (the chunk loop reads `settings.targetLanguage` at chunk time, `content.js:1234`). Preserve mutate-in-place semantics or audit every read.
3. **Three near-identical Web Audio graph builders** and **two `/audio/speech` callers** with subtly different bodies (chunk has `speed`, sentence doesn't). Tempting to merge — must keep the body difference.
4. **`apiBase` is a module-global reassigned per session** (`content.js:23,2092`). Realtime SDP (call #2) deliberately ignores it. A TS `ApiClient` must NOT route the OpenAI SDP POST through `apiBase`.
5. **The two-layer token guard `&& vs single ===`** difference (§4) is easy to "normalize" wrongly. Lock it in tests.
6. **F9 guard semantics under bundling** (§4) — biggest structural risk. Vite output must remain a single IIFE-equivalent that early-returns on re-inject, not an ES module.
7. **Subtitle-first tier is undocumented in the brief but is the primary Standard path.** Any "standard pipeline" module must include it + the fallback chain + the webRequest-intercept dance.
8. **`processStandardChunk` is ~150 lines doing 6 sequential awaits each followed by a guard.** Splitting into a `Pipeline` of awaitable steps must re-insert a guard after EVERY await (table row 14) or it silently regresses the credit-burn protection.

**CROSS-SLICE FLAGS:**
- **→ Agent 1 (background messaging):**
  - Message contract content depends on: inbound `CONTENT_PING / CONTENT_START{settings} / CONTENT_STOP / CONTENT_UPDATE_SETTINGS{settings} / CONTENT_UPDATE_VOLUME{originalVolume,voiceVolume}` (`content.js:2378-2404`); outbound `CONTENT_STATE / CONTENT_ENDED / GET_YT_CC_URL{videoId} / UPDATE_SETTINGS{settings}`.
  - **SUBTLE: content sends `{type:"UPDATE_SETTINGS"}` (`content.js:259,270,952`) but because it carries a `sender.tab`, background routes it to `handleContentEvent` which only handles CONTENT_STATE/CONTENT_ENDED (`background.js:435-438`) — so content-originated `UPDATE_SETTINGS` is effectively a no-op `{ok:true}`.** The popup-path `UPDATE_SETTINGS` (`background.js:484`) is a DIFFERENT handler. The content router returns `true` (async sendResponse) for every case (`content.js:2404`), but `applySettingsLive` never reads `reply.state` even though background's `handleUpdateSettings` expects `reply.state` from a CONTENT_UPDATE_SETTINGS reply (`background.js:358`) — content does NOT send a `state` back (`content.js:2393`). Document this asymmetry so the rewrite doesn't "fix" it and change behavior.
  - `GET_YT_CC_URL` is a **callback-style** `sendMessage(msg, cb)` (`content.js:1458`), the only place content uses the 2-arg form; everything else is fire-and-forget via `notifyBackground`. Background replies `{ok, url, lang, kind, isAsr, tlang}` (`background.js:430-432`). The whole subtitle-first layer-1 depends on background's webRequest cache (`background.js:33-60`).
  - `kymaKey` in settings is actually the **resolved bearer** (Kyma key OR Echoly session token) injected by background (`background.js:307`) — name is legacy. Keep the field name `kymaKey` to avoid breaking the message contract unless Agent 1 renames it on both sides.
- **→ Agent 3 (overlay UI):** the logic↔UI call surface listed in §0 (`buildOverlay/removeOverlay/setStatusText/setOverlayState/setTargetText/showToast/pushHistoryTurn/renderHistory/populateVoicePicker/applySourceVisibility` + `elements.*` reads + `elements.source.textContent` writes from caption poll & live display). The select `change` handlers (`content.js:253-274`) live in `buildOverlay` (Agent 3) but call OUR `requestHandover`/`notifyBackground`/`applySettingsLive` — **this is the shared seam to define a port interface for.** `showToast`'s 3 call signatures (text+ms, text+opts+ms) (`content.js:333-353`) are used by logic for errors with CTA — lock the signature. `removeOverlay` nulling `root` is what makes the no-caption-fallback ordering load-bearing (§3b) — logic depends on the timing of Agent 3's `removeOverlay`.

---

## Quick reference — symbol → line index
findVideo 509 · isLive 516 · captureWithRetry 525 · parseKymaError 544 · startHeartbeat 567 · startSessionTimer 582 · endKymaSession 601 · waitForPCConnected 616 · buildRealtimeSession 637 · handleRealtimeEvent 799 · computeGain 831 · applyVolumes 835 · bindVolumeDriftGuard 877 · bindRateChangeWarn 902 · requestHandover 930 · startStandardSession 1011 · pickRecorderMime 1103 · webmBlobToWav 1117 · audioBufferToWavBlob 1134 · downmixAndResample 1158 · runChunkLoop 1188 · processStandardChunk 1230 · fetchCCViaIntercept 1455 · readPlayerResponseFromDom 1496 · pickCaptionTrack 1528 · fetchYouTubeCaptions 1545 · parseJson3Events 1610 · mergeWithDedupe 1633 · regroupToSentences 1647 · batchTranslateSubtitles 1671 · renderTTSForSentence 1724 · startSubtitleFirstSession 1744 · translateBatch 1950 · renderWaveTTS 1962 · scheduleWindow 1990 · scheduleAroundPlayhead 2011 · cancelPendingSources 2027 · updateLiveDisplay 2035 · runRollingRenderer 2052 · startSession 2087 · stopSession 2239 · applySettingsLive 2316 · SPA watcher 2358 · unload hooks 2369 · message router 2378
