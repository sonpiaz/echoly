# Echoly Extension Rebuild — SOLUTION (ratified design)

**Status:** ✅ COMPLETE. Critic APPROVED (round 2, spike-verified). Human checkpoint passed. Built on branch `rebuild/ts-wxt`: legacy archived, contracts locked, 3 build agents integrated, cleanup pass done. Gates green — `tsc --noEmit` 0 errors, `vitest` 128/128, `wxt build` clean (manifest byte-equivalent to 0.6.3, M-a SW single-chunk confirmed). Audit PASS (2 round-1 gaps fixed: toast CTA link restored, controller branch test added). AC1/AC1b/AC3/AC4 automated-green; AC2 (manual smoke) + AC5 (browser load) remain manual-only/provider-gated. NOT committed (awaiting your review). Next wave = server wiring (recover `uncommitted-server-repoint.patch`).

## 0. Phase-0 spike results (hard evidence — resolves critic blockers)

Ran a real WXT 0.20.26 / Vite 8 prod build (`/tmp/ext-spike-wxt`):
- **Content output names are STABLE & UNHASHED:** emits `content-scripts/content.js` + `content-scripts/content.css` (identical across rebuilds), manifest references them correctly. The critic's "hashed" concern was wrong — they're unhashed, just in a `content-scripts/` subdir. → **B1 resolved.** The only change: point programmatic injection at the new path (see §3 `CONTENT_SCRIPT_PATH`).
- **Prod manifest CSP = exactly `script-src 'self'; object-src 'none'`** — no dev-localhost leak in the production build. Permissions emitted verbatim. Version single-sourced from `package.json`.
- **SW** emits flat `background.js`, calls `main()` synchronously at top level (eager listener registration); WXT warns if `main()` returns a promise (enforces sync).
- **F9-under-WXT (Finding 4):** WXT's content wrapper constructs a `ContentScriptContext` that dispatches a `wxt:content-script-started` event + `postMessage` and may `abort()` the *previous* ctx **before** `main()` runs. Our code must therefore **NOT** use WXT's `ctx` (no `ctx.setInterval`/`ctx.signal`); keep our own module-global `pageToken` + our own `AbortController` + raw timers, and make the F9 guard the **first statement in `main()`**. WXT's invalidation event is then benign noise (nothing of ours subscribes). → **Finding 4 resolved as a contract, test-gated in §6.**

**Decision: WXT is confirmed.** It satisfies every hard build contract with one trivial path change; a thin hand-rolled Vite setup would re-implement manifest gen + multi-format bundling + zip for no gain.


**Baseline:** committed `0.6.3` (`5c35eb5`); working tree restored to it. Uncommitted server-repoint work saved at `docs/rebuild/uncommitted-server-repoint.patch`.
**Scope (confirmed by user):** Port the extension from plain-JS single-files to a **modular TypeScript + Vite/WXT** codebase, **preserving 100% of current 0.6.3 behavior and UI** (incl. the BYOK/Kyma seam). **Defer** server-wiring (`/v1/rtc/translate`, BYOK removal) to a later wave.

---

## 1. Problem & Why

`content.js` is 2,406 lines of plain JS in a single IIFE; `background.js` 517; `popup.js` 455. No build step, no types, no tests. This is hard to maintain, hard to verify, and risky to evolve toward the new server. We want a modern, typed, modular, testable architecture **without changing what the user sees or how it behaves** — so the change is provably behavior-equivalent and de-risks the *next* wave (server cutover).

Goals: modular separation of concerns, OOP where identity/lifecycle exists + pure functions where logic is stateless, TypeScript strict, Vite-based build, real unit tests on extracted logic, identical UI + behavior.

Non-goals (this wave): server cutover, BYOK/Kyma removal, UI redesign, new features.

---

## 2. Chosen Approach

### 2.1 Build tool — **WXT** (vanilla TS mode) — spike-confirmed (§0)
WXT (`wxt` v0.20.x, Vite-based) generates a typed manifest from `entrypoints/`, bundles each content script to a single IIFE (required: the isolated world has no module loader), injects CSS via the manifest, ships `wxt zip`, and **relaxes CSP only in dev** — the prod build emits our exact `script-src 'self'; object-src 'none'` (verified §0). Content output names are stable/unhashed (verified §0). Decision was re-ranked on the criterion that actually matters for this extension — *cheapest guarantee of stable content names + clean prod CSP* — not on the (corrected) CRXJS bug below.

**Rejected:** CRXJS (`@crxjs/vite-plugin`) — primary disqualifier is its 2025 near-archival / Vite-version-churn maintenance risk and that you must hand-manage manifest output to get stable names; NOTE the previously-cited CSP bug #918 is **closed and dev-server-only** (the same dev-CSP-relaxation risk exists for WXT and is tested for either tool — see §0). `@samrum/...` — only wins with Shadow-DOM UI + HMR, which we explicitly avoid. `aklinker1/vite-plugin-web-extension` — author moved to WXT.

### 2.2 Typed cross-surface messaging — **hand-rolled discriminated-union `ProtocolMap` over `chrome.*`** (critic B2)
A typed DU `ProtocolMap` + thin `send()`/`route()` wrappers over `chrome.runtime`/`chrome.tabs`, with **explicit `sender.tab` routing**. This is *more* faithful to "preserve quirks verbatim" than a library: it keeps the `sender.tab` discriminant explicit, models fire-and-forget vs req/resp in the type, and preserves the exact `return true | false` channel semantics — with zero runtime deps and no `browser.*` polyfill.

**Rejected:** `@webext-core/messaging` — abstracts away `sender.tab` routing, always sends a response (can't model genuine fire-and-forget cleanly), and is built on the `browser.*`/`webextension-polyfill` namespace while the whole codebase + `@types/chrome` are `chrome.*`. Wrong fit for a protocol whose value is its preserved quirks. (Same reasoning ⇒ storage mirror is a thin hand-rolled typed wrapper over `chrome.storage.local`, not `@webext-core/storage`.)

### 2.3 State — background-resident observable `Store` + `chrome.storage` mirror
Background remains the single source of truth (popup = passive renderer, content = injected, stateless-persistent). Durable bits (the 8 `DEFAULT_SETTINGS`, auth/tier) mirror to `chrome.storage.local`; ephemeral session bits (tabId, running, AbortController) live in memory and reset to clean idle on SW cold start — **preserving current 0.6.3 behavior, including R2** (mid-session SW death orphans the session). We do NOT add `chrome.storage.session` hardening (that's a behavior change → out of scope).

### 2.4 OOP vs functional balance
- **Classes** (identity + lifecycle): `Store`, `SessionManager` (owns the module-global `pageToken` guard + per-session `AbortController`), `RealtimePipeline` (PeerConnection lifecycle), `StandardChunkedPipeline`, `SubtitleFirstPipeline`, `AudioCapture`, `Overlay` (render-only view).
- **Pure functions** (`src/lib`, chrome-free, the unit-test surface): cost/format/classify, `parseKymaError`, `pickCaptionTrack`, `parseJson3Events`, `regroupToSentences`, `computeGain`, WAV/resample math, popup reducers (`fmtMin`, `meterLevel`, tier-gating), the message dispatcher/validators, the `apiMode` resolver, the "mode by request shape" decision.

---

## 3. Module Architecture & File Ownership (preview — locked in Phase 3a)

```
extension/
  wxt.config.ts                  # manifest gen, permissions verbatim, CSP, stable output names
  package.json  tsconfig.json  vitest.config.ts
  src/
    shared/                      # ── CONTRACT LAYER (locked first, Phase 3a) ──
      protocol.ts                #   ProtocolMap (DU) + send()/route() over chrome.* + sender.tab routing
      types.ts                   #   State, Settings, Session, Tier, Usage, ApiMode shapes
      ports.ts                   #   OverlayCallbacks (UI→pipeline seam), pipeline ports
      storage.ts                 #   storage schema + keys (DEFAULT_SETTINGS, LAYOUT_KEY) over chrome.storage.local
      constants.ts               #   LANGUAGES, REALTIME_VOICES, STANDARD_VOICES, caps, timings,
                                 #   CONTENT_SCRIPT_PATH = "content-scripts/content.js" (single source)
    lib/                         # pure, chrome-free, fully unit-tested
      cost.ts caption.ts audio.ts format.ts apiMode.ts ...
    background/
      index.ts                   # entrypoint glue (single eager SW chunk, sync listeners)
      store.ts router.ts auth.ts session-coordinator.ts webRequest.ts
    content/
      index.ts                   # IIFE entry; F9 version guard FIRST; bootstraps modules
      session-manager.ts         # pageToken (module-global) + AbortController
      capture.ts                 # captureStream + F5 retry + Web Audio gain graph
      pipelines/
        realtime.ts              # WebRTC; SDP POST direct to OpenAI; dual token-guard
        standard-chunked.ts      # Gemini understand + MiniMax speech; guard after every await
        subtitle-first.ts        # default non-live Standard path
        captions.ts              # 3-layer acquisition (webRequest → DOM → timedtext)
      controller.ts              # owns select-change DISPATCH: binds OverlayCallbacks →
                                 #   realtime⇒requestHandover, standard⇒mutate settings+notifyBackground+setStatus
      overlay/                   # ── UI (render-only, byte-identical DOM) ──
        overlay.ts               # buildOverlay(callbacks)/removeOverlay/setOverlayState/... (~10 fns)
        template.ts              # the exact innerHTML template + applyLayout inline styles
    popup/
      index.html  popup.ts  popup.css   # passive renderer; applyState(s); IDs preserved
    public/ or assets/
      content.css  icons/                # verbatim filenames; manifest-injected
  legacy/                        # archived 0.6.3 originals (git mv'd), kept until smoke passes
```

**Hard build contracts (load-bearing):**
- Content emits at WXT's stable unhashed `content-scripts/content.js` + `content-scripts/content.css` (verified §0). The single shared constant `CONTENT_SCRIPT_PATH` is the ONLY place that path appears; `chrome.scripting.executeScript({files:[CONTENT_SCRIPT_PATH]})` and `insertCSS` use it (replacing the old literal `"content.js"`). Spike AC: `executeScript` against the WXT-built bundle succeeds and re-injection is F9-guarded.
- **F9 guard under WXT:** content code keeps its OWN lifecycle (module-global `pageToken` + own `AbortController` + raw `setInterval`/`setTimeout`), does **NOT** use WXT's `ctx`, and the F9 version-keyed guard (`window[GLOBAL_KEY] === VERSION`) is the **first statement in `main()`** (it is version-keyed, NOT a DOM-marker — a newer version re-inject must clean stale `.ec-root` + restamp).
- Background SW = **single eagerly-evaluated chunk**, all `addListener` calls synchronous at top level, no dynamic `import()` before registration, no top-level await.
- Prod manifest CSP exactly `script-src 'self'; object-src 'none'` — do **NOT** add a `connect-src` directive (network egress is governed by `host_permissions`; a `connect-src` would break the realtime OpenAI SDP POST and Kyma/Echoly fetches). Permissions verbatim: `activeTab, scripting, storage, webRequest, cookies`.
- **host_permissions = the EXACT set from committed 0.6.3** (no "if present", no tidying): `https://*.youtube.com/*`, `https://youtube.com/*`, `https://api.kymaapi.com/*`, `https://api.echolyhq.com/*`, `https://echolyhq.com/*` — plus `api.openai.com` is present in the realtime SDP path and MUST be kept. The server-repoint (drop `api.openai.com`, `/v1/proxy`→`/v1`) is **explicitly out of scope** → lives in `uncommitted-server-repoint.patch` for the next wave.
- **No Shadow DOM.** Overlay stays imperative DOM appended to `document.documentElement`; CSS injected via manifest (plain `.css`, never `.module.css`, so class names aren't hashed). `createShadowRootUi` is forbidden (regresses the draggable overlay cascade/events).
- Single-source the version (WXT manifest from `package.json` = `0.6.3`); the F9 guard token reads that version (fixes the `0.6.1`/`0.6.3` drift). Safe: F9 cleanup keys on removing `.ec-root` on version mismatch, not the old literal. Document the old `0.6.1` literal in migration notes so nobody "restores" it.

---

## 4. Contracts / Public API (headline — full table in Phase 3a `protocol.ts`)

**Message protocol (15 types, preserve quirks — do NOT "fix"):**
- popup→bg: `GET_STATE`, `GET_AUTH` (defined, never called — keep), `START`, `STOP`, `UPDATE_SETTINGS`, `UPDATE_VOLUME` (fire-and-forget), `SIGN_OUT_ECHOLY`
- bg→popup: `BACKGROUND_STATE_UPDATE` (push, 50ms leading-edge debounce)
- bg→content: `CONTENT_PING`, `CONTENT_START`, `CONTENT_STOP`, `CONTENT_UPDATE_SETTINGS`, `CONTENT_UPDATE_VOLUME`
- content→bg: `CONTENT_STATE`, `CONTENT_ENDED` (push), `GET_YT_CC_URL` (callback req/resp)
- Routing pivots on `sender.tab` truthiness. Async popup branch returns `true`; content paths return `false`. `CONTENT_UPDATE_SETTINGS` response `state` is **optional** (bg reads `reply.state` but content may not send it). Content's outbound `UPDATE_SETTINGS` is a no-op by routing — preserve.

**State shape (popup render contract — exact fields):** `running, connecting, paused, tier, targetLanguage, realtimeVoice, standardVoice, originalVolume, voiceVolume, showSource, kymaKey (=resolved bearer, legacy name), status, errorMessage, signedInUser{email,tier}, usage{standard,realtime}, apiMode`.

**Settings (DEFAULT_SETTINGS — 8 keys):** persisted to `chrome.storage.local`; `kymaKey` is the resolved bearer (Kyma key OR Echoly session token) — keep the legacy name unless renamed on BOTH sides.

**`OverlayCallbacks` port (UI↔pipeline seam — Finding 5):** `buildOverlay(callbacks)` receives `{ onLanguageChange(lang), onVoiceChange(voice), onStop(), onHideToggle(show), ... }`. The overlay binds the `<select>`/button DOM events but only invokes these callbacks — it never reaches into pipeline globals. `content/controller.ts` implements them with the EXACT branch logic to preserve: realtime tier ⇒ `requestHandover(...)`; standard tier ⇒ mutate `settings` in place + `notifyBackground()` + `setStatusText("Switching to …")` + `setOverlayState("live")`. This branch is characterization-tested so the C1/H3 (failed-handover token-bump, "lang/voice change during subtitle-first") behaviors can't regress.

---

## 5. Correctness Invariants to Preserve (test-locked)

1. **F9 version guard** — content entry early-returns on re-inject (`window[GLOBAL_KEY] === VERSION`); cleans stale `.ec-root` first. Must stay at the very top of the single IIFE.
2. **F6 `pageToken` guard** — **module-global**, bumped on Stop to invalidate ALL in-flight pipelines (incl. pre-session builds and no-caption fallback). Two idioms preserved separately: realtime dual-check (`token!==pageToken && session?.token!==token`), chunked/subtitle identity-check (`s!==session`). `processStandardChunk` checks the guard **after every one of its ~6 awaits** (credit-burn protection).
3. **Per-session `AbortController`** — Stop aborts in-flight fetches so credits aren't burned; every abort-wired fetch enumerated in research doc 02.
4. **Session limits** — `SESSION_LIMIT_MS` 60min auto-stop, `SESSION_WARNING_MS` 55min warning, `HEARTBEAT_MS` 30s, `CAPTION_POLL_MS` 350ms, `VOICE_GAIN_MAX` 2.0.
5. **Tier caps** — free 30/0, pro 600/0, max 3000/120 (rt). **BYOK-wins apiMode** resolution.
6. **UI fidelity** — `.ec-*` classes + `data-ec-*` hooks + `data-ec-resize`; `data-state` (ready/connecting/live/paused/error); collapse thresholds 560/210, 760/235; `--ec-target-lines`; LAYOUT_KEY shape; HISTORY_MAX 16 (newest-first + `column-reverse`); RTL_LANGS `{ar,fa,he,ur}`; toast built via DOM APIs (not innerHTML — XSS guard); popup element IDs + `body[data-state]`/`[data-tier]`/`.usage-fill[data-level]` selectors; all copy verbatim; both rendered option-list forms (overlay "Auto" vs popup "Auto · clones speaker"). Dead CSS carried verbatim (prune only with sign-off).
7. **No BUGS.md regressions** — C1, C2, H1–H4, M1–M6 must not return.

---

## 6. Acceptance Criteria (concrete, testable)

**Gates (hard):** `tsc --noEmit` 0 errors · `vitest run` green · `wxt build` produces an output whose `manifest.json` has CSP `script-src 'self'; object-src 'none'`, all 5 permissions, verbatim host_permissions, and stable unhashed `content-scripts/content.js` + `content-scripts/content.css` (the `CONTENT_SCRIPT_PATH`). Plus the build-gate checks below (critic round-2 MINORs):
- **M-a (SW single module-chunk):** with `defineBackground({type:"module", main(){…}})`, assert the built `background.js` is a single file with all `addListener` calls synchronous and no dynamic `import()` before registration (WXT can code-split a `type:module` SW — verify it didn't). This was the one contract the spike didn't exercise (spike SW was non-module).
- **M-c (popup CSS may be hashed):** popup's bundled CSS/JS (`assets/popup-*.css`, loaded via generated `popup.html`) MAY be hashed — that's fine. Only the overlay `content.css` (manifest-injected) must be the stable unhashed path. Do not waste effort forcing an unhashed popup bundle.

**Test strategy — honest coverage map (Finding 6).** Pure-fn golden tests prove the stateless logic; they do NOT prove the stateful async control flow, which is where most correctness lives. So the suite has THREE layers, and we name the unverifiable gap explicitly:
- **Layer A — pure-fn golden/characterization tests** (`src/lib`, chrome-free): AC1 below.
- **Layer B — state-machine / interaction tests** (with a small hand-rolled `chrome.*` mock, `chrome.*` namespace — not `browser.*`): (i) `processStandardChunk` against a `pageToken` that flips mid-pipeline ⇒ assert it no-ops after the flip, AND assert via spies that the guard predicate is called after each of its awaits; (ii) Stop ⇒ assert `abortController.abort()` fired and every wired fetch received the signal; (iii) the dual-guard predicate vs identity-guard predicate as a table test (they are NOT interchangeable); (iv) the `OverlayCallbacks` realtime-vs-standard branch.
- **Layer C — manual-only, provider-gated (NO automated parity proof — stated as a limitation):** the realtime WebRTC/PeerConnection path, MediaRecorder/captureStream, and live-YouTube DOM. Covered solely by the AC2 smoke checklist; if providers (Kyma/Echoly) are down, this proof is blocked and must be re-run when they return.

**Behavioral parity:**
- AC1 (Layer A) — Golden tests pass for: `parseKymaError`, `pickCaptionTrack`, `parseJson3Events`, `regroupToSentences`, `computeGain`, WAV/resample, `fmtMin`/`meterLevel`/tier-gating, message dispatcher/validators, `apiMode` resolver. Inputs/outputs captured from `legacy/` originals.
- AC1b (Layer B) — the four interaction tests above are green.
- AC2 — TEST-MATRIX TC-1…TC-6 pass manually (5-point smoke checklist) on a real YouTube video: free signed-in start w/o Kyma key, realtime session, standard subtitle-first session, lang swap mid-session (zero-gap handover), Stop aborts fetches, 60-min auto-stop + 55-min warning.
- AC3 — Overlay renders byte-identical DOM/CSS (visual diff against 0.6.3); popup renders identically across all `data-state` values; draggable/resizable + layout persistence work.
- AC4 — Message protocol unchanged (all 15 types, same payloads, quirks preserved); state shape unchanged.
- AC5 — `dist/` zips and loads as unpacked extension in Chrome 116+ with no CSP violations (Playwright or manual).

**Definition of done:** all gates green, AC1+AC4+AC5 automated-green, AC2+AC3 manually verified against the smoke checklist, `legacy/` retained, no stubs/TODOs.

---

## 7. Migration Mechanics (destructive — human checkpoint required)

1. Branch (e.g. `rebuild/ts-wxt`).
2. `git mv content.js background.js popup.js popup.html content.css popup.css manifest.json legacy/` (history-preserving).
3. Scaffold WXT + TS + Vitest + `wxt.config.ts` (manifest gen, permissions/CSP verbatim, stable content output names).
4. **Phase 3a:** lock `src/shared/*` contracts + FEATURE-MAP (file ownership).
5. Capture golden fixtures from `legacy/` for AC1.
6. Port logic into `src/` (parallel build agents, non-overlapping files).
7. Gate: `tsc --noEmit` + `vitest` + `wxt build`.
8. Confirm CSP-clean generated `dist/manifest.json`.
9. Manual smoke (AC2/AC3).
10. Cutover: `wxt zip` (or keep `pack.sh` pointed at `dist/`); delete `legacy/` only after smoke passes.

---

## 8. Resolved Questions (critic round 1 + spike)

- Q1 — **RESOLVED:** drop `@webext-core/*` runtime deps. Messaging + storage are hand-rolled typed wrappers over `chrome.*`; the vitest `chrome.*` mock is a small hand-rolled fake (or `sinon-chrome`, chrome.* namespace) — no `browser.*` polyfill anywhere.
- Q2 — **RESOLVED:** keep version `0.6.3`; F9 guard token reads the manifest version (fixes the drift); old `0.6.1` literal recorded in migration notes only.
- Q3 — **RESOLVED by §0 spike:** WXT emits stable unhashed `content-scripts/content.js`/`.css`; pin via `CONTENT_SCRIPT_PATH`. No WXT-internals fight needed.
- Q4 — **RESOLVED:** Vitest (Layers A+B) + manual smoke checklist are required gates; Playwright e2e is a stretch (nice-to-have), not a gate this wave.
