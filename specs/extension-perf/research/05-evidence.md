# 05 — Evidence & Measurement Methodology

**Research agent:** read-only. Slice: prove-or-disprove framework for extension optimisations.  
**Date:** 2026-06-07  
**Mandate:** Define what to measure, how to instrument THIS codebase, how to run a fair A/B, and the numeric bar an optimisation must clear to count as real. Be skeptical throughout.

---

## 1. Metrics That Matter for This Product

### 1.1 Metric Definitions

| ID | Metric | Precise definition | Where it lives |
|----|--------|--------------------|---------------|
| **TTFA** | Time-to-first-audio | `t(user clicks Start in popup) → t(first dubbed audio sample is output by the speaker)`. Both timestamps must be captured in the same JS clock domain. | Content script clock; correlate across BG via request-id. |
| **MTE** (mouth-to-ear) | Mouth-to-ear (glass-to-glass) latency | `t(source speaker produces syllable) → t(dubbed equivalent syllable exits speaker)`. Realtime tier only. Not easily measurable in a purely software test. | Requires external audio capture or loopback comparison. |
| **SDP-RTT** | SDP negotiation round-trip | `t(fetch /v1/rtc/translate starts) → t(SDP answer received)`. Pure network measurement. | Content script: `performance.now()` around `fetch()`. |
| **ICE-TTX** | ICE time-to-connected | `t(setRemoteDescription done) → t(iceConnectionState==="connected")`. | Content script: existing `waitForPCConnected()` already has this boundary. |
| **TTFD** | Time-to-first-dub (Standard subtitle-first) | `t(first `renderSubtitleDubBatch` / `renderSubtitleDubStream` fetch starts) → t(first AudioBufferSourceNode.start())`. | Content script. |
| **BG-RTT** | Background cold-start overhead | `t(chrome.runtime.sendMessage START sent) → t(CONTENT_START arrives at content)`. | Both sides must mark. |
| **Caption-RTT** | Caption acquisition time | `t(fetchCaptions starts) → t(caption array returned)`. Standard subtitle-first only. | Content script `subtitle-first-pipeline.ts`. |
| **Batch-RTT** | Server translate+TTS batch latency | `t(fetch /v1/translate/subtitles starts) → t(response body fully received)`. | Content script `echoly-api.ts`. |

### 1.2 p50 / p95 — NOT Mean

All reported values MUST be p50 and p95 over N runs. Mean hides bimodal distributions (warm-vs-cold). Standard deviation alone is not enough — tail latency (p95) governs the experience because users notice the worst case.

### 1.3 What "Cold" vs "Warm" Means Here

- **Cold BG**: service worker was terminated. Steps 1–9 of the startup path (see `research-1-startup-latency.md`) include a ~1–2 s SW wake-up penalty. This IS measurable.
- **Warm BG**: SW answered the last message <30 s ago, session cookie cached in memory.
- **Cold server**: Redis session cache miss → full PG session JOIN. Adds ~3–8 ms per server research slice.
- **Cold provider**: first Realtime session after provider WebSocket connection is closed. OpenAI WS dial adds ~80–200 ms (post-reply, but serial with ICE per research slice 4).

All benchmarks MUST report warm-BG numbers separately from cold-BG numbers. Cold-BG is a confound, not a variable to optimise in an architecture A/B.

---

## 2. How to Instrument THIS Codebase

### 2.1 The Minimal Instrumentation Set (4 marks required)

These four marks can be added in ~2 hours, produce a credible before/after, and do not change control flow. All use `performance.now()` (sub-millisecond resolution, monotonic, same origin for content script).

#### Mark A — `M_START_CLICK` (Popup → BG boundary)

**File:** `src/popup/index.ts`, just before `chrome.runtime.sendMessage({type:"START",...})`

```typescript
// PERF MARK — remove before shipping
const _M_START_CLICK = performance.now();
console.log("[echoly-perf] M_START_CLICK", _M_START_CLICK.toFixed(1));
```

#### Mark B — `M_CONTENT_START_RECEIVED` (BG → Content boundary)

**File:** `src/content/index.ts`, at the top of the `CONTENT_START` message handler (where `startSession` is called)

```typescript
// PERF MARK
console.log("[echoly-perf] M_CONTENT_START_RECEIVED", performance.now().toFixed(1));
```

Note: this mark is in the content script's JS clock, which is the same origin as all subsequent marks. `M_START_CLICK` is in the popup's clock (different context). To bridge them, the popup can embed `Date.now()` (wall-clock) in the START message; the content script then correlates via wall-clock delta. The BG relay latency is: `(Date.now() at content receipt) - (Date.now() in popup message)`.

#### Mark C — `M_SDP_FETCH_START` / `M_SDP_FETCH_END` (SDP negotiation RTT)

**File:** `src/content/pipelines/webrtc-pipeline.ts`, lines ~379 / ~403, wrapping the `fetch(/v1/rtc/translate)` call:

```typescript
const _M_SDP_FETCH_START = performance.now();
const sdpResp = await fetch(`${sm.apiBase}/rtc/translate?${qs}`, {...});
const _M_SDP_FETCH_END = performance.now();
console.log("[echoly-perf] SDP-RTT", (_M_SDP_FETCH_END - _M_SDP_FETCH_START).toFixed(1), "ms");
```

Also log the `x-echoly-session-id` header so runs can be matched to server logs.

#### Mark D — `M_FIRST_AUDIO` (First dubbed audio)

**Realtime path:** in `webrtc-pipeline.ts`, inside the `track.unmute` handler, after Web Audio graph is connected:

```typescript
console.log("[echoly-perf] M_FIRST_AUDIO_REALTIME", performance.now().toFixed(1));
```

**Standard subtitle-first path:** in `subtitle-first-pipeline.ts`, just before `AudioBufferSourceNode.start()` is called for the first cue (the `#playbackTick` path):

```typescript
console.log("[echoly-perf] M_FIRST_AUDIO_STANDARD", performance.now().toFixed(1));
```

**Standard WebRTC path (no-CC fallback):** inside `startWebRtcSession()` in `content/index.ts`, at the `dubStarted = true` branch of the live-fallback polling loop.

#### Derived TTFA

```
TTFA (content-clock) = M_FIRST_AUDIO - M_CONTENT_START_RECEIVED
```

This is the measurable TTFA. It excludes the popup→BG→content relay (BG-RTT), which must be added if you want the full user-perceived TTFA from click.

### 2.2 Using `x-echoly-request-id` for Server Correlation

The header `x-echoly-request-id` is already sent on all fetch calls in `echoly-api.ts` (lines 12, 50, 152). For WebRTC SDP calls, add it to `sdpHeaders` in `webrtc-pipeline.ts:370`. The server can then emit per-request timing logs keyed by this ID. Server-side marks (auth lookup, mediasoup answer, reserve) are already candidates per research slice 4.

The correlation is: client logs `[echo-perf] SDP-RTT 312ms request-id=sf_dub_s_xxxx`, server logs `[rtc] answer latency 28ms request-id=sf_dub_s_xxxx`. The gap (312 - 28 = 284 ms) is network RTT + client-side overhead.

### 2.3 Instrumentation NOT Needed for a Credible A/B

- Hardware perf counters, browser DevTools trace, or MediaStream timing are NOT required. The four console marks above are sufficient for a before/after on TTFA.
- Do NOT add marks inside the 250ms poll loops — the resolution is already limited by the interval. Mark the boundaries (start-of-fetch, first-audio-node-start).
- Do NOT add marks to the heartbeat or media-pause/resume calls — these are post-startup and do not affect TTFA.

---

## 3. A/B Benchmark Design

### 3.1 What "Architecture A vs B" Means Here

Per the topology research (slice 01), the current architecture is:
- **Architecture A (current):** RTCPeerConnection created in content script; all fetches from content script; no offscreen document; no direct-to-provider path.
- **Architecture B (any proposed alternative):** e.g. offscreen-document peer, pre-warm pool, parallelised ICE+WS dial (server side), reduced STT_FIRST_SEGMENT_MS.

Note: for server-side changes (A1–A7 in slice 04), the extension code does not change; TTFA is the dependent variable measured in the browser.

### 3.2 Benchmark Protocol

**Setup:**
1. Use the same physical machine, same browser profile, same network (wired Ethernet or a throttled `tc netem` emulation fixed for the run).
2. Use the same YouTube video and seek to the same timestamp before each run (eliminates caption variance). A short known-good video with dense captions is ideal.
3. Warm the browser profile: open the extension tab once, wait 60 s, then start the benchmark.
4. Use a logged-in session with credits available (eliminate auth-cold effects from the data path).

**Cold-BG runs:** Kill the SW between runs by navigating to `chrome://serviceworker-internals/` and clicking "Stop" (or use the DevTools Application panel). Record these separately; do not mix with warm-BG runs.

**Run count:** Minimum **N=30 runs per variant per condition** (warm-BG/cold-BG × pipeline × A/B). 30 is the minimum for CLT to apply to p50; p95 needs more (use N=50 if feasible). Discard the first 3 runs as warm-up.

**Randomisation:** Alternate A and B runs (ABABAB…) rather than running all-A then all-B. This controls for within-session provider variance (OpenAI load drifting over time).

**Data collection:** Capture from the Chrome DevTools console via `copy(JSON.stringify([...performance.getEntriesByType("mark")]))` or by redirecting console output to a file. A small harness script using `puppeteer` or `playwright-chromium` (with `--load-extension`) can automate clicking Start and parsing `[echoly-perf]` lines from `page.on("console", ...)`.

**Network jitter control:** Run `ping api.echolyhq.com -c 60` before each 30-run block. Discard any block where RTT jitter (p95 - p50) exceeds 30 ms. This gates out outlier network conditions.

**Provider variance isolation:** For server-side A/B tests (e.g. parallelising OpenAI WS + ICE), use the server's own request-scoped timing logs (keyed by request-id) to extract the `server-observable latency` separately. This lets you see whether the server change actually moved the server-side number, independently of client-side noise.

**Confounders to control explicitly:**

| Confounder | Control method |
|-----------|----------------|
| YouTube ad-gate | Use a YouTube Premium account or skip ads manually before timing starts (never measure through an ad, per ad-watcher research) |
| Caption cache hit/miss | Pre-load the page and wait for `echoly:yt-capture` event before starting the benchmark run; confirm cache is hot |
| SW cold start | Separate warm vs cold runs; never mix |
| Provider load variability | Alternate A/B runs; use wall-clock time-of-day control (run at consistent off-peak hour) |
| Network RTT baseline | Measure ping and discard high-jitter blocks |
| AudioContext suspend/resume | Run each benchmark in a fresh tab (AudioContext starts fresh) |

### 3.3 Statistical Analysis

Report:
- p50 (median) and p95 for each variant (A and B), each condition.
- 95% confidence interval on the median using bootstrap resampling (resample with replacement N=10,000 times).
- Effect size: absolute delta in ms (p50_B - p50_A) and relative (%) change.
- Non-overlapping CIs are required for a claimed win.
- A Wilcoxon rank-sum test is appropriate (TTFA distributions are non-normal and right-skewed).

---

## 4. Acceptance Threshold

### 4.1 Human Perception Baselines (sourced)

The following are the anchors for what "detectable" means to a user:

- **AV sync tolerance (lip-sync):** ITU-R BT.1359 defines detectability thresholds at +45 ms (audio leads video) and **-125 ms (audio lags video)**. The -125 ms figure is the oft-cited "125 ms tolerance." ([Wikipedia: Audio-to-video synchronization](https://en.wikipedia.org/wiki/Audio-to-video_synchronization); [avlatency.com](https://avlatency.com/recommendations/acceptable-audio-latency-lip-sync-error/))
- **Perceptible lip-sync difference:** Research shows 20–40 ms AV desync is perceptible to sensitive viewers in close-up content. For dubbing (where the dubbed voice is a different speaker and there is inherent lag), the tolerance is much wider — users accept natural dubbing lag as a genre convention.
- **Conversational latency acceptability:** Below 300 ms p50 TTFA is acceptable for voice AI; below 200 ms is excellent; above 400 ms starts feeling non-conversational. ([Gradium TTS benchmark 2026](https://gradium.ai/content/tts-latency-benchmark-2026))
- **Echoly's current TTFA (from research slice 1):** Standard subtitle-first ~2–5 s; Realtime ~800 ms–3.5 s. These are far above the "conversational" threshold — the product is in a regime where seconds of TTFA improvement are clearly user-perceptible.

### 4.2 Numeric Acceptance Bar

An architectural or code change counts as a **proven optimisation** only if ALL of the following hold:

**Tier A — TTFA reduction (primary bar):**
> p50 TTFA (warm-BG) for variant B is **≥ 200 ms lower** than variant A, with non-overlapping 95% bootstrap confidence intervals, across N ≥ 30 alternated runs on the same video/network/provider.

200 ms is chosen because:
1. It is the minimum perceptible "feels faster" threshold for startup latency in interactive applications (well above measurement noise).
2. It is well above the expected provider-side noise floor (see §5 below).
3. 200 ms represents a ~5–10% improvement on the Standard subtitle-first path (~2–5 s) — a meaningful fraction — and ~10–25% on the best-case Realtime path (~800 ms). Sub-200 ms changes in a 2–5 s TTFA are not user-perceptible.

**Tier B — p95 non-regression (secondary bar):**
> p95 TTFA for variant B must be **no worse than p95 A + 100 ms** (p95 must not regress). A change that improves p50 but widens the tail is rejected.

**Tier C — Server-internal optimisations:**
> For changes that only move server-side latency (e.g. eliminating the double PG round-trip, parallelising OpenAI WS + ICE), accept a **server-observable** timing improvement of ≥ 20 ms (p50), confirmed in server logs, plus a **client-observed TTFA improvement of ≥ 100 ms** (p50, N ≥ 30). The 100 ms bar (not 200 ms) is acceptable here because server changes are isolated from provider noise.

**NOT accepted:**
- Mean-only improvements (must show p50 and p95).
- Improvements visible only in single-run anecdotes.
- Improvements < 200 ms on client-measured TTFA that may be within provider variance (see §5).
- Changes that improve one tier while silently degrading another (both tiers must pass Tier B).

---

## 5. Reality Check — The Noise Floor Problem

This is the most important section. **Read before claiming any win.**

### 5.1 Provider Variance Dwarfs Client-Side Micro-Optimisations

From the existing server latency research (slice 04):
- OpenAI Realtime first `response.audio.delta`: **200–800 ms** (depending on VAD silence + model load). This is a **600 ms variance range**.
- Gemini audio-in STT (Standard WebRTC path): **300–800 ms**. **500 ms variance**.
- MiniMax TTS TTFA: **~250 ms** per MiniMax's stated spec, but in practice variable under load.
- The `STT_FIRST_SEGMENT_MS` window wait alone: **500–2000 ms**.
- Total Standard TTFA: **~2–5 s** from click; total Realtime: **~800 ms–3.5 s** from click.

From external benchmarks (2026): even top-tier TTS providers show P25-P95 spreads of **16–100+ ms** for TTS alone; LLM first-token latency can swing by **hundreds of ms** between requests on the same provider across different days.

**Consequence:** On the Realtime path, the provider-side variance alone (600 ms range on OpenAI model latency) is **3× larger than the entire client-side startup path** (approx. 200 ms from content-start to SDP-sent on a warm path). Any client-side change that saves 50–100 ms is **below the noise floor** of a realistic test unless you have N ≥ 100 runs or can isolate provider latency from the measurement.

### 5.2 What IS Detectable Above the Noise Floor

| Change type | Claimed saving | Detectable? | Reason |
|------------|---------------|-------------|--------|
| Eliminate gratuitous `REALTIME_VOD_PLAY_ALIGN_MS=80ms` sleep | 80 ms | **No** — below noise floor on Realtime (600 ms provider variance). | Would need N > 200 to see. |
| Parallel OpenAI WS dial + ICE (server A4) | Up to 150 ms | **Marginal** — within provider variance, but server-observable isolation can confirm it. | Use server logs, not just client TTFA. |
| Reduce `STT_FIRST_SEGMENT_MS` 2000→800 ms (Standard) | ~1200 ms | **Yes** — far above noise floor. Visible in N=30. | Clear user-perceptible improvement. |
| Eliminate double PG round-trip (server A1) | ~5–8 ms | **No** — client TTFA noise drowns this. | Server-log-only confirmation. |
| Auth tier-cache (server A2) | ~2–5 ms | **No** — completely invisible at client. | Internal server quality only. |
| Stream TTS from subtitle endpoint (server A6/B5) | ~1000+ ms on TTFD for first line | **Yes** — large and visible. | Already designed in SSE streaming fallback path. |
| Offscreen-document RTCPeerConnection vs content-script | 0–30 ms (speculative) | **No** — within measurement noise; no evidence this saves anything in Chrome 116+. | Architectural change with no proven latency benefit. |
| SW cold-start elimination (keep SW alive) | 1–2 s | **Yes** — the single largest client-side variable. | But MV3 does not allow persistent SW. |

### 5.3 Guard Against Fake Wins

Three failure modes to explicitly guard against:

1. **Provider wind at your back**: a 30-run test A is run on a slow provider day; B runs on a fast day. The A/B alternation protocol (§3.2) is the mitigation. If not alternated, the result is invalid.

2. **Confirmation bias in cold runs**: cold-BG runs show huge variance (1–2 s SW wake); mixing these with warm-BG runs inflates the apparent improvement of any warm-path optimisation.

3. **Measurement self-fulfilling prophecy**: if the instrumentation marks are added inside the critical path (e.g. a `console.log` that triggers a synchronous paint), they can create the very latency they measure. Use `queueMicrotask` or ensure marks are fire-and-forget `console.log` calls only.

---

## 6. Cross-Slice Conflict Flags

The following conflicts were identified between this slice and other active agents:

| Conflict | Involved parties | Note |
|----------|-----------------|------|
| **STT_FIRST_SEGMENT_MS tuning** affects translation quality | This slice (measurement) + server audio agent | A reduction from 2000→800 ms is measurable and detectable, but the quality impact (shorter Gemini context) must be validated in a separate quality audit before shipping. Latency win does not override quality regression. |
| **Pre-warm endpoint B1** creates unmeasured zombie transport cleanup cost | Server resource agent + this slice | Any TTFA improvement from pre-warming must be weighed against median GC overhead. Benchmark with pre-warm GC running in background, not just pre-warm hits. |
| **Offscreen RTCPeerConnection** (hypothetical B variant) | Extension architecture agent | Research slice 01 confirms NO offscreen document exists. There is no evidence offscreen-document WebRTC is faster in Chrome MV3. Do not propose this as an optimisation without first measuring baseline. |
| **Provider variance quoted in this doc** is from 2024-era benchmarks | This slice + any provider comparison agent | Provider performance changes. If MiniMax or OpenAI change their infrastructure, the noise floor estimate changes. Re-baseline before committing to acceptance thresholds. |

---

## 7. Minimum Viable Measurement Checklist

Before calling any result a "proven optimisation":

- [ ] N ≥ 30 alternated A/B runs (not sequential blocks)
- [ ] Warm-BG and cold-BG separated into distinct datasets
- [ ] Network RTT baseline measured and consistent (p95 - p50 ping < 30 ms per block)
- [ ] Same video, same seek position, same caption cache state
- [ ] p50 delta ≥ 200 ms (client TTFA) or ≥ 100 ms (server-observable, confirmed in logs)
- [ ] p95 does not regress vs baseline
- [ ] 95% bootstrap CIs on p50 are non-overlapping
- [ ] Wilcoxon rank-sum p < 0.05
- [ ] Both tiers (Standard and Realtime) pass Tier B non-regression

---

## Sources

- [Wikipedia: Audio-to-video synchronization](https://en.wikipedia.org/wiki/Audio-to-video_synchronization) — ITU-R BT.1359 detectability thresholds (+45 ms / -125 ms)
- [avlatency.com: Acceptable Audio Latency and AV Sync Error](https://avlatency.com/recommendations/acceptable-audio-latency-lip-sync-error/) — acceptability ranges
- [Gradium: Time to First Audio — TTS Latency in Voice Agents](https://gradium.ai/blog/time-to-first-audio) — TTFA definition and benchmarking methodology
- [Gradium: TTS Latency Benchmark 2026](https://gradium.ai/content/tts-latency-benchmark-2026) — P50/P95 benchmarks, provider IQR data
- [Gradium: Best Low-Latency TTS APIs 2026](https://gradium.ai/content/best-low-latency-tts-apis-2026) — P50 < 300 ms acceptability threshold
- [Gladia: Measuring Latency in STT (TTFB, Partials, Finals, RTF)](https://www.gladia.io/blog/measuring-latency-in-stt) — STT latency measurement methodology
- [Streaming Media Producer: Glass-to-Glass Report](https://www.streamingmedia.com/Producer/Articles/Editorial/Featured-Articles/Glass-to-Glass-Report-Comparing-Low-Latency-Streaming-Providers-161238.aspx) — glass-to-glass methodology
- [ResearchGate: Determining AV Sync Errors Perceptible to End-Users](https://www.researchgate.net/publication/3042141_Determining_the_Amount_of_Audio-Video_Synchronization_Errors_Perceptible_to_the_Average_End-User) — 20–40 ms lip-sync perception
- `extension/specs/smooth-dub/research-1-startup-latency.md` — per-step startup timeline with file:line citations
- `extension/specs/smooth-dub/research-4-server-latency.md` — server-side serial step costs and noise estimates
- `extension/specs/extension-perf/research/01-topology.md` — hop-by-hop architecture map
