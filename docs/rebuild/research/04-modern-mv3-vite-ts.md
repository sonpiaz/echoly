# 04 — Modern MV3 + Vite + TypeScript Architecture (External/Reference Research)

> Research Agent 4 of 5 — feature-wave: rebuild Echoly extension (plain JS → modular TS + Vite).
> Slice: EXTERNAL/REFERENCE — define the best-practice toolchain & architecture to adopt.
> Date-stamped: **2026-05-27**. Vite 6/7 era. All versions verified via web search this date.
> READ-ONLY on source; this doc is the only write.

---

## TL;DR — one recommendation per decision

| # | Decision | Recommendation (2026-05-27) | Confidence |
|---|---|---|---|
| 1 | Build tool / Vite plugin | **WXT** (`wxt`, framework-agnostic, vanilla-TS mode) | High |
| 2 | MV3 module SW | Keep `"type":"module"`; **all runtime code inside `defineBackground(() => …)`**; no top-level await; static imports only | High |
| 3 | Content script | Authored as TS module, **bundled to a single IIFE** by WXT (Rollup); CSS via `cssInjectionMode:"manifest"` to preserve current behavior | High |
| 4 | Folder structure | `entrypoints/` (WXT convention) + `src/` (shared/background/content/popup libs) — concrete tree below | High |
| 5 | Typed messaging | **`@webext-core/messaging`** (`defineExtensionMessaging`, discriminated protocol map) | High |
| 6 | State management | Background = single source of truth; **observable store class + `@webext-core/storage` (`defineExtensionStorage`)** for the typed `chrome.storage` mirror | Medium-High |
| 7 | OOP vs FP | Classes for lifecycle/identity (PeerConnection, Store, pipelines); pure functions for cost/format/classify transforms | High |
| 8 | TS config | `target ES2022`, `module/moduleResolution "bundler"`, `strict:true`, types via **`@types/chrome`** (WXT's `wxt/browser` re-exports the typed API) | High |
| 9 | Testing | **Vitest** unit + **`@webext-core/fake-browser`** for `chrome.*`; **Playwright** with loaded unpacked extension for e2e | High |

**Primary risk to UI-preservation / CSP:** the build tool must NOT rewrite our overlay into a Shadow DOM (would break `content.css` cascade & the draggable overlay), and must NOT mutate the production `content_security_policy` (`script-src 'self'; object-src 'none'`). WXT satisfies both: use `createIntegratedUi` (or no UI helper at all — keep imperative DOM) with `cssInjectionMode:"manifest"`, and WXT only relaxes CSP in **dev** mode, emitting the clean strict CSP in the production zip. CRXJS, by contrast, has a known Chrome 130+ CSP-injection bug — a concrete reason to reject it (detail in §1).

---

## 1. Build tool / Vite plugin comparison

### 1.1 The field (verified versions, 2026-05-27)

| Tool | Pkg | Latest | Built on | Maintenance state | React-required? |
|---|---|---|---|---|---|
| **WXT** | `wxt` | 0.20.x (regular Feb 2026 releases, ~216 contributors) | Vite + own framework layer (same author as aklinker1 plugin) | **Actively maintained — 2026 market leader** | No — framework-agnostic |
| **CRXJS** | `@crxjs/vite-plugin` | **2.4.0** (last publish ~2 mo ago); supports Vite 3→8-beta | Vite plugin | **Revived after near-archival** (was slated for archive 2025-06-01 if no maintainer found; transition completed, but history of instability) | No |
| **samrum** | `@samrum/vite-plugin-web-extension` | active | Vite plugin | Maintained; niche (best-in-class Shadow-DOM HMR) | No |
| **aklinker1** | `vite-plugin-web-extension` | active (v4-era) | Vite plugin | Maintained, but **superseded by the author's own WXT** | No |

> Note: `@samrum/...` and `aklinker1/...` are two *different* packages by different authors that happen to share a near-identical name — do not conflate. WXT is aklinker1's successor project and is where that author's effort now goes.

### 1.2 Comparison matrix (for OUR case: 3 surfaces, vanilla TS, no React, YouTube content script, strict CSP, pack.sh zip)

| Criterion | **WXT** | **CRXJS 2.4** | **samrum** | **aklinker1 plugin** |
|---|---|---|---|---|
| MV3 maturity (2026) | Best — purpose-built, file-based manifest | Good, but revival/instability history | Good | Good but author redirects to WXT |
| Manifest generation | **Auto from `entrypoints/` + `wxt.config` `manifest`** — typed | You hand-write `manifest.json`; plugin reads/augments | You pass a manifest object to the plugin | You pass a manifest object |
| Manifest typing | Typed config + `WxtViteConfig` | Manual JSON (typed only if you `satisfies chrome.runtime.ManifestV3`) | Typed object | Typed object |
| SW (`type:module`) HMR | **Fast reload** (not true HMR, by design) | HMR-ish; impacted by CSP bug below | Reload | Reload |
| Content-script bundling → isolated world | **Single IIFE per CS** (Rollup); no top-level ESM leaks | Bundles CS, injects loader; **HMR for CS** | Single file; **best Shadow-DOM HMR** | Single file; **no true CS-UI HMR** (watch/rebuild only) |
| Content-script HMR | Fast reload of CS; **IFrame UI supports HMR**; integrated/shadow UI = reload | **True CS HMR** (its headline feature) | True HMR for Shadow-DOM CS UI | Watch+rebuild only |
| Popup/HTML HMR | True Vite HMR | True Vite HMR | True Vite HMR | True Vite HMR |
| CSP compatibility (prod) | **Clean strict CSP in prod zip; dev-only relaxation** | **Known Chrome 130+ CSP bug** (injects `http://localhost:*`, dynamic-import `Failed to fetch` failures) | Clean | Clean |
| Zip output for pack.sh | **Built-in `wxt zip`** → `.output/*.zip` (can replace pack.sh) | `dist/` only — pack.sh still zips it | `dist/` | `dist/` |
| Vanilla-TS ergonomics | First-class (no framework needed) | First-class | First-class | First-class |
| Cross-browser (future Firefox) | **Built-in** (`--browser firefox`, polyfill-aware) | Chrome-focused | Built-in | Built-in |
| Built-in helpers we'd otherwise hand-roll | `injectScript` (main world), `createIntegratedUi`/`ShadowRootUi`, storage/messaging guides, `#imports` auto-import | None — bring-your-own | UI helpers | Minimal |
| Lock-in / "magic" | Highest (conventions, virtual modules, NodeJS-context build of entrypoints) | Low | Low | Low |

### 1.3 RECOMMENDATION — **WXT**

**Rationale (ranked):**

1. **Maintenance & longevity.** WXT is the actively-maintained 2026 leader with regular releases and a large contributor base. CRXJS spent 2025 under an archive threat; even though it was revived to 2.4.0, betting the rebuild on a project with that recent instability — *and* a current open Chrome 130+ CSP bug — is the wrong risk for a shipping consumer extension.
2. **CSP safety (our hard constraint).** We must emit `script-src 'self'; object-src 'none'` in the shipped zip. WXT confines all HMR/dev CSP relaxation to dev mode and produces a clean strict CSP in production. CRXJS's documented Chrome 130+ behavior (injecting `http://localhost:*` into CSP, causing `TypeError: Failed to fetch dynamically imported module`) is a live hazard against exactly our policy.
3. **Manifest as typed config, not hand-edited JSON.** Our current `manifest.json` (permissions, `host_permissions`, `minimum_chrome_version:116`, MV3 SW `type:module`, content-script matches) becomes typed config in `wxt.config.ts`, validated against WXT's MV3 types — eliminating a class of "forgot to update the manifest" bugs during the rebuild.
4. **Content-script story matches ours exactly.** WXT bundles each content script to a single IIFE (solves the top-level-ESM problem, §3) and supports `cssInjectionMode:"manifest"` so `content.css` keeps injecting into the page DOM exactly as today — **no forced Shadow DOM**, so the draggable overlay & current CSS cascade are preserved (see §3 / UI risk note).
5. **Replaces pack.sh.** `wxt zip` reads the version and emits `.output/<name>-<version>-chrome.zip`. We keep `pack.sh` as a thin wrapper or retire it.
6. **Free Firefox path.** Not needed now, but the server/extension roadmap is multi-surface; WXT's cross-browser build costs us nothing to keep open.

**Rejected alternatives:**

- **CRXJS** — rejected primarily on (a) the recent near-archival/instability and (b) the open Chrome 130+ CSP-injection bug that directly threatens our strict `extension_pages` CSP. Its standout feature (true content-script HMR) is *nice-to-have*; our content script is a large imperative pipeline where a fast full reload is perfectly acceptable, so we are not paying meaningfully for losing CS-HMR.
- **`@samrum/vite-plugin-web-extension`** — excellent only if we were committing to Shadow-DOM-rendered UI with live HMR. We are explicitly *preserving* a non-shadow overlay, so its key differentiator is irrelevant, and it offers fewer batteries (manifest gen, zip, main-world injection) than WXT.
- **`aklinker1/vite-plugin-web-extension`** — the author themselves moved on to WXT; it has no true content-script-UI HMR (watch+rebuild only) and fewer conveniences. Choosing it over WXT is choosing the predecessor.

**One caveat on WXT lock-in:** WXT imports each entrypoint in a **NodeJS context at build time**, so *all runtime code must live inside the `defineBackground`/`defineContentScript`/`defineUnlistedScript` callback* (top-level runtime code throws, e.g. `document is not defined`). This is a real authoring rule the build agents must follow, but it is also good MV3 hygiene (no top-level side effects in an ephemeral SW). We accept the convention cost for the maintenance + CSP + manifest wins.

---

## 2. MV3 module service worker constraints (`"type":"module"` under a bundler)

Our manifest already declares `"background": { "service_worker": "background.js", "type": "module" }`. Keep it. Constraints the rebuilt TS SW must respect:

- **Ephemerality.** The SW is killed after ~30s idle and respawned on events. **No long-lived in-memory state survives.** Any state that must persist across restarts goes to `chrome.storage` (see §6). In-memory `state` is a *cache rebuilt on wake*, not the source of durability.
- **No top-level `await`.** Even though `type:module` technically allows TLA, the SW lifecycle + bundling make it fragile (the worker may be evaluated/parsed under conditions where a hanging top-level promise stalls registration). **Do all async work inside event listeners.** With WXT, this is enforced naturally: runtime code lives inside `defineBackground(() => {...})`.
- **Register all event listeners synchronously at top of the callback.** `chrome.runtime.onMessage`, `chrome.tabs.*`, alarms, etc. must be added on the *synchronous* first turn of SW evaluation, or events that wake the SW can be missed. Do not `addListener` inside a `then()`/`await`.
- **Dynamic `import()` is restricted.** MV3 SWs disallow arbitrary runtime dynamic imports of remote/unbundled modules (and strict CSP blocks remote code regardless). Under a bundler this is moot — everything is bundled at build time into the single SW file — but do **not** introduce runtime code-splitting/`import()` of chunks in the SW path. WXT's default background output is a **single IIFE** unless you opt into `type:"module"` background output (which enables code-splitting between SW and HTML pages). For our SW we keep it bundled-single to avoid dynamic-chunk fetches at wake time. (Manifest can still say `type:module`; the bundled output is one file.)
- **No DOM in the SW.** `window`/`document` are undefined. Pure logic + `chrome.*` only. (WXT's NodeJS-context build will surface this at build time if violated.)
- **`importScripts()` is unavailable** in a module SW — irrelevant under a bundler, just don't reach for it.

---

## 3. Content-script constraints (isolated world)

### 3.1 Why raw top-level ESM `import` fails in a content script

A content script is injected by Chrome as a **classic script into the page's isolated world** — there is no module loader / `import.meta` resolution wired up for it, and MV3 has no native "module content script" the way it has a module SW. So a file that begins with `import { x } from "./y.js"` simply **throws a SyntaxError** ("Cannot use import statement outside a module") when injected. (You *can* dynamically `import(chrome.runtime.getURL(...))` at runtime, but that's a fragile manual pattern.) This is exactly why our current `content.js` is one giant IIFE with everything inlined.

### 3.2 How WXT solves it

WXT authors content scripts as normal TS modules with `import`s, then **Rollup-bundles each content script into a single, self-contained IIFE** — one file, no top-level `import`, no leaked ESM — which is what lands in the manifest's `content_scripts[].js`. This is the standard, correct solution and is identical in spirit to what CRXJS/samrum/aklinker do. We get modular authoring (split `content/` into many TS files) with a single-IIFE emit. (WXT does *not yet* offer ESM/HMR for content scripts; chunking is planned. Acceptable for us — see §1.3.)

### 3.3 Isolated world (keep) vs main world (only if needed)

- **Keep the isolated world.** Our content script needs `chrome.runtime` messaging and only the page's DOM (the `<video>` element, overlay). Isolated world gives exactly that and is the default.
- **If we ever need page-context JS** (e.g., reaching into YouTube's player internals, which today we avoid), use **WXT `injectScript()`** rather than `world:"MAIN"` — it works across MV3/MV2 and all browsers and supports bidirectional `CustomEvent` messaging. Not needed for current behavior.

### 3.4 CSS injection — preserve current behavior

Today `content.css` is listed in `content_scripts[].css` and injected into the page DOM normally (the overlay is styled by the page-level cascade, not a Shadow DOM). To preserve this **exactly**:

- Use **`cssInjectionMode:"manifest"`** (WXT default): WXT bundles the imported CSS and adds it to the manifest's `css` array — same delivery as today.
- **Do NOT migrate the overlay to `createShadowRootUi`** during this rebuild. Shadow DOM would re-scope styles and change the cascade/event behavior of the existing draggable overlay — a UI-preservation regression. If a UI helper is wanted, `createIntegratedUi` (renders into page DOM, page styles apply) matches current semantics; otherwise just keep the imperative `document.createElement` overlay code.

---

## 4. Recommended folder structure

WXT requires an `entrypoints/` directory (it derives the manifest from it). Everything else (shared logic, per-surface internals) lives under `src/` and is imported into the entrypoints. Concrete tree:

```
extension/
├─ wxt.config.ts              # manifest (typed) + build config; replaces hand-written manifest.json
├─ tsconfig.json              # extends .wxt/tsconfig (WXT-generated); see §8
├─ package.json               # scripts: dev / build / zip / test / lint
├─ vitest.config.ts
├─ playwright.config.ts
├─ public/                    # static, copied verbatim
│  └─ icons/                  # icon-16/32/48/128.png  (from current icons/)
├─ entrypoints/               # WXT entrypoints — manifest is generated from these
│  ├─ background.ts           # export default defineBackground(() => boot(...))  — thin
│  ├─ content/                # content script as a DIRECTORY entrypoint (multi-file allowed)
│  │  ├─ index.ts             # export default defineContentScript({matches, css, main})
│  │  └─ style.css            # imported here; cssInjectionMode:"manifest" (== current content.css)
│  └─ popup/
│     ├─ index.html           # == current popup.html
│     ├─ main.ts              # popup bootstrap (was popup.js)
│     └─ popup.css            # == current popup.css
├─ src/
│  ├─ shared/                 # imported by 2+ surfaces — the contract layer
│  │  ├─ messaging.ts         # defineExtensionMessaging<ProtocolMap>() — typed bus (§5)
│  │  ├─ types.ts             # domain types, Tier, SessionState, settings shapes
│  │  ├─ protocol.ts          # ProtocolMap discriminated union of all messages
│  │  ├─ storage.ts           # defineExtensionStorage typed schema (§6)
│  │  └─ constants.ts         # API base URLs, model ids, caps
│  ├─ background/             # SW internals (pure where possible)
│  │  ├─ boot.ts              # registers listeners synchronously (called by entrypoint)
│  │  ├─ store.ts             # Store class — single source of truth (§6)
│  │  ├─ session-manager.ts   # session lifecycle, AbortController, pageToken guard
│  │  ├─ rtc/                 # PeerConnection lifecycle class(es) — Realtime tier
│  │  ├─ standard/            # chunked STT→translate→TTS pipeline — Standard tier
│  │  └─ api-client.ts        # fetch wrapper to api.echolyhq.com (auth headers)
│  ├─ content/                # content internals (imported by entrypoints/content/index.ts)
│  │  ├─ overlay/             # draggable overlay DOM (imperative; preserves current UI)
│  │  ├─ audio-capture.ts     # <video> captureStream wiring
│  │  └─ controller.ts        # tier pipeline orchestration in the page
│  ├─ popup/                  # popup internals (renderer only — passive)
│  │  ├─ render.ts            # reads state via messaging, renders
│  │  └─ components/          # small view helpers (vanilla DOM)
│  └─ lib/                    # pure, surface-agnostic, dependency-free
│     ├─ cost.ts              # pure cost/centi-minute math
│     ├─ format.ts            # pure formatters (time, labels)
│     ├─ classify.ts          # pure mode/shape classification
│     └─ result.ts            # Result<T,E> helpers (optional)
├─ test/
│  ├─ unit/                   # vitest — lib/* and pure logic
│  ├─ integration/            # vitest + @webext-core/fake-browser — store/messaging
│  └─ e2e/                    # playwright — loaded unpacked extension
└─ .output/                   # build output (gitignored); wxt zip writes here
```

Rationale:
- **`entrypoints/*` are thin** — each just calls into `src/`. This keeps the NodeJS-build-context rule (§2) trivial to satisfy and makes the surfaces testable as plain modules.
- **`src/shared/` is the contract layer** (messaging protocol, types, storage schema). Per the codebase's feature-wave norm, lock these *first* so parallel build agents own non-overlapping files (Agent-SW, Agent-content, Agent-popup) and integrate cleanly.
- **`src/lib/` is pure** — no `chrome.*`, no DOM — so it's unit-testable without any browser mock and reusable across surfaces.

---

## 5. Cross-surface typed messaging

### 5.1 The problem with hand-rolled `chrome.runtime.sendMessage`

`chrome.runtime.sendMessage(msg)` is `any`-typed both ways. With three surfaces and many message kinds (start/stop session, state push, settings change, auth, metering updates), a hand-rolled switch on `msg.type` is workable but loses compile-time guarantees on payload/return shapes and is easy to drift.

### 5.2 Library landscape (2026-05-27)

| Lib | Pkg | State | Verdict |
|---|---|---|---|
| **@webext-core/messaging** | `@webext-core/messaging` | **v2.3.x, actively maintained**; typed protocol map; used/blessed by WXT docs | **Recommend** |
| webext-bridge | `webext-bridge` | v6.0.1 **last published ~3 yrs ago** — stale | Reject (unmaintained) |
| hand-rolled DU + wrapper | — | always available | Fallback if we want zero deps |

### 5.3 RECOMMENDATION — `@webext-core/messaging`

Define one protocol map (a TS interface mapping message name → `(data) => returnType`); the lib gives you a typed `sendMessage`/`onMessage` pair with full inference and works in all contexts (SW/content/popup). It pairs naturally with WXT (which documents it as the messaging option) and shares an author/ecosystem with our chosen storage + fake-browser test tooling.

```ts
// src/shared/protocol.ts
import { defineExtensionMessaging } from "@webext-core/messaging";
import type { SessionState, Tier, Settings } from "./types";

interface ProtocolMap {
  // popup/content → background
  startSession(args: { tabId: number; tier: Tier; pair: string }): { sessionId: string };
  stopSession(args: { sessionId: string }): void;
  getState(): SessionState;
  updateSettings(patch: Partial<Settings>): Settings;
  // background → content/popup (broadcast via tabs.sendMessage / runtime)
  stateChanged(state: SessionState): void;
}

export const { sendMessage, onMessage } = defineExtensionMessaging<ProtocolMap>();
```

```ts
// background: handler is fully typed; return type checked against ProtocolMap
onMessage("startSession", ({ data }) => store.startSession(data)); // data: {tabId,tier,pair}
// popup: call site is typed; result inferred as { sessionId: string }
const { sessionId } = await sendMessage("startSession", { tabId, tier, pair }, /*tabId for CS*/);
```

If we want **zero runtime deps**, the fallback is a hand-rolled discriminated-union (`type Msg = {kind:"startSession"; ...} | ...`) plus a small typed `send<K>()` wrapper — same ergonomics, more boilerplate, no inference for the response side. Given the lib is tiny, maintained, and ecosystem-aligned, prefer it.

---

## 6. State management (background = single source of truth)

Constraints from our architecture: **background owns `state`; popup is a passive renderer; content script is injected & reports up.** Plus MV3 ephemerality (§2) — in-memory state can be wiped at any idle.

### 6.1 Pattern: observable Store class + typed chrome.storage mirror

- **`Store` class in the SW** holds the authoritative in-memory state and exposes `get()`, `subscribe(listener)`, and intent methods (`startSession`, `stopSession`, `applySettings`). Subscribers fire `stateChanged` broadcasts (§5) to popup/content.
- **Durability via typed storage.** Use **`@webext-core/storage` `defineExtensionStorage`** (or WXT's `storage` helper / `wxt/storage`) to define a typed schema over `chrome.storage.local`/`sync`. On SW wake, the Store **rehydrates** from storage; on mutations that must survive restart (settings, auth token, last tier), it **persists**. Ephemeral session state (active `sessionId`, AbortController) is NOT persisted — it's reconstructed/cancelled on wake.
- **Storage change events** (`chrome.storage.onChanged`) can also feed the Store so popup/options edits stay consistent without bespoke plumbing.

```ts
// src/shared/storage.ts
import { defineExtensionStorage } from "@webext-core/storage";
interface Schema { settings: Settings; authToken: string | null; lastTier: Tier; }
export const storage = defineExtensionStorage<Schema>(chrome.storage.local);
```

```ts
// src/background/store.ts  (sketch)
export class Store {
  #state: SessionState = initialState();
  #subs = new Set<(s: SessionState) => void>();
  get() { return this.#state; }
  subscribe(fn: (s: SessionState) => void) { this.#subs.add(fn); return () => this.#subs.delete(fn); }
  #set(patch: Partial<SessionState>) { this.#state = { ...this.#state, ...patch }; this.#subs.forEach(f => f(this.#state)); }
  async hydrate() { this.#set({ settings: await storage.getItem("settings"), tier: await storage.getItem("lastTier") }); }
  async applySettings(p: Partial<Settings>) { const s = { ...this.#state.settings, ...p }; await storage.setItem("settings", s); this.#set({ settings: s }); }
}
```

**Don't reach for Redux/Zustand/etc.** A single SW-resident observable store + typed storage covers a 3-surface extension without a UI-framework state lib. The popup/content never hold authoritative state — they `getState()` on open and listen for `stateChanged`.

---

## 7. OOP vs functional balance

Pragmatic rule: **classes where there is identity + lifecycle + invariants to protect; pure functions where there is a transform.**

**Use classes for:**
- **`PeerConnection` / RTC bridge lifecycle** — has connection state, must be created/torn-down, owns an `RTCPeerConnection`, tracks, and an `AbortController`. Classic stateful object.
- **`Store`** (§6) — identity + subscribers + invariants.
- **`SessionManager`** — owns the `pageToken`-captured-in-closure guard and the per-session `AbortController` (the two correctness patterns the CLAUDE.md flags). Lifecycle object.
- **Tier pipelines** (Realtime, Standard) — each owns streams/buffers and a start/stop lifecycle; modeling as classes implementing a small `TierPipeline` interface keeps them swappable.

**Use pure functions for:**
- **`cost.ts`** — centi-minute math; server-authoritative recompute helpers on the client are pure given inputs.
- **`format.ts`** — time/label formatting.
- **`classify.ts`** — request-shape → mode (clip vs live) decisions; the CLAUDE.md invariant "mode decided by request shape, never a client flag" is naturally a pure function.
- DOM *builders* can be plain functions returning elements; only promote to a small class if an overlay needs its own retained handlers/teardown (the draggable overlay is borderline — a small `Overlay` class with `mount()/destroy()` is justified by its drag-state + listener lifecycle).

**Anti-patterns to avoid:** a "God service" class wrapping pure math; classes that are just namespaces of static methods (use a module of functions instead); deep inheritance (prefer small interfaces + composition — mirrors `services/ports.ts` in the server).

---

## 8. TypeScript config

Target the Chrome 116 baseline (our `minimum_chrome_version`). Chrome 116 ⇒ V8 supports ES2022 comfortably (top-level await, class fields, `.at()`, error cause all shipped well before 116). So **`target: "ES2022"`** is safe and avoids needless downleveling.

```jsonc
// tsconfig.json  (WXT generates .wxt/tsconfig.json; extend it)
{
  "extends": "./.wxt/tsconfig.json",   // WXT path aliases + #imports types
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",      // Vite/Rollup resolve; matches our bundler
    "lib": ["ES2022", "DOM", "DOM.Iterable", "WebWorker"], // WebWorker for SW globals
    "strict": true,
    "noUncheckedIndexedAccess": true,   // catches array/obj access bugs (recommended)
    "exactOptionalPropertyTypes": true, // optional but tightens settings patches
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,       // explicit type-only imports; clean tree-shaking
    "skipLibCheck": true,
    "types": ["chrome", "vitest/globals"]  // @types/chrome; add node only where needed
  }
}
```

**Chrome types — `@types/chrome` vs `chrome-types`:**
- `chrome-types` (GoogleChrome, generated from Chromium source, MV3+) is the most *accurate/up-to-date* and is Google's recommendation in the abstract.
- **But for WXT, prefer `@types/chrome`** (or simply consume WXT's `wxt/browser`, which re-exports a typed `browser`/`chrome` namespace and is what WXT's own docs/types assume). Practically, `@types/chrome` is the de-facto standard, integrates cleanly with `vitest-chrome`/fake-browser typings, and avoids the occasional shape mismatches teams hit when mixing `chrome-types` with third-party tooling. If we hit a missing brand-new MV3 API, we can add `chrome-types` narrowly. **Recommendation: `@types/chrome` as the baseline; revisit only if a needed API is missing.**

**Two TS environments:** the SW is a worker context (no DOM) and the content/popup are DOM contexts. With a bundler this is usually fine under one tsconfig with both `DOM` and `WebWorker` in `lib`; if false-positive globals become a problem, split into `tsconfig.sw.json` (no `DOM`) and a DOM one via project references. Start with one config; split only if needed.

---

## 9. Testing

### 9.1 Recommended stack

| Layer | Tool | Why |
|---|---|---|
| Unit (pure `lib/*`, logic) | **Vitest** | Fast, ESM-native, shares config style with `server/` (vitest there too) |
| `chrome.*` mocking (store, messaging, storage) | **`@webext-core/fake-browser`** | In-memory implementation of the extension APIs; storage *actually behaves* (in-memory), so you test real flows, not stubs; WXT-blessed; ecosystem-aligned with our messaging+storage choices |
| (alt mock) | `vitest-chrome` / `sinon-chrome` | Fallback if we need a fuller surface or only spy-style stubs |
| Content-script / e2e | **Playwright** with a **loaded unpacked extension** (persistent context, `--load-extension`) | Only way to exercise the real injected content script + SW + popup against a real Chromium; can drive a YouTube page (or a local fixture page) and assert overlay behavior |

### 9.2 Notes / pragmatics

- **Pure `src/lib/*` needs no mock** — that's the whole point of keeping cost/format/classify pure. Highest-value, cheapest tests; cover the centi-minute math and mode-classification invariants here.
- **Store/messaging integration tests** use `@webext-core/fake-browser`: reset between tests (`fakeBrowser.reset()`), exercise `Store.hydrate()` ↔ storage, and message round-trips through the typed protocol.
- **Playwright e2e** loads `.output/chrome-mv3` as an unpacked extension via a persistent context; it's the layer that validates UI-preservation (overlay renders, drag works, Start/Stop wiring) and CSP (no violations in the page console). Keep this suite small and high-signal — gate on it before release, not on every commit.
- **WXT has a unit-testing guide** that wires Vitest + fake-browser with the `WxtVitest` plugin so `#imports`/auto-imports resolve in tests — use it so test files can import entrypoint internals.

---

## Appendix A — concrete `wxt.config.ts` (manifest mapped from current manifest.json)

```ts
import { defineConfig } from "wxt";

export default defineConfig({
  manifestVersion: 3,
  manifest: {
    name: "Echoly — Live YouTube Translation",
    short_name: "Echoly",
    description: "Hear any YouTube video in your language. Live AI dubbing, 40+ language pairs.",
    minimum_chrome_version: "116",
    permissions: ["activeTab", "scripting", "storage", "webRequest", "cookies"],
    host_permissions: [
      "https://*.youtube.com/*", "https://youtube.com/*",
      "https://api.echolyhq.com/*", "https://echolyhq.com/*",
      // legacy gateways (kept until migration off BYOK/Kyma completes):
      "https://api.kymaapi.com/*", "https://api.openai.com/*"
    ],
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'none'"  // strict — WXT emits this clean in prod
    },
    action: { default_title: "Echoly" },   // popup is auto-wired from entrypoints/popup
    icons: { 16: "icons/icon-16.png", 32: "icons/icon-32.png", 48: "icons/icon-48.png", 128: "icons/icon-128.png" }
  }
  // background type:module + content_scripts matches/css are derived from entrypoints/*
});
```

```ts
// entrypoints/background.ts
import { boot } from "@/background/boot";
export default defineBackground({
  type: "module",          // keeps manifest "type":"module" (our current setting)
  main() { boot(); }       // ALL runtime code inside main() — NodeJS-build-context rule
});
```

```ts
// entrypoints/content/index.ts
import "./style.css";       // == current content.css; cssInjectionMode "manifest" by default
import { mountController } from "@/content/controller";
export default defineContentScript({
  matches: ["https://*.youtube.com/*", "https://youtube.com/*"],
  runAt: "document_idle",
  cssInjectionMode: "manifest",   // preserve current page-DOM CSS injection (NOT shadow DOM)
  main(ctx) { mountController(ctx); }  // bundled to a single IIFE — no top-level ESM leaks
});
```

## Appendix B — package.json scripts (replaces pack.sh build step)

```jsonc
{
  "scripts": {
    "dev": "wxt",                       // dev server + auto-reload, dev CSP only
    "build": "wxt build",               // → .output/chrome-mv3
    "zip": "wxt zip",                   // → .output/<name>-<version>-chrome.zip (replaces pack.sh)
    "lint": "tsc --noEmit",             // THE gate, mirroring server/ convention
    "test": "vitest run",
    "test:e2e": "playwright test"
  }
}
```

`release.sh`/`pack.sh` can either call `npm run zip` or be retired; the version is read from `wxt.config.ts` manifest, same as today's `manifest.json` read.

---

## Appendix C — UI-preservation & CSP risk register (for the build phase)

| Risk | Mitigation |
|---|---|
| Build tool migrates overlay to Shadow DOM, breaking CSS cascade & drag | Use `cssInjectionMode:"manifest"` + keep imperative overlay (or `createIntegratedUi`); **do not** use `createShadowRootUi` |
| Dev-mode CSP relaxation leaks into shipped zip | WXT confines relaxation to dev; verify `zip` output manifest shows exactly `script-src 'self'; object-src 'none'`; add a Playwright check asserting no CSP violations on the popup/page |
| Top-level runtime code throws under WXT's NodeJS build context | All runtime code inside `defineBackground`/`defineContentScript` `main()`; entrypoints stay thin |
| Content-script top-level `import` SyntaxError | Authored as TS modules; WXT bundles to single IIFE — verify the emitted `content-scripts/*.js` has no `import` at top level |
| Manifest drift during migration | Manifest is generated from typed `wxt.config.ts` + entrypoints — diff the emitted manifest against current `manifest.json` once at cutover |
| Chrome 116 baseline vs ES target | `target ES2022` is safe for Chrome 116; do not target newer without re-checking the baseline |

---

## Sources (verified 2026-05-27)

- WXT — https://wxt.dev/ , content scripts https://wxt.dev/guide/essentials/content-scripts.html , ES modules https://wxt.dev/guide/essentials/es-modules , entrypoints https://wxt.dev/guide/essentials/entrypoints.html , messaging https://wxt.dev/guide/essentials/messaging , unit testing https://wxt.dev/guide/essentials/unit-testing , content-script UI https://wxt.dev/guide/key-concepts/content-script-ui.html
- CRXJS — https://crxjs.dev/vite-plugin/ , npm https://www.npmjs.com/package/@crxjs/vite-plugin , repo https://github.com/crxjs/chrome-extension-tools , Chrome 130+ CSP issue https://github.com/crxjs/chrome-extension-tools/issues/918
- 2025 framework comparison (Plasmo/WXT/CRXJS) — https://redreamality.com/blog/the-2025-state-of-browser-extension-frameworks-a-comparative-analysis-of-plasmo-wxt-and-crxjs/
- 2026 framework comparison — https://extensionbooster.com/blog/best-chrome-extension-frameworks-compared/
- samrum plugin — https://github.com/samrum/vite-plugin-web-extension ; aklinker1 plugin — https://vite-plugin-web-extension.aklinker1.io/ , HMR discussion https://github.com/aklinker1/vite-plugin-web-extension/discussions/181
- Messaging — @webext-core/messaging https://www.npmjs.com/package/@webext-core/messaging , webext-bridge https://github.com/serversideup/webext-bridge
- Testing mocks — @webext-core/fake-browser https://www.npmjs.com/package/@webext-core/fake-browser , vitest-chrome https://github.com/probil/vitest-chrome
- Chrome types — chrome-types https://github.com/GoogleChrome/chrome-types (and issue #47 vs @types/chrome) , @types/chrome https://www.npmjs.com/package/@types/chrome
- MV3 CSP reference — https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy
