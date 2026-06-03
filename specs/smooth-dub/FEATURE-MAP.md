# FEATURE-MAP — smooth-dub build ownership (no file appears in two BUILD-phase agents)

Branches: extension `wave/smooth-dub`, server `wave/smooth-dub`, core `wave/smooth-dub`.

## Phase 3a — FOUNDATION (serial, ONE agent, must leave tsc GREEN in all 3 repos)
Lands the cross-agent shared surface + self-contained pieces so build agents never collide:
- **ext `src/shared/ports.ts`** — add `"buffering"` to `OverlayState` union.
- **ext `src/shared/constants.ts`** — add `RESUME_GATE_MS = 2500`, `MEDIA_GATE_TIMEOUT_MS = 1500`; tune `SUBFIRST_PREBUFFER_COUNT` 3→2 and `DUB_TTFA_GATE_MS` →8000 (confirm current names/values first).
- **ext `src/content/session-manager.ts`** — add `systemResuming = false` field (mirrors `_systemPaused`).
- **ext `src/content/pipelines/subtitle-first-pipeline.ts`** — add public `onResumeCheck(): void` FULL impl (no-arg; reads `this`/`sm.session`; if active + next due cue not buffered → enter micro-pause/buffering state, else fire one `#playbackTick`). This frees Agent E to edit `#renderBatch` later in the SAME file without a concurrent collision.
- **server `RtcBridgePlan` type** — add `warmWs?` optional field (additive; the only D↔S shared type). Locate the type (providers/rtc) and add only the optional field.
- **F config** — `core/src/config/env.ts` (NO default change — leave 1000), `server/.env.example` + `worker/.env.example`: documented commented candidate `STT_FIRST_SEGMENT_MS=750` with the calibration note.
Gate: `cd extension && npm run typecheck` (or tsc --noEmit) + `cd server && npm run lint` + `cd core && npm run typecheck` all 0 errors before build agents start.

## Phase 3b — PARALLEL BUILD (6 agents, disjoint files)

### Agent A — Resume correctness (ext)
Owns: `src/content/pause-controller.ts`, `src/lib/dub-playback-sync.ts`, `src/lib/rtc-media-sync.ts`, `src/content/index.ts`.
Does NOT touch: session-manager.ts, subtitle-first-pipeline.ts (foundation did A's pieces there), constants.ts, ports.ts.
Work: A1 (`snapPlaybackStart` sets `stopped=false`), A2 resume buffer gate (systemResuming contract, per-tier, emits `"buffering"` from pause-controller branches, calls `onResumeCheck` for subtitle-first), A3 (`syncSourcePauseState` async + `notifyServerMediaGate`/`ctx.resume()` bounded by `MEDIA_GATE_TIMEOUT_MS`, soft-fail). index.ts onPause guard order + resumeSession wiring + `await syncSourcePauseState`.

### Agent B — Startup latency (ext)
Owns: `src/lib/standard-vod-start.ts`, `src/popup/index.ts`, `src/content/navigation.ts`, `src/platforms/youtube/caption-cache.ts` (+ `captions-fetch.ts`/`captions.ts` if needed for prefetch).
Work: B1 (event-driven `alignRealtimeVodBeforePlay`, kill 80ms sleep), B3 (optimistic popup from storage), B4 (caption prefetch on navigation when `sm.session==null`, 1 AbortController/prefetch, separate `Map<videoId,parsed>`). Constants already tuned by foundation.

### Agent C — Branded loading UX (ext)
Owns: `src/content/overlay/overlay.ts`, `src/content/overlay/overlay.css`, `src/content/overlay/template.ts`, `src/shared/product-copy.ts`.
Work: C1 CSS branded loading/buffering animation on `.ec-dock-mark`/`.ec-panel-mark` driven by `[data-state="connecting"|"buffering"]`, reduced-motion block. C2 in overlay.ts: `"buffering"` joins the clock-RUNNING branch (line ~787), `setOverlayState` accepts it, emit `connecting` earlier. C3 copy. (ports.ts already has the union member from foundation.)

### Agent D — Pre-warm prepare (server + ext)
Owns server: `src/http/routes/rtc.routes.ts` (new `POST /v1/rtc/prepare` + optional `prepare_id` on translate + populate `plan.warmWs` + fold S2 reserve-bounds call-site), `src/providers/rtc/mediasoup.peer.ts` (warm-slot registry + `prepare()/claimWarmSlot()/answerWarm()` + capacity count incl warm + close-on-claim-fail), `src/providers/rtc/peer.port.ts` (interface methods), the MOCK peer impl of the new methods (find it — `RTC_PEER_IMPL=mock`). Owns ext: `src/content/pipelines/webrtc-pipeline.ts` (`prepareIntent()` on hover + thread `prepare_id`), `src/lib/rtc-handover.ts` if the start request is built there. Realtime-only (D-3). Does NOT touch rtc-bridge.service.ts (S) or session-manager.ts (foundation/A).

### Agent S — Safe server wins (server + core)
Owns: `src/providers/rtc/rtc-bridge.service.ts` (S1 `Promise.all([gpt.dial(), waitConnected()])`; consume `plan.warmWs ?? dial`), the Metering service file (S2 add OPTIONAL `usagePeriodBounds` param to `reserve()` — core `services/` or wherever it lives), `src/.../auth.service.ts` (S3 tier-refresh cache TTL ~30s). Does NOT edit rtc.routes.ts (D folds the S2 call-site).

### Agent E — SSE streaming (server + ext)
Owns server: new streaming route file (e.g. `src/http/routes/translate-stream.routes.ts`) registered alongside existing, `src/.../subtitle-dub.service.ts` (NEW `#synthesizeOrdered` — leave `#synthesizeAll` untouched), `src/.../tts.service.ts` + `tts.routes.ts` (additive streaming variant), the translate service stream method. Owns ext: `src/lib/echoly-api.ts` (`renderSubtitleDubStream` async generator, fallback to buffered on 404), `src/content/pipelines/subtitle-first-pipeline.ts` (`#renderBatch` → streaming consumer, `_buffer[idx]` in index order, signal threaded every batch). Reserve BEFORE writeHead(200) (E-2); abort commits M lines once (E-1). Does NOT touch the buffered `subtitle-dub.routes.ts` handler.

## Same-file serializations (sequenced via foundation; NO concurrent build collision)
- `subtitle-first-pipeline.ts`: foundation lands `onResumeCheck`; build-phase only E edits it (`#renderBatch`). ✓
- `rtc-bridge.service.ts`: only S (build). D provides `warmWs?` via foundation type. ✓
- `rtc.routes.ts`: only D (build); S2 call-site folded into D. ✓

## Gates
After 3b: integration agent runs `extension: npm run typecheck && npm test`, `server: npm run lint && npm test`, `core: npm run typecheck && npm test`. All green before audit.
