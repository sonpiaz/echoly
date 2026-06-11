# 03 — Design Language · CSS Isolation · Test Conventions · Constraints

Scope: read-only research slice for the overlay-drag fix + launcher redesign.
All file:line references are to the working tree as-is (branch `develop`, uncommitted changes present).

---

## 1. Design Tokens / Visual Language

### Source of truth
`src/content/overlay/overlay.css:11–44` (`.ec-root` block, comment "Warm Studio tokens").
All tokens are CSS custom properties scoped to `.ec-root`, not `:root`, so they do not bleed into the host page and are not inherited by `.ec-launcher` (which lives outside `.ec-root` — see §2).

### Color palette
| Token | Value | Usage |
|---|---|---|
| `--ec-glass-bg` | `rgba(26,20,15,.82)` | Dark warm cocoa base for all glass surfaces |
| `--ec-glass-border` | `rgba(255,255,255,.16)` | Hairline rim on dock/panel/caption |
| `--ec-glass-text` | `#FFFFFF` | Primary text |
| `--ec-glass-text-dim` | `rgba(255,255,255,.55)` | Secondary/muted text |
| `--ec-tangerine` | `#FF7A3C` | **Brand accent** — left border on captions, slider fill, panel live-dot, CC active state |
| `--ec-tangerine-deep` | `#F25B17` | Deeper shade for gradients |
| `--ec-glow` | `#FFB28A` | Highlight end of orb gradient; scrollbar thumb tint |
| `--ec-grad-orb` | `radial-gradient(120% 120% at 25% 20%, #FFB28A 0%, #FF7A3C 52%, #F25B17 100%)` | Orb fill, voice avatar, caption-loader mark |
| `--ec-grad-brand` | `linear-gradient(135deg, #FF7A3C 0%, #F25B17 100%)` | Buffering ring, launcher-mark background |
| `--ec-cocoa` | `#3B2A1E` | Deep warm brown (reserved/structural) |
| `--ec-cocoa-soft` | `#8A715D` | Softer cocoa |
| `--ec-success` | `#2E9E5B` | Not yet used visually in current UI |
| `--ec-danger` | `#E0442A` | Error state caption background |
| `--ec-warning` | `#E8A013` | Sync-hint text color |
| `--ec-shadow-island` | `0 14px 34px -10px rgba(26,20,15,.55), inset 0 1px 0 rgba(255,255,255,.12)` | Dock + panel elevation |

The palette is **dark/warm-only** — no light-mode tokens, no `prefers-color-scheme` media query. The overlay always renders in its own dark glass aesthetic regardless of host-page theme.

### Typography
- Font stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif` (overlay.css:40). No webfonts injected.
- Base size on `.ec-root`: `13px`. Children override: dock-live `11px/600`, state chip `8px/600/uppercase/tracking+0.06em`, caption `15px/600`, panel body `11–12.5px`.
- Monospace for lag/elapsed: `ui-monospace, "SF Mono", Menlo, monospace` (overlay.css:867).
- Letter-spacing conventions: tight on headings (`-0.01em`), loose on uppercase labels (`+0.06–0.12em`).

### Radii
- Pill (dock, stop pill, panel live badge): `border-radius: 100px`
- Dock itself: `border-radius: 100px` (fully rounded pill)
- Caption card: `12px`
- Panel: `18px`
- Panel buttons/selects: `6–8px`
- Action buttons: `50%` (circular)
- EQ bars: `2px`
- Launcher mark: `6px 0 0 6px` (rounded on left, flush on right edge)

### Spacing / sizing
- Dock: `min-height:32px`, `padding:6px 8px`, `gap:6px`
- Action buttons: `20×20px` (CC/stop); expand button `22×22px`
- Orb mark: `20×20px` (dock + panel)
- Launcher mark: `22×26px` at current size

### Animations
All animation names carry the `ec-` prefix: `ec-orb-breathe`, `ec-eq`, `ec-mark-spin`, `ec-mark-ring-appear`, `ec-mark-buffer-pulse`, `ec-mark-buffer-glow`, `ec-pulse`, `ec-caption-mark-pulse`, wave-0 through wave-4.
`prefers-reduced-motion: reduce` disables all animations (overlay.css:1150–1164) with `!important` — the only `!important` in the file.

### State model
State is stored on `data-state` on `.ec-root`. Values: `ready`, `connecting`, `live`, `buffering`, `switching`, `paused`, `ad-wait`, `error`. CSS selects on `.ec-root[data-state="..."]`. The dock/panel `data-ec-*` attribute pattern is used for JS element refs (overlay.ts:659–689).

### Brand mark / logo
`template.ts` lines 46–66: the orb mark (`ec-dock-mark`) and panel mark (`ec-panel-mark`) render an inline SVG waveform:
```
viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"
path d="M7 9v6M11 6v12M15 8v8M19 11v2"
```
Four vertical bars of varying height — the Echoly "EQ/waveform" glyph, `12×12px` inside a 20px circular orb with `--ec-grad-orb` background. This same glyph appears in the caption-loader (template.ts:514–532, built imperatively via `document.createElementNS`). The launcher uses the same waveform SVG via `LAUNCHER_MARK_SVG` (launcher.ts:24) but inlined as `innerHTML` at 12×12px inside a `22×26px` rect `ec-launcher-mark`.

**Implication for redesigned launcher:** The launcher mark must continue using the tangerine gradient (`--ec-grad-brand` or `--ec-grad-orb` equivalent) and the waveform SVG to maintain visual family. Since `.ec-launcher` is outside `.ec-root`, the token vars are not available there; colors must be hard-coded inline or the element must be moved inside `.ec-root` / the tokens re-declared on `:root`.

---

## 2. CSS Isolation Strategy

### No Shadow DOM
`overlay.ts:1–18` explicitly states: **"NO Shadow DOM: imperative DOM appended to `document.documentElement`, manifest-injected plain CSS."** The `.ec-root` `<aside>` is appended to `document.body ?? document.documentElement` (overlay.ts:656). There is no `attachShadow` anywhere in the codebase.

### How styles are injected
`src/entrypoints/content/index.ts:11,24`:
```ts
import "@/content/overlay/overlay.css";
// ...
cssInjectionMode: "manifest",
```
WXT emits the CSS into the manifest `content_scripts[].css` array; the browser injects it as a plain `<link>` into the page's document. The CSS is therefore live in the page's global stylesheet and competes with host-page styles.

### Isolation mechanism
Because there is no Shadow DOM, isolation relies on:
1. **Namespace prefix**: every rule selector starts with `.ec-root`, `.ec-dock`, `.ec-panel`, `.ec-launcher`, `.ec-toast`, etc. — the `ec-` prefix guards against accidental collisions.
2. **Specificity + CSS variable scope**: tokens declared on `.ec-root` (not `:root`) are scoped to the subtree, limiting inheritance leakage.
3. **No `!important` except reduced-motion**: overlay.css uses `!important` only in the `@media (prefers-reduced-motion: reduce)` block (line 1158). Host-page rules could theoretically override overlay classes if they have higher specificity; this is an accepted risk mitigated by the obscure `ec-` prefix.
4. **`appearance:none`**: buttons and selects explicitly reset `appearance` and `font: inherit` to defeat host-page normalization (overlay.css:93, 1103).

### The `.ec-root` 0×0 fixed host — the "inset:0→0×0" fix
`overlay.css:29–44` and `test/ui/overlay-root-no-fullscreen.test.ts`:
- `.ec-root` is `position:fixed; top:0; left:0; width:0; height:0; overflow:visible; z-index:2147483600; pointer-events:none`.
- The comment at overlay.css:7–10 warns: **"Do NOT add transform/filter/contain"** — these would make the 0×0 root the containing block for its `position:fixed` children, collapsing them to 0×0.
- This was fixed in the `ext-overlay-tier-fixes` wave (specs/ext-overlay-tier-fixes/SOLUTION.md §1): the original `inset:0` made `.ec-root` full-viewport, causing YouTube to promote it to a compositor surface and produce a dark scrim. The fix: `width:0; height:0` (no `inset:0`). The static test (`overlay-root-no-fullscreen.test.ts`) guards this permanently.
- `.ec-root > * { pointer-events:auto }` (overlay.css:52) restores interactivity on all direct children since the root itself has `pointer-events:none`.

### `.ec-launcher` is intentionally outside `.ec-root`
`overlay.css:547–549`: "Lives outside `.ec-root`, so colors and host-page button resets are declared here." The launcher is appended directly to `document.body` (launcher.ts:201), completely separate from the `.ec-root` subtree. Its CSS tokens (`rgba(255,122,60,...)`) are hard-coded literals because the `--ec-*` variables are scoped to `.ec-root` and not inherited. The `.ec-launcher` selector therefore needs its own full set of defensive resets (`appearance:none`, `border:none`, `font:inherit`, `margin:0`, `padding:0`).

---

## 3. Fullscreen Handling

**No fullscreen-specific code found.** A grep across all `.ts` files in `src/` for `fullscreen`, `fullscreenchange`, and `webkitfullscreen` returns no results.

The overlay survives fullscreen implicitly:
- `.ec-root` and `.ec-launcher` are both `position:fixed` on `document.body`. When the browser enters full-screen via the `<video>` element's native fullscreen API (not `document.body.requestFullscreen`), the fixed layers remain in the non-fullscreen layer stack — they are **not** visible over the video in native video fullscreen on most platforms. This is standard browser behavior for MV3 extensions.
- If the user fullscreens via YouTube's player (which keeps the page in document flow), the fixed overlay remains visible.
- There is no `fullscreenchange` re-parenting logic; the `watchMediaStage` observer (media-stage.ts:196–258) uses `ResizeObserver`, `MutationObserver`, and a 400ms poll to continuously re-anchor the dock/caption to the video rect. When the video's rect changes during a fullscreen transition, the next poll cycle re-anchors everything.

**Implication for redesigned launcher:** The launcher will similarly not be visible in native browser fullscreen. This is expected behavior. No special fullscreen handling is needed unless a specific fullscreen re-parenting UX is scoped.

---

## 4. Test Conventions

### Framework and environment
- **Vitest** (`vitest@^3.0.5`) with `jsdom@^26.0.0` (package.json devDependencies).
- Default environment: `node` (vitest.config.ts:8). DOM tests opt in with `// @vitest-environment jsdom` at the top of the file.
- Setup file: `test/setup.ts` — auto-installs a `chrome.*` mock via `resetChrome()` in a global `beforeEach`.

### File naming patterns
- `test/content/` — content-script unit/interaction tests
- `test/ui/` — overlay DOM / render tests
- `test/platforms/<platform>/` — adapter tests
- `test/background/` — service-worker logic
- `test/lib/` — shared library tests
- All files: `*.test.ts`. No `.spec.ts` convention.

### chrome.* mock pattern
`test/setup.ts` exports `makeChrome()` / `resetChrome()`. The global `beforeEach` calls `resetChrome()` which installs a fresh `FakeChrome` on `globalThis.chrome`. Tests that need custom behavior override specific methods with `vi.fn()`:
```ts
vi.stubGlobal("chrome", {
  runtime: { sendMessage: vi.fn().mockResolvedValue({ ok: true, signedIn: true }) },
});
```
(launcher.test.ts:26–30)

`FakeChrome` covers: `runtime.{id,sendMessage,onMessage}`, `tabs.*`, `storage.local/session`, `scripting`, `cookies`, `webRequest`. No `browser.*` polyfill.

### PointerEvent polyfill for jsdom
jsdom does not implement `PointerEvent`. The launcher test polyfills it:
```ts
class PolyPointerEvent extends MouseEvent {
  pointerId: number;
  constructor(type: string, params: PointerEventInit = {}) {
    super(type, params);
    this.pointerId = params.pointerId ?? 1;
  }
}
vi.stubGlobal("PointerEvent", PolyPointerEvent);
```
(launcher.test.ts:17–25). Also needed: `btn.setPointerCapture = vi.fn()`, `btn.releasePointerCapture = vi.fn()`, `btn.hasPointerCapture = vi.fn().mockReturnValue(true)`.

### `rAF` polyfill
`test/setup.ts:191–198` installs `requestAnimationFrame` / `cancelAnimationFrame` as `setTimeout(cb, 0)` when not present in jsdom. Tests that need settled rAF chains use a double-rAF flush:
```ts
await new Promise<void>((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
});
```
(overlay.test.ts:656–661)

### Existing overlay-related test files
| File | What it tests |
|---|---|
| `test/ui/overlay.test.ts` | DOM structure, render-only seam (callbacks), caption scroll, toast XSS guard, `syncFromSettings`, `setCaptionPosition`, `setDubSyncReadout` |
| `test/ui/overlay-root-no-fullscreen.test.ts` | **Static CSS file assertion**: reads overlay.css bytes and asserts `.ec-root` block properties — no layout engine needed |
| `test/content/launcher.test.ts` | `QuickStartLauncher`: default right-edge position, drag → persists `echolyLauncherPos`, click suppressed after drag |

### What drag / responsive tests can realistically assert in jsdom

**jsdom has no layout engine** — `getBoundingClientRect()` always returns zero, `scrollHeight === clientHeight`, `offsetWidth === 0` unless explicitly mocked via `Object.defineProperty`. There is no CSS cascade execution.

**Drag regression tests — what they CAN assert:**
1. After simulating `pointerdown → pointermove → pointerup` with mocked `getBoundingClientRect`, assert `localStorage.getItem("echolyLauncherPos")` contains `{ userPlaced: true, left: <number>, centerY: <number> }`.
2. Assert `btn.style.left` is a `px` string after drag (not `"auto"` or `"0"`).
3. Assert `btn.classList.contains("ec-launcher-dragging")` is `true` during move and `false` after `pointerup`.
4. Assert click is suppressed: fire a `click` event after drag; verify no `sendMessage` call.
5. Assert `#suppressClick` reset on next `pointerdown` (simulate second pointerdown; confirm click works).

**What they CANNOT assert:** pixel-accurate final position (no layout), visual jank (no rendering pipeline), CSS transition firing.

**For "no transition jank during drag":**
The correct assertion is structural — verify that the `.ec-launcher-dragging` class is present during drag, which causes `transition: none` (overlay.css:583). Assert:
```ts
// During pointermove, transition is disabled via the class
expect(btn.classList.contains("ec-launcher-dragging")).toBe(true);
// After pointerup, class is removed (transitions re-enabled)
expect(btn.classList.contains("ec-launcher-dragging")).toBe(false);
```
The anti-jank contract is: the class must be added on `pointermove` when `dragging === true` and removed on `pointerup/pointercancel`.

**Launcher sizing / responsive rules:**
jsdom cannot test CSS media queries or computed sizes. Tests should assert:
1. Default state: `btn.style.right === "0"` and `btn.style.top === "50%"` (flush right edge, vertically centered).
2. After `window.innerWidth`/`innerHeight` are set and `window.dispatchEvent(new Event("resize"))` fired, if `userPlaced`, the stored position is re-clamped within bounds.
3. Clamp logic (`clampLauncherPos`) can be tested as a pure function in a `node` environment (no DOM needed).

**CSS static assertion pattern (from `overlay-root-no-fullscreen.test.ts`):**
For properties that cannot be verified via layout, read the CSS file with `readFileSync` and assert regex patterns on the rule block. This is the established pattern for structural CSS contracts.

---

## 5. Platform Adapters and CSS Gotchas

### Adapter mount points
Platform adapters (`src/platforms/*/adapter.ts`) implement `PlatformAdapter` (from `src/shared/platform-ports.ts`) and provide:
- `findVideo()` — how to locate the `<video>` element
- `stageInsets(video)` — padding around the video rect for safe-zone anchoring
- `matchesHost()`, `isWatchUrl()`, `getVideoId()`, `fetchCaptions()`

The adapters do **not** affect where `.ec-root` or `.ec-launcher` mounts — both always go on `document.body`. Adapters influence only the overlay's anchoring math.

### Per-platform insets
| Platform | top | bottom | side |
|---|---|---|---|
| YouTube (`adapter.ts:68`) | 10px | 56px | 12px |
| Coursera (`adapter.ts:195`) | 12px | 56px | 16px |
| Udemy (`adapter.ts:173`) | 12px | 56px | 16px |
| Generic (`adapter.ts:93`) | 44px | 56px | 16px |

The 56px bottom inset clears all platform control bars. YouTube's 10px top (vs 44px generic) reflects that YouTube's top controls are minimal.

### YouTube-specific mount note
`overlay.ts:655–656`:
```ts
// Prefer body — YouTube's html layer can interact badly with fixed UI.
(document.body ?? document.documentElement).appendChild(root);
```
This is a known platform-specific quirk: mounting on `<html>` breaks on YouTube. Always mount on `document.body`.

### YouTube resolveStageRect
`media-stage.ts:126–131`: for YouTube, the stage rect is the `.html5-video-player` or `#movie_player` element, not the `<video>` itself (which may be letterboxed). Other platforms fall through to `video.closest(".video-player, .vjs-tech-parent, ...")`.

### Coursera/Udemy CSS interference
No platform-specific CSS overrides for `.ec-*` classes were found. The `cssInjectionMode:"manifest"` injection puts the overlay CSS at the top of the page's stylesheet cascade; host-page rules are generally later and have higher specificity only if they use IDs or `!important`. The `ec-` namespace makes accidental collisions very unlikely.

---

## 6. Hard Constraints

1. **`ECHOLY_VERSION` must NOT be bumped.** Current value: `"0.6.4-dub-e2e"` (`src/shared/constants.ts:11`). The content-guard (`index.ts:7–8`) uses this to prevent double-injection on tab reload. Bumping would force re-injection into all open tabs on extension reload — a separate concern reserved for the next release.

2. **Do not touch uncommitted work from other waves.** The working tree has uncommitted changes (branch `develop`). Any edits must be confined to the files in scope for this wave. Do not modify files owned by the drag-fix agent or the launcher-redesign agent's implementation unless your file explicitly overlaps.

3. **TypeScript gate: `npm run typecheck` (`wxt prepare && tsc --noEmit`).** All changes must pass this. The `tsc` config is strict (TypeScript 5.7.3). `wxt prepare` regenerates WXT type stubs; it must run before `tsc` (package.json:7).

4. **Test gate: `npm test` (`vitest run`).** All existing tests must remain green. New tests go in `test/content/` (content-layer behavior) or `test/ui/` (overlay/launcher DOM assertions). Use `// @vitest-environment jsdom` for any DOM test.

5. **No new manifest permissions.** The manifest is locked (`wxt.config.ts`). Do not add permissions or host_permissions.

6. **No `innerHTML` on user-sourced text.** `overlay.ts:933`: "Toast is built via DOM APIs (NEVER innerHTML) — text may be a provider error body, so innerHTML would be an XSS vector inside youtube.com's origin." Same principle applies to launcher title/aria-label.

7. **No `transform/filter/contain/will-change/perspective` on `.ec-root`.** These would re-anchor fixed children to the 0×0 root, breaking the dock/caption/toast positioning. Guarded by `overlay-root-no-fullscreen.test.ts`.

8. **`ec-launcher-dragging` class must be present during drag and absent after.** This suppresses the CSS `transition` (overlay.css:582–584) and prevents positional jank. Adding `will-change:transform` or a CSS transition on the dragging state would reintroduce jank.

9. **`ec-launcher` outside `.ec-root`.** The CSS comment at overlay.css:547–548 says this is intentional. Colors in `.ec-launcher` and `.ec-launcher-mark` must be hard-coded (not CSS var references) because `--ec-*` tokens are not inherited outside `.ec-root`.

---

## 7. Prior Spec Ratified Behaviors — Must Not Regress

### specs/ext-overlay-tier-fixes/SOLUTION.md (AC1–AC6, status: implemented)
- **AC1 (locked):** `.ec-root` has NO `inset:0`, is `width:0; height:0`, keeps `position:fixed; overflow:visible; pointer-events:none; z-index:2147483600`. Guarded by `overlay-root-no-fullscreen.test.ts`. Any redesign must leave the `.ec-root` rule structurally unchanged.
- **AC5:** `wxt prepare && tsc --noEmit` clean; full suite green. Still the gating CI command.

### specs/dub-e2e/SOLUTION.md §0a (status: in progress)
- The content-guard uses `ECHOLY_VERSION = "0.6.4-dub-e2e"` to gate re-injection. **Do not bump this version string.**
- The overlay's `buildOverlay` is idempotent (overlay.ts:639–644): a second call when `root` is already set returns early without recreating the DOM.

### specs/smooth-dub/SOLUTION.md / specs/pause-resume-autonext/SOLUTION.md
- These do not directly constrain overlay visual design but do constrain the `OverlayView` interface (`src/shared/ports.ts`). The overlay module exports a fixed set of methods (`buildOverlay`, `removeOverlay`, `setOverlayState`, etc.) — the interface is "locked, render-only seam" as stated in overlay.ts:9. Do not add new callback signatures without updating `src/shared/ports.ts`.
- `watchMediaStage` is called once in `buildOverlay` and the unwatch fn stored. Do not create additional watchers or move the call site.

### Overlay drag behavior ratified by overlay.test.ts
- Drag uses `pointerdown/pointermove/pointerup/pointercancel` with `setPointerCapture` (overlay.ts:805–831).
- Position is stored in `LAYOUT_KEY` localStorage (constants.ts) under `{left, top, ...Layout}`.
- `dockUserPlaced = true` is set on first drag-end; thereafter `applyLayout` uses the stored position. A "too far outside the stage" guard resets `dockUserPlaced` (overlay.ts:279–287).
- `layout.left/top` are updated in `pointermove` without `saveLayout` — save only on `pointerup`. This means mid-drag layout changes do not spam localStorage.

---

## Risks

1. **`.ec-launcher` token gap.** Since the launcher lives outside `.ec-root`, any redesign that adds more visual tokens (responsive sizing, dark/light state, accent color tweaks) must hard-code values or move the element inside `.ec-root`. Moving inside `.ec-root` would give it access to `--ec-*` vars but requires auditing `pointer-events:none` / z-index conflicts with the 0×0 root. **Recommended:** keep launcher outside `.ec-root` but document each hard-coded color with a comment referencing the source token.

2. **jsdom layout gap for responsive assertions.** No CSS media query or `clamp()` / `min()` is evaluated in tests. Responsive sizing rules (e.g. `clamp(22px, 2.5vw, 32px)` for a screen-size-appropriate launcher) cannot be validated in Vitest. Options: (a) static CSS assertion test (read file, assert regex for the rule), (b) Playwright e2e test (already exists under `test:e2e`), (c) pure-function unit tests for the JS sizing logic.

3. **Drag transition jank is the CSS `transition` on `.ec-dock` (`overlay.css:79`).** During `pointermove`, the `.ec-dock` has `transition: left 0.15s ease, top 0.15s ease`. The dock drag code sets `left`/`top` via `el.style.left` on every `pointermove` event — each inline-style change re-triggers the CSS transition, causing the dock to lag behind the pointer. The fix is the same pattern already used for `.ec-launcher-dragging`: add a class (e.g. `ec-dock-dragging`) during active drag and use `transition: none` for that class. The launcher already does this correctly; the dock does not.

4. **No fullscreen handling.** If the overlay/launcher must appear in YouTube's CSS-fullscreen mode (non-native, `position:fixed` persists), current behavior already works. For true native fullscreen, nothing will appear — this is a known extension limitation and not in scope.

5. **`ECHOLY_VERSION` bump constraint.** If the drag-fix or launcher redesign also changes a hot-path module that content-guard checks (currently only `index.ts:931`), the guard will be stale on open tabs until a tab reload. This is accepted; do not bump the version.
