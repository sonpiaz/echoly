# FOLLOW-UP — Udemy CC CORS failure + audio-fallback 55s no-PCM deadlock

Follow-up to `SOLUTION.md` (which fixed Udemy `courseId` extraction). A live run got
*further* — it now reaches the VTT fetch and the audio fallback — and surfaced two NEW,
distinct defects. Both root causes are confirmed by code reading (lifecycle.ts,
subtitle-first-pipeline.ts, udemy/adapter.ts, mediasoup.peer.ts), not inference.

## Problem 1 — "CC có nhưng vẫn không lấy được" (Udemy captions exist but fetch fails)

**Symptom (console):** fetch of `https://vtt-c.udemycdn.com/.../tr_TR/...vtt?Expires=…&Signature=…&Key-Pair-Id=…`
from origin `https://www.udemy.com` blocked by CORS — *"the 'Access-Control-Allow-Credentials'
header in the response is '' which must be 'true' when the request's credentials mode is 'include'"*
→ `fetchCaptions threw TypeError: Failed to fetch`.

**Root cause (confirmed):** `extension/src/platforms/udemy/adapter.ts:518` fetches the VTT with
`credentials:"include"`. The VTT lives on `vtt-c.udemycdn.com` — a **cross-origin** CloudFront
host. CloudFront serves these signed URLs with `Access-Control-Allow-Origin: *` (the error text —
complaining *only* about ACAC, not a missing ACAO — is the canonical signature of `ACAO:*` + a
credentialed request, which is invalid per the Fetch spec). The signed URL's
`Expires`/`Signature`/`Key-Pair-Id` query params **are** the auth (CloudFront query-string signing);
session cookies are neither needed nor wanted.

**Fix (FIX 1):** `adapter.ts:518` change `credentials:"include"` → `credentials:"omit"`.
- The same-origin api-2.0 calls at `:476` and `:205` (to `www.udemy.com`) **stay** `"include"` —
  they genuinely need the session cookies. Only the cross-origin CDN GET changes.

**Escalation (FIX 1b — NOT shipped speculatively):** if a live run shows `omit` still fails
(CDN returns no ACAO even un-credentialed), add `https://*.udemycdn.com/*` to `wxt.config.ts`
host_permissions and route the VTT GET through the background service worker (a background fetch
with host_permission bypasses page CORS). Held in reserve — shipping it now adds a needless Chrome
Web Store permission flag on the public extension.

**`tr_TR` wrong-track note (NOT fixed here — flagged):** the picked track was Turkish on an English
course. The real selection paths are already correct — `start()` (`subtitle-first-pipeline.ts:179-186`)
and `restart()` pass `preferLang = sourceLanguage (≠"auto")` / `avoidLang = targetLanguage`. The
eager-prefetch path lacks the hint **but is never consumed for Udemy** (`getPrefetchedCaptions` is
hard-gated `adapter.id==="youtube"` at `:173` and `:595`), so threading it is dead work (dropped).
The genuine residual: when `sourceLanguage==="auto"`, `preferLang` is `undefined` on *every* path and
`pickCaptionTrack` step-2 returns the first non-auto track (= `tr_TR`). Once CORS is fixed, the live
symptom resolves **iff** the user's `sourceLanguage` was a concrete non-auto value. If it was `"auto"`,
that is a separate product follow-up (auto-detect the source track), explicitly out of scope here.

## Problem 2 — audio fallback runs but returns no translation (55s no-PCM)

**Symptom (server):** the no-CC audio fallback (minimax-chain) fires and even commits metering, but
`first_pcm_fill_ms=54776`, `ttfa_ms=63989` — the server got **no usable PCM for ~55s** though the
first STT window needs only `STT_FIRST_SEGMENT_MS=1000ms`. STT (3.2s) + TTS (0.8s) were fast once
PCM finally arrived. So the entire delay is the inbound WebRTC audio track delivering nothing.

**Root cause (confirmed — lifecycle deadlock):**
1. `subtitle-first-pipeline.ts:166` pauses the source video: `lifecycle.pause("system-buffer")`.
2. When captions are absent, the no-CC branch (`:230-240`) calls `this.app.startWebRtcStandard(...)`
   at `:233` **without first releasing `system-buffer`**. The local `restorePlay()` closure is only
   invoked on the *failure* branch (`:238`) — and it is gated on `wasPlaying`, so it no-ops entirely
   when Start was pressed while the video was paused.
3. `startWebRtcStandard → startWebRtcSession(..., {forceWebRtcStandard:true})` **skips** its own
   SF6 pause/resume block (`index.ts:677 if (!live && !opts?.forceWebRtcStandard)`), so nothing in
   that path releases `system-buffer` either.
4. The reason stays stuck. `lifecycle.resume(reason)` only issues `video.play()` when the stack
   becomes empty (`lifecycle.ts:215`), and `effectivePaused` **excludes** `system-buffer`
   (`lifecycle.ts:254`) — so the stuck pause is invisible to the TTFA poller and to `sm.userPaused`.
5. The source `<video>` stays paused. `captureStream()` of a paused element yields a present-but-silent
   audio track (passes `captureWithRetry`'s `getAudioTracks().length` check), so the server's
   `#pcmWindows` never fills. The 55s is the user manually un-pausing the Udemy player.

**Killed hypothesis (critic):** the prior "muted source mutes `captureStream`" theory is wrong —
`HTMLMediaElement.muted`/`volume` govern the **speaker sink**, not the captured `MediaStreamTrack`.
Not in scope. The lifecycle deadlock is the real and complete client cause.

**Fix (CLIENT — the complete fix):** in `subtitle-first-pipeline.ts`, no-CC `canCaptureAudio`
branch, release the pause **unconditionally** *before* `startWebRtcStandard`:
- add `void this.app.lifecycle.resume("system-buffer");` immediately before `:233`.
- remove the now-redundant `restorePlay()` at `:238` (the reason is already released; on failure the
  source video correctly stays playing — a live dub of a paused video is meaningless).
- Unconditional (not the `wasPlaying`-gated `restorePlay()`): if Start was pressed while paused,
  `restorePlay()` would no-op and the deadlock would persist. `resume()` is idempotent; for the
  live-style no-CC dub the controller must hold **no** residual pause. `captureWithRetry`'s
  `nudgePlay` then drives the brief play needed to acquire the track.

**Fix (SERVER — diagnostics only, chosen scope):** add a one-shot **no-RTP warn timer** to
`mediasoup.peer.ts` so ops/the user can instantly see "the extension isn't sending audio" instead of
a silent stall. Set in `_attach()`, fires at 5s if `!_sawInboundRtp && !_closed`, cancelled on the
first RTP (`_onInboundRtp` `_sawInboundRtp` flip) **and** on `close()` so a recycled/warm session id
never warns stale. `.unref()`'d. Pure observability — no behavior/metering change.
- *Out of scope this wave (user choice):* the `FIRST_PCM_TIMEOUT_MS` fail-fast in `#pcmWindows`. A
  genuinely-silent session is already bounded by the client's 30s TTFA ceiling → `stopSession` →
  `pc.close()` → server DTLS-close teardown, so it does not hang forever; the behavioral timeout is
  deferred.

## File ownership (no overlaps)

| File | Change | Repo |
|---|---|---|
| `src/platforms/udemy/adapter.ts:518` | VTT fetch `credentials:"include"` → `"omit"` (CDN GET only; `:476`/`:205` stay `include`) | extension |
| `src/content/pipelines/subtitle-first-pipeline.ts:232-239` | unconditional `lifecycle.resume("system-buffer")` before `startWebRtcStandard`; drop redundant `restorePlay()` at `:238` | extension |
| `src/services/rtc/mediasoup.peer.ts` | `_attach` 5s no-RTP warn timer; cancel on first RTP + on `close()` | server |
| `test/platforms/udemy/adapter.test.ts` | assert VTT CDN fetch uses `credentials:"omit"`, api-2.0 stays `"include"` | extension |
| `test/content/pipelines/subtitle-first-pipeline.test.ts` | assert `resume("system-buffer")` is called before `startWebRtcStandard` on the no-CC audio fallback, incl. started-paused | extension |

## Acceptance criteria (runtime-observable)

1. **CORS:** on a Udemy lecture with captions, Start fetches the VTT from `vtt-c.udemycdn.com`
   with no CORS error and renders subtitles (no `fetchCaptions threw`). *(Live-verify: the env here
   has no logged-in Udemy session; unit test asserts the credentials mode.)*
2. **No-CC fallback, started PLAYING:** the source `<video>` stays playing through WebRTC setup; the
   server logs `first_pcm_fill_ms` in the ~1–3s range (not 50s+); dub audio plays.
3. **No-CC fallback, started PAUSED:** the unconditional resume drops `system-buffer`; no 55s
   deadlock; user pause→play still pauses/resumes both video and dub.
4. **Diagnostic:** when the extension sends no inbound RTP for 5s, the server emits a single
   `[mediasoup] … no inbound RTP in 5000ms` warn naming the sessionId; it never fires on a healthy
   session and never fires twice / for a recycled warm slot.
5. **Gates:** extension `npm run typecheck` = 0 errors, `npm test` green (+ new tests);
   server `npm run lint` (tsc) = 0 errors, `npm test` green.

## Known limitations (explicit)

- No live logged-in Udemy run in this environment — CORS + no-CC fallback are verified by unit tests,
  tsc, and the new `[mediasoup]` / `[echoly-cc]` diagnostics the user reads on the real page. If the
  CDN unexpectedly rejects the un-credentialed GET, FIX 1b (background + host_permission) is the
  pre-specified escalation.
- `tr_TR` wrong-track under `sourceLanguage==="auto"` is **not** fixed here (separate follow-up).
- `coursera/adapter.ts:280,302` and `lib/html5-captions.ts:157` carry the same latent
  `credentials:"include"`-on-CDN pattern; deferred (need per-CDN header verification).
</content>
</invoke>
