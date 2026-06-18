# SOLUTION — Udemy captions reported missing + no-caption audio fallback

## Problem & why

On a Udemy course-taking page that **has** captions (English [CC] visible in the player's
native caption menu), the extension shows **"No captions available on this video."** and offers
no dubbing. Two distinct defects:

**A. False "no captions" on Udemy.** `udemyAdapter.fetchCaptions()` collapses to `null` before it
ever hits the network because `extractCourseId()` queries stale selectors:
- Primary `document.querySelector(".ud-app-loader")` — an **AngularJS-era** element that is **not
  present** on the current React course-taking page.
- Fallback `body[data-clp-course-id]` — `clp` = *course-landing-page*; that attribute only exists
  on `/course/<slug>/` (the marketing page), **never** on `/course/<slug>/learn/lecture/<id>`.

No `courseId` → `fetchCaptions` returns `null` with **no API call**. The pipeline's HTML5
`video.textTracks` fallback then also fails (Udemy's Shaka player renders captions in its own
`UITextDisplayer` DOM overlay, so `video.textTracks` is empty), and because Udemy is flagged
`audioCapture:false` the pipeline shows the unsupported toast. (Confirmed against 3 live
Udemy tools, Dec-2025, + active yt-dlp issue #15681 Jan-2026: the current taking-page selector is
`[data-module-id="course-taking"]` whose `data-module-args` JSON holds `courseId`.)

**B. No audio fallback when captions truly are absent.** The user expects "audio → text → TTS
(MiniMax)" to kick in. Today the no-caption branch hard-refuses it on Udemy because the adapter
declares `audioCapture:false` (blanket Widevine assumption). But **not every Udemy lecture is
DRM-protected** (free previews, some courses ship plain HLS), and the server Standard chain
(Gemini audio-in STT → MiniMax WS TTS) is fully wired, enabled on all tiers, metered, and
CORS-allows `udemy.com`. The static flag is too conservative.

## Chosen approach

### A — robust Udemy caption acquisition (`src/platforms/udemy/adapter.ts`)

1. **`extractCourseId()` → ordered waterfall**, return first hit, else `null`:
   1. `[data-module-id="course-taking"]` → `data-module-args` JSON → `courseId`  *(current taking page — PRIMARY)*
   2. `.ud-app-loader[data-module-args]` → `courseId`  *(legacy, kept as cheap extra)*
   3. regex `/"courseId"\s*:\s*(\d+)/` over `document.documentElement.innerHTML`  *(embedded bootstrap JSON)*
   4. `body[data-clp-course-id]` then `body[data-course-id]`  *(landing-page / older fallbacks)*
2. **Caption API call**: add header `x-udemy-cache-logged-in: 1` (CDN reliability), keep
   `credentials:"include"`, keep `fields[lecture]=asset&fields[asset]=captions,download_urls`.
3. **Track selection** prefers the genuine source track over auto-translations:
   - `getLocale(c) = (c.locale_id ?? c.locale?.locale ?? "").toLowerCase()`
   - `isAuto(c) = c.source === "auto" || c.is_translation === true`
   - Never select a track whose locale matches `avoidLang` (don't dub target→target).
   - Order: non-auto∧preferLang → non-auto(any) → preferLang(any) → first non-avoid →
     **`null`** when every track is the avoided language (→ caller's audio fallback).
     *(Audit fix: a "first usable even if avoidLang" last-resort would dub target→target.)*
4. **Diagnostics**: module-private `udlog(...) = console.info("[echoly-cc]", ...)` (same prefix as
   YouTube's `cclog`) at **every** `return null` (no courseId / api non-ok+status / empty captions /
   no track url / VTT non-ok+status / 0 cues / threw) so the user can self-diagnose on the real page.
5. Extend `UdemyCaption` with `source?`, `is_translation?`, `locale?: { locale?: string }`.

The pipeline-level HTML5 `fetchHtml5TextTrackCaptions` fallback stays as last resort (unchanged) —
free, occasionally helps generic `<track>` lectures, never hurts.

### B — per-lecture audio-capture probe (additive port hook, capabilities stay immutable)

Add an **optional** method to the `PlatformAdapter` port:

```ts
/** Per-session refinement of capabilities.audioCapture for platforms where capture
 *  viability depends on THIS media (e.g. Udemy: DRM lectures vs non-DRM previews).
 *  Omit → callers use the static capabilities.audioCapture flag. */
canCaptureAudioNow?(video: HTMLVideoElement): boolean;
```

- Udemy implements it: `try { return video.mediaKeys == null } catch { return false }` — a fast,
  playback-independent **Widevine probe** (EME attaches `mediaKeys`; when present, `captureStream`
  yields a silent track-less stream → refuse; when absent → allow the audio fallback attempt).
- `capabilities.audioCapture` **stays `false`** for Udemy (the platform is *generally* DRM; the
  static contract's "read once, immutable" rule is untouched — the new hook is a separate runtime
  refinement, not a mutation).
- Both fallback branches change from `adapter.capabilities.audioCapture` to:
  `adapter.canCaptureAudioNow?.(video) ?? adapter.capabilities.audioCapture`.
  - `subtitle-first-pipeline.ts:228` — `video` already in scope.
  - `auto-next.ts:191` — `app.capture.videoEl ?? app.adapter.findVideo()`.

**Credit safety preserved**: even when the probe says "try", `captureWithRetry` refuses to POST to
the server if the stream has no audio tracks (throws *before* any metering reserve) — so a DRM
stream that slips through burns **zero** credits, it just shows "Tab audio not ready." The probe
only converts that 9s wait into an instant, correct decision for the common case.

### Rejected alternatives
- *Flip Udemy `audioCapture:true`*: semantically wrong + would need touching the immutable-
  capabilities contract; the optional hook is cleaner and scoped.
- *Thread server `course_is_drmed` into the fallback decision*: the caption API returns `null` on
  no-captions, losing the flag; client `mediaKeys` is simpler and authoritative enough.
- *MAIN-world webRequest intercept of Udemy's own lecture XHR*: more robust long-term but heavy;
  the selector fix resolves the reported bug with far less surface.

## Files / ownership (no overlaps)
| File | Change |
|---|---|
| `src/shared/platform-ports.ts` | add optional `canCaptureAudioNow?(video)` to interface (+doc) |
| `src/platforms/udemy/adapter.ts` | rewrite `extractCourseId`, `pickCaptionTrack`, `fetchCaptions` diagnostics + header, add `canCaptureAudioNow`, extend `UdemyCaption` |
| `src/content/pipelines/subtitle-first-pipeline.ts` | line ~228 branch uses the probe |
| `src/content/auto-next.ts` | line ~191 branch uses the probe |
| `test/platforms/udemy/adapter.test.ts` | new courseId fixtures (taking-page selector, regex, body attr), track-pick (non-auto/avoidLang), diagnostic-log spies, `canCaptureAudioNow` |
| `test/content/pipelines/subtitle-first-pipeline.test.ts` | probe gates the Standard fallback; DRM (`mediaKeys` set)+no-cc → `NO_CC_UNSUPPORTED` |

## Acceptance criteria (runtime-observable)
1. On a Udemy taking page using the current `[data-module-id="course-taking"]` DOM, `fetchCaptions`
   extracts `courseId`, calls the api-2.0 endpoint, and returns the **English [CC]** (non-auto)
   cues — dubbing starts via subtitle-first. *(verified by unit test w/ real-shaped fixture; live
   verification requires the user's logged-in Udemy session — flagged.)*
2. When `preferLang`/`avoidLang` are set, the picker never returns an auto-translated or
   target-language track if a genuine source track exists.
3. Every caption-acquisition failure prints a distinct `[echoly-cc]` console line naming the failed
   step.
4. On a **non-DRM** Udemy lecture with no captions, the pipeline attempts `startWebRtcStandard`
   (audio→STT→TTS) instead of immediately showing "No captions available". On a **DRM** lecture
   (`video.mediaKeys != null`) with no captions it still shows the unsupported toast and burns no
   credits.
5. `npm run typecheck` = 0 errors; `npm test` green (incl. new tests); `npm run build` succeeds.

## Known limitation (explicit)
- **No live Udemy run in this environment** (no logged-in session/browser). Verification is
  fixtures + tsc + build + the `[echoly-cc]` diagnostics the user reads on their own page. If the
  real api-2.0 shape differs from the documented contract, the diagnostics will pinpoint the step.
- DRM Udemy lectures with **no** captions remain genuinely undubable (Chrome blocks captureStream);
  the fix makes that case fast+clear, it cannot make DRM audio capturable.
</content>
</invoke>
