# SOLUTION — ad-end / seek-ad / auto-next / continuation-source-lang

Slug: `ad-seek-ended-autonext` · Repo: `extension/` (TS+WXT) · Branch target: a new `wave/ad-seek-ended-autonext`

## Problem (user report, 4 symptoms)

From the console trace + the Vietnamese notes:

1. **(A) Spurious `ended` on ad-end.** Log shows `[ad] ad ENDED → resume dub` immediately followed by `[nav] source video 'ended' event fired → notifyEnded` → `[nav] video ENDED → keep watcher alive, terminal-idle window open (45000ms)`, then `[session] stopSession called` (alarming `Error: stop-trace`). The `ended` is **spurious** — it is the ad→content `<video>` src-swap firing `ended`, not the content video ending.
2. **(B) Auto-start on self-next still buggy.** After auto-advance the session is torn down (`stopSession` via a background `CONTENT_STOP`) and a brand-new session starts (`[nav] watcher STARTED` + `[ad] watcher STARTED` = a full `startSession`, not the smooth `continueOnNewVideo`).
3. **(C) Seek → mid-roll ad not detected.** Seeking to an arbitrary point that triggers a mid-roll ad: the AdWatcher does not pause the dub promptly (dub plays over the ad, metering not frozen).
4. **(D) Continuation source language wrong / inconsistent.** "dịch tiếp lỗi tiếng gốc k theo cấu hình, dịch tiếp khá nhau" — the continued dub picks the wrong SOURCE caption track and varies per video.

## Confirmed root causes (verified against code, not hypotheses)

### RC-A — `onEnded` blindly arms the terminal window on an ad-boundary `ended`
`src/content/index.ts:298` `onEnded` calls `this.nav?.notifyEnded()` unconditionally. YouTube plays ads in the **same** `<video>` element; when the ad media ends it fires `ended` before content reloads. The log's ordering (`ad ENDED` → `source video 'ended'`) is exactly this. Result: a false 45s terminal-idle window (`navigation.ts:147` `notifyEnded`). It is identity-guarded so it rarely fires a real false-stop, but it is a genuine false positive and the alarming log the user sees.

### RC-B — the real teardown is `nav-stop` → `session.stop()` → `CONTENT_STOP`, then `auto-start` fresh start
The trace's `stopSession` came from the content message handler `case "CONTENT_STOP": app.stopSession(USER_STOP)` (built content.js ~6579). The only background sender is `SessionCoordinator.stop()` (`session-coordinator.ts:306`), called by `nav-stop.ts` — either the hard-nav branch (`:68`, `status:"loading"`) or the SPA→non-watch fallthrough (`:86`). `CONTENT_ENDED` (`router.ts:87`) only clears store state — **no** stop loop. After the stop, `auto-start.ts:99` fires `session.start({})` (continuation-intent honored) → fresh `startSession` → both watchers re-STARTED. So auto-next, when it goes through the background hard-nav/transient path, is a full teardown+restart rather than the smooth content-side `continueOnNewVideo`. Two risks:
- A **transient** non-watch URL during the ad/transition would trip `nav-stop.ts:86` and tear a session that should have continued.
- The fresh `session.start({})` re-runs the start path and (with RC-D) re-derives the source language.

### RC-C — AdWatcher is not re-seeded / re-bound on seek
`AdWatcher` binds its MutationObserver and seeds `#adActive` **once** at `start()` (`ad-watcher.ts:56-71`). Neither the WebRTC `onSeeked` (`index.ts:707`, only `snapPlaybackStart()`) nor the subtitle-first `#onSeek` (`subtitle-first-pipeline.ts`) re-seeds or re-binds the watcher. A seek-triggered mid-roll is therefore only caught by the **250 ms backstop poll** (`ad-watcher.ts:71`) — up to 250 ms of dub-over-ad — and, if `#adActive` got stuck (seed race when a seek lands during a pre/mid-roll), the false→true edge may never fire at all.

### RC-D — the SOURCE caption track is selected by the TARGET (output) language
`subtitle-first-pipeline.ts:156/176/498/515` pass `preferLang: sm.settings.targetLanguage` into `adapter.fetchCaptions`. YouTube forwards it as `targetLang` → `fetchYouTubeCaptions(videoId, targetLang)` → `pickCaptionTrack(tracks, targetLang)` (`captions.ts:28`), which scores `code === targetCode` **+100**. So the *source* track is chosen to match the *output* language: when the video has a target-language track (e.g. a `vi` auto-translation), it is picked as source → `vi→vi` no-op/garbled; when it does not, it falls through to `en` (+50) or the first track. Selection therefore **varies per video** ("dịch tiếp khá nhau") and never reflects the video's actual spoken language. The timedtext fallback URL (`captions-fetch.ts:382` `targetLang || "vi"`) compounds it by requesting the source track in the target language. There is **no** `sourceLanguage` field anywhere in `Settings`/`StartSettings` (`shared/types.ts`); source is implicitly assumed `"en"` (`adapter.ts:78` `preferLang ?? "en"`, `session-coordinator.ts:265` hardcoded `"en"`).

## Chosen approach

Root-cause fixes, no new user-facing config (Symptom D uses **auto-original-track** selection, Option B — see "Decision for checkpoint"). Four targeted fixes; correctness first.

> **REVISE 1** — incorporates the critic's blockers (1,4,10) + should-fixes (2,5,6,7,8,11,12,13,15) + nits (3,16).

### Fix A — gate `onEnded` so an ad-boundary `ended` does not arm the terminal window
In `index.ts` `onEnded`, only call `notifyEnded()` for a **genuine** content end. **Primary** gate — ignore when EITHER:
- `this.ad?.adActive` is true (an ad is on), OR
- an ad ended within the last `AD_END_GRACE_MS` (≈1500 ms): `this.ad?.lastAdEndAt != null && Date.now() - this.ad.lastAdEndAt < AD_END_GRACE_MS`.

**Secondary** (independent scenario — a seek that lands at/near the end then auto-plays): also ignore when the playhead is clearly NOT at the end on a finite-duration video: `Number.isFinite(video.duration) && video.duration > 0 && video.currentTime < video.duration - VIDEO_END_EPSILON_S`. NOTE (critic #2): this guard does **not** catch the ad-boundary case — during a YouTube ad the `<video>` reports the *ad's* clock so `currentTime ≈ duration` at ad-end; the `adActive`/`lastAdEndAt` guards are what catch ad-end. Keep it only as a secondary defense, documented as such.

Dropped (critic #3): `shouldIgnoreSourcePlaybackEvent` is redundant here — it resolves to the same `isYouTubeAdPlaying()` DOM check that feeds `adActive`. Do not add it.

**Ordering requirement (critic #1, BLOCKER):** `AdWatcher.lastAdEndAt` MUST be assigned as the FIRST statement of `#evaluate()`'s true→false branch — i.e. BEFORE `this.#onAdEnd?.()` is invoked. `#onAdEnd → #exitAdPause() → lifecycle.resume("ad") → video.play()` triggers the spurious `ended` synchronously within that callback; if `lastAdEndAt` is written after the callback returns, `onEnded` reads `null` and the grace check misses. Set it first.

When ignored, log `[nav] ad-boundary 'ended' ignored (not a real video end)` and return without arming.

### Fix B — harden `nav-stop` against a transient non-watch URL (defensive; safe on genuine hard nav)
In `nav-stop.ts`, the SPA non-watch fallthrough (`:86`) must not tear down an **active** session on a transient URL that returns to a supported watch page within a short window. Add a re-check debounce:

- When `(running||connecting)` AND `status!=="loading"` (not a hard nav) AND the new URL is NOT a supported watch URL: schedule a deferred stop after `NAV_STOP_RECHECK_MS` (≈700 ms, matching the content NavigationWatcher debounce) **keyed by `tabId`** (critic #5).
- **Re-check mechanism (critic #4, BLOCKER):** at expiry, call `await chrome.tabs.get(tabId)` and read `tab.url`. Do NOT rely on a second `onUpdated` event (YouTube may not emit one). Decision at expiry:
  - `tab.url` is now a supported watch URL → **cancel** (the transient resolved back to watch; session continues).
  - `store.state.tabId !== tabId` OR `!(running||connecting)` → **cancel** (a different/ended session owns the tab now — no stale stop; critic #5).
  - otherwise (still non-watch, same active session) → `session.stop()`.
  - `chrome.tabs.get` throws (tab gone) → `session.stop()` (the tab is gone; clean up).
- Cancel any pending deferred stop for a tab when a fresh `onUpdated` for that tab arrives (new watch URL → the SPA-continue branch returns; new non-watch → reschedule).
- Hard-nav (`status:"loading"`, `:68`) is UNCHANGED — immediate stop + continuation intent (the content script is already dead).

This aligns the background stop timing with the content watcher and prevents the transient-flicker teardown. A genuine leave-context (watch→home) still stops, after a ≤700 ms delay (critic #6 — acceptable; covered by test B3). Test B6 explicitly covers watch→non-watch→watch within the window (no stop).

### Fix C — re-seed the AdWatcher on seek (re-seed ONLY; no observer churn)
Add to `AdWatcher`:
- `lastAdEndAt: number | null` — set FIRST in `#evaluate`'s true→false branch (see Fix A ordering).
- `reseed(): void` — re-read `isAdPlaying()`; if it differs from `#adActive`, update `#adActive` and fire the matching callback exactly once (same edge semantics as `#evaluate`). **Do NOT disconnect/reconnect the MutationObserver** (critic #7): R2 confirmed `#movie_player` is NOT re-created on a same-page seek, so the observer is still bound to the right node; reconnecting on every seek only opens a lost-mutation race. Observer (re)binding stays solely in `start()`/`startAdWatcher()` (SPA re-arm). `reseed()` is pure re-seed + edge-fire; idempotent when state is unchanged.

Call `app.ad?.reseed()` from BOTH seek paths:
- WebRTC: `index.ts:707` `onSeeked` (Agent 1 — owns index.ts).
- Subtitle-first: `subtitle-first-pipeline.ts` `#onSeek` (Agent 2 — owns the pipeline), BEFORE its existing `isPausedFor("ad")` gate so the gate sees fresh state.

**Side-effect note (critic #8):** `reseed()` may fire `onAdStart → #enterAdPause()` synchronously. For a subtitle-first session `#enterAdPause` only pushes the `'ad'` lifecycle reason (no server POST — that branch is WebRTC-only, `index.ts:355`), so calling it from `#onSeek` is safe and, by design, makes the subsequent `isPausedFor("ad")` gate no-op the rest of the seek handler (correct — we don't re-anchor the dub against an ad clock). The C3 test asserts this path.

The 250 ms poll stays as backstop. Net: a seek-induced ad is detected at the seek edge, not up to 250 ms later, and the stuck-`#adActive` race is eliminated.

### Fix D — explicit `sourceLanguage` setting (default `"auto"`) + original-track auto-selection
**User decision (checkpoint): Option B** — auto-fix the picker AND add a popup **Source language** selector (`"auto"` + manual). `sourceLanguage` mirrors `targetLanguage` exactly: **local `chrome.storage` only, NOT server-synced** (R6: `targetLanguage` is local; the server bundle is only `AdvancedSettings`).

**D-UI / settings plumbing (Agent 4):**
- `src/shared/types.ts` (3a foundation): add `Settings.sourceLanguage: string` + `DEFAULT_SETTINGS.sourceLanguage = "auto"`. `State`/`StartSettings`/`INITIAL_STATE` inherit via the existing spreads. `storage.ts` (`SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS)`) and `store.ts` (`loadSettings/persistSettings/snapshot/mergeFromContent` are generic) need **no** edit — the field flows automatically (R6).
- `src/popup/index.ts` + `src/entrypoints/popup/index.html`: add a **Source language** dropdown next to Target (the HTML already has static `src-flag`/`src-name` nodes ~136-140). Populate from the SAME language catalog as Target (`state.languagePicker ?? offlineLanguagePicker()`), **prepended with `["auto","Auto-detect"]`**, NO tier gate. Add `renderSourceLang()`, the change handler (sends `UPDATE_SETTINGS {sourceLanguage}`), include `sourceLanguage` in `readSettings()` + the explicit `cachePopupState` object + local-state init, and fix the hardcoded live-summary source flag (`updateLiveSummary`).
- `src/lib/resolve-lang-name.ts`: map `"auto"` → "Auto-detect".
- `src/background/session-coordinator.ts:265`: `recordLanguagePairRecent` uses the resolved source (when `!== "auto"`) instead of hardcoded `"en"`.

**D-picker / pipeline (Agent 2):** translate the setting into the picker inputs.
- `subtitle-first-pipeline.ts`: at the four `fetchCaptions` call sites (`:156/176/498/515`), replace `preferLang: settings.targetLanguage` with:
  `preferLang: (settings.sourceLanguage && settings.sourceLanguage !== "auto") ? settings.sourceLanguage : undefined` and `avoidLang: settings.targetLanguage`. So an explicit source is honored; `"auto"` lets the picker auto-detect the original track while still avoiding the target.
- `captions.ts` `pickCaptionTrack` — **precise scoring (critic #11)** for SOURCE selection. ASR is the original spoken-language track and must be PREFERRED (today it is penalized). Signature gains an `avoidLang`:
  ```
  pickCaptionTrack(tracks, sourcePref = "en", avoidLang?):
    targetCode = avoidLang?.toLowerCase().split("-")[0]
    score(t): code = lang(t)
      s = 0
      if t.kind === "asr"          s += 100   // auto-captions = ORIGINAL spoken language → best source
      if code === sourcePref       s += 60    // explicit source hint (default "en")
      if code === "en"             s += 20    // English is a safe default source
      if code === targetCode       s -= 200   // NEVER pick the output/target language as source
      return s
    best = max-by-score
    // robustness: if the best remaining track IS the target language, return null so the
    // caller falls back (audio-capture / no-CC) instead of producing target→target garbage.
    if best && lang(best) === targetCode  return null
    return best
  ```
- `captions-fetch.ts`: thread the new params through `fetchYouTubeCaptions`/`...WithSettle` (rename `targetLang` → `sourcePref` + add `avoidLang`); pass them to `pickCaptionTrack` at `:279/:355`. The timedtext fallback URL (`:382`, critic #12) must request the **source** language (default `"en"`), never the output language — directional fix for the dead last-resort path; acknowledged behavior change for non-English videos (was `lang=vi`, now `lang=en`).
- **Layer-0 captured-network guard (critic #10, BLOCKER; + critic N2):** `fetchViaCapturedNetwork` sub-layers (a)/(b) (`:256-275`) return whatever track the YouTube player itself fetched (driven by the player's CC button), bypassing `pickCaptionTrack`. Add a guard there: read BOTH the `lang` AND `tlang` query params of the captured URL (a YouTube auto-translated track URL is `...&lang=<source>&tlang=<target>`, so `langFromUrl`'s `lang`-only read MISSES auto-translations — critic N2). **Skip that captured entry** when `primarySubtag(lang) === primarySubtag(avoidLang)` OR `primarySubtag(tlang) === primarySubtag(avoidLang)`, and fall through to the next layer / `pickCaptionTrack`. Add a small `captureLangs(url): { lang, tlang }` helper (or extend `langFromUrl`). This prevents the captured path from feeding a target-language (native OR auto-translated) track as source. Sub-layer (c) already routes through `pickCaptionTrack`.
- `adapter.ts:78`: forward `opts.preferLang ?? "en"` as `sourcePref` and `opts.avoidLang` through to the fetch.
- Consistency across continuation: because source is now the video's original (ASR/original) track, the same video always selects the same source and different auto-next videos each pick their own original — eliminating "dịch tiếp khá nhau".

**Scope honesty (critic #10):** the strong acceptance (D1/D2) is asserted at the `pickCaptionTrack` unit level + the Layer-0 captured guard. When CC is off (the common dub case) selection routes through `pickCaptionTrack`; when CC is on, the captured guard keeps the source off the target language. We do NOT claim byte-identical production track selection in every YouTube edge case.

**Acceptance for D:** translating an English-spoken video to `vi`, the dub source is the English (ASR/original) track, never the `vi` track; the chosen source track for a given track-set is identical regardless of `targetLanguage`; a video whose ONLY track is a `vi` auto-translation returns `null` (→ audio-capture fallback) rather than dubbing `vi→vi`.

## Interfaces / contracts (locked before build — Phase 3a)

**Foundation step (orchestrator, before spawning build agents — closes critic #13 + N1):** the orchestrator (a) adds the `reseed()`/`lastAdEndAt` member STUBS to `ad-watcher.ts`, (b) adds the three constants to `src/shared/constants.ts`, and (c) adds `avoidLang?: string` to the shared `PlatformAdapter.fetchCaptions` opts in `src/shared/platform-ports.ts:174` (critic N1 — otherwise the pipeline's `fetchCaptions({…, avoidLang})` is an excess-property `tsc` error; this shared interface is in no build agent's ownership). Commit these so BOTH Agent 1 (fills bodies) and Agent 2 (`this.app.ad?.reseed()`, `fetchCaptions({avoidLang})`) compile from the start. Then `npm run typecheck` after each agent and at integration.

```ts
// src/content/ad-watcher.ts  (stub by orchestrator; body by Agent 1)
class AdWatcher {
  get adActive(): boolean;                 // exists
  lastAdEndAt: number | null = null;       // NEW — ms epoch of last true→false edge; set FIRST in #evaluate's else-branch
  reseed(): void;                          // NEW — re-read ad state, fire edge callback iff changed.
                                           //       NO observer disconnect/reconnect (same-page seek keeps #movie_player).
}

// src/platforms/youtube/captions.ts  (owner: Agent 2)
// Selects the ORIGINAL/source track. MUST NOT pick a track because its language === target.
function pickCaptionTrack(
  tracks: Array<{ languageCode?: string; kind?: string; baseUrl?: string }>,
  sourcePref?: string,        // default "en"; the video's spoken-language hint, NOT the target
  avoidLang?: string,         // the output/target language — penalized hard; returns null if it's the only option
): (typeof tracks)[number] | null;
```

Shared constants (Agent 1 / orchestrator → `src/shared/constants.ts`):
`AD_END_GRACE_MS = 1500`, `VIDEO_END_EPSILON_S = 1.5`, `NAV_STOP_RECHECK_MS = 700`.

### Extra scope (critic #15) — de-alarm the stop log
`index.ts:852` logs `new Error("stop-trace").stack` at `warn` for EVERY stop (incl. normal user/video-end stops) — this is the alarming line the user pasted. Change to: `console.info("[session] stopSession", { reason })` for normal reasons; retain the stack ONLY for genuine-error reasons (`SERVER_ERROR`, `CONNECTION_LOST`, `HANDOVER_FAILED`). Owner: Agent 1 (index.ts).

## File ownership (Phase 3b — NO overlaps)

**Phase 3a foundation (orchestrator, serialized first):** add to the FOUR shared files (owned ONLY by foundation — no build agent edits them):
1. `src/content/ad-watcher.ts` — `lastAdEndAt: number|null = null` + `reseed(): void {}` STUBS.
2. `src/shared/constants.ts` — `AD_END_GRACE_MS=1500`, `VIDEO_END_EPSILON_S=1.5`, `NAV_STOP_RECHECK_MS=700`.
3. `src/shared/platform-ports.ts:174` — `avoidLang?: string` on `fetchCaptions` opts (critic N1).
4. `src/shared/types.ts` — `Settings.sourceLanguage: string` + `DEFAULT_SETTINGS.sourceLanguage="auto"` (D-UI; lets Agent 2 + Agent 4 compile in parallel).

Typecheck after foundation. This unblocks parallel compilation (critic #13 + N1).

| Agent | Owns (source) | Owns (tests) | Fixes |
|---|---|---|---|
| **Agent 1 — Ad/Ended** | `src/content/ad-watcher.ts` (fill `reseed`/`lastAdEndAt` bodies), `src/content/index.ts` (onEnded gate, onSeeked reseed call, stop-log de-alarm, + add `sourceLanguage` to the `applySettingsLive` langOrVoiceChanged handover check ~:1061) | `test/content/ad-watcher.test.ts` (extend: A4,C1,C2), `test/content/ad-boundary-ended.test.ts` (new: A1,A2,A3,A5), `test/content/seek-ad-reseed.test.ts` (new: C3 WebRTC) | A, C, D-live |
| **Agent 2 — Caption source selection + pipeline seek hook** | `src/content/pipelines/subtitle-first-pipeline.ts` (sourceLanguage→preferLang/avoidLang; `#onSeek` reseed call), `src/platforms/youtube/captions.ts`, `src/platforms/youtube/captions-fetch.ts`, `src/platforms/youtube/adapter.ts` | `test/unit/pick-caption-track.test.ts` (new: D1,D2,D5), `test/platforms/youtube/adapter.test.ts` (extend: D3,D4,D6), `test/content/subtitle-first-ad-onseek.test.ts` (extend: C3 subtitle-first) | D-picker, C (pipeline hook) |
| **Agent 3 — nav-stop harden** | `src/background/nav-stop.ts` | `test/background/nav-stop.test.ts` (extend: B1,B3,B4,B6) | B |
| **Agent 4 — Source-language UI + settings** | `src/popup/index.ts`, `src/entrypoints/popup/index.html`, `src/lib/resolve-lang-name.ts`, `src/background/session-coordinator.ts` (only `recordLanguagePairRecent` :265) | `test/ui/popup-source-language.test.ts` (new: D7,D8,D9) | D-UI |

Contract dependencies (all stubbed in 3a so every agent compiles from the start): Agent 2's `#onSeek` calls `this.app.ad?.reseed()` (body by Agent 1); Agent 2 + Agent 4 read `settings.sourceLanguage` (field by 3a); Agent 2 + 3a own `avoidLang`. No shared SOURCE file is edited by two agents. `subtitle-first-ad-onseek.test.ts` is Agent 2 only; Agent 1's seek test is the new `seek-ad-reseed.test.ts`.

## Acceptance criteria (concrete, testable)

- **A1** `onEnded` with `ad.adActive===true` does NOT call `nav.notifyEnded()`.
- **A2** `onEnded` within `AD_END_GRACE_MS` of `lastAdEndAt` does NOT arm the terminal window.
- **A3** `onEnded` at genuine end (no ad, `lastAdEndAt` stale/null, `currentTime≈duration`) DOES call `notifyEnded()`. *(positive case — new test, critic #16)*
- **A4** `#evaluate` true→false sets `lastAdEndAt` BEFORE invoking `#onAdEnd` (ordering — unit asserts `lastAdEndAt!=null` synchronously after a simulated ad-end). *(critic #1)*
- **A5** `stopSession(USER_STOP|VIDEO_ENDED)` logs at `info` with no `Error` stack; error reasons keep the stack. *(critic #15)*
- **C1** `reseed()` after the ad-signal target gains `ad-showing` fires `onAdStart` exactly once (even if the observer missed it).
- **C2** `reseed()` when ad state is unchanged fires no callback (idempotent); the MutationObserver is NOT disconnected/reconnected (critic #7).
- **C3** both seek paths invoke `app.ad.reseed()` (WebRTC `onSeeked` + subtitle-first `#onSeek`); the subtitle-first path no-ops the rest of `#onSeek` once `reseed()` flips `isPausedFor("ad")` true. *(critic #8)*
- **D1** `pickCaptionTrack([{en,asr},{vi}], "en", "vi")` returns the `en` track (source≠target).
- **D2** for a FIXED track-set, `pickCaptionTrack` returns the same track regardless of the `sourcePref`/target value when the varied target is a language NOT present in the track-set (i.e. source selection is not driven by the output language). *(reworded — critic N3)*
- **D3** pipeline call sites no longer pass `targetLanguage` as the caption *source* preference (grep-clean); they pass it as `avoidLang`.
- **D4** timedtext fallback URL requests the source language (default `en`), not the target.
- **D5** `pickCaptionTrack` returns `null` when the only track is the target/avoid language (→ fallback, no `vi→vi`). *(critic #10)*
- **D6** Layer-0 captured-network guard: a captured entry whose `lang` === `avoidLang` OR whose `tlang` === `avoidLang` (auto-translated) is skipped (falls through). *(critic #10 + N2)*
- **D7** `DEFAULT_SETTINGS.sourceLanguage === "auto"`; with `sourceLanguage="auto"` the pipeline calls `fetchCaptions` with `preferLang: undefined, avoidLang: targetLanguage` (auto-detect original, avoid target).
- **D8** with an explicit `sourceLanguage` (e.g. `"en"`) the pipeline passes `preferLang: "en"` to `fetchCaptions`; the popup persists the choice (chrome.storage) and shows it; an "Auto-detect" option is offered.
- **D9** changing `sourceLanguage` mid-session triggers the live language-change path (handover / settings relay), same as `targetLanguage`.
- **B1** nav-stop: active session + a transient non-watch URL that returns to a supported watch URL within `NAV_STOP_RECHECK_MS` does NOT call `session.stop()` (re-check via `chrome.tabs.get`). *(critic #4)*
- **B2** nav-stop: a hard nav (`status:"loading"`) still stops immediately + records continuation intent (unchanged).
- **B3** nav-stop: leaving the dub context (watch→home, stays non-watch) still stops after the re-check window.
- **B4** nav-stop: the deferred stop is keyed by `tabId` and is cancelled at expiry if `store.state.tabId` changed or the session is no longer active (no stale stop). *(critic #5)*
- **Gate** `npm run typecheck` = 0 errors; `npm test` green (existing + new).

## Rejected alternatives

- **Add a user-facing source-language selector (Option A for D).** Bigger scope (popup UI + storage + server settings + propagation). Deferred; the auto-original-track fix resolves the reported bug without new config. (Offered at checkpoint.)
- **Make `notifyEnded` itself ad-aware (instead of `onEnded`).** Rejected: keeps the responsibility split; the caller (`onEnded`) has the video element + adapter context cheaply.
- **Drop the 250 ms poll in favor of reseed-only.** Rejected: the poll is the only signal for adapters with no observer target and a real backstop for observer misses.
- **Force every auto-next through content-side `continueOnNewVideo` (kill the bg fresh-start).** Rejected as too broad/risky for this wave: genuine hard navs destroy the content script, so the bg restart is required there. Fix B only stops the *transient* teardown; Fix D makes the fresh restart pick the right source.
