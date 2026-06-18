# SOLUTION — Udemy auto-next: CC dub fails on the next lecture (start works, restart doesn't)

## Problem & why

On Udemy, CC (subtitle-first) dubbing works on a lecture. When the lecture ENDS, the dub stops
(expected). The user clicks the next lecture on Udemy's end-screen → it auto-plays → the extension
shows "connecting"/translating status but produces **no dub audio and no subtitles**.

**Decisive user clue:** a manual **Stop + Start on that same next lecture dubs via CC correctly.**
So captions ARE available — only the **auto-next path** (`navigation` → `continueOnNewVideo` →
`subtitleFirst.restart()`) fails, while a fresh `subtitleFirst.start()` succeeds.

**Root cause (timing divergence).** `restart()` and `start()` are near-identical (same
`findVideo` → `fetchCaptions(videoId)` → `#firstPlayableCueAt(currentTime)` → dub-driver), but they
run at different moments:
- `start()` runs when the user manually presses Start — the lecture has **settled** (stable `<video>`
  element, `currentTime` sane, Udemy's caption asset/DOM ready).
- `restart()` runs **immediately on auto-next**, *during* Udemy/Shaka's lecture-load churn — the log
  shows `loadLecture`/`componentDidMount`/`createVideoPlayer`, i.e. Shaka **destroys + recreates** the
  `<video>` element and the React taking-page DOM remounts.

So `restart()` returns `{ok:false}` via one of these timing-sensitive exits:
- `subtitle-first-pipeline.ts:588-591` `findVideo()` → null mid-recreate → "No playable video" (**Defect 2, confirmed**).
- `:650-652` `fetchCaptions(newVideoId)` → null because the just-navigated lecture/DOM/API isn't ready yet → "No captions available".
- `:672-676` a stale/transient `currentTime` (read from a detached element) → `#firstPlayableCueAt` null → "No captions remaining at this position".

When `restart()` returns `!ok`, `auto-next.ts:189-208` falls back to `webrtc.continueOnNewVideo` — a
**dead end on DRM Udemy** (no audio capture → the silent `rt_…/v1/rtc/translate?pipeline=standard`
session seen in the server log), and additionally blocked because `restart()` left an **uninitialized
subtitle-first session in `sm.session`** (poisoning; `webrtc-pipeline.ts:535` `isWebRtcSession` →
false). Net: the dub dies.

## Chosen approach — make `restart()` succeed via CC like `start()` does

Fix the *timing robustness* of the CC path (the user's real goal), NOT the dead-end fallback.

- **A — Thread the validated `<video>` element into `restart()`.** `auto-next.ts`'s ready-poll already
  waited for `readyState>=3 && currentTime>0 && !ad` and holds that element in `video`. Pass it to
  `restart()` (`knownVideo`); `restart()` uses it **iff `knownVideo.isConnected`** (else re-queries).
  Eliminates the `findVideo()`-null and stale-`currentTime` divergences (Defect 2).
- **B — One bounded caption-fetch retry in `restart()`.** If the first `fetchCaptions` + HTML5 fallback
  are both empty, wait ~800 ms (abort/stale-guarded) and re-fetch **once**. Covers the
  "lecture not ready yet right after SPA nav" window so CC succeeds — exactly what waiting-then-manual-
  start does. Bounded; only on the empty path.
- **C — Clear the poisoned `sm.session` on the no-captions exit.** `if (sm.session === newSession) sm.session = null;`
  before the `:652` return, so a genuine failure leaves clean state (no uninitialized subtitle-first
  session blocking anything). Identity-guarded so a superseded generation never clobbers a successor.
- **D — Diagnostic logging at each `restart()` failure return** (`[auto-next] restart failed {step,…}`)
  so the exact cause is confirmable from the next live test.

`auto-next.ts` keeps its existing structure: with A+B, `restart()` succeeds on lectures with captions
and never reaches the fallback. On a genuine no-caption DRM lecture the existing
`canCaptureAudioNow`→false branch stops cleanly (`NO_CC_UNSUPPORTED`) — correct.

### Rejected alternative (the multi-agent converge's primary fix)
Moving the WebRTC no-caption handoff *into* `restart()` (with reused-AudioContext teardown,
overlay-retention proof, and re-entrancy guards). **Rejected:** high risk on a load-bearing path,
never critic-APPROVED (3× REVISE), and it makes a *dead-end* robust — on DRM Udemy it still yields
silence, so it does not serve the user's goal (CC dub). Our fix makes the **CC path succeed** instead.
The two real bugs it found (stale element, session poison) are addressed minimally here (A, C).

## Files / ownership (no overlaps)
| File | Change |
|---|---|
| `src/content/pipelines/subtitle-first-pipeline.ts` | `restart()` 3rd param `knownVideo?` (A) + `:588` use-if-connected (A) + one caption retry (B) + clear poisoned `sm.session` at the no-captions exit (C) + failure-step logging (D) |
| `src/content/auto-next.ts` | `:184` pass the poll-validated `video` as `restart()`'s 3rd arg (A) |
| `test/content/pipelines/subtitle-first-pipeline.test.ts` | restart uses `knownVideo` when connected; retry succeeds on 2nd fetch; no-captions exit nulls `sm.session` |

## Acceptance criteria (runtime-observable)
1. Auto-next to a next Udemy lecture that HAS captions dubs via CC **automatically** (no manual
   stop/start); overlay switching→live; console `[auto-next] subtitleFirst.restart result {ok:true}`.
2. `restart()` uses the auto-next-validated element; a transient Shaka recreate does not produce
   "No playable video on this page."
3. If the first caption fetch is empty on the just-navigated lecture, `restart()` retries once and
   dubs via CC when captions are actually present.
4. A genuine no-caption DRM lecture stops cleanly (`NO_CC_UNSUPPORTED`), leaves **no** silent `rt_`
   session, and `sm.session` is not left as a kind="subtitle-first" placeholder.
5. Each `restart()` failure logs its exact step (`[auto-next] restart failed`).
6. `tsc --noEmit` = 0 errors; `vitest` green (incl. new tests); manual Start unchanged.

## Known limitations (explicit)
- No live logged-in Udemy run here — verified by unit tests + tsc + build + the `[auto-next]`
  diagnostics the user reads. The diagnostics will confirm the exact failing step if anything remains.
- Genuine no-caption **non-DRM** Udemy lecture during auto-next still won't cold-start a WebRTC dub
  (rare edge; the dead-end fallback is left as a clean stop, not rebuilt). Out of scope.
</content>
