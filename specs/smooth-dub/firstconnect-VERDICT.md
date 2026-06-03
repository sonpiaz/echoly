# First-Connect Latency — Cross-Examiner Verdict

*Branch: wave/smooth-dub — Code-verified, 2026-06-02*

---

## Claim-by-Claim Verdict

### Claim 1: alignRealtimeVodBeforePlay — "up to 2000 ms ceiling, Math.max(alignMs, 2000) = 2000 ms"

**VERDICT: TRUE, BUT MISFRAMED — the 2000 ms ceiling is STILL in the current code, however the investigator's characterisation of the problem is partially wrong.**

Reading `src/lib/standard-vod-start.ts` lines 29–32 on wave/smooth-dub:

```ts
// Ceiling: alignMs is at minimum 80 ms (REALTIME_VOD_PLAY_ALIGN_MS), but we
// allow it to be capped higher (the 2 000 ms element-wait from the old code).
// In practice alignMs=80 so the ceiling is 2 000 ms — same worst-case as before.
const ceiling = Math.max(alignMs, 2000);
```

So `REALTIME_VOD_PLAY_ALIGN_MS = 80` (constants.ts:66), and the function immediately computes `Math.max(80, 2000) = 2000`. The 2000 ms ceiling is real. The claim is correct.

**What was already changed:** the old code did an unconditional fixed-duration sleep. The current code is event-driven — it resolves early the moment `getDubAudio()` returns an element with `readyState >= 1` or the element fires `canplay`/`loadedmetadata`. So on a good path (OpenAI sends its first audio delta while ICE/DTLS is completing), this can resolve in ~300–600 ms. The 2000 ms only hits on the **slow path** where OpenAI hasn't sent audio by the time ICE is done.

**What is still wrong:** The `Math.max(alignMs, 2000)` expression is dead code for the intended purpose. The intent stated in the comment — "allow it to be capped higher" — contradicts the actual math: `alignMs=80` always yields ceiling=2000, so the passed-in `alignMs` parameter is entirely ignored for anything that matters. This is the correct description of the O6 fix: remove the `Math.max(..., 2000)` override so the function respects `REALTIME_VOD_PLAY_ALIGN_MS` (80 ms) as a true fallback ceiling.

**Risk of O6 fix:** On the slow path the video will start playing after 80 ms even if OpenAI hasn't begun streaming audio yet. The user will hear the original source audio for the time it takes OpenAI to produce its first delta (200–800 ms). This is a real UX tradeoff, not a bug. Whether it's better than "frozen for up to 2 s" depends on what the user prefers. A softer fix (reduce ceiling to 1000 ms rather than 80 ms) is viable. This is SAFE to ship — the alignment is a soft gate, not a correctness invariant.

---

### Claim 2: MV3 Service-Worker keepalive feasibility

**VERDICT: PARTIALLY CORRECT — the 200–1500 ms SW cold start is real and is the single largest first-connect cost. The proposed fix (content-script PING every 20 s) works but requires nuance on lifetime limits.**

**What is confirmed:**
- `src/background/index.ts` registers all listeners in `initBackground()` with no keepalive mechanism. There are no `chrome.alarms`, no port-based keepalives, and no `setInterval` in background code.
- `HEARTBEAT_MS = 30_000` in constants.ts is the _session heartbeat_ (POST to `/rtc/translate/:id/heartbeat` during active dubbing). It is NOT a SW keepalive. During a session the content script's `setInterval` fires every 30 s making `fetch` calls, which incidentally keeps the SW running — but this stops when no session is active.
- The popup's `GET_STATE` message wakes the SW but does not keep it alive for more than 30 s after the popup is opened.
- `registerAutoStart` uses `chrome.tabs.onUpdated` event; these event-driven wakeups do not prevent idle termination between events.

**On the "5 min max port lifetime" claim:** The investigator is correct that Chrome's MV3 SW has a hard 5-minute lifetime even with open port connections (Chromium bug #1152255, Chrome 116+). A long-lived `chrome.runtime.connect()` port keeps the SW alive for as long as the port is open, up to 5 minutes — but the port must be actively maintained. The content-script-driven 20-second PING approach (using `sendMessage`, not a port) resets the **30-second idle timer** on each message, which is sufficient to prevent termination. This works for as long as the page tab is open. The content script running on YouTube/Coursera/Udemy (already injected via static manifest match) is always alive on those pages and CAN send a PING to reset the SW idle timer.

**Battery/policy concern:** A `chrome.runtime.sendMessage` from content script every 20 s is extremely cheap (a few bytes of IPC). Chrome's own documentation and policy allow this; it is not a battery drain concern. The SW only wakes briefly on each message.

**Does this eliminate the 200–1500 ms cold start?** YES — on supported platforms where the content script is already running. On a tab loaded BEFORE the extension was installed/reloaded, the content script isn't running yet, so no keepalive is possible until after the first `ensureContentScript` injection. On fresh tabs where the extension auto-injects (manifest static match: YouTube, Coursera, Udemy), the keepalive works from tab load.

**One important correction to the investigator's claim:** The investigator says "Chrome 116+ resets the 30 s idle timer on chrome.runtime messages / port activity." This is correct for `sendMessage`. The 5-minute cap applies only to the maximum SW lifetime in a single run, not to timer resets. Periodic 20 s pings from a content script keep the SW perpetually alive (no 5-min cap on reset-based keepalives, only on port-based keepalives held open continuously).

**Existing mechanism to check — auto-start:** `registerAutoStart` fires on `tabs.onUpdated` which wakes the SW on every page navigation on all tabs. On an active browser this likely fires at least once every 1–2 minutes, keeping the SW reasonably warm. However, it does NOT guarantee the SW is warm when the user clicks Start — a user who opened YouTube 5 minutes ago and hasn't navigated since will have a cold SW.

**Conclusion:** SW keepalive via content-script PING every 20 s is effective and safe on platforms where the content script is statically injected. Implement it. The code is two lines in the content script (`setInterval(() => chrome.runtime?.sendMessage?.({ type: "SW_PING" })?.catch(() => {}), 20_000)`). The background router must handle `SW_PING` as a no-op (or it can be handled implicitly by `routeMessage`'s default case which returns `{ok:false}` — either way the response is ignored).

---

### Claim 3: prepareIntent timing — hover/focus only, warm-SW-only

**VERDICT: CONFIRMED CORRECT. The investigator's analysis is accurate.**

Code confirms:
- `maybeSendPrepareIntent()` fires only on `toggleBtn.addEventListener("mouseenter", ...)` and `toggleBtn.addEventListener("focus", ...)` (popup/index.ts:880-881).
- It does NOT fire on popup open, tier change, or auto-start.
- The debounce flag (`prepareIntentSent`) resets on `mouseleave`/`blur`, so one fire per hover session.
- `CONTENT_PREPARE_INTENT` reaches the content script via router.ts:208-233, which calls `webrtc.prepareIntent()`.
- Guards in content/index.ts:842: only fires when `!sm.session && s?.apiBearer && s?.targetLanguage`.
- Warm slot TTL: `RTC_PREPARE_TTL_SEC = 30` (env.ts:225). Cap: `RTC_PREPARE_MAX_PER_USER = 2` (env.ts:226).

**Is firing on popup-open safe?** YES with one caveat. A popup-open fire allocates a mediasoup transport + pre-dials OpenAI WS. If the user opens the popup, doesn't click Start, and closes it within 30 s, the slot expires harmlessly. The 2-slot-per-user cap means: if the user has already pre-warmed twice (e.g. from two tabs), a third popup-open would evict the oldest slot. Empirically this is a non-issue — users rarely have two concurrent popup sessions.

**Double-fire risk:** The popup-open fire + hover fire would both trigger `maybeSendPrepareIntent`. But the hover-time `prepareIntentSent` debounce is in-function state and does NOT deduplicate against a popup-open trigger (they're separate callsites). The content-script `prepareIntent()` function itself does not prevent a second call — it just fires a new POST. Result: two warm slots used. Acceptable given the 2-slot cap. The second call would overwrite `this.#pendingPrepareId` with the new prepare_id, discarding the first slot. Net result: one warm slot at click time (the most recent). This is correct behavior — no cost-burning risk since `/v1/rtc/prepare` is non-billable.

**Tier-select firing:** The investigator proposes firing on `tierSelect` change to Realtime. This is clean and safe. The tier-change event is already in `popup/index.ts` at the `tierSelect.addEventListener("change", ...)` handler, making this a one-line add.

---

### Claim 4: STT_FIRST_SEGMENT_MS reduction to ~700 ms

**VERDICT: REFUTED AS STATED. Reducing below 1000 ms was already tried and caused WORSE latency, not better. The env.ts comment is the authoritative record.**

From `core/src/config/env.ts`, lines 201–206:

```ts
// Raised from 500→1000 ms: a 500 ms window at 24 kHz is often too few words
// for Gemini to produce a useful clause split, so the first clause is held
// until CLAUSE_MAX_MS (2 s) fires anyway — net TTFA is worse, not better.
// 1000 ms gives the speech model ~2–4 words to work with and dramatically
// improves first-clause quality. Keep overridable for env tuning.
STT_FIRST_SEGMENT_MS: num(1000),
```

`CLAUSE_MAX_MS = 2000` (env.ts:208). This is the maximum time the clause splitter waits before forcibly emitting a clause. If the 700 ms of audio yields too few words, Gemini produces a degenerate output and the splitter holds it until `CLAUSE_MAX_MS` (2 s) fires — making total TTFA **2000 ms + TTS** instead of **1000 ms + TTS**. Reducing to 700 ms risks this exact failure mode.

The investigator's recommendation (600–700 ms) conflicts with a documented engineering decision that was made AFTER empirical testing. The comment "500 ms window at 24 kHz is often too few words" directly applies to any value in the 600–700 ms range — at 24 kHz/16-bit, 700 ms is 33.6 KB of PCM, approximately 2–3 words of speech. For fast speech this may be adequate; for slow or accented speech it produces clause-detection failures.

**What IS safe:** The env var is overridable, so a careful A/B test at 700–800 ms on live speech with real Gemini keys is the right path. This CANNOT be finalized without the §13 live smoke tests. Mark as NEED-CALIBRATION.

**The investigator's claim that STT_FIRST_SEGMENT_MS is "the single largest fixable cost" is correct in isolation — but the proposed reduction to 600–700 ms is not safe without live validation.**

---

### Claim 5: Caption prefetch always cold on first Start

**VERDICT: CONFIRMED CORRECT.**

`NavigationWatcher` is created at `src/content/index.ts:292` inside `startSession()`. It is `null` before the first session. The prefetch logic at `navigation.ts:173-180` fires only when the watcher detects a URL change after it is running.

Therefore: on the very first Start on a fresh YouTube tab in a browser session, the `NavigationWatcher` has never run, no prefetch has been triggered, and `getPrefetchedCaptions(videoId)` returns null. The full 100–400 ms caption fetch cost applies.

**Is prefetch-on-popup-open cleanly implementable?** Yes — when the popup opens on a YouTube watch page, it can send a `CONTENT_PREFETCH_CAPTIONS` message (or include this in `PREPARE_INTENT` relay) to the content script, which calls `adapter.fetchCaptions({ videoId })`. The content script already knows the adapter (via `detectAdapter`) and can get the video ID. The implementation is clean: ~15 lines in the content script message handler + 1 new message type. No background changes needed beyond routing.

**One wrinkle:** The prefetch URL interception path (`fetchCCViaIntercept`) depends on `ytCaptionCache` in the background's `webRequest` listener, which intercepts YouTube's subtitle JSON3 URL. If the page loaded BEFORE the extension was installed (the content script was injected on demand rather than statically), the webRequest may not have captured the URL. In that case the fallback path (click CC button, poll for 1800 ms) is used. Pre-fetching on popup-open doesn't fix this worst case, but it does cover the normal path where the content script was statically injected and the page loaded with the extension active.

---

### Claim 6: Are the ms estimates honest?

**VERDICT: MOSTLY HONEST — but some numbers are overstated and a key interaction is missed.**

**Confirmed accurate:**
- MV3 SW cold start: 200–1500 ms (investigator-1) / 100–600 ms (investigator-2). The range varies by hardware. On fast M-series Macs it's ~100–200 ms; on slow Windows machines or after a Chrome update it can reach 1.5 s. Both ranges are honest.
- `captureWithRetry` retries: 300 ms per retry, up to 9 s max. Realistic on paused video.
- ICE/DTLS: 70–380 ms. Realistic for Internet paths; LAN is faster.
- OpenAI TTFA: 200–800 ms. Correct for typical translation.
- Gemini LLM first-token: 600–2000 ms. Correct; this is the dominant unavoidable cost.

**Overstated or imprecise:**
- "Content script injection: 50–300 ms" — this only applies if the tab was loaded BEFORE the extension was installed or reloaded. On a fresh Chrome profile where the extension was loaded first, the content script is statically injected via manifest match and this cost is zero. Investigator-2's "50–150 ms" range is more realistic; investigator-1's upper bound of 300 ms is plausible but rare.
- `hydrateSignedIn`: 30–200 ms (investigator-1) vs 50–300 ms (investigator-2). The `hydrate-signed-in.ts` has a 300 ms debounce (`HYDRATE_DEBOUNCE_MS = 300`). It IS deduped via `hydrateInFlight` promise — but the 300 ms debounce adds fixed latency. The actual server round-trip is fast (20–50 ms typically), but the debounce itself adds 300 ms on top. Neither investigator noted this. The real first-time cost is closer to **300–500 ms** total (debounce + server RTT + settings fetch), not 30–200 ms. This is a systematic underestimate.
- `alignRealtimeVodBeforePlay`: investigator-1 claims "up to 2000 ms". Accurate for the slow path. On the typical path (OpenAI streams audio before ICE+DTLS completes, ~300–500 ms after SDP answer), this resolves in 300–500 ms. The "up to 2 s stuck on connecting" framing is accurate for the slow path only.

**Key interaction neither investigator addressed:**
The `hydrateSignedIn` call inside `session-coordinator.ts:start()` is gated on `token && !state.signedInUser`. If the SW is warm AND a prior `GET_STATE` from the popup already called `hydrateSignedIn`, then `state.signedInUser` is already populated and this is skipped. But on a cold SW start, the SW-boot path at `background/index.ts:62` ALSO calls `hydrateSignedIn` — meaning it fires both at boot AND at Start, but the `hydrateInFlight` in-flight dedup prevents double execution. So the cost is paid once (at boot), and the Start path benefits from the already-completed bootstrap. This is correct behavior; neither investigator got this exactly right.

**Unavoidable physics vs fixable (final scorecard):**

| Cost | Nature | Fixable? |
|---|---|---|
| Gemini TTFT (600–2000 ms) | Provider physics | No |
| MiniMax TTS TTFA (200–600 ms) | Provider physics | No |
| OpenAI TTFA (200–800 ms) | Provider physics | No |
| ICE/DTLS (70–380 ms) | Browser/network physics | No |
| SW cold start (100–1500 ms) | Chrome policy, workable | YES — 20 s PING |
| `hydrateSignedIn` debounce+RTT (300–500 ms) | Architecture | PARTIAL — boot-time pre-warm already in place |
| `alignRealtimeVodBeforePlay` 2000 ms ceiling | Code bug | YES — remove Math.max(.,2000) |
| STT_FIRST_SEGMENT_MS 1000 ms idle | Tunable tradeoff | NEED-CALIBRATION |
| Caption fetch cold (100–400 ms) | Architecture | YES — prefetch on popup-open |
| prepareIntent missed non-hover paths | Architecture | YES — fire on popup-open + tier-select |

---

## Final Conclusion

### Single Biggest Fixable Cost Per Tier

**Realtime tier:**
The `Math.max(alignMs, 2000) = 2000` ceiling in `alignRealtimeVodBeforePlay` (standard-vod-start.ts:32) is the clearest code bug. On the slow path it holds the video paused for up to 2 s after ICE connects, waiting for OpenAI's first audio delta. The fix (remove or reduce the hardcoded ceiling) is one line. This is the single biggest fixable per-connect cost for Realtime VOD.

**Standard-WebRTC tier:**
`STT_FIRST_SEGMENT_MS = 1000` ms idle accumulation is the biggest per-connect cost, but it CANNOT be safely reduced without live testing (see Claim 4 above). It was already increased from 500 ms because 500 ms caused worse latency. The biggest SAFE fixable cost for Standard-WebRTC is SW cold start, which adds 100–1500 ms to first connect and is entirely eliminated by a content-script keepalive ping.

**Subtitle-first (YouTube VOD) tier:**
Gemini TTFT + MiniMax TTS TTFA dominate (~800–2600 ms) and are unavoidable physics. The biggest fixable cost is SW cold start (same fix as above), followed by caption prefetch miss on first Start (100–400 ms, fixed by pre-fetching on popup-open).

---

### Prioritized Fix List

#### SAFE-NOW (implement immediately, no live keys needed):

**P1 — Remove `Math.max(alignMs, 2000)` ceiling in alignRealtimeVodBeforePlay**
- File: `src/lib/standard-vod-start.ts:32`
- Fix: `const ceiling = Math.max(alignMs, 2000)` → `const ceiling = alignMs`
- Impact: saves up to 2000 ms on the Realtime VOD slow path. Typical path: saves 0 ms (already resolves early from event).
- Risk: on paths where OpenAI hasn't sent audio when ICE completes, the video starts playing 80 ms after ICE instead of waiting up to 2 s. User may briefly hear source audio before dub starts. Acceptable UX tradeoff — better than a frozen spinner.
- Effort: 1 line.

**P2 — SW keepalive PING from content script every 20 s**
- Files: `src/content/index.ts` (add `setInterval`) + `src/shared/protocol.ts` (optional SW_PING type) + `src/background/router.ts` (add no-op handler)
- Impact: eliminates 100–1500 ms SW cold-start cost for users on YouTube/Coursera/Udemy (where content script is statically injected). Does not help on tabs loaded before extension install.
- Risk: NONE. Chrome allows this. Negligible CPU/battery.
- Effort: ~10 lines.

**P3 — Fire prepareIntent on popup-open (Realtime tier, not running)**
- File: `src/popup/index.ts` — call `maybeSendPrepareIntent()` (or a variant that bypasses the `prepareIntentSent` debounce flag) after `GET_STATE` resolves and `tier === TIER_REALTIME && !state.running`.
- Impact: pre-warms the mediasoup transport + OpenAI WS before user clicks Start, saving 100–280 ms on Realtime cold connect. No benefit to Standard beyond ~50–100 ms transport savings.
- Risk: LOW. One extra `/v1/rtc/prepare` call per popup open when Realtime is selected. The warm slot expires in 30 s if unused. Max 2 slots per user (env cap).
- Note: add same fire on `tierSelect → TIER_REALTIME` change (1 line).
- Effort: ~5 lines.

**P4 — Fire prepareIntent for auto-start registrations**
- File: `src/background/auto-start.ts` — send `CONTENT_PREPARE_INTENT` before calling `session.start({})` (with ~200 ms lead time to let the prepare complete before START relay arrives).
- Impact: auto-start users currently NEVER get pre-warm (no hover event). This gives them the warm slot.
- Risk: LOW. Same as P3.
- Effort: ~10 lines.

**P5 — Caption prefetch on popup-open (subtitle-first/YouTube only)**
- Files: `src/popup/index.ts` (send `CONTENT_PREFETCH_CAPTIONS` message after GET_STATE if on YouTube watch page + tier=Standard + no session) + `src/content/index.ts` (handle new message, call `adapter.fetchCaptions`) + `src/shared/protocol.ts` (new message type).
- Impact: saves 100–400 ms caption fetch on first Start on YouTube.
- Risk: LOW. If the user never starts, the prefetch result is discarded. The abort controller guards against stale results.
- Effort: ~20 lines across 3 files.

---

#### NEED-CALIBRATION (require live keys + §13 smoke tests before shipping):

**C1 — Reduce STT_FIRST_SEGMENT_MS below 1000 ms**
- Current value: 1000 ms (env.ts:206). Previously 500 ms — raised because 500 ms caused WORSE TTFA (CLAUSE_MAX_MS holdback).
- Proposed range: 700–800 ms.
- What can go wrong: at 700 ms + 24 kHz PCM, ~2–3 words of audio. On slow speech or pauses, Gemini produces a degenerate clause, ClauseSplitter holds it for CLAUSE_MAX_MS=2000 ms, net TTFA gets worse. This is not theoretical — it happened at 500 ms.
- Required test: §13 smoke test with real Gemini audio-in API, multiple speakers/speeds, confirming p50 TTFA improves without p95 regression.
- Do NOT ship this without live validation. The env comment is an explicit engineering caution.

---

#### RISKY / DEFER:

**D1 — Pre-create RTCPeerConnection before Start (O3)**
- Impact: ~10–20 ms PC + offer creation, 50–200 ms ICE gather head-start.
- Risk: Pre-created PCs that are never used burn ICE candidates. If network changes between pre-create and click, ICE may re-gather. Architecturally invasive.
- Verdict: DEFER. The gain is modest compared to P1–P5 and the failure modes are subtle.

**D2 — Pre-capture audio stream before Start (O4 / Standard O5)**
- Impact: 30–500 ms on `captureWithRetry` slow path.
- Risk: Browser media pipeline state may not persist; stale streams on YouTube SPA nav; architecturally invasive to AudioCapture.
- Verdict: DEFER.

**D3 — Provider TLS pre-warm at server startup**
- Impact: 50–300 ms on first call after server restart (server-process one-time cost, not per-user).
- In production the server is long-lived; Gemini and MiniMax connections are warm within minutes of startup. Near-zero incremental value for users.
- Verdict: DEFER. Low ROI.

---

### Refuted / Corrected Investigator Claims

1. **REFUTED: STT_FIRST_SEGMENT_MS reduction to 600–700 ms is safe.** The env.ts itself records that 500 ms was tried and caused worse latency (CLAUSE_MAX_MS holdback). 700 ms is in the same failure zone. This requires live calibration, not a safe env-var change.

2. **CORRECTED: alignRealtimeVodBeforePlay — "the earlier edit already made it event-driven."** Investigator-1 describes the function correctly (event-driven). What was NOT corrected by the edit: `Math.max(alignMs, 2000)` still hardcodes a 2000 ms ceiling regardless of `REALTIME_VOD_PLAY_ALIGN_MS = 80`. The comment in the file itself acknowledges this: "In practice alignMs=80 so the ceiling is 2 000 ms — same worst-case as before." The edit improved the typical-path behavior but did NOT reduce the worst-case ceiling.

3. **CORRECTED: hydrateSignedIn cost estimate too low.** Both investigators estimate 30–300 ms. The actual cost includes the `HYDRATE_DEBOUNCE_MS = 300` fixed delay before the network call fires, making the realistic first-time cost **300–500 ms** (debounce + RTT + settings bundle). However, the SW boot path at `index.ts:62` calls `hydrateSignedIn` asynchronously on every SW start — so by the time the user clicks Start, hydration may have already completed. The cost is real but not always on the critical path.

4. **CORRECTED (investigator-2): "SW keepalive risk LOW" understates one constraint.** The 5-minute max port lifetime claim is technically correct for open-port keepalives, but irrelevant to the PING approach (message-based keepalives have no 5-minute cap). The PING approach is cleaner. The statement "Chrome MV3 service workers stay alive for 30 s after the last message" is accurate.

5. **CORRECTED: The `prepareIntentSent` debounce flag does NOT deduplicate a popup-open fire from a subsequent hover fire.** They are different callsites. The result is two `/v1/rtc/prepare` calls, the second overwriting `#pendingPrepareId` with a fresh slot. Net effect: one warm slot used at click time. Acceptable.

---

### What to Implement Now vs Defer

**Implement now (in order):**
1. P1 — Remove `Math.max(alignMs, 2000)` ceiling (1 line, Realtime VOD, immediate win)
2. P2 — SW keepalive PING from content script (10 lines, all tiers, largest systemic win)
3. P3 — Fire prepareIntent on popup-open + tier-select (5 lines, Realtime only)
4. P4 — Fire prepareIntent for auto-start (10 lines, Realtime auto-start users)
5. P5 — Caption prefetch on popup-open (20 lines, YouTube Standard only)

**Calibrate with live keys before shipping:**
- C1 — STT_FIRST_SEGMENT_MS reduction. Run §13 smoke tests. If p50 TTFA improves and p95 doesn't regress, ship. Otherwise keep at 1000 ms.

**Defer:**
- D1 (pre-create PC), D2 (pre-capture audio), D3 (provider TLS pre-warm at server startup).

**Combined expected improvement (P1–P5 + C1 if passes):**
- Realtime VOD: -80–2000 ms (P1) + -100–1500 ms (SW, P2) + -100–280 ms (prepareIntent, P3)
- Standard subtitle-first: -100–1500 ms (SW, P2) + -100–400 ms (caption, P5)
- Standard WebRTC: -100–1500 ms (SW, P2) + -300–500 ms (STT if C1 passes)

Residual "connecting" after all fixes: **Realtime ~200–600 ms** (ICE+DTLS + OpenAI TTFA, unavoidable physics). **Standard SF: ~800–2600 ms** (Gemini TTFT + TTS, unavoidable physics). **Standard WebRTC: ~1400–3500 ms** (PCM accumulation + Gemini + TTS, partially reducible).
