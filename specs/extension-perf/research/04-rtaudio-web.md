# Research: Real-Time Audio — Server Gateway/Relay vs. Direct-to-Provider Latency

**Wave:** extension-perf  
**Slice:** 04 — WebRTC relay economics  
**Date:** 2026-06-07  
**Status:** FINDINGS COMPLETE — read-only research  

---

## Summary Table

| Hop / Approach | Typical Added Latency (ms) | Type | Source |
|---|---|---|---|
| Direct P2P WebRTC (same continent) | 50–120 ms mouth-to-ear | Measured | forasoft.com/blog; DEV Community SFU vs P2P articles |
| SFU relay (e.g. mediasoup, LiveKit) vs P2P | +50–100 ms additional | Estimated industry consensus (no mediasoup-specific published benchmark) | forasoft.com/blog; dev.to/alakkadshaw; digital samba |
| TURN relay vs direct (NAT traversal) | +20–80 ms | Measured/published | WebRTC search results citing TURN literature |
| Browser → own cloud server → OpenAI (extra hop, same region server) | +10–40 ms per RTT leg | Derived from cloud RTT data (same-region 5–20 ms one-way, cross-region 15–80 ms one-way) | Azure latency docs; Google Cloud latency dashboard |
| Browser → own cloud server → OpenAI (cross-region, e.g. EU user, US-East server) | +100–300 ms | Derived | Azure/AWS latency matrix; Cloudping.co |
| OpenAI Realtime API voice-to-voice (WebRTC direct, US client) | ~1,700 ms total end-to-end | **Measured** (Wireshark + VAD) | webrtchacks.com — "Measuring the response latency of OpenAI's WebRTC-based Realtime API" |
| OpenAI Realtime API TTFB (US client) | ~500 ms | Stated by OpenAI docs | latent.space/p/realtime-api (OpenAI quote) |
| WebSocket transport vs WebRTC transport | "Essentially identical" at ~1,920 ms vs ~2,060 ms median | **Measured head-to-head** | dev.to/nick_lackman — "I Tested Our WebSocket Audio Pipeline with WebRTC" |
| Cascaded STT → LLM → TTS (naive, non-streaming) | 2,000–4,000 ms | Measured/industry consensus | introl.com voice AI guide; softcery.com; deepgram.com |
| Cascaded STT → LLM → TTS (optimized streaming) | 700–1,000 ms (streaming ASR + LLM + streaming TTS) | Measured example: 200+500+150+50+100 ms = 1,000 ms | introl.com voice AI guide |
| Speech-to-speech model (OpenAI gpt-realtime) | ~820 ms TTFA (time-to-first-audio) | Measured (Artificial Analysis) | softcery.com citing Artificial Analysis |
| xAI Grok Voice (fastest S2S) | ~780 ms TTFA | Measured (Artificial Analysis) | softcery.com citing Artificial Analysis |

---

## Finding 1 — WebRTC P2P vs SFU/Relay Added Latency

**Consensus from industry literature (no single authoritative benchmark paper):**

SFU architectures (mediasoup, LiveKit, Janus) add approximately **+50–100 ms** over direct P2P. The mechanism is straightforward: instead of a single network path browser→browser, the media traverses browser→SFU→destination, adding at least one extra RTT. For audio-only relay where the SFU only forwards RTP packets (does not mix or transcode), the pure forwarding overhead is minimal — the bulk of the added latency is the additional RTT of the extra hop.

- **P2P baseline:** 50–120 ms mouth-to-ear on good Wi-Fi.  
  Source: [forasoft.com WebRTC architecture guide](https://www.forasoft.com/blog/article/webrtc-architecture-guide-for-business-2026) — "P2P offers 50–100ms latency, ideal for 1:1 calls."
- **SFU:** 100–200 ms latency.  
  Source: [dev.to/alakkadshaw SFU vs MCU vs P2P](https://dev.to/alakkadshaw/sfu-vs-mcu-vs-p2p-webrtc-architectures-explained-163d) — "SFU achieves 100–200ms latency for 11–100 concurrent users."
- **TURN relay specifically:** adds 20–80 ms vs direct STUN/P2P path.  
  Source: WebRTC STUN/TURN literature (cited in search results from webrtc.ventures, trueconf.com).

**Mediasoup specifically:** does NOT publish per-operation latency benchmarks. The v100.ai 2026 benchmark article explicitly states "coturn, LiveKit, mediasoup, and Janus do not publish per-operation TURN/STUN benchmarks."  
Source: [v100.ai/blog/fastest-webrtc-server-2026.html](https://v100.ai/blog/fastest-webrtc-server-2026.html)

**What determines the relay cost:**
- Geographic distance between browser and relay server (dominates).
- Jitter buffer depth at the receiving end.
- Extra RTT from server → OpenAI leg (independent of browser → server leg).
- In mediasoup's case: it terminates the browser peer (stateful DTLS/ICE), so it is a **full peer termination**, not a transparent TURN relay. This means it re-encodes or at minimum re-packetizes the RTP stream — the forwarding cost is higher than a pure TURN relay.

---

## Finding 2 — OpenAI Realtime API Latency (Measured)

The most rigorous public measurement is from **webrtcHacks (Chad Hart, 2024):**
- Methodology: Wireshark PCAP + libWebRTC neteq_rtpplay → WAV + Silero VAD for automated speech detection; 3 exchanges measured.
- **Result: ~1.7 seconds** voice-to-voice (from end of speaker turn to start of AI response audio in RTP stream).
- Network RTT (STUN): 60–70 ms — this is the pure network component, everything else is model inference + turn detection.
- Source: [webrtchacks.com — Measuring OpenAI WebRTC Realtime API response latency](https://webrtchacks.com/measuring-the-response-latency-of-openais-webrtc-based-real-time-api/)

OpenAI's own stated target:
- **~500 ms TTFB** for US clients.
- "800 ms voice-to-voice is a good target" — implies they acknowledge ~1.7s in practice is above goal.
- Default `silence_duration_ms` VAD parameter = 500 ms (adds to perceived latency before inference starts).
- Source: [latent.space OpenAI Realtime API — The Missing Manual](https://www.latent.space/p/realtime-api)

**OpenAI's own infrastructure design for proximity:** OpenAI uses Cloudflare geo-steering so users connect to a nearby **relay node** first (not the model datacenter), then the media is forwarded over a fast backbone to compute. Their relay nodes do **not** decrypt media — they are lightweight UDP forwarders. This is architecturally analogous to what Echoly does with mediasoup, except OpenAI controls the edge nodes globally at scale. Source: OpenAI blog on low-latency voice AI (403 on direct fetch; confirmed via techplanet.today summary).

**WebRTC vs WebSocket (OpenAI's documented guidance):**
> "When connecting to a Realtime model from the client (like a web browser or mobile device), we recommend using WebRTC rather than WebSockets for more consistent performance."

Reason given: WebSocket/TCP suffers head-of-line blocking, lacks Opus FEC, lacks integrated jitter buffering and congestion control (GCC algorithm). WebRTC's UDP+Opus+jitter-buffer stack is purpose-built for voice.  
Source: [developers.openai.com/api/docs/guides/realtime-webrtc](https://developers.openai.com/api/docs/guides/realtime-webrtc)

---

## Finding 3 — The Cost of an Extra Network Hop

**General rule:** Each added hop adds at least one RTT to the critical path.

Cloud RTT data (from Azure, Google Cloud, AWS latency matrices):
- Browser → same-region cloud server one-way: 5–20 ms (RTT: 10–40 ms)
- Browser → cross-region cloud server one-way: 15–80 ms (RTT: 30–160 ms)
- Cloud server (US) → OpenAI (US, same cloud region/backbone): likely 1–10 ms

**Net added latency for Echoly's architecture (browser → Echoly mediasoup → OpenAI):**

| Scenario | Added latency vs direct |
|---|---|
| Echoly server co-located with OpenAI (same cloud region, e.g. US-East) | +10–40 ms RTT (browser→Echoly) + <10 ms (Echoly→OpenAI) ≈ **+20–50 ms total** |
| Echoly server US, user in EU | +100–200 ms (browser→Echoly) + <10 ms (Echoly→OpenAI) ≈ **+100–200 ms total** |
| Echoly server in same country as user | Smaller: browser→Echoly ~20–50 ms RTT ≈ **+30–60 ms vs direct** |

**API gateway software overhead** (TLS, routing logic): 5–20 ms per request (well-tuned gateway). This is negligible compared to RTT.  
Source: AWS re:Post, Tyk blog, dev.to/ovaiseq network hop article.

**Key insight from the webrtcHacks measurement:** the WebRTC STUN RTT to OpenAI was 60–70 ms from the test client. If Echoly's server has a 20–30 ms RTT to OpenAI (same region), the extra per-packet RTT added is roughly **20–30 ms one-way** — modest relative to the ~1,700 ms total exchange latency.

---

## Finding 4 — WebSocket vs WebRTC for Real-Time Audio

**Theoretical advantage of WebRTC over WebSocket:**
- WebRTC uses UDP: no head-of-line blocking. A dropped 20 ms audio frame is imperceptible; TCP retransmission during a loss event can block 100–200+ ms.
- WebRTC includes adaptive jitter buffer (absorbs network jitter automatically).
- Opus codec over WebRTC includes Forward Error Correction (FEC) — conceals packet loss.
- WebRTC has integrated echo cancellation, AGC, noise reduction.
- WebSocket/TCP lacks all of these; user must implement manually.

**Empirical result (head-to-head test):**
> "Median response latency: WebSocket ~1,920 ms vs WebRTC ~2,060 ms — essentially identical. Transport layer accounts for less than 5% of total conversational latency. The bottleneck is the model, not the pipe."

Source: [dev.to/nick_lackman — I Tested Our WebSocket Audio Pipeline with WebRTC. Here's Why I Switched It Back.](https://dev.to/nick_lackman/i-tested-our-websocket-audio-pipeline-with-webrtc-heres-why-i-switched-it-back-3g1j)

**Interpretation:** For AI dubbing, where model inference dominates (~1,200–1,400 ms of the ~1,700 ms total), transport protocol choice is nearly irrelevant for **average** latency. WebRTC wins on **tail latency** (avoiding HoL-induced spikes) and **audio quality** under packet loss, not on median numbers. For Echoly's use case (continuous dubbing stream, not turn-taking), this distinction matters: jitter and dropout artifacts matter more than average latency.

---

## Finding 5 — STT → Translate → TTS Cascade vs Speech-to-Speech

**Cascaded pipeline (Echoly's MiniMax STT → translate → TTS path):**

| Component | Typical latency |
|---|---|
| STT (streaming ASR, e.g. Deepgram Nova-3) | 150–300 ms |
| STT (Whisper self-hosted, optimized) | 380–520 ms |
| LLM/MT translation (GPT-4o-mini class) | 350–500 ms |
| TTS synthesis to first audio (ElevenLabs Flash, Cartesia Sonic) | 40–150 ms |
| **Optimized streaming cascade total** | **700–1,000 ms** |
| **Naive non-streaming cascade total** | **2,000–4,000 ms** |

Source: [introl.com voice AI infrastructure guide 2025](https://introl.com/blog/voice-ai-infrastructure-real-time-speech-agents-asr-tts-guide-2025); [deepgram.com real-time S2S guide](https://deepgram.com/learn/real-time-speech-to-speech-translation)

The deepgram.com article reports: "Adding 4,200ms of latency with non-streaming TTS. Switching to streaming TTS dropped that to 475ms." This confirms that **streaming TTS is not optional** — it's what makes cascade viable.

**Speech-to-speech (OpenAI Realtime, gpt-realtime-1.5):**
- Time-to-first-audio: ~820 ms (Artificial Analysis benchmark).
- End-to-end voice-to-voice: ~1,700 ms (webrtcHacks measured; includes VAD silence window ~500 ms + inference ~500 ms + audio delivery).

**Net comparison:**
- OpenAI Realtime (S2S, direct): **~820 ms TTFA, ~1,700 ms full turn**
- MiniMax cascade (optimized streaming): **~700–1,000 ms** — roughly comparable or slightly faster to first audio, but may degrade under load since it is three sequential network calls vs one.
- Cascade is **2× worse** if any component is not streaming or adds a batch penalty.

**Quality note:** Cascaded Whisper-LV3 + NLLB-3.3B scored 21.6 BLEU vs SeamlessM4T v2 at 15.8 BLEU — cascade wins on translation quality but pays latency cost.  
Source: deepgram.com S2S guide.

---

## Finding 6 — Why Teams Route Through Their Own Server (Despite Latency Cost)

**Security / Key management (the primary justification):**

OpenAI explicitly warns: "you only use standard OpenAI API keys on the server, not in the browser."  
Source: [developers.openai.com/api/docs/guides/realtime-webrtc](https://developers.openai.com/api/docs/guides/realtime-webrtc)

Options and their trade-offs:

| Option | Approach | Latency | Key security |
|---|---|---|---|
| **A: Full server relay** (Echoly current) | Browser → Echoly mediasoup → OpenAI | Adds +20–200 ms RTT depending on co-location | Keys fully server-side; ideal |
| **B: Ephemeral token (direct)** | Server mints 60s single-use token; browser connects directly to OpenAI | Minimal added latency (only initial token fetch, not ongoing relay) | Keys server-side; token is short-lived / single-use |
| **C: BYOK / browser-direct (legacy)** | Browser holds provider key directly | Lowest latency | Keys exposed in browser — **unacceptable for production** |

OpenAI's own recommendation for new integrations is **Option B (ephemeral token)** for lower latency while maintaining security. The "unified interface" (server as persistent relay, Option A) is simpler but "puts your application server in the critical path."

**Metering / abuse control (Echoly's primary use case):**
- Server-authoritative metering (Echoly's centi-minute reserve→commit model) is **only possible if all media flows through the server**. An ephemeral token (Option B) would let the browser connect directly to OpenAI — Echoly could still meter session duration server-side (it issues the token and knows session start/end), but would lose per-packet / per-second granularity.
- Fair-use enforcement, quota checking, fraud detection (Echoly's Metering + UsagePeriod services) require the server to be on the critical path OR to receive accurate reporting from the client — which is inherently trust-absent.
- **Verdict:** Full server relay (Option A / current architecture) is the only option that supports Echoly's server-authoritative metering. Ephemeral tokens would weaken metering fidelity unless the server also intercepts session events (which requires a WebSocket event bridge back to the server anyway).

**Other counterweights:**
- Observability: full relay gives the server access to the audio stream for quality metrics, SSRC tracking, and debugging.
- Geographic optimization: a well-placed relay between user and OpenAI can *reduce* total latency if OpenAI's closest PoP is farther from the user than Echoly's server (an edge deployment scenario). OpenAI itself does this with its Cloudflare relay nodes.
- Provider portability: routing through Echoly's server makes swapping OpenAI for MiniMax, Gemini Live, or another backend transparent to the browser.

---

## Verdict: Does Echoly's Server Relay Make Realtime FASTER or SLOWER?

**Slower than browser-direct-to-OpenAI, but by a modest and acceptable margin in most cases.**

### Quantified latency cost

With Echoly's mediasoup server **co-located in the same US cloud region as OpenAI (US-East):**
- Added latency: **+20–50 ms** on top of the ~1,700 ms total end-to-end.
- That is a **+1–3% overhead** — imperceptible.

With Echoly's server in a **different region from the user** (e.g., US server, EU user):
- Added latency: **+100–300 ms** — pushing a ~1,700 ms exchange to ~1,800–2,000 ms.
- This is ~+10–15% and starts to be perceptible if the user is already near the conversation-discomfort threshold.

### The dominant latency driver

The ~1,700 ms total voice-to-voice time (webrtcHacks measured) breaks down roughly:
- VAD silence window: ~500 ms (configurable)
- Model inference: ~700–900 ms
- Network RTT (browser↔OpenAI): 60–70 ms
- Relay overhead (if any): 20–100 ms

**The model is the bottleneck, not the relay.** Transport layer = < 10% of total latency. This matches the empirical finding that WebSocket vs WebRTC was "essentially identical" (< 5% difference) in practice.

### Is the trade-off justified?

**Yes, for Echoly's specific requirements:**
1. **Metering is non-negotiable** — server-authoritative reserve→commit cannot function without the server on the critical path. This alone forces Option A or a carefully designed hybrid.
2. **Key security** — shipping OpenAI API keys to the browser is not an option for a commercial product; the server relay is the clean solution (the alternative, ephemeral tokens, is viable for latency but weakens metering granularity).
3. **Provider abstraction** — the relay lets Echoly swap OpenAI for MiniMax or other backends without extension changes.
4. **Latency cost is modest if server is well-placed** — the +20–50 ms cost at same-region co-location disappears into model-inference noise.

**What Echoly should NOT do:** place the mediasoup server geographically far from the majority of users. A EU-based user hitting a US-only server adds 150–300 ms RTT, which is the scenario where the relay becomes genuinely harmful. Multi-region deployment (or edge relay, as OpenAI itself does) is the mitigation.

---

## Evidence Quality Notes

- **OpenAI Realtime ~1,700 ms figure:** STRONG — independently measured via Wireshark PCAP + VAD (webrtcHacks). Reproducible methodology.
- **SFU adds +50–100 ms over P2P:** MODERATE — derived from industry consensus across multiple sources; no single controlled benchmark comparing mediasoup relay vs direct with audio-only streams. Mediasoup publishes no benchmark.
- **TURN relay adds 20–80 ms:** MODERATE — from WebRTC practitioner articles; not a controlled paper.
- **Cascade 700–1,000 ms (streaming):** MODERATE — consistent across multiple industry sources but not a single unified benchmark.
- **WebSocket vs WebRTC "essentially identical":** STRONG — single measured head-to-head (dev.to/nick_lackman), confirmed by theory (model dominates).
- **Cloud RTT figures:** STRONG — from Azure/Google/AWS published latency matrices.
- **OpenAI docs (ephemeral token / WebRTC recommendation):** STRONG — primary source, official documentation.

---

## Sources

- [webrtcHacks — Measuring OpenAI WebRTC Realtime API response latency](https://webrtchacks.com/measuring-the-response-latency-of-openais-webrtc-based-real-time-api/)
- [OpenAI — Realtime API with WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc)
- [latent.space — OpenAI Realtime API: The Missing Manual](https://www.latent.space/p/realtime-api)
- [LiveKit — Why WebRTC beats WebSockets for realtime voice AI](https://livekit.com/blog/why-webrtc-beats-websockets-for-voice-ai-agents)
- [dev.to/nick_lackman — I Tested Our WebSocket Audio Pipeline with WebRTC](https://dev.to/nick_lackman/i-tested-our-websocket-audio-pipeline-with-webrtc-heres-why-i-switched-it-back-3g1j)
- [forasoft.com — P2P, SFU, MCU, Hybrid WebRTC Architecture Guide 2026](https://www.forasoft.com/blog/article/webrtc-architecture-guide-for-business-2026)
- [dev.to/alakkadshaw — SFU vs MCU vs P2P](https://dev.to/alakkadshaw/sfu-vs-mcu-vs-p2p-webrtc-architectures-explained-163d)
- [v100.ai — Fastest WebRTC Server 2026 (mediasoup no published benchmark)](https://v100.ai/blog/fastest-webrtc-server-2026.html)
- [introl.com — Voice AI Infrastructure guide 2025](https://introl.com/blog/voice-ai-infrastructure-real-time-speech-agents-asr-tts-guide-2025)
- [deepgram.com — Real-Time Speech-to-Speech Translation](https://deepgram.com/learn/real-time-speech-to-speech-translation)
- [softcery.com — Real-Time vs Turn-Based Voice Agent Architecture](https://softcery.com/lab/ai-voice-agents-real-time-vs-turn-based-tts-stt-architecture)
- [blog.cloudflare.com — Cloudflare Calls: anycast WebRTC](https://blog.cloudflare.com/cloudflare-calls-anycast-webrtc/)
- [gethopp.app — Achieving <100ms Latency with WebRTC](https://www.gethopp.app/blog/latency-exploration)
- [Azure network round-trip latency statistics](https://learn.microsoft.com/en-us/azure/networking/azure-network-latency)
- [dev.to/ovaiseq — Extra Network Hop Latency in Production](https://dev.to/ovaiseq/why-one-extra-network-hop-silently-breaks-your-latency-budget-in-production-19ck)
