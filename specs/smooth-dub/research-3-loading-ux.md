# Research 3 — Overlay Loading UX

**Slice:** Branded loading / buffering animation on the Echoly overlay logo  
**Branch base:** wave/platform-adapters (or current develop)  
**Date:** 2026-06-02

---

## 1. What the user sees today — the loading gap

### 1a. WebRTC path (Realtime + Standard WebRTC)

**Press Start → audio playing** goes through these status strings and overlay states
(traced through `src/content/index.ts` lines 375–503 and `src/content/pipelines/webrtc-pipeline.ts` lines 125–126):

| Wall-clock phase | `data-state` on `.ec-root` | `[data-ec-status]` text | Visual |
|---|---|---|---|
| `buildOverlay()` called | `"ready"` (default) | `"Ready"` | Dock appears, live-dot purple-pulse |
| `overlay.setStatusText("Acquiring audio")` | still `"ready"` | `"Acquiring audio"` | No state change |
| Non-live VOD only: `overlay.setStatusText("Connecting")` | still `"ready"` | `"Connecting"` | No state change |
| `webrtc.buildSession()` calls `setOverlayState("connecting")` | **`"connecting"`** | `"Connecting"` | live-dot turns pink |
| `buildSession()` returns, `setOverlayState("live")` | `"live"` | `"Almost ready"` (VOD) or `"Translating"` (live) | live-dot stays pink |
| Standard VOD: `setStatusText("Preparing dub")` during `waitForFirstDub()` | `"live"` | `"Preparing dub"` | No additional indicator |
| `video.play()` succeeds | `"live"` | `"Translating"` | Running |

**Gap:** Between `buildOverlay()` and the first `setOverlayState("connecting")` — typically 0.5–2s while `captureWithRetry` acquires the audio stream — the status text says "Acquiring audio" but the state is still `"ready"`. There is no spinner or animation on the logo mark during this window. The live-dot just pulses at its default purple.

### 1b. Subtitle-first pipeline (YouTube/Coursera VOD)

Traced through `src/content/pipelines/subtitle-first-pipeline.ts`:

| Phase | `data-state` | Status text | Duration |
|---|---|---|---|
| `overlay.buildOverlay()` → initial | `"ready"` | `"Ready"` | instant |
| `setOverlayState("connecting")` | **`"connecting"`** | `"Loading captions"` | ~0.5–1.5s (fetch) |
| `setStatusText("Translating N lines")` | `"connecting"` | `"Translating N lines"` | while `#renderBatch()` runs — can be 2–8s on slow connections |
| First batch done, `setOverlayState("live")` | `"live"` | `"Translating"` | Running |

**Gap:** The `connecting` → `live` transition encompasses the entire caption-fetch + first-batch TTS pre-buffer window. This is the longest loading phase (2–8s). The status text changes but the **logo mark is completely static** throughout.

### 1c. Pause/resume

- `pauseSession()` → `setOverlayState("paused")`, `setStatusText("Paused — press play to resume")`  
  Live-dot turns amber (`#c77b00`), animation stops. Logo mark: **static**.

- `resumeSession()` (normal) → `setOverlayState("live")`, status `"Translating"`  
  Immediate — no reconnecting phase.

- `resumeSession()` when `sm.connectionLost` (WebRTC died during pause) → calls `continueOnNewVideo` which calls `buildSession` which calls `setOverlayState("connecting")` again.  
  **Gap:** the overlay briefly shows `"connecting"` with no loading indicator on the logo.

### 1d. System-pause (subtitle-first buffering)

When a cue has no buffer yet, `#enterSystemPause()` (`subtitle-first-pipeline.ts:528`) calls:
```ts
this.app.overlay.setStatusText("Buffering…");
```
The `data-state` does NOT change — it stays `"live"`. There is no dedicated `"buffering"` state. No animation on the logo, no distinct visual.

### 1e. Handover (lang/voice change)

`webrtc-pipeline.ts:589` → `setOverlayState("connecting")` during reconnect, then back to `"live"` or `"paused"`.

---

## 2. Current `OverlayState` enum

Defined in `src/shared/ports.ts:16`:

```ts
export type OverlayState = "ready" | "connecting" | "live" | "paused" | "switching" | "error";
```

**Meaning per state (from overlay.ts:785-796):**

| State | Clock | live-dot color | live-dot animation |
|---|---|---|---|
| `"ready"` | stopped | purple `#8b5bff` | ec-pulse (scale+opacity) |
| `"connecting"` | starts (if sessionStartedAt null, sets it) | pink `#ff6fb1` | ec-pulse |
| `"live"` | starts | pink `#ff6fb1` | ec-pulse |
| `"switching"` | keeps running | pink `#ff6fb1` | ec-pulse |
| `"paused"` | stopped | amber `#c77b00` | **none** |
| `"error"` | stopped | red `#c73c5b` | **none** |

**Missing:** There is no `"buffering"` state. The subtitle-first `"Buffering…"` text fires while state stays `"live"`. A build agent may want to either (a) add a new `"buffering"` state or (b) hook into the existing `"connecting"` CSS selector and extend it to also cover a `"buffering"` class.

---

## 3. DOM structure — where loading animation hooks in

### 3a. The logo mark element

The logo mark (the Echoly waveform icon) lives in **two places** in the template (`src/content/overlay/template.ts`):

**Dock (mini pill, always visible when panel closed):**
```html
<span class="ec-dock-mark" aria-hidden="true">
  <svg viewBox="0 0 24 24" …>
    <path d="M7 9v6M11 6v12M15 8v8M19 11v2"/>
  </svg>
</span>
```
CSS: `src/content/overlay/overlay.css:64-79`
```css
.ec-dock-mark {
  width: 20px; height: 20px; border-radius: 5px;
  background: linear-gradient(135deg, #ff9764 0%, #ff6fb1 55%, #8b5bff 100%);
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.ec-dock-mark svg { width: 12px; height: 12px; color: #fff; }
```

**Panel header (expanded panel, `.ec-panel-mark`):**
```html
<span class="ec-panel-mark" aria-hidden="true">
  <svg viewBox="0 0 24 24" …>…</svg>
</span>
```
CSS: `overlay.css:378-392` — same gradient background, `width:18px height:18px`.

### 3b. Target hook: `.ec-dock-mark` and `.ec-panel-mark`

Both marks are the **primary brand surface** — the orange→pink→purple gradient square with the waveform bars SVG. These are the natural home for a loading animation.

**Hook selectors:**
```css
/* While connecting or buffering — animate the dock mark */
.ec-root[data-state="connecting"] .ec-dock-mark,
.ec-root[data-state="connecting"] .ec-panel-mark { … }
```

Because `data-state` is already set as `root.dataset.state = state` (`overlay.ts:786`), the CSS selector approach is zero-JS — just add CSS rules.

### 3c. The live-dot (secondary signal)

`.ec-live-dot` (`overlay.css:81-116`) already pulses with `ec-pulse` during active states. It changes color per state. This is a secondary channel — the dock-mark is the primary branded element.

### 3d. Status text line

`[data-ec-status]` / `.ec-state` — the small grey text ("Ready", "Connecting", "Buffering…") is already in the dock. No changes needed here; it already reflects the correct copy.

---

## 4. CSS approach — how the build agent must extend it

### 4a. Conventions

- All classes use `.ec-` prefix (no exceptions; this is the XSS-safe imperative-DOM codebase)
- CSS lives exclusively in `src/content/overlay/overlay.css` — imported by `src/entrypoints/content/index.ts:11` and injected via WXT's `cssInjectionMode: "manifest"` as a stable stylesheet at `content-scripts/content.css`
- No CSS framework, no preprocessor — plain CSS with CSS custom properties (`--v` for slider fill)
- State is communicated via `data-state` attribute on `.ec-root` and via explicit class toggles (`.ec-panel-open`, `.ec-caption-off`, `.ec-caption-top`)
- `@keyframes` names use `ec-` prefix (see `ec-pulse`, `wave-0` through `wave-4`)
- `@media (prefers-reduced-motion: reduce)` block at the bottom of the file silences `ec-pulse` — any new animations MUST be added to this block
- NO inline styles for animation — all animation via CSS rules so `prefers-reduced-motion` works

### 4b. Existing animation inventory

| Name | Where | Description |
|---|---|---|
| `ec-pulse` | `.ec-live-dot` | Scale + opacity pulse, 1.4s infinite |
| `wave-0` … `wave-4` | `.ec-panel-wave i` | Equalizer bars, staggered 0.7–1.42s |

### 4c. Proposed new animations (for build agent reference)

Three approaches for the `.ec-dock-mark` / `.ec-panel-mark` logo:

**Option A — Spin ring overlay** (non-destructive, preserves gradient background):
- Add a `::after` pseudo-element on `.ec-dock-mark` that draws a `conic-gradient` or `border` spinner ring around the square's rounded edges
- Triggered by `[data-state="connecting"] .ec-dock-mark::after`

**Option B — SVG waveform breathing animation**:
- Animate the `stroke-dashoffset` or `opacity` of the existing `<path>` elements inside `.ec-dock-mark svg` to pulse in sequence, creating a "thinking" waveform effect
- Use CSS `nth-child` if the SVG paths were split into individual `<path>` elements (currently they are one `<path>` — would need template change OR animate at the `svg` level)

**Option C — Brightness/opacity pulse on the whole mark** (simplest, zero template change):
```css
@keyframes ec-mark-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%       { opacity: 0.7; transform: scale(0.93); }
}
.ec-root[data-state="connecting"] .ec-dock-mark,
.ec-root[data-state="connecting"] .ec-panel-mark {
  animation: ec-mark-pulse 0.9s ease-in-out infinite;
}
```
Cleanest to implement with zero template changes.

**Option D — Spinner ring (recommended for "intentional wait" feel)**:
```css
@keyframes ec-spin {
  to { transform: rotate(360deg); }
}
.ec-root[data-state="connecting"] .ec-dock-mark::after {
  content: "";
  position: absolute;
  inset: -3px;
  border-radius: 8px; /* slightly more than the 5px of .ec-dock-mark */
  border: 2px solid transparent;
  border-top-color: #ff9764;
  border-right-color: #ff6fb1;
  animation: ec-spin 0.8s linear infinite;
  pointer-events: none;
}
```
Requires `.ec-dock-mark { position: relative; }` (currently not set — add it).

---

## 5. States that need a distinct visual — recommendations

| Scenario | Current state | Current visual | Recommended treatment |
|---|---|---|---|
| Acquiring audio (pre-connecting) | `"ready"` | static logo, purple dot | Set state to `"connecting"` earlier (in `startWebRtcSession` before `captureWithRetry`) OR add spinner at `"ready"` after `buildOverlay` is called |
| WebRTC connecting / signaling | `"connecting"` | pink dot, static logo | **Spinner on `.ec-dock-mark`** |
| Caption fetch + initial TTS batch (subtitle-first) | `"connecting"` | pink dot, static logo | **Spinner on `.ec-dock-mark`** — already using `"connecting"` ✓ |
| Standard VOD "Preparing dub" (waitForFirstDub) | `"live"` | running logo, no wait indicator | Either keep `"connecting"` through this phase OR add a `"buffering"` state; otherwise a spinner at `"connecting"` already covers the prior phase |
| System-pause buffering (subtitle-first) | `"live"` + status "Buffering…" | static logo | **Add `"buffering"` state** (simple OverlayState extension) OR use a CSS class `.ec-root.ec-buffering` toggled at `#enterSystemPause` / `#resumeSystemPause` |
| Paused by user | `"paused"` | amber dot, no animation | Logo mark could dim (opacity: 0.65) — already visually distinct via amber dot |
| Reconnecting after pause (connectionLost) | `"connecting"` | spinner coverage above ✓ | covered |
| Handover (lang/voice change) | `"connecting"` | spinner coverage above ✓ | covered |
| Error | `"error"` | red dot, caption red | No spinner needed (terminal state) |

**Minimum viable set:**
1. Spinner (or Option C pulse) on `.ec-dock-mark` + `.ec-panel-mark` for `[data-state="connecting"]` — covers initial connect, subtitle-first loading, and handover
2. Either a new `"buffering"` OverlayState or a `.ec-buffering` toggle class — covers subtitle-first micro-pauses while remaining decoupled from the locked OverlayState type

---

## 6. Logo asset location

| Asset | Path | Usage |
|---|---|---|
| Extension icon PNG (toolbar, store) | `src/public/icons/icon-{16,32,48,128}.png` | Manifest icons only |
| Brand SVG (toolbar popup) | `src/public/icons/brand.svg` | Not used in the overlay |
| In-overlay logo mark | Inline SVG in `OVERLAY_TEMPLATE` (`template.ts:46-49`) | The waveform bars (`<path d="M7 9v6M11 6v12M15 8v8M19 11v2"/>`) |

The overlay does **not** use the `brand.svg` file. The waveform is drawn as an inline SVG `<path>` (4 vertical bars) inside `.ec-dock-mark` and `.ec-panel-mark`. The brand gradient comes from CSS (`background: linear-gradient(135deg, #ff9764 0%, #ff6fb1 55%, #8b5bff 100%)`).

---

## 7. Cross-slice concerns (status events to watch)

### 7a. OverlayState type is a locked contract

`src/shared/ports.ts:16` defines `OverlayState`. Adding `"buffering"` requires:
1. Edit `ports.ts:16` — add `"buffering"` to the union
2. Edit `overlay.ts:787-796` — add `"buffering"` to the clock logic (should NOT start or stop elapsed timer — it's a sub-live state)
3. Add CSS rule `[data-state="buffering"]` to `overlay.css`

This is a small isolated change. The locked seam comment says "legacy values" so the union can extend.

### 7b. Where to emit `"buffering"` state

`subtitle-first-pipeline.ts:530` — `#enterSystemPause` already calls:
```ts
this.app.overlay.setStatusText("Buffering…");
```
Add `this.app.overlay.setOverlayState("buffering")` here.  
And in `#resumeSystemPause` (line 543): `this.app.overlay.setOverlayState("live")`.

### 7c. The `"Acquiring audio"` gap (pre-connecting)

`src/content/index.ts:375`:
```ts
overlay.setStatusText("Acquiring audio");
stream = await capture.captureWithRetry(video);
```
State is still `"ready"` here. **Simplest fix:** call `overlay.setOverlayState("connecting")` immediately before `setStatusText("Acquiring audio")`. The clock logic in `overlay.ts:787` starts `sessionStartedAt` on `"connecting"` — that is acceptable since the session is genuinely in progress.

### 7d. `"Preparing dub"` phase (Standard WebRTC VOD)

`src/content/index.ts:469`:
```ts
overlay.setStatusText("Preparing dub");
await this.standardDubSync!.waitForFirstDub();
```
State is `"live"` at this point (set at line 446). This gives a false impression of a running session before audio actually plays. Consider: keep state as `"connecting"` until `waitForFirstDub` resolves, then transition to `"live"`. This requires shifting line 446 (`setOverlayState("live")`) to after `waitForFirstDub`.

### 7e. `continueOnNewVideo` (auto-next)

`webrtc-pipeline.ts:494` calls `buildSession` → `setOverlayState("connecting")` — already covered by the dock-mark spinner.

### 7f. `setOverlayState` is called by `handleMetadataEvent` on first translation packet

`webrtc-pipeline.ts:386` — `setOverlayState("live")` fires on the first `partial_translation` event. This is the definitive "audio has started" signal. The spinner should stop here.

---

## 8. File:line summary for build agent

| File | Line(s) | What |
|---|---|---|
| `src/shared/ports.ts` | 16 | `OverlayState` type — add `"buffering"` |
| `src/content/overlay/overlay.ts` | 785–796 | `setOverlayState` clock logic — add `"buffering"` branch (no clock change) |
| `src/content/overlay/template.ts` | 43–134 | `OVERLAY_TEMPLATE` — `.ec-dock-mark` at line 44, `.ec-panel-mark` at line 67 |
| `src/content/overlay/overlay.css` | 64–79 | `.ec-dock-mark` styles (add `position: relative`) |
| `src/content/overlay/overlay.css` | 378–392 | `.ec-panel-mark` styles (add `position: relative`) |
| `src/content/overlay/overlay.css` | 81–116 | Existing `ec-pulse` + state-keyed dot colors — add new `ec-mark-pulse` / `ec-spin` keyframes and `[data-state="connecting"]` rules |
| `src/content/overlay/overlay.css` | 795–799 | `prefers-reduced-motion` block — add new animations here |
| `src/content/pipelines/subtitle-first-pipeline.ts` | 527–548 | `#enterSystemPause` / `#resumeSystemPause` — emit `"buffering"`/`"live"` |
| `src/content/index.ts` | 375 | Before `captureWithRetry` — emit `"connecting"` early |
| `src/content/index.ts` | 446–469 | Standard VOD `waitForFirstDub` — keep `"connecting"` until dub is ready |

---

## 9. Non-issues / out of scope

- The `brand.svg` file is not used by the overlay — no changes needed there
- The popup (`src/entrypoints/popup/style.css`, `src/popup/`) is a separate DOM, not the overlay — out of scope
- Shadow DOM: there is none. Everything is imperative DOM under `document.body` (or `document.documentElement` fallback) — CSS selector specificity is standard
- The `ec-panel-wave` animation (equalizer bars in the expanded panel, `overlay.css:487–516`) is a SEPARATE animation from the dock-mark; it already plays continuously during live — do not add loading semantics to it
