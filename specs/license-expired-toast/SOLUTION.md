# SOLUTION — Toast on the page when a translate Start fails due to license/credit/quota expiry

## Problem & why

When a signed-in user whose **license/credits have expired** (or whose plan
doesn't cover the requested tier, or whose session has lapsed) presses
**translate**, the start fails on a server **402** (`quota_exhausted` /
`tier_locked`) — or sometimes **401**/**403** — and today the user sees
**nothing on the video page**:

- **Content catch** (`src/content/index.ts:486-499`, and the standard path in
  `src/content/pipelines/subtitle-first-pipeline.ts:241-254`): on the thrown
  `CtaError`, the code calls `overlay.removeOverlay()` then
  `return { ok:false, error }`. **No `overlay.showToast(...)` is called.** The
  `cta` upgrade URL is degraded into inline text `"<msg> (<url>)"`.
- **`showToast` requires `.ec-root`** (`overlay.ts:910` — `if (!root) return`),
  and `removeOverlay` sets `root = null`. So even if we wanted to toast, the
  surface is already gone. There is **no standalone toast host**.
- **On-page launcher** (`src/content/launcher.ts:138`): sends `START_REQUEST`
  fire-and-forget and never reads the reply → **completely silent** on failure.
- **Background pre-gate** (`SessionCoordinator.start()` → `resolveApiMode`
  returns `null` when the session token is gone): rejects **before** the content
  script is ever reached, so the only surface is the popup `statusEl`
  (popup-only, invisible if the popup is closed).

Net effect: the user thinks the extension is **broken** ("tưởng lỗi") instead of
understanding their license/credits ran out. We must surface a clear, friendly
**toast on the page** in all of these paths, with an actionable CTA.

## What "license expired" maps to

There is **no first-class "license expired" error code**. It surfaces as:

| Server status | code | meaning | toast intent |
|---|---|---|---|
| 402 | `quota_exhausted` | credits/minutes for the cycle are used up | message + **Upgrade** CTA (and reset date if present) |
| 402 | `tier_locked` | plan doesn't include the requested tier (e.g. Realtime on Pro) | message + **Upgrade** CTA |
| 401 | `unauthorized` | session cookie expired / signed out at server | message + **Sign in** CTA |
| 403 | `forbidden` | access revoked / plan lapsed | message + **Upgrade** CTA (if `upgrade_url`) |

We treat all four as **"expiry-like"** — the class of "you can't translate right
now because of your account/credit/license state, and it is NOT a bug." Anything
else (429 rate, 413 too-large, 5xx, network) keeps its current behavior.

## Chosen approach

Root-cause fix in three coordinated pieces. **Server stays authoritative** — we
do NOT add a client-side credit pre-gate (cached usage can be stale; the start
must still be allowed and the *server's* 402 is what fires the toast).

### A. Classify once, in `server-errors.ts`
- Add a derived discriminant `kind: 'quota' | 'auth' | 'access' | 'rate' | 'too_large' | 'other'`
  to `ParsedServerError` (402→`quota`, 401→`auth`, 403→`access`, 429→`rate`,
  413→`too_large`, else→`other`). Keep `isQuotaOrTier` (402-only) for back-compat
  with `usagePatchFromServerError` / `notifyQuotaToBackground`.
- Add `export function isExpiryLike(p: ParsedServerError): boolean` →
  `p.kind === 'quota' || p.kind === 'auth' || p.kind === 'access'`.
- Extend `cta`/`ctaLabel` population in `parseServerError`:
  - 402 → `cta = upgrade_url`, `ctaLabel = "Upgrade"` (unchanged).
  - 403 → `cta = upgrade_url` (if present), `ctaLabel = "Upgrade"`.
  - 401 → `cta = <web sign-in URL>`, `ctaLabel = "Sign in"` (sign-in URL sourced
    from the existing web-URL constant; if none available, no CTA — message only).

### B. Make the toast survive teardown / cold start — `overlay.ts` + `overlay.css`
- `showToast` **self-mounts** a minimal toast host when `root === null`: a new
  internal `ensureRootForToast()` creates the `<aside class="ec-root">` (the same
  element class the toast CSS already targets), appends it to `document.body`,
  and flags it `toastOnlyRoot = true`.
- When a toast created on a `toastOnlyRoot` host expires (its existing
  `setTimeout`), and there is no live session overlay, the host removes itself so
  we never leave an empty container.
- This keeps `.ec-toast` **inside `.ec-root`** (existing CSS + existing
  `overlay.test.ts` contract unchanged) while making toasts independent of the
  session lifecycle. It also incidentally hardens every existing showToast call.
  CONFIRMED by critic: `.ec-root` is visible by default (`position:fixed;
  width:0;height:0;z-index:2147483600;overflow:visible`, no state-class gate) and
  `.ec-toast` is `position:fixed` to the viewport — a bare 0×0 self-mounted root
  renders the toast correctly.
- **CSS fix (REQUIRED, critic BLOCKER-1):** `overlay.css` sets
  `.ec-toast { pointer-events: none }` (~line 994) and there is **no** rule
  re-enabling pointer events on its children, so the CTA `<a>` renders but is
  **unclickable today** (this already silently breaks the handover-toast CTA at
  `webrtc-pipeline.ts:684`). Add `.ec-toast a { pointer-events: auto; }`. Without
  this, the Upgrade/Sign-in link is dead and ACs 1/4/8 cannot pass.

### C. Wire the toast into every failure path
**Reuse the EXISTING error type — do NOT introduce a parallel one** (critic
CONCERN-3/11). `pipeline-error.ts` already has `PipelineToastError` (a plain
duck-typed shape, `{ user, cta?, ctaLabel? }`) and `isPipelineToastError`
(predicate `"user" in err`), thrown as `Object.assign(new Error(t.user), t)` by
`echoly-api.ts:65,182`. We extend that, we don't fork it:
- `pipeline-error.ts`:
  - Extend `interface PipelineToastError` with **optional** `expiryLike?: boolean`
    and `durationMs?: number`.
  - `pipelineToastFromServer(parsed)` now ALSO sets
    `expiryLike: isExpiryLike(parsed)` (and may set `durationMs`).
  - **Centralize `isPipelineToastError` here** and re-export it from
    `echoly-api.ts` for back-compat (so `index.ts` can import the predicate
    without depending on the api module).
  - No `makeStartToastError` / `isStartToastError` / new `StartToastError` —
    those are removed from the design.
- **Throw sites** all funnel through `pipelineToastFromServer`:
  - `echoly-api.ts:65,182` already do `t = pipelineToastFromServer(parsed); throw Object.assign(new Error(t.user), t)` → they pick up `expiryLike` **with no edit**
    (the change is entirely inside `pipelineToastFromServer`, owned by Agent-1).
  - `webrtc-pipeline.ts` `buildSession` SDP-error throw (~line 388): replace the
    hand-built `CtaError` with the same
    `const t = pipelineToastFromServer(parsed); throw Object.assign(new Error(t.user), t)`.
    The handover toast at `webrtc-pipeline.ts:684` is a direct `showToast` call,
    not a start-throw, and is left unchanged (still compatible).
- **Content catches show the toast** — BOTH catches in each file (critic NIT-12):
  - `index.ts:486-499` (start), and
  - `subtitle-first-pipeline.ts:241-254` (`start`) **and** its `restart()` catch
    (~line 499-510, also silent on 402 today).
  - On `isPipelineToastError(err) && err.expiryLike`: call
    `overlay.removeOverlay()` **then**
    `overlay.showToast(err.user, { durationMs: err.durationMs ?? 8000, cta: err.cta, ctaLabel: err.ctaLabel })`. Self-mount makes the order safe — a fresh
    host is created for the toast after teardown. Return `{ ok:false, error: err.user }`
    (drop the inline `"(url)"` hack — the CTA is now a real clickable link).
  - Non-expiry errors keep their current behavior exactly.
- **Background relay for the ONE pre-content gap** — new protocol message
  `CONTENT_SHOW_TOAST` (background → content):
  `{ type:"CONTENT_SHOW_TOAST"; text: string; durationMs?: number; cta?: string; ctaLabel?: string }`.
  - Content message handler (`index.ts` switch) adds
    `case "CONTENT_SHOW_TOAST"` → `overlay.showToast(text, { durationMs, cta, ctaLabel })` then `sendResponse({ ok: true })`.
  - **The relay lives entirely inside `SessionCoordinator.start()`, at the single
    `resolveApiMode`-null early-return** (critic BLOCKER-2/CONCERN-6/7). The
    router stays an unchanged sync void function — it does NOT await `start()`.
    At that return site, best-effort resolve the active dubbable tab
    (`chrome.tabs.query({ active:true, currentWindow:true })`, or the existing
    `sessionTabForStart()` helper) and, if a tab id is found,
    `chrome.tabs.sendMessage(tabId, { type:"CONTENT_SHOW_TOAST", text: <signInToStartMessage()> })`
    before returning `{ ok:false }`. This makes the launcher-triggered
    expired/lost-session case non-silent on the page.
  - **No double-toast, no benign filter needed** (critic NIT-8): the relay fires
    at exactly one site with one known non-benign message. The coordinator's
    catch-at-236 (content-reached failures) does **not** relay — content already
    toasts itself there.

## Rejected alternatives

- **Client-side credit pre-gate** (block Start when cached `standardRemaining<=0`):
  rejected — violates the server-authoritative metering invariant, risks
  false-positives on stale cache, and blocks legit starts. Server 402 is the
  trigger.
- **Dedicated `<div class="ec-toast-host">` separate from `.ec-root`**: rejected —
  would require duplicating positioning CSS and would break the existing
  `overlay.test.ts` contract that asserts `.ec-toast` lives inside `.ec-root`.
  Self-mounting a minimal `.ec-root` achieves the same robustness with zero CSS
  churn.
- **Toast only from the background (single relay for all paths)**: rejected —
  content-reached failures already have the overlay mounted; toasting from
  content is simpler and avoids a background→content round-trip + double-toast
  bookkeeping. Background relay is used only for the pre-content gap.

## Public interfaces / contracts (locked in Phase 3a)

```ts
// src/lib/server-errors.ts
export interface ParsedServerError {
  /* …existing… */
  kind: 'quota' | 'auth' | 'access' | 'rate' | 'too_large' | 'other';
}
export function isExpiryLike(p: ParsedServerError): boolean;
// parseServerError additionally sets cta/ctaLabel on 403 (Upgrade) and 401 (Sign in).

// src/lib/pipeline-error.ts  (extend existing — do NOT fork)
export interface PipelineToastError {
  user: string; cta?: string; ctaLabel?: string;
  durationMs?: number;   // NEW (optional)
  expiryLike?: boolean;  // NEW (optional)
}
export function pipelineToastFromServer(parsed: ParsedServerError): PipelineToastError; // now sets expiryLike
export function isPipelineToastError(e: unknown): e is (Error & PipelineToastError);    // centralized here, re-exported from echoly-api.ts

// 401 Sign-in CTA uses the existing ECHOLY_WEB_URLS.signin() (src/shared/echoly-config.ts:49) — CONFIRMED available.

// src/shared/protocol.ts  (add to BgToContent map + response Ok)
type CONTENT_SHOW_TOAST = {
  type: 'CONTENT_SHOW_TOAST'; text: string; durationMs?: number; cta?: string; ctaLabel?: string;
};

// src/content/overlay/overlay.ts  — behavior change only, no signature change:
//   showToast(text, opts) self-mounts a minimal `.ec-root` when root===null and
//   auto-removes that toast-only host when the toast expires (no live session).
```

## Data model / migrations

None. No schema, no storage changes. Purely additive client logic + one new
runtime message type.

## Acceptance criteria (concrete, testable)

1. **Popup-initiated** Start with exhausted credits (server 402 `quota_exhausted`)
   → a `.ec-toast` appears **on the video page** with the server message and an
   **Upgrade** `<a>` link (when `upgrade_url` present), in addition to the
   existing popup `statusEl` text.
2. **Launcher-initiated** Start with the same 402 → the page toast appears (no
   longer silent).
3. The toast appears **even though the session overlay was torn down** — i.e.
   `showToast` self-mounts a host; verified by a test where `root` is null at
   call time and a `.ec-toast` still ends up in the DOM.
4. **402 `tier_locked`**, **401 `unauthorized`**, **403 `forbidden`** during Start
   each produce a page toast (Upgrade CTA for 402/403, Sign-in CTA for 401).
5. **Pre-content** rejection from the launcher (expired session →
   `resolveApiMode` null) relays `CONTENT_SHOW_TOAST` and the page toasts.
6. **Benign** failures ("Session already running.", "Cancelled…") do **not**
   toast and do **not** relay.
7. `isExpiryLike` returns true for 401/402/403 and false for 429/413/5xx/other —
   unit-tested. `parseServerError` attaches the right `cta`/`ctaLabel`/`kind` per
   status — unit-tested with real `Response` objects.
8. Toast DOM stays XSS-safe (`textContent` + `<a target=_blank rel=noopener noreferrer>`),
   duration capped (~8s), matching the existing `overlay.ts` contract.
9. Gates green: `npm run typecheck` (0 errors) and `npm test` (vitest) including
   the new tests (server-errors classification, content start-failure-toast,
   overlay self-mount, background relay).

## File ownership (Phase 3 FEATURE-MAP — no overlaps)

- **Foundation (3a, serialized first):** Agent-1 — `src/lib/server-errors.ts`
  (`kind` + `isExpiryLike` + 401/403 cta via `ECHOLY_WEB_URLS.signin()`),
  `src/lib/pipeline-error.ts` (extend `PipelineToastError` + set `expiryLike` in
  `pipelineToastFromServer` + centralize `isPipelineToastError`),
  `src/lib/echoly-api.ts` (re-export `isPipelineToastError`; throw sites already
  funnel through `pipelineToastFromServer`, so no throw-site edits needed),
  `src/shared/protocol.ts` (add `CONTENT_SHOW_TOAST` to the BgToContent map +
  its `Ok`/`Ack` response), `src/shared/product-copy.ts` (any fallback copy).
- **Parallel build (3b):**
  - Agent-2 (overlay): `src/content/overlay/overlay.ts` (self-mount), 
    `src/content/overlay/overlay.css` (add `.ec-toast a { pointer-events:auto }`).
  - Agent-3 (content wiring): `src/content/index.ts` (`CONTENT_SHOW_TOAST` handler
    + start-catch toast), `src/content/pipelines/subtitle-first-pipeline.ts`
    (both `start` + `restart` catches), `src/content/pipelines/webrtc-pipeline.ts`
    (`buildSession` throw → `pipelineToastFromServer`).
  - Agent-4 (background relay): `src/background/session-coordinator.ts` ONLY
    (relay at the `resolveApiMode`-null return; `router.ts` is NOT touched).
- **Tests (after build):** Agent-5 — `test/lib/server-errors.test.ts` (extend:
  `kind`/`isExpiryLike` over 401/402/403/429/413 with real `Response`),
  `test/content/start-failure-toast.test.ts` (new — see mock boundary below),
  `test/ui/overlay.test.ts` (extend: `showToast` with no prior `buildOverlay`
  still puts `.ec-toast` in the DOM; CTA `<a>` present),
  `test/background/session-coordinator.test.ts` (extend: signed-out/expired
  `start()` calls `chrome.tabs.sendMessage` with a `CONTENT_SHOW_TOAST`).

**Test mock boundary (critic NIT-13), follow `test/content/ad-gate-nocc-fallback.test.ts`:**
`vi.mock` the pipeline module; `mockWebRtcPipeline.buildSession.mockRejectedValue(Object.assign(new Error("Credits used up"), { user:"Credits used up", cta:"https://echolyhq.com/upgrade", ctaLabel:"Upgrade", expiryLike:true }))`;
drive `app.startSession(settings)`; assert `mockOverlay.showToast` was called with
`"Credits used up"` and a ToastOptions carrying `cta`/`ctaLabel`. For the relay
test, mock `chrome.tabs.sendMessage`/`chrome.tabs.query` and assert the
`CONTENT_SHOW_TOAST` payload.

No source file appears in two agents' scopes. Agents 3 & 4 import the locked
contracts from Agent-1; Agent-2 needs no contract change (uses existing
`ToastOptions`). `router.ts` stays untouched (relay is self-contained in the
coordinator).
