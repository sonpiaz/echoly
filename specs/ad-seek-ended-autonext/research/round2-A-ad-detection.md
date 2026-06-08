# Round 2 — Agent A: Seek → Ad-Detection → Ad-Wait Overlay Path

Branch: `wave/ad-seek-ended-autonext`. Read-only investigation.

Reported symptom: user seeks during a Standard/subtitle-first YouTube VOD session → a mid-roll ad fires → no "ad-wait" overlay appears, dub keeps playing over the ad.

---

## Code path traced

### Entry points

1. **subtitle-first seek path** (`subtitle-first-pipeline.ts:295-296`, `606-607`)
   Both `start()` and `restart()` bind `onSeeked = () => this.#onSeek(newSession, video)` and pass it to `app.bindCommonVideoListeners(…, { onSeeked })`.

2. **`bindCommonVideoListeners` → `bindSourceVideoPlayback`** (`rtc-media-sync.ts:22`)
   Conditionally adds `video.addEventListener("seeked", handlers.onSeeked)`.
   So the `seeked` event from the `<video>` element DOES reach `#onSeek` for subtitle-first sessions.

3. **`#onSeek` → `this.app.ad?.reseed()`** (`subtitle-first-pipeline.ts:1059`)
   `reseed()` simply calls `this.#evaluate()` (`ad-watcher.ts:113`).

4. **`#evaluate()`** (`ad-watcher.ts:128-144`)
   Reads `this.#isAdPlaying()` → `adapter.isAdPlaying()` → `isYouTubeAdPlaying()` → `hasYouTubeAdClass(document.getElementById("movie_player"))` (`ad-state.ts:29-31`).
   If state flipped: fires `#onAdStart?.()` → `#enterAdPause()`.

5. **`#enterAdPause()`** (`index.ts:396-420`)
   Calls `this.lifecycle.holdReason("ad")` then `overlay.setOverlayState("ad-wait")` / `emitState({paused:true, status:STATUS_AD_WAIT})`.

All the wiring is present. The question is WHY the overlay still does not appear.

---

## Ranked root-cause hypotheses

### H1 — TIMING: `#movie_player` does NOT have `ad-showing` at the `seeked` instant [MOST LIKELY]

**Evidence and reasoning:**

YouTube mid-rolls triggered by a seek follow this sequence:
1. `seeking` fires → `seeked` fires → YouTube's player JS processes the seek request server-side.
2. YouTube's ad-decision network round-trip: typically **500ms–2000ms** after the `seeked` event.
3. Only after the ad-decision returns does YouTube: load the ad creative, swap the `<video>` src, and **add `ad-showing`/`ad-interrupting` to `#movie_player.classList`**.

So at the exact moment `seeked` fires and `reseed()` calls `#evaluate()`:
- `isYouTubeAdPlaying()` queries `#movie_player.classList` → **`ad-showing` is NOT yet present** → returns `false`.
- `#adActive` is already `false` (no ad was on before the seek) → `now === this.#adActive` → **`#evaluate` returns immediately with no callback**.

Detection then falls back to the TWO backstop mechanisms:

**MutationObserver** (`ad-watcher.ts:70-71`): observes `#movie_player`'s `class` attribute. This SHOULD catch the ad class appearing later. Key question: does `#movie_player` survive a seek?

`getYouTubeAdSignalTarget()` returns `document.getElementById("movie_player")`. On a same-page seek (SPA navigation within the same video) `#movie_player` is NOT re-created — the element persists. The MutationObserver binding from `start()` remains live on the same node. So if `ad-showing` is added to `#movie_player.classList` 1s after the seek, the observer SHOULD fire `#evaluate()` → `#adActive` flips true → `#enterAdPause()` → overlay = `"ad-wait"`.

**250ms poll** (`ad-watcher.ts:75`): independently calls `#evaluate()` every 250ms. Also catches the flip.

**So H1 alone should NOT fully explain the missing overlay** — unless one of the following is also true.

### H2 — RE-SEED RACE: `startAdWatcher()` fires mid-ad, seeding `#adActive = true`, killing the edge [SECOND MOST LIKELY]

**Evidence:**

`startAdWatcher()` is called from three places:
- `startSession()` at line 571 (after the initial ad-gate poll).
- `continueOnNewVideo` / `auto-next.ts:229` (re-arm after auto-next).
- `startSession()` is also called on a fresh session start.

The critical scenario: user seeks → ad starts ~1s later → the MutationObserver (or 250ms poll) fires `#evaluate()` → `#onAdStart` → `#enterAdPause()` is beginning to run. But is there ANY re-arm of the AdWatcher between the seek and the ad appearing?

**Possible re-arm paths during this window:**

The subtitle-first pipeline does NOT call `startAdWatcher()` itself — only the app-level `startSession()` and `continueOnNewVideo` do. During a mid-session seek there is no `startSession()` or `continueOnNewVideo` — the session continues. So **H2 is not triggered by a plain seek on the same video**. It would only apply if the seek somehow triggered a `continueOnNewVideo` (different video ID) — unlikely for a within-video seek.

**However**: there IS a subtle re-arm race if a seek causes a transient URL change (YouTube sometimes pushes a `?t=NNN` query param) that the `NavigationWatcher` interprets as a new video — but that would have been diagnosed separately.

For a plain within-video seek, H2 is LOW likelihood.

### H3 — `#enterAdPause` runs but overlay is immediately overwritten [MEDIUM-LOW LIKELIHOOD]

**Evidence:**

`#enterAdPause()` (`index.ts:396-420`) calls:
```
this.lifecycle.holdReason("ad")
overlay.setOverlayState("ad-wait")
sm.emitState({ running: true, paused: true, status: STATUS_AD_WAIT })
```

The subtitle-first `#playbackTick` step-2 gate keys on `lifecycle.effectivePaused`. Since `holdReason("ad")` adds `'ad'` to the reason stack, `effectivePaused === true` → the tick gate should quiesce.

But `#onSeek` continues AFTER `reseed()` at line 1060 — it calls `#firstPlayableCueAt`, resets `_played` flags, resets `renderCursor`, calls `#stopCurrent`, and immediately calls `#playbackTick(s)` (line 1089).

**THE KEY ISSUE:** `#onSeek` checks `this.app.lifecycle.isPausedFor("ad")` at line 1060 AFTER calling `reseed()`. If `reseed()` synchronously fires `onAdStart → #enterAdPause → holdReason("ad")`, then `isPausedFor("ad")` is `true` at line 1060 and `#onSeek` returns early — so `#playbackTick` is NOT called. This is the documented "correct" behavior per the code comment.

BUT: this only works if `reseed()` fires synchronously — i.e., `ad-showing` is ALREADY on `#movie_player` at the `seeked` moment. Because of H1 (timing), it is NOT. So for a seek-induced mid-roll, `reseed()` is a no-op, `#onSeek` runs to completion including `#playbackTick`, and then ~500ms–2s later the observer/poll fires `#enterAdPause`.

When the observer fires `#enterAdPause` AFTER `#onSeek` has already completed, the overlay correctly sets `"ad-wait"`. So H3 (tick overwriting) is NOT the blocker — the overlay should appear ~500–2000ms after the seek, not "never".

This means the user report of "KHÔNG thấy trạng thái 'đợi ads'" suggests the overlay NEVER appears, which points to either:
- The MutationObserver is NOT firing (H4), or
- `#enterAdPause()` is short-circuiting (H5 below), or
- The `ad` field (`this.app.ad`) is `null` when the observer fires.

### H4 — `#movie_player` uses a different element / class for seek-triggered ads [MEDIUM LIKELIHOOD]

**Evidence:**

`isYouTubeAdPlaying()` checks `document.getElementById("movie_player")` for classes `"ad-showing"` or `"ad-interrupting"` (`ad-state.ts:16-31`).

For **autoplay/preroll ads**, YouTube adds these classes to `#movie_player`. For **seek-triggered mid-roll ads**, YouTube may use a different signaling path:
- Some YouTube layouts (e.g., the theater/full-screen mode or newer player versions) add ad classes to a **nested player element** or use `ytp-ad-player-overlay` visibility rather than `#movie_player` classes.
- A seek-induced mid-roll sometimes loads in a **separate ad player container** (`#movie_player` is replaced temporarily or a child element `#player-container` or `ytd-player` gets the class instead).
- The element with `id="movie_player"` may not have an `ad-showing` class if the ad is rendered via a different slot mechanism (bumper ads, non-skippable mid-rolls, etc.).

If `ad-showing` never lands on `#movie_player` during a seek-triggered mid-roll, then `isYouTubeAdPlaying()` always returns `false`, the observer never fires a meaningful callback, and `#evaluate()` never transitions `#adActive` to `true` → `#enterAdPause` never runs → overlay never shows.

**This is the most likely complete explanation** when combined with H1 — the timing gap means `reseed()` is a no-op, AND if YouTube's seek-triggered ad does not set `ad-showing` on `#movie_player` (or sets it on a different element), both the observer AND the 250ms poll stay silent.

### H5 — `this.app.ad` is null when the observer/poll fires [LOW LIKELIHOOD]

`#enterAdPause()` is called via `this.#onAdStart?.()` inside `#evaluate()`. The `#onAdStart` callback is set in `start()` and cleared in `stop()`. If `stopAdWatcher()` is called between the seek and the ad appearing, `this.ad` becomes null and the observer has been disconnected. `stopAdWatcher()` is called from `stopSession()` — but no stop is happening here. LOW likelihood for a plain seek.

---

## Most likely root cause

**H4 (wrong DOM signal for seek-triggered mid-rolls) combined with H1 (timing).**

- H1: `reseed()` at `seeked` is always a no-op for seek-induced ads (YouTube adds `ad-showing` 500ms–2s later).
- H4: YouTube's seek-triggered mid-roll may not add `ad-showing`/`ad-interrupting` to `#movie_player` at all — it may use a different DOM path (`ytd-player`, `#movie_player-container`, or the ad overlay visibility mechanism), causing both the MutationObserver and the 250ms poll to remain silent permanently.

If H4 is true, Fix C's `reseed()` approach is fundamentally broken for seek-triggered ads regardless of timing — the signal source (`#movie_player` classes) is wrong for this ad variant.

---

## Fix options

### Option 1 — Broaden the ad-signal query (targets multiple elements + classes)

In `isYouTubeAdPlaying()` (`ad-state.ts`), additionally check:
- `document.querySelector(".ad-showing")` — matches the class on ANY element (not just `#movie_player`).
- `document.querySelector("ytd-player[ad-active]")` or visibility of `.ytp-ad-player-overlay`.
- The `<video>` `src` change: when a seek-induced ad loads, the `<video>.src` changes to an ad URL (detectable by domain — googlevideo.com with `/videoplayback?…` ad markers, or the `googlesyndication`/`doubleclick` domains).

Tradeoff: broader query risks false positives (matching ad overlays during normal playback). The `<video> src` check is more reliable but requires a `srcchange` MutationObserver on the video element itself.

**Implementation:** modify `getYouTubeAdSignalTarget()` to return the `<body>` (class subtree observer) or observe multiple elements, and update `isYouTubeAdPlaying()` to check both the legacy `#movie_player` classes AND the broader DOM signal. Low blast radius.

### Option 2 — Add a `<video>` src MutationObserver as a parallel ad-signal

A seek-induced mid-roll swaps the `<video>.src` to an ad URL and then back to the content URL. Observe the `src` attribute on the `<video>` element (or `currentSrc` via a `srcObject` check). When src changes to an ad domain and the video is playing, treat it as an ad start. When src reverts, treat it as ad end.

Tradeoff: requires knowing YouTube's ad CDN domain patterns (brittle if YouTube changes them). Also the `src` attribute may not be set directly on the element (YouTube uses `blob:` URLs via MSE). More complex.

### Option 3 — Expose YouTube's ad state via the player API (MAIN world)

YouTube's player object (`document.getElementById("movie_player").getPlayerState()` or the `ytInitialPlayerResponse` / player API) has explicit ad state. Inject a MAIN-world script (via `chrome.scripting.executeScript({world:"MAIN"})`) to read `movie_player.getAdState()` or listen to `yt-navigate-finish` events with ad metadata.

Tradeoff: requires a new executeScript injection (already has precedent in the codebase via `getPlayerResponse()`). Most reliable but adds async latency and depends on undocumented YouTube internal APIs.

---

## Console lines to capture

Ask the user to open DevTools → Console, start dubbing a video, then seek to a point that triggers an ad. Capture:

1. **`[ad] watcher STARTED`** — confirms AdWatcher is running with `hasObserver:true` when the session begins.
2. **`[ad] ad STARTED → pause dub`** — if this NEVER appears after the seek, neither the observer nor the poll is firing → H4 (wrong DOM signal).
3. **`[ad] ad ENDED → resume dub`** — confirms the ad-end path.
4. **No output at all between seek and the ad appearing** → confirms H4 is the root cause.

Additionally, run in the console immediately after seeking (while the ad is visible):
```js
document.getElementById("movie_player")?.className
// → if "ad-showing" is NOT in the output while the ad is playing → H4 confirmed
document.querySelector(".ad-showing")?.id
// → if this returns a different element ID → confirms the signal is on a different node
```

These two console queries, run while the ad is visible on screen, will definitively confirm whether `#movie_player` carries `ad-showing` (observer would catch it) or whether the signal is elsewhere (H4 = root cause, fix must target a different element).
