# SOLUTION — Smooth overlay drag + refined responsive quick-launcher

Status: **RATIFIED** — critic round 1 REVISE → round 2 REVISE → round 3 **APPROVE** (residual minor null-guard incorporated)

> **ITERATION 1 (post-ship user feedback, same day).** The §B·1 clamp() floating pill read as a
> large orange blob on real pages ("xấu thế? để nhỏ gọn thôi đơn giản dễ nhìn cố định bên cạnh
> màn hình"). Launcher visual re-done as a **compact fixed-size docked tab**: `.ec-launcher-mark`
> fixed 26×48 px, `border-radius: 12px 0 0 12px`, `border-right: none`, softer shadow, no hover
> scale, icon 13 px, rest opacity .85; default inline position back to flush `right: 0`;
> `LAUNCHER_W/H = 26/48`. Everything else from Part B (label chip, focus ring, entrance-on-mark,
> measured clamping, debounced saves, behavior contracts) unchanged. Additionally, per user rule
> "all extension UI labels in English": label chip → "Start dubbing", title → "Dub with Echoly ·
> hold and drag to move", aria-label → "Start dubbing with Echoly". Tests updated accordingly
> (default right "0px", BCR mock 26×48, fixed-size CSS contract instead of clamp()).

> **ITERATION 2 (same day).** User: the persisted free-drag position left the tab floating
> mid-page, and dragging should be vertical-only ("di chuyển chỉ lên xuống thôi k rời bên phải").
> Drag is now **vertical-only**: the button never leaves `right: 0`; only `top` (centerY) moves
> and persists. `LauncherPos` dropped the `left` field (old records' `left` is ignored on load —
> stale mid-screen placements self-heal). `clampLauncherPos` → `clampLauncherCenterY(centerY, vh,
> h = LAUNCHER_H)`; `#measuredSize` → `#measuredHeight`; horizontal pointer delta only counts
> toward the click-vs-drag threshold. Tests updated (vertical-only drag asserts right stays
> "0px"/left "auto", stored.left undefined, exact centerY).

> **ITERATION 3 (same day).** User: 26×48 too hard to click ("hơi nhỏ, click vào khá khó").
> Mark grew to **30×56** (radius 14, icon 14px) and the button gained an invisible **click halo**
> (`padding: 8px 0 8px 10px`, transparent, right stays 0) → real hit target ≈ 40×72 px while the
> painted tab stays slim. Hover/focus now deepens the mark shadow. Also fixed a latent bug: both
> entrance animations used fill `both`, which pins final keyframe values forever (overriding any
> later hover/inline transform) — switched to `backwards`, with a CSS-contract test banning
> both/forwards on the launcher animations. `LAUNCHER_H` fallback → 72 (mark + halo).
Scope: `extension/` only. No version bump (ECHOLY_VERSION stays `0.6.4-dub-e2e`). No manifest changes.

## Problem

1. **Overlay drag is janky** ("cầm nắm mang đi chỗ khác quá giật"). Root causes (research/01):
   - R1: `.ec-dock` / `.ec-panel` have `transition: left .15s ease, top .15s ease` (overlay.css:79, 660)
     which fires on every pointermove → element chases the cursor with 150 ms lag. No dragging class
     suppresses it (the launcher already has `.ec-launcher-dragging { transition: none }` — the dock doesn't).
   - R2: every pointermove runs the **full** `applyLayout()` pipeline: `getBoundingClientRect()` on dock
     AND panel (forced reflow, `measuredChrome`), caption re-anchor, `syncCaptionToggleUi`, class toggles.
     No rAF coalescing.
   - R3: **first-drag snap-back bug** — during the first drag `layout.dockUserPlaced` is still `false`,
     so `anchorChrome` takes the `trackVideo` branch (overlay.ts:289–296), repositions to the DEFAULT
     stage position and overwrites `layout.left/top` on every move. The dock fights the user for the
     whole first drag and the saved drop position is wrong.
   - R4: our own per-move `style` writes re-trigger `watchMediaStage`'s MutationObserver →
     `onUpdate` → another `applyLayout()` per frame (feedback loop).
2. **Quick-launcher button is unrefined and too small** (research/02): fixed 22×26 px painted area
   (below the 44 px WCAG pointer-target floor), icon 12 px, rest opacity 0.78, flush `right: 0`
   (scrollbar collision), no responsive sizing, no entrance animation, no focus ring, no label.
   JS clamping hard-codes the 22/26 constants.

## Chosen approach

### Part A — drag fast path (overlay.ts + overlay.css)

During an active drag, bypass the full layout pipeline; run a minimal, pure-math, rAF-coalesced
position writer. Full `applyLayout()` runs once at drop.

1. **`.ec-dragging` class** on BOTH `.ec-dock` and `.ec-panel` for the duration of the drag.
   CSS: `.ec-dock.ec-dragging, .ec-panel.ec-dragging { transition: none; }` (compound selector —
   wins specificity over the base rules). Existing left/top transitions stay for non-drag
   stage re-anchoring.
2. **pointerdown — STRICT ordering** (critic #4):
   (1) `classList.add("ec-dragging")` on dock + panel →
   (2) force reflow `void dockEl.offsetWidth` (flushes `transition: none`, snapping any in-flight
       150 ms transition to its inline target so rendered position == `layout.left`) →
   (3) `capturePointer()` (origin stays `layout.left ?? rect.left` — unchanged math) →
   (4) cache `dragDims = { dock: measuredChrome(dockEl, DOCK_W, DOCK_H), panel: measuredChrome(panelEl, PANEL_W, PANEL_H) }`
       (the only BCRs of the whole drag; dims cannot change mid-drag — there is no resize path,
       `PointerOrigin.width/height` are vestigial legacy fields, do NOT add width/height writes) →
   (5) `setPointerCapture`, `dragActive = true`.
3. **rAF-coalesced fast path**: `pointermove` only updates `layout.left/top` (origin + delta,
   unchanged math) and schedules ONE `requestAnimationFrame` → `applyDragPosition()`:
   - `layout = clampLayout(layout, innerWidth, innerHeight)` (pure, template.ts).
   - Determine the SINGLE visible dragged element (critic #6): when `layout.panelExpanded` the dock
     is `display:none` (overlay.css `.ec-panel-open .ec-dock`) → write the PANEL only, with
     `dragDims.panel`; when collapsed → write the DOCK only, with `dragDims.dock`. Never both.
   - Position math, mirroring `anchorChrome` exactly (critic #1, #2):
     `pos = stageSnapshot
        ? clampDockToStage(layout.left, layout.top, stageSnapshot, dims.w, dims.h)   // MUST pass dragDims, not DOCK_W/H
        : { left: layout.left ?? Math.max(8, innerWidth - dims.w - 12), top: layout.top ?? 12 }  // null-guarded no-stage fallback`
     then write `style.left/top` (px), `style.right = "auto"`.
   - Nothing else: no caption sync, no class toggles, no `anchorChrome`, no BCR. (Kills R2; fixes R3
     structurally — the `trackVideo` branch is never consulted mid-drag and `layout.left/top` is
     never overwritten with the default.)
   - **rAF call-time contract** (critic r2 #4): the scheduling MUST call
     `requestAnimationFrame` / `cancelAnimationFrame` dynamically at call time (globals resolved when
     invoked) — do NOT copy the module-load-captured alias pattern from media-stage.ts:176–184, or
     the A2 manual-flush test stub cannot intercept it.
   - Snap-on-drop: dock dims are *normally* stable during a drag, so the drop-commit re-measure
     yields the same clamp result; content-driven width changes mid-drag (state chip / elapsed text,
     critic r2 #3) can shift the clamp boundary by a few px at drop — accepted, imperceptible.
4. **Stage-update deferral**: module-level `dragActive` flag. The `watchMediaStage` callback
   (overlay.ts:770) keeps storing `stageSnapshot` but returns without `applyLayout()` while
   `dragActive`; `onWindowResize` likewise. Drop applies the latest snapshot. (Kills R4.)
5. **Drop commit** (`endDrag`, fires on pointerup AND pointercancel — same semantics as today,
   critic #5) — STRICT ordering (critic #7; reworked per critic r2 #1 — NO suppression flag):
   (1) cancel pending rAF, flush `applyDragPosition()` once →
   (2) **clamp write-back** — when `stageSnapshot` exists AND coords are non-null (plain click with
       zero pointermoves on a never-positioned overlay can leave them null — degrade through
       `anchorChrome`'s existing `?? def.left` path in that corner, matching today):
       `if (stageSnapshot && layout.left != null && layout.top != null) {
          const p = clampDockToStage(layout.left, layout.top, stageSnapshot, dims.w, dims.h);
          layout.left = p.left; layout.top = p.top;
        }` (dims = the visible dragged element's `dragDims`). `layout.left/top` are now inside the stage **by construction**, so the
       >48 px out-of-stage reset in `anchorChrome` cannot fire — neither during the drop's
       `applyLayout()` (which calls `anchorChrome` twice, dock AND panel) nor on the next
       MutationObserver/400 ms-poll pass. The reset stays fully intact for its real purpose
       (stale persisted layouts vs new stage geometry). Persistence now equals the visible
       position (fixes the old behavior where the raw pointer position was saved). →
   (3) `layout.dockUserPlaced = true`; `saveLayout()` (persistence stays drag-end-only) →
   (4) `dragActive = false`; full `applyLayout()` →
   (5) force reflow `void el.offsetWidth` on the visible dragged element →
   (6) ONLY THEN `classList.remove("ec-dragging")` from both. Steps 5 and 6 must not be inverted —
       inverting re-animates the commit over 150 ms (the original bug at drop).

Rejected alternatives:
- *Transform-delta compositor drag* (per-move `translate3d`, commit left/top at drop): marginal gain
  once transitions + reflows + redundant pipeline are gone; the commit-swap adds real risk. Not needed.
- *Migrating dock positioning to `transform` entirely*: blast radius across clamping/persistence/
  anchoring for no user-visible gain.
- *Touching `media-stage.ts`*: deferral inside overlay.ts achieves the same during drag with zero
  risk to stage tracking used elsewhere.
- *Revert-on-pointercancel*: changes long-standing semantics beyond the complaint's scope.

### Part B — launcher redesign (launcher.ts + overlay.css launcher section)

Refined floating vertical pill, responsive via CSS `clamp()`, JS clamps with measured size.

1. **Geometry**: default `right: 10px; top: 50%; transform: translateY(-50%)` (was flush `right: 0`).
   **The `10px` default offset is written as INLINE style by `#applyPos`'s default branch in
   launcher.ts (Agent B), not by CSS** (critic r2 #5 — the test asserts `btn.style.right === "10px"`).
   Fully rounded pill `border-radius: 999px`. Painted size on `.ec-launcher-mark`:
   `width: clamp(30px, 2.2vw, 38px); height: clamp(48px, 6vh, 72px)` — ~30×48 on a 1366×768 laptop,
   ~38×72 on 4K. Icon (same 4-bar waveform SVG) at 16×16 px.
2. **Visual polish** (all colors hard-coded literals — `--ec-*` vars unavailable outside `.ec-root`):
   brand gradient `linear-gradient(135deg, rgba(255,122,60,.95), rgba(242,91,23,.97))`, hairline rim
   `border: 1px solid rgba(255,255,255,.22)` + inset top highlight, shadow
   `-2px 4px 14px rgba(26,20,15,.28)`. Rest opacity **0.95** (was 0.78); hover/focus opacity 1.
   **Hover scale lives on `.ec-launcher-mark`, NOT the button** (critic #12) — the button keeps its
   inline `translateY(-50%)` untouched: `.ec-launcher:hover .ec-launcher-mark { transform: scale(1.05) }`,
   `.ec-launcher:active .ec-launcher-mark { transform: scale(.97) }`.
   `.ec-launcher:focus-visible { outline: 2px solid #FF7A3C; outline-offset: 2px }`.
3. **Hover label = floating chip, absolutely positioned to the LEFT** (critic #8 — the button's box
   must never change size, so clamping/drag math and the userPlaced left-anchored case stay correct):
   `span.ec-launcher-label` is a sibling of the mark inside the button, created with
   `document.createElement("span")` + `textContent = "Lồng tiếng"` — **no innerHTML** (critic #15).
   CSS: `position: absolute; right: calc(100% + 8px); top: 50%; transform: translateY(-50%);
   white-space: nowrap; pointer-events: none; opacity: 0;` dark-glass chip
   (`background: rgba(26,20,15,.92); color: #fff; font: 600 11px/1.4 system-ui...; padding: 4px 10px;
   border-radius: 8px; transition: opacity .16s ease`), revealed (`opacity: 1`) on
   `.ec-launcher:hover` / `.ec-launcher:focus-visible`, hidden while `.ec-launcher-dragging`.
   Grows leftward in BOTH anchoring modes by construction. Tooltip + aria-label unchanged.
4. **Entrance animation — on the MARK, not the button** (critic r2 #2: an animation of `transform`
   on `.ec-launcher` would override the inline `translateY(-50%)` centering for its full duration):
   `.ec-launcher` gets opacity-fade only; `@keyframes ec-launcher-in` (~220 ms ease-out,
   `translateX(8px)→0` + fade) is applied to `.ec-launcher-mark`. Reduced motion (critic #16): add
   EXPLICIT selectors inside the existing `@media (prefers-reduced-motion: reduce)` block
   (overlay.css ~1158):
   `.ec-launcher, .ec-launcher-mark { animation: none !important; transition: none !important; }
    .ec-launcher-label { transition: none !important; }`.
5. **Measured clamping — locked signature** (critic #10): `clampLauncherPos` becomes
   `clampLauncherPos(left: number, centerY: number, vw: number, vh: number, w: number = LAUNCHER_W, h: number = LAUNCHER_H)`.
   A private helper `#measuredSize(): { w: number; h: number }` returns the button's BCR when both
   dims > 0, else the fallback constants `LAUNCHER_W = 34`, `LAUNCHER_H = 60` (jsdom returns 0×0 →
   fallback). Callers (`#applyPos`, `#onResize`, drag handlers) pass `#measuredSize()` results.
   `VIEWPORT_PAD = 8` unchanged; right clamp boundary stays `vw - w - VIEWPORT_PAD`.
6. **Resize save debounce**: `#onResize` re-clamps/applies immediately but debounces the
   `saveLauncherPos` localStorage write (~150 ms).
7. **Everything else byte-identical in behavior**: visibility derivation, 20 s GET_LAUNCH_STATE
   keepalive (fires regardless of visual state), START_REQUEST fire-and-forget, optimistic hide +
   3 s reset, drag threshold 5 px + click suppression, `.ec-launcher-dragging` suppression,
   persistence key/shape `echolyLauncherPos {left, centerY, userPlaced}`.
8. **Mandatory test mutations in test/content/launcher.test.ts** (critic #11 — Agent B MUST make
   exactly these): (a) default-position assertion changes from `right === "0"` to `right === "10px"`
   (top stays `"50%"`); (b) the BCR mock changes from `{width: 22, height: 26}` to
   `{width: 34, height: 60}`; (c) drag+persist contract assertions stay (`userPlaced: true`,
   numeric `left`, `style.left` matches `/^\d+px$/`); (d) add a label assertion: the button contains
   `span.ec-launcher-label` with `textContent === "Lồng tiếng"`.

Rejected alternatives:
- *Video-relative anchoring*: large positioning-logic change; the viewport edge is the launcher's identity.
- *Hide-until-hover peek tab*: hurts discoverability — the complaint includes "easy to miss".
- *Flex-grow label inside the pill*: changes the button's box on hover → breaks measured clamping and
  overflows right when userPlaced (critic #8). Floating chip chosen instead.
- *Moving launcher inside `.ec-root`*: z-index/pointer-events audit for no gain.

## Contracts (locked — build agents import these, do not invent)

- Class names: `.ec-dragging` (dock+panel drag suppression) · `.ec-launcher` / `.ec-launcher-mark` /
  `.ec-launcher-label` (new, floating chip) / `.ec-launcher-dragging` (existing).
- Launcher DOM: `button.ec-launcher > [ span.ec-launcher-mark > svg , span.ec-launcher-label ]`
  (label is a SIBLING of the mark, not a child; created via createElement + textContent).
- launcher.ts: `LAUNCHER_W = 34`, `LAUNCHER_H = 60` (fallbacks only); default offset `right: 10px`;
  `clampLauncherPos(left, centerY, vw, vh, w = LAUNCHER_W, h = LAUNCHER_H)`.
- overlay.ts: module flag `dragActive` (NO suppression flag — the drop-commit clamp write-back in
  §A·5(2) makes one unnecessary); per-drag cache `dragDims`; helper `applyDragPosition()` whose
  scheduling resolves `requestAnimationFrame`/`cancelAnimationFrame` at call time; the strict
  pointerdown ordering (§A·2) and drop ordering (§A·5) are normative.
- `.ec-root` invariants untouched (0×0 fixed, no transform/filter/contain) — guarded by
  test/ui/overlay-root-no-fullscreen.test.ts which must stay green.
- localStorage keys/shapes unchanged: `LAYOUT_KEY` (saved at drag end only) and
  `echolyLauncherPos {left, centerY, userPlaced}`.

## File ownership (FEATURE-MAP — no overlaps)

| Owner | Files |
|---|---|
| Agent A (overlay drag + ALL CSS) | `src/content/overlay/overlay.ts`, `src/content/overlay/overlay.css` (incl. the launcher CSS section per §B·1–4), NEW `test/content/overlay-drag.test.ts`, NEW `test/ui/drag-launcher-css-contract.test.ts` (static readFileSync+regex CSS assertions) |
| Agent B (launcher) | `src/content/launcher.ts`, `test/content/launcher.test.ts` |

No other file may be edited. `media-stage.ts`, `template.ts`, `constants.ts`, manifest, version strings: untouched.

## Acceptance criteria

A1. While dragging dock or panel, the dragged elements carry `.ec-dragging` and a CSS rule
    `.ec-dock.ec-dragging, .ec-panel.ec-dragging { transition: none }` exists; class removed only
    after the drop commit + forced reflow (jsdom class-lifecycle test + static CSS test).
A2. Between the first and last pointermove of a drag, zero `getBoundingClientRect` calls on
    dock/panel (spy scoped to the move phase). rAF coalescing tested with a MANUAL-FLUSH rAF stub
    (critic #14): dispatch two pointermoves before flushing; after one flush, `style.left` equals
    the SECOND move's target (the first move's write was superseded, not applied).
A3. First drag with `dockUserPlaced=false` ends with the DRAGGED position in `layout`/localStorage,
    not the stage default (regression test for R3).
A4. A stage snapshot stored mid-drag does not reposition until drop; at drop the clamp write-back
    puts `layout.left/top` inside the stage rect (test: drag far outside the stage, drop, assert
    persisted position is stage-clamped and `dockUserPlaced` stays `true` after a subsequent
    stage-update `applyLayout()` pass — the >48 px reset must NOT fire);
    `saveLayout` called exactly once per drag, at drag end (pointerup or pointercancel).
A5. test/ui/overlay-root-no-fullscreen.test.ts still green; non-drag stage re-anchoring
    (resize/fullscreen tracking, including the >48 px reset on normal stage updates) unchanged.
B1. Launcher painted size uses `clamp()` for width and height (static CSS assertion) with floor
    ≥ 30×48 px; default position `right: 10px`, `top: 50%` (test updated per §B·8).
B2. `clampLauncherPos` has the locked signature; `#measuredSize()` falls back to 34×60 on 0×0 BCR;
    drag+persist contract test green with the new geometry; resize saves debounced.
B3. `.ec-launcher-label` chip exists (createElement + textContent "Lồng tiếng"), absolutely
    positioned `right: calc(100% + 8px)`, revealed on hover/focus-visible, hidden while dragging;
    `:focus-visible` outline rule present; entrance keyframe targets `.ec-launcher-mark` (NOT a
    transform animation on `.ec-launcher`) AND `.ec-launcher`/`.ec-launcher-mark` explicitly listed
    in the prefers-reduced-motion block (static CSS assertions). Known accepted quirk: the chip can
    clip off-screen left when the launcher is user-placed at the far left edge (hover-transient,
    pointer-events: none — harmless).
B4. Keepalive/visibility/START_REQUEST/optimistic-hide behavior untouched (existing tests green).
G1. `npm run typecheck` → 0 errors; `npm test` → all green (including the pre-existing suite).
G2. No edits outside the FEATURE-MAP; no version bump; no new permissions.
