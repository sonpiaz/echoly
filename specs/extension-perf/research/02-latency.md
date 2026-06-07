# Research 02 — Latency Budget & Instrumentation Inventory

**Agent:** Research-02 (read-only, latency slice)
**Date:** 2026-06-07
**Scope:** Extension-side latency budget for both tiers + all existing instrumentation.
**Sources:** specs/smooth-dub/ (research-1..4, firstconnect-VERDICT, SOLUTION), live source files.

---

## 1. Shared Pre-Pipeline Path (both tiers, steps 1–9)

| Step | Stage | Files | Estimated cost | Serial? |
|---|---|---|---|---|
| 1 | User clicks Start in popup | `src/popup/index.ts` | ~0 ms | — |
| 2 | `onToggle()` → `chrome.runtime.sendMessage({type:"START"})` | `src/popup/index.ts:741` | **200–1500 ms** SW cold; 2–5 ms warm | SERIAL |
| 3 | Background router → `session.start(settings)` | `src/background/router.ts:165` | ~0 ms | — |
| 4 | `persistSettings` (chrome.storage.local write) | `src/background/session-coordinator.ts:161` | 5–20 ms | SERIAL |
| 5 | `resolveApiMode()` — user session check | `src/lib/api-mode.ts:33` | 5–15 ms warm; 100–500 ms cold network | SERIAL |
| 6 | `sessionTabForStart()` — 2× chrome.tabs.query | `src/background/session-coordinator.ts:114` | ~4–20 ms | SERIAL |
| 7 | `ensureContentScript()` — PING or inject | `src/background/session-coordinator.ts:132` | 1–5 ms (warm); 100–300 ms (inject) | SERIAL |
| 8 | `connecting=true` broadcast to popup | `src/background/session-coordinator.ts:193` | ~0 ms | — |
| 9 | `relayToContent(…CONTENT_START…)` | `src/background/session-coordinator.ts:219` | 1–5 ms | SERIAL |

**Shared-path total (warm SW, warm content script): ~200–550 ms.**
**Shared-path total (cold SW): +200–1500 ms.**

---

## 2. Standard Subtitle-First Pipeline — Stage-by-Stage Budget

YouTube VOD path (most common). After step 9.

| Step | Stage | File | Cost (best/typical/worst) | Dominant? |
|---|---|---|---|---|
| 10 | Overlay DOM build | `overlay/overlay.ts:572` | <10 ms | No |
| 11 | video.pause() (frozen video starts here) | `subtitle-first-pipeline.ts:141` | sync | — |
| 12 | Caption fetch: B4 prefetch cache hit | `caption-cache.ts` / `navigation.ts` | 0–15 ms (hit) | No |
| 12b | Caption fetch: intercept cache poll | `captions-fetch.ts:122` | 15–1800 ms (no cache) | YES |
| 12c | Caption fetch: timedtext fallback | `captions-fetch.ts:144` | +200–800 ms | YES |
| 13 | `regroupToSentences()` | `caption-utils.ts` | <5 ms | No |
| 14 | **`#renderBatch()`** — `POST /v1/translate/subtitles` (Gemini + MiniMax TTS, 1 line with SUBFIRST_PREBUFFER_COUNT=1) | `echoly-api.ts:47`, `subtitle-first-pipeline.ts:251` | **800–2500 ms** | **DOMINANT** |
| 15 | `audioCtx.decodeAudioData()` | `subtitle-first-pipeline.ts:494` | 5–30 ms | No |
| 16 | video.play() + `#playbackTick()` fires | `subtitle-first-pipeline.ts:307` | sync | — |
| — | First dubbed audio output | — | — | TTFA endpoint |

**Standard subtitle-first TTFA (from click):**
- Best case (caption cache hit, fast server): ~1200–2000 ms
- Typical (caption fetch 300 ms + server 1500 ms): ~2500–3500 ms
- Worst case (caption timeout + server slow): ~5–8 s

**Key number from specs:** "8s gate vs 24.7s ttfa" referenced in memory notes is the NO-CC fallback (DUB_TTFA_GATE_MS, now lowered to 8000 ms; old value 14000 ms). The headline subtitle-first TTFA is 2–5 s.

**UI feedback timeline:**
- Step 11: video freezes (user sees frozen screen)
- Step 12: overlay shows "Loading captions"
- Step 13: overlay shows "Translating N lines"
- Step 14: 800–2500 ms dead silence — nothing changes visually
- Step 16: video plays + dubbed audio begins

---

## 3. Realtime WebRTC Pipeline — Stage-by-Stage Budget

After step 9.

| Step | Stage | File | Cost | Serial? |
|---|---|---|---|---|
| 10 | `captureWithRetry(video, 9000)` | `capture.ts:66` | 0–300 ms (playing); up to 9 s (paused) | SERIAL |
| 11 | `new RTCPeerConnection() + addTrack + createDataChannel + AudioContext` | `webrtc-pipeline.ts:176` | 1–5 ms | SERIAL |
| 12 | `pc.createOffer()` | `webrtc-pipeline.ts:295` | 5–20 ms | SERIAL |
| 13 | **`POST /v1/rtc/translate?pipeline=realtime` with SDP offer** | `webrtc-pipeline.ts:321` | **200–600 ms** server-side (mediasoup alloc + SDP) | **SERIAL** |
| 14 | `pc.setRemoteDescription()` + ICE gather | `webrtc-pipeline.ts:347` | ICE overlaps with step 15 | — |
| 15 | `waitForPCConnected(pc, 3000)` | `capture.ts:97` | **200–800 ms** (ICE + DTLS) | **SERIAL** |
| 16 | `alignRealtimeVodBeforePlay()` — event-driven track-ready wait | `standard-vod-start.ts:25` | 0–1000 ms ceiling (ceiling reduced from 2000→1000 ms) | SERIAL |
| 17 | video.play() (video unfreezes) | `content/index.ts:491` | async | — |
| 18 | OpenAI first audio delta → `track.unmute` → Web Audio graph connected | `webrtc-pipeline.ts:257` | **200–800 ms** (OpenAI model latency) | Post-ICE |
| — | First dubbed audio | — | — | TTFA endpoint |

**Realtime TTFA (from click, VOD):**
- Best case (warm SW, fast network): ~700–1000 ms
- Typical: ~1200–2000 ms
- Worst case (cold SW, cellular ICE, slow OpenAI): ~2500–3500 ms

**Realtime TTFA (from click, Live stream):**
- No video.pause/play gate (step 11 skipped for live)
- Best: ~600–800 ms; Typical: ~900–1500 ms

**Glass-to-glass latency (realtime, steady-state):** The pipeline is voice-to-voice; the server's `rtc-bridge.service.ts` docs note ~400–1200 ms from SDP exchange to first audio, dominated by ICE/DTLS + OpenAI first-turn.

---

## 4. Standard WebRTC Fallback (no captions)

When `fetchCaptions()` returns empty, falls back to `startWebRtcStandard()`:
- Full caption fetch timeout (up to ~2 s) already paid
- Full Realtime WebRTC flow + `waitForFirstDub(DUB_TTFA_GATE_MS=8000)` gate
- Total: **3–12 s** (was up to 20 s with old 14 s gate)

---

## 5. Concrete Latency Numbers Found in Code/Specs

| Constant / Comment | Value | File |
|---|---|---|
| `DUB_TTFA_GATE_MS` | 8000 ms (absolute TTFA cap, Standard WebRTC) | `constants.ts:62` |
| `DUB_STANDARD_RELEASE_FLOOR_MS` | 1500 ms (early release floor) | `constants.ts:67` |
| `DUB_LIVE_TTFA_CEILING_MS` | 30,000 ms (no-CC live fallback ceiling) | `constants.ts:71` |
| `REALTIME_VOD_PLAY_ALIGN_MS` | 80 ms (floor for alignRealtimeVodBeforePlay) | `constants.ts:77` |
| `alignRealtimeVodBeforePlay` ceiling | 1000 ms (reduced from 2000 ms in wave/smooth-dub) | `standard-vod-start.ts:33` |
| `SUBFIRST_PREBUFFER_COUNT` | 1 (reduced from 3 in wave/smooth-dub) | `subtitle-first-pipeline.ts:47` |
| `SUBFIRST_BUFFER_WAIT_MAX_MS` | 8000 ms (micro-pause max wait) | `subtitle-first-pipeline.ts:56` |
| `STT_FIRST_SEGMENT_MS` (server) | 1000 ms default (raised from 500 ms) | `server/core/src/config/env.ts:206` (comment) |
| `MEDIA_GATE_TIMEOUT_MS` | 1500 ms (media-gate POST soft timeout) | `constants.ts:75` |
| Standard tier secondary copy | "~5s" | `constants.ts:93` |
| Realtime tier secondary copy | "<1s" | `constants.ts:97` |
| SW cold start | "200–1 500 ms" | comment in `popup/index.ts:70` |
| MiniMax TTS TTFA | ~250 ms (per server research doc) | `specs/smooth-dub/research-4-server-latency.md:59` |
| OpenAI first audio delta | 200–800 ms | `specs/smooth-dub/research-4-server-latency.md:31` |
| Server SDP round-trip | ~17–55 ms server-internal | `specs/smooth-dub/research-4-server-latency.md:33` |
| "8s gate vs 24.7s ttfa" | 8000 ms gate; 24.7 s was the ad-wait → no-CC fallback total | memory / specs/ad-gate-and-nocc-fallback/ |

---

## 6. Already-Shipped Optimizations (do NOT re-propose)

The following were designed/built in prior waves:

| Optimization | Target latency | Status | Files |
|---|---|---|---|
| **`SUBFIRST_PREBUFFER_COUNT` 3→1** | Startup freeze (Standard SF) | **SHIPPED** in wave/smooth-dub | `subtitle-first-pipeline.ts:47` |
| **`DUB_TTFA_GATE_MS` 14000→8000 ms** | Standard WebRTC cap | **SHIPPED** in wave/smooth-dub | `constants.ts:62` |
| **`DUB_STANDARD_RELEASE_FLOOR_MS=1500`** | Early video release (Standard WebRTC) | **SHIPPED** in wave/smooth-dub | `constants.ts:67` |
| **`alignRealtimeVodBeforePlay` ceiling 2000→1000 ms** | Realtime VOD post-ICE delay | **SHIPPED** in wave/smooth-dub (but `Math.max(alignMs,1000)` still holds the ceiling) | `standard-vod-start.ts:33` |
| **Event-driven `alignRealtimeVodBeforePlay`** (replaces fixed sleep) | Realtime VOD post-ICE | **SHIPPED** in wave/smooth-dub | `standard-vod-start.ts:36–86` |
| **Optimistic popup render from `chrome.storage.local`** | SW cold-start UX (B3) | **SHIPPED** in wave/smooth-dub | `popup/index.ts:1200–1213` |
| **Caption prefetch on navigation (B4)** | Standard SF caption fetch on Start | **SHIPPED** in wave/smooth-dub | `content/navigation.ts:#startPrefetch` |
| **`prepareIntent` on hover/focus + popup-open** | Realtime SDP pre-warm (D) | **SHIPPED** in wave/smooth-dub | `popup/index.ts:1221`, `webrtc-pipeline.ts:135` |
| **SSE streaming subtitle-dub `renderSubtitleDubStream()`** | Standard SF first-line TTFA | **SHIPPED** in wave/smooth-dub | `lib/echoly-api.ts:131`, `subtitle-first-pipeline.ts` uses `renderSubtitleDubStream` |
| **`snapPlaybackStart()` sets `stopped=false` (A1)** | Resume drift corrector | **SHIPPED** in wave/smooth-dub | `lib/dub-playback-sync.ts:137–151` |
| **`buffering` OverlayState** | Loading UX | **SHIPPED** in wave/smooth-dub | `shared/ports.ts` (inferred from SOLUTION) |
| **SW keepalive PING every 20 s** | SW cold-start | Status: **DESIGNED** (P2 in firstconnect-VERDICT), code presence NOT confirmed from source — VERIFY |

**Note on SW keepalive:** `firstconnect-VERDICT.md` recommends it as P2 and gives the implementation (~2 lines in content script), but the grep for `SW_PING` in `content/index.ts` and `router.ts` returned empty. This may be PENDING — the feature-wave wave/smooth-dub may not have included it. A future agent must verify whether P2 is actually committed.

---

## 7. Existing Instrumentation / Telemetry — Full Inventory

### 7A. What EXISTS (measurable hooks)

| Hook | What it measures | Location | Limitations |
|---|---|---|---|
| **`_bufferWaitStartedAt = performance.now()`** | Duration of micro-pause buffer wait in subtitle-first pipeline | `subtitle-first-pipeline.ts:775`, checked at `:842` | Internal only — used for SUBFIRST_BUFFER_WAIT_MAX_MS enforcement; not logged or exposed |
| **`[data-ec-latency]` overlay element** + `DubSyncReadout` | Steady-state A/V lag (video ahead of dub, seconds, EMA) | `overlay/template.ts:90`, `overlay/overlay.ts:1040–1071`, `lib/dub-playback-sync.ts:15–27` | Only shows STEADY-STATE lag; Standard WebRTC only; nothing for startup TTFA; not emitted to server |
| **`DubSyncReadout.lagSec`** | EMA of `video.currentTime - (expected video position given dub progress)` | `lib/dub-playback-sync.ts:63` | 500 ms poll interval; masked by the lag target (DUB_SYNC_TARGET_LAG_SEC=5 s); not startup metric |
| **`x-echoly-request-id` header** | Correlation ID per subtitle-dub batch request (`sf_dub_<uuid>`) | `lib/echoly-api.ts:10,52` | Server-side only; extension does NOT timestamp the fetch start or parse a timing response header |
| **`x-echoly-session-id` header** | Session grouping in server usage_events | `lib/echoly-api.ts:11` | Server-side accounting; not latency |
| **Playwright `waitForDubAudioProgress()`** | Binary check: `audio.currentTime > 0.05` | `e2e/helpers/voice-pipeline.ts:7` | YES/NO proof of audio playing; not a timestamp |
| **Playwright `waitForRtcTranslateOffer()`** | Detects SDP response (HTTP level) | `e2e/helpers/voice-pipeline.ts:68` | Marks SDP round-trip but does NOT measure audio start time |
| **`Date.now() - startedAt` in popup elapsed timer** | Session wall-clock elapsed since Start confirmed running | `popup/index.ts:436` | Counts from `sessionStartedAt` (set after first audio), NOT from click — so it does not capture TTFA |
| **`captureWithRetry` loop** | Implicit timing via `while (Date.now() - start < timeoutMs)` | `capture.ts:82` | Not logged; pure control-flow |
| **`waitForFirstDub` polling** | Polls `dub.currentTime > 0.04` every 80 ms | `dub-playback-sync.ts:114` | TTFA gate, not a measurement; no timestamp emitted |

### 7B. What is MISSING (gaps)

The codebase has **zero end-to-end TTFA measurement** — no wall-clock timestamp is recorded at click time (`onToggle()`), no timestamp at first audio playback, and no difference is computed between the two. Specifically:

1. **No click timestamp.** `onToggle()` in `popup/index.ts` does not record `Date.now()` or `performance.now()` at the moment Start is clicked.
2. **No first-audio timestamp.** The `track.unmute` handler (`webrtc-pipeline.ts:257`) and `AudioBufferSourceNode.start()` (`subtitle-first-pipeline.ts`) do not emit any timing event.
3. **No TTFA log.** Neither the extension nor the server logs TTFA. No structured log line exists.
4. **E2E tests measure presence, not timing.** `waitForDubAudioProgress()` asserts `audio.currentTime > 0.05` but does NOT record when the audio started relative to when Start was clicked. There is no `page.evaluate(() => window.__echolyStartClickTime)` pattern.
5. **No `performance.mark` / `performance.measure`.** No use of the Web Performance API in the latency-critical path.
6. **The lag display (`[data-ec-latency]`) is steady-state A/V sync only** — it does not capture startup TTFA and only activates after the first dub anchor is established (≥50 ms of dub progress).
7. **Server response has no timing headers.** The `/v1/rtc/translate` response and `/v1/translate/subtitles` response do not return an `X-Server-Duration` or equivalent. The Fastify request logger has timing but it is not surfaced to the extension.

---

## 8. Test Surface for Performance

| Test | What it tests | Timing data? |
|---|---|---|
| `e2e/voice-only.spec.ts` | Full Standard + Realtime start on YouTube (real browser) | NO — asserts overlay text, no TTFA |
| `e2e/product-e2e.spec.ts` | Full pipeline smoke (Free/Pro/Max) | NO — asserts audio plays, no TTFA |
| `e2e/youtube-voice-chunked.spec.ts` | Standard WebRTC `rtc/translate` | NO — asserts `res.ok()` and dub audio |
| `test/lib/dub-playback-sync.test.ts` | Unit: drift corrector tick, stop/snap/start | NO timing perf |
| `test/lib/standard-vod-start.test.ts` | Unit: `alignRealtimeVodBeforePlay` event-driven | YES: tests "resolves on event not timer" (AC4) — but as logic, not wall-clock |
| `test/content/pipelines/subtitle-first-stream-render.test.ts` | Stream render ordering (AC10/AC12) | NO timing |
| No latency/benchmark test exists anywhere | — | — |

**Verdict:** There are no timing/latency vitest or Playwright tests. Tests validate CORRECTNESS of the pipeline state machine, not performance.

---

## 9. TTFA Measurability Assessment

**Can the codebase currently MEASURE TTFA end-to-end?**

**NO.** The answer is unambiguous:

- No clock is started at click time.
- No clock is stopped at first audio.
- The only quasi-temporal hook is `waitForFirstDub()` which is a gate (success/fail), not a measurement.
- The E2E tests observe *that* audio plays but cannot tell *how long it took*.
- The overlay lag display measures steady-state A/V drift, not startup TTFA.

**What is needed to make TTFA measurable:**

1. **Extension:** Record `window.__echolyClickTs = Date.now()` in `onToggle()` at the moment Start is clicked.
2. **Extension (Realtime):** In `track.unmute` handler (`webrtc-pipeline.ts:257`), compute `Date.now() - window.__echolyClickTs` and emit via `console.info("[echoly][perf] realtime_ttfa_ms:", delta)` or via a structured background message.
3. **Extension (Standard SF):** In `#playCue()` first invocation (`subtitle-first-pipeline.ts`), same pattern.
4. **E2E test:** Add `page.evaluate()` calls before `clickPopupStart` to inject the timestamp hook, and after `waitForDubAudioProgress()` to read it — producing a real TTFA measurement per test run.
5. **Server (optional):** Return `X-Server-Duration-Ms` on `/v1/rtc/translate` and `/v1/translate/subtitles` responses so the extension can decompose server vs. client latency.

---

## 10. Cross-Slice Flags

- **SW keepalive PING (P2 from firstconnect-VERDICT):** May be PENDING — source grep found no `SW_PING` in content/index.ts or router.ts. A perf-wave agent editing content/index.ts should check and implement if absent.
- **`alignRealtimeVodBeforePlay` ceiling still 1000 ms:** The SOLUTION proposed removing `Math.max(alignMs, 1000)` entirely, but the current code (`standard-vod-start.ts:33`) still has `const ceiling = Math.max(alignMs, 1000)`. The `REALTIME_VOD_PLAY_ALIGN_MS=80` parameter is still ignored for worst-case. This is a known remaining fix.
- **SSE streaming (`renderSubtitleDubStream`):** Implemented in `lib/echoly-api.ts`, consumed by `subtitle-first-pipeline.ts`. Whether the server `/v1/translate/subtitles/stream` route is live is a server-slice question — if not deployed, the client falls back to buffered path at 404.
- **Server-side latency culprits** (double usagePeriodService PG hit, unconditional tier refresh PG, serialized OpenAI dial + ICE) are documented in `specs/smooth-dub/research-4-server-latency.md` — these are server-slice concerns, not extension-slice.

---

## Summary Table

| Tier | TTFA best | TTFA typical | TTFA worst | Dominant blocker | Measurable? |
|---|---|---|---|---|---|
| Standard subtitle-first | ~1200 ms | ~2500–3500 ms | ~5–8 s | Server translate+TTS (1 line, ~800–2500 ms) | NO |
| Realtime WebRTC (VOD) | ~700 ms | ~1200–2000 ms | ~2500–3500 ms | ICE+DTLS + OpenAI first audio delta | NO |
| Realtime WebRTC (Live) | ~600 ms | ~900–1500 ms | ~2000 ms | ICE+DTLS + OpenAI TTFA | NO |
| Standard WebRTC (no CC) | ~3 s | ~5–8 s | ~12 s | STT window + Gemini + TTS + 8 s gate | NO |
