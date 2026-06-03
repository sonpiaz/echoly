# First-Connect Latency Analysis — Standard Tier

Branch: `wave/smooth-dub`  
Date: 2026-06-02  
Scope: read-only; no code changes.

---

## Overview

Standard tier has two sub-paths:

| Sub-path | Trigger | Server route |
|---|---|---|
| **Subtitle-first** (SF) | YouTube VOD + captions found | `POST /v1/translate/subtitles/stream` |
| **Standard-WebRTC** (SWR) | Live stream, no captions, non-YouTube | `POST /v1/rtc/translate` + MiniMax chain |

Both share the same popup→background→content START chain and the same auth preHandler. They diverge inside `ContentApp.startSession()` (`src/content/index.ts:314`).

---

## Part 1 — Shared "Start" chain (both sub-paths)

### 1a. MV3 Service-Worker cold start

**File:** `src/entrypoints/background.ts:7`, `src/background/index.ts:16`

MV3 service workers are terminated after ~30 s of inactivity. On the **first message** from popup to an idle SW:

- Browser spawns a new SW context: **100–600 ms** (Chrome on Windows/WSL; fast on Mac, slow on a cold CPU).
- `initBackground()` runs synchronously: `new Store(auth)`, `new SessionCoordinator()`, `installAllBackgroundServices()`, adds all listeners. This is cheap (< 5 ms), but it must complete before the SW can handle the popup's `START` message.
- After cold-start the SW is **warm** for ~30 s. A second Start within that window skips this cost entirely.

**This is a ONE-TIME cost per browser session idle period, not per video.**

### 1b. Popup → Background → Content relay

**File:** `src/background/session-coordinator.ts:156–244`

Sequential steps on every Start (warm SW):

1. `auth.getSessionToken()` → `chrome.storage.local.get()` — **1–3 ms** (IPC to storage).
2. If token present but `signedInUser` stale: `hydrateSignedIn()` → GET `/v1/session/bootstrap` — **50–300 ms round-trip**. This fetch happens once per SW cold start; subsequent Starts skip it (in-flight deduplication guard at `src/background/hydrate-signed-in.ts:28`).
3. `resolveApiMode()` — no network, reads Store state — **<1 ms**.
4. `sessionTabForStart()` → `chrome.tabs.query()` — **2–8 ms** (IPC).
5. `ensureContentScript()` → PING relay → if CS alive, returns immediately (**5–15 ms round-trip**). If CS not injected (first time on this tab): `chrome.scripting.executeScript()` + `insertCSS()` — **50–150 ms** additional.
6. `relayToContent(tabId, {type:"CONTENT_START"})` — IPC to content tab — **1–5 ms**.

**First-time-only costs in 1b:**  
- `hydrateSignedIn()` bootstrap fetch: **+50–300 ms** (once per SW cold-start cycle).  
- Content script injection: **+50–150 ms** (once per tab load).

### 1c. Server-side auth preHandler (every request)

**File:** `src/http/hooks/auth.hook.ts:63`, `src/services/auth.service.ts:295`

`requireAuth` calls `authService.resolveToken(token)`:
- **Warm path** (Redis cache hit): Redis `GET` (**0.5–2 ms** on same-AZ Redis) + PG `users` read gated by 30 s TTL memo (`TIER_REFRESH_TTL_MS=30_000`). On a warm session within 30 s: **<3 ms total**.
- **Cold path** (first request / after Redis eviction): PG JOIN `sessions + users` (**3–10 ms**) + Redis `SET` to warm cache. This is the **first request after SW cold-start**.

**First-time-only:** on the very first authenticated request the Redis session cache is cold → **+5–8 ms** vs. warm.

---

## Part 2 — Subtitle-First sub-path

### 2a. Complete timing breakdown

`SubtitleFirstPipeline.start()` — `src/content/pipelines/subtitle-first-pipeline.ts:60`

```
T=0ms   popup Start click
T+1ms   SW wakes (if warm), processes message
T+100–600ms  [COLD SW only] SW cold-start spawn
T+5ms   chrome.tabs.query → find tab
T+5ms   CONTENT_PING round-trip (CS already injected)
T+15ms  relayToContent (CONTENT_START)

[ContentApp.startSession() → subtitleFirst.start()]

T+16ms  new AudioContext()          ← synchronous, ~0 ms
T+16ms  audioCtx.resume()           ← async, starts but NOT awaited here
T+16ms  video.pause()               ← synchronous

── CAPTION FETCH ──
T+16ms  getPrefetchedCaptions(videoId)

  CASE A: B4 prefetch warm (NavigationWatcher fired ≥700ms before Start)
    → null fetch, 0 ms.  [SEE NOTE BELOW ON "WARM" DEFINITION]

  CASE B: prefetch not yet done / cache miss:
    fetchCCViaIntercept():
      - sendFromContent({type:"GET_YT_CC_URL"})  → BG message round-trip ~5ms
      - if URL in ytCaptionCache (background webRequest interceptor): returns immediately
      - else: clicks CC button, polls 100ms×18 = up to 1800ms
    → then fetch timedtext JSON3 URL: 50–300ms (YouTube CDN, usually fast)
    TOTAL: 100–400ms typical; 1800ms worst-case

── regroupToSentences() ── sync, <1ms (pure JS)

── INITIAL RENDER BATCH ── (SUBFIRST_PREBUFFER_COUNT=1 line)
  POST /v1/translate/subtitles/stream

  Server:
    auth preHandler:         0.5–10ms (warm/cold Redis)
    redis rate-limit check:  1–2ms
    metering.reserve():      1–3ms (Redis Lua, fast)
    LLM translate (Gemini):  600–2000ms  ← DOMINANT
    reserve TTS leg:         1–3ms
    SSE stream starts: first line arrives to client as soon as Gemini returns
    Per-line TTS (MiniMax):  200–600ms per line  ← SECOND DOMINANT
    First SSE "line" event arrives to extension: ~800–2500ms from POST

  Extension receives first SSE line:
    atob() base64 → ArrayBuffer: <1ms
    audioCtx.decodeAudioData(mp3): 10–50ms (async, runs in separate thread)

Total for #renderBatch (1 line):  ~1000–3000ms

── audioCtx.resume() await ── (subtitle-first-pipeline.ts:268-273)
  If context suspended: await resume(), bounded to 400ms.
  Chrome's AudioContext starts suspended on first create (no user gesture in SW context).
  On first Start the context IS suspended → this adds 50–400ms.
  [IMPORTANT: already partially mitigated — resume() was called at T+16ms and
   the await here is bounded 400ms, so in practice 10–80ms if resume already progressing]

── video.play() await ── ~5–20ms
── playbackTick() immediate call ── <1ms, starts first cue
── runRollingRenderer() starts ── parallel, non-blocking

TOTAL "connecting" duration (warm SW, warm caption prefetch):
  ~1200–3500ms typical; dominated by Gemini first-token latency.

TOTAL "connecting" duration (cold first-ever session):
  +100–600ms SW cold start
  +50–300ms hydrateSignedIn bootstrap
  +50–150ms content script injection  
  +100–400ms caption fetch (if prefetch miss)
  = +300–1450ms additional
  Grand total: ~1500–5000ms
```

### 2b. Is the B4 caption prefetch warm on first connect?

**File:** `src/content/navigation.ts:168–193`

The B4 prefetch fires when:
1. No active session (`sm.session == null`), AND
2. The URL debounce settles (`NAV_DEBOUNCE_MS=700 ms`), AND
3. Adapter has `capabilities.subtitleFirst` (YouTube).

On **first page load**: the NavigationWatcher is created inside `startSession()` (`src/content/index.ts:292`), so it does NOT exist before Start is clicked. The prefetch is therefore **always cold on the first Start of a browser session.**

The prefetch IS warm on:
- Second Start after navigating to a new YT video (the watcher was running from the previous session → fired the prefetch).
- Auto-next (the watcher observes the SPA nav, prefetch fires 700 ms before the next session starts).

**Conclusion: on the very first Start on a fresh tab/session, the caption prefetch adds ~100–400 ms.**

### 2c. Provider TLS/connection warm-up (first call only)

**File:** `src/services/subtitle-dub.service.ts:184`, `src/providers/translate/tts/minimax.tts.ts:114`

- Gemini (via AI SDK `provider.chatObject()`): Node.js HTTP/2 connection pool. First call in a fresh server process dials TLS to `generativelanguage.googleapis.com`: **50–300 ms** TCP + TLS handshake.
- MiniMax TTS (`fetch` to `api.minimax.io`): first call dials TLS: **50–200 ms**.

After the first call both connections are pooled by Node.js `https.Agent` / undici. Subsequent requests reuse the connection: **0 ms dial overhead**.

**This is a server-process ONE-TIME cost**, not per-user. In production the server is long-lived so these connections are warm within minutes of startup.

### 2d. The SSE streaming path

**File:** `src/lib/echoly-api.ts:128`, `src/http/routes/subtitle-dub.routes.ts` (stream route — file not shown but registered alongside the batch route)

The streaming path (`/v1/translate/subtitles/stream`) returns the first line via SSE as soon as Gemini+TTS complete for that ONE line, without waiting for all N lines. This directly reduces the "blocking prebuffer" to a single Gemini→TTS call, which is already the minimum latency unit.

The `#synthesizeOrdered` loop in `subtitle-dub.service.ts:439` is **serial** (one TTS call at a time), so the first SSE line arrives exactly when `Gemini_TTFT + TTS_TTFA` completes. For one line: typically 800–2500 ms.

### 2e. AudioContext suspension (FIRST CONNECT ONLY)

**File:** `src/content/pipelines/subtitle-first-pipeline.ts:86–98` (create), `src/content/pipelines/subtitle-first-pipeline.ts:268–273` (pre-play resume)

Chrome suspends new `AudioContext` instances unless created in a user-gesture handler. Since the AudioContext is created inside `start()` which is triggered by a message from the background (NOT inside the click handler directly), **the context starts suspended on first create**.

The resume at line 92 is fire-and-forget. The blocking `await audioCtx.resume()` at line 269–273 (bounded 400 ms) happens AFTER `#renderBatch` completes — so it adds to the "video frozen" window only if `resume()` hasn't already resolved during the ~1–3 s batch fetch. In practice, by the time #renderBatch returns, resume has typically already settled → this adds **0–80 ms** on first connect, **0 ms** on warm reconnects.

---

## Part 3 — Standard-WebRTC sub-path

### 3a. Complete timing breakdown

`ContentApp.startWebRtcSession()` — `src/content/index.ts:334`

```
T=0ms   popup Start click
[same SW warm-up + content relay as above]

T+15ms  ContentApp.startWebRtcSession()
T+16ms  overlay.buildOverlay() + setStatusText("Connecting")
T+16ms  capture.captureWithRetry(video)

── captureStream ACQUISITION ──
  First call on this video element:
    video.captureStream()  → usually returns immediately IF video is playing
    If stream has no audio tracks (YT before pipeline hot):
      retry loop: nudgePlay() + 300ms sleep × up to 30 = max 9000ms
  TYPICAL: 0–300ms for a playing video
  FIRST-TIME on a newly-loaded video: may need 1–3 retries → 300–900ms

T+17ms  video.pause()  (non-live VOD, SF6)
T+18ms  sm.nextToken()
T+18ms  webrtc.buildSession()

── WebRTC.buildSession() (webrtc-pipeline.ts:164) ──

T+18ms  new RTCPeerConnection()       ← Chrome allocates ICE agent, ~1ms
T+18ms  pc.addTrack(audioTrack)
T+19ms  pc.createDataChannel("echoly-meta")
T+19ms  new AudioContext()            ← synchronous
T+19ms  pc.createOffer()              ← async; ICE candidate gathering starts

  ICE candidate gathering:
  Chrome gathers local ICE candidates: typically 5–50ms
  (STUN requests if configured; local only is faster)

  FIRST-TIME: Chrome initializes ICE agent infrastructure for this origin.
  This is typically fast (~5 ms) but can be 20–80ms cold.

T+30ms  pc.setLocalDescription(offer)  ← <1ms
T+30ms  POST /v1/rtc/translate (SDP offer in body)

── SERVER: handleRtcTranslate() (rtc.routes.ts:302) ──
  auth preHandler:           0.5–10ms
  rate-limit check (Redis):  1–2ms
  resolveRtcPipeline():      <1ms
  usagePeriodService.resolve() → PG query: 3–10ms  ← ONE PG query per Start
  SDP validation:            <1ms
  mintSessionId():           <1ms (ULID)
  rtcPeer.answer(offer):
    mediasoup allocates WebRtcTransport + produces answer:
    FIRST call on this server process: transport pool cold → 20–100ms
    WARM (pool pre-allocated):         5–20ms
  metering.reserve():        1–3ms (Redis Lua)
  reply SDP:                 <1ms

Total server-side for POST /v1/rtc/translate: ~30–130ms

── EXTENSION: receives SDP answer ──
T+130ms  pc.setRemoteDescription(answer)  ← <1ms

── ICE/DTLS handshake ──
  (client ↔ server, runs concurrently with bridgeService.run() start)
  Typical LAN/same-DC: 50–200ms to "connected"
  Cross-region: 100–500ms

── bridgeService.run() starts (async, after reply sent) ──
  session.waitConnected(10_000): waits for peer to connect
  For standard: #runMinimaxChain()

── Extension: waitForPCConnected(3000) (index.ts:470) ──
  Waits up to 3 s for pc.connectionState === "connected"
  Usually resolves in 50–200ms

── beginStandardDubSync(video) (index.ts:475) ──
  Creates bindStandardDubPlaybackSync handle, no network yet

── standardDubSync.waitForFirstDub(DUB_TTFA_GATE_MS=8000ms) (index.ts:477) ──
  Polls every 80ms for dub.currentTime > 0.04
  This is the MAIN "connecting" wait for Standard-WebRTC

── SERVER: #runMinimaxChain() ── (rtc-bridge.service.ts:360)
  waits for inbound PCM (ICE connected)
  Then: audio.pipeline.ts MiniMaxChainAudioProvider.translate()

  STT_FIRST_SEGMENT_MS = 1000ms  ← accumulates this much PCM before first Gemini call
  After 1000ms of audio arrives:
    Gemini audio-in translate: 600–2000ms (first call cold TLS: +100ms)
    TTS session warmup (MiniMax WS): ~100–300ms (first call)
    Per-clause TTS: 200–600ms TTFA
  First audio chunk pushed to browser peer: ~1900–3900ms from ICE connect

  Then: peer pushes outbound PCM → browser receives via track event
  Browser fires "unmute" on remote track → WebAudio routing: <5ms

Total "connecting" display for Standard-WebRTC VOD (warm server):
  ICE connect:              50–200ms
  PCM accumulation:        1000ms  (STT_FIRST_SEGMENT_MS)
  Gemini translate:        600–2000ms
  MiniMax TTS (WS):        200–600ms
  = ~1850–3800ms from ICE connect
  = ~1950–4100ms from Start click (warm SW, warm session)

FIRST-TIME-ONLY extras:
  SW cold start:           +100–600ms
  hydrateSignedIn:         +50–300ms
  CS injection:            +50–150ms
  captureStream retries:   +0–900ms
  ICE agent init:          +20–80ms
  mediasoup transport cold: +15–80ms
  Gemini TLS cold:         +100–300ms (server-side, once per server restart)
  MiniMax WS cold:         +100–300ms (once per TTS session, i.e. per RTC call)
```

### 3b. STT_FIRST_SEGMENT_MS is the single largest fixable cost

**File:** `core/src/config/env.ts:206`

Default: `STT_FIRST_SEGMENT_MS = 1000 ms`.

This is a hard floor: the pipeline accumulates 1 full second of PCM before making the first Gemini call. The user sees "connecting" for the entire duration of: ICE connect (~150ms) + PCM accumulation (1000ms) + Gemini TTFT (600–2000ms) + MiniMax TTS TTFA (200–600ms). The PCM accumulation is completely idle time from the user's perspective.

### 3c. MiniMax WS warmup (first clause per RTC session)

**File:** `src/providers/translate/audio.pipeline.ts:119–127`

```typescript
const ttsSession = this.#tts.openSession?.();
if (ttsSession?.warmup) {
  void ttsSession.warmup().catch(...);  // fire-and-forget
}
```

The warmup is fire-and-forget (not awaited). The WS connects while PCM is accumulating and while Gemini processes the first window. In practice the WS handshake (~100–300 ms) overlaps with the 1000 ms PCM accumulation + Gemini call → by the time the first clause is ready for TTS, the WS is usually already warm. **This is already well-optimized.**

### 3d. Pre-warm intent (CONTENT_PREPARE_INTENT)

**File:** `src/content/index.ts:833–849`, `src/content/pipelines/webrtc-pipeline.ts:134–162`

`CONTENT_PREPARE_INTENT` is sent on hover/focus. It calls `POST /v1/rtc/prepare` which pre-allocates a mediasoup transport and (for realtime) pre-dials the OpenAI WS. For standard, the comment notes:

```
// D-3: for pipeline=standard the server accepts the request but returns no warm
// WS benefit — the prepare_id is still threaded through and will produce a slot
// that is claimed (transport already allocated). On standard the benefit is
// ~50–100 ms transport-create savings only.
```

**For Standard-WebRTC, prepare-intent saves ~50–100 ms** (transport allocation). Not nothing, but minor compared to STT_FIRST_SEGMENT_MS.

---

## Part 4 — Ranked dominant latencies

### 4a. Subtitle-first (YouTube VOD captions)

| Rank | Cause | Est. ms | One-time or per-connect | Fixed by |
|---|---|---|---|---|
| 1 | Gemini LLM first-token (translate 1 line) | 600–2000 | Per-connect | Unavoidable physics; model latency |
| 2 | MiniMax TTS TTFA for first line | 200–600 | Per-connect | Unavoidable physics; provider |
| 3 | MV3 SW cold-start spawn | 100–600 | One-time (per idle cycle) | SW keep-alive ping |
| 4 | Caption fetch (intercept miss) | 100–400 | One-time per tab load | B4 prefetch (already done) → WARM on 2nd+ Start |
| 5 | `hydrateSignedIn` bootstrap (GET /session/bootstrap) | 50–300 | One-time per SW restart | Can pre-warm earlier |
| 6 | AudioContext suspended resume | 0–80 | One-time per session | Already mitigated; rarely dominant |
| 7 | Content script injection | 50–150 | One-time per tab | Already lazy-injected correctly |
| 8 | Auth hook PG cold path | 5–10 | One-time per SW restart | Redis cache warms after first request |

**Subtotal "connecting" gate on first-ever session:** ~1200–3500 ms (Gemini+TTS) + ~300–1500 ms (SW/bootstrap/caption extras) = **~1500–5000 ms total**.

**On a warm session (SW alive, prefetch done):** ~800–2600 ms, entirely Gemini+TTS.

### 4b. Standard-WebRTC

| Rank | Cause | Est. ms | One-time or per-connect | Fixed by |
|---|---|---|---|---|
| 1 | PCM accumulation gate (STT_FIRST_SEGMENT_MS=1000ms) | 1000 | Per-connect | Reduce env var (tradeoff: worse STT quality on short audio) |
| 2 | Gemini audio-in translate TTFT | 600–2000 | Per-connect | Unavoidable physics |
| 3 | MiniMax TTS TTFA (first clause) | 200–600 | Per-connect | WS warmup already fires concurrently |
| 4 | ICE/DTLS handshake | 50–200 | Per-connect | Unavoidable networking |
| 5 | MV3 SW cold-start | 100–600 | One-time | SW keep-alive |
| 6 | captureStream retries (audio not ready) | 0–900 | One-time per cold video | `nudgePlay` already in place |
| 7 | `hydrateSignedIn` / bootstrap | 50–300 | One-time per SW restart | Pre-warm |
| 8 | mediasoup transport cold alloc | 15–80 | Once per server restart | Already pooled; /prepare helps |
| 9 | Server-side PG `usagePeriodService.resolve()` | 3–10 | Per-connect | Cached after first call |

**Subtotal "connecting" display on warm session:** ~1850–3800 ms from ICE connect, dominated by PCM accumulation + Gemini.

---

## Part 5 — What is already optimized

| Optimization | Status | Helps first cold? |
|---|---|---|
| `SUBFIRST_PREBUFFER_COUNT=1` | Done (`subtitle-first-pipeline.ts:46`) | YES — was N, now 1 line |
| SSE streaming (`/stream` route) | Done | YES — first line arrives before all N are done |
| B4 caption prefetch (NavigationWatcher) | Done | NO on first Start (watcher not yet running); YES on 2nd+ |
| AudioContext pre-resume (line 92) | Done (fire-and-forget early) | Marginal; resume is fast in warm path |
| Await audioCtx.resume() before play (lines 268-273, 400ms cap) | Done | Prevents "video chạy 1 tý mới thấy tiếng" |
| MiniMax WS warmup (fire-and-forget `ttsSession.warmup()`) | Done | YES — overlaps with PCM accumulation |
| S1: concurrent GPT dial + waitConnected (bridge) | Done for realtime; not applicable to standard | N/A for standard |
| /prepare intent on hover | Done; ~50–100ms saving for standard only | YES (minor) |
| Session Redis cache (30s TTL memo) | Done | YES on warm sessions |
| waitForFirstDub gate up to 8s | Done; prevents premature play | Needed, not latency-adding per se |

---

## Part 6 — Concrete optimizations ranked by impact/effort

### O1. Reduce `STT_FIRST_SEGMENT_MS` (Standard-WebRTC only)

**Impact: HIGH (~500–800 ms saved)**  
**Effort: LOW** (single env var change)  
**Risk: MEDIUM** (shorter windows = less audio context for Gemini → lower translation quality, especially on fast speech)

`core/src/config/env.ts:206`: `STT_FIRST_SEGMENT_MS: num(1000)`.

Reducing to 500 ms saves ~500 ms of PCM accumulation. Gemini audio-in performs well on 500 ms of audio for clear speech; 250 ms is pushing it. A conservative improvement is `STT_FIRST_SEGMENT_MS=600–700ms`. This is entirely server-side, zero client change.

Tradeoff: on the first window, less audio = less context = higher chance of partial/wrong translate on short sentences. Accept a lower quality first word in exchange for faster connect.

### O2. SW keep-alive ping (First-ever Start only)

**Impact: HIGH one-time (100–600 ms saved on cold SW)**  
**Effort: LOW**  
**Risk: LOW**

Post a no-op message from the popup to the SW every ~20 s while the popup is open (or from a content script on YouTube). This keeps the SW warm and eliminates the cold-start penalty. Chrome MV3 service workers stay alive for 30 s after the last message; a periodic ping prevents termination.

Alternatively: the auto-start watcher (`src/background/auto-start.ts`) may already exercise the SW — investigate if it prevents cold-start in practice.

### O3. Pre-start B4 caption prefetch on popup open (subtitle-first, first connect)

**Impact: MEDIUM (100–400 ms saved on caption fetch miss)**  
**Effort: MEDIUM**  
**Risk: LOW**

Currently: NavigationWatcher starts inside `startSession()` → watcher only fires AFTER Start is clicked. The prefetch is therefore always cold on the first Start on a fresh tab.

Fix: when the popup opens on a YouTube watch page AND no session is running, immediately trigger `adapter.fetchCaptions(videoId)` from the background (or fire `CONTENT_PREPARE_INTENT` which could include a caption prefetch). This gives ~700ms–2s of warm-up time while the user decides to click Start.

This requires the background to call the content script with a `CONTENT_PREFETCH_CAPTIONS` message when the popup opens, or the popup can send it.

### O4. Pre-dial provider TLS on startup (subtitle-first, server-side)

**Impact: LOW-MEDIUM** (100–300 ms on first call after server restart only)  
**Effort: LOW** (server startup warm-up)  
**Risk: LOW**

In `src/app.ts` (or `buildContainer()`), fire a no-op request to Gemini and MiniMax on server startup to pre-warm the HTTP connection pools. This is a server-side-only change.

### O5. Pre-create AudioContext on first user interaction (before Start)

**Impact: LOW** (0–80 ms saved, already partially mitigated)  
**Effort: MEDIUM**  
**Risk: MEDIUM** (AudioContext should be created on user gesture; creating too early may be refused by the browser)

Currently AudioContext is created inside `start()` (always suspended). If it were created on the first user interaction with the popup or overlay (e.g., popup open), Chrome might grant the autoplay policy. In practice the current `audioCtx.resume()` + 400ms bound at line 268 already handles this adequately.

### O6. Reduce `waitForFirstDub` timeout or add early-bail (Standard-WebRTC)

**Impact: MEDIUM** (improves worst-case "connecting" display, not median)  
**Effort: LOW**  
**Risk: MEDIUM** (early bail means video starts before dub is ready → de-sync)

The `waitForFirstDub` gate (8 s at `DUB_TTFA_GATE_MS`) keeps the video paused while waiting for first dub audio. The median wait is ~2–4 s (PCM + Gemini + TTS). A shorter timeout (e.g. 5 s) reduces worst-case freeze but increases de-sync risk if the chain is slow.

A better approach: instead of a fixed timeout, begin playing at `waitForFirstDub` resolve AND start `snapPlaybackStart` + dub.play() together (already done), but additionally log/metric the p95 TTFA to know if 8 s is ever actually hit.

### O7. Parallel TTS on subtitle-first (server-side, streaming route)

**Impact: MEDIUM** (reduces subsequent batch latency, not first line)  
**Effort: HIGH** (changes the ordered-streaming contract)  
**Risk: HIGH** (ordering guarantee is critical for subtitle alignment)

Currently `#synthesizeOrdered` is **serial** (one TTS at a time) to preserve emission order for SSE. Parallelizing TTS while maintaining order (buffered parallel with ordered yield) would reduce the time between line 1 and line 2 in the prebuffer. For `SUBFIRST_PREBUFFER_COUNT=1` this doesn't affect first-connect latency. Only relevant for prebuffer > 1 or for rolling renderer catch-up speed.

---

## Part 7 — Unavoidable physics vs fixable-in-code

### Unavoidable (physics/provider):
- Gemini LLM first-token latency: ~600–2000 ms. Irreducible short of switching models.
- MiniMax TTS TTFA: ~200–600 ms. Per MiniMax SLA; irreducible.
- ICE/DTLS handshake: ~50–200 ms. Networking; irreducible.
- MiniMax WS connect: ~100–300 ms (already overlapped with PCM accumulation — effectively 0 added time).
- STT_FIRST_SEGMENT_MS accumulation: ~1000 ms default. **Fixable** by reducing the env var at quality tradeoff.

### Fixable:
- SW cold-start: **~100–600 ms** — fix with periodic keep-alive ping from popup.
- Caption fetch (first Start): **~100–400 ms** — fix with pre-fetch on popup open.
- Bootstrap hydration: **~50–300 ms** — already deduped; occurs only once after SW restart.
- STT_FIRST_SEGMENT_MS reduction: **~300–400 ms savings** — server env var.
- Provider TLS warm-up: **~100–300 ms** — server startup pre-warm.

### Summary of achievable improvement

Best case (all fixable items addressed) for subtitle-first first connect:
- Warm SW (keep-alive): saves 100–600 ms
- Pre-fetched captions: saves 100–400 ms  
- Pre-warmed provider TLS: saves 100–300 ms  
- **Net improvement: ~300–1300 ms off the first-connect "connecting" duration**
- Residual: ~900–2200 ms (Gemini + TTS, unavoidable)

Best case for Standard-WebRTC first connect:
- STT_FIRST_SEGMENT_MS: 600ms saves ~400ms
- Warm SW: saves 100–600 ms
- **Net improvement: ~500–1000 ms**
- Residual: ~1400–3500 ms (ICE + Gemini audio-in + TTS)

---

## Key file references

| Component | File | Lines |
|---|---|---|
| SW cold-start, listener registration | `src/entrypoints/background.ts:7`, `src/background/index.ts:16` | — |
| Start relay chain | `src/background/session-coordinator.ts:156–244` | — |
| Bootstrap hydration | `src/background/hydrate-signed-in.ts:24–44` | — |
| Auth preHandler | `src/http/hooks/auth.hook.ts:63` | — |
| Session Redis cache (warm/cold) | `src/services/auth.service.ts:295–327` | — |
| Subtitle-first start() | `src/content/pipelines/subtitle-first-pipeline.ts:60` | — |
| SUBFIRST_PREBUFFER_COUNT=1 | `src/content/pipelines/subtitle-first-pipeline.ts:46` | — |
| AudioContext create + early resume | `src/content/pipelines/subtitle-first-pipeline.ts:86–98` | — |
| AudioCtx pre-play resume (bounded 400ms) | `src/content/pipelines/subtitle-first-pipeline.ts:268–273` | — |
| B4 caption prefetch (NavigationWatcher) | `src/content/navigation.ts:168–256` | — |
| Caption prefetch cache | `src/platforms/youtube/caption-cache.ts:97–134` | — |
| Caption fetch (intercept path, 1800ms timeout) | `src/platforms/youtube/captions-fetch.ts:55–92` | — |
| renderSubtitleDubStream (SSE client) | `src/lib/echoly-api.ts:128–262` | — |
| Subtitle dub service renderBatch + streamBatch | `src/services/subtitle-dub.service.ts:124–647` | — |
| STT_FIRST_SEGMENT_MS default=1000ms | `core/src/config/env.ts:206` | — |
| STT_SEGMENT_MS default=2500ms | `core/src/config/env.ts:200` | — |
| PCM windowing (#pcmWindows) | `src/providers/translate/audio.pipeline.ts:311–381` | — |
| MiniMax WS warmup (fire-and-forget) | `src/providers/translate/audio.pipeline.ts:119–127` | — |
| Standard-WebRTC build session | `src/content/pipelines/webrtc-pipeline.ts:164–407` | — |
| captureWithRetry | `src/content/capture.ts:66–93` | — |
| waitForFirstDub gate (8s) | `src/lib/dub-playback-sync.ts:114–135`, `src/shared/constants.ts:62` | — |
| handleRtcTranslate server | `src/http/routes/rtc.routes.ts:302–568` | — |
| RtcBridgeService #runMinimaxChain | `src/services/rtc-bridge.service.ts:360–457` | — |
| /prepare pre-warm (standard saves ~50-100ms) | `src/content/pipelines/webrtc-pipeline.ts:134` | — |
| MiniMax TTS provider | `src/providers/translate/tts/minimax.tts.ts` | — |
