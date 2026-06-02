# SOLUTION — Pause/Resume + Auto-Next Continuation (all tiers, all platforms)

Status: DRAFT → critic loop → human checkpoint
Repos: `extension` (primary), `server` + `core` (metering fix)
Slug: `pause-resume-autonext`

## 1. Problem & why

Today, when a user **pauses the source `<video>`** while dubbing, the extension calls
`stopSession(STOP_REASON.VIDEO_PAUSED)` — a **full teardown** (closes the peer, stops
capture, unmounts the overlay, ends the realtime session). Resuming requires the user to
hit Start again from the popup. Likewise, when a YouTube VOD **ends and auto-plays the next
video** (or the user clicks a related/next video), the session is torn down
(`VIDEO_ENDED` / `SPA_NAVIGATION`).

This is poor UX. The industry best-practice for dubbing tools is **"intelligent dubbing that
adapts to pause / seek / next in real time"** — pausing the original pauses the dub, playing
resumes it, and moving to the next video keeps dubbing going. (Sources: Murf, TransMonkey,
Immersive Translate, Vozo — see research/.)

**Desired behavior (general UX — applies to ALL tiers and ALL platforms):**
- Pause source video → **pause the dub** (no teardown, session stays alive, credits stop).
- Play again → **resume the dub** from the live point.
- Video auto-nexts / user navigates to another video on the same site → **keep the session
  alive and continue dubbing on the new video** (refetch/rebuild as needed), with a graceful
  fallback to a clean stop only when the new video genuinely cannot be dubbed.

## 2. Chosen approach (and rejected alternatives)

### 2.1 Pause/Resume — route through existing machinery (do NOT rebuild)

The pause/resume plumbing **already exists**; it is simply never reached because `onPause`
tears down first. The fix is to replace the teardown with the existing gate paths.

- **WebRTC tiers (Realtime + Standard-WebRTC):** on pause call
  `syncSourcePauseState(sm, sess, true)` (disables sender tracks, pauses `remoteAudio`,
  suspends `AudioContext`, POSTs `media-pause`). On play call `syncSourcePauseState(..., false)`
  (already wired in `onPlay`). `handleMetadataEvent` already gates on `sm.videoPaused`.
  For **Standard-WebRTC** the dub-sync must be quiesced/re-anchored or it applies a stale
  catch-up rate on resume (critic Finding 12): on pause call `standardDubSync.stop()`; on resume
  call `snapPlaybackStart()` + `start()` to re-anchor at the resume playhead.
- **Subtitle-first (YouTube VOD captions):** the 250ms `#playbackTick` and `#runRollingRenderer`
  **already idle** while `video.paused && !_systemPaused`. So on a genuine user pause we must
  ONLY (a) not tear down, (b) flip overlay/emit to the paused state. On play the driver's next
  tick resumes naturally.
- **Single source of truth for "user paused" (critic Finding 7).** Today `sm.videoPaused` is
  WebRTC-only (the metadata gate) and subtitle-first has no paused flag — two would-be sources of
  truth. Resolve by introducing **one canonical `sm.userPaused`** set true/false on BOTH paths
  (WebRTC and subtitle-first). The WebRTC metadata gate keeps reading `sm.videoPaused`, which
  `syncSourcePauseState` continues to set in lockstep with `sm.userPaused`; the subtitle-first
  idle check reads `sm.userPaused`. `_systemPaused` (driver buffering micro-pause) stays distinct
  and unaffected. Overlay/emit/timer logic keys off `sm.userPaused` only.
- The existing **ad-overlay guard** (`shouldIgnoreSourcePlaybackEvent`) still suppresses
  spurious pause/play from YouTube mid-roll ads — unchanged.

**Rejected:** building a parallel pause subsystem. The endpoints, track-gating, ctx-suspend,
and metadata gating are all present — reuse them.

### 2.2 Server metering fix (Realtime credit-burn — the one blocker)

Realtime bills via a **30s wall-clock heartbeat**: `heartbeatRealtime()` adds
`RT_HEARTBEAT_CMIN (≈50 cmin = 30s)` to `observed_cmin` on **every tick regardless of audio**
(`core/src/services/metering.service.ts:~491`). If we keep a realtime session alive while
paused, two failure modes:
- keep heartbeating → **burns credits for a paused video** (BLOCKER), or
- stop heartbeating → worker `session-cleanup` reaps the session after
  `RT_ABANDON_GRACE_SECONDS = 180s` → cannot resume (BLOCKER).

The critic confirmed there are **TWO independent accrual paths** — the heartbeat AND the
`#observedFloorTimer` + `endRealtime` settlement (which take `GREATEST`/`MAX` of
`#observedInboundMs`). Freezing only the heartbeat is INSUFFICIENT: inbound RTP (DTX
comfort-noise from a disabled track) keeps advancing `#observedInboundMs`, and the floor
`GREATEST(observed_cmin, …)` bills the paused span anyway. **The fix must gate at the inbound
source so BOTH paths freeze.**

**Fix (decouple keepalive from billing — gate at the source):**
1. **Paused heartbeat = keepalive, 0 credits — 3-FILE change (the route body is NOT parsed today).**
   The realtime heartbeat carries `paused: boolean` (extension knows `sm.userPaused`).
   - `server/src/http/routes/rtc.routes.ts` heartbeat handler — **parse the POST body**
     `{ paused?: boolean }` (it currently reads nothing) and forward it.
   - `server/src/services/session-manager.ts` — `HeartbeatInput` gains `paused?: boolean`; passes
     `intervalCmin: paused ? 0 : RT_HEARTBEAT_CMIN`.
   - `core/src/services/metering.service.ts` — `heartbeatRealtime` with `intervalCmin===0` does a
     pure keepalive: refresh `last_heartbeat_at` + Redis sentinel TTL, **0** `observed_cmin` add,
     **no** top-up reserve. Back-compat: absent flag ⇒ `RT_HEARTBEAT_CMIN` ⇒ unchanged.
2. **Gate inbound at the PEER so `#observedInboundMs` truly freezes (the real Blocker-1/3 fix).**
   In `mediasoup.peer.ts` `_onInboundRtp` (+ `mock.peer.ts` equivalent), when `_mediaPaused`,
   **drop the inbound frame** (do not decode / do not enqueue to `_pcmQueue`). With the source
   gated, `rtc-bridge.service.ts` `#meteredInbound` never advances `#observedInboundMs` during
   pause, so the `#observedFloorTimer` `GREATEST` write AND the `endRealtime` `MAX(...)` settlement
   both inherit the freeze — no paused span billed, no provider forward of silence. (Verify
   `setMediaPaused(true)` clears `_pcmQueue`; the new gate prevents refill.)

This keeps Metering **server-authoritative** and self-consistent: pausing freezes accrual at the
source, so every downstream path inherits the freeze with no per-path subtraction math.

**Reaping-race note (critic Finding 2/6):** media-pause is sent immediately but the paused flag
only rides the next ≤30s heartbeat — at most ONE post-pause billing tick (≤30s) could fire before
the flag lands. Acceptable (bounded, ≤30s). The `media-pause` route is node-local: after a server
restart it 404s (peer gone from the in-memory map). The extension MUST treat a non-`ok`
media-pause/resume response as "session lost" → drive the §2.5 recovery path (rebuild on resume or
stop with a clear message), instead of silently believing it is paused while the bridge bills.

**Rejected:** gating only the heartbeat (Finding 1/3 — floor timer still bills via `GREATEST`).
**Rejected:** a separate `/keepalive` endpoint (more surface than a flag on the existing
heartbeat). **Rejected:** extension-only with realtime keeping stop-on-pause (user chose the
server fix for consistent UX).

### 2.3 Auto-Next continuation — navigation-aware restart-in-place

Replace the blunt SPA-watcher teardown with a **navigation classifier + debounced restart** that
keeps the overlay mounted and the background session `running`. Two triggers feed one path:

- **SPA URL change** (existing 500ms href poll, kept as the cross-platform baseline; optionally
  augmented by YouTube `yt-navigate-finish` for lower latency). On change while running:
  - `adapter.isWatchUrl(newUrl)` **false** (home/search/non-video) → `stopSession(SPA_NAVIGATION)`
    (unchanged).
  - `adapter.isWatchUrl(newUrl)` **true** and `adapter.getVideoId(newUrl)` differs from the
    current one → **CONTINUE**: enter `switching` state, **debounce ~700ms** for the URL to
    settle, then `continueOnNewVideo(newVideoId)`.
- **`onEnded` (VOD finished)** → do NOT tear down immediately. Enter a **pending-next** window
  (`switching` state + an ~8s timer). If a watch-URL navigation arrives within the window, the
  SPA path continues seamlessly. If the timer fires with no navigation (true end / autoplay off /
  last in playlist) → `stopSession(VIDEO_ENDED)`.

**`continueOnNewVideo(newVideoId)` — restart-in-place (keeps overlay + bg session):**
1. Set `switching` overlay state + `emitState({ running:true, paused:false, status:"Switching…" })`.
   (CONTENT_ENDED must NOT fire; `sm.session` and `sessionStartedAt` stay set; `sm.userPaused=false`.)
2. **Evict the OLD subtitle-first driver correctly (critic Finding 5).** The rolling-renderer
   while-loop guards on `sm.session === s` (NOT `pageToken`), so bumping the token alone does NOT
   stop it. Sequence: set the old session's `stopFlag = true` AND clear its `playbackTimer` /
   stop its `currentSource`; then **build a FRESH `SubtitleFirstSession` object** (reusing the
   existing `audioCtx`/`outputGain` so no audio glitch) and assign `sm.session = newSession`
   atomically. The old renderer's next check sees `sm.session !== oldS` (or `oldS.stopFlag`) and
   exits — no double-driver race. (For WebRTC, `detachOutgoingPeer` + token bump is sufficient.)
   Bump `sm.pageToken` to invalidate other in-flight async.
3. Re-acquire the video element (`adapter.findVideo()`); wait until `readyState >= HAVE_FUTURE_DATA`,
   `currentTime > 0`, **not** an ad (`!shouldIgnoreSourcePlaybackEvent`), and playing — so capture
   never grabs ad audio or a not-yet-loaded element (critic Finding 9).
4. **Rebind `bindCommonVideoListeners` to the new element BEFORE the async caption fetch**
   (critic Finding 8) so a quick `ended` on a very short next video is never missed; an `ended`
   that arrives mid-switch feeds back into the pending-next/stop logic. If the `<video>` element
   **reference changed**, re-acquire the capture stream (it is element-bound; YouTube reuses the
   element so the stream survives — but Coursera/others may replace it). (+ rebind volume guards.)
5. Restart the tier pipeline for the new video (token-checked at every async boundary):
   - **Subtitle-first:** on the FRESH session — new `AbortController`; refetch captions for
     `newVideoId`; populate `sentences/translations`; `renderCursor=0`, `rollingInFlight=false`,
     `currentPlayingIdx=null`, `_systemPaused=false`, `_bufferWaitStartedAt=undefined`,
     `stopFlag=false`; re-read `videoTitle`; start `playbackTimer` + rolling renderer. If **no
     captions** → fallback (§2.4).
   - **Standard-WebRTC:** `detachOutgoingPeer`; re-acquire stream (if element changed);
     `buildSession()` (new `rtcSessionId`); restart `standardDubSync`.
   - **Realtime:** `/end` old session (closes billing cleanly per video); `detachOutgoingPeer`;
     re-acquire stream if element changed; `buildSession()` (new `rtcSessionId`);
     `startHeartbeat()`; reset live-text state. (Realtime is video-content-agnostic — it just
     needs audio to flow; the new session gives correct per-video billing + title.)
6. On success → `live` overlay + `emitState({ running:true, paused:false, status:"Translating" })`.
   On any failure/timeout → `stopSession(NEXT_VIDEO_LOAD_FAILED)` (never stuck on `switching`).

The existing **handover** machinery (`#requestHandoverInner`) is the proven template for a
keep-the-session peer swap; the new-video restart differs only in that it MUST re-acquire the
capture stream when the element changes (handover reuses it because the element is the same).

### 2.4 Fallbacks (graceful, never a silent hang)

- New video has **no captions** (subtitle-first) → if the platform supports `audioCapture`,
  fall back to **Standard-WebRTC** for the new video; else `stopSession(NO_CC_UNSUPPORTED)`.
- **Udemy** (DRM, `audioCapture:false`) + no captions → `stopSession(NO_CC_UNSUPPORTED)`.
- New video is a **live stream** (was VOD) → re-evaluate `capture.isLive()`; route to the
  WebRTC/live path (no subtitle-first, no SF6 pause).
- **Pre-roll ad** on the new video → wait for `!isYouTubeAdPlaying()` before starting the dub.
- **Rapid multi-navigation** (playlist skipping) → the 700ms debounce coalesces to the final
  stable URL; each restart bumps `pageToken` so stale restarts no-op.
- **Restart failure / timeout** → `stopSession(NEXT_VIDEO_LOAD_FAILED)` with a clear message
  (never leave the overlay stuck on "Switching…").
- **Generic (non-SPA) platforms** → full page reload reinjects the content script; auto-next
  continuation is a no-op there (out of scope by nature), pause/resume still applies.

### 2.5 Failure & recovery (critic Findings 4, 6, 13 — peer death during pause)

A multi-minute pause can outlive the WebRTC peer: a network blip during pause drives ICE
`disconnected` and the server's 8s `icestate:disconnected-timeout` closes the peer
(`mediasoup.peer.ts`), or a server restart drops the node-local session map (media-pause 404s).
Without handling, the overlay is stuck on `paused`/`live` with dead audio.

- **Detect peer death** via the existing DataChannel/PC close + a non-`ok` response from
  `notifyServerMediaGate` (today it `.catch(()=>{})` and ignores status — add a `res.ok` check).
  Mark the session as lost (`sm.connectionLost = true`).
- **On resume (play) of a lost session:** do not silently no-op. Attempt ONE rebuild
  (`buildSession()` with current settings, same video); on success → `live`; on failure →
  `stopSession(CONNECTION_LOST)` with the existing "Connection lost." message.
- **On media-pause/resume 404 (server restart):** treat as lost → same resume-rebuild path.
- Subtitle-first has no peer, so it is immune to this class; only the WebRTC tiers need it.

## 3. State model (no new State booleans — expressed via `paused` + `status`)

`running × { active, paused-by-video, switching }`:

| Sub-state | running | paused | overlay state | status string | popup |
|---|---|---|---|---|---|
| active | true | false | `live` (clock runs) | "Translating" | Stop btn, live |
| paused-by-video | true | true | `paused` (clock frozen) | `STATUS_PAUSED_VIDEO` | Stop btn live, status from `state.status` |
| switching-video | true | false | `switching` (NEW) | `STATUS_SWITCHING_VIDEO` | Stop btn live, status from `state.status` |
| stopped | false | false | unmounted | — | Start btn |

**Invariants:** `CONTENT_ENDED` must NOT fire during pause or switching; `sm.session` and
`sessionStartedAt` stay set; `sm.pageToken` is bumped on switching (restart) but NOT on pause.

**Session-limit timer during pause (critic Finding 10).** The 55/60-min warning+auto-stop timer
MUST be **frozen during a user pause** (otherwise a video paused at minute 55 auto-stops while the
user is away). On pause: record `pausedAt` and clear the timers; on resume: restart them shifted
by the paused duration (remaining = original deadline + paused span). The timer keeps running
during `switching` (a brief transition, and a new Realtime session resets its own clock anyway).

## 4. Interfaces / contracts (locked in Phase 3a)

### Extension — NEW files to avoid the `content/index.ts` ownership bottleneck (critic Finding 11)
`content/index.ts` is touched by pause/resume AND navigation AND continuation. Extract so parallel
build agents own non-overlapping files; `content/index.ts` becomes a thin caller/wirer:
- **NEW `content/navigation.ts`** — `class NavigationWatcher`: the URL/`yt-navigate-finish` poll,
  the `isWatchUrl`/`getVideoId` classifier, the 700ms debounce, and the `onEnded` pending-next
  (~8s) timer. Emits `{ kind: "continue", videoId } | { kind: "stop", reason }` to a callback.
- **NEW `content/auto-next.ts`** — `continueOnNewVideo(app, newVideoId)`: the restart-in-place
  orchestration (§2.3 steps 1–6), tier dispatch, fallbacks (§2.4), recovery (§2.5).
- **NEW `content/pause-controller.ts`** — `pauseSession(app)` / `resumeSession(app)`: the §2.1
  per-tier pause/resume bodies (WebRTC `syncSourcePauseState` + dub-sync stop/anchor; subtitle-first
  `userPaused`; overlay/emit; timer freeze/thaw). `onPause`/`onPlay` in `content/index.ts` call these.
- `content/index.ts` — only the thin wiring: instantiate `NavigationWatcher`, route its callback to
  `auto-next`/`stopSession`, and make `onPause`/`onPlay`/`onEnded` delegate to the controllers.

### Extension — contracts
- `pauseSession(app): void` / `resumeSession(app): void` (in `pause-controller.ts`).
- `continueOnNewVideo(app, newVideoId: string): Promise<void>` (in `auto-next.ts`).
- `NavigationWatcher.start(onEvent: (e: NavEvent) => void): void` + `stop()`.
- `SubtitleFirstPipeline.restart(settings: StartSettings, newVideoId: string): Promise<{ok:boolean; error?:string}>`
  — builds a FRESH session object reusing `audioCtx`/`outputGain` (§2.3 step 2/5), swaps `sm.session`.
- WebRTC restart reuses `buildSession()` (a thin `continueOnNewVideo` branch; no new peer API).
- `SessionManager` gains `userPaused: boolean` (canonical), `connectionLost: boolean`, and
  `pauseSessionTimer()` / `resumeSessionTimer()` (freeze/thaw, §3).
- `OverlayState` union gains `"switching"`. Elapsed clock runs for `switching`/`live`, frozen for
  `paused`.
- `product-copy.ts`: `STATUS_PAUSED_VIDEO`, `STATUS_SWITCHING_VIDEO`, `STATUS_LOADING_NEXT`.
- `stop-reasons.ts`: add `NEXT_VIDEO_LOAD_FAILED` (terminal, with message). (`SWITCHING_VIDEO` is a
  state, not a stop reason — no STOP_REASON entry.)
- `lib/rtc-media-sync.ts`: `notifyServerMediaGate` checks `res.ok` (Finding 13); resume completeness
  already present.
- popup status text reads `state.status` (not hardcoded "Paused.") so the new strings surface.

### Server / core (3-file heartbeat change + 1 peer gate)
- `server/src/http/routes/rtc.routes.ts` — heartbeat handler **parses the body** `{paused?:boolean}`
  (it reads nothing today) and forwards `paused` to the session manager.
- `server/src/services/session-manager.ts` — `HeartbeatInput` gains `paused?: boolean`; passes
  `intervalCmin: paused ? 0 : RT_HEARTBEAT_CMIN`.
- `core/src/services/metering.service.ts` — `heartbeatRealtime` with `intervalCmin===0` ⇒ keepalive
  (refresh `last_heartbeat_at` + sentinel TTL, no `observed_cmin` add, no top-up). Back-compat:
  absent ⇒ unchanged billing.
- `server/src/services/rtc/mediasoup.peer.ts` + `mock.peer.ts`: `_onInboundRtp` drops the frame
  while `_mediaPaused` ⇒ `#observedInboundMs` (in `rtc-bridge.service.ts`) cannot advance, so the
  floor timer `GREATEST` + `endRealtime` `MAX` settlement both freeze. No `rtc-bridge` change
  needed beyond confirming the freeze; no provider forward of silence.
- `media-pause`/`media-resume` routes + `setSessionMediaPaused` — unchanged in shape (idempotent,
  node-local). The 404-after-restart case is handled CLIENT-side (§2.5), not by persisting state.

## 5. Acceptance criteria (concrete, testable)

**Pause/Resume (all tiers):**
1. Realtime: pause source video → overlay shows `paused`, `STATUS_PAUSED_VIDEO`; dub audio stops;
   sender tracks disabled; `media-pause` POSTed; popup shows paused (Stop btn still live, clock
   frozen); **no CONTENT_ENDED**. Play → resumes within ~1s, overlay `live`, dub plays.
2. Standard-WebRTC: same as (1) + dub-sync re-anchors on resume (no audio truncation/overlap).
3. Subtitle-first: pause → overlay `paused`, driver idles (no new translate/TTS work, no audio);
   play → next tick resumes; no duplicate/lost cue at the resume boundary.
4. **No credit burn while paused:** Realtime paused heartbeat adds **0** `observed_cmin`
   (unit test on `heartbeatRealtime({paused:true})`); inbound metering frozen while `_mediaPaused`
   (unit test on peer/bridge). Standard-clip charges 0 for a paused span.
5. Paused realtime session is **not reaped**: `last_heartbeat_at` refreshed by the paused
   heartbeat ⇒ `listAbandoned` does not include it within the grace window.

**Auto-Next continuation:**
6. YouTube VOD subtitle-first: video ends → overlay `switching` (`STATUS_SWITCHING_VIDEO`);
   autoplay next loads → captions refetched for new videoId → dubbing continues; overlay returns
   to `live`; **no teardown / no Start required**.
7. User clicks a different watch video mid-session → same continuation (debounced).
8. Realtime: navigate to next video → old session `/end`ed, new session built, dubbing continues;
   billing is per-video (two sessions, not one inflated one).
9. Navigate to a **non-watch** page (home/search) → clean `stopSession(SPA_NAVIGATION)`.
10. New video has **no captions** → fallback to Standard-WebRTC (if `audioCapture`) or clean
    `NO_CC_UNSUPPORTED` (Udemy); overlay never stuck on `switching`.
11. Rapid multi-navigation → only the final video starts; no orphaned peers/sessions
    (pageToken guard); no leaked `playbackTimer`/AbortController.
12. `onEnded` with autoplay OFF (last in playlist, no nav within 8s) → clean
    `stopSession(VIDEO_ENDED)`.

**Gates:** `tsc --noEmit` 0 errors in extension, server, core; `vitest` green in all three;
new unit tests for the metering-paused path + the navigation classifier/debounce + the
subtitle-first restart reset.

**Robustness (from critic round 1):**
13. New-video restart evicts the old subtitle-first driver (no double-renderer): a fresh session
    object swap makes the old `sm.session===s` loop exit; verified no concurrent `#renderBatch`.
14. Realtime peer death during a long pause (ICE timeout / server restart 404) → on resume, ONE
    rebuild attempt; on failure a clean `CONNECTION_LOST` stop — never a stuck overlay.
15. Session-limit timer is frozen across a user pause (no auto-stop while paused); resumes shifted.
16. New short video that `ended`s mid-switch is not missed (listeners bound before caption fetch).
17. Capture never grabs ad/not-ready audio on the new video (readyState + currentTime + !ad gate).

## 6. Out of scope
- DRM platforms beyond current support (Netflix/Widevine).
- Cross-tab session migration.
- Non-SPA generic-platform auto-next (full reload reinjects; pause/resume still applies).

## 7. Revision log
- **REVISE 1 (critic round 1):** Addressed BLOCKERs 1/2/5 + MAJORs 3/4/6/7/8 + MINORs 9/10/11/12/13.
  Key changes: inbound metering gated at the PEER (`_onInboundRtp`) so BOTH the heartbeat AND the
  floor-timer/end-settlement accrual paths freeze; heartbeat `paused` flag is a 3-file change
  (route body IS parsed); subtitle-first restart swaps a FRESH session object (no double-driver);
  unified `sm.userPaused`; peer-death recovery (§2.5); frozen session timer; listeners-before-fetch;
  ad/ready capture gate; `content/index.ts` split into `navigation.ts` + `auto-next.ts` +
  `pause-controller.ts` for clean parallel ownership.
- **REVISE 2 (critic round 2) → DESIGN RATIFIED.** Critic verified every round-1 fix against code
  and found the **design sound**; its remaining "blockers" (F1 peer inbound gate, F2 heartbeat
  3-file thread, F4 new files/fields) are all "not yet written" — i.e. they ARE the Phase-3 build
  tasks, not design defects. Folded its 3 new MINORs into build acceptance:
  - **F3:** the `#observedFloorTimer` keeps firing during pause but, with the inbound gate, only
    re-writes the frozen value (idempotent `GREATEST`) — harmless. Optional: skip the PG write when
    the value is unchanged. Not required for correctness.
  - **F8:** dropping inbound frames at `_onInboundRtp` during pause may give a ~20ms Opus
    decode artifact on the first frame after resume (decoder state stale). Acceptable (Opus PLC
    handles it); build MAY reset the per-session decoder on `setMediaPaused(false)` if the pool
    API allows.
  - **F10:** the extension's realtime heartbeat must send `Content-Type: application/json` + a
    `{ paused }` body, and the Fastify route must parse it (no `additionalProperties:false` schema
    rejects it today since the route has no body schema). Build adds the body + parsing together.
</content>
</invoke>
