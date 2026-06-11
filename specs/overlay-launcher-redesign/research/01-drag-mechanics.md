# Research 01 — Overlay drag jank (root causes)

User complaint: "overlay cầm nắm mang đi chỗ khác quá giật" — dragging the dock/panel is janky.

## Code path (pointerdown → move → up)

- `bindDragResize` (overlay.ts:800–844) binds `pointerdown/move/up/cancel` on the handle
  (`[data-ec-drag]` dock, `[data-ec-panel-drag]` panel). `setPointerCapture` IS used. Good.
- `capturePointer` (overlay.ts:833) — one BCR at grab; origin = `layout.left ?? rect.left`.
- **Every `pointermove`** (overlay.ts:814–819): `layout.left/top = origin + delta` then
  **synchronous `applyLayout()`** — the full layout pipeline:
  `clampLayout` → panel.hidden → 2× `classList.toggle` → `syncCaptionToggleUi()` (setAttribute)
  → `applyStageAnchors()` → `anchorChrome(dock)` + `anchorChrome(panel)`, each doing
  `getBoundingClientRect()` (**forced reflow**, via `measuredChrome` overlay.ts:247–258)
  then `style.left/top` writes (**layout write**). No rAF batching anywhere.
- `pointerup` → `endDrag`: `dockUserPlaced = true`, `saveLayout()` (localStorage **only here** — correct).

## Ranked root causes

1. **CSS transitions on the dragged properties** — `.ec-dock { transition: left .15s ease, top .15s ease, opacity .15s }` (overlay.css:79) and `.ec-panel { transition: left .15s, top .15s, opacity .2s }` (overlay.css:660). Every move restarts a 150 ms ease toward the new position → the element *chases* the cursor. There is **no dragging class that disables transitions** (the launcher already does this correctly with `.ec-launcher-dragging { transition: none }`).
2. **Forced reflow per move** — `measuredChrome` → `getBoundingClientRect()` on dock *and* panel on every pointermove, interleaved with style writes = layout thrash at pointer-event frequency (120+ Hz on fast mice).
3. **No rAF coalescing** — multiple pointermoves per frame each run the full pipeline.
4. **MutationObserver feedback loop** — `watchMediaStage` (media-stage.ts:232–243) observes `document.documentElement` `attributeFilter: ["class","style"]`; our own per-move `style.left` writes re-trigger `schedule()` → `emit` → `onUpdate` → `applyLayout()` again (rAF-coalesced, but one extra layout pass per drag frame).
5. **Initial-grab jump** — if a 150 ms transition is mid-flight at pointerdown, `layout.left` (target) ≠ `rect.left` (rendered); origin prefers `layout.left`, so the element snaps on first move.
6. (Minor) `backdrop-filter: blur(16px)` on `.ec-dock` (overlay.css:73) makes every repaint expensive; `left/top` movement forces layout+paint instead of compositor-only transform movement.

## Shared-coordinate gotcha

Dock and panel are both anchored from the **same** `layout.left/top` (overlay.ts:290 `rawLeft = trackVideo ? def.left : (layout.left ?? def.left)`), with per-element clamping in `anchorChrome`. Dragging either handle moves the shared coordinate → **both elements reposition together**. Any per-move fast path must move both nodes.

## Must keep working

- `saveLayout()` on pointerup only; `dockUserPlaced` set on drag end.
- Stage tracking (`watchMediaStage` ResizeObserver/MO/400 ms poll) re-anchors when NOT dragging — window resize, fullscreen, SPA layout shifts.
- Out-of-stage reset guard (overlay.ts:278–287, >48 px outside video rect → position reset) must not fire mid-drag.
- Caption stack placement (`ec-caption-top`, `captionOnVideo`) — uses transform, unaffected, but is needlessly re-synced per move today.
- `.ec-root` invariants (0×0 fixed host, no transform/filter/contain) — guarded by `test/ui/overlay-root-no-fullscreen.test.ts`.
