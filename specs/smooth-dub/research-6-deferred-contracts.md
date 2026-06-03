# Research 6 — Deferred Latency Contracts (D, E, F)

**Status:** READ-ONLY research artefact — contracts proposed, no code written.  
**Date:** 2026-06-02  
**Author:** Contract-design research agent (smooth-dub wave)

---

## Overview

Three latency optimisations have been approved. This document provides precise
contracts — exact JSON shapes, affected file:line references, metering-safety
rules, back-compat guarantees, and extension-side wiring.

The two hard invariants these contracts must never violate:

> **Server-authoritative cost**: cost is ALWAYS recomputed server-side from
> provider-observed usage; a client can never set or lower its own bill.  
> **Exact-once billing**: every chargeable event is keyed by a `requestId`
> (standard) or `rt_${sessionId}` (realtime) and protected by Redis
> `SET NX` + PG `ON CONFLICT DO NOTHING`.

---

## Contract D — Pre-warm endpoint `POST /v1/rtc/prepare`

### Goal

Extension calls this on user INTENT (hover/focus of Start button) to
pre-allocate a mediasoup transport and pre-dial the OpenAI Realtime WS.
The subsequent hot `POST /v1/rtc/translate` reuses the warm transport+WS,
skipping the O(200–500 ms) dial latency from its critical path.

### Current hot path (verified in code)

`rtc.routes.ts:handleRtcTranslate` (line 223) does sequentially:

1. Auth + rate-limit check
2. `usagePeriodService.resolve()` (PG query — line 250)
3. `resolveRtcPipeline()` (pure, no I/O)
4. SDP validation (pure — line 307)
5. `rtcPeer.answer(offer, { sessionId })` — allocates mediasoup WebRtcTransport
   (line 348)
6. `metering.reserve(...)` (Redis Lua — lines 385–402)
7. Reply SDP + spawn `bridgeService.run(session, plan)` (line 445)

Inside `bridgeService.run()` → `BridgeRun.run()` (rtc-bridge.service.ts:240):
- line 247: `gpt.dial("live", targetLanguage)` — OpenAI WS handshake (the
  expensive bit: TLS + HTTP upgrade, ~200–400 ms cold)
- line 261: `session.waitConnected(10_000)` — waits for DTLS connected event

Contract D pre-moves steps 5 + the `gpt.dial()` out of the translate path and
into a prepare step.

### Metering-safety rule (CRITICAL)

**`/v1/rtc/prepare` MUST NOT call `metering.reserve()`.** Reserve stays
exclusively in `handleRtcTranslate` (rtc.routes.ts, around lines 385–402).
A prepare is a transport allocation, not a billable event. The user may hover
and never start — charging a reserve at hover would be fraudulent.

This is the single most important invariant of this contract.

### D.1 — New endpoint: `POST /v1/rtc/prepare`

**File to add:** `server/src/http/routes/rtc.routes.ts` — new
`fastify.post("/v1/rtc/prepare", ...)` block, registered inside
`registerRtcRoutes`.

**Request (JSON body):**

```jsonc
{
  // Which backend to pre-dial. Only "realtime" (gpt-single-hop) benefits from
  // WS pre-dial; "standard" (minimax-chain) can still use prepare for transport
  // pre-allocation but the WS savings are smaller. Both are valid.
  "pipeline": "realtime",           // "realtime" | "standard"
  "target_language": "vi",          // same targetLanguage the translate call will use
  // Optional — used to decide gpt.dial() language mode. If absent, the server
  // uses the user's preferred_language then falls back to "vi".
  "source_language": "en"           // optional
}
```

**Response (200 OK, JSON):**

```jsonc
{
  "prepare_id": "pr_01JXQ3AB5CDEFGHIJKLMN",   // ULID, signed like rtc session id
  "ttl_sec": 30,                                // how long the slot stays alive
  "pipeline": "realtime"                        // echoes resolved pipeline
}
```

**Error responses** (same envelope as translate):
- `401` — not authed
- `429` — rate limited (shares the existing `rtc` rate-limit bucket)
- `422` — `realtime_language_unsupported` (same check as translate line 289)
- `503` — mediasoup at capacity (no transport available)

### D.2 — Warm-slot registry (where it lives)

The warm slot is held **in the existing `RtcPeer` / mediasoup layer**. No new
Redis key is required; the transport is an in-process mediasoup object.

A new in-memory `Map<prepareId, WarmSlot>` lives inside `MediasoupRtcPeer`
(server/src/services/rtc/mediasoup.peer.ts).

```typescript
interface WarmSlot {
  prepareId: string;       // "pr_<ulid>"
  userId: string;          // owner — must match translate caller
  pipeline: string;        // "realtime" | "standard"
  targetLanguage: string;
  // The pre-allocated session (transport+bridge objects already wired but
  // NOT yet bridged to a provider — bridge.run() has NOT been called).
  session: MediasoupRtcSession;
  // For "realtime" pipeline only: the pre-dialed OpenAI WS connection.
  // null for "standard" pipeline (MiniMax chain has no eager dial).
  warmWs: WsLike | null;
  expiresAt: number;       // Date.now() + TTL_MS (default 30 000)
  gcTimer: ReturnType<typeof setTimeout>;
}
```

**GC mechanism:**
- Each slot has a `setTimeout(30_000)` that calls `slot.session.close("prepare_expired")` then removes the entry from the map.
- On server shutdown / `drain()`, every warm slot is closed.
- On `answer()` (translate reuses slot), the GC timer is cancelled first.

**Anti-abuse cap:**
- Maximum 2 warm slots per user at a time (env: `RTC_PREPARE_MAX_PER_USER`,
  default 2). If a third prepare arrives, the oldest slot for that user is
  expired immediately and replaced.
- The global `this._sessions.size >= this._maxStreams` check already counts warm
  sessions (because they hold a real WebRtcTransport slot); no separate counter
  is needed.

**New key in `keys.ts`:** none needed (in-memory only — no authoritative
state is at risk; warm slots are purely infrastructure pre-work that will be
GC'd if unused).

### D.3 — How `translate` accepts an optional `prepare_id`

Add `prepareId?: string` to `RtcTranslateQuery` (rtc.routes.ts line 68):

```typescript
interface RtcTranslateQuery {
  pipeline?: string;
  targetLanguage?: string;
  sourceLanguage?: string;
  voice?: string;
  durationHintSec?: string;
  requestId?: string;
  sessionId?: string;
  prepareId?: string;   // ← NEW: optional signed prepare id
}
```

In `handleRtcTranslate` (rtc.routes.ts line 223), before step 5
(`rtcPeer.answer()`), add:

```typescript
// D — optional pre-warm reuse
const prepareId = query.prepareId?.trim() || undefined;
let warmSlot: WarmSlot | null = null;
if (prepareId) {
  warmSlot = rtcPeer.claimWarmSlot(prepareId, user.id);
  // claimWarmSlot returns null if: slot not found, expired, or userId mismatch.
  // In all null cases, fall through to normal rtcPeer.answer() below.
}
```

Then replace the existing `rtcPeer.answer(offer, { sessionId })` call (lines
347–352) with:

```typescript
let answer: RtcAnswer;
let session: RtcSession;
if (warmSlot) {
  // Reuse pre-allocated transport. The offer SDP still needs to be applied
  // so DTLS + ICE negotiate correctly. We add an rtcPeer.answerWarm() method
  // that takes an existing session + offer and completes the SDP exchange
  // without creating a new transport.
  try {
    const result = await rtcPeer.answerWarm(warmSlot.session, offer, { sessionId: sessionIdForPeer });
    answer = result.answer;
    session = result.session;
  } catch {
    warmSlot = null; // fall through: warm slot was stale, proceed normally
    // (normal answer() path below)
  }
}
if (!warmSlot) {
  try {
    const result = await rtcPeer.answer(offer, { sessionId: sessionIdForPeer });
    answer = result.answer;
    session = result.session;
  } catch {
    return reply.status(502).send(errorBody("rtc_negotiate_failed", "WebRTC negotiation failed."));
  }
}
```

**Important:** metering.reserve() at lines 385–402 is NOT moved. It runs
identically regardless of whether a warm slot was used.

In `bridgeService.run()` / `BridgeRun.run()` (rtc-bridge.service.ts line 240),
add an optional `warmWs` parameter to `RtcBridgePlan`:

```typescript
export interface RtcBridgePlan {
  // ... existing fields ...
  warmWs?: WsLike | null;   // ← NEW: pre-dialed OpenAI WS from the prepare slot
}
```

In `BridgeRun.run()` (line 244), change:

```typescript
// Before: always dials fresh
warmWs = await gpt.dial("live", this.plan.targetLanguage);

// After: reuse pre-warmed WS if supplied
warmWs = this.plan.warmWs ?? await gpt.dial("live", this.plan.targetLanguage);
```

The existing lazy-dial fallback on dial failure (lines 248–252) is preserved —
if the warm WS is stale (OpenAI closed it), `relay()` retries lazily.

### D.4 — Back-compat guarantee

`translate` without a `prepareId` continues to work UNCHANGED. The
`prepareId` field is optional; if absent, `claimWarmSlot()` returns null and
the existing translate path executes in full.

Existing tests that call translate without prepare continue to pass.

### D.5 — New `RtcPeer` port additions

Two new methods on the `RtcPeer` interface
(server/src/services/rtc/peer.port.ts):

```typescript
interface RtcPeer {
  // ... existing methods ...

  /**
   * Pre-allocate a transport + (for realtime) pre-dial the provider WS.
   * Returns a prepare_id that translate can claim within TTL_MS.
   * Does NOT reserve quota.
   */
  prepare(opts: {
    userId: string;
    pipeline: string;
    targetLanguage: string;
  }): Promise<{ prepareId: string; ttlSec: number }>;

  /**
   * Claim a warm slot by prepare_id + userId. Returns the slot if valid and
   * unclaimed, null otherwise (expired / wrong user / not found).
   * Cancels the GC timer. Slot is removed from the registry.
   */
  claimWarmSlot(prepareId: string, userId: string): WarmSlot | null;

  /**
   * Complete the SDP exchange on an already-allocated warm session.
   * The transport + Opus pool slot are already created; this method
   * applies the DTLS+ICE from the SDP offer and returns the answer SDP.
   * Follows the same contract as answer() for the SDP step.
   */
  answerWarm(
    session: RtcSession,
    offer: string,
    opts: { sessionId?: string },
  ): Promise<{ answer: RtcAnswer; session: RtcSession }>;
}
```

Both `MockRtcPeer` (mock.peer.ts) needs stub implementations. The mock can
return a synthetic prepare_id immediately and claim it trivially.

### D.6 — Auth + rate limit for prepare

```
POST /v1/rtc/prepare
preHandler: requireAuth           // mandatory — same as translate
```

Rate limit: prepare uses the same `rtc` rate-limit bucket (keys.rateLimit("rtc",
userId, window)) that translate uses. No separate bucket. The combined
per-user budget is `env.RTC_SIGNALING_RATE_MAX` (default 30 per 60s).

### D.7 — Extension-side wiring

**Where to call prepare:**

`extension/src/content/pipelines/webrtc-pipeline.ts:buildSession()` (around
line 117). The prepare call happens _before_ `pc.createOffer()` — at the
point the user clicks Start or the hover event fires.

For hover-based pre-warm, a `prepareIntent()` method can be added to
`WebRtcPipeline` and called from the popup's mouseenter/focus handler
(extension/src/popup/index.ts or the controller). It should be
fire-and-forget with a caught error:

```typescript
async prepareIntent(opts: { apiBearer: string; pipeline: string; targetLanguage: string }): Promise<string | null> {
  try {
    const res = await fetch(`${sm.apiBase}/rtc/prepare`, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + opts.apiBearer,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        pipeline: opts.pipeline,
        target_language: opts.targetLanguage,
      }),
    });
    if (!res.ok) return null;
    const json = await res.json() as { prepare_id?: string };
    return json.prepare_id ?? null;
  } catch {
    return null;
  }
}
```

The `prepare_id` is stored in a short-lived variable (not in session state —
it is pre-session). When `buildSession()` runs, if a prepare_id is available
and not yet expired, it is appended to the query string:

```typescript
const qs = new URLSearchParams({ targetLanguage: lang, pipeline: opts.pipeline });
if (prepareId) qs.set("prepareId", prepareId);
// ... rest of existing qs population ...
```

**Graceful fallback:** if prepare failed (null) or the translate server
returns a 4xx for the prepareId (stale), the extension simply retries without
it. No user-visible degradation.

**No change to heartbeat, end, or media-pause routes.** They operate on the
session that was returned by translate, not the prepare slot.

---

## Contract E — SSE streaming for subtitle-dub (`/v1/translate/subtitles/stream`)

### Goal

Extension starts playing line 1 within ~250 ms instead of waiting for the
entire batch (translate + TTS for all N lines before first byte).

### Current buffered path (verified in code)

`subtitle-dub.service.ts:renderBatch()` (line 124):

1. Reserve chat leg (line 165)
2. `provider.chatObject<{lines: string[]}>()` — translates ALL N lines (line 185)
3. Reserve TTS leg (line 215)
4. `#synthesizeAll()` — runs TTS for ALL N lines in parallel (up to
   `MAX_TTS_PARALLEL=5`) (line 232)
5. Commit both legs (lines 255–304)
6. Return full `{ lines, modelChain, ... }` to the route handler
7. Route sends the full JSON (subtitle-dub.routes.ts line 151)

The extension awaits the full response in
`echoly-api.ts:renderSubtitleDubBatch()` (line 44), then decodes all
AudioBuffers in `subtitle-first-pipeline.ts:#renderBatch()` (lines 491–496).

### E.1 — New streaming route (content-negotiated)

Add a parallel route `/v1/translate/subtitles/stream` (separate URL, NOT a
content-negotiate override of the existing one). The buffered route at
`/v1/translate/subtitles` remains UNTOUCHED and continues to work.

**Rationale for separate URL:** content-negotiating on Accept header is fragile
in MV3 content scripts where fetch headers have limited control. A distinct URL
is cleaner, back-compat is trivially guaranteed, and the buffered route can be
deprecated later with a redirect.

**File to add route in:**
`server/src/http/routes/subtitle-dub.routes.ts` — new `fastify.post` block
inside `registerSubtitleDubRoutes`.

**Request:** Identical JSON body to the existing `/v1/translate/subtitles`
(same validation, same fields). No request-schema change.

### E.2 — SSE event format

The response is `Content-Type: text/event-stream` with chunked transfer.

Each translated-and-synthesised line emits ONE SSE event:

```
event: line
data: {"index":0,"text":"Xin chào thế giới","audio_b64":"<base64 MP3>","cue_start_ms":0,"cue_end_ms":4200}

event: line
data: {"index":1,"text":"Đây là dòng thứ hai","audio_b64":"<base64 MP3>","cue_start_ms":4200,"cue_end_ms":8100}

event: done
data: {"model_chain":["google:gemini-3-flash","minimax-tts"],"total_lines":5,"billed_lines":5}
```

**Field definitions:**

| Field | Type | Meaning |
|---|---|---|
| `index` | number | 0-based line index; lines are emitted IN ORDER |
| `text` | string | Translated text (server-produced) |
| `audio_b64` | string | Base64-encoded MP3; empty string if TTS failed for this line |
| `cue_start_ms` | number | Cue start in ms (from `cueDurationsMs` hint, cumulative) |
| `cue_end_ms` | number | Cue end in ms (cumulative) |

**Terminal events:**

```
event: done
data: {"model_chain":["..."],"total_lines":N,"billed_lines":M}

event: error
data: {"code":"quota_exhausted","message":"Monthly quota exhausted.","status":402}
```

The `error` event carries the same envelope codes as the JSON error body
(AppError.code, AppError.status). After `error`, the stream closes.

The `done` event is emitted only after ALL lines have been emitted and billing
committed. Clients SHOULD wait for `done` before marking the session complete,
but MAY begin playback immediately on the first `line` event.

### E.3 — Metering for the streaming route

The streaming route uses the SAME metering logic as the buffered route
(identical `renderBatch` inside `SubtitleDubService`), but called per
pipeline stage rather than at the end:

```
Option A (recommended for exact-once safety):
  translate ALL lines → commit chat leg → stream TTS per line → commit TTS leg
  at end-of-stream. Lines stream as TTS completes per-line.
```

**Why not per-line commit:** per-line TTS commits would need per-line
`requestId` keys (avoiding exact-once collisions), and the commit at `done`
ensures the chat leg and TTS leg are both committed atomically (2-leg atomicity
invariant in subtitle-dub.service.ts line 248).

**Exact billing rule for aborted streams:**

If the client closes the connection (AbortController) mid-stream after K lines
have been delivered but TTS has run for M ≥ K lines (M ≤ N):

- TTS is already running in parallel (up to `MAX_TTS_PARALLEL` ahead); the
  server cannot un-run TTS calls already in-flight.
- The server detects close via the `req.raw.on("close")` / `reply.raw.on("close")` Fastify event.
- **On stream abort:** commit the TTS leg for `M` (however many lines were
  synthesised, not just K delivered). The chat leg is committed regardless
  (full translation already completed before TTS begins).
- This is billing-safe: the user is billed for server-rendered work, not for
  streamed delivery. A mid-stream abort does not grant free translations.

**Metering flag:** the streaming route does NOT change `METER_CHAT_COMPLETIONS`.
While that flag is false, chat is unmetered; TTS is still metered on
translated char count (same as buffered route).

### E.4 — Server-side streaming implementation sketch

Inside `SubtitleDubService`, add a new method `streamBatch()` that:

1. Reserves chat leg (identical to `renderBatch` step 1).
2. Calls the translate provider once for all N lines (`chatObject`). Lines
   arrive all at once from Gemini (not per-line streaming from the LLM — Gemini
   structured output is not token-streamed). Chat commit happens immediately
   after translate completes.
3. Reserves TTS leg on total translated chars.
4. Runs TTS per-line **strictly in order** (not `MAX_TTS_PARALLEL` parallel)
   to preserve SSE line ordering without buffering. This trades some server
   throughput for correct ordering — acceptable because the client-side gain
   is the first-line latency, not all-N throughput.
5. Each TTS completion emits a `line` SSE event immediately (no buffer).
6. After all N lines, commits the TTS leg and emits `done`.

**Fastify SSE pattern:**

```typescript
fastify.post("/v1/translate/subtitles/stream", { preHandler: [requireAuth, idempotencyHook] },
  async (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    const sendEvent = (event: string, data: unknown): void => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    // ... streaming logic calling subtitleDubService.streamBatch() ...
  }
);
```

Note: Fastify's `reply.send()` must NOT be called when writing directly to
`reply.raw`. The route handler returns `reply` after setting up raw streaming.

### E.5 — Extension-side streaming consumer

**Problem:** `EventSource` does not support POST. The extension must use
`fetch()` with `ReadableStream` reading.

**MV3 content-script streaming note:** Chromium's `fetch()` in content scripts
supports `ReadableStream` bodies since Chrome 109 (extension targets
`minimum_chrome_version: 116` per `manifest.json`). Streaming works.

**New helper in `extension/src/lib/echoly-api.ts`:**

```typescript
export async function* renderSubtitleDubStream(opts: {
  apiBase: string;
  bearer: string;
  sentences: CaptionSentence[];
  targetLanguage: string;
  voiceId: string;
  cueDurationsMs?: number[];
  priorLines?: string[];
  sessionId?: string;
  siteHost?: string;
  videoTitle?: string;
  signal?: AbortSignal;
}): AsyncGenerator<SubtitleDubBatchLine & { index: number }> {
  const res = await fetch(`${opts.apiBase}/translate/subtitles/stream`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.bearer}`,
      "Content-Type": "application/json",
      // ... same headers as renderSubtitleDubBatch ...
    },
    body: JSON.stringify({ /* same body */ }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    const parsed = await parseServerError(res);
    throw Object.assign(new Error(parsed.user), parsed);
  }
  // Parse SSE over ReadableStream
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          const data = JSON.parse(line.slice(5).trim());
          if (currentEvent === "error") {
            throw Object.assign(new Error(data.message), { code: data.code });
          }
          if (currentEvent === "line") {
            const audioMp3 = decodeBase64ToArrayBuffer(data.audio_b64 ?? "");
            yield { index: data.index, text: data.text, audioMp3 };
          }
          // "done" event: just stop iterating (reader.read() will return done)
          currentEvent = "";
        } else if (line === "") {
          currentEvent = "";
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
```

**Change in `subtitle-first-pipeline.ts:#renderBatch()`** (line 453):

Replace the single `await renderSubtitleDubBatch(...)` call + for-loop decode
with a `for await` over `renderSubtitleDubStream(...)`:

```typescript
for await (const item of renderSubtitleDubStream({ ... })) {
  if (sm.session !== s || s.stopFlag) return;
  const idx = i + item.index;
  s.translations[idx] = item.text;
  if (item.audioMp3.byteLength > 0 && s.audioCtx) {
    try {
      s.sentences[idx]!._buffer = await s.audioCtx.decodeAudioData(item.audioMp3.slice(0));
    } catch { /* ignore */ }
  }
  // First line is now decoded and available ~250ms into the request —
  // the playback tick can start playing immediately.
}
```

**AbortController cancellation:** the existing `s.abortController.signal` is
passed as `signal` to `renderSubtitleDubStream`. When Stop is pressed,
`fetch()` is aborted via the signal. The `ReadableStream` reader throws
`AbortError`; the `for await` exits. Server detects close and commits what
was already synthesised (see E.3).

**Back-compat:** `renderSubtitleDubBatch` is left in `echoly-api.ts` untouched.
If the streaming route is unavailable (e.g. older server), the pipeline can
fall back to the buffered route. A feature-flag or version header can govern
which is used until streaming is confirmed stable.

---

## Contract F — `STT_FIRST_SEGMENT_MS` tuning

### Current state (verified in code)

**File:** `core/src/config/env.ts:206`

```typescript
STT_FIRST_SEGMENT_MS: num(1000),
```

**Comment at that line:**
> Raised from 500→1000 ms: a 500 ms window at 24 kHz is often too few words
> for Gemini to produce a useful clause split, so the first clause is held
> until CLAUSE_MAX_MS (2 s) fires anyway — net TTFA is worse, not better.
> 1000 ms gives the speech model ~2–4 words to work with and dramatically
> improves first-clause quality.

**Usage in audio.pipeline.ts:105:**

```typescript
const firstSegMs = this.#env.STT_FIRST_SEGMENT_MS;
// passed to #pcmWindows() as the first window size
```

`#pcmWindows()` accumulates PCM bytes until `alignedFirst` bytes are available,
then yields the first window for Gemini audio-in translate. A shorter window
→ Gemini sees the first translation sooner → lower TTFA for the realtime
Standard pipeline.

### Trade-off

| `STT_FIRST_SEGMENT_MS` | First window duration | Gemini context | TTFA |
|---|---|---|---|
| 500 ms | 24 kHz × 500ms × 2B = 24 KB PCM | Too few words — clause often held by `CLAUSE_MAX_MS` (2 s), negating the saving | Higher (paradoxically) |
| 750 ms | 36 KB PCM | ~2–3 words — borderline. May still trigger `CLAUSE_MAX_MS` holdback | Moderate |
| 1000 ms (current) | 48 KB PCM | ~3–4 words — Gemini generally produces a usable clause | ~1.7 s p50 |
| 1250 ms | 60 KB PCM | More context but ~250 ms slower first window | Higher |

The non-obvious risk in lowering below 750 ms: Gemini receives so little
audio it cannot split on a clause boundary, so `ClauseSplitter` buffers the
partial and the `CLAUSE_MAX_MS` (2 000 ms) timer fires instead — the TTS
start is deferred to `CLAUSE_MAX_MS` after the window start, which can be
LATER than the 1000 ms window finish.

### Recommendation

**Ship a tunable env default of 750 ms as the target**, with documentation
noting it requires the §13 live smoke test to verify.

Specifically: **do not change the hardcoded default in `core/src/config/env.ts`
at this time.** Instead, set `STT_FIRST_SEGMENT_MS=750` in the production
`.env` / infra config once the §13 smoke test (live Gemini key + real audio)
confirms that Gemini produces a valid clause on a 750 ms window for the target
language pair (typically EN→VI). The test must measure:

1. p50 TTFA at 750 ms vs 1000 ms across ≥ 20 utterances.
2. Clause-split quality: % of first windows where `CLAUSE_MAX_MS` fires (bad)
   vs where a clause boundary is detected naturally (good).
3. Translation accuracy on the first clause (no context clipping).

If the smoke test shows `CLAUSE_MAX_MS` fires > 40% of the time at 750 ms,
revert to 875 ms and re-test.

### Env variable name and wiring

- **Env name:** `STT_FIRST_SEGMENT_MS` (already exists — no new name needed)
- **Schema location:** `core/src/config/env.ts:206`
- **Pipeline consumer:** `server/src/providers/translate/audio.pipeline.ts:105`
- **No code change required for the env plumbing** — it is already wired end-to-end.

### What to ship without live keys

Add a comment in the `.env.example` for `server/`:

```ini
# First STT window duration for Standard realtime pipeline (ms).
# Lower = faster first translation but Gemini needs enough audio for a clause.
# 750ms is the tuning target; verify with live §13 smoke tests before deploying.
# Default: 1000
# STT_FIRST_SEGMENT_MS=750
```

The line is commented out so the safe default (1000) remains active until
explicitly verified. This is not a hardcoded change — it is a documented
tunable.

---

## Metering-Safety Cross-Check

| Contract | Reserves quota? | Commits quota? | Exact-once key? | Risk flag |
|---|---|---|---|---|
| D — `/v1/rtc/prepare` | **NO** (CRITICAL invariant) | No | N/A | None — pure infra allocation |
| D — `/v1/rtc/translate` with `prepareId` | YES (unchanged from current, same lines 385–402) | YES (unchanged) | `rt_${sessionId}` (unchanged) | None |
| E — `/v1/translate/subtitles/stream` | YES (reserve before translate + TTS) | YES (commit at end-of-stream) | `req.requestId` / `${req.requestId}:tts` | Mid-stream abort: bill for M synthesised lines, not K delivered — see E.3 |
| F — `STT_FIRST_SEGMENT_MS` tuning | N/A (env knob, not a billing change) | N/A | N/A | None — metering basis unchanged |

**No contract here breaks the server-authoritative-cost invariant.** Cost is
always recomputed from server-observed provider usage (translated char count,
TTS chars, observed cmin) — never from a client-supplied value.

---

## Files Modified per Contract

### Contract D

| File | Change |
|---|---|
| `server/src/http/routes/rtc.routes.ts` | Add `POST /v1/rtc/prepare` handler; add `prepareId?` to `RtcTranslateQuery`; add warm-slot claim logic before `rtcPeer.answer()` |
| `server/src/services/rtc/peer.port.ts` | Add `prepare()`, `claimWarmSlot()`, `answerWarm()` to `RtcPeer` interface |
| `server/src/services/rtc/mediasoup.peer.ts` | Implement `prepare()`, `claimWarmSlot()`, `answerWarm()` in `MediasoupRtcPeer`; add `_warmSlots: Map<string, WarmSlot>` |
| `server/src/services/rtc/mock.peer.ts` | Stub implementations of the three new methods |
| `server/src/services/rtc-bridge.service.ts` | Add `warmWs?` to `RtcBridgePlan`; use it in `BridgeRun.run()` before dialing |
| `core/src/config/env.ts` | Add `RTC_PREPARE_MAX_PER_USER: num(2)` and `RTC_PREPARE_TTL_SEC: num(30)` |
| `extension/src/content/pipelines/webrtc-pipeline.ts` | Add `prepareIntent()` method; thread `prepareId` into `buildSession()` query string |

### Contract E

| File | Change |
|---|---|
| `server/src/http/routes/subtitle-dub.routes.ts` | Add `POST /v1/translate/subtitles/stream` SSE route |
| `server/src/services/subtitle-dub.service.ts` | Add `streamBatch()` method (ordered per-line TTS + SSE write callback) |
| `extension/src/lib/echoly-api.ts` | Add `renderSubtitleDubStream()` async generator |
| `extension/src/content/pipelines/subtitle-first-pipeline.ts` | Change `#renderBatch()` to use `for await` over the streaming API |

### Contract F

| File | Change |
|---|---|
| `server/.env.example` | Document `STT_FIRST_SEGMENT_MS=750` as commented-out tuning target |
| No code changes | The env plumbing is already complete |

---

## Open Questions for Human Review

1. **Contract D — `answerWarm()`** requires changes inside `MediasoupRtcPeer.answer()`
   to factor out the SDP→transport wiring step. This is a moderately invasive
   change to the most complex file in the codebase. Confirm scope is acceptable
   before building.

2. **Contract D — prepare for standard pipeline:** MiniMax chain has no eager
   WS dial (it opens per-segment). Pre-warming a transport slot for standard is
   still useful (saves ~50–100 ms for transport creation) but the benefit is
   smaller. Confirm whether prepare should be restricted to `pipeline=realtime`
   only to reduce implementation scope.

3. **Contract E — ordered TTS (no parallel) for streaming:** Serialising TTS
   per line ensures in-order SSE delivery but reduces server throughput compared
   to the buffered `MAX_TTS_PARALLEL=5` approach. For a batch of 5–8 lines this
   adds ~200–400 ms total time but saves ~250 ms on line 1. Confirm the
   latency-vs-throughput tradeoff is acceptable.

4. **Contract E — SSE in Fastify:** Fastify's `reply.raw.write()` approach
   bypasses Fastify's serialisation and error-handling middleware. Confirm
   this is acceptable, or use a `fastify-sse-v2` plugin if the team prefers
   a plugin-based approach.

5. **Contract F — smoke test gate:** The recommended 750 ms target is untested
   against live Gemini keys. This document explicitly defers the final value
   to the §13 smoke test. Confirm this deferral policy is understood before
   building.
