# Navigation & Auto-Next Mechanics — Research Findings

**Slice:** Navigation & Auto-Next  
**Date:** 2026-06-02  
**Repo:** `extension/` (TypeScript + WXT, Chrome MV3, branch `develop`)

---

## 1. SPA Navigation Detection

### Current mechanism (`src/content/index.ts:753–763`)

```ts
startSpaWatcher(): void {
  setInterval(() => {
    if (location.href !== this.lastSpaUrl) {
      this.lastSpaUrl = location.href;
      if (this.sm.session) {
        this.stopSession(STOP_REASON.SPA_NAVIGATION);
      }
    }
  }, 500);
}
```

- Polls `location.href` every **500 ms**.
- If a session is active and the URL changed, calls `stopSession(SPA_NAVIGATION)`.
- No session → silent update of `lastSpaUrl` (correct).

### What `stopSession` tears down (`:506–668`)

`stopSession` is a full teardown in this order:

1. `stopStandardDubSync()` — clears the adaptive dub/video rate-sync interval.
2. `sm.videoPaused = false`
3. `sm.pageToken += 1` — invalidates all in-flight async branches.
4. `sm.clearSessionTimer()` — clears the 55/60-min warning/limit timers.
5. `sm.stopHeartbeat()` — stops the Realtime /heartbeat keepalive.
6. `stopCaptionPoll()` — stops source-text scraping interval.
7. `unbindSourcePlayback?.()` — removes pause/play/ended/seeked DOM listeners from the `<video>` element; sets `unbindSourcePlayback = null`.
8. Drops `capture.videoEl`: unregisters volume-drift guard, rate-change warning, resets `video.muted = false` and `video.volume = 1.0`, sets `capture.videoEl = null`.
9. Builds `rtcEnd` snapshot if Realtime session (for deferred `/end` call).
10. **Session teardown:**
    - SubtitleFirst: `clearInterval(playbackTimer)`, `stopFlag = true`, `abortController.abort()`. If `reason === VIDEO_ENDED` and a source is ringing, defers AudioContext close to the clip's `onended` (or 5s safety timeout). Otherwise: stops and disconnects `currentSource`, closes AudioCtx.
    - WebRTC: closes `remoteAudio` (drain 600ms if VIDEO_ENDED, else cut immediately), disconnects `outputGain`, closes `audioCtx`, closes `dc`, closes `pc`, stops `stream` tracks.
11. `sm.session = null`
12. POST `/rtc/translate/${id}/end` (fire-and-forget, if Realtime).
13. Tears down `sm.prevSession` (handover remnant) the same way.
14. Resets `sm.history`, `sm.currentTargetText`, `sm.translationUtteranceOpen`, `sm.translationSegmentId`.
15. Calls `restoreNativeCaptions()` if set.
16. `setActiveAdapter(null)` — clears media-stage module's adapter reference.
17. `overlay.removeOverlay()` — **removes the overlay DOM entirely**.
18. `sm.emitState({ running: false, paused: false, status: "Stopped" })`
19. `sm.emitEnded(STOP_REASON_MESSAGE[reason])` (unless BACKEND_STOP).

### What SURVIVES a navigation

| Thing | Survives? | Notes |
|---|---|---|
| `ContentApp` instance | YES | `startSpaWatcher` is a `setInterval` on the instance; the instance lives for the tab's lifetime. |
| `sm.settings` | YES (stale) | Not cleared on stop. Re-set fresh on next `startSession`. |
| `overlay` DOM (`.ec-root`) | NO | `overlay.removeOverlay()` is called. |
| `overlay` object (TS instance) | YES | The `OverlayView` object is alive; `buildOverlay` recreates DOM on next start. |
| `capture` (AudioCapture object) | YES | Object survives; `capture.videoEl = null` is set. |
| `sm.session` | NO | Set to null. |
| WebRTC PeerConnection | NO | Closed by stopSession. |
| MediaStream (captureStream) | NO | Tracks stopped. tabCapture stream fully released. |
| `sm.pageToken` | YES (incremented) | Guards stale async branches. |
| `lastSpaUrl` | YES (updated) | Prevents re-firing the stop. |
| `adapter` | partially | `setActiveAdapter(null)` clears media-stage; `ContentApp.adapter` field keeps old reference until next `startSession` resets it via `detectAdapter`. |
| Video element DOM listeners | NO | `unbindSourcePlayback()` removes them. |

---

## 2. Video Element Lifecycle Across YouTube Navigation

### YouTube video element identity

`findYouTubeVideo()` (`platforms/youtube/adapter.ts:25–31`) uses:
```ts
document.querySelector("video.html5-main-video") ||
document.querySelector(".html5-video-player video") ||
document.querySelector("video")
```

**YouTube SPA behaviour (from well-documented browser behaviour):** YouTube reuses the **same** `<video class="html5-main-video">` DOM element across SPA navigations. It updates `src`/`srcObject` in place rather than replacing the element. This means:

- The video element identity (`===`) is **preserved** across navigations.
- However, the `readyState`, `currentTime`, `duration`, `src`, and caption tracks all reset.

### Listener lifecycle

The pause/play/ended listeners are bound by `bindSourceVideoPlayback` (`lib/rtc-media-sync.ts:12–26`):
```ts
video.addEventListener("pause", handlers.onPause);
video.addEventListener("play", handlers.onPlay);
video.addEventListener("ended", handlers.onEnded);
```

`stopSession` calls `unbindSourcePlayback()` which removes all three. So after a navigation-triggered stop, **no listeners survive on the element**. A new `startSession` must re-bind them via `bindCommonVideoListeners`.

The `seeked` listener (`_onSeeked` in SubtitleFirstSession) is also removed by the same `unbindSourcePlayback` call (the return value of `bindSourceVideoPlayback` removes all four if `onSeeked` was passed).

### captureStream across navigation

`captureWithRetry` calls `video.captureStream()` at session start (`capture.ts:84–86`). This returns a `MediaStream` tied to the element's current playback pipeline. When YouTube reloads the video src for the next video, the existing `captureStream` tracks go silent / end — the stream is no longer valid. This is why `stopSession` calls `stream.getTracks().forEach(t => t.stop())` and the next session must re-acquire via `captureWithRetry`.

### volume-drift guard and rate-change warning

Both (`bindVolumeDriftGuard`, `bindRateChangeWarn`) are unbound in `stopSession` before `capture.videoEl` is nulled:
```ts
capture.unbindVolumeDriftGuard();
capture.unbindRateChangeWarn();
capture.videoEl.muted = false;
capture.videoEl.volume = 1.0;
capture.videoEl = null;
```
They do NOT survive navigation.

---

## 3. `onEnded` vs Auto-Next on YouTube

### Current `onEnded` handler (`index.ts:265–269`)

```ts
onEnded: () => {
  extra.onEndedBefore?.();
  this.stopSession(STOP_REASON.VIDEO_ENDED);
},
```

`onEndedBefore` (SubtitleFirstPipeline only) fires the final `#playbackTick` so the last buffered cue plays out before teardown.

### Event ordering on YouTube auto-next

On YouTube with **Autoplay ON**, when a VOD finishes and the next video auto-plays:

1. `ended` fires on the current `<video>` (immediately at the last frame).
2. → `stopSession(VIDEO_ENDED)` runs: tears down the session, removes overlay.
3. YouTube SPA navigates: URL changes to the next video's `/watch?v=NEW_ID`.
4. → `startSpaWatcher` detects the URL change (within the next 500ms poll) — but there is no session to stop (already stopped), so it is a silent `lastSpaUrl` update only.
5. YouTube updates the `<video>` element src (same element, new content).
6. The new video begins loading / playing.

**Gap:** Typically 2–5 seconds between `ended` on the old video and `play` on the new video (YouTube's end-slate countdown, if any). With the "Up next" auto-play countdown, the gap is configurable (default 5s). With no countdown (playlist auto-advance), it can be < 1s.

**There is NO native signal that "a next video is coming."** The only signals available are:
- **URL change** (500ms poll, or pushState intercept).
- **`video.ended` state** (video element property remains `true` until new src loads).
- YouTube-specific: the `yt-navigate-finish` custom event (dispatched by the YouTube SPA on the `document` when a navigation completes and the new page is hydrated). This is NOT currently intercepted.
- YouTube-specific: `yt-player-updated` (less reliable) or the `data-video-id` attribute on `#movie_player` changing.
- The `ytInitialPlayerResponse` being replaced in the DOM script tag (inspectable via `readPlayerResponseFromDom`).

**Key insight:** `ended` + subsequent URL change within ~10s is a strong heuristic for "auto-next". `ended` with no URL change = user paused/stopped at the last frame or a loop. But there is no 100%-reliable, latency-free signal without intercepting YouTube's internal event bus.

---

## 4. Per-Platform Navigation Models

### YouTube (`platforms/youtube/adapter.ts`)

| Property | Value |
|---|---|
| `capabilities.isSpa` | `true` |
| `capabilities.subtitleFirst` | `true` (preferred for VOD) |
| `capabilities.audioCapture` | `true` |
| `capabilities.hasAdOverlays` | `true` |
| New video detection | `getVideoId` extracts `?v=` param from URL. URL change (SPA watcher) is the only current signal. |
| `isWatchUrl` | `/watch?v=` or `/embed/<id>` |
| Video element reuse | Same `<video class="html5-main-video">` element reused across SPA navigations. |
| Per-platform nav hook | `yt-navigate-finish` custom DOM event (NOT currently used). |

YouTube's `installBackgroundServices()` installs the `webRequest` caption-URL interceptor (for the `ytCaptionCache`). This runs in the background SW, not content — it survives all navigations.

### Coursera (`platforms/coursera/adapter.ts`)

| Property | Value |
|---|---|
| `capabilities.isSpa` | `true` |
| `capabilities.subtitleFirst` | `true` (via `<track>` VTT or API) |
| `capabilities.audioCapture` | `true` |
| `capabilities.hasAdOverlays` | `false` |
| New lecture detection | `getVideoId` extracts lecture item-id from `/learn/<course>/lecture/<item-id>`. URL change via SPA watcher. |
| `isWatchUrl` | Matches `/learn/<course>/lecture/<id>` regex only (not home/quiz/supplement). |
| Video element reuse | Coursera is a React SPA — typically reuses the same `<video>` element but may recreate it between lectures. The `findLargestVideo()` fallback (by bounding-box area) handles either case. |
| Per-platform nav hook | None currently used; `history.pushState` intercept or `popstate` listener would be the clean approach. |

### Udemy (`platforms/udemy/adapter.ts`)

| Property | Value |
|---|---|
| `capabilities.isSpa` | `true` |
| `capabilities.subtitleFirst` | `true` (Widevine DRM → captions-only) |
| `capabilities.audioCapture` | **`false`** — Widevine DRM hard-blocks `captureStream`. |
| `capabilities.hasAdOverlays` | `false` |
| New lecture detection | `getVideoId` extracts `lectureId` from `/course/<slug>/learn/lecture/<id>`. |
| `isWatchUrl` | Matches `/course/<slug>/learn/lecture/<id>` regex. |
| Video element reuse | Udemy's Shaka player DOM: `document.querySelector("video")` — typically the same element across lectures within a course, but not guaranteed. |
| Caption acquisition | `courseId` from `.ud-app-loader[data-module-args]` DOM attribute + `lectureId` from URL → `api-2.0/subscribed-courses/<courseId>/lectures/<lectureId>/` API. |
| Per-platform nav hook | None currently used. |
| DRM implication | Audio capture impossible → subtitle-first only. If no captions: `NO_CC_UNSUPPORTED` (no WebRTC fallback). Auto-next on Udemy cannot use Realtime or Standard-WebRTC. |

### Generic (`platforms/generic/adapter.ts`)

| Property | Value |
|---|---|
| `capabilities.isSpa` | **`false`** |
| `capabilities.subtitleFirst` | `false` |
| `capabilities.audioCapture` | `true` |
| Navigation | Full page reload between navigations assumed. Content script is re-injected on new page. SPA watcher still runs but `isSpa: false` means no structural URL-change knowledge. |
| `getVideoId` | Uses pathname as stable ID. |
| `isWatchUrl` | Always `true` (optimistic). |

---

## 5. videoId Change Detection

### Current mechanism

Only the **500ms href poll** (`startSpaWatcher`). No platform-native hook is used.

### Available cleaner hooks (not currently used)

#### YouTube
- **`yt-navigate-finish`** — custom event dispatched by the YouTube SPA on `document` when a new page is fully hydrated. Example intercept:
  ```ts
  document.addEventListener("yt-navigate-finish", () => {
    const newId = getYouTubeVideoId(location.href);
    // ... react to new video
  });
  ```
  This fires synchronously on navigation commit, before the 500ms poll window. It is the most reliable YouTube-specific signal.
- **`yt-player-updated`** — also dispatched by YouTube on player state changes.
- **`data-video-id` attribute on `#movie_player`** — changes with each video; a `MutationObserver` on this attribute would give sub-100ms notification.

#### Coursera / Udemy
- **`history.pushState` / `popstate`** — can be intercepted to detect URL changes at pushState time (not 500ms later). The standard approach is to monkey-patch `history.pushState`:
  ```ts
  const origPush = history.pushState.bind(history);
  history.pushState = function(...args) {
    origPush(...args);
    window.dispatchEvent(new Event("locationchange"));
  };
  window.addEventListener("popstate", () => window.dispatchEvent(new Event("locationchange")));
  ```
  Or use the newer `Navigation API` (`navigation.addEventListener("navigate", ...)`) where available (Chrome 102+, so available for MV3 minimum Chrome 116).

### `caption-cache.ts` and videoId keying

`installYoutubeCaptionCache()` (`platforms/youtube/caption-cache.ts:24–63`) intercepts `webRequest.onCompleted` for `*/api/timedtext*` URLs in the background SW. It extracts `?v=<videoId>` from the captured URL and stores:
```ts
ytCaptionCache.set(videoId, { url, lang, kind, isAsr, tlang, capturedAt });
```

**Key insight:** The cache entry is **keyed by YouTube videoId** (the `?v=` param). When YouTube auto-loads captions for the next video (which happens before playback starts), the cache is populated for the new videoId **before** the content script's `startSession` even runs. This means the subtitle-first pipeline's `fetchCCViaIntercept` → `GET_YT_CC_URL` background message will find the URL ready immediately — no need to click the CC button.

The cache TTL is `YT_CACHE_TTL_MS = 30 min` (`:7` via constants). GC runs every `YT_CACHE_GC_MS = 5 min`.

**Can the cache tell us a new videoId early?** Indirectly yes — if the background SW detects a new videoId being added to the cache (a timedtext request for a `?v=X` not previously seen), that is a reliable early signal. But this requires the background to proactively notify the content script, which is not currently wired.

---

## 6. Restart-In-Place Requirements

To **continue dubbing on the new video without tearing down the overlay/background session**, here is the minimal delta by tier:

### (a) SubtitleFirst (YouTube VOD, Coursera, Udemy caption-only)

What must reset:
1. **pageToken bump** — `sm.nextToken()` — invalidates in-flight render loops and stale branches.
2. **Abort old AbortController** — `session.abortController.abort()` — cancels in-flight caption fetches and translate calls.
3. **New AbortController** — fresh `new AbortController()` for the new video's fetch chain.
4. **Caption refetch** — `adapter.fetchCaptions({ videoId: newVideoId, ... })`.
5. **Reset sentences / translations arrays** — `session.sentences = []`, `session.translations = []`.
6. **Reset renderCursor = 0**, `rollingInFlight = false`, `stopFlag = false`.
7. **Stop and null `playbackTimer`** — `clearInterval(session.playbackTimer); session.playbackTimer = null`.
8. **Stop/disconnect `currentSource`** — if a clip is mid-play, stop it.
9. **Close and recreate `audioCtx`** — AudioContext accumulates state; the safest approach is to close and new one. Alternatively, keep the same context if `state !== 'closed'` and just disconnect/reconnect nodes.
10. **Video element ref update** — `capture.videoEl = newVideo` (same element on YouTube, possibly different on Coursera/Udemy; re-run `adapter.findVideo()`).
11. **Rebind video listeners** — `bindCommonVideoListeners(video, newSession, { onSeeked, onEndedBefore })`.
12. **Rebind volume drift guard** — `capture.bindVolumeDriftGuard(newVideo)`.
13. **Adapter update** — `this.adapter = detectAdapter(location.hostname)` (same on same site; needed if navigating between sites, which is unlikely).
14. **Suppress native captions** — re-call `adapter.suppressNativeCaptions()` for the new video.
15. **videoTitle update** — `adapter.getVideoTitle()`.
16. **Overlay reset** — show "Loading captions" status, then "Translating X lines". The overlay DOM can stay mounted.
17. **Session timer reset** — `sm.startSessionTimer(...)`.

What does NOT need to change:
- `audioCtx.destination` routing (same GainNode graph, just different source nodes).
- Overlay `buildOverlay` call — the overlay is already mounted; just update status text.
- The `ContentApp` instance itself.
- `sm.settings` (same lang/voice settings unless user changed them).

### (b) Standard-WebRTC (Realtime pipeline path on non-subtitle-first platforms)

What must reset:
1. **pageToken bump**.
2. **Close old PeerConnection** — `detachOutgoingPeer(session)` or full `pc.close()`.
3. **Stop stream tracks** — `session.stream.getTracks().forEach(t => t.stop())`.
4. **Re-acquire captureStream** — new `capture.captureWithRetry(newVideo)` (the old stream's tracks are dead after `ended`).
5. **New `rtcSessionId`** — must POST a new `/v1/rtc/translate` signaling request; old session is ended.
6. **Stop heartbeat** → `sm.stopHeartbeat()`, then restart after new session established.
7. **POST `/end`** to the old session.
8. **Standard dub sync** — `stopStandardDubSync()`, then rebuild after ICE connects.
9. **Video element ref** — same video element (YouTube), but `capture.videoEl` must be updated.
10. **Rebind video listeners** — full rebind.
11. **SF6 pause/play sequence** — need to pause the video, wait for ICE + first dub, then play.

What does NOT need to change:
- `overlay` (already mounted).

### (c) Realtime (WebRTC OpenAI relay, translates tab audio)

**Realtime translates tab audio, not video-specific content.** The audio source is the tab's audio track, captured via `captureWithRetry(video)` but delivering the entire tab audio (since `captureStream` captures all audio from the `<video>` element).

On YouTube auto-next:
- The **same `<video>` element** continues; it just loads new content.
- The tab audio continues flowing through the same captureStream... **but `video.ended` fires, which triggers `stopSession(VIDEO_ENDED)` first.**

So even for Realtime, a restart-in-place on auto-next needs:
1. **New `rtcSessionId`** — POST new `/v1/rtc/translate` with `pipeline: "realtime"`.
2. **Re-acquire captureStream** — old stream is stopped; new one from the (same) video element.
3. **Restart heartbeat** for the new session.
4. **Rebind video listeners** — after `ended` fired and stopped the old session.
5. **No caption work needed** — Realtime does not use captions.

**Key insight for Realtime:** The gap between `ended` on the old video and `play` on the new video is 1–5+ seconds. During this gap, there is no audio to translate. The ideal behavior is to detect the URL change (new videoId), pause the dub and wait for the new video to start, then restart the WebRTC session automatically. The user should not need to press Stop/Start.

The captureStream tracks do go silent (not dead) when the video is paused/ended; they come back to life when the new video plays. However, to get a new `rtcSessionId` (required for billing), the server /end + new /v1/rtc/translate must be called.

**Minimum restart for Realtime:** end old session → new `/v1/rtc/translate` POST → establish ICE → re-bind ended listener. The overlay stays mounted.

---

## 7. Edge Cases & Failure Modes

Ranked from most-likely-to-occur to rarest:

### Tier 1 — High probability, must handle

1. **New video has no captions (subtitle-first path).**  
   YouTube: ASR captions are usually available but not guaranteed (new upload, live stream misidentified, CC disabled by creator). Udemy: many courses have no captions. Coursera: typically has captions.  
   → Fallback: if `audioCapture: true`, fall back to Standard-WebRTC (as `subtitle-first-pipeline.ts:154–158` already does). If `audioCapture: false` (Udemy), emit `NO_CC_UNSUPPORTED` and stop the auto-next session.

2. **Different source language on the next video.**  
   The `preferLang` passed to `fetchCaptions` is the **target** language, not source. The adapter picks any available source track. Different source language just means a different track is chosen — no blocking issue, but the translation quality may drop if the track language mismatch is severe.

3. **Navigation to a non-video page (YouTube home, search, channel page).**  
   `youtubeAdapter.isWatchUrl(newUrl)` returns `false`. The SPA watcher detects the URL change but no session is running (it was stopped by `ended`). Auto-next logic should NOT attempt to restart. Detection: check `adapter.isWatchUrl(location.href)` after URL change before restarting.

4. **Rapid multi-navigation (user skipping through playlist quickly).**  
   Each URL change fires the SPA watcher. The `startSpaWatcher` already debounces to 500ms poll. The background SW `auto-start.ts` has a 1500ms per-tab debounce. For restart-in-place, a debounce of at least 800ms on the "restart for new video" signal is needed to avoid building multiple sessions during rapid skips.

5. **Ad on the new video (YouTube pre-roll).**  
   `isYouTubeAdPlaying()` checks `#movie_player.ad-showing` or `.ad-interrupting`. This guard is already wired into `shouldIgnoreSourcePlaybackEvent`. During an ad, `video.paused` fires but the guard returns `true` → no session teardown. However, for auto-next restart, starting dubbing while an ad is playing would capture ad audio. The restart should be deferred until `!isYouTubeAdPlaying()` and `video.play` fires for the actual content.

6. **User manually navigates (clicks a recommendation) mid-pause.**  
   URL changes, `ended` has not fired. The SPA watcher detects it and calls `stopSession(SPA_NAVIGATION)` (if a session is running). This is correct behavior for the current model. For auto-next continuation: same path — detect URL change, stop old session, start new one.

### Tier 2 — Medium probability

7. **Multiple URL changes during one transition (search → video → another video in 2s).**  
   YouTube sometimes fires intermediate URL changes during SPA navigation (pushState may fire for search params first). A debounce (800ms–1.5s) on the restart trigger prevents spurious session builds. Only the final stable URL matters.

8. **Live stream after VOD.**  
   `capture.isLive(video)` checks `!isFinite(video.duration)`. Live streams skip the SF6 pause and don't use subtitle-first. If the next video after a VOD is a live stream, the adapter path changes: `subtitleFirst` would fail (`getVideoId` returns null for live `/watch?v=X` — wait, it does return the videoId; the real gate is `adapter.getVideoId !== null && videoProbe && !liveProbe` in `startSession:308–317`). So the live stream would correctly fall through to `startWebRtcSession`. Restart-in-place must re-evaluate live status on the new video.

9. **Udemy DRM + no captions (caption-only platform with no captions).**  
   `NO_CC_UNSUPPORTED` is emitted. Auto-next should surface this as a toast and not attempt to restart (already handled by the SubtitleFirstPipeline fallback logic when `audioCapture: false`).

10. **VOD → playlist auto-advance gap is very short (< 500ms).**  
    SPA watcher at 500ms may miss the brief ended→play sequence and only see the final URL. This is fine — the URL change detection is sufficient; `ended` already stopped the old session.

### Tier 3 — Low probability / edge

11. **`captureStream` fails on the new video (audio not yet ready).**  
    `captureWithRetry` already handles this with a 9s retry loop and 300ms poll. No new handling needed.

12. **User pauses the old video RIGHT as it ends.**  
    `pause` fires before `ended`. Current behavior: `stopSession(VIDEO_PAUSED)`. Then `ended` fires — but session is already null, so `onEnded` is never bound (listener was removed by stop). No double-stop. For auto-next: the video is already paused before ended fires, so SPA watcher will pick up the URL change (if any).

13. **Extension context invalidated mid-session (SW restart).**  
    `sm.notifyBackground` catches `"Extension context invalidated"` and calls `onRuntimeDead()` → `handleUnload()` → `stopSession(UNLOAD)`. Covered.

14. **`yt-navigate-finish` fires before `ended` (YouTube sometimes navigates away from an ended video).**  
    SPA watcher would fire first (at next 500ms tick). `ended` might not fire at all if YouTube replaces the src before the element naturally ends. In this case, SPA_NAVIGATION is the stop reason. For auto-next: this is fine — URL change is the trigger either way.

---

## Recommended Strategies

### Recommended restart approach per tier/platform

#### YouTube Subtitle-First (Standard tier)
1. Listen for `yt-navigate-finish` DOM event (or fallback to 500ms poll detecting URL change).
2. On URL change: if `adapter.isWatchUrl(newUrl)`, bump pageToken, abort old controller, cancel in-flight renders.
3. Debounce 600ms for stability.
4. `newVideoId = adapter.getVideoId(newUrl)`. If null or same as old: no-op.
5. Show "Loading next video…" in overlay status.
6. Re-fetch captions for newVideoId (new AbortController).
7. Reset sentences/translations/renderCursor/playbackTimer.
8. Wait for `video.play` (new video started) — re-bind listeners on the same element.
9. Restart playback driver.

#### Coursera / Udemy Subtitle-First
- Same flow as YouTube SF, but use `popstate` / `navigation.navigate` or the 500ms poll.
- Udemy: if no captions → `NO_CC_UNSUPPORTED` toast, do not attempt restart.
- Coursera: re-fetch from `<track>` elements or API with new lectureId.

#### Standard-WebRTC (non-SF platforms, or SF fallback)
1. On URL change + new videoId detected.
2. End old RTC session (`/end`), close PC/stream.
3. Wait for `video.play` (new video loaded).
4. Re-acquire captureStream, POST new `/v1/rtc/translate`, ICE connect.
5. VOD: SF6 pause/play sequence with new session.

#### Realtime
1. On `video.ended`: current session stops (already handled by `stopSession(VIDEO_ENDED)`).
2. Wait for URL change (up to 8s debounce window).
3. On URL change to a new watch URL: automatically restart Realtime session.
4. Re-acquire captureStream from (same) video element after it loads new content.
5. No caption refetch needed.
6. The overlay stays mounted; show "Reconnecting…" during the gap.

**Realtime special case:** Because Realtime translates raw tab audio, the content gap during the YouTube end-slate (2–5s silence) produces no translation output. This is natural and correct. No buffering or special handling needed; the new session simply starts translating when audio resumes.

### Detection approach & debouncing

| Mechanism | Latency | Reliability | Recommended for |
|---|---|---|---|
| `yt-navigate-finish` event | < 100ms | High (YouTube-specific) | YouTube |
| `navigation.navigate` API (Chrome 102+, available in MV3) | < 50ms | High (all SPA) | Coursera, Udemy |
| `history.pushState` monkey-patch | < 50ms | Medium (fragile) | Fallback if Navigation API unavailable |
| 500ms poll (current) | 0–500ms | High (universal) | Fallback for all |
| `onEnded` + 500ms URL-change window | 0–5000ms | Medium | YouTube auto-next detection only |

**Recommended debounce:** 600–800ms from the URL-change signal before starting the new session. This absorbs multi-pushState storms and allows the new `<video>` element to begin loading.

### Ranked edge cases (must-handle)

1. No captions on new video (subtitle-first) → SF fallback or NO_CC_UNSUPPORTED toast.
2. Navigation to non-video page → check `isWatchUrl` before restarting.
3. Rapid skip (multiple URL changes < 2s) → debounce restart to final URL.
4. YouTube pre-roll ad on new video → wait for `!isYouTubeAdPlaying()`.
5. New video is live stream → re-evaluate `capture.isLive()` and skip SF/SF6 accordingly.
6. Udemy DRM + no captions → hard stop, inform user.
7. Different source language → pick best available track; warn if quality may differ.

---

## File References (Key Locations)

| Topic | File | Lines |
|---|---|---|
| SPA watcher | `src/content/index.ts` | 753–763 |
| `stopSession` full teardown | `src/content/index.ts` | 506–668 |
| `bindCommonVideoListeners` | `src/content/index.ts` | 229–272 |
| `startSession` router | `src/content/index.ts` | 276–320 |
| YouTube `findVideo` | `src/platforms/youtube/adapter.ts` | 25–31 |
| YouTube `isWatchUrl` / `getVideoId` | `src/platforms/youtube/adapter.ts` | 42–59 |
| Coursera capabilities + `getVideoId` | `src/platforms/coursera/adapter.ts` | 42–48, 176–185 |
| Udemy capabilities + `getVideoId` | `src/platforms/udemy/adapter.ts` | 22–36, 142–151 |
| Generic adapter (`isSpa: false`) | `src/platforms/generic/adapter.ts` | 20–26 |
| Caption cache (videoId keyed) | `src/platforms/youtube/caption-cache.ts` | 18–63 |
| `bindSourceVideoPlayback` | `src/lib/rtc-media-sync.ts` | 12–27 |
| `detachOutgoingPeer` (handover) | `src/lib/rtc-handover.ts` | 65–117 |
| Background SW nav handler | `src/background/index.ts` | 38–41 |
| Auto-start debounce (1500ms) | `src/background/auto-start.ts` | 26, 72–74 |
| SubtitleFirst start | `src/content/pipelines/subtitle-first-pipeline.ts` | 43–258 |
| SubtitleFirst `_systemPaused` guard | `src/content/pipelines/subtitle-first-pipeline.ts` | 334–356 |
