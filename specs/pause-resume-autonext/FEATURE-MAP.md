# FEATURE-MAP — file ownership + locked contracts

Build order: **FOUND (serial)** → parallel **[SRV, PIPE+AUTONEXT, PAUSE+NAV, UI]** →
**WIRE (integration)** → integration gate (tsc+vitest) → audit loop.

**Hard rule: no file appears in two agents' scope.**

## Ownership

| Agent | Repo | Owns (files) |
|---|---|---|
| **FOUND** (serial, first) | extension | `shared/ports.ts`, `shared/product-copy.ts`, `content/stop-reasons.ts`, `content/session-manager.ts`, `lib/rtc-media-sync.ts` |
| **SRV** | server + core | `core/src/services/metering.service.ts`, `server/src/services/session-manager.ts`, `server/src/http/routes/rtc.routes.ts`, `server/src/services/rtc/mediasoup.peer.ts`, `server/src/services/rtc/mock.peer.ts` (+ their test files) |
| **PIPE+AUTONEXT** | extension | `content/pipelines/subtitle-first-pipeline.ts`, `content/pipelines/webrtc-pipeline.ts`, **NEW** `content/auto-next.ts` |
| **PAUSE+NAV** | extension | **NEW** `content/pause-controller.ts`, **NEW** `content/navigation.ts` |
| **UI** | extension | `popup/index.ts`, `content/overlay/overlay.ts`, `content/overlay/template.ts` |
| **WIRE** (integration) | extension | `content/index.ts` (only) |

`content/capture.ts`, `background/*`, `shared/protocol.ts` are NOT edited (existing APIs suffice).

## Locked contracts (every agent imports these signatures; do not invent new shared types)

### FOUND — `content/session-manager.ts` (add to `SessionManager`)
```ts
userPaused = false;          // canonical "user paused the source video" (all tiers)
connectionLost = false;      // peer died during pause / media-gate 404 (WebRTC)
pauseSessionTimer(): void;   // freeze 55/60-min warn+limit: store remaining, clear timers
resumeSessionTimer(): void;  // restart warn+limit from stored remaining + stored callbacks
```
- `startSessionTimer(onWarning, onLimit)` must STORE `onWarning`/`onLimit` + absolute deadlines
  (`Date.now()+SESSION_WARNING_MS`, `+SESSION_LIMIT_MS`) so `pause/resumeSessionTimer` can rebuild.
- `startHeartbeat(...)` fetch must send `Content-Type: application/json` +
  `body: JSON.stringify({ paused: this.userPaused })` so the realtime heartbeat carries pause state.
- `emitState({running,paused,status,errorMessage})` unchanged (already supports these fields).

### FOUND — `lib/rtc-media-sync.ts`
```ts
// returns whether the server acknowledged (res.ok); false on !ok or network error
export function notifyServerMediaGate(apiBase, rtcSessionId, apiBearer, paused): Promise<boolean>;
// sm now structurally: { videoPaused: boolean; apiBase: string; connectionLost?: boolean }
export function syncSourcePauseState(sm, session, paused): void; // sets sm.videoPaused;
//   fires the gate; on a non-ok gate result sets sm.connectionLost = true (best-effort).
```
(`pauseSession`/`resumeSession` own setting `sm.userPaused`; rtc-media-sync owns `videoPaused`.)

### FOUND — `shared/ports.ts`
```ts
export type OverlayState = "ready" | "connecting" | "live" | "paused" | "switching" | "error";
```

### FOUND — `shared/product-copy.ts`
```ts
export const STATUS_PAUSED_VIDEO   = "Paused — press play to resume";
export const STATUS_SWITCHING_VIDEO = "Switching to next video…";
export const STATUS_LOADING_NEXT   = "Loading next video…";
```

### FOUND — `content/stop-reasons.ts`
```ts
NEXT_VIDEO_LOAD_FAILED: "next-video-load-failed"   // STOP_REASON
// STOP_REASON_MESSAGE: "Couldn't load the next video."
```
(`switching` is a state, NOT a stop reason — no STOP_REASON entry for it.)

### PAUSE+NAV — `content/pause-controller.ts` (NEW)
```ts
import type { ContentApp } from "./index.ts";
export function pauseSession(app: ContentApp): void;   // user paused source video
export function resumeSession(app: ContentApp): void;  // user played source video
```
- `pauseSession`: set `sm.userPaused=true`; per tier — WebRTC: `syncSourcePauseState(sm,sess,true)` +
  (Standard) `app.standardDubSync?.stop()`; subtitle-first: nothing extra (driver idles on userPaused).
  Then `overlay.setOverlayState("paused")` + `overlay.setStatusText(STATUS_PAUSED_VIDEO)` +
  `emitState({running:true,paused:true,status:STATUS_PAUSED_VIDEO})` + `sm.pauseSessionTimer()`.
  Honor `shouldIgnoreSourcePlaybackEvent(app.adapter)` (ad guard) — caller already checks, but be safe.
- `resumeSession`: if `sm.connectionLost` → attempt one rebuild (`app.webrtc...`/stop on fail) else
  set `sm.userPaused=false`; WebRTC: `syncSourcePauseState(sm,sess,false)` + (Standard)
  `snapPlaybackStart()+start()`; subtitle-first: driver auto-resumes. Then `setOverlayState("live")`
  + status "Translating" + `emitState({running:true,paused:false,status:"Translating"})` +
  `sm.resumeSessionTimer()`.

### PAUSE+NAV — `content/navigation.ts` (NEW)
```ts
import type { ContentApp } from "./index.ts";
import type { StopReason } from "./stop-reasons.ts";
export type NavEvent =
  | { kind: "continue"; videoId: string }
  | { kind: "stop"; reason: StopReason };
export class NavigationWatcher {
  constructor(app: ContentApp);
  start(onEvent: (e: NavEvent) => void): void;  // begins URL poll (+ yt-navigate-finish if YT)
  stop(): void;
  notifyEnded(): void;  // called from onEnded: arm ~8s pending-next; emit continue on nav, else stop(VIDEO_ENDED)
}
```
- URL poll (500ms) + optional `yt-navigate-finish`. On change while running:
  `adapter.isWatchUrl(url)===false` → emit `{stop, SPA_NAVIGATION}`; else new `getVideoId` differs →
  **debounce 700ms** → emit `{continue, videoId}`. `notifyEnded` arms an 8s timer; a nav within the
  window cancels it (continue path handles it); on expiry emit `{stop, VIDEO_ENDED}`.

### PIPE+AUTONEXT — `content/pipelines/subtitle-first-pipeline.ts`
```ts
// builds a FRESH SubtitleFirstSession (reusing audioCtx/outputGain), evicts the old driver
// (old.stopFlag=true, clearInterval(old.playbackTimer), old.currentSource?.stop()), swaps sm.session.
restart(settings: StartSettings, newVideoId: string): Promise<{ ok: boolean; error?: string }>;
```
- Also: the idle checks (`#playbackTick`, `#runRollingRenderer`) read `sm.userPaused` (canonical)
  in place of / in addition to `sm.videoPaused` for the user-pause term.

### PIPE+AUTONEXT — `content/pipelines/webrtc-pipeline.ts`
```ts
// end old realtime session (/end), detach peer, re-acquire stream if element changed, buildSession,
// startHeartbeat (realtime), restart standardDubSync (standard); keeps overlay/bg session alive.
continueOnNewVideo(settings: StartSettings): Promise<{ ok: boolean; error?: string }>;
```

### PIPE+AUTONEXT — `content/auto-next.ts` (NEW)
```ts
import type { ContentApp } from "./index.ts";
export function continueOnNewVideo(app: ContentApp, newVideoId: string): Promise<void>;
```
- Orchestrates §2.3: switching overlay/emit; evict old driver; wait video ready+!ad
  (`readyState>=HAVE_FUTURE_DATA && currentTime>0 && !shouldIgnoreSourcePlaybackEvent`);
  rebind listeners BEFORE caption fetch; dispatch by tier to the pipeline restart method above;
  fallbacks §2.4 (no captions → Standard-WebRTC if `adapter.capabilities.audioCapture` else
  `stopSession(NO_CC_UNSUPPORTED)`); on any failure `stopSession(NEXT_VIDEO_LOAD_FAILED)`.

### WIRE — `content/index.ts` (integration)
- `onPause` → `pauseSession(this)` (after the existing ad/`_systemPaused` guards; NO stopSession).
- `onPlay`  → `resumeSession(this)` (drop the WebRTC-only early returns; controller handles tiers).
- `onEnded` → `this.nav.notifyEnded()` (NOT immediate stopSession).
- replace `startSpaWatcher()` with a `NavigationWatcher` whose `onEvent` calls
  `continueOnNewVideo(this, e.videoId)` or `stopSession(e.reason)`.
- expose what controllers need (already public): `adapter`, `sm`, `overlay`, `capture`,
  `standardDubSync`, `webrtc`, `subtitleFirst`, `stopSession`.

### SRV — server/core (see SOLUTION §2.2 + §4)
- `core metering.service.ts heartbeatRealtime`: `intervalCmin===0` ⇒ keepalive (refresh
  `last_heartbeat_at` + sentinel TTL, 0 `observed_cmin`, no top-up).
- `server session-manager.ts`: `HeartbeatInput.paused?: boolean` → `intervalCmin: paused?0:RT_HEARTBEAT_CMIN`.
- `server rtc.routes.ts` heartbeat: parse `{paused?:boolean}` body, forward.
- `server mediasoup.peer.ts` + `mock.peer.ts`: `_onInboundRtp` (mock `feedPcm`) drops the frame while
  `_mediaPaused` ⇒ `#observedInboundMs` cannot advance.
- Tests: paused heartbeat adds 0 cmin; inbound-gate freezes observed; back-compat absent flag.

## Gate
`tsc --noEmit` 0 in extension + server + core; `vitest` green in all three. Then audit loop.
</content>
