# Research Slice 4 — Server-side First-Byte Latency

**Date:** 2026-06-02  
**Scope:** What happens on the server between request arrival and the first audio byte/track reaching the extension, for both tiers. Which steps are serial, which are parallelisable, and where are the biggest delays?

---

## 1. Realtime Tier — `POST /v1/rtc/translate`

### 1.1 Full Step-by-Step Timeline

All file:line references are in `server/src`.

| # | Step | Serial / Parallel | Rough cost | File:line |
|---|------|--------------------|-----------|-----------|
| 1 | **Auth preHandler – token extraction** | Serial | ~0 µs (pure string) | `http/hooks/auth.hook.ts:70` |
| 2 | **Auth – `resolveToken()`: Redis session cache lookup** | Serial | **~0.5–2 ms** (R-auth roundtrip) | `services/auth.service.ts:277` |
| 2b | Auth cache hit → `refreshEntitlement()`: one PG `findById` (tier check) | Serial | **~2–5 ms** (PG query) | `services/auth.service.ts:330` |
| 2c | Auth cache miss (cold/expired) → full PG session JOIN + warm cache | Serial | **~3–8 ms** | `services/auth.service.ts:299` |
| 3 | **Signaling rate-limit** – Redis `incr` + `expire` on R-cache | Serial | ~1 ms | `http/routes/rtc.routes.ts:239` |
| 4 | **`usagePeriodService.resolve()`** – PG `usersRepo.findById` + optional `subscriptionsRepo.findByUserId` (non-free tier) | Serial | **~3–8 ms** | `http/routes/rtc.routes.ts:250`, `core/src/services/usage-period.service.ts:37` |
| 5 | Pipeline/tier validation, language validation | Serial | ~0 µs (pure) | `rtc.routes.ts:245–281` |
| 6 | **SDP validation** (regex) | Serial | ~0 µs | `rtc.routes.ts:307` |
| 7 | **`rtcPeer.answer(offer, {sessionId})`** — mediasoup allocate WebRtcTransport + DirectTransport + browserProducer + inboundConsumer + outboundProducer + browserConsumer | **Serial** | **~5–20 ms** (6 mediasoup IPC calls to C++ worker, each crossing an IPC boundary) | `services/rtc/mediasoup.peer.ts:808–960` |
| 8 | **`meteringService.reserve()`** — Redis `incr` (inflight), `usagePeriod.resolve()` (another PG query!), Redis Lua `reserveQuota` | Serial | **~5–12 ms** (PG + Redis Lua) | `http/routes/rtc.routes.ts:385`, `core/src/services/metering.service.ts:105` |
| 9 | **Reply SDP** to browser — `reply.send(answer.sdp)` | — | ~0 µs (already have the data) | `rtc.routes.ts:429` |
| 10 | **`bridgeService.run()` spawned async (post-reply)** — `gpt.dial("live")`: DNS + TCP + TLS + WS upgrade to `api.openai.com` | Post-reply, concurrent with browser ICE | **~80–200 ms** (cold OpenAI WS dial) | `services/rtc-bridge.service.ts:247` |
| 11 | **`session.waitConnected(10_000)`** — waits for browser DTLS `connected` event | Concurrent with step 10 | **~50–300 ms** (ICE + DTLS round-trip) | `rtc-bridge.service.ts:261` |
| 12 | First inbound RTP from browser decoded; PCM enqueued | After step 11 | ~20 ms/frame | `services/rtc/mediasoup.peer.ts:416` |
| 13 | PCM frames pumped to OpenAI via `relay()` → first `response.audio.delta` arrives | After steps 10+11+12 | **~200–800 ms** (OpenAI model first token, depends on VAD silence) | `providers/translate/live.openai.ts:219` |
| 14 | First PCM audio chunk → `pushOutboundPcm` → encode Opus (off-loop pool) → RTP → browser | After step 13 | ~5–10 ms | `services/rtc/mediasoup.peer.ts:512` |

**Total server-observable latency from request arrival to SDP reply:** steps 1–9 = **~17–55 ms** (dominated by 2–3 serial PG round-trips + mediasoup allocations).

**Total glass-to-glass until first dubbed audio in browser:** steps 1–14 = **~400–1200 ms** from SDP exchange. The browser's ICE/DTLS (step 11) and OpenAI first-turn (step 13) dominate.

### 1.2 Where Step 8 Double-Counts PG

`usagePeriodService.resolve()` is called **twice** on the hot path:
- Once at step 4 (`rtc.routes.ts:250`) to get `resetsAtIso` for error bodies.
- Once inside `metering.reserve()` → `this.period(userId, tier)` at step 8 (`metering.service.ts:122`).

Each call does `usersRepo.findById` + (for paid tiers) `subscriptionsRepo.findByUserId`. That is **2 × 2 PG queries = 4 PG queries** on the critical path for a fresh request.

---

## 2. Standard Tier (WebRTC path) — `POST /v1/rtc/translate?pipeline=standard`

The route is identical through steps 1–9; the differences kick in post-reply in `bridgeService.run()`:

| # | Step | Serial / Parallel | Rough cost | File:line |
|---|------|--------------------|-----------|-----------|
| 10 | **No `gpt.dial()`** — for `backend="minimax-chain"` the bridge skips the OpenAI WS pre-dial entirely | — | 0 | `rtc-bridge.service.ts:241` |
| 11 | `session.waitConnected(10_000)` — ICE + DTLS (same as realtime) | — | ~50–300 ms | `rtc-bridge.service.ts:261` |
| 12 | First inbound PCM arrives; `#runMinimaxChain()` starts | — | ~20 ms | — |
| 13 | **`STT_FIRST_SEGMENT_MS` window accumulates** before Gemini is called | Serial wait | **~500–2000 ms** (waits for firstSegMs of audio) | `providers/translate/audio.pipeline.ts:182`, `#pcmWindows` |
| 14 | **`stt.translateAudio()` (Gemini audio-in)** — one HTTP call, cold | Serial | **~300–800 ms** first token | `providers/translate/audio.pipeline.ts:390` |
| 15 | **MiniMax TTS warmup** (`ttsSession.warmup()`) — WS connection fires concurrently with Gemini window | Concurrent with step 14 | ~100–300 ms | `audio.pipeline.ts:124` |
| 16 | **MiniMax TTS `synthesize()`** — first audio chunk (TTFA ~250 ms per MiniMax docs) | Serial after step 14 | ~250 ms | `providers/translate/tts/minimax.tts.ts:66` |
| 17 | First audio chunk pushed via `pushOutboundPcm` (or `pushOutboundOpus` if Opus native) | — | ~5 ms | `rtc-bridge.service.ts:386–396` |

**Standard TTFA on WebRTC path:** ~800–3000 ms post-ICE (STT window + Gemini + TTS).

---

## 3. Standard Subtitle/TTS Path — `POST /v1/translate/subtitles` and `POST /v1/tts/speech`

### 3.1 `/v1/translate/subtitles` (SubtitleDubService)

Preamble (steps 1–4) is the same as above. Then:

| # | Step | Cost |
|---|------|------|
| 5 | Rate-limit check (Redis) | ~1 ms |
| 6 | Body validation | ~0 µs |
| 7 | `metering.reserve()` — same double-PG issue as RTC | ~5–12 ms |
| 8 | **Translate all lines** — sequential or concurrent depending on `MAX_CONCURRENT_CLAUSES` | **~200–600 ms/batch** |
| 9 | **TTS per line** (MiniMax HTTP, serial per clause) | **~250–500 ms/line** |
| 10 | All chunks collected → single JSON response | — |

No streaming: the response is buffered. All audio arrives at once. Total per-batch: **~500–2000 ms** (latency = longest clause).

### 3.2 `/v1/tts/speech`

Same prelude, then:
- `metering.reserve()` (Redis Lua)
- `MiniMaxTtsProvider.synthesize()` (HTTP SSE, buffered to completion)
- `metering.commit()` (PG transaction)
- Returns complete Buffer

First byte is only sent after **all** audio is buffered. No streaming to client.

### 3.3 `/v1/chat` (ChatService — translate role)

- Non-streaming path: blocks on full LLM response before replying. No audio.
- Streaming path (SSE, `stream:true`, only when `METER_CHAT_COMPLETIONS=false`): first token arrives fast, but this is text/translate only, not audio.

---

## 4. Auth Session Lookup — Cached vs Cold

`AuthService.resolveToken()` at `services/auth.service.ts:277`:

- **Hot path (cache hit):** Redis GET (~0.5–2 ms) + PG `usersRepo.findById` for tier refresh (~2–5 ms). Always two I/O calls even on cache hit.
- **Cold path (no cache):** PG JOIN sessions+users (~3–8 ms) + Redis SET.
- **Sliding expiry bump:** additional Redis NX + PG UPDATE when session nears expiry (debounced).

The tier refresh on every cache hit (`refreshEntitlement`, `auth.service.ts:330`) is an unconditional PG query. For the media hot path this adds 2–5 ms every single request.

---

## 5. Ranked Server-Side Latency Culprits

### Rank 1 — OpenAI WS dial (Realtime, **80–200 ms**, serial with ICE)
**File:** `services/rtc-bridge.service.ts:247` (`warmWs = await gpt.dial("live", ...)`)  
The upstream WS is opened *after* the SDP reply but the key question is whether it completes before the browser's ICE/DTLS does. If ICE finishes first (fast LAN path), the session waits on OpenAI's WS upgrade. The dial is attempted eagerly *in the bridge*, which runs post-reply — but it is still **serial with `waitConnected`** in the bridge's `run()` body: dial starts first, then `waitConnected` is awaited. If ICE is fast (~50 ms on cellular), the 150–200 ms WS dial adds latency. There is no parallelism between the OpenAI WS dial and `waitConnected`.

### Rank 2 — `STT_FIRST_SEGMENT_MS` window wait (Standard, **500–2000 ms**)
**File:** `providers/translate/audio.pipeline.ts:182` (the `#pcmWindows` loop)  
The pipeline accumulates `STT_FIRST_SEGMENT_MS` of PCM before making the first Gemini call. Default value in env unknown but typical values of 1–2 s mean no audio arrives for the full first segment duration. This is the single largest Standard-tier delay.

### Rank 3 — Double `usagePeriodService.resolve()` PG round-trip (**3–8 ms wasted**)
**Files:**
- `http/routes/rtc.routes.ts:250` (first call — for error body `resetsAtIso`)
- `core/src/services/metering.service.ts:122` (second call inside `reserve()`)

Each call executes `usersRepo.findById` + `subscriptionsRepo.findByUserId`. Two PG queries are executed for no reason since the first result is only used for error paths. On success paths the data from step 4 is already available but not threaded down to `reserve()`.

### Rank 4 — `refreshEntitlement()` unconditional PG query on every auth cache hit (**2–5 ms**)
**File:** `services/auth.service.ts:330`  
Called on *every* request even when the tier hasn't changed. Adds one PG round-trip on every authenticated request.

### Rank 5 — mediasoup `answer()` — 6 serial IPC calls to C++ worker (**5–20 ms**)
**File:** `services/rtc/mediasoup.peer.ts:808–960`  
`createWebRtcTransport`, `connect`, `produce` (browserProducer), `createDirectTransport`, `consume` (inboundConsumer), `produce` (outboundProducer), `consume` (browserConsumer) — each is an `await` across the mediasoup IPC boundary. Each call is individually fast (~1–3 ms) but they are chained, adding up to ~8–20 ms total.

### Rank 6 — TTS fully buffered, no streaming to HTTP client (**all paths**)
**Files:** `services/tts.service.ts:113` (collects all chunks before returning), `http/routes/tts.routes.ts:108` (`reply.status(200).type(contentType).send(result.audio)`)  
The `/v1/tts/speech` response waits for all audio to arrive before sending the first byte. The `/v1/translate/subtitles` response is similarly fully buffered. For Standard WebRTC TTS this is invisible (audio goes over RTP not HTTP), but for the subtitle-dub path it means the extension cannot start playing partial audio mid-synthesis.

### Rank 7 — MiniMax TTS lacks keep-alive connection reuse
**File:** `providers/translate/tts/minimax.tts.ts:114`  
Each `synthesize()` call opens a fresh `fetch()` HTTP connection to MiniMax. Node's default `fetch` uses a keep-alive connection pool by default, but the pool benefits only within a process lifetime. Each new clause in `audio.pipeline.ts` calls `synthesize()` which calls `#callT2A` which calls `fetch`. The first clause in a session pays a TCP + TLS handshake penalty (~50–150 ms).

---

## 6. Concrete Optimisation Opportunities

### (a) No contract change — server-internal optimisations

**A1. Thread `usagePeriodBounds` into `metering.reserve()` to eliminate the double PG hit.**  
`rtc.routes.ts:385` calls `meteringService.reserve({...})` but `reserve()` calls `this.period(userId, tier)` internally (`metering.service.ts:122`). Add an optional `periodBounds` parameter to `reserve()` (or a new `reserveWithBounds()` overload) so the route can pass the already-resolved bounds. This removes one `usersRepo.findById` + `subscriptionsRepo.findByUserId` pair from the hot path. Same fix applies to `chat.service.ts` and `tts.service.ts`.  
**Savings:** ~3–8 ms per request.

**A2. Cache the tier-refresh result in the session cache with a short TTL (e.g. 30 s).**  
`refreshEntitlement()` currently does an unconditional PG query on every cache hit. Add a `tier_refreshed_at` field to the `SessionCache` entry and skip the refresh if the last check is < 30 s old. The 30 s staleness is acceptable (billing webhooks use a separate invalidation path).  
**Savings:** ~2–5 ms per request, ~90% of requests.  
**File:** `services/auth.service.ts:330`.

**A3. Reduce `STT_FIRST_SEGMENT_MS`.**  
The first dubbed audio cannot arrive until at least `STT_FIRST_SEGMENT_MS` of audio is captured. Lowering this from ~2000 ms to ~800–1000 ms cuts the Standard TTFA by ~1 s at the cost of shorter context for Gemini (may reduce translation quality slightly). This is a single env-var change.  
**File:** `providers/translate/audio.pipeline.ts:104` (`const firstSegMs = this.#env.STT_FIRST_SEGMENT_MS`).

**A4. Parallelize OpenAI WS dial and `waitConnected`.**  
Currently in `rtc-bridge.service.ts:run()`:
```ts
warmWs = await gpt.dial(...)  // step A: OpenAI WS
const connected = await session.waitConnected(10_000)  // step B: ICE
```
These can run in parallel: start both simultaneously and await both with `Promise.all`. The OpenAI WS and browser ICE/DTLS are fully independent. This hides the ~80–200 ms WS dial behind ICE when ICE is slow (cellular), and eliminates it when ICE is fast.  
**File:** `services/rtc-bridge.service.ts:240–270`.  
**Savings:** up to ~150 ms on fast networks.

**A5. Reduce mediasoup `answer()` IPC call count.**  
The 7 sequential `await` calls in `MediasoupRtcPeer.answer()` cannot all be parallelised (some depend on prior results), but `createDirectTransport()` (step 4) can start immediately after `recvTransport.connect()` (step 2) since it does not depend on `browserProducer`. Currently it waits until `produce()` is called first (`mediasoup.peer.ts:866`).  
**File:** `services/rtc/mediasoup.peer.ts:828–960`.  
**Savings:** ~1–3 ms.

**A6. Stream TTS audio from `/v1/tts/speech` instead of buffering.**  
`tts.service.ts:113` collects all `chunks` before returning. Change to stream the response via SSE or `Transfer-Encoding: chunked` as audio arrives. This requires holding the metering commit until the stream ends but would reduce TTFA from ~250 ms (full MiniMax TTFA) to ~20–50 ms (first SSE frame).  
**File:** `services/tts.service.ts:113` and `http/routes/tts.routes.ts:108`.

**A7. MiniMax TTS session warmup firing in the critical path.**  
`audio.pipeline.ts:124` fires `ttsSession.warmup()` as a fire-and-forget but does NOT await it. The first clause's `synthesize()` call will block on the WS connection if warmup has not completed. Ensure warmup is awaited (or the first synthesize handles reconnect gracefully) so the warm connection is actually ready by clause time.

### (b) Needs extension coordination — new endpoints / protocol changes

**B1. Pre-warm endpoint: `POST /v1/rtc/prepare`**  
A lightweight endpoint that the extension calls on hover/intent (before Start is pressed). It would:
1. Auth + tier check (same as translate)
2. Pre-allocate a mediasoup WebRtcTransport (partial answer without SDP — or with a dummy offer)
3. Pre-dial the OpenAI WS and keep it alive for up to 30 s

When the user then presses Start, `POST /v1/rtc/translate` reuses the pre-warmed transport + WS socket. The extension sends a `session_id` from the prepare response to the translate request to claim the slot.

**Cross-slice concern:** Requires a new `RtcPeer.prepare()` / `claim()` API and a corresponding pre-warm pool with TTL cleanup. The extension must send the `session_id` back. Pre-warmed but unclaimed slots need a GC path (30 s TTL, release mediasoup resources). The metering reserve must NOT happen at prepare time — only at translate time when the user actually starts.

**B2. `session_bootstrap` prefetch — extension calls `/v1/session/bootstrap` on extension load**  
`session-bootstrap.routes.ts` already exists. The extension should call this on load to warm the session cache (auth + tier resolution), so by the time the user presses Start the session is cached in Redis. Currently the extension may not call this.  
**Savings:** eliminates the cold-auth PG JOIN on first request.

**B3. Reduce ICE candidate count in SDP answer.**  
`buildSdpAnswer()` (`mediasoup.peer.ts:1234`) emits ALL ICE candidates (both UDP and TCP). For users on a direct network, a single UDP candidate is enough. Filtering to the highest-priority candidate or pruning TCP-only candidates reduces SDP parse time in the browser and speeds up ICE connectivity checks.  
**File:** `services/rtc/mediasoup.peer.ts:1271` (the `for (const c of candidates)` loop).

**B4. Extension: send `durationHintSec` for better reserve estimation.**  
`rtc.routes.ts:302` reads `query.durationHintSec`. If the extension sends this for known-duration content (YouTube VOD), the clip reserve is right-sized, avoiding over-reservation that triggers a release→re-reserve cycle.

**B5. Streaming TTS response for subtitle-dub path.**  
`/v1/translate/subtitles` returns the full batch before the extension can play the first line. Changing the response to SSE (one `line` event per synthesised subtitle) would let the extension start the first dub line ~250 ms after the request arrives, with subsequent lines arriving in pipelined order. Requires extension changes to consume an SSE stream instead of JSON.

---

## 7. Cross-Slice Concerns / Flags for Other Wave Agents

- **Metering reserve double-PG hit** is a load concern as well as a latency concern. Under concurrency (N users pressing Start simultaneously), this doubles the PG SELECT load. Fix A1 benefits both latency and throughput.
- **`STT_FIRST_SEGMENT_MS` tuning** (fix A3) interacts with translation quality. The audio agent should validate translation accuracy at lower values before committing to a config change.
- **Pre-warm endpoint (B1)** creates zombie mediasoup transports if the user never presses Start. GC logic needed. This is a non-trivial addition — allocate carefully (each WebRtcTransport holds a UDP port pair).
- **Auth tier-cache staleness (A2)** means a tier downgrade (cancellation webhook) may be served stale for up to 30 s. This is acceptable given the existing webhook invalidation path, but the billing agent should be aware.
- **OpenAI WS pre-dial (A4)** keeps an upstream WS open during ICE negotiation. If ICE fails, this connection must be closed cleanly — `warmWs?.close()` at `rtc-bridge.service.ts:265` already handles this.

---

## 8. Summary Table — Serial Steps Before First Audio Byte (Realtime)

```
[0 ms]   Request arrives
[+2 ms]  Auth: Redis session cache GET
[+5 ms]  Auth: PG refreshEntitlement findById
[+7 ms]  Rate-limit: Redis INCR
[+13ms]  usagePeriodService.resolve: PG findById + subscriptions (FIRST call)
[+15ms]  SDP validation (regex, ~0)
[+28ms]  rtcPeer.answer(): 6 mediasoup IPC calls
[+38ms]  metering.reserve(): Redis INCR (inflight) + PG (SECOND usagePeriod call) + Redis Lua
[+38ms]  SDP answer sent to browser ← HTTP response returns
         ↓↓↓ (all below is post-reply, runs concurrently with browser ICE) ↓↓↓
[+88ms]  gpt.dial() + waitConnected() started concurrently... but actually SERIAL in bridge
[+238ms] OpenAI WS ready (best case 150 ms dial)
[+288ms] ICE + DTLS connected (best case 50 ms on fast network)
         (if ICE finishes BEFORE OpenAI WS, you wait for OpenAI WS)
[+300ms] First inbound PCM frames arrive
[+700ms] First response.audio.delta from OpenAI (~400 ms model latency)
[+710ms] First Opus RTP packet sent to browser
```

**Total to first audio:** ~700 ms best case (fast network, warm cache); **1200–2000 ms** realistic (cold cache, cellular ICE, model variability).
