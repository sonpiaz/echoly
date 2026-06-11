# Research 02 — Quick-start launcher (right-edge button)

User complaint: "button dịch nhanh bên phải chưa tinh tế, nhỏ không phù hợp với nhiều loại màn hình".

## Current design (overlay.css:549–621, launcher.ts)

- `position: fixed`, default `right: 0; top: 50%; transform: translateY(-50%)` — flush to the
  right viewport edge, vertically centered. `border-radius: 6px 0 0 6px` (left-rounded tab).
- Painted area = `.ec-launcher-mark` span: **22×26 px fixed** (`LAUNCHER_W=22`, `LAUNCHER_H=26`,
  launcher.ts:21). Icon = 4-bar waveform SVG at **12×12 px**, white stroke 2.2.
- Background `linear-gradient(135deg, rgba(255,122,60,.9), rgba(242,91,23,.94))` (brand tangerine).
- Rest opacity **0.78**; hover/active 1.0. `transition: opacity .16s ease` only.
- Drag: pointer events + `setPointerCapture`, `DRAG_THRESHOLD_PX=5`, `#suppressClick` guard,
  `.ec-launcher-dragging { transition: none; cursor: grabbing }` — **already jank-free**.
  Persist `{left, centerY, userPlaced}` to `localStorage["echolyLauncherPos"]` on pointerup only.
- Clamping (`clampLauncherPos` launcher.ts:64–75) uses the **hard-coded 22/26 constants** +
  `VIEWPORT_PAD=8`. `#onResize` re-clamps + **saves localStorage synchronously per resize event**
  (no debounce) when userPlaced.
- z-index 2147483646. Appended to `document.body`, **outside `.ec-root`** → `--ec-*` CSS vars
  are NOT available; colors must stay hard-coded literals.
- a11y: `title="Lồng tiếng với Echoly · giữ và kéo để di chuyển"`, `aria-label="Bắt đầu lồng
  tiếng với Echoly"`; native button focus but **no `:focus-visible` style**, no keyboard drag.

## State machine / contracts (MUST PRESERVE)

- Visibility = `signedIn && !starting && !app.sm.session && hasVideo()` (launcher.ts:153–159);
  `hasVideo()` = `adapter.findVideo() ?? capture.findVideo()`.
- 20 s tick (`KEEPALIVE_MS=20_000`) sends `GET_LAUNCH_STATE` — **dual-purpose MV3
  service-worker keepalive (P2)**; must keep firing regardless of visual state.
- Click → `chrome.runtime.sendMessage({type:"START_REQUEST"})` fire-and-forget (router.ts:81–86
  → `deps.session.start()`); optimistic hide + `START_OPTIMISTIC_HIDE_MS=3000` reset.
- `refresh()` called from content/index.ts on session start/stop; `visibilitychange` tick.
- Existing tests (test/content/launcher.test.ts, untracked): default `right === "0"` &&
  `top === "50%"`; post-drag persistence `{userPlaced: true, left: number}` and `style.left`
  matches `/^\d+px$/`; BCR mock hard-codes 22×26.

## Why it reads as unrefined / too small

1. 22×26 px is far below the 44 px WCAG 2.5.5 pointer-target minimum; microscopic on 1080p+,
   worse at 125 % Windows zoom.
2. Fixed px — no `clamp()`/vh/media queries; same sliver on 1366×768 and 4K.
3. Rest opacity 0.78 + tiny size = invisible/forgettable; icon-only with hover-only tooltip
   (useless on touch).
4. Flush `right: 0` can sit against/behind classic Windows scrollbars; zero breathing room.
5. No entrance/exit animation (abrupt appendChild/remove), no pressed feedback beyond opacity,
   no focus ring, no label.

## Risks for redesign

- Changing dimensions/default offset requires updating launcher.test.ts assertions and the BCR
  mock (acceptable — test is part of this working tree, not a ratified external contract).
- If CSS sizing becomes fluid (`clamp()`), the JS clamping math must measure the real rendered
  size (BCR at drag-start/resize) instead of trusting the 22/26 constants.
- Keepalive tick must continue even when hidden/collapsed.
- CSS is page-global (manifest injection, no shadow DOM) — keep `ec-` prefix, explicit resets.
