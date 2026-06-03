# First-Connect Realtime Latency Trace
*Branch: wave/smooth-dub — READ-ONLY investigation, 2026-06-02*

---

## 0. Executive Summary

The "long pause during connecting" on the very first Realtime connect has **four
dominant costs**, two of which are one-time-only and two of which recur on every
connect. The biggest fixable one-time cost is the MV3 service-worker cold-start.
The biggest fixable per-connect cost is the sequential (non-overlapped) ordering
of audio capture, RTCPeerConnection setup, and the server round-trip. The
pre-warm system (`/v1/rtc/prepare` + `prepareIntent`) is partially but
**conditionally** effective: it only fires on **hover**, so a keyboard user or a
user who clicks without hovering gets the full cold dial path.

---

## 1. Complete end-to-end trace

### 1.1 Extension side

#### Popup → Background (service-worker)

| Step | File:line | Cost | First-only? |
|---|---|---|---|
| User clicks Start button | `popup/index.ts:862` `onToggle()` | ~0 ms | No |
| Optimistic UI update (synchronous) | `popup/index.ts:808-810` | <1 ms | No |
| `sendToBackground({ type: "START" })` via `chrome.runtime.sendMessage` | `popup/index.ts:811` | 0 ms if SW warm; **200–1500 ms if SW cold-started** | **YES — first message after SW idle** |

**MV3 service-worker cold start** is the largest first-time-only cost on the
extension side. Chrome terminates idle service workers after 30 s of inactivity.
The first `sendMessage` after a cold SW wakes it up. The time from "send" to
"SW receives onMessage" is typically **200–800 ms** on a normal machine and can
reach **1 500 ms** on a slow device or after a Chrome update. The popup already
has a mitigation: it renders optimistically from `chrome.storage` cache
(`popup/index.ts:1202-1208`) so the popup itself looks instant, but the **actual
`START` message is still serialized** through this delay. On subsequent opens
(SW still warm from recent activity) this cost is **0 ms**.

*The popup comment at `popup/index.ts:71`: "masks MV3 service-worker cold-start
latency of 200–1 500 ms" confirms this is a known known.*

#### Background session-coordinator start() path

All of the following happen SERIALLY before `CONTENT_START` is sent to the
content script:

| Step | File:line | Cost | First-only? |
|---|---|---|---|
| `store.persistSettings(settings)` | `session-coordinator.ts:161` | ~1 ms (localStorage) | No |
| `auth.getSessionToken()` | `session-coordinator.ts:163` | ~1 ms (cookie read) | No |
| `hydrateSignedIn()` if user not in store | `session-coordinator.ts:164-166` | **30–200 ms** (GET /session-bootstrap) | **YES — first open after cold SW** |
| `resolveApiMode()` | `session-coordinator.ts:168` | ~1 ms (cached state) | No |
| `sessionTabForStart()` — `chrome.tabs.query` | `session-coordinator.ts:114-126` | ~2-5 ms | No |
| `ensureContentScript()` — PING, then inject if needed | `session-coordinator.ts:132-153` | **50–300 ms if injection needed** | **YES — first use on a tab that loaded before the extension** |
| `relayToContent(tabId, CONTENT_START)` | `session-coordinator.ts:218` | ~2-5 ms (IPC) | No |

**`hydrateSignedIn`**: called only when `token && !state.signedInUser`. On a
cold SW startup the store is empty so this fires. It does a GET to the backend
(`/v1/session-bootstrap` or similar) which adds **30–200 ms** to the path.

**`ensureContentScript`**: does a PING first. If the content script is already
injected (warm tab, same extension lifecycle) this is ~2 ms. If the tab loaded
before the extension started (common: user had YouTube tab open, then installed/
reloaded extension), Chrome must inject content.js (~50 KB bundle) + CSS. The
`chrome.scripting.executeScript` call adds **50–300 ms** on a first injection.

#### Content script → capture → buildSession

| Step | File:line | Cost | First-only? |
|---|---|---|---|
| `initContent()` guard + ContentApp constructor | `content/index.ts:782-791` | <5 ms | No (idempotent guard) |
| `startSession()` → `startWebRtcSession()` | `content/index.ts:271-325` | — | — |
| `adapter.findVideo()` + `capture.isLive()` | `content/index.ts:311` | ~1 ms DOM query | No |
| `overlay.buildOverlay()` | `content/index.ts:363-371` | ~2-5 ms DOM build | No |
| **`capture.captureWithRetry(video)`** | `content/capture.ts:66-93` | **30–500 ms** | **PARTLY first-only** |
| `video.pause()` (non-live VOD sync SF6) | `content/index.ts:389` | ~0 ms | No |

**`captureWithRetry`**: calls `video.captureStream()`. On first call the browser
must hook into the media pipeline. If the video is paused or the pipeline is not
yet hot (e.g. YouTube hasn't started buffering), the stream returns zero audio
tracks and the function retries every 300 ms up to 9 s. On the very first call
on a freshly-loaded page this can be **100–500 ms**. On a warm page where video
is already playing it is **≤30 ms** (single attempt succeeds). There is **no
device permission prompt** — `captureStream()` on a same-origin video element
does not require any permission.

#### WebRTC setup (webrtc-pipeline.ts buildSession)

| Step | File:line | Cost | First-only? |
|---|---|---|---|
| `new RTCPeerConnection()` | `webrtc-pipeline.ts:175` | ~2-5 ms | No |
| `pc.addTrack()` | `webrtc-pipeline.ts:176-178` | ~1 ms | No |
| `pc.createDataChannel()` | `webrtc-pipeline.ts:180` | ~1 ms | No |
| **`new AudioContext()`** | `webrtc-pipeline.ts:188-200` | **5–50 ms first-ever; ~1 ms warm** | **YES — first AudioContext in this content script** |
| `pc.createOffer()` | `webrtc-pipeline.ts:342` | **10–50 ms** | No (same each call) |
| `pc.setLocalDescription(offer)` | `webrtc-pipeline.ts:344` | ~5 ms (triggers ICE gathering) | No |
| **ICE candidate gathering (internal to browser)** | — | **50–300 ms** (network-dependent) | No (each connect) |
| consume pending prepareId | `webrtc-pipeline.ts:349-367` | ~0 ms (in-memory) | No |
| **`fetch POST /v1/rtc/translate`** (full RTT) | `webrtc-pipeline.ts:378-406` | **80–400 ms** | **PARTLY first-only** |
| `pc.setRemoteDescription(answer)` | `webrtc-pipeline.ts:404` | ~5 ms | No |
| Return newSession (buildSession done) | — | — | — |

The `createOffer()` + `setLocalDescription()` pair triggers ICE gathering. The
browser starts sending STUN requests simultaneously, so ICE gathering
**overlaps** with the network round-trip to the server. This is the one piece
that is already implicitly parallelized by the browser.

**First-time TLS cost to api.echolyhq.com**: On the very first request from this
browser to the Echoly API in this session, TLS handshake adds **30–150 ms** over
what subsequent requests cost (which reuse the TLS session). This is a browser-
level one-time cost per origin. Subsequent requests reuse the connection.

#### Post-buildSession VOD align

| Step | File:line | Cost |
|---|---|---|
| `capture.waitForPCConnected(pc, 3000)` | `content/index.ts:470` | waits for ICE/DTLS (see server side) |
| `alignRealtimeVodBeforePlay()` | `content/index.ts:491` | up to 2000 ms ceiling, event-driven |
| `video.play()` | `content/index.ts:499` | ~0 ms |

`alignRealtimeVodBeforePlay` (`lib/standard-vod-start.ts:25-84`) waits for the
remote `<audio>` element to fire `canplay` / `loadedmetadata`, polling every
16 ms. It resolves immediately if the element already has `readyState >= 1`. The
ceiling is 2 000 ms. In practice, if OpenAI hasn't sent the first audio delta
yet, this waits the full 2 s. The constant `REALTIME_VOD_PLAY_ALIGN_MS = 80`
(constants.ts:66) is the default but the function clamps to
`Math.max(80, 2000) = 2000 ms` ceiling always. This is a per-connect cost but
NOT a one-time cost — it happens on every VOD connect.

#### prepareIntent: does it fire on first connect?

**Only if the user hovers the Start button.** The event chain is:

```
popup/index.ts:880  toggleBtn.addEventListener("mouseenter", maybeSendPrepareIntent)
popup/index.ts:881  toggleBtn.addEventListener("focus", maybeSendPrepareIntent)
```

`maybeSendPrepareIntent` sends `PREPARE_INTENT` to the background SW
(`router.ts:184-186`), which calls `prepareIntentOnActiveTab(store)` and relays
`CONTENT_PREPARE_INTENT` to the content script (`router.ts:208-233`). The content
script handler at `content/index.ts:833-851` calls `webrtc.prepareIntent()`.

`prepareIntent` (`webrtc-pipeline.ts:134-162`) fires a POST to `/v1/rtc/prepare`,
which in turn calls `rtcPeer.prepare()` (`mediasoup.peer.ts:1022-1122`). This
creates a `WebRtcTransport` eagerly AND pre-dials the OpenAI WS via
`_dialWarmWs(targetLanguage)` (`mediasoup.peer.ts:1065-1073`). The warm slot is
stored in `_warmSlots` for up to `prepareTtlSec` seconds (default 30 s,
`mediasoup.peer.ts:1091`).

**Critical gap: if the user clicks Start without hovering** (keyboard, touch,
programmatic click, auto-start), `prepareIntent` is NEVER called. The user gets
the full cold path every time. This includes:
- First Realtime session ever (user just switched to Realtime tier and immediately clicks)
- Auto-start sessions (no hover event possible)
- Touch/mobile-style interaction patterns

Even when the user does hover, the SW may be cold when the PREPARE_INTENT arrives,
consuming the hover lead-time on SW warm-up rather than on the prepare call.

---

### 1.2 Server side

#### POST /v1/rtc/translate handler

| Step | File:line | Cost | First-only? |
|---|---|---|---|
| CORS preflight (OPTIONS) if cross-origin | — | **50–150 ms extra RTT** | No (each cold connection) |
| `requireAuth` preHandler → `authService.resolveToken()` | `rtc.routes.ts:177` → `auth.hook.ts:81` | — | — |
| → Redis session cache hit | `auth.service.ts:300` | **~1-3 ms** (R-auth) | No |
| → Redis cache miss + PG query | `auth.service.ts:318` | **~5-20 ms** | **YES — first request after cold SW** |
| → `refreshEntitlement` tier PG read (every 30 s per-token) | `auth.service.ts:369` | ~5-10 ms | No (30 s debounce) |
| `isRateLimited()` — Redis INCR | `rtc.routes.ts:319` | ~1-2 ms | No |
| `resolveRtcPipeline()` | `rtc.routes.ts:324` | ~0 ms (pure) | No |
| **`usagePeriodService.resolve()`** — PG query | `rtc.routes.ts:329` | **~5-15 ms** | No |
| Language pair check, SDP validation | `rtc.routes.ts:356-389` | ~0 ms (pure) | No |
| **`rtcPeer.claimWarmSlot()` or cold `rtcPeer.answer()`** | `rtc.routes.ts:430-467` | see below | No/Yes |
| `metering.reserve()` — Redis Lua script | `rtc.routes.ts:501-519` | ~2-5 ms | No |
| `reply.send(answer.sdp)` | `rtc.routes.ts:546` | — | — |
| `bridgeService.run()` (async, after reply) | `rtc.routes.ts:564` | does NOT block SDP response | No |

**Auth cold path**: The very first request from a new session (cold SW) has an
empty Redis session cache. `resolveToken` falls through to PG (`auth.service.ts:318`:
`sessionsRepo.findUserByToken`). This is a JOIN query on sessions+users. Estimate:
**5–20 ms** depending on PG load. Subsequent requests within the 30 s tier refresh
window hit only Redis: **1-3 ms**.

#### rtcPeer.answer() — mediasoup cold path

| Step | File:line | Cost | First-only? |
|---|---|---|---|
| `this._initialized` check → `await this.init()` guard | `mediasoup.peer.ts:841` | **skipped after boot** | **YES — one-time at server startup** |
| `router.createWebRtcTransport()` | `mediasoup.peer.ts:858-868` | **20–80 ms** | No (each connect) |
| `recvTransport.connect()` (DTLS params) | `mediasoup.peer.ts:878` | ~2-5 ms (sync IPC to C++ worker) | No |
| `recvTransport.produce()` (browser producer) | `mediasoup.peer.ts:887-891` | ~2-5 ms | No |
| `router.createDirectTransport()` | `mediasoup.peer.ts:896` | ~2-5 ms | No |
| `directTransport.consume()` | `mediasoup.peer.ts:898-903` | ~2-5 ms | No |
| `directTransport.produce()` (outbound) | `mediasoup.peer.ts:916-925` | ~2-5 ms | No |
| `recvTransport.consume()` (browser consumer) | `mediasoup.peer.ts:937-941` | ~2-5 ms | No |
| `buildSdpAnswer()` | `mediasoup.peer.ts:983-990` | ~1 ms | No |

**Mediasoup worker pool**: Workers are spawned at server boot by `await peer.init()`
(`mediasoup.peer.ts:802-825`). The `answer()` code at line 841 guards:
`if (!this._initialized) await this.init()`. In production this is always already
initialized before the first request. The first-time-only cost is at **server
boot** (not visible to the user). Each call to `answer()` costs **~30–110 ms**
total for the transport chain — this is a per-connect cost.

**answerWarm() on the pre-warm path**: When a `warmSlot` is claimed
(`claimWarmSlot`), `answerWarm()` is called. The pre-allocated `WebRtcTransport`
is reused (skipping `router.createWebRtcTransport()`), saving **~20–80 ms**. The
remaining produce/consume/attach calls still happen (~20 ms). This is the main
server-side benefit of pre-warm.

#### Bridge.run(): ICE/DTLS + OpenAI WS (parallelism analysis)

After the SDP answer is sent, `bridgeService.run()` fires async
(`rtc.routes.ts:564`). Inside `BridgeRun.run()` (`rtc-bridge.service.ts:242-357`):

```
Line 280-301: if (useGpt && gpt != null && warmWs == null) {
  // S1: concurrent dial + waitConnected
  const dialPromise = gpt.dial("live", targetLanguage);       // ~80-200 ms
  [warmWs, connected] = await Promise.all([dialPromise, this.session.waitConnected(10_000)]);
```

**S1 is the most important optimization already implemented**. When there is NO
pre-warmed WS (cold path), the OpenAI WS dial runs **concurrently** with
`session.waitConnected(10_000)` (ICE/DTLS). On a typical path:
- ICE/DTLS: **150–500 ms** (most of which is browser ICE gathering + STUN, already
  in flight since `setLocalDescription`)
- OpenAI WS dial: **80–200 ms** (DNS + TLS + WS upgrade to api.openai.com)

Because they run in `Promise.all`, the effective cost is `max(ICE, dial)` not
`ICE + dial`. This saves **80–200 ms** on the critical path.

**When pre-warmWs IS present** (hover path), `warmWs` is already open from
`/v1/rtc/prepare`. The bridge skips the dial entirely and goes straight to
`session.waitConnected(10_000)`. On ICE paths where DTLS completes in
**<150 ms** (LAN/same-region), the pre-warm saves the full dial time.

**`session.waitConnected(timeoutMs)`** resolves when mediasoup fires
`dtlsstatechange → "connected"` on the WebRtcTransport
(`mediasoup.peer.ts:344-349`). DTLS requires ICE to complete first.
ICE completion time: **50–300 ms** (typical UDP); DTLS handshake adds another
**20–80 ms**. Total `waitConnected`: **70–380 ms**.

**First audio from OpenAI**: After `relay()` starts, OpenAI begins sending
`response.audio.delta` (base64 PCM16/24k) over the WS. Time-to-first-audio from
when the WS session is configured and audio starts flowing: **200–800 ms** (OpenAI
model startup, VAD detection, first translation chunk). This is network/model
physics — not fixable in our code.

---

## 2. Ranked dominant causes of first-connect pause

### One-time costs (slow only on the very first connect after SW idle)

| Rank | Cost | Estimate | Source |
|---|---|---|---|
| 1 | **MV3 service-worker cold start** | 200–1500 ms | Chrome terminates idle SWs after 30 s; first `sendMessage` wakes it up |
| 2 | **`hydrateSignedIn` bootstrap call** | 30–200 ms | Only when SW just woke up and store is empty; hits server GET endpoint |
| 3 | **First TLS handshake to api.echolyhq.com** | 30–150 ms | Browser TLS session reuse per origin; first request pays full handshake |
| 4 | **Content script injection** | 50–300 ms | Only if tab loaded before extension (common); `chrome.scripting.executeScript` |

### Per-connect costs (every Realtime connect, not just first)

| Rank | Cost | Estimate | Source |
|---|---|---|---|
| 5 | **captureWithRetry first-attempt lag** | 30–500 ms | `captureStream()` on paused/cold video; retries every 300 ms |
| 6 | **ICE gathering + DTLS on browser side** | 70–380 ms | Browser physics; STUN RTT + DTLS handshake |
| 7 | **mediasoup `answer()` transport chain** | 30–110 ms | `createWebRtcTransport` + produce/consume/attach (~6 IPC calls to C++ worker) |
| 8 | **Network RTT to server** | 50–200 ms | Internet connection quality; TLS reuse after first connect |
| 9 | **`alignRealtimeVodBeforePlay` ceiling** | up to 2000 ms | Waits for first OpenAI audio delta before unpausing VOD; this is the user-visible "stuck connecting" on slow paths |
| 10 | **OpenAI TTFA** | 200–800 ms | Model startup + VAD + first translation chunk; network/model physics |

---

## 3. What is already optimized and whether it helps first cold connect

| Optimization | Implemented | Helps cold first connect? |
|---|---|---|
| **S1: concurrent `gpt.dial()` + `waitConnected()`** | YES — `rtc-bridge.service.ts:280-301` | YES, saves 80–200 ms by hiding OpenAI WS handshake behind ICE |
| **Pre-warm `/v1/rtc/prepare`** (transport + WS pre-dial) | YES — `mediasoup.peer.ts:1022-1122`, `rtc.routes.ts:104-171` | **CONDITIONALLY** — only if user hovered Start button AND SW was warm AND prepare completed before click. Three failure modes: no hover, cold SW, click too fast after hover |
| **`prepareIntent` fired on hover** | YES — `popup/index.ts:869-885` | Only saves on hover path; keyboard/auto-start/touch users get cold path always |
| **Popup optimistic pre-render from storage cache** | YES — `popup/index.ts:1196-1210` | YES for popup render latency only; does not reduce actual connect time |
| **Redis session cache for auth** | YES — `auth.service.ts:299-315` | YES on warm SW; first request after cold SW still hits PG |
| **Tier refresh 30 s debounce (S3)** | YES — `auth.service.ts:362-366` | Saves ~5-10 ms on warm requests |
| **`usagePeriodBounds` resolved once (B-3)** | YES — `rtc.routes.ts:329` | Saves one duplicate PG query per request |
| **Mediasoup worker pool pre-initialized at boot** | YES — `mediasoup.peer.ts:802-825` + `init()` called at `buildApp` | YES — workers ready before first request |
| **`answerWarm()` skips transport creation** | YES — `mediasoup.peer.ts:1164-1280` | YES when warm slot claimed; saves ~20-80 ms |

---

## 4. Concrete further optimizations, ranked by impact/effort

### O1: Trigger prepareIntent on session-intent, not just hover (HIGH impact, LOW effort, LOW risk)
**Current**: `prepareIntent` fires on `mouseenter` and `focus` events on the
Start button (`popup/index.ts:880-881`). This misses keyboard users, touch users,
and auto-start entirely.

**Fix**: Also fire `prepareIntent` when:
- The popup opens (`initPopup`, after `GET_STATE` reply) if the user is logged-in
  and Realtime is selected — fire immediately without waiting for hover.
- Auto-start registers (background `auto-start.ts`) — fire before the auto-start
  delay.
- `tierSelect` changes to Realtime — fire immediately.

**Risk**: Each `prepareIntent` allocates a mediasoup transport and pre-dials
OpenAI WS. Max 2 warm slots per user (`RTC_PREPARE_MAX_PER_USER=2`, evicts
oldest). Over-firing at popup open would waste one slot if the user never starts.
The slot expires in 30 s. Cost is ~one extra connection to OpenAI per popup open
(negligible, non-billable per D-meter invariant).

**Saves**: The full cold-dial savings (80–200 ms WS + 20-80 ms transport) on
every non-hover scenario.

---

### O2: Pre-warm the SW before popup action by firing SW keepalive (MEDIUM impact, LOW effort, LOW risk)
**Current**: The extension has no background SW keepalive. After 30 s idle, the
SW dies. First `sendMessage` from popup wakes it up (200–1500 ms penalty).

**Fix**: From the content script (which runs persistently on the page), send a
lightweight `PING` to the background SW every 20 s when a Realtime session is
NOT running. This keeps the SW alive. WXT supports content scripts with
`matches` and `runAt: "document_start"` for persistent scripts.

**Alternative (less invasive)**: At popup open time, send a `chrome.runtime.connect()`
with a port name. This also wakes the SW and keeps it alive for the duration the
popup is open. The popup already sends `GET_STATE` which achieves this, but
doing so via a long-lived port (instead of a single message) keeps the SW warm
even before the user triggers START.

**Risk**: An SW keepalive increases Chrome battery/memory use (SW runs slightly
more often). Chrome has hard limits on SW lifetime (5 minutes max with a port
connection). Not all Chrome versions handle this the same way.

**Saves**: 200–1500 ms on cold SW starts — the single largest first-connect cost.

---

### O3: Pre-create RTCPeerConnection before Start (MEDIUM impact, MEDIUM effort, MEDIUM risk)
**Current**: `new RTCPeerConnection()` and `createOffer()` happen inside
`buildSession()`, AFTER the user clicks Start and the capture stream is acquired
(`content/index.ts:409` calls `webrtc.buildSession()`).

**Fix**: On popup-open (or when `prepareIntent` fires), pre-create a
`RTCPeerConnection`, call `createOffer()`, and keep the offer cached. ICE
candidates begin gathering immediately. When Start is clicked, reuse the existing
PC and cached offer — skip ~20 ms + ICE gathering head-start.

**Risk**: Pre-created PCs that are never used consume ICE candidates / STUN
quota. Must be carefully cleaned up if the user closes the popup without starting.
The pre-offer SDP will have ICE candidates from before user input; if network
changes between pre-create and actual connect, ICE may need to re-gather anyway.

**Saves**: ~10-20 ms for PC + offer creation + 50-200 ms ICE gather head-start
(ICE gathering starts before the user clicks).

---

### O4: Pre-capture audio stream on page load (LOW impact, HIGH effort, HIGH risk)
**Current**: `captureWithRetry()` runs after Start is clicked. On a paused or
just-loaded video it retries every 300 ms.

**Fix**: On session-start intent detection (popup visible + Realtime + logged in),
pre-call `captureStream()` speculatively. Cache the stream; if the user clicks
Start within 10 s, reuse it.

**Risk**: Browser requires user gesture to start capture in some scenarios.
`captureStream()` on a video element does NOT require a gesture, but:
1. On YouTube, the video must be actively buffering (may be paused).
2. A pre-captured stream may go stale if the video element is replaced by YouTube
   SPA navigation.
3. This is architecturally invasive — `AudioCapture` currently has no pre-capture
   state.

**Saves**: 30–500 ms on the captureWithRetry retry loop.

---

### O5: Pre-open TLS connection to api.echolyhq.com (VERY LOW impact, HIGH effort, MEDIUM risk)
**Current**: The first HTTPS request to `api.echolyhq.com` from a new browser
session pays the full TLS handshake (~30-150 ms extra).

**Fix**: At content-script load or popup open, fire a dummy GET to a lightweight
endpoint (e.g. `/v1/health`) to warm the TLS session. Subsequent `POST /v1/rtc/translate`
reuses the TLS session.

**Risk**: Adds an extra network request on every page load. On mobile/throttled
connections this may slow things down more than it saves. Most users' browsers
already have a warm connection to api.echolyhq.com from recent popup opens or
settings fetches. Very low incremental value.

**Saves**: 30-150 ms on truly first-ever connections; near-zero on returning sessions.

---

### O6: Reduce `alignRealtimeVodBeforePlay` ceiling (MEDIUM impact, VERY LOW effort, LOW risk)
**Current**: `alignRealtimeVodBeforePlay` has a ceiling of `Math.max(alignMs, 2000)`
= 2000 ms (`lib/standard-vod-start.ts:31`). On slow paths where OpenAI hasn't
sent its first audio delta yet, this holds the video paused for up to 2 s before
giving up and playing anyway.

**Fix**: Either:
- Reduce `REALTIME_VOD_PLAY_ALIGN_MS` from 80 ms and remove the 2000 ms override
  (`Math.max(alignMs, 2000)` → just `alignMs`). This means the function respects
  the 80 ms constant as the true ceiling rather than a floor.
- Or: display a "Translating, starting in…" countdown so the user sees progress
  rather than a frozen spinner.

**Risk**: If OpenAI first audio arrives after 80 ms, the video plays before the
dub is ready. The user hears the source audio first (for <200 ms) before the dub
starts. Whether this is better UX than the pause depends on the use case.

**Saves**: Up to 2000 ms on slow OpenAI paths. On typical paths (first audio
arrives in ~300 ms), the current event-driven wait already resolves early.

---

## 5. Costs that are browser/network physics and cannot be fixed in our code

| Cost | Why unavoidable |
|---|---|
| **ICE gathering (STUN RTT)** | Browser/network physics. Chrome waits for STUN server replies before completing ICE. UDP RTT to STUN server (usually ~50 ms). Cannot be skipped — required for NAT traversal. |
| **DTLS handshake** | Required by WebRTC spec for media encryption. ~20-80 ms after ICE. |
| **OpenAI WS TLS + session setup** | DNS + TCP + TLS + WS upgrade to api.openai.com. Minimum ~80 ms per the laws of physics (2+ RTTs). Already overlapped with ICE by S1. |
| **OpenAI model TTFA (time-to-first-audio)** | Model must process input context, generate translation, and stream the first audio delta. Minimum ~200 ms even on OpenAI's best hardware. |
| **Network RTT extension→server** | Geographic distance. Cannot be eliminated; can be reduced by edge deployment. |
| **Chrome MV3 SW 30 s termination** | Chrome platform policy. Can be worked around with keepalives but not eliminated entirely. |

---

## 6. Key file:line references

| Item | File | Line |
|---|---|---|
| prepareIntent fired on hover/focus | `src/popup/index.ts` | 869-885 |
| prepareIntent debounce flag | `src/popup/index.ts` | 869-885 |
| `maybeSendPrepareIntent` guards | `src/popup/index.ts` | 870-879 |
| PREPARE_INTENT relay to content | `src/background/router.ts` | 208-233 |
| CONTENT_PREPARE_INTENT handler | `src/content/index.ts` | 833-851 |
| `prepareIntent()` (fetches /v1/rtc/prepare) | `src/content/pipelines/webrtc-pipeline.ts` | 134-162 |
| `buildSession()` start | `src/content/pipelines/webrtc-pipeline.ts` | 164 |
| AudioContext creation (first-time cost) | `src/content/pipelines/webrtc-pipeline.ts` | 184-200 |
| captureWithRetry (300 ms retry loop) | `src/content/capture.ts` | 66-93 |
| waitForPCConnected (gates VOD play) | `src/content/capture.ts` | 97-119 |
| alignRealtimeVodBeforePlay 2000 ms ceiling | `src/lib/standard-vod-start.ts` | 31 |
| REALTIME_VOD_PLAY_ALIGN_MS = 80 | `src/shared/constants.ts` | 66 |
| SW cold-start comment | `src/popup/index.ts` | 71 |
| POST /v1/rtc/prepare handler | `src/http/routes/rtc.routes.ts` | 104-171 |
| POST /v1/rtc/translate handler | `src/http/routes/rtc.routes.ts` | 173-568 |
| S1 concurrent dial + waitConnected | `src/services/rtc-bridge.service.ts` | 280-301 |
| mediasoup answer() transport chain | `src/services/rtc/mediasoup.peer.ts` | 837-991 |
| prepare() warm slot allocation | `src/services/rtc/mediasoup.peer.ts` | 1022-1122 |
| answerWarm() reuses pre-allocated transport | `src/services/rtc/mediasoup.peer.ts` | 1164-1280 |
| worker pool init (at server boot) | `src/services/rtc/mediasoup.peer.ts` | 802-825 |
| auth resolveToken Redis fast path | `src/services/auth.service.ts` | 299-315 |
| auth resolveToken PG slow path | `src/services/auth.service.ts` | 317-326 |
| dialWarmWs injection into createRtcPeer | `src/app.ts` | 225-228 |
