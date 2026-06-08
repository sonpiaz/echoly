# R2 — Ad Detection Robustness on Seek

**Slice:** Symptom C — why a seek-triggered mid-roll ad is not detected.
**Branch:** current `develop` (WXT+TS rebuild).
**Status:** READ-ONLY analysis; no source files modified.

---

## TL;DR

The 250ms backstop poll (`AD_WAIT_POLL_MS = 250`, `constants.ts:73`) **does**
re-read `isAdPlaying()` on every tick regardless of the MutationObserver's
state — so a stale observer would be rescued by the poll. The dominant failure
is instead an **`#adActive` edge-seeding race**: when a seek lands during an
ad's playback (or causes the ad to begin in the same event-loop turn that
flips other state), `#adActive` may already be seeded `true` at watcher-start,
causing the false→true edge to never fire. A secondary contributing path is the
`#onSeek` **ad-gate inside subtitle-first** that purposely no-ops during an ad
— meaning a seek-induced mid-roll that arrives WHILE `#adActive` is stuck `true`
silently discards the seek correction as well, compounding the symptom.

---

## 1. Code Paths Traced

### 1.1 MutationObserver target — is `#movie_player` stable across seek?

`getYouTubeAdSignalTarget` (`ad-state.ts:25-27`) does a live
`document.getElementById("movie_player")` every call. The AdWatcher captures
this element **once at `start()` time** (`ad-watcher.ts:64-67`) and hands it
to `new MutationObserver(…).observe(target, …)`. If YouTube destroys and
re-creates `#movie_player` (which YouTube's SPA navigation *does* do across
full page navigations, but typically NOT across mid-roll ads on the same page),
the observer watches a detached node.

**Evidence for a seek-triggered mid-roll:** on a seek-induced mid-roll, YouTube
does NOT re-create `#movie_player`; it mutates the existing element's class list
in-place. The comment in `ad-state.ts:7-14` is accurate. So **the observer is
observing the right node** for a same-page mid-roll. The observer being stale is
therefore NOT the root cause for seek-triggered mid-roll ads.

However: `startAdWatcher()` (`index.ts:318-327`) calls
`this.ad?.stop()` before re-arming, ensuring the old observer is disconnected
before a new one is bound to a fresh `getAdSignalTarget()` call. This is called
once at session start (`index.ts:521`) and once on auto-next
(`auto-next.ts:229`). Between those points, `#movie_player` stays alive and the
observer is valid.

### 1.2 250ms backstop poll — is it running during/after a seek?

`#pollTimer = setInterval(() => this.#evaluate(), AD_WAIT_POLL_MS)` is started
in `start()` (`ad-watcher.ts:71`) and cleared only in `stop()` (`ad-watcher.ts:
82-89`). `stop()` is called by `stopAdWatcher()` (`index.ts:330-333`) which is
called from `stopSession()` (`index.ts:876`) and before a `startAdWatcher()`
re-arm. **No seek path calls `stopAdWatcher()` or `stopSession()`** — the
`onSeeked` handlers are:

- **WebRTC-VOD** (`index.ts:707-716`): calls `this.standardDubSync?.snapPlaybackStart()` only — does NOT stop/restart the watcher.
- **Subtitle-first** (`subtitle-first-pipeline.ts:287-288`): calls `this.#onSeek(newSession, video)` — does NOT stop/restart the watcher.

**Conclusion:** the 250ms poll is still running through a seek. At the next
250ms tick after the ad classes appear, `#evaluate()` calls `this.#isAdPlaying()`
which calls `isYouTubeAdPlaying()` which calls `document.getElementById("movie_player")`
fresh and checks its live class list. The poll SHOULD catch a seek-induced
mid-roll **within 250ms**.

### 1.3 `#adActive` seeding race — the dominant failure path

This is the most likely root cause.

`start()` (`ad-watcher.ts:61`) seeds:
```ts
this.#adActive = this.#isAdPlaying();
```

This runs at watcher-arm time, which is `startSession()` line 521 in
`index.ts` — before the video session is fully live. The comment at
`index.ts:517-520` says it is "Armed BEFORE routing so it is already live when
the pipeline sets sm.session (an ad can start during the WebRTC TTFA wait)."

**Scenario that causes the miss:**

1. User is watching content; `#adActive = false`. The watcher was seeded
   correctly at session start.
2. User **seeks** to a cue point near a mid-roll marker.
3. YouTube inserts the mid-roll ad. YouTube's player flips `#movie_player` to
   `ad-showing`/`ad-interrupting`. The MutationObserver fires → `#evaluate()`
   runs → `now = true`, `#adActive = false` → edge fires → `onAdStart()` is
   called. **This path works correctly for a normal mid-roll.**

**The broken scenario — seek + ad in the SAME event burst:**

When the seek lands at a mid-roll cue boundary, YouTube's player can:
(a) fire the `seeked` event on the `<video>` while simultaneously
(b) flipping the ad class on `#movie_player`.

The `seeked` handler for subtitle-first (`#onSeek`) has an **ad-gate at line
1040**:
```ts
if (this.app.lifecycle.isPausedFor("ad")) return;
```

This gate is correct in intent — it prevents resetting `_played`/`renderCursor`
against the ad clock. But it creates a **timing window**:

- If the ad class flip arrives in the same microtask batch as `seeked` and the
  MutationObserver fires first → `#adActive` flips to true → `lifecycle.pause("ad")`
  → `#onSeek` rightly no-ops. **This path is CORRECT.**
- If `seeked` fires first (which it usually does — it is a DOM media event and
  the MutationObserver callback is a microtask queued after the mutation) →
  `#onSeek` runs, sees `isPausedFor("ad") === false`, resets `_played`/
  `renderCursor` against the ad's content-time (which is wrong), THEN the
  MutationObserver fires and `#adActive` flips to true → `lifecycle.pause("ad")`.
  The tick driver is now paused, but the render cursor is corrupt. **This path
  is partially broken but recovers when the ad ends via `reAnchor()`.**

The more serious version:

- The `seeked` event fires. `#onSeek` runs. `#adActive` is still `false` (the
  ad class has not been set yet — YouTube sets it slightly after the seek lands).
  `#onSeek` resets state against the seek-target's content time.
- 10–100ms later, YouTube sets `ad-showing` on `#movie_player`. The observer
  fires. `#evaluate()` runs. `now = true`, `#adActive = false` → edge fires →
  `onAdStart()` is called → `#enterAdPause()` pushes `ad` reason.

In this sub-scenario, **detection is NOT missed** — it arrives 10–100ms later.

**The truly broken scenario — poll gap + observer miss on seek boundary:**

There is a subtle window where BOTH signals fail. Consider:

1. The observer was just fired for a class mutation (perhaps a prior
   transitional class from the seek itself — YouTube mutates `#movie_player`
   classes during seeking in ways unrelated to ads: `playing-mode`, `ytp-large-play-button-show`, etc.)
2. The MutationObserver's callback queue drains. The next callback won't fire
   until the *next* mutation.
3. YouTube sets `ad-showing` in the same microtask flush as the seek-boundary
   class changes — all mutations coalesce into one MutationObserver callback.
4. If the MutationObserver callback fires but `isYouTubeAdPlaying()` returns
   `false` at that instant (because the ad class was removed and re-added within
   the same mutation batch — YouTube briefly removes then re-adds it during a
   seek-reset), the `#evaluate()` call sees `now === #adActive === false` → no
   edge → **detection miss**.
5. The 250ms poll fires 0–250ms later and rescues it — **unless** the poll
   itself misfires because `#adActive` is **seeded incorrectly at watcher re-arm**.

**The actual smoking gun — seeding at `startAdWatcher()` on auto-next:**

`continueOnNewVideo` calls `app.startAdWatcher()` at line 229 of `auto-next.ts`
AFTER the new video pipeline is live. This re-arms the watcher on the NEW video.
The `start()` seed reads `this.#isAdPlaying()` at arm-time (`ad-watcher.ts:61`).
If YouTube is still showing a **pre-roll ad** on the new video at that instant,
`#adActive` is seeded `true`. That is correct — the ad is already in progress,
and the watcher correctly waits for `ad-end`.

But if the user **seeks during the pre-roll ad** and the seek triggers the ad to
restart or skip:
- `#adActive` is `true` (seeded at watcher start).
- The ad ends briefly (skip animation), then restarts.
- `now = false` → `#adActive = true` → edge fires → `onAdEnd()` → ad reason
  is popped → dub resumes over the still-active ad video. **False negative on
  the ad-end/restart cycle.**

### 1.4 `#onSeek` ad-gate interaction — secondary compounding factor

`subtitle-first-pipeline.ts:1039-1040`:
```ts
#onSeek(s: SubtitleFirstSession, video: HTMLVideoElement): void {
    if (this.app.lifecycle.isPausedFor("ad")) return;
```

If `#adActive` is correctly `true` (ad is running), this no-op is correct. But
if `#adActive` is stuck `false` (the detection miss scenario), then:
- The seek fires → `#onSeek` runs (ad gate doesn't fire because `lifecycle` has
  no `ad` reason) → `_played`/`renderCursor` are reset against the ad clock →
  the subtitle-first tick starts trying to dub content against an ad timestamp.
- The 250ms poll eventually catches the ad (within 250ms) → `#enterAdPause()`
  pauses the tick → dub audio stops.
- **But 0–250ms of subtitle-first dub played over the ad.** The metering is NOT
  frozen for that window.

### 1.5 Does seek cause `#movie_player` re-creation?

**No.** YouTube's SPA architecture only re-creates `#movie_player` across
full-page SPA navigations (handled by auto-next `startAdWatcher()` re-arm).
For a seek on the same video, `#movie_player` persists and its class list is
mutated in-place. The MutationObserver target remains valid.

---

## 2. Root Causes (Ranked by Likelihood)

### RC-1 (High): Observer fires in coalesced mutation batch; `isYouTubeAdPlaying` momentarily false

**Likelihood: HIGH.**

When a user seeks near a mid-roll cue, YouTube mutates `#movie_player` class
list multiple times in rapid succession (seek-mode flags, then ad flags). The
MutationObserver batches these into one callback. At the moment `#evaluate()`
runs inside that callback, if YouTube's internal sequence is:
1. Remove old classes (for the seek)
2. Add `ad-showing`
…and both mutations fire in the same batch, `isYouTubeAdPlaying()` reads the
final state (ad-showing = true) correctly. **But** if the ad class is set in a
SEPARATE microtask flush after the seek-related mutations, the first observer
callback sees no ad → `now === false === #adActive` → no edge. The ad-class
mutation arrives in a second callback → `now = true` → edge fires correctly.

This is the self-correcting case — the poll or the second observer callback
catches it within 250ms. **Net effect: 0–250ms of dub over the ad.**

### RC-2 (High): `#adActive` stuck `true` after seek through ad skip/restart

**Likelihood: HIGH for seek-through-pre-roll-on-auto-next.**

If the ad is being shown when `startAdWatcher()` re-arms (seeds `#adActive = true`),
then the user seeks → YouTube briefly shows "no ad" → `now = false` → edge →
`onAdEnd()` fires → dub resumes → ad resumes → `now = true` → edge →
`onAdStart()` fires. The resume window between skip/restart is the bug: **dub
resumes over the ad for the skip-bounce duration.**

### RC-3 (Medium): Race window between `seeked` DOM event and MutationObserver callback

**Likelihood: MEDIUM.**

`seeked` is a media event (task queue). MutationObserver callbacks are
microtasks queued after each mutation flush. If the ad class is set in the same
script turn as the seek triggers, the MutationObserver fires BEFORE `seeked`
(microtask beats macrotask). The `#onSeek` ad-gate then correctly no-ops.

If the ad class is set AFTER `seeked` fires (e.g. YouTube's ad-insertion is
deferred to a rAF or setTimeout after detecting the seek-target), then `#onSeek`
runs first against the ad-free state, corrupts cursor/`_played` for 0–250ms,
then the observer/poll catches the ad. **Secondary symptom: brief cursor
corruption, recoverable via `reAnchor()` on ad-end.**

### RC-4 (Low): Observer detached due to stale node (NOT the primary cause for mid-rolls)

The observer IS on the right node for same-page mid-rolls (YouTube doesn't
re-create `#movie_player` during a mid-roll). This path is only relevant for
auto-next transitions, where `startAdWatcher()` correctly re-arms on the new
element. **Not the root cause for the reported bug.**

---

## 3. Fix Options

### Fix A (Recommended): Re-seed `#adActive` on every 250ms poll tick (not just at start)

**Files touched:** `src/content/ad-watcher.ts`

**Mechanism:** In `#evaluate()`, instead of checking `now === this.#adActive`,
always call `this.#isAdPlaying()` (already done) but also re-seed from DOM state
after any edge fires. More precisely: add an explicit re-seed in the poll tick
path by calling `getAdSignalTarget()` fresh each poll (already done via
`adapter.isAdPlaying()` → `isYouTubeAdPlaying()` → live `getElementById`).

**The actual gap to fix:** The poll at line 71 already calls `#evaluate()` which
reads `isAdPlaying()` live. The issue is not the poll itself but the **initial
seed** at `start()` time. The fix is: after a seek, call
`ad.#adActive = this.#isAdPlaying()` to re-seed. Since `#adActive` is private,
the public API needs a new method:

```ts
/** Re-seed #adActive from current DOM state (call after a seek that may have
 *  changed ad state before the observer fired). Does NOT emit callbacks. */
reseed(): void {
  this.#adActive = this.#isAdPlaying();
}
```

Call `this.ad?.reseed()` in the `onSeeked` handler inside `bindCommonVideoListeners`
(`index.ts:706-718`), which handles the WebRTC case, and in `#onSeek`'s first
line in subtitle-first (`subtitle-first-pipeline.ts:1039`), after the existing
ad-gate check.

**Tradeoff:** Adds a small reseed call per seek. Correct because the poll's
existing 250ms rescue window is preserved as a belt-and-suspenders backstop.

### Fix B: Observe a more stable ANCESTOR (e.g. `<body>` or `ytd-app`) with subtree+class filter

**Files touched:** `src/content/ad-watcher.ts`, `src/platforms/youtube/adapter.ts`

**Mechanism:** Instead of observing only `#movie_player`, observe `document.body`
(or `ytd-app`) with `subtree: true, attributes: true, attributeFilter: ['class']`
and filter hits to the `#movie_player` node in the callback.

**Tradeoff:** Much noisier — every class mutation anywhere in the DOM fires the
callback. Given YouTube's heavy DOM churn during seeking, this could thrash
`#evaluate()` many times per second. The edge-detector already de-dupes boolean
flips, so correctness is preserved, but CPU cost is higher. Also, `subtree`
observers on `<body>` are known to be slow. **Not recommended.**

### Fix C: Re-arm the observer on seek (re-read `getAdSignalTarget()`)

**Files touched:** `src/content/ad-watcher.ts`, `src/content/index.ts`,
`src/content/pipelines/subtitle-first-pipeline.ts`

**Mechanism:** Add a public `restartObserver()` method on `AdWatcher` that
calls `this.#observer?.disconnect()` and re-creates it on a freshly-queried
`getAdSignalTarget()`. Call it from `onSeeked`.

```ts
restartObserver(): void {
  if (this.#observer) {
    this.#observer.disconnect();
    this.#observer = null;
  }
  const target = this.#app.adapter.getAdSignalTarget?.() ?? null;
  if (target) {
    this.#observer = new MutationObserver(() => this.#evaluate());
    this.#observer.observe(target, { attributes: true, attributeFilter: ['class'] });
  }
  // Re-seed to pick up any ad state that arrived during the seek.
  this.#adActive = this.#isAdPlaying();
}
```

**Tradeoff:** Heavier than Fix A (disconnects + reconnects MutationObserver on
every seek). Since `#movie_player` is NOT re-created during same-page mid-rolls,
this is overkill for the main scenario. BUT it handles the case where YouTube
does swap the element at a seek boundary (which has been observed in older YT
player versions). The re-seed subsumes Fix A. **Recommended as the combined fix.**

---

## 4. Cross-Slice Conflicts

### Symptom A ('ended' interaction)
When a seek lands AT the video's `duration` boundary (e.g. seeking to the very
end), `ended` may fire simultaneously with `seeked`. The `nav.notifyEnded()`
call in `onEnded` (`index.ts:299-304`) arms the terminal-idle window. If a
mid-roll fires in the SAME turn, `#enterAdPause()` pushes the `ad` reason —
but `notifyEnded` has already armed the 45s window. When the ad ends,
`#exitAdPause()` pops `ad`, the video resumes, and the nav watcher's idle
timer eventually fires. This could cause a false `VIDEO_ENDED` termination
during a legitimate ad+content-continue scenario. R1 should document this.

### Auto-next `startAdWatcher()` re-arm timing
`continueOnNewVideo` calls `startAdWatcher()` at step 5 (`auto-next.ts:229`),
AFTER the pipeline is live. The seed reads ad state at that point. If a
pre-roll is running at that instant and the user seeks during it, RC-2 applies.
The fix (`restartObserver()` including re-seed on seek) resolves this because
the seek re-seeds `#adActive` from live DOM state — the ad-showing class is
present → `#adActive` stays `true` → no false onAdEnd.

### `#onSeek` ad-gate in subtitle-first
`subtitle-first-pipeline.ts:1040`: `if (this.app.lifecycle.isPausedFor("ad")) return;`
This gate is correct in intent. With Fix A/C (re-seed on seek), `#adActive` will
be correct before `#onSeek` is called, so `isPausedFor("ad")` will be true when
the ad is genuinely running. The gate then correctly no-ops the seek reset —
which is the intended behavior for a seek landing inside a mid-roll.

---

## 5. Summary of Findings

| Question | Answer |
|---|---|
| Does YouTube flip `ad-showing`/`ad-interrupting` on `#movie_player` for seek-induced mid-rolls? | YES — same-page mid-rolls mutate the existing element in-place. |
| Does `#movie_player` get re-created on a mid-roll (observer detached)? | NO for same-page mid-rolls; YES across SPA nav (handled by `startAdWatcher()` re-arm). |
| Does the 250ms backstop poll catch it? | YES — within 250ms. Poll is live through seeks. **But** 0–250ms of dub plays over the ad before the poll fires. |
| Is the poll torn down / not re-armed after a seek? | NO. Neither `onSeeked` path stops/restarts `AdWatcher`. |
| Is there an `#adActive` seeding bug? | YES — `#adActive` is seeded once at watcher-start. On auto-next re-arm during a pre-roll, RC-2 (skip/restart bounce) can cause a false `onAdEnd`. On same-page seeks, RC-1 (coalesced mutation batch) explains the 0–250ms window. |
| Does a seek near a mid-roll cue cause `ended` + ad in the same tick? | Possible — if the seek target is at video end, `ended` + mid-roll can overlap. Cross-slice conflict with Symptom A. |
| Is any DOM timing where ad classes are on a DIFFERENT element after a seek? | No evidence. The comment in `ad-state.ts:14` explicitly warns against `.video-ads.ytp-ad-module` (always present) and endorses `#movie_player` only. |

**Recommended fix:** Fix C (re-arm observer + re-seed on seek), called from
`onSeeked` in `bindCommonVideoListeners` (WebRTC path, `index.ts:707`) and from
`#onSeek` (subtitle-first path, `subtitle-first-pipeline.ts:1039`).
