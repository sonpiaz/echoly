# Extension architecture & latency — analysis + evidence-gated optimization plan

**Question (user, paraphrased):** "I see the extension calling APIs directly from the app — is that correct?
Is the extension correctly using a web service to speed things up? Compare against best practice on the
internet, and propose an optimal architecture — but only count something as an optimization if there is
PROOF it is actually faster."

Converges 5 research findings (`research/01..05`) + 1 adversarial critic round (REVISE→fixed below).

---

## 1. What the extension actually does today (verified, with file:line)

**Two data-plane paths, both originating in the CONTENT SCRIPT, both routed through the Echoly server
gateway (`api.echolyhq.com/v1`). No provider is ever called directly from the browser. The background
service worker (SW) is control-plane only.**

### Realtime tier (WebRTC)
```
[page <video>] --captureStream()--> [CONTENT SCRIPT: new RTCPeerConnection()]   capture.ts:84 / webrtc-pipeline.ts:176
   --HTTPS POST /v1/rtc/translate (SDP)--> [ECHOLY SERVER: mediasoup terminates peer]   webrtc-pipeline.ts:379
   --Opus→PCM, wss--> [OpenAI Realtime]  --translated PCM→Opus--> back to browser track
   --> [CONTENT SCRIPT: HTMLAudio + WebAudio gain --> speakers]
```
Control calls (also from content script): `POST /v1/rtc/prepare` (pre-warm), 30 s heartbeat, media-pause/resume, `/end`.

### Standard tier (subtitle-first, the preferred YouTube-VOD path)
```
[YT MAIN world patches fetch/XHR, captures timedtext + poToken]  yt-mainworld.content.ts
   --> [CONTENT SCRIPT: regroup sentences --HTTPS POST /v1/translate/subtitles/stream (SSE)-->  echoly-api.ts:147
        [ECHOLY SERVER: Gemini translate + MiniMax TTS per line, SSE back]
   --> decodeAudioData --> AudioBufferSourceNode --> speakers]   (no WebRTC peer in this path)
```
No-caption fallback creates a WebRTC peer at runtime (server runs Gemini-audio→MiniMax instead of OpenAI).

**Background SW** (`background/*`): reads `ec_session` cookie → resolves bearer → relays START/STOP +
settings (`apiBase`, `apiBearer`) to content. **Zero data-plane fetches.** No `chrome.offscreen` document
anywhere. Main-world script exists only to read YouTube's `poToken` (cannot be minted externally).

---

## 2. Direct answers to the user's questions (with evidence)

### Q1 — "Calls are made directly from the app — is that correct?"
**Yes — all AI fetches + the WebRTC peer originate in the content script.** Correct and intentional for the
fetches, with one nuance: per Chrome's rule (chromium.org extension-content-script-fetches, enforced since
Chrome 85–87) a content-script fetch runs under the **page origin** (`youtube.com`), not the extension origin.
It works only because the server sets permissive CORS for the extension. Best practice would move cross-origin
fetches to the SW/offscreen (extension origin, `host_permissions`). **This is correctness/robustness hygiene,
NOT a latency win.**

### Q2 — "Is the extension correctly using a web service to speed things up?" → **It depends on server geography.**
The Echoly server gateway does **not** make the product faster in the abstract — it **adds** network latency
versus a hypothetical browser-direct-to-OpenAI path. From research (`04-rtaudio-web.md`):

| Hop / approach | Added latency | Type | Source |
|---|---|---|---|
| Same-region server relay (browser→server→OpenAI vs direct) | **+20–50 ms** | derived | Azure/GCP RTT matrices |
| **Cross-region server (e.g. SE-Asia user, US server)** | **+100–300 ms** | derived | Azure/AWS RTT matrices |
| WebSocket vs WebRTC transport (head-to-head) | **<140 ms / "essentially identical"** | **measured** | dev.to/nick_lackman |
| OpenAI Realtime voice-to-voice total | **~1700 ms** | **measured** (Wireshark+VAD) | webrtchacks.com |
| Cascaded STT→MT→TTS (optimized) | 700–1000 ms | industry | introl/deepgram |

**The model inference (~700–900 ms) + VAD silence window (~500 ms) dominate; transport is <5–10% of total.**
"The model is the bottleneck, not the pipe."

So the honest framing has TWO parts:
- The gateway is the **right design for metering + key security, not speed**: (1) server-authoritative
  reserve→commit metering (the anti-fraud invariant) is only enforceable with the server on the critical path;
  (2) provider keys must never ship to the browser. It pays a small latency tax to buy those.
- **BUT that tax is only "small" if the server is geographically near users.** Echoly's output language work is
  Vietnamese-first → a large share of users are in SE Asia, ~150–250 ms RTT from a US-East server. If the
  mediasoup server is US-only, the web service is **actively costing those users 100–300 ms** — i.e. the answer
  to "is it speeding things up?" is *"no, and for far users it's slowing them down."* **This is the single
  highest-value, lowest-effort, instrumentation-free lever in the whole analysis** (see §4-A).

### Q3 — "Compare to best practice; propose the optimal architecture."
Best-practice MV3 (`03-mv3-web.md`) says the WebRTC peer + audio "should" live in an **offscreen document**
(SW can't do WebRTC/WebAudio; a content-script peer is destroyed on SPA navigation). Two distinct sub-claims —
keep them separate:
- **Cold-start TTFA via offscreen peer:** no benefit. Research (`05-evidence.md`) flags *"an
  offscreen-document RTCPeerConnection saves nothing provable — no evidence in Chrome 116+ that it is faster
  than a content-script peer."* And capture is page-bound (`capture.ts:84` `video.captureStream()`): an
  offscreen doc cannot see page DOM, a live `MediaStream` can't be `postMessage`d content→offscreen, so this
  needs a `chrome.tabCapture`-via-offscreen rewrite (whole-tab capture, feedback-loop risk). Not justified for
  cold start.
- **Auto-next / transition cost via offscreen peer:** a *separate, real* question. A content-script peer dies
  on every YouTube SPA video change / ad, forcing a full re-ICE + re-SDP + reconnect (~450–800 ms) on each
  transition — exactly what `rtc-handover.ts` / `auto-next.ts` exist to paper over. An offscreen peer's
  lifetime is independent of tab navigation, so it *could* eliminate the per-transition re-handshake across a
  multi-video session. This is a **legitimate Stage-2 candidate with its own measurement target** (re-handshake
  latency on video change, NOT cold-start TTFA) — but it carries the tabCapture rewrite cost and is unproven.

For *this* product the content-script peer is a defensible home precisely because that is where the capturable
media lives; the optimal architecture is **not** a blind "move everything to offscreen."

---

## 3. The architecture is already well-optimized

Smooth-dub + dub-e2e waves already shipped the high-value latency work (`02-latency.md`): `/v1/rtc/prepare`
pre-warm, SSE streaming subtitles, navigation caption prefetch, optimistic popup render, event-driven realtime
VOD alignment, `SUBFIRST_PREBUFFER_COUNT` 3→1, `DUB_TTFA_GATE` 14s→8s, **and a partial SW keepalive** (see
§4-B). Current TTFA: Standard ~1.2–3.5 s, Realtime ~0.7–3.5 s. **The cheap client-side wins are largely taken.**

---

## 4. The honest conclusion & the only evidence-respecting path

The user's rule — *"only count it as an optimization if there is proof it is faster"* — exposes the real blocker:

> **The codebase has ZERO end-to-end latency instrumentation (`02-latency.md`, `05-evidence.md`): no timestamp
> at click, none at first audio, no `performance.mark` on the critical path, no server-timing surfaced. We
> cannot prove OR disprove a client-side speedup today.**

Two of the highest-value levers, however, are **provable without the full A/B harness** because their expected
effect (100s–1000s of ms) is far above both the 200 ms perception bar and the provider noise floor:

**4-A. Server geographic placement (HIGHEST value, no extension code, instrumentation-free proof).**
Measure browser→server RTT from the primary user geography (Vietnam / SE Asia). If it exceeds ~80 ms, the relay
is taxing every realtime session 100–300 ms. Mitigation = multi-region mediasoup or an edge/anycast WebRTC
termination (this is exactly what OpenAI does with Cloudflare relay nodes, `04-rtaudio-web.md:67`). Proof = a
`ping`/RTT table from VN + a US baseline; no A/B run needed. *Server-repo / deployment concern — out of
extension build scope, but it is the top recommendation and must be surfaced to the user.*

**4-B. SW cold-start on the popup→click path (provable, low-risk, extension code).**
Correction to an earlier draft: a SW keepalive **already exists** — `QuickStartLauncher` pings
`GET_LAUNCH_STATE` every 20 s "keeping the MV3 service worker warm" (`launcher.ts:16,37,60`). But the content
script (hence the launcher) runs **only on youtube/coursera/udemy** (`entrypoints/content/index.ts:15–22`).
Opening the popup also wakes the SW via its `GET_STATE` round-trip, and the optimistic cached render
(`popup/index.ts`) masks it visually. **Remaining gap:** user on an *unsupported-domain* tab, or who opens the
popup, lets it idle >30 s, then clicks START → the START message waits on a cold SW (`02-latency.md`: +200–1500 ms;
`03-mv3-web.md`: up to 5,400 ms on 6 W hardware — measured, single report). Honest framing of the fix: MV3 caps
SW idle at ~30 s — you cannot keep it warm *indefinitely* (a popup `runtime.connect` port only holds it while the
popup is open; once closed the idle timer resumes). So the real remedies are (a) the off-domain case → broaden
where a keepalive runs (a minimal always-on content script, or `chrome.alarms`); (b) the closed-popup case →
accept the cap and *mask* it (B3 optimistic render already does), or warm-on-popup-open right before a likely
START. The win (>200 ms, often >1 s) is **trivially above the bar and provable with a simple warm-vs-cold START
timing**, not a 30-run A/B.

**Everything else is speculative until measured** — and the research predicts three of four remaining candidates
sit below the provider noise floor (~600 ms/utterance), i.e. **unprovable, therefore not optimizations** under
the user's rule. So the build plan is:

### Chosen approach — staged, second stage gated on the first + on human approval

**STAGE 1 (warranted now, low-risk, ~½ day): TTFA instrumentation harness.** Debug-flagged latency probe:
- `M_START_CLICK` (popup: embed `Date.now()` in the START message) → `M_CONTENT_START` (content `CONTENT_START`
  handler: capture `performance.now()` **and** `Date.now()` so click-time crosses the context boundary) →
  `M_SDP_FETCH_START/END` (around `webrtc-pipeline.ts:379`, log `x-echoly-session-id`) → `M_FIRST_AUDIO`
  (Realtime `track.unmute`; Standard before `AudioBufferSourceNode.start()`).
- **Cross-context formula (explicit):** `TTFA_from_click = (Date.now()_at_content_receipt − Date.now()_from_START_msg)
  + (M_FIRST_AUDIO_perf − M_CONTENT_START_perf)`. The first parenthesis = popup→SW→content relay (includes any
  SW cold-start); the second = pure pipeline time on the content monotonic clock. Report both, plus their sum.
- Surfaced behind a flag read **once at module init** (`const PERF_ENABLED = localStorage.getItem("echolyPerf")==="1"`
  at top-of-module → module-scoped boolean; hot-path cost = one boolean branch, zero allocation when off).
  Output a structured `console.table` / overlay readout; correlate to server via existing `x-echoly-request-id`.
- Genuinely useful regardless of any later change, and it is the prerequisite the user's own rule demands.

**STAGE 2 (gated on Stage-1 data + human approval): A/B-test candidates; ship only provable winners.**
Run the `05-evidence.md` protocol — N≥30 alternated (ABAB) runs, warm + cold separated, p50/p95 with bootstrap
CIs, Wilcoxon p<0.05. **Acceptance bar: ship only if p50 TTFA drops ≥200 ms with non-overlapping 95% CIs**
(≈ minimum perceptible "feels faster", above provider noise). For the auto-next/transition candidate the user
experience is tighter (AV-sync ~125 ms, ITU-R BT.1359) — measure transition latency, not cold-start TTFA.
Candidate backlog, ranked by predicted provable win:
1. **No-CC Standard STT first-segment window** (predicted ~1200 ms; clearly above noise) — gated by a parallel
   translation-quality check (shorter context may degrade Gemini output).
2. **Offscreen-document peer for auto-next transitions** (predicted ~400 ms/transition in multi-video sessions)
   — distinct from cold-start; carries the `tabCapture`-via-offscreen rewrite; measure re-handshake latency.
3. **Remove `REALTIME_VOD_PLAY_ALIGN_MS=80` sleep** — note it is currently **inert** (`standard-vod-start.ts`
   uses `Math.max(alignMs, 1000)`, so the 80 ms value never applies). Removal is correctness cleanup, **not** a
   claimed speedup.
4. **Move data-plane fetches to SW/offscreen** — CORS/origin hygiene, **no latency claim**.

---

## 5. Acceptance criteria (Stage 1 — the only code we build pre-checkpoint)

1. With `localStorage.echolyPerf=1`, starting a session (both tiers) logs a structured record with all marks,
   the cross-context `TTFA_from_click` (per the §4 formula), and the SDP-RTT / ICE / pipeline sub-splits.
2. Flag read **once at module init**; **zero marks/allocation on the hot path when off** (proven by a test that
   asserts no probe calls fire with the flag unset).
3. `ttfaMs` correlates to a server log line via `x-echoly-request-id` / `x-echoly-session-id`.
4. A repeatable harness/script (or documented manual protocol) produces p50/p95 over N runs from the records,
   separating warm-SW from cold-SW datasets.
5. `tsc --noEmit` clean; existing vitest suite green; ≥1 unit test on the mark-collection/aggregation +
   cross-context arithmetic with real (non-toy) timestamp inputs.
6. **No behavioral change to the dubbing pipelines** — probe only observes.

## 6. Rejected alternatives (and why)
- *"Move everything to an offscreen document because best practice says so"* — capture is page-bound; no
  provable cold-start win; large rewrite. Rejected as a speculative optimization (only the transition case
  survives, as a gated Stage-2 candidate).
- *"Call OpenAI directly from the browser to cut the relay hop"* — breaks metering + leaks keys; saves only
  20–300 ms of a ~1700 ms path. Rejected.
- *"Ship the small tunings (80 ms sleep, fetch-in-SW) as optimizations now"* — the 80 ms sleep is inert and the
  fetch move has no latency effect; shipping either as a "speedup" would be an unprovable claim. Allowed only as
  labeled cleanup, post-checkpoint.
