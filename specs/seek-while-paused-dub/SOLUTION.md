# SOLUTION — Dub plays the WRONG segment after pause → seek → resume (+ launcher appears slowly)

Two independent fixes in this batch. (1) is the serious one.

## Problem 1 (SERIOUS) — "khi đang pause, tua sang điểm khác → nhấn play → lồng tiếng SAI đoạn"

On a subtitle-first (CC) dub: the user PAUSES, SEEKS to a different point while paused, then presses
PLAY — and the dub voices the **wrong segment** (a line from the old position, not the playhead).

### Root cause (confirmed by online research — documented browser behavior)

Seeking an HTML5 `<video>` **while paused does NOT fire a `'seeked'` event** — it's deferred until
play resumes, and in some cases (scrubbing the playbar while paused) **no events fire at all**.
Sources:
- MDN HTMLMediaElement `seeked` event — fires only when seeking completes + position changed.
- videojs/videojs-youtube #276 — "Seeking during pause does not fire a seeked event."
- Chromium issues 223031 / 41001716; videojs/video.js #3936 (no events when seeking at currentTime 0).

The dub's re-anchor (`SubtitleFirstPipeline.#onSeek`) is bound to `'seeked'`. So a seek-while-paused
**never re-anchors**, and the resume path historically did nothing special for subtitle-first
(`pause-controller.ts` — "resume naturally on the 250ms tick"). On resume, `#playbackTick` →
`#sentenceDueAt` returns the **earliest UNPLAYED cue** (not the cue at the playhead). The 3s
`SUBFIRST_DRIFT_SKIP_SEC` only masks **forward** seeks; a backward seek (or a seek into an
already-played / sparsely-played region) resumes on the stale pre-seek line, and the pre-fetcher's
`renderCursor` stays at the old region.

### Fix — re-anchor on resume when the playhead moved during the pause

A discrete, reliable trigger (`onPlay` → `resumeSession`) replaces the unreliable `'seeked'` event:
- `session-manager.ts` — add `_pausedAtTime?: number` to `SubtitleFirstSession`.
- `pause-controller.ts` `pauseSession` — for a subtitle-first session, record
  `sess._pausedAtTime = video.currentTime`.
- `pause-controller.ts` `resumeSession` — new `else if (isSubtitleFirstSession(sess))` branch:
  read+clear `_pausedAtTime`; if `|video.currentTime − pausedAt| > 0.5s`, call
  `app.subtitleFirst.reAnchor(sess, video)` (→ `#onSeek`: reset `_played` for cues ≥ the new anchor,
  re-target `renderCursor` in BOTH directions, bump the render epoch, stop the current clip, restart
  playback at the right line). `lifecycle.resume("user")` runs first, so `reAnchor`'s `#playbackTick`
  actually plays (userPaused already false). A plain pause/resume (no seek) skips it → no replay.

Why on resume (not a new listener): the resume is a reliable event even when `'seeked'` isn't; it
detects ANY seek (forward or backward) during the pause, and `reAnchor` already does the full
re-sync (cursor + played-flags + playback).

### Rejected alternative
A jump-detector inside `#playbackTick` (detect a backward `currentTime` jump). Rejected as the
primary fix: it touches the load-bearing playback driver, and a forward paused-seek still wouldn't
move `renderCursor` cleanly. The resume re-anchor is scoped, lower-risk, and handles both directions.

### Known limitation (explicit)
If the user seeks while paused and the player **auto-plays without firing `'play'`** (a documented
edge), `resumeSession` won't run and the re-anchor won't fire. The reported flow (pause → seek →
**press play**) does fire `'play'`, so it's covered. Seek-while-PLAYING is covered by the existing
`'seeked'` → `#onSeek`. If a flaky-`'seeked'` playing-seek surfaces, the follow-up is a
`#playbackTick` backward-jump detector.

## Problem 2 (minor) — launcher icon appears up to ~20s late on Udemy

The on-page launcher's only periodic visibility re-check was the **20s `KEEPALIVE_MS` tick**. On a
SPA/Shaka page the `<video>` is created after the content script's `init()`, so `#hasVideo()` is false
at init and the launcher waited up to 20s (next tick) / a tab-switch / a session event to appear.

### Fix
`launcher.ts` — a scoped `MutationObserver` (`#videoWatchObserver`, 150ms debounce) that re-evaluates
`#update()` the instant the DOM changes. Armed ONLY while eligible-but-no-video on a watch page
(`#isWatchPage()` = `adapter.isWatchUrl`); torn down on mount / active session / sign-out / non-watch
/ destroy. The 20s keepalive tick is unchanged (its job is keeping the MV3 SW warm).

## Files / ownership
| File | Change |
|---|---|
| `src/content/session-manager.ts` | `_pausedAtTime?: number` on `SubtitleFirstSession` |
| `src/content/pause-controller.ts` | record playhead on pause; re-anchor on resume if moved (subtitle-first) |
| `src/content/launcher.ts` | scoped video-appearance `MutationObserver` |
| `test/content/pause-resume-autonext.test.ts` | pause records playhead; resume re-anchors on seek; no re-anchor without seek |
| `test/content/launcher.test.ts` | launcher mounts as soon as the `<video>` appears (no 20s wait) |

## Acceptance criteria (runtime-observable)
1. Subtitle-first dub: pause → seek to a different point → press play → the dub voices the line at the
   NEW playhead (not the old one), in both seek directions.
2. Plain pause → play (no seek) does NOT replay/duplicate the current line.
3. Launcher icon appears within ~150ms of the Udemy `<video>` loading, not up to 20s later.
4. `tsc --noEmit` = 0; `vitest` green incl. new tests; manual Start + WebRTC pause/resume unchanged.
</content>
