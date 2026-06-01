# SOLUTION — Fix full-screen overlay dim + lock Realtime tier for non-Max

Slug: `ext-overlay-tier-fixes`  ·  Scope: extension/ ONLY  ·  no new permissions

## 1. Problems & why
- **Issue 1 — full-screen dim on Start.** The content overlay host `.ec-root`
  (`content/overlay/overlay.css:6`) is `position:fixed; inset:0; z-index:2147483600`
  injected straight into the page (cssInjectionMode "manifest"). Its `background`
  is transparent, BUT it is a full-viewport `position:fixed` layer whose children
  (`.ec-dock`, `.ec-panel`) carry `backdrop-filter: blur(...)`. On YouTube this
  promotes `.ec-root` to a full-viewport compositor surface and the backdrop-filter
  sampling renders a dark scrim over the whole screen. The root does NOT need to be
  full-viewport: every child is `position:fixed` and JS-positioned from the video
  rect (the CSS comment itself notes "root has 0×0 in-flow size"). `.ec-root`
  establishes NO containing block for its fixed children (it has no transform/
  filter/contain), so collapsing it to 0×0 leaves children viewport-anchored.
- **Issue 2 — Realtime selectable on Free/Pro.** Realtime is Max-only. The popup
  tier dropdown's `tierItems()` (`popup/index.ts:804`) never sets `disabled:true`
  on the Realtime option for non-Max, so a Free/Pro user can select it (only the
  Start button is then gated → confusing state in the screenshot). Also the rule
  "realtime ⇔ max" is duplicated 3× (`popup-format.ts allowRealtime`, popup inline
  `accountAllowsRealtime`, `OFFLINE_TIER_CAPS.rt`), and a persisted `tier=realtime`
  from a since-downgraded user is never normalized in the store.

## 2. Chosen approach (+ rejected)
- **Issue 1:** collapse `.ec-root` to a zero-size fixed anchor (drop `inset:0`;
  `width:0; height:0`), keeping `position:fixed; z-index; overflow:visible`. Removes
  the full-viewport surface entirely → no dim, regardless of the exact compositor
  mechanism; dock/panel/caption (all `position:fixed`, JS-anchored) unaffected.
  _Rejected:_ removing `backdrop-filter` from dock/panel (aesthetic loss + doesn't
  remove the full-viewport host, which is the real hazard).
- **Issue 2:** (a) one SoT `canUseRealtime(accountTier)` in `src/shared/tier.ts`,
  imported by popup-format, popup, and store — kills the 3-way duplication.
  (b) Popup `tierItems()` sets `disabled: !canUseRealtime(plan)` on the Realtime
  item — the dropdown's existing `disabled` path (aria-disabled + `.is-disabled` +
  `pick()` early-return) makes it non-selectable; keep the "· Max plan" upsell
  secondary + the existing footer upsell. (c) Store NORMALIZES `state.tier`:
  when `!canUseRealtime(signedInUser?.tier)` and persisted tier is realtime, coerce
  to standard and persist (root-cause for the resurrecting-stale-tier bug).
  _Rejected:_ hiding the Realtime option (users should see it as an upsell);
  a session-coordinator START guard (redundant once the option is non-selectable
  AND the store normalizes the persisted value before Start — noted as optional).

## 3. Interfaces / contracts (foundation, locked first)
`src/shared/tier.ts` (NEW):
```ts
import type { AccountTier } from "./types.ts"; // "free" | "pro" | "max"
/** Realtime translation tier is Max-only. Single source of truth. */
export function canUseRealtime(accountTier: AccountTier | string | null | undefined): boolean {
  return accountTier === "max";
}
```
Consumers import it (no new inline rule):
- `src/lib/popup-format.ts` `allowRealtime(tier)` → `return canUseRealtime(tier)`.
- `src/popup/index.ts` `accountAllowsRealtime()` → `canUseRealtime(state.signedInUser?.tier)`.
- `src/background/store.ts` normalization.

## 4. Behavior spec
- **overlay.css `.ec-root`**: `position:fixed; top:0; left:0; width:0; height:0;
  overflow:visible; z-index:2147483600; pointer-events:none; …` (drop `inset:0`).
  Keep `.ec-root > * { pointer-events:auto }` and all child rules unchanged.
- **popup `tierItems()`**: the Realtime item gets `disabled: !allow` where
  `allow = accountAllowsRealtime()`. When disabled, `secondary` stays the gated
  "· Max plan" text. Standard always enabled.
- **store normalization** (`store.ts`, after `signedInUser` is set in `refreshAuth`):
  if `this.state.tier === TIER_REALTIME && !canUseRealtime(this.state.signedInUser?.tier)`
  → set `this.state.tier = TIER_STANDARD` and persist via the existing settings-persist
  path. Idempotent (guard is false after the first coercion; no write-loop). This
  fixes the PERSISTENCE root-cause (stale realtime resurrecting on next load). The
  popup's existing `applyState` `previewingGated` coercion (popup/index.ts:488) stays
  — it's complementary (handles the in-DOM select value), not redundant. (critic-6/11)

## 5. Acceptance criteria (testable)
- AC1 `.ec-root` rule in overlay.css has NO `inset: 0` and is zero-sized
  (`width:0; height:0`); keeps `position:fixed`, `overflow:visible`,
  `pointer-events:none`, z-index. Guarded by a CSS-file static assertion test
  (jsdom can't compute CSS — the test reads overlay.css and asserts the `.ec-root`
  block). Overlay DOM structure unchanged (dock+panel+caption-stack+toast still
  built + all `position:fixed`; existing overlay.test.ts green).
- AC2 popup: for plan ∈ {free,pro} the Realtime dropdown item is `disabled`
  (aria-disabled / `.is-disabled`, not pickable); Standard pickable. For max,
  Realtime pickable.
- AC3 `canUseRealtime` is the sole REALTIME-gate rule; `popup-format.allowRealtime`,
  popup `accountAllowsRealtime`, and the store normalization all delegate to it.
  (critic-5: verify ONLY the realtime gate is centralized — grep
  `allowRealtime|accountAllowsRealtime|canUseRealtime`, not bare `=== "max"`. Leave
  unrelated plan-badge helpers like `planFromTier`/`tierBadge`/`OFFLINE_TIER_CAPS.max`
  UNTOUCHED — they are not realtime checks.)
- AC4 store coerces a persisted/selected `realtime` tier → `standard` and persists
  it when the account is non-Max (no resurrection on next load).
- AC5 `wxt prepare && tsc --noEmit` clean; full extension suite green; new tests:
  overlay-css `.ec-root` guard, popup tier locked-for-free/pro + selectable-for-max,
  store tier-normalization.
- AC6 no new manifest permissions; popup footer upsell text retained; Realtime
  still VISIBLE (as an upsell), not hidden.
```
