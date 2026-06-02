# Research Slice 03 — State Machine + UX Surface
# Pause/Resume & Auto-Next Continuation

Researcher: state-ux agent  
Date: 2026-06-02  
Branch: develop  
Codebase: extension/ (TS + WXT, Chrome MV3)

---

## 1. Background Store — `src/background/store.ts`

### Full State Shape (`shared/types.ts` `State` interface)

```
State extends Settings {
  running: boolean          // session is live
  connecting: boolean       // negotiating RTC / building pipeline
  paused: boolean           // currently: video-pause → stop (see §2)
  tabId: number | null
  status: string            // free-text shown in popup status line
  errorMessage: string
  apiMode: ApiMode
  signedInUser: SignedInUser | null
  usage: Usage | null
  languagePicker, languageNames, standardVoices, standardVoiceDefaultId
  sessionStartedAt: number | null    // wall-clock ms for elapsed timer
  advanced, siteOverrides, advancedVersion, advancedDirty, currentDomain
  // (Settings: tier, targetLanguage, realtimeVoice, standardVoice,
  //  originalVolume, voiceVolume, showSource, showTargetCaptions, apiBearer)
}
```

### `paused` — current wiring status: **half-wired, not end-to-end**

`store.ts:312` defines `setPaused(paused: boolean): void { this.state.paused = paused; }`.

**Who sets it:**
- `router.ts:43` — `CONTENT_STATE` handler: `if (typeof message.paused === 'boolean') store.setPaused(message.paused)`
- `router.ts:65` — `CONTENT_QUOTA` handler: `store.setPaused(false)` (hard reset on quota exhaustion)
- `router.ts:79` — `CONTENT_ENDED` handler: `store.setPaused(false)` (reset on session end)
- `session-coordinator.ts:284` — `stop()`: `store.setPaused(false)`

**Who reads it (popup):**
The popup `applyState()` at `popup/index.ts:563–568` checks `state.running && state.paused`:
```ts
} else if (state.running && state.paused) {
  setStateClass("paused");
  statusEl.textContent = "Paused.";
  setActionLabel("Stop dubbing");
  toggleBtn.classList.add("is-live");   // ← button stays orange/active
}
```
And the elapsed timer at `popup/index.ts:593`:
```ts
if ((state.running || state.connecting) && !state.paused) startElapsedTimer();
else stopElapsedTimer();
```

**Who sends `paused: true` from content?**
- `content/index.ts:211`: `this.sm.emitState({ paused: wasPaused, status })` — called only from `completeStandardHandover()`, after a mid-session lang/voice handover. `wasPaused` is `!video.paused` captured BEFORE the handover pause.
- `content/index.ts:263`: `sm.emitState({ running: true, paused: false, status: "Translating" })` — on video `play` event (WebRTC path).
- `content/index.ts:500` / `pipelines/subtitle-first-pipeline.ts:256`: `emitState({ running: true, paused: false, status: "Translating" })` — on successful session start.
- `content/index.ts:665`: `sm.emitState({ running: false, paused: false, status: "Stopped" })` — on `stopSession()`.

**Verdict: The `paused` field exists end-to-end in the data model and the popup renders it, but nothing currently sets `paused: true` in the normal video-pause path.** The current `onPause` handler in `content/index.ts:249` calls `this.stopSession(STOP_REASON.VIDEO_PAUSED)` — a full teardown, not a pause. So `paused` is structurally complete but behaviourally dead (only used briefly during handovers).

---

## 2. Router & Coordinator — `background/router.ts`, `session-coordinator.ts`

### CONTENT_STATE handling (`router.ts:41–48`)

```ts
if (message.type === "CONTENT_STATE") {
  if (typeof message.running === "boolean") store.setRunning(message.running);
  if (typeof message.paused === "boolean") store.setPaused(message.paused);
  if (typeof message.status === "string") store.setStatus(message.status);
  if (typeof message.errorMessage === "string") store.setError(message.errorMessage);
  store.broadcast();                     // → popup via BACKGROUND_STATE_UPDATE
}
```

All fields are optional. Setting only `{ paused: true, status: "Paused" }` without touching `running` is safe — the router only applies truthy-typed fields. **This means content can transition to paused without changing `running`, which is exactly what the new feature needs.**

### CONTENT_ENDED handling (`router.ts:76–90`)

```ts
if (message.type === "CONTENT_ENDED") {
  store.setRunning(false);
  store.setConnecting(false);
  store.setPaused(false);
  store.setTabId(null);
  store.setSessionStartedAt(null);
  store.setStatus(message.reason || "Stopped");
  store.broadcast();
  if (deps.settings && store.state.signedInUser) {
    scheduleHydrateSignedIn(store, deps.settings);
  }
}
```

`CONTENT_ENDED` is a **hard stop** — it clears tabId, nulls sessionStartedAt, and schedules a usage refresh. For the auto-next feature, the new "switching video" state must NOT emit `CONTENT_ENDED`. Instead it should hold `running: true` and emit `CONTENT_STATE` with a new status.

### `session-coordinator.stop()` (`session-coordinator.ts:249–299`)

Calls `relayToContent(CONTENT_STOP)`, then sets `running=false, connecting=false, paused=false, tabId=null, sessionStartedAt=null, status="Stopped"`. This is the popup's Stop button path. For pause/resume, the popup Stop button must NOT call this when the session is "paused"; it still calls `stop()` (killing the dub entirely), but the popup label stays "Stop dubbing" since `toggleBtn.classList.add("is-live")` is already set in the paused branch.

### Path: content → bg → popup

```
content emitState({paused:true, status:"Paused"})
  → chrome.runtime.sendMessage({ type: "CONTENT_STATE", paused: true, status: "Paused" })
  → router handleContentEvent
    → store.setPaused(true)
    → store.setStatus("Paused")
    → store.broadcast()
      → post({ type: "BACKGROUND_STATE_UPDATE", state: snapshot() })
        → popup applyState(state)
          → state.running && state.paused → setStateClass("paused")
            → statusEl.textContent = "Paused."
            → setActionLabel("Stop dubbing")
            → toggleBtn.classList.add("is-live")   // button stays live/orange
            → stopElapsedTimer()                   // clock freezes
```

**No new router code needed for the basic pause path. The channel already carries `paused` and the popup already renders it.**

---

## 3. Content → Background Protocol — `shared/protocol.ts`, `content/session-manager.ts`

### `ContentToBgMessage` union (`protocol.ts:94–113`)

```ts
| { type: "CONTENT_STATE"; running?: boolean; paused?: boolean; status?: string; errorMessage?: string; }
| { type: "CONTENT_ENDED"; reason?: string }
| { type: "CONTENT_STOP_REQUEST" }
| { type: "CONTENT_QUOTA"; mode?; used_credits?; cap_credits?; resets_at? }
| { type: "UPDATE_SETTINGS"; settings: Partial<Settings> }
| { type: "GET_YT_CC_URL"; videoId: string }
```

### `emitState` signature (`session-manager.ts:136–143`)

```ts
emitState(partial: {
  running?: boolean;
  paused?: boolean;
  status?: string;
  errorMessage?: string;
}): void {
  this.notifyBackground({ type: "CONTENT_STATE", ...partial });
}
```

### What content currently sends about state

| Call site | Message fields |
|---|---|
| `startWebRtcSession()` success | `{ running: true, paused: false, status: "Translating" }` |
| `subtitle-first-pipeline` start | `{ running: true, paused: false, status: "Translating" }` |
| `completeStandardHandover()` | `{ paused: wasPaused, status: "Paused"|"Translating" }` |
| video `play` event (WebRTC) | `{ running: true, paused: false, status: "Translating" }` |
| `stopSession()` | `{ running: false, paused: false, status: "Stopped" }` then `CONTENT_ENDED` |

### Can we add "switching"/"paused-video" without breaking the union?

Yes. `CONTENT_STATE.status` is an unconstrained `string`. The router writes it verbatim into `store.state.status`. The popup reads `state.status` only in the `connecting` branch (`statusEl.textContent = state.status || "Connecting"`) — all other branches hardcode their status text. So `status` is safe to extend freely.

For a new `"switching"` sub-state, two options:
1. **Use `status` only** — `emitState({ status: "Switching to next video…" })` while keeping `running: true, paused: false`. The popup `setStateClass("active")` branch (running, not paused) renders the status from `state.status` if we change the popup to use it. Currently the popup hardcodes `"Dubbing to ${langName}."` in the active branch — this would need to be changed.
2. **Add a new field to `CONTENT_STATE`** — e.g. `switching?: boolean`. The router pattern handles optional fields naturally.

**Recommended: use `status` as the signal, extend popup to show `state.status` in the active/paused branches when it is a "special" status.** This avoids a protocol addition entirely and is backward-compatible.

For `"paused-video"` vs user pause: the `status` string is sufficient as a UX differentiator. The store boolean `paused` is the structural signal; `status` is the human text.

---

## 4. Overlay States — `shared/ports.ts`, `content/overlay/overlay.ts`

### `OverlayState` type (`ports.ts:16`)

```ts
export type OverlayState = "ready" | "connecting" | "live" | "paused" | "error";
```

**`"paused"` already exists in the type.** It is NOT a new value.

### Where `"paused"` is used

- **`overlay.ts:785–793`** (`setOverlayState`):
  ```ts
  function setOverlayState(state: OverlayState): void {
    if (root) root.dataset.state = state;     // → CSS sees data-state="paused"
    if (state === "live" || state === "connecting") {
      if (sessionStartedAt == null) sessionStartedAt = Date.now();
      startElapsedTimer();
    } else if (state === "ready" || state === "error" || state === "paused") {
      stopElapsedTimer();   // clock stops
    }
  }
  ```
  Effect: `root.dataset.state = "paused"` drives CSS via `[data-state="paused"]` selector; the elapsed timer is stopped.

- **`content/index.ts:210`**: `this.overlay.setOverlayState(wasPaused ? "paused" : "live")` — after Standard handover.
- **`pipelines/webrtc-pipeline.ts:500`**: `overlay.setOverlayState(wasPaused ? "paused" : "live")` — same handover path.

### `setStatusText` channel

`overlay.ts:812–815`:
```ts
function setStatusText(text: string): void {
  if (elements.status) elements.status.textContent = text;
  if (!currentTargetText.trim()) paintTargetPane();  // uses status as placeholder
}
```

`[data-ec-status]` is the overlay status element. It is **separate** from the overlay state badge (`data-state`). The status text can say "Paused — video paused" while `data-state="paused"` controls the badge color/icon. Both can be set independently.

### "switching" in the overlay

There is **no "switching" OverlayState value today.** Options:
1. Add `"switching"` to the `OverlayState` union in `ports.ts` (requires updating the `setOverlayState` branch logic in `overlay.ts`). Clean separation, CSS-driven.
2. Reuse `"connecting"` with a different `setStatusText` ("Switching to next video…"). The elapsed timer would continue (not ideal — the session is nominally still running). Less clean.

**Recommended: add `"switching"` to `OverlayState`** (small change, clear semantics, keeps elapsed timer running since we'd add it to the `"live" | "connecting"` branch).

---

## 5. Popup Rendering — `src/popup/index.ts`

### How popup derives session state (the decision tree at `applyState:556–594`)

```ts
if (state.connecting) {
  setStateClass("connecting");
  statusEl.textContent = state.status || "Connecting";
  setActionLabel("Stop dubbing");
  toggleBtn.classList.add("is-live");
} else if (state.running && state.paused) {
  setStateClass("paused");
  statusEl.textContent = "Paused.";           // ← hardcoded
  setActionLabel("Stop dubbing");
  toggleBtn.classList.add("is-live");
} else if (state.running) {
  setStateClass("active");
  statusEl.textContent = `Dubbing to ${langName}.`;   // ← hardcoded
  setActionLabel("Stop dubbing");
  toggleBtn.classList.add("is-live");
} else if (state.errorMessage) {
  setStateClass("error");
  statusEl.textContent = state.errorMessage;
  setActionLabel("Start dubbing");
  toggleBtn.classList.remove("is-live");
} else {
  setStateClass("idle");
  // ... "Ready." / "Signed out" / "Sign in"
  setActionLabel("Start dubbing");
  toggleBtn.classList.remove("is-live");
}
```

### What currently flips the button back to "Start"

Only the `else` and `errorMessage` branches call `toggleBtn.classList.remove("is-live")`. A session is considered active (button stays "Stop") while `running || connecting`. The `paused` branch also adds `is-live` — so the button already says "Stop dubbing" while paused.

### How popup should look for new states

**"Paused (video paused)"** — `state.running = true`, `state.paused = true`:
- Current popup: `setStateClass("paused")`, `statusEl.textContent = "Paused."` ✓
- Needed: status line change from `"Paused."` to `state.status` (so content can send `"Paused — press play to resume"`)
- Button: "Stop dubbing" (already `is-live`) ✓ — user can still stop; play will resume
- Elapsed: frozen ✓

**"Switching to next video…"** — `state.running = true`, `state.paused = false`, `state.status = "Switching to next video…"`:
- Current popup: falls into `running && !paused` → `setStateClass("active")`, hardcoded `"Dubbing to ${langName}."` — **wrong**, needs to show the switching status
- Fix: in the `running && !paused` branch, check for a "special" status prefix, OR always show `state.status` when it is non-empty (and fall back to `"Dubbing to ${langName}."` only when status is generic)

**Recommended approach:** In the `running && !paused` branch, replace the hardcoded text with:
```ts
statusEl.textContent = state.status && state.status !== "Translating"
  ? state.status
  : `Dubbing to ${langName}.`;
```
This is backward-compatible: normal translation keeps `"Dubbing to ${langName}."` while any special status (switching, loading, etc.) surfaces directly.

---

## 6. Status Copy — `shared/product-copy.ts`, `lib/popup-format.ts`, `content/stop-reasons.ts`

### Existing strings

**`shared/product-copy.ts`** (4 strings):
- `ERR_NO_VIDEO_TAB` — "Open a page with video first (YouTube, Coursera, Udemy, …)."
- `TOAST_PRESS_PLAY` — "Press play on the video to start dubbing"
- `TOAST_NO_CC_FALLBACK` — "No captions — using live voice dubbing (~5s lag)"

**`content/stop-reasons.ts` `STOP_REASON_MESSAGE`** — exhaustive Record<StopReason, string>:
```ts
VIDEO_PAUSED: "Stopped",         // ← currently: full stop, not a pause
VIDEO_ENDED: "Video ended.",
SPA_NAVIGATION: "Page navigated.",
AUTO_STOP_60MIN: "Auto-stopped at 60 min — start again to continue.",
...
```

**`lib/popup-format.ts`** — pure computation helpers (no copy strings).

### Where new strings belong

The new feature introduces two classes of copy:

**1. Overlay status text** (set via `overlay.setStatusText()`):
- Content side, in `content/index.ts` or the pipeline/pause handlers.
- Recommend adding to `shared/product-copy.ts`:
  ```ts
  export const STATUS_PAUSED_VIDEO = "Paused — press play to resume";
  export const STATUS_SWITCHING_VIDEO = "Switching to next video…";
  export const STATUS_LOADING_NEXT = "Loading next video…";
  ```

**2. Popup status line**:
- Currently hardcoded in `popup/index.ts` as `"Paused."` and `"Dubbing to ${langName}."`.
- For paused: change `"Paused."` → `state.status` (so content drives the message).
- For switching: `state.status` surfacing (see §5 above).

**3. Stop-reason message**:
- `STOP_REASON.VIDEO_PAUSED: "Stopped"` — if pause/resume is implemented, this reason would no longer be emitted on video pause (the session stays alive). No change needed to the message itself; the reason just stops being used.

**i18n convention**: The codebase is English-only with no i18n framework. All copy is string literals. No convention other than "single source of truth in `product-copy.ts` for shared strings; inline literals in `popup/index.ts` for popup-only strings; `STOP_REASON_MESSAGE` for stop-reason strings."

---

## 7. Auto-Start — `background/auto-start.ts`

### Current auto-start logic

Triggers on `chrome.tabs.onUpdated` when:
1. `changeInfo.status === "complete"` (full load)
2. URL matches a supported watch URL (any platform via `isSupportedWatchUrl`)
3. User signed in (`store.state.signedInUser !== null`)
4. Host opted in (`advanced.autoStartHosts[host] === true`)
5. Nothing running/connecting (`!store.state.running && !store.state.connecting`)

Has a **1500ms per-tab debounce** to guard against SPA URL-change storms.

### Conflict with pause/resume

Gate 5 checks `state.running || state.connecting`. If the session is "paused" (`running: true, paused: true`), auto-start would be blocked — correct behaviour (session still alive). No conflict.

### Reuse for auto-next continuation

The auto-next feature (session continues on next video) needs something different: the existing session's content script handles the SPA navigation internally (the content script persists across YouTube SPA navigations as long as the tab doesn't fully reload). The auto-start listener would only trigger on a new page-load (`status: "complete"`), not a YouTube SPA click. So:

- **Auto-next on YouTube SPA**: handled in content by the SPA watcher (`startSpaWatcher`, `location.href !== this.lastSpaUrl`). Currently this calls `stopSession(STOP_REASON.SPA_NAVIGATION)`. For auto-next, it would need to instead emit a "switching" state, wait for the new video, and restart.
- **Auto-start listener**: only relevant when the user navigates to a new tab or hard-reloads. For auto-next, the content script's SPA watcher is the right hook — not the background listener.
- **Debounce**: the 1500ms debounce in auto-start would prevent double-fires on the same tab's SPA storm — reusable if the auto-next logic is ever routed through the background.

**Conclusion**: auto-start and auto-next are complementary but use different hooks. No conflict; no reuse of the auto-start listener for SPA-driven auto-next. The content SPA watcher is the natural insertion point.

---

## Summary & Recommended State Model

### Current `paused` wiring status

**Structurally complete, behaviourally dead.** The field exists in `State`, the router writes it, the popup renders it with a `"paused"` CSS class and a frozen elapsed timer, and the overlay has a `"paused"` state. However, **no code path in the normal flow ever sets `paused: true`** because video pause currently calls `stopSession(STOP_REASON.VIDEO_PAUSED)` — a full teardown. Only `completeStandardHandover()` briefly sets `paused: true` during mid-session voice/lang switches.

### Exact message/field path: content → bg → popup

```
content/index.ts onPause handler
  → currently: stopSession() → { running: false, paused: false } + CONTENT_ENDED
  → NEW: emitState({ paused: true, status: STATUS_PAUSED_VIDEO })
         + overlay.setOverlayState("paused") + overlay.setStatusText(STATUS_PAUSED_VIDEO)
         + suspend audio (mute/pause remote audio element)
  → router.handleContentEvent CONTENT_STATE
    → store.setPaused(true), store.setStatus("Paused — press play to resume")
    → store.broadcast()
  → popup applyState()
    → state.running && state.paused → setStateClass("paused")
    → statusEl.textContent = state.status    ← (requires popup change: use state.status, not hardcoded "Paused.")
    → toggleBtn is-live → "Stop dubbing"
    → stopElapsedTimer()
```

For resume (video `play` event):
```
content onPlay (already exists at content/index.ts:260–263, WebRTC path)
  → resume audio + emitState({ running: true, paused: false, status: "Translating" })
  → popup: running && !paused → setStateClass("active"), elapsed resumes
```

For switching video:
```
content SPA watcher fires (new URL)
  → currently: stopSession(SPA_NAVIGATION)
  → NEW: emitState({ status: STATUS_SWITCHING_VIDEO })  [running stays true, paused stays false]
         + overlay.setStatusText(STATUS_SWITCHING_VIDEO) + overlay.setOverlayState("switching")  ← new value
         → wait for new video element on new URL
         → re-init capture/pipeline (new session token) without rebuilding overlay
         → emitState({ running: true, paused: false, status: "Translating" }) on success
         OR emitEnded(…) on failure (triggers popup back to idle)
```

### Where new states/strings slot in

| Slot | File | Change |
|---|---|---|
| `STATUS_PAUSED_VIDEO` etc. | `shared/product-copy.ts` | Add 3 new export constants |
| `OverlayState` union | `shared/ports.ts:16` | Add `"switching"` |
| Overlay `setOverlayState` | `content/overlay/overlay.ts:787–793` | Add `"switching"` to elapsed-timer-running branch |
| Popup paused status text | `popup/index.ts:564` | `state.status` instead of `"Paused."` |
| Popup active status text | `popup/index.ts:570–572` | Show `state.status` when it's not the generic "Translating" |
| `STOP_REASON` | `content/stop-reasons.ts` | Add `SWITCHING_VIDEO = "switching-video"` and `NEXT_VIDEO_LOAD_FAILED = "next-video-load-failed"` |
| `STOP_REASON_MESSAGE` | `content/stop-reasons.ts` | Messages for new reasons |
| Video pause handler | `content/index.ts:244–249` | Replace `stopSession(VIDEO_PAUSED)` with pause/hold logic |
| SPA watcher | `content/index.ts:756–763` | Branch: if auto-next enabled, enter "switching" state instead of stopSession |

---

## Recommended State Model

The session is `running: true` the entire time. Sub-states are expressed through `(paused, status)` — no new boolean fields needed in `State`.

```
running=true × paused=false, status="Translating"   → "active"   → overlay: "live"
running=true × paused=true,  status="Paused — press play to resume"
                                                      → "paused"  → overlay: "paused"
running=true × paused=false, status="Switching to next video…"
                                                      → "active"  → overlay: "switching" (new)
running=true × paused=false, status="Loading next video…"
                                                      → "active"  → overlay: "switching"
running=false × ...                                  → "idle/error" → overlay unmounted
```

### Overlay rendering per sub-state

| Sub-state | `data-state` | Status text | Elapsed | Badge |
|---|---|---|---|---|
| active | `"live"` | "Translating" | running | orange/live |
| paused-by-video | `"paused"` | "Paused — press play to resume" | frozen | grey/paused |
| switching | `"switching"` (new) | "Switching to next video…" | running | amber? |
| stopped | `"ready"` | (overlay removed) | — | — |

### Popup rendering per sub-state

| Sub-state | `body[data-state]` | Status line | Button | Elapsed |
|---|---|---|---|---|
| active | `"active"` | `state.status` or "Dubbing to ${langName}." | "Stop dubbing" (is-live) | running |
| paused | `"paused"` | `state.status` ("Paused — press play to resume") | "Stop dubbing" (is-live) | frozen |
| switching | `"active"` | `state.status` ("Switching to next video…") | "Stop dubbing" (is-live) | running |
| idle/error | `"idle"/"error"` | "Ready."/"Error…" | "Start dubbing" | 00:00 |

**Key invariant:** The popup Stop button (`toggleBtn`) is gated only on `state.running || state.connecting`. While `running: true` (even during pause or switching), it always says "Stop dubbing". The user can always kill the session from the popup — this is correct and safe.

### What NOT to break

- `CONTENT_ENDED` must NOT fire during pause or switching — it clears `tabId` and triggers usage refresh. Only fire it when the session is truly over.
- The `sessionStartedAt` clock must remain set during pause/switching so the elapsed display is correct when it resumes.
- The `session.token` / `sm.pageToken` guard must remain valid during pause; bumping `pageToken` (as `stopSession` does) must NOT happen on pause.
- `sm.videoPaused` (SessionManager boolean, line 97) is the content-side guard that subtitle-first uses to skip rendering. It must be set to `true` on video pause and `false` on resume — this already exists in the subtitle-first pipeline (`sm.videoPaused || (video.paused && !isSystemPaused)` at `subtitle-first-pipeline.ts:576`).
