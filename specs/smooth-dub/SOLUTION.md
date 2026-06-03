# SOLUTION — Smooth dub: startup latency, resume A/V sync, branded loading UX

Slug: `smooth-dub`. Repos: `extension/` (primary), `server/` (optional safe wins).
Source research: `research-1..5-*.md` in this dir.

## Problem (engineering restatement of the user's complaints)

1. **Startup pause too long** — pressing Start (lồng tiếng) freezes the video for 2–5 s before any dubbed audio. Serial network work happens with the video frozen and a static UI.
2. **Resume desync** — after a pause, on resume the native video plays immediately while the dubbed audio has not arrived/caught up → video races ahead of the dub. Made permanent for Standard-WebRTC by a real bug: the drift corrector dies after the first pause.
3. **No branded loading state** — the logo is static during connect/buffer; the wait reads as a hang, not as intentional work. Unprofessional.
4. **General smoothness/perceived speed** — gaps, jerky catch-up, no buffering feedback.

## Confirmed root causes (file:line)

- **R1 (critical bug).** `lib/dub-playback-sync.ts:157` `stop()` sets `stopped=true`; `snapPlaybackStart()` (137–148) never clears it; `tick()` early-returns on `stopped` (71). After one pause/resume the Standard-WebRTC sync engine never ticks again → drift is never corrected → video drifts ahead of dub permanently. Verified by reading the file.
- **R2.** No **resume buffer gate** on ANY tier. Initial start gates correctly (`index.ts` `waitForFirstDub`, `alignRealtimeVodBeforePlay`, subtitle-first prebuffer) but `pause-controller.ts:54 resumeSession` does zero gating — it unblocks the dub asynchronously while the video is already running.
- **R3.** Realtime resume: `notifyServerMediaGate` (media-resume POST) is fire-and-forget (`rtc-media-sync.ts:93`), and `ctx.resume()` is not awaited (`rtc-media-sync.ts:53`); the server media gate reopens 50–300 ms later with no corrective gate.
- **R4.** `lib/standard-vod-start.ts:12–22` `alignRealtimeVodBeforePlay` has an unconditional ~80 ms sleep + a polling loop instead of an event-driven track-ready wait → up to ~2 s gratuitous delay on Realtime VOD start.
- **R5.** `SUBFIRST_PREBUFFER_COUNT=3` initial TTS batch is a single serial 1.5–4 s HTTP with the video frozen (`subtitle-first-pipeline.ts:195`); `DUB_TTFA_GATE_MS` cap is large.
- **R6.** Overlay logo (`.ec-dock-mark`/`.ec-panel-mark`) is static across `connecting`/`buffering`; "Acquiring audio" leaves state at `ready`; subtitle-first micro-pause only changes status text. (`overlay/template.ts`, `overlay.css`, `index.ts`.)
- **R7 (server, optional).** `gpt.dial()` and `waitConnected()` run serially (`rtc-bridge.service.ts:247`); `usagePeriodService.resolve()` runs twice per start (route + metering); tier refresh does an unconditional PG read per request (`auth.service.ts:330`).

## Chosen approach — 3 extension workstreams + 1 optional server workstream

Correctness before performance. Surgical edits + additive CSS/states; **no rewrites, no deletions, no schema/migration** → not a destructive change.

### Workstream A — Resume correctness (fixes complaint #2) — extension
- **A1.** `snapPlaybackStart()` sets `stopped = false` (and `start()` re-arms cleanly). Fixes R1. *Owner file: `lib/dub-playback-sync.ts`.*
- **A2.** **Resume buffer gate** in `pause-controller.ts resumeSession`, per tier, mirroring initial-start:
  - *Standard-WebRTC:* after `snapPlaybackStart()`, soft-hold the video (pause remoteAudio + brief `video.pause()` OR ramp `playbackRate`→0) until `waitForFirstDub(shortMs)` resolves, then `start()` + release. Add a `sm.systemResuming` guard so the internal `video.pause()`/`play()` does not re-enter `pauseSession`/`resumeSession` (mirror existing `_systemPaused`).
  - *Realtime:* `await` the media-resume gate (A3) then a short `alignRealtimeVodBeforePlay`-style track-ready wait before flipping to `live`; hold soft until inbound audio resumes.
  - *Subtitle-first:* expose `onResumeCheck()` on the pipeline; `resumeSession` calls it to fire a playback tick immediately and enter the micro-pause/buffering state if the next due cue is not buffered (instead of waiting up to 250 ms). *Owner files: `content/pause-controller.ts`, `content/pipelines/subtitle-first-pipeline.ts` (new `onResumeCheck`), `content/index.ts` (`systemResuming` guard + wiring), `content/session-manager.ts` (flag).* 
- **A3.** `await ctx.resume()` and `await` the media-gate POST in `lib/rtc-media-sync.ts`; suspend on pause / resume on play is the transport primitive ("two clocks"). *Owner file: `lib/rtc-media-sync.ts`.*

### Workstream B — Startup latency (complaint #1, perceived speed) — extension
- **B1.** Replace `alignRealtimeVodBeforePlay`'s 80 ms sleep + poll with an event-driven track-ready promise (`ontrack`/`unmute`, capped). Fixes R4. *Owner: `lib/standard-vod-start.ts`.*
- **B2.** Lower first-batch latency: `SUBFIRST_PREBUFFER_COUNT` 3→2 and reduce `DUB_TTFA_GATE_MS` cap (e.g. 14 s→8 s). Tunables only, behavior-preserving. *Owner: `shared/constants.ts`.*
- **B3.** Optimistic popup render from `chrome.storage.local` before `GET_STATE` resolves (mask SW cold start). *Owner: `popup/index.ts`.*
- **B4.** Eager caption prefetch when the platform adapter / `NavigationWatcher` detects a new YouTube video, so Start doesn't pay the caption fetch. Must be cancellable + cache-keyed by videoId; no metering/network to provider, captions only. *Owner: `content/navigation.ts` + `platforms/youtube/*` caption cache (single owner, read existing cache API).* 

### Workstream C — Branded loading UX (complaint #3, #4) — extension
- **C1.** Add a CSS-only branded animation on `.ec-dock-mark`/`.ec-panel-mark` driven by `[data-state="connecting"]` and a new `[data-state="buffering"]` (conic ring via `::after` + gentle pulse). Respect `prefers-reduced-motion`. *Owner: `overlay/overlay.css`, `overlay/template.ts` (only if a node is needed).* 
- **C2.** Add `"buffering"` to `OverlayState`; emit `connecting` earlier (at "Acquiring audio"), keep `connecting` through `waitForFirstDub`, flip to `live` only after first audio; emit `buffering` from subtitle-first micro-pause + Standard/Realtime resume gate. *Owner: `content/overlay/overlay.ts` (state type + setter), wired by A2/B callers — overlay.ts is the single owner of the state enum; callers pass the new string.*
- **C3.** Honest phase-label copy ("Connecting…" → "Preparing dub…" → "Buffering…"). *Owner: `shared/product-copy.ts`.*

### Workstream S — Server safe latency wins — server
- **S1.** `Promise.all([gpt.dial(), session.waitConnected()])` in `rtc-bridge.service.ts run()`. 
- **S2.** Thread resolved `usagePeriodBounds` from the route into `metering.reserve()` to drop the duplicate PG resolve.
- **S3.** Short TTL (e.g. 30 s) on the tier-refresh result in the session cache to avoid the per-request PG read.

### Workstream D — Pre-warm `POST /v1/rtc/prepare` (user-approved deferred) — server + extension
Full contract in `research-6-deferred-contracts.md` Contract D. Summary:
- **D-srv.** New route `POST /v1/rtc/prepare` (auth + rate-limited). Request `{ pipeline, target_language, source_language? }` → response `{ prepare_id: "pr_<ulid>", ttl_sec: 30, pipeline }`. Allocates the mediasoup transport + pre-dials the OpenAI WS into an **in-memory warm-slot registry** on `MediasoupRtcPeer` (`_warmSlots: Map`), GC'd by `setTimeout(ttl)`; the existing `_sessions.size >= _maxStreams` cap bounds abuse. New `RtcPeer` port methods `prepare()/claimWarmSlot()/answerWarm()`; `warmWs` field on `RtcBridgePlan`; `BridgeRun.run()` uses the warm WS if present, else lazy-dials (existing fallback).
- **D-meter (INVARIANT).** `metering.reserve()` STAYS on `/v1/rtc/translate` (`rtc.routes.ts:385–402`) — prepare reserves NOTHING. No quota on hover. Verified location.
- **D-claim.** `/v1/rtc/translate` accepts optional `prepare_id`; if present and live, claims the warm slot (skips dial); if missing/expired → unchanged cold path. **Back-compat: translate without `prepare_id` is byte-for-byte unchanged.**
- **D-ext.** `WebRtcPipeline.prepareIntent()` fires (fire-and-forget) on Start hover/focus; threads `prepare_id` into `buildSession()`. Any failure → silent fallback to normal translate.

### Workstream E — SSE streaming subtitle-dub + TTS (user-approved deferred) — server + extension
Full contract in Contract E. Summary:
- **E-srv.** NEW route `POST /v1/translate/subtitles/stream` (separate URL — existing buffered route untouched for back-compat). SSE `event: line` with `{ index, text, audio_b64, cue_start_ms, cue_end_ms }` emitted in order as each line's TTS completes; terminal `event: done` / `event: error`. TTS serialised per-line in the stream path to preserve order.
- **E-meter (INVARIANT).** Cost still recomputed server-side; chat leg commits after translation, TTS leg commits at end-of-stream for however many lines were **synthesised** (not merely delivered). On abort, commit only synthesised lines. Exact-once + 2-leg atomicity preserved.
- **E-tts.** `/v1/tts/speech` gains a chunked/streaming variant; extension consumes partial audio.
- **E-ext.** New async generator `renderSubtitleDubStream()` in `lib/echoly-api.ts` using `fetch()` + `ReadableStream` reader (Chrome ≥116 OK). `#renderBatch()` becomes `for await` so line 0 plays ~250 ms in. AbortController cancels mid-stream. Falls back to the buffered path if the stream route 404s/errors (back-compat with older server).

### Deferred-contract hardening (REVISE 2 — critic blockers, MUST follow)
- **D-1 (capacity, critic):** warm sessions MUST count against the SAME `_maxStreams` guard as live sessions (`mediasoup.peer.ts:816`). Either register the warm session in `_sessions` OR make the guard compare `_sessions.size + _warmSlots.size`. A separate uncounted map = transport/UDP-port exhaustion below the guard → real `answer()` starts throwing "at capacity". Non-negotiable.
- **D-2 (leak, critic):** in the `/v1/rtc/translate` claim path, if `claimWarmSlot` succeeds but `answerWarm()` then throws (→ fall through to fresh `answer()`), the catch block MUST `void warmSlot.session.close("warm_claim_failed")` before falling through — the slot was already removed from the registry and its GC timer cancelled, so nothing else will close it.
- **D-3 (scope-narrow, flag→adopt):** restrict `prepare` to `pipeline=realtime` only (the only pipeline with an eager WS worth pre-dialing); standard's MiniMax chain has no eager WS, so prepare there only saves ~50–100 ms transport-create and isn't worth the `answerWarm` complexity. Standard prepare = accepted but no-op/omitted.
- **D-4 (doc):** add one line to D noting prepare shares the EXISTING single-node media-plane assumption (same node-affinity `rt_${sessionId}` already has for heartbeat/media-pause/end per `rtc.routes.ts:132` "not active on this node"). Cross-node prepare → null claim → fresh `answer()` (graceful, no error, no mis-bill). If the API is ever scaled >1, sticky routing is required — already true today, independent of this wave.
- **E-1 (abort billing, critic):** the stream abort handler (`reply.raw.on("close")`) MUST call `metering.commit` (NOT `release`, NOT nothing) with `reservedCredits = full N-line TTS reserve` and `actualCredits = settled cost of the M lines actually synthesised`, mirroring `metering.service.ts:289–304`. `release` would refund TTS the server already rendered (free-translation hole); doing nothing leaks the Redis hold until inflight TTL. Single commit site guarded by a `committed` flag / `finally` so the close-handler vs loop-finish race is deterministic (both key `${req.requestId}:tts`, so exact-once holds, but pin which char-count wins).
- **E-2 (quota status, critic):** run the chat+TTS **reserve BEFORE `reply.raw.writeHead(200)`**. A pre-stream quota rejection MUST return a true HTTP 402 (matching the buffered route `subtitle-dub.routes.ts:157` and the extension's `if (!res.ok)` check), NOT a 200 with an SSE `error` frame. Switch to SSE framing only after the first reserve succeeds.
- **E-3 (no shared-method mutation, flag):** add a NEW ordered synth method (e.g. `#synthesizeOrdered`); leave `#synthesizeAll` (`subtitle-dub.service.ts:385`, the buffered path's parallel impl) literally untouched. Do NOT add an `ordered` flag to the shared method.
- **E-4 (abort signal, flag):** the streaming consumer MUST be created with `signal: s.abortController.signal` on EVERY batch (not just the first) so Stop mid-stream halts server synth+billing.
- **E-5 (A↔E interaction, flag) + new AC:** the streaming `#renderBatch` MUST populate `s.sentences[idx]._buffer` in strict index order so Agent A's `onResumeCheck`→`#playbackTick` "next due cue buffered?" check (`subtitle-first-pipeline.ts:~579`) behaves identically to the buffered path. See AC10.

### Workstream F — `STT_FIRST_SEGMENT_MS` tuning (user-approved deferred) — config only
- **F.** Env already exists (`core/src/config/env.ts:206`, default 1000 ms; plumbed at `audio.pipeline.ts:105`). Ship a **safer lower default candidate via `.env.example`** (recommend 750 ms, documented), NOT a hardcoded change. **The final value is gated on the §13 live smoke test** (no live keys here): if `CLAUSE_MAX_MS` fires >40% of first windows at 750 ms, fall back to 875 ms. Documented as a calibration follow-up, env left tunable.

## Interfaces / contracts (locked in Phase 3a)
- `OverlayState` union gains `"buffering"`. **The type lives in `shared/ports.ts:16`, NOT overlay.ts** — Agent C edits `ports.ts` to add `"buffering"` to the union (critic B3).
- **`overlay.ts:787–795` clock branch:** `"buffering"` MUST join the clock-RUNNING branch (treated like `"live"`/`"connecting"`/`"switching"`), so a `paused→buffering` transition restarts the elapsed clock. It must NOT fall through both branches (critic B4).
- `StandardDubPlaybackSyncHandle` unchanged externally; A1 is internal to `bindStandardDubPlaybackSync`. A1 = add `stopped = false` to `snapPlaybackStart()`. Scope note: R1 only manifests intra-session (a fresh `bind…` is created per session); `start()` already has a `timer != null` double-arm guard so no double-timer.
- New `SubtitleFirstPipeline.onResumeCheck(): void` — **no argument**; reads `this`/`sm.session` internally; idempotent; called by `resumeSession` AFTER `sm.userPaused = false`. Body: if a session is active and the next due cue is not buffered, enter the micro-pause/buffering state, else fire one `#playbackTick`.
- New `SessionManager` flag `systemResuming: boolean = false` (mirrors `_systemPaused`). **Re-entrancy contract (critic B1):** in `index.ts onPause`, guard order is `shouldIgnoreSourcePlaybackEvent → if (sm.systemResuming) return → _systemPaused guard → pauseSession`. In `resumeSession` the gate MUST: (1) set `sm.userPaused = false` and `sm.systemResuming = true` BEFORE any internal `video.pause()`; (2) run the buffer gate inside `try`; (3) `await video.play()` to release; (4) clear `sm.systemResuming = false` in a `finally` so an error/timeout path can never leave pauses permanently suppressed.
- **Resume buffer gate timeout (critic B1):** Standard-WebRTC uses `waitForFirstDub(RESUME_GATE_MS)` where `RESUME_GATE_MS` is a new small constant (≈2500 ms). On `false` (timeout) the gate releases the video anyway (soft-fail) — never an indefinite hold.
- `rtc-media-sync.syncSourcePauseState` becomes `async` and the caller (`pause-controller`) awaits it. **`notifyServerMediaGate` and `ctx.resume()` MUST be bounded (critic B2):** wrap the media-gate `fetch` in `AbortSignal.timeout(MEDIA_GATE_TIMEOUT_MS≈1500)`; on timeout/reject, proceed anyway (soft-fail, set `connectionLost` only on an explicit non-ok response as today). `ctx.resume()` awaited but also raced against a short timeout so a stuck AudioContext can't hang resume.
- `"buffering"` is emitted from WITHIN `pause-controller.ts` per-tier resume branches and from the subtitle-first micro-pause — Agent A emits it; Agent C only defines the state + CSS (critic 8f).
- **Auto-next divergence (critic 8d):** the new resume gate lives only in `resumeSession`'s normal path; the `connectionLost` recovery branch (`continueOnNewVideo`) keeps its own `buildSession`+TTFA gate and is intentionally out of scope — documented, not changed.
- **Caption prefetch (critic B4/5):** one `AbortController` per pending prefetch, aborted when videoId changes; trigger ONLY when `app.sm.session == null` (no active session) to avoid racing a running session; store parsed result in a small in-memory `Map<videoId, parsedCaptions>` (new, separate from the URL `ytCaptionCache`); fetches hit YouTube `timedtext` only (no provider, no metering).
- No server contract changes in S1–S3 (internal only).

## Acceptance criteria (concrete, testable)
1. **AC1 (R1):** After ≥2 pause/resume cycles on a Standard-WebRTC session, the drift corrector still ticks and corrects (unit test: stop→snap→start→tick measures drift, not early-return). 
2. **AC2 (resume gate):** On resume, the dub audio is flowing (`dub.currentTime` advancing / inbound audio unmuted) before the video is allowed to run at rate 1; the video does not visibly outrun the dub by >250 ms at resume (logic test on the gate; documented manual check).
3. **AC3 (Realtime resume):** media-resume POST and `ctx.resume()` are awaited before `live`; test asserts ordering.
4. **AC4 (startup):** `alignRealtimeVodBeforePlay` returns as soon as the track is ready with no fixed sleep (test: resolves on track-ready event, not on a timer); `SUBFIRST_PREBUFFER_COUNT`/`DUB_TTFA_GATE_MS` updated.
5. **AC5 (UX):** Overlay shows a branded animated loading state during connect/buffer (new `buffering` state + CSS); `prefers-reduced-motion` disables animation; state transitions: ready→connecting (on Acquiring audio)→(buffering)→live, and live↔buffering on resume gate.
6. **AC6 (no regressions):** `tsc --noEmit` 0 errors; full vitest green; existing pause/resume/auto-next tests still pass; new tests for AC1–AC4.
7. **AC7 (server, if S included):** server `tsc` 0 + vitest green; S1 ordering test; no contract change.
8. **AC8 (gate failure path, critic 8c):** a test asserts that when `waitForFirstDub`/media-gate times out, the video STILL plays (`systemResuming` cleared, no indefinite hold).
9. **AC9 (reduced-motion, critic 8a):** the new buffering/connecting `@keyframes` are disabled under the existing `@media (prefers-reduced-motion: reduce)` block (asserted by a CSS-presence test or documented manual check).
10. **AC10 (A↔E ordering):** test that the streaming `#renderBatch` writes `_buffer[idx]` in index order and that `onResumeCheck` sees the same "next due cue buffered" result as the buffered path.
11. **AC11 (D pre-warm):** translate WITHOUT `prepare_id` is byte-for-byte the cold path (test); `prepare` reserves zero quota (metering untouched); warm sessions count against `_maxStreams`; claim-fail closes the orphan slot; prepare only acts for `pipeline=realtime`.
12. **AC12 (E streaming):** buffered `/v1/translate/subtitles` route + `#synthesizeAll` unchanged (characterization test green); stream emits lines in order; pre-stream quota → HTTP 402 (not 200+error-frame); abort commits M synthesised lines exactly once; extension falls back to buffered path on stream 404.

## Non-goals / explicitly deferred
- Pre-warm/pre-connect endpoint, SSE streaming, AudioWorklet PCM ring buffer, soft-pause playbackRate ramp as the *primary* hold (we use brief hold + buffering UI; ramp optional polish), `STT_FIRST_SEGMENT_MS` tuning. Listed as follow-ups in the final report.

## File ownership (no collisions) — finalized in Phase 3a
- **Agent A (resume):** `lib/dub-playback-sync.ts`, `content/pause-controller.ts`, `lib/rtc-media-sync.ts`, `content/session-manager.ts` (add flag), `content/pipelines/subtitle-first-pipeline.ts` (add `onResumeCheck`), `content/index.ts` (systemResuming guard + resume wiring).
- **Agent B (startup):** `lib/standard-vod-start.ts`, `shared/constants.ts`, `popup/index.ts`, `content/navigation.ts` + youtube caption cache.
- **Agent C (UX):** `content/overlay/overlay.ts`, `content/overlay/overlay.css`, `content/overlay/template.ts`, `shared/product-copy.ts`, **`shared/ports.ts`** (add `"buffering"` to `OverlayState` — critic B3). Agent A imports the new state but never edits ports.ts.
- **Conflict note:** `content/index.ts` is touched by A only. overlay STATE enum owned by C; A/B callers only pass strings. If A needs to emit `buffering`, C lands the enum first (3a serialize). Resolve any residual `index.ts` overlap by giving it to Agent A exclusively.
- **Agent S (server safe wins):** `server/src/providers/rtc/rtc-bridge.service.ts` (S1 parallel dial), `server/src/.../metering.service.ts` (S2 optional bounds param), `server/src/providers/.../auth.service.ts` (S3 cache TTL). NOTE: `rtc.routes.ts` is owned by Agent D (below) — Agent S does NOT edit it; S2's call-site change in the route is folded into Agent D's edits to avoid collision.
- **Agent D (server+ext pre-warm):** server: `rtc.routes.ts` (new prepare route + optional `prepare_id` on translate + S2 call-site), `providers/rtc/mediasoup.peer.ts` (warm-slot registry + 3 methods), `providers/rtc/peer.port.ts` (port methods), `rtc-bridge.service.ts`? NO — bridge is Agent S; **D adds `warmWs` to the plan type in a shared contracts file, S consumes it.** ext: `content/pipelines/webrtc-pipeline.ts` (prepareIntent + thread prepare_id), `lib/rtc-handover.ts` if start path lives there.
  - **Collision resolve:** `rtc-bridge.service.ts` is edited by BOTH S1 (parallel dial) and D (use warmWs). → Assign `rtc-bridge.service.ts` to Agent S ONLY; D defines the `warmWs`/`RtcBridgePlan` contract in the foundation step (3a) and S implements the consumption. D owns `mediasoup.peer.ts` + `peer.port.ts` + `rtc.routes.ts`.
- **Agent E (server+ext streaming):** server: new file `server/src/http/routes/translate-stream.routes.ts` (or extend translate routes — new route only, no edit to buffered handler), `tts.service.ts` + `tts.routes.ts` (additive streaming variant), the subtitle/translate service (additive stream method). ext: `lib/echoly-api.ts` (new `renderSubtitleDubStream`), `content/pipelines/subtitle-first-pipeline.ts` (`#renderBatch` → streaming consumer). **Collision: `subtitle-first-pipeline.ts` is edited by BOTH Agent A (onResumeCheck) and Agent E (renderBatch streaming).** → serialize: Agent A lands `onResumeCheck` first in 3a-foundation as part of the locked pipeline surface, then Agent E edits `#renderBatch` only. Both touch disjoint methods; integration gate verifies.
- **Agent F (config):** `core/src/config/env.ts` (only if default change needed — prefer NOT), `server/.env.example` + `worker/.env.example` (documented candidate). Tiny.
