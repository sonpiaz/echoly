# DIAGNOSIS — Navigation / Auto-next / Caption / Lifecycle subsystem (systemic, cross-platform)

Comprehensive evidence-based review (6-agent wave) of why the SAME class of bug — "session lost / wrong
dub / no dub / frozen sub across a video transition or state change" — keeps recurring on every platform
after each platform-specific patch. **Conclusion: it is ONE architectural disease, not N separate bugs.**

## Systemic root causes (ranked)

- **RC1 — TWO independent navigation authorities with NO handshake (master root cause).** A single SPA
  URL change is acted on by BOTH the background `nav-stop.ts` (`chrome.tabs.onUpdated`, fires first) and
  the content `NavigationWatcher` (500ms `location.href` poll). Both can kill the session; neither can ask
  the other "did you survive / are you handling this." **Smoking-gun log:** `[nav] URL changed {source:poll,
  hasSession:true}` → background relays `CONTENT_STOP` → `stopSession(USER_STOP)` → `nav.stop()` kills the
  watcher → `auto-start` does a fresh `start()`. The background wins the race and destroys the in-place
  auto-next the content side was about to run.
- **RC2 — `isSupportedWatchUrl(changeInfo.url)` is not a reliable oracle for "content survived this nav."**
  The RC1 handoff (nav-stop's SPA-skip at `:107-119`) hinges on the new URL classifying as a watch URL in
  the FIRST `onUpdated` with no `status:"loading"`. Two documented behaviors break it on React-router
  platforms (Udemy/Coursera): (i) Chrome emits a **spurious `status:"loading"` on `history.pushState`**
  (Chromium issue `yOloaK3Iy5w`) → nav-stop's hard-nav branch hard-stops; (ii) React Router exposes a
  transient non-`LECTURE_RE` intermediate URL → the 700ms deferred-stop's cross-process `chrome.tabs.get()`
  can read the stale intermediate URL (IPC timing inversion). **YouTube is immune** (clean first-party
  pushState + `yt-navigate-finish` head-start) — which is why YouTube "just works" and the team wrongly
  generalized its heuristics.
- **RC3 — `start()` and `restart()` are ~84 lines of near-duplicate inline code,** so every caption/lifecycle
  fix must land twice and routinely doesn't (restart() lacks start()'s no-CC WebRTC fallback; the system-buffer
  deadlock + the 800ms retry had to be fixed in both separately; in-code comments literally say "mirrors
  restart()"). Auto-next ALWAYS runs restart() → Udemy/Coursera bite hardest.
- **RC4 — caption acquisition uses a blind fixed 800ms timer (`AUTONEXT_CAPTION_RETRY_MS`) instead of a
  platform readiness signal** (the comment calls it a band-aid). Plus the prefetch passes no `preferLang`
  (auto-next can pick the WRONG source-language track) and `fetchHtml5TextTrackCaptions` reads `track.cues`
  without activating the track.
- **RC5 — teardown relies on `pc.close()` / swap-order instead of explicit listener+timer ownership** →
  stop→start churn leaks drivers and listeners (`MaxListenersExceededWarning: 11 close listeners`). The
  **intermittent frozen subtitle** = RC1+RC3+RC5 compound: bg kills the session mid-`restart()`, the new
  driver never starts (or a leaked old `playbackTimer`/rolling-renderer writes a stale `#showCue`), overlay
  freezes on the previous line. Intermittent because it depends on microtask/IPC timing.
- **RC6 — three inconsistent supersession mechanisms** (`sm.pageToken`, `sm.session` object-identity,
  `auto-next.ts` module `activeGen`), each guarding a different subset of async paths. The lower-level
  fingerprint of RC1: no single "current session" identity.

## Cross-platform matrix

| Platform | Nav signal | pushState→spurious loading? | content survives SPA nav? | auto-advance path | captions | DRM | RCs hit |
|---|---|---|---|---|---|---|---|
| **YouTube** | `yt-navigate-finish` + poll (fastest) | clean | yes | content `continueOnNewVideo` (works) | 4-layer MAIN-world + inner 500ms retry | none | RC5, RC4 (mostly immune to RC1/RC2 → why it "just works") |
| **Udemy** | 500ms poll only | YES (+ transient non-lecture URL) | yes (but SPA-skip guard FAILS) | dual: user-click pushState vs `autoGoToNext` | api-2.0, NO inner retry, slow `resolveCourseId`; Shaka recreates `<video>` | Widevine (canCaptureAudioNow race) | **RC1+RC2 (confirmed live), RC3, RC4, RC5 — worst-served** |
| **Coursera** | 500ms poll only | same class as Udemy | yes | content `continueOnNewVideo` | `<track>.src` VTT w/ `credentials:'include'` (**latent CORS bug** — Udemy already fixed to `omit`); 3 dup helpers | none | RC1+RC2 (structural), RC3, RC4 (+ CORS risk) |
| **Generic** | 500ms poll only | `isSpa:false` (real navs = reload) | no (reload) | bg hard-nav (correct/alone) | `isWatchUrl` always true + **`subtitleFirst:true` contradicts header comment** + `fetchCaptions`→null → burns 800ms then WebRTC | none | RC4/RC5; RC1 mostly N/A |

## Recurring-fix ledger ("căn cứ" — evidence this is systemic)

Every fix over ~6 waves is a one-sided heuristic or guess-timer compensating for RC1 or RC3: (1) SPA-skip
guard, (2) deferred-stop 700ms re-check, (3) continuation-intent + 12s window, (4) `#awaitingNext` 45s
terminal-idle, (5) `knownVideo` threading, (6) 800ms retry ×2, (7) `sm.session=null` poison-clear ×2, (8)
MAIN-world cross-video-leak fix, (9) system-buffer deadlock ×2, (10) triple supersession guards, (11)
seeked-while-paused re-anchor. **The tell:** the same symptom recurs on a DIFFERENT platform after each fix,
because each patches one authority's branch or one copy of the path — never removing the other authority's
power or unifying the two paths. (The `dub-e2e` wave already named the lifecycle version: "no single owner
of pause/resume/ready." This is the same disease at the navigation/caption layer.)

## Unified-fix options

- **A — Single nav authority via explicit handshake (RC1+RC2; highest leverage).** Content is sole authority
  for SPA watch→watch; background authority only for genuine hard navs (content provably dead via `CONTENT_PING`
  / `webNavigation.onCommitted` correlation, not the unreliable URL/status oracle). Medium blast radius (touches
  the core nav decision on ALL platforms incl. healthy YouTube → must regression-smoke).
- **B — Merge start()+restart() into one `acquireCaptions`/bootstrap path with PER-PLATFORM readiness polling
  (RC3+RC4).** Replaces the blind 800ms; fixes the prefetch wrong-language + the HTML5 track-mode bug; dedups
  Coursera/html5 helpers. Medium-high (rewrites the caption critical path) but mostly mechanical.
- **C — Explicit teardown ownership + single session identity (RC5+RC6).** Per-session listener/timer teardown
  list (pc.close() doesn't free JS listeners); atomic `stopFlag`+swap; collapse the 3 supersession guards into
  one `sm.currentSessionId`; `#showCue` liveness guard. Low-medium blast radius. Makes churn SURVIVABLE.
- **D — Full reconcile (A+B+C as one feature-wave with locked contracts).** HIGH blast radius on a public
  v1.0.0 extension with no browser test runner — only via strict phasing.

## Recommended phasing (do NOT patch further; do NOT do D all-at-once)

- **Phase 0 (cheap, no checkpoint, ship now):** (i) `generic/adapter.ts` `subtitleFirst:true`→`false` (live
  object contradicts its own comment, wastes 800ms every generic start); (ii) thread `preferLang` into
  `NavigationWatcher.#startPrefetch` so auto-next stops consuming a wrong-language prefetch.
- **Phase 1 (Option C):** make churn survivable — kills the 11-listener leak + frozen-subtitle zombie driver
  regardless of why churn happens. Low blast radius. Checkpoint before merge.
- **Phase 2 (Option A):** the real nav handshake — the destructive/high-leverage step. **Checkpoint + mandatory
  live smoke on YouTube + Udemy + Coursera** (no browser test runner).
- **Phase 3 (Option B):** unify start()/restart() + readiness-based captions, AFTER A removes the mid-restart
  kills that B's polling would otherwise race.

Rationale: C makes it tolerant, A removes the cause, B removes the band-aids. B-before-A would just add
platform-specific timers racing the same un-coordinated stop.

## Live-verification facts still needed (instrument on the user's machine)
1. Does Udemy/Coursera pushState actually emit `status:"loading"` (Chromium spurious bug)? — decides RC2 path.
2. The transient intermediate-URL sequence + the renderer↔`tabs.get` IPC lag (deferred-stop window).
3. `CONTENT_PING` after a lecture nav → same content instance replies? (validates Option-A premise).
4. Shaka `<video>` recreation timing + whether `loadedmetadata`/`addtrack` fires (Option-B readiness).
5. Coursera `<track>.src` VTT CORS with `credentials:'include'` (latent bug, same as Udemy's).
6. The 11-listener leak origin: browser RTCPeerConnection/DataChannel/video vs server mediasoup `_closeCallbacks`.
7. Per-platform caption-readiness event/window (replaces the blind 800ms).
</content>
