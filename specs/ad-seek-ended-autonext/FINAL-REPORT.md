# FINAL REPORT — ad-seek-ended-autonext wave

Branch: `wave/ad-seek-ended-autonext` (extension/). Uncommitted. NOT browser-verified (vitest + tsc only).

## What was wrong (4 symptoms → confirmed root causes)

- **A** `ad ENDED` → spurious `source video 'ended'` → scary `stopSession … Error: stop-trace`.
  Root: YouTube ads run in the **same `<video>`**; the ad→content src-swap fires a spurious `ended`, and `onEnded` armed the terminal window unconditionally. The teardown itself came from the background (`nav-stop → session.stop() → CONTENT_STOP`); the `Error: stop-trace` was an unconditional debug log.
- **B** auto-next restart janky / "auto-start on self-next still buggy".
  Root: the logged restart is the **hard-nav** continuation (full stop + fresh `session.start({})`); a transient non-watch URL during the ad/transition could also trip the SPA→stop fallthrough.
- **C** seek → mid-roll ad **not detected**.
  Root: `AdWatcher` seeds `#adActive` + binds its observer **once**; no seek path re-seeded it — only the 250 ms poll caught it (and a seed race could wedge it).
- **D** continuation source language wrong / "dịch tiếp khá nhau".
  Root: the pipeline passed `preferLang: targetLanguage` and `pickCaptionTrack` scored `+100` for a track whose language **== the output language** → it picked the *target* track as the *source* (vi→vi), varying per video.

## The fix (4 changes + UI)

- **A** `onEnded` gate (`index.ts`): ignore the event when an ad is active or ended within `AD_END_GRACE_MS` (1500 ms); secondary finite-duration end check. `AdWatcher.lastAdEndAt` set FIRST in `#evaluate`'s ad-end branch (before the callback that triggers the spurious `ended`). `stopSession` log de-alarmed (info; stack only for error reasons).
- **B** `nav-stop`: active-session + transient non-watch URL → **deferred stop keyed by tabId**, re-checked at `NAV_STOP_RECHECK_MS` (700 ms) via `chrome.tabs.get`; cancelled if the URL returned to a watch page or the session/tab changed. Hard-nav (`status:"loading"`) unchanged.
- **C** `AdWatcher.reseed()` (re-seed only, no observer churn) called from both seek paths (WebRTC `onSeeked` + subtitle-first `#onSeek`, before the ad gate).
- **D** explicit `sourceLanguage` setting (default `"auto"`) + popup **Source-language** dropdown ("Auto-detect" + manual). `pickCaptionTrack` now selects the original/source track (ASR +100, sourcePref +60, en +20, **avoid/target −200**, returns `null` if only the target track exists). Layer-0 captured-network guard skips entries whose `lang` OR `tlang` == the target. `targetLanguage` is local-only, so `sourceLanguage` mirrors it (no server field).

## Files changed (source)
`content/index.ts`, `content/ad-watcher.ts`, `content/pipelines/subtitle-first-pipeline.ts`, `background/nav-stop.ts`, `background/session-coordinator.ts`, `platforms/youtube/{captions,captions-fetch,adapter}.ts`, `popup/index.ts`, `entrypoints/popup/index.html`, `lib/resolve-lang-name.ts`, `shared/{types,constants,platform-ports}.ts`.

## Tests added (~65 over baseline)
`ad-watcher.test.ts` (+A4,C1,C2), `ad-boundary-ended.test.ts` (NEW A1-A3,A5), `seek-ad-reseed.test.ts` (NEW C3), `nav-stop.test.ts` (+B1-B4 +edges), `pick-caption-track.test.ts` (NEW D1,D2,D5), `captions-fetch.test.ts` (+D4,D6), `subtitle-first-ad-onseek.test.ts` (+C3), `subtitle-first-source-lang.test.ts` (NEW D7), `adapter.test.ts` (+D3), `apply-settings-live-sourcelang.test.ts` (NEW D9), `popup-source-language.test.ts` (NEW D8).

## Follow-up fix (browser smoke-test regression) — ad-pause deadlock on seek
**Symptom:** "mất tiếng luôn khi chọn 1 khoảng khác để xem tiếp" — after seeking into a point that triggered a YouTube ad, the dub went **permanently silent** (server kept generating TTS; client playback gated).
**Root cause:** `#enterAdPause` called `lifecycle.pause("ad")`, which (stack empty) issued `video.pause()`. YouTube plays the ad in the **same `<video>`** as content, so pausing froze the **ad** → it never ended → `isAdPlaying()` stayed true → `onAdEnd`/`#exitAdPause` never fired → `'ad'` reason stuck → dub silenced forever. Fix C's new prompt seek-ad detection (`reseed()`) is what began triggering this latent freeze on seek (pre-Fix-C, seek-into-ad simply wasn't detected).
**Fix:** the `'ad'` reason must **hold a pause without pausing the source `<video>`** — added `LifecycleController.holdReason(reason)` (push + emit `pauseChanged`, no `#pauseVideo`); `#enterAdPause` now uses `holdReason("ad")`. The dub is silenced purely via `effectivePaused` (the `#playbackTick` Step-2 gate / Standard corrector / metering freeze all key off it); the ad plays through and ends, then `#exitAdPause` recovers (`resume("ad")` → harmless `play()` on the already-playing element + reAnchor). Confirmed `syncSourcePauseState`/`applyVideoPauseToSession` never touch the source `<video>` (only the session media plane), so WebRTC is unaffected.
**Files:** `src/content/lifecycle.ts` (+`holdReason`), `src/content/index.ts` (`#enterAdPause`). (No version change — `ECHOLY_VERSION` left at `0.6.4-dub-e2e`; release version `package.json` = 1.0.0 untouched.)
**Tests:** `lifecycle.test.ts` (+2: holdReason no-video-pause + holdReason→resume recovery), `ad-pause-integration.test.ts` (+1: ad-start does NOT pause source `<video>`, recovers on ad-end).

## Round-2 follow-up (browser smoke-test) — explicit `sourceLanguage` was ignored
**Symptom:** after an ad, dub resumes but the SOURCE ("Original") language doesn't match the user's Source-language dropdown — "dùng giá trị default". (3 agents investigated; Agent B's wiring trace confirmed popup→storage→bg→content→pipeline propagation is CORRECT — the pipeline DOES pass `sourceLanguage`→`preferLang`. Agent B's "root cause" was a hallucination; ground-truth code read confirmed Agent C.)
**Two real root causes (caption SOURCE selection ignored the explicit choice):**
1. `pickCaptionTrack` scored ASR `+100` but an explicit `sourcePref` match only `+60` → a different-language ASR track beat the user's choice.
2. Layer-0 captured-network path (`fetchViaCapturedNetwork` (a)/(b)) returns whatever track the YouTube player itself fetched (its shown/default CC), consulting only the `avoidLang` guard — never `sourcePref` → the user's explicit source was overridden by YouTube's track.
**Fix (auto path preserved byte-for-byte; only explicit changes):**
- Thread `sourcePref` as `string | undefined` (undefined = AUTO). Adapter passes `opts.preferLang` AS-IS (no longer `?? "en"`), so the picker can tell AUTO from EXPLICIT.
- `pickCaptionTrack`: EXPLICIT match now `+300` (beats ASR `+100`); avoid is a hard `−1000`; AUTO (undefined) keeps ASR-first.
- `fetchViaCapturedNetwork` (a)/(b): when an EXPLICIT source is set, skip a captured track whose `lang` ≠ the chosen source (fall through to captionTracks/DOM/timedtext which can target it). AUTO unchanged.
**Files:** `src/platforms/youtube/{captions,captions-fetch,adapter}.ts`.
**Tests:** `pick-caption-track.test.ts` (+4: explicit-beats-ASR, auto-fallback, explicit-not-present-fallback), `captions-fetch.test.ts` (+3: layer-0 explicit-source skip/keep), `adapter.test.ts` (D3c updated: AUTO→undefined).

## Still open — Problem 1: seek-into-ad shows NO "ad-wait" state
The ad triggered by a seek isn't being detected (no `ad-wait` overlay; needs the user's DOM console capture to pin whether YouTube puts `ad-showing`/`ad-interrupting` on `#movie_player` for this ad type — Agent A's H4). NOT yet fixed.

## Gates
`npm run typecheck` = 0 errors. `npm test` = 74 files, **751 passed**, 3 skipped.

## Known limitations
- NOT browser-verified — needs a live YouTube smoke (real ad, real auto-next, real seek-into-ad, source-lang switch).
- The HTML5 `<track>` fallback (`fetchHtml5TextTrackCaptions`) honors the source preference but has no `avoidLang` exclusion (minor; YouTube path — the reported case — is fully covered).
- Whether the user's auto-next is hard-nav vs SPA was inferred from logs, not reproduced; Fix B is defensive for both.
