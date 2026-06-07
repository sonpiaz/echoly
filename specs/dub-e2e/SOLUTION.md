# SOLUTION — End-to-end dubbing quality + lifecycle standardization

Status: DRAFT → critic → human checkpoint. Repos: extension (`develop`) + server (`wave/kyma-gateway`).
Source: 5-slice research (specs/dub-e2e/research/01-04 + server specs/prod-hardening/research/05).

## 0. The unifying diagnosis

Problems 1 (auto-next), 2 (ads), 3 (start-pause) are **all manifestations of one root defect**: there is
**no single owner of the dub pause/resume/ready lifecycle**. `video.pause()/play()` is called from ≥6 sites;
"is the dub paused" is guessed from ~9 flags across 8 files; ad-pause / user-pause / system-buffer-pause all
fight over one `video.paused` bit. The user's ask ("chuẩn hóa lại") = unify this. So the backbone of this wave
is a **single pause owner with a reason-stack**; 1/2/3 plug into it; 5 (prod hygiene) is independent server work.

## ⚠️ 0a. BLOCKING pre-step — confirm the build is actually loaded (slices 1+4, critical; critic-confirmed)

The live "auto-next never fires + NO `[nav]` logs of any kind" is most likely a **stale content script**, NOT a
logic bug: `index.ts:931 if (Reflect.get(window, CONTENT_GLOBAL_KEY) === ECHOLY_VERSION) return;` early-returns
on re-injection, so the old in-page `ContentApp` (with stale code) keeps handling Starts. Reloading the extension
card does not re-inject into an open tab. `NavigationWatcher.start()` logs `[nav] watcher STARTED`
unconditionally (navigation.ts:83) → its absence ⇒ the new code never ran.
**Concrete fix:** bump `ECHOLY_VERSION` in `extension/src/shared/constants.ts` (currently "0.6.3") so the guard
admits the new injection, then **reload the YouTube TAB**. **Verification:** Start dub → `[nav] watcher STARTED`
must appear. If it does, we diagnose auto-next from real `[nav]/[session]` traces (the fix may then be much
smaller than §1 — see §1 note); if it still doesn't, the watcher genuinely isn't starting for that path.
This is the §2e checkpoint gate — do NOT build the §1 soft-end before this is resolved.

## 1. Auto-next continuation (slice 1)

**Root cause (critic-corrected — the two pipelines differ):**
- `onEnded` (index.ts:267) calls `nav.notifyEnded()` (an 8s PENDING_NEXT window), **NOT `stopSession`** — so for
  **subtitle-first** the session + watcher STAY ALIVE for 8s post-video-end; if YouTube navigates within 8s and
  `sm.session != null`, `{continue}` already fires. The real subtitle-first failures are narrower: (a) YouTube
  does NOT reliably fire `ended` on autoplay → `notifyEnded` never opens the window → only the 500ms URL poll can
  catch it (and it works *if the session is still alive*); (b) if `ended` DOES fire but the 8s timer expires
  before the URL changes, `{stop, VIDEO_ENDED}` (navigation.ts:136) tears the watcher down; (c) the idle-path
  videoId-consumption (navigation.ts:208) demotes a navigation to prefetch if the session went null first.
- For **Realtime/Standard-WebRTC**, a server `BACKEND_STOP` (or the duration-hint elapsing) can call `stopSession`
  at the boundary, genuinely killing the session+watcher before autoplay navigates.

**Fix — bifurcated, minimal-first (don't over-engineer subtitle-first):**
- **Subtitle-first (the common case): keep the watcher alive past video-end, don't auto-stop.** Replace the 8s
  `{stop, VIDEO_ENDED}` with: while still on a watch page, keep the watcher armed and the session idle; only emit
  a terminal stop after a long idle with no navigation (~45s) OR a real SPA-off-watch / USER_STOP. The 500ms URL
  poll + `yt-navigate-finish` then catch the auto-advance regardless of `ended`. This is the bulk of the fix and
  needs NO soft-end teardown rewrite — the subtitle-first session is already alive; we just stop killing it early.
- **#awaitingNext / idle-path guard.** Ensure a still-alive session emits `{continue}` and the idle branch
  (navigation.ts:208) cannot consume the videoId while the session is alive.
- **Realtime: a soft-stop branch.** Intercept `BACKEND_STOP`-at-boundary when the page is still on a watch URL →
  silence dub + overlay "switching" but DON'T null `sm.session`/`nav`; let the URL poll drive
  `webrtc.continueOnNewVideo()` (which already `/end`s the old realtime session at webrtc-pipeline.ts:502, so do
  NOT double-`/end` and do NOT leak the live slot). Coordinate with slice-5/server if the server force-closes.
- **Pause-then-dub-immediately:** silence current dub → `restart()` / `webrtc.continueOnNewVideo()` the moment
  captions are ready; PRESERVE the B4 eager prefetch (`forActiveSession:true`).
- **Ad-aware ready-poll** (auto-next.ts MAX_WAIT_MS=9000): keep waiting while `isAdPlaying` (cap ~60s) so a
  15–30s pre-roll between videos doesn't fail as NEXT_VIDEO_LOAD_FAILED.
- **Teardown-invariant guard:** the deferred subtitle-first ring-out (index.ts:721) only runs inside
  `stopSession(VIDEO_ENDED)`; the keep-alive path must `#stopCurrent(session)` to silence the ringing source
  before `restart()` reuses the AudioContext (restart already does this at subtitle-first-pipeline.ts:354).

## 2. Ads — instant pause on ad, resume on skip/end (slice 2)

**Root cause:** there is **no mid-session ad detection** (only a start gate). `shouldIgnoreSourcePlaybackEvent`
suppresses teardown on ad-boundary pause/play but **actively prevents the dub from pausing** — the dub keeps
playing over the ad. YouTube uses ONE `<video>` for ad+content, so during a mid-roll every sync key reads the
AD clock → dub mis-fires, `_played` bookkeeping corrupts, the Standard corrector rate-warps the ad, and
Realtime/Standard translate the ad and burn credits.

**Fix — event-driven AdWatcher routed through the unified pause path:**
- **New `content/ad-watcher.ts`** (mirrors NavigationWatcher; per-session, ContentApp-owned): primary signal =
  `MutationObserver` on `#movie_player` `class` (instant, same microtask YouTube flips `ad-showing`/
  `ad-interrupting`); backstop = ~250ms `isAdPlaying()` poll. Edge-detect → `onAdStart()`/`onAdEnd()` exactly
  once per transition (`#adActive` guard; ignore class churn).
- **Wire in ContentApp** parallel to nav (start in startSession, stop in stopSession). `onAdStart` →
  `pause('ad')`; `onAdEnd` → `resume('ad')` — through the SAME reason-stack pause primitive (§4) the user-pause
  path uses. So both pipelines pause (subtitle-first idles; WebRTC disables sender tracks so the ad isn't sent to
  the provider + pauses remoteAudio + suspends ctx + POSTs media-pause → **server metering freezes**), overlay
  shows ad-wait, and resume re-anchors to content `currentTime`.
- **Freeze sync across the ad:** subtitle-first `#playbackTick` early-returns while `effectivePaused`; `#onSeek`
  is a no-op while `adActive` (ad-in/ad-out seeks are not user seeks); ONE clean re-anchor at restored content
  time on ad-end. Standard corrector predicate includes `adActive`.
- **Fold the start ad-gate into the same path** so start-ad and mid-ad share one mechanism.

## 3. Dub start — minimal pause, lock-step resume, never lose line 1 (slice 3)

**Root cause:** `firstWaveStart = sentences.findIndex(s => s.start >= currentTime)` (subtitle-first-pipeline.ts:231
and :521 in restart) **excludes the cue covering currentTime** → the line you Started on is skipped and can cause
an up-to-8s buffering stall on line 1. The start freeze is one serial TTS round-trip; resume is two hops
(`play()` then a later `#playbackTick`) leaving a sub-frame play-before-sound tail. Standard-VOD freezes the
video for the FULL first-dub TTFA (8s gate).

**Fix:**
- **`firstPlayableCueAt(t)` shared helper** used by start(), restart(), and `#onSeek`: pick the cue COVERING `t`
  (replay it from its start — "no swallowed words") else the next; never returns `length` while a playable cue
  exists. **(critic GAP-7) `#onSeek`'s `_played` reset loop (subtitle-first-pipeline.ts:~893) must key off
  `coveringCue.start`, NOT `newT`** — i.e. reset `_played` for cues with `start >= coveringCue.start` (or `===`
  the covering cue) so the covering cue actually replays on a mid-cue seek-back. Changing the anchor without the
  reset loop = the covering cue stays `_played` and is skipped.
- **`#startCue(s, cue)` lock-step release (critic GAP-6 — exact sequence, do NOT start audio before `play()`):**
  after `#renderBatch` decodes line-1's buffer + the audioCtx.resume race, call `await video.play()` FIRST; on
  the play promise **resolving successfully**, `#startCue` schedules `src.start(audioCtx.currentTime)` in that
  same microtask (before the first `#playbackTick`); on `play()` **reject** (autoplay-block) do NOT start the
  source → TOAST_PRESS_PLAY. (Starting the source synchronously BEFORE `play()` would play dub over a frozen
  video = A/V desync — the exact bug we're avoiding.) The 250ms interval + onended chain take line-2+.
- **Standard-VOD:** release `video.play()` as soon as `waitForFirstDub` resolves OR a short floor elapses, then
  let `bindStandardDubPlaybackSync` ramp playbackRate to catch up (keep DUB_TTFA_GATE_MS as the absolute cap;
  leave the no-CC-live fallback ceiling untouched).
- Keep the post-play `#playbackTick` micro-pause as the only stall net (no eager resume-side micro-pause).

## 4. Unified lifecycle backbone — the full 7-state LifecycleController (slices 2 + 4) — RATIFIED by the user

**Ratified scope (user chose the maximal rewrite):** a single explicit `LifecycleController`
(`src/content/lifecycle.ts`, NEW) — the one source of truth for "what the dub is doing" and the **single owner of
`video.pause()/play()`**. Every current direct call routes through it. This is the §13-smoke-gated, high-blast-
radius "chuẩn hóa" backbone; 1/2/3 plug into it.

- **7 states + a fixed legal-edge transition table:** `idle → starting → dubbing ⇄ paused`, `dubbing → switching
  → starting` (auto-next), any non-terminal `→ stopping → stopped`. Illegal edges throw in dev / are no-ops in
  prod. `transition(to)` is the only state mutator; it emits an `enter` event.
- **Reason-stack pause** (the load-bearing invariant): `pause(reason)` pushes + calls `video.pause()` iff the
  stack was empty; `resume(reason)` pops + calls `video.play()` iff the stack becomes empty. Reasons:
  `user | ad | system-buffer | switching | connection-lost`. So ad-pause + user-pause coexist and resume only
  un-pauses when ALL clear. The controller sets a synchronous `#selfIssued` flag BEFORE every `video.pause()/play()`
  so the bound `onPause/onPlay` handlers no-op on controller-issued events (replaces the per-session `_systemPaused`
  guard).
- **`effectivePaused = stack.has('user') || stack.has('ad')`** — exposed off the controller (and re-surfaced via a
  SessionManager getter for back-compat). The subtitle-first driver gate (subtitle-first-pipeline.ts:783, reads
  `userPaused`) AND the Standard corrector closure (index.ts:173, reads `videoPaused`) both converge on it.
- **One monotonic epoch** owned by the controller collapses the three current supersession mechanisms (`pageToken`
  + auto-next `activeGen` + nav `#emitting`); `session.token` stays for the handover-safe identity check. Every
  async boundary checks `controller.epoch` instead of three different counters.
- **Event-driven subscribers (not imperative pokes):** overlay, the 60-min session timer, pause-controller/
  metering media-gate, and the dub-sync engine subscribe to controller events (`enter` / `pauseChanged` / `stop`).
  Heartbeat billing `paused` = `stack.has('user') || stack.has('ad')` (NOT `system-buffer`/`switching`).
- **Write-site migration BEFORE making them derived getters (critic GAP-4/12/13/14 — EXHAUSTIVE or the build
  breaks).** Every direct WRITE to `userPaused`/`videoPaused`/`_systemPaused` must be replaced by a
  `pause(reason)`/`resume(reason)` call first, else a read-only getter throws/`tsc`-errors. **Full write-site
  inventory (grep each; do NOT trust shorthand):**
  - `userPaused`: `index.ts:671` (stopSession → terminal `stack.clear()`); `pause-controller.ts:27`
    (→`pause('user')`), `:83,:90` (→`resume('user')`); **`auto-next.ts:59`** (switching → clear user reason).
  - `videoPaused`: `index.ts:672` (stopSession); **`rtc-media-sync.ts:108`** (`syncSourcePauseState` — the
    PRIMARY/only `videoPaused` writer for WebRTC, read by the Standard corrector at index.ts:173 — MUST be routed
    through the controller or the corrector's pause gate goes dead); **`webrtc-pipeline.ts:694`** (handover
    restore).
  - `_systemPaused` (subtitle-first; ~10 sites — `grep _systemPaused`): init `:428`, `restart()` `:451,:460,:584`,
    `#enterSystemPause` `:693`, `#resumeSystemPause` `:708`. Replace with the controller's synchronous self-issued
    guard set BEFORE `video.pause()`; `_systemPaused` on the session is REMOVED.
  - **Stage-A atomic migration files** therefore include: pause-controller.ts, session-manager.ts, index.ts,
    auto-next.ts, rtc-media-sync.ts, webrtc-pipeline.ts, subtitle-first-pipeline.ts. Done as ONE migration (not
    split across parallel agents) so no getter write is left half-wired; `tsc` is the backstop.
- **Heartbeat billing freeze** reads `paused = has('user') || has('ad')` (NOT system-buffer) — aligns the server
  media-gate with ad/user pause, NOT the transient start buffer.
- `onPause/onPlay` shrink to: if controller self-issued → return; else `pause('user')` (or the AdWatcher owns
  `'ad'`). Removes the `shouldIgnoreSourcePlaybackEvent` early-return race.
- Collapse the supersession mechanisms (pageToken + auto-next `activeGen` + nav `#emitting`) toward one epoch
  over time; this wave keeps `session.token` for the handover check and just adds the reason-stack.

## 5. Production endpoint hygiene (slice 5) — server, independent

**Root cause:** `AppError.toBody()` + `errorBody()` (core/src/errors.ts:27-34) spread `...extra` into the
response **with no isProd gate** — the single conduit through which `detail`/`cause` (raw upstream bodies,
provider names, `String(err)`) leak in prod. The global backstop (app.ts:313-321) is already correct (fixed
500), Fastify sends no x-powered-by, validation is manual — so the ONLY leaks are (a) the un-gated `extra` spread
and (b) a few provider wrappers interpolating provider/status/`String(err)` into the AppError **message**.

**Fix — central, one place:**
- In **core/src/errors.ts**: add `DEBUG_ONLY_EXTRA_KEYS = Set(['detail','cause','stack','upstream','provider',
  'raw'])` + `sanitizeExtra(extra)` that drops those keys when `isProd` (prod returns minimal `{error:{code,
  message, ...allowlisted-contract-keys}}`); dev returns full extra. Apply in BOTH `toBody()` and `errorBody()`.
  Denylist (not allowlist) so the **intentional client-contract keys survive** — the actual body keys the
  extension reads are `tier, mode, used_credits, cap_credits, resets_at, upgrade_url, retryable, field` (critic
  GAP-9: `resetsAtIso` is an internal builder option, never a body key — `resets_at` is the emitted key).
  Either import `isProd` from `@echoly/core/config` (critic GAP-8: verified NO import cycle — env.ts imports only
  zod) OR read `process.env.ENVIRONMENT==='production'` directly; both are safe.
- **Message fix** (the serializer can't sanitize the message): apply the existing log-raw-then-fixed-message
  convention to `kyma/realtime.ts`, `google-oauth.ts`, `auth-google.routes.ts:182` so messages stop naming the
  provider / echoing `String(err)`/status. (Pattern already at live.openai.ts:538.)
- Optional: drop `env` from `GET /health` in prod.

## 6. Build stages (contract-locked) + ownership

| Stage | Owner files | Depends on |
|---|---|---|
| **A — PauseController + reason-stack + effectivePaused** (the backbone) | pause-controller.ts, session-manager.ts | — (foundation) |
| **B — Auto-next soft-end** | index.ts (stopSession split + soft-end), navigation.ts (#awaitingNext + drop notifyEnded-as-trigger), auto-next.ts (ad-aware poll), stop-reasons.ts | A |
| **C — AdWatcher** | ad-watcher.ts (NEW), index.ts (wire), youtube/adapter.ts + ad-state.ts (signal target), subtitle-first-pipeline.ts (effectivePaused gate, onSeek no-op), dub-playback-sync.ts (adActive) | A |
| **D — Dub-start lock-step** | subtitle-first-pipeline.ts (firstPlayableCueAt, #startCue), index.ts (Standard-VOD release), constants.ts | A |
| **E — Prod hygiene (server/core)** | core/src/errors.ts, server kyma/realtime.ts, google-oauth.ts, auth-google.routes.ts, health.routes.ts | — (independent repo) |

**File collisions (critic GAP-11 — C and D are NOT parallel on shared files):** index.ts is touched by B, C, D;
subtitle-first-pipeline.ts by C and D. So the extension build is **strictly serial: A → B → C → D**, each gating
`tsc` before the next, on the shared files. Only **E (server/core) runs fully in parallel** (different repo).
AdWatcher's own new file (ad-watcher.ts) and the youtube adapter/ad-state files (C-only) can be drafted while B
runs, but the index.ts/subtitle-first edits integrate serially. The start ad-gate fold-in (§2) stays OPTIONAL
(critic GAP-5: the AdWatcher has no live session pre-start, so unifying it needs a pre-session limbo mode — defer;
keep the existing start ad-gate as-is for this wave).

## 7. Acceptance criteria (testable)

1. **Auto-next:** with the build confirmed loaded, letting a YouTube VOD auto-advance keeps `sm.session` alive,
   emits `[nav] URL changed`/`continue`, and dubs the next video without a manual Start. No dependence on `ended`.
2. **Ads:** an ad starting mid-session pauses the dub within one microtask (no dub over the ad), freezes server
   metering (media-pause POSTed), and resumes + re-anchors on skip/ad-end. User-pause during an ad and ad during
   a user-pause both behave correctly (resume only when both clear).
3. **Dub-start:** Starting mid-caption dubs the covering line (not skipped); line-1 audio starts in lock-step with
   `video.play()` (no play-before-sound, no dropped first line); Standard-VOD freeze is shorter.
4. **Lifecycle:** one `PauseController` owns `video.pause/play`; `effectivePaused` is the single truth; a ≥2
   pause/resume drift-corrector regression test passes.
5. **Prod hygiene:** in `ENVIRONMENT=production`, `toBody()`/`errorBody()` strip `detail`/`cause`/`stack` and
   KEEP `tier`/`used_credits`/`retryable`; in dev they keep all. Provider messages name no provider/status.
6. **Gates:** extension `tsc` 0 + vitest green; server `tsc` 0 + vitest green.

## 8. Known limitations / non-goals
- NOT doing the maximal 7-state LifecycleController rewrite this wave (reason-stack achieves the standardization
  at lower risk); noted as a future deepening.
- Live smoke (real browser, real ads/autoplay) has NOT been run — the extension changes need the §13-style live
  verification; this wave lands behind tsc+vitest gates only.
- Ad detection is YouTube-only (other adapters return no ad signal — YAGNI).
