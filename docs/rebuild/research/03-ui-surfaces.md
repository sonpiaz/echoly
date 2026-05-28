# Research 03 — UI Surfaces Inventory (fidelity baseline)

**Agent:** Research Agent 3 of 5
**Slice:** All visible UI surfaces — in-page overlay (content.js + content.css) and popup (popup.html + popup.css + popup.js).
**Baseline:** committed 0.6.3 (working tree at commit `5c35eb5`, `manifest.json` version `0.6.3`).
**Status:** READ-ONLY inventory. HARD CONSTRAINT for the rebuild: UI must stay **pixel- and behavior-identical to 0.6.3**.

> Scope note: pipeline/WebRTC/STT/TTS internals are **out of scope** (owned by Agent 2). This doc covers only DOM structure, styling, text, interactions, and the render boundary. Background `state` shape is Agent 1's; I document only what the popup *reads* from it.

---

## 0. File map & sizes

| File | Lines | Role |
|---|---|---|
| `content.js` | 2406 | In-page overlay (built via `innerHTML` template inside an IIFE). UI lives in lines ~135–506; rest is pipeline (not my slice). |
| `content.css` | 322 | All `.ec-*` overlay styles. Injected by MV3 `content_scripts[].css`. |
| `popup.html` | 137 | Static popup markup (toolbar action popup). |
| `popup.css` | 506 | All popup styles (`:root` token vars + component classes). |
| `popup.js` | 455 | Passive renderer: `applyState(s)` from background, dispatches messages. |
| `icons/` | — | `icon-16/32/48/128.png` (action + extension icons), `brand.svg`. |
| `manifest.json` | — | `action.default_popup = popup.html`; `content_scripts` inject `content.js` + `content.css` on youtube.com at `document_idle`. CSP `extension_pages: script-src 'self'`. |

Two **independent** UIs with **non-shared** styling. Tokens differ between them (see §4) — they are NOT a shared design system. The overlay uses orange brand stops (`#ff9159/#ff7a45`); the popup uses an Aurora gradient (`#7B61FF → #FF6BD5 → #FFAA5A`). Keep them separate.

---

## 1. OVERLAY (content.js + content.css)

### 1.1 Component / element tree

Root is `<aside class="ec-root" data-state="...">` appended to `document.documentElement` (NOT body). Built once in `buildOverlay()` (content.js:188) via a single `innerHTML` template string (content.js:193–227).

```
aside.ec-root  [data-state]  (+ optional classes: is-side-collapsed, is-compact, is-roomy)
├─ div.ec-toolbar [data-ec-drag]                 ← drag handle (cursor: grab)
│  ├─ span.ec-brand
│  │  ├─ span.ec-mark [aria-hidden]
│  │  │  └─ svg (4-bar equalizer glyph; viewBox 0 0 24 24, stroke currentColor, width 2.4)
│  │  ├─ span.ec-wordmark               text: "Echoly"
│  │  └─ span.ec-state [data-ec-status] text: "Ready" (live-updated)
│  ├─ span.ec-spacer                    (flex:1 push)
│  ├─ select.ec-select [data-ec-language] aria-label="Target language"   ← 13 LANGUAGES options
│  ├─ select.ec-select [data-ec-voice]    aria-label="Voice"             ← tier-dependent voices
│  ├─ button.ec-btn [data-ec-hide]        text: "Hide" / "Show"
│  └─ button.ec-btn.ec-btn-primary [data-ec-stop] text: "Stop"
├─ div.ec-body
│  ├─ div.ec-main
│  │  └─ div.ec-target [data-ec-target]   ← translated text, clamped to --ec-target-lines
│  └─ div.ec-side [data-ec-side]
│     ├─ div.ec-source [data-ec-source] hidden   ← source caption (last 220 chars)
│     └─ div.ec-history [data-ec-history] hidden ← history list (column-reverse)
├─ span.ec-resize-edge.ec-resize-edge-{n,e,s,w}    [data-ec-resize="n|e|s|w"]
├─ span.ec-resize-corner.ec-resize-corner-{nw,ne,sw,se} [data-ec-resize="nw|ne|sw|se"]
└─ span.ec-toast (transient; created/removed dynamically by showToast, NOT in template)
   └─ optional <a target=_blank rel=noopener> CTA link
```

History items (built per-render in `renderHistory()`, content.js:446):
```
div.ec-h-marker            (optional, when turn.marker set)
└─ span.ec-h-marker-chip   text: e.g. "en → vi" or "Switching voice"
div.ec-h-item
├─ span.ec-h-meta          text: HH:MM (turn.time)
└─ span.ec-h-text          text: turn.target
```

### 1.2 Hooks (data-* attributes → JS element refs)

`elements` map cached in `buildOverlay()` (content.js:230–240):

| `data-ec-*` attr | `elements` key | Purpose |
|---|---|---|
| `data-ec-status` | `status` | status text (`setStatusText`) |
| `data-ec-language` | `langSelect` | target language `<select>` |
| `data-ec-voice` | `voiceSelect` | voice `<select>` |
| `data-ec-target` | `target` | translated text + `dir` (RTL) |
| `data-ec-source` | `source` | source caption pane (`hidden` toggled) |
| `data-ec-history` | `history` | history container (`hidden` toggled) |
| `data-ec-hide` | `hideBtn` | toggles side panel + flips label Hide/Show |
| `data-ec-stop` | `stopBtn` | stop session |
| `data-ec-drag` | `drag` | toolbar = drag region |
| `data-ec-resize` | (queried) | 8 resize handles, value = edge/corner |

These attribute names are **load-bearing** (CSS doesn't use them, but JS queries them). The rebuild may swap to refs/JSX but must preserve identical resulting DOM (CSS targets the *classes*, drag/resize uses `data-ec-resize` values).

### 1.3 Overlay states (`data-state` on `.ec-root`)

Set by `setOverlayState()` (content.js:318). Distinct values observed: `ready` (initial), `connecting`, `live`, `paused`, `error`. CSS keys off these for the status dot — **but note: the overlay has NO visible status dot element** (`.ec-dot` is styled in CSS lines 238–267 but there is no `.ec-dot` node in the overlay template). The `.ec-dot` rules and `ec-pulse` keyframes are effectively **dead CSS in the overlay** (the dot lives only in the popup, which has its own `.dot`). `data-state="error"` *does* recolor `.ec-target` red (content.css:269). Keep `data-state` values + the `error→target` color; the `.ec-dot` rules can be carried over verbatim for safety but render nothing.

### 1.4 Layout / drag / resize / persistence

- **LAYOUT_KEY** = `"echolyOverlayLayout"`, stored in `localStorage` (content.js:31, 143, 150). Shape: `{ left, top, width, height, sideCollapsed }`. `loadLayout()` defaults all positional fields to `null` + `sideCollapsed:false`.
- **clampLayout()** (content.js:152): min width 300 / min height 130; default width 560, default height 200; default position bottom-right with 24px margin (`innerWidth - w - 24`, `innerHeight - h - 96`). Margins: keeps ≥12px from edges.
- **applyLayout()** (content.js:167): writes inline `style.left/top/width/height` (px), sets `right/bottom = auto`, toggles 3 classes, sets `--ec-target-lines`.
  - `is-side-collapsed` when `layout.sideCollapsed` (hides `.ec-side`, `.ec-body` → single column).
  - `is-compact` when `width < 560 || height < 210` (smaller target font, tighter toolbar, hides wordmark + state).
  - `is-roomy` when `width > 760 && height > 235` (larger target font 18px).
  - `--ec-target-lines` = `clamp(2, floor((height-74)/38), 8)` → drives `-webkit-line-clamp` on `.ec-target`.
  - `hideBtn` label flips: `sideCollapsed ? "Show" : "Hide"`.
- **Drag** (`bindDragResize`, content.js:363): pointer events on `.ec-toolbar`. Ignored if `e.button !== 0` or target is a `button, select, input` (so controls work). `dragMode = "move"`. Uses `setPointerCapture`.
- **Resize**: pointerdown on any `[data-ec-resize]` handle → `dragMode = "resize-<edge>"`. e/s grow from origin; w/n move origin + resize. Saves layout on `pointerup`.
- `window resize` listener re-runs `applyLayout()` (re-clamps into viewport); removed in `removeOverlay()`.

### 1.5 Show/hide & lifecycle

- `buildOverlay()` is **idempotent** (`if (root) return`). Appends to `document.documentElement`.
- `removeOverlay()` removes node, nulls `root`, clears `elements`, removes resize listener.
- F9 version guard: on script (re-)inject, removes any stale `.ec-root` nodes (content.js:14). `ECHOLY_VERSION = "0.6.1"` constant (string is stale vs 0.6.3 but functionally a guard token — keep as-is unless Agent 1/4 say otherwise).
- `.ec-root[hidden]` → `display:none` (CSS:23), but `hidden` is not toggled by the overlay JS in 0.6.3 (it's removed/rebuilt instead). Keep the rule.

### 1.6 Text / captions / history

- **Target text** (`setTargetText`, content.js:324): sets `.ec-target` textContent and `dir = RTL_LANGS.has(lang) ? "rtl" : "ltr"`. **RTL_LANGS** = `{ar, fa, he, ur}` (content.js:32). (Note: none of these 4 are in the popup's 13-language list — RTL is defensive.)
- **Source captions** (`startCaptionPoll`, content.js:483): polls `.ytp-caption-segment` every `CAPTION_POLL_MS = 350ms` only when `settings.showSource`; writes last 220 chars to `.ec-source`. `applySourceVisibility()` toggles `.ec-source.hidden = !showSource`. Standard pipeline also writes source directly (content.js:2047).
- **History** (`pushHistoryTurn`/`renderHistory`): **HISTORY_MAX = 16** (content.js:29). `history.unshift(...)` newest-first; CSS `column-reverse` so newest renders at bottom. Each turn: `{ time: HH:MM, target: ≤280 chars, source: ≤220 chars, lang, voice, marker }`. Empty list → container `hidden`. Marker chips for handover transitions (`"<from> → <to>"`, `"Switching voice"`).
- **Toast** (`showToast`, content.js:333): built via DOM APIs (NOT innerHTML — deliberate XSS guard since text may be a provider error body). Default 8000ms, auto-removes. Optional CTA `<a>`. Replaces any existing toast. **Security-relevant: keep DOM-API construction, never innerHTML.**

### 1.7 Voice/language option lists (overlay)

- **LANGUAGES** (content.js:34) — 13 entries: en English, vi Vietnamese, ja Japanese, ko Korean, zh Chinese, fr French, es Spanish, de German, pt Portuguese, hi Hindi, id Indonesian, it Italian, ru Russian. Default selection `vi`.
- **REALTIME_VOICES** (content.js:42) — array of 9 lowercase ids: marin, alloy, ash, ballad, coral, echo, sage, shimmer, verse. Rendered as **"Auto"** (value `""`) + capitalized names (`Marin`, `Alloy`, …). Default `marin`.
- **STANDARD_VOICES** (content.js:48) — 5 `[id, label]` pairs: `English_magnetic_voiced_man`→"Magnetic Man", `English_captivating_female1`→"Captivating Female", `English_ManWithDeepVoice`→"Deep Voice Man", `English_ConfidentWoman`→"Confident Woman", `Chinese (Mandarin)_News_Anchor`→"News Anchor". Default = first (`STANDARD_DEFAULT_VOICE`).
- `populateVoicePicker(tier)` (content.js:295) swaps the voice list on tier change.

> **DUPLICATION FLAG:** these three lists exist **twice** — content.js AND popup.js — with subtly different shapes (overlay REALTIME_VOICES = bare strings + synthesized "Auto"; popup REALTIME_VOICES = objects incl. an explicit `{id:"", name:"Auto · clones speaker"}`; STANDARD identical labels). The rebuild should hoist these into ONE shared module, but must reproduce **both rendered forms exactly** (overlay shows "Auto"; popup shows "Auto · clones speaker"). See §6 + cross-slice flag.

### 1.8 content.css full class inventory

Prefix `.ec-` (deliberate, to avoid colliding with YouTube classes — keep the prefix).

| Class / selector | Role / notable props |
|---|---|
| `.ec-root` | fixed; **z-index `2147483600`** (near max int — must stay above YT); border-radius 14px; `backdrop-filter: blur(28px) saturate(140%)`; box-shadow; flex column; `contain: layout paint`; `user-select:none`; font-family Apple-system stack, 14px, color `#f5f5f7`. |
| `.ec-root[hidden]` | display:none |
| `@media (prefers-color-scheme: light) .ec-root` | white bg, dark text, lighter shadow |
| `.ec-toolbar` | flex, gap 10px, padding 10/12, `cursor:grab`; bottom border; `:active` → grabbing |
| `.ec-brand`, `.ec-mark`, `.ec-mark svg`, `.ec-wordmark`, `.ec-state` | brand cluster. `.ec-mark` 22×22 orange gradient `#ff9159→#ff7a45`; svg 13×13 white; wordmark SF Pro Display 14px/700; state 11px 55%-opacity |
| `.ec-spacer` | flex:1 |
| `.ec-select` | custom dropdown, inline SVG chevron (stroke `#ff9159`), max-width 130px, focus outline `#ff7a45` |
| `.ec-btn`, `.ec-btn:hover`, `.ec-btn-primary`, `:hover` | 12px/600 pills; primary = orange gradient + glow shadow |
| `.ec-body` | grid `minmax(0,1.3fr) minmax(0,1fr)`; min-height 0 |
| `.ec-root.is-side-collapsed .ec-body` | single column; `.ec-side { display:none }` |
| `.ec-main`, `.ec-target` | main pad 14/16; target 16px/500, `-webkit-line-clamp: var(--ec-target-lines, 4)`, `-webkit-box` clamp; `[dir=rtl]` right-align; light-mode color |
| `.ec-side`, `.ec-source`, `.ec-source[hidden]` | left border; source 12px 55% opacity, max-height 40%, scroll |
| `.ec-history`, `[hidden]` | flex `column-reverse`, gap 6px, scroll |
| `.ec-h-item` | grid `38px 1fr`, 11px |
| `.ec-h-meta`, `.ec-h-text` | meta tabular-nums 36% opacity; text 78% opacity |
| `.ec-h-marker`, `.ec-h-marker-chip` | centered pill chip, orange `#ff9159` on tint bg, uppercase 10px |
| `.ec-dot` + `data-state` variants + `@keyframes ec-pulse` | status dot colors (connecting `#ffca64`, live `#32d74b` pulsing, paused `#ffca64`, error `#ff453a`). **NO matching DOM node — dead in overlay** (see §1.3). |
| `.ec-root[data-state=error] .ec-target` | text `#ff7066` |
| `.ec-resize-edge*`, `.ec-resize-corner*` | 8 transparent handles, -4px offsets, resize cursors |
| `.ec-root.is-compact` / `.is-roomy` variants | font/padding tweaks; compact hides wordmark+state |
| `.ec-toast`, `.ec-toast a` | bottom-center red pill, z-index 10, shadow; link white underline |
| `@media (prefers-reduced-motion: reduce)` | disables live-dot animation |

**Structural CSS dependencies (must-stay-identical):** `.ec-body` grid ratios; `is-side-collapsed/is-compact/is-roomy` class names + thresholds; `--ec-target-lines` custom prop + `-webkit-line-clamp`; the inline-SVG chevron data-URIs; z-index `2147483600`; `.ec-` prefix; `data-state`/`dir` attribute selectors.

---

## 2. POPUP (popup.html + popup.css + popup.js)

### 2.1 Element tree (popup.html)

`<body data-state="idle">` (state ∈ idle | connecting | active | paused | error — set by `setStateClass`).

```
main.shell
├─ header.topline
│  ├─ div.brand
│  │  ├─ span.mark.aurora-mark [aria-hidden]   → inline "e" glyph (white, 700, 14px)
│  │  └─ div > h1  text: "echoly"
│  └─ span#tier-badge.tier-badge [data-tier=free]   text: Free|Pro|Max|BYOK
├─ section#account-band.account-band [data-state=loading]   (states: loading|out|in|byok)
│  ├─ div.account-out          (signed-out)
│  │  ├─ span.account-msg "Sign in to use a subscription, or paste a Kyma key for BYOK."
│  │  └─ a.account-link "Sign in →"  → https://echolyhq.com/signin
│  ├─ div.account-in           (signed-in)
│  │  ├─ div.account-id-row
│  │  │  ├─ div.account-id
│  │  │  │  ├─ span.account-email#acct-email
│  │  │  │  └─ span.account-tier#acct-tier [data-tier]
│  │  │  └─ button#signOutBtn.account-link-btn "Sign out"
│  │  ├─ div.usage-block#usage-std [hidden]
│  │  │  ├─ div.usage-row: span.usage-label#usage-std-label "Standard"
│  │  │  │   + span.usage-numbers (#usage-std-used / span.muted "/ #usage-std-cap min")
│  │  │  └─ div.usage-track > div.usage-fill#usage-std-fill [style=width:0%][data-level]
│  │  ├─ div.usage-block#usage-rt [hidden]   (Realtime; same structure)
│  │  └─ div.usage-hint#usage-hint [hidden]  text: "Resets <Month Day>"
│  └─ div.account-byok         (BYOK active)
│     ├─ span.account-msg "<strong>BYOK active</strong> · unlimited at wholesale"
│     └─ a.account-link "Switch to subscription" → /signin
├─ section.row  label "Tier" + select#tier  (2 options, see §2.5)
├─ section.row  label "Voice" + select#voice  (populated by JS)
├─ section.row  label "Language" + select#lang  (populated by JS)
├─ section.secret
│  ├─ div.row: label "Kyma key" + span.badge "— optional, BYOK" + span#keyBadge.badge "missing"
│  └─ input#kymaKey type=password placeholder "ky-... (leave empty to use subscription)"
├─ button.action#toggle  text: "Start" / "Stop" (+ .is-live class)
├─ section.mix
│  ├─ div.mix-row: label "Original" + input#originalVolume range 0–100 v=18 + output#originalOut "18"
│  └─ div.mix-row: label "Voice"    + input#voiceVolume    range 0–100 v=100 + output#voiceOut "100"
├─ label.toggle-row: span "Show source captions" + input#showSource type=checkbox
├─ details.advanced
│  ├─ summary "Advanced"
│  └─ div.advanced-body
│     ├─ Plans copy ("Free 30 min/month, Pro $9/mo (600 min), Max $24.90/mo (3,000 + 120 min realtime)…")
│     ├─ links: Subscribe (/#pricing) · Account (/account) · Kyma billing (kymaapi.com/billing)
│     └─ div.hint "Sessions auto-stop at 60 minutes. Press Stop to end early."
└─ p.status#status "Ready."
```

### 2.2 Popup states & how `applyState(s)` renders them

`popup.js` is a **passive renderer**. Flow: on open → `send({type:"GET_STATE"})` → `applyState(reply.state)`; subscribes to `BACKGROUND_STATE_UPDATE` pushes (popup.js:436). `applyState(s)` (popup.js:224) does:

1. Merge into local `state`, then `renderAccountBand(signedInUser, kymaKey, usage)`.
2. Sync `#tier` (`standard`/`realtime`), `#lang`, repopulate `#voice` for the active tier + select the saved voice.
3. Sync `#originalVolume`/`#voiceVolume` inputs + `<output>` text.
4. Sync `#showSource` checkbox, `#kymaKey` value + `keyBadge`.
5. **Status + toggle button** (drives `body[data-state]` + `#status` text + `#toggle` label/`.is-live`):
   - `connecting` → status = `state.status || "Connecting"`, toggle "Stop" + is-live.
   - `running && paused` → "Paused.", "Stop" + is-live.
   - `running` → "Translating to `<LangName>`.", "Stop" + is-live.
   - `errorMessage` → status = errorMessage, "Start", remove is-live.
   - else idle → "Ready." (if key OR signed in) or "Sign in or paste a Kyma key to start.", "Start".
6. `applyTierGating()` (popup.js:289): Realtime option `disabled` unless BYOK key OR `user.tier==="max"`. Appends " (Max only)" to the option label when locked; strips it when allowed. If currently on Realtime but disallowed, force-switch to Standard.

`account-band[data-state]` (popup.js `renderAccountBand`, popup.js:161): priority BYOK > in > out. CSS shows exactly one of `.account-out/.account-in/.account-byok` per state (popup.css:182–190); `loading` → all hidden + 0.6 opacity.

`renderTierBadge` (popup.js:150): BYOK key → "BYOK"; else `Max`/`Pro`/`Free` by tier.

`renderUsageMeters` (popup.js:187): hard-coded caps `{free:{std:30,rt:0}, pro:{std:600,rt:0}, max:{std:3000,rt:120}}`. Std meter always shown when signed-in; RT meter only when `cap.rt>0` (Max). Fill width % + `data-level` (`ok`/`warning≥0.9`/`danger≥1.0`). Hint `"Resets <next month 1st, UTC>"`.

### 2.3 Event handlers → message dispatched (UI→action map ONLY)

| Control | Event | Message sent |
|---|---|---|
| `#tier` | change | repopulate voices → `UPDATE_SETTINGS {settings: readSettings()}` (via `pushSettings`) |
| `#voice` | change | `UPDATE_SETTINGS` |
| `#lang` | change | `UPDATE_SETTINGS` |
| `#showSource` | change | `UPDATE_SETTINGS` |
| `#kymaKey` | input | (local only) `setKeyBadge` — no message |
| `#kymaKey` | change | `UPDATE_SETTINGS` |
| `#originalVolume`/`#voiceVolume` | input | updates `<output>`; debounced 60ms → `UPDATE_VOLUME {originalVolume, voiceVolume}` |
| `#toggle` | click | running/connecting → `STOP`; else validate → `START {settings}` |
| `#signOutBtn` | click | `SIGN_OUT_ECHOLY` |
| (background push) | onMessage | `BACKGROUND_STATE_UPDATE` → `applyState` |
| (init) | — | `GET_STATE` |

`readSettings()` (popup.js:312) returns `{tier, targetLanguage, [voiceKey], originalVolume, voiceVolume, showSource, kymaKey}` where `voiceKey` is `standardVoice` or `realtimeVoice` (only the active tier's key, to preserve the other). Validation in `onToggle` shows inline error text (no message) when no key + not signed in, or Realtime requested without Max/BYOK.

### 2.4 `keyBadge` logic (`setKeyBadge`, popup.js:119)

empty → "missing" (no class); starts `ky`/`kyma-` → "saved" + `.ok` (green); else → "check" + `.warn` (amber).

### 2.5 Popup option lists / text constants

- **#tier** static options (popup.html:70): `realtime` = "Realtime · clones speaker · <1s"; `standard` = "Standard · ~5s lag · cheaper". (Realtime label gets " (Max only)" appended dynamically when gated.)
- **LANGUAGES** (popup.js:34): identical 13 entries to overlay.
- **REALTIME_VOICES** (popup.js:41): 10 objects incl. `{id:"", name:"Auto · clones speaker"}` then Marin/Alloy/Ash/Ballad/Coral/Echo/Sage/Shimmer/Verse.
- **STANDARD_VOICES** (popup.js:56): same 5 ids/labels as overlay.
- Hard-coded copy strings (must reproduce verbatim): account-band messages, Advanced plans paragraph, hint "Sessions auto-stop at 60 minutes…", placeholder "ky-... (leave empty to use subscription)", status fallback strings.

### 2.6 popup.css inventory (highlights)

`:root` token block (popup.css:1–24) + light-mode overrides (26–40) + reduced-motion (42). Width fixed `380px`. Font stack `"Geist Variable","Geist", -apple-system, …`. Body bg = layered Aurora radial gradients + `--bg`.

Key component classes: `.shell` (grid gap 12 pad 18), `.topline`/`.brand`/`.mark`/`h1`, `.dot` + `body[data-state]` dot variants + `@keyframes pulse` (popup has a real `.dot`? — NO `.dot` node in popup.html either; `.dot` styling at 108–122 is **also dead in the popup** since the markup has no `.dot` element — both UIs ship orphan dot CSS. Flag for cleanup but keep to avoid behavioral risk). `.row`/`select`/`input[type=password]` (custom chevron, orange stroke `#ff7a45`), `.account-band` + state machine, `.tier-badge` + `[data-tier]` variants, `.usage-*` meter (fill gradient + `data-level`), `.mode-row/.mode-btn` (**unused in 0.6.3 markup** — segmented control CSS with no DOM; flag), `.secret`/`.badge`/`.badge.ok`/`.badge.warn`, `.action` (Aurora gradient button, `.is-live` flips to neutral), `.mix`/`.mix-row`/`input[type=range]` (`accent-color`), `.toggle-row`/`input[type=checkbox]` (custom 38×22 switch via `::before`), `.advanced` (custom `summary` triangle via `::before`, `details[open]` rotate), `.status` + error color.

**Structural CSS deps (must-stay-identical):** `body[data-state]` + `.account-band[data-state]` + `[data-tier]` + `.usage-fill[data-level]` selectors; `:root` token names; the custom checkbox/`summary` pseudo-elements; the SVG chevron data-URI; fixed 380px width.

---

## 3. UI ↔ logic seam (render boundary)

### Overlay seam (content.js)
The pipeline drives the overlay through **8 thin UI functions** — this is already a clean seam to preserve:
| Function | Effect | Called from (examples) |
|---|---|---|
| `buildOverlay()` | create DOM | session start (1019, 1753, 2126) |
| `removeOverlay()` | teardown | errors/stop (multiple) |
| `setOverlayState(s)` | `.ec-root[data-state]` | connecting/live/paused/error transitions |
| `setStatusText(t)` | `.ec-state` text | every phase ("Connecting", "Translating", "Loading captions", "Preparing voices", "Almost ready", "Press YouTube play to start dub", …) |
| `setTargetText(t)` | `.ec-target` text + dir | realtime delta + standard sentence (1303, 2044) |
| `applySourceVisibility()` / `startCaptionPoll()` / `stopCaptionPoll()` | source pane | start/stop/tier-change |
| `pushHistoryTurn(opts)` / `renderHistory()` | history | turn complete + handover markers (826, 942, 1379) |
| `showToast(text, opts, ms)` | toast | warnings/errors (588, 909, 972, 1384, 1836, 2231, 2323) |
| `populateVoicePicker(tier)` | voice `<select>` | tier change (250, 2333) |

The two overlay `<select>` change handlers (content.js:253, 266) call `requestHandover(...)` (realtime) or push `UPDATE_SETTINGS` (standard) — that branch is pipeline logic (Agent 2), but the **DOM event binding** is UI. Rebuild should expose these as injected callbacks so the UI module stays render-only.

Status status text strings are scattered across the pipeline as string literals passed to `setStatusText` — to keep identical, the rebuild should centralize these strings or pass them through unchanged.

### Popup seam (popup.js)
Already a pure passive renderer: single entry `applyState(s)`, single output = runtime messages. Keep this contract. The popup never touches DOM outside its own document.

### Cross-slice dependencies (FLAGS)
- **Agent 1 (background/state):** The popup's entire render depends on the `state` object shape: `running, connecting, paused, tier, targetLanguage, realtimeVoice, standardVoice, originalVolume, voiceVolume, showSource, kymaKey, status, errorMessage, signedInUser{email,tier}, usage{standard,realtime}, apiMode`. Message **types** the UI emits: `GET_STATE, UPDATE_SETTINGS, UPDATE_VOLUME, START, STOP, SIGN_OUT_ECHOLY`; receives `BACKGROUND_STATE_UPDATE`. Overlay emits `CONTENT_STATE, CONTENT_ENDED, UPDATE_SETTINGS`. These names/shape must be agreed with Agent 1 — UI fidelity assumes they are unchanged.
- **Agent 2 (content pipeline):** overlay UI funcs are *called by* the pipeline; the two `<select>` handlers call into `requestHandover`/settings. The caption poll reads `.ytp-caption-segment` (YouTube DOM) — that's a pipeline concern but the render target (`.ec-source`) is mine. RTL/`dir`, `--ec-target-lines`, and `is-compact/roomy` thresholds are UI but depend on layout numbers.

---

## 4. Shared visual tokens

**NOT actually shared** — two distinct palettes. Document both; do not merge.

| | Overlay (content.css) | Popup (popup.css) |
|---|---|---|
| Brand | Orange `#ff9159 → #ff7a45` | Aurora `#7B61FF → #FF6BD5 → #FFAA5A` |
| Text | `#f5f5f7` (dark) / `#1d1d1f` (light) | `--label #F5F5FA` / `#0A0B14` |
| BG | `rgba(20,20,22,0.92)` + backdrop blur | layered radial gradients + `--bg #0A0B14` |
| Status colors | live `#32d74b`, warn `#ffca64`, error `#ff453a` | success `#34D399`, warning `#FBBF24`, danger `#F87171` |
| Font | Apple-system / SF Pro stack | Geist Variable / Geist stack |
| Accent stroke (chevron) | `#ff9159` | `#ff7a45` |

Token strategy for rebuild: popup uses CSS custom props (`:root`) — preserve names. Overlay uses literal hex values inline in CSS — preserve literals (no token system). Do **not** unify the two palettes.

---

## 5. Must-stay-identical checklist

Overlay:
- [ ] Root is `<aside class="ec-root">` appended to `document.documentElement`; `z-index: 2147483600`.
- [ ] All `.ec-*` class names + `data-ec-*` hook attributes + `data-ec-resize` values preserved.
- [ ] `data-state` values: ready/connecting/live/paused/error; `[data-state=error] .ec-target` red.
- [ ] `is-side-collapsed`, `is-compact`, `is-roomy` classes + exact thresholds (560/210, 760/235).
- [ ] `--ec-target-lines` = clamp(2, floor((h-74)/38), 8); `-webkit-line-clamp` + `-webkit-box`.
- [ ] LAYOUT_KEY `"echolyOverlayLayout"`, localStorage shape `{left,top,width,height,sideCollapsed}`; clamp mins 300/130, defaults 560/200, 24px bottom-right.
- [ ] Drag from toolbar (ignore button/select/input); 8 resize handles; pointer-capture; save on pointerup.
- [ ] HISTORY_MAX = 16; unshift newest-first + `column-reverse` render; marker chips.
- [ ] RTL_LANGS `{ar,fa,he,ur}` → `dir` on `.ec-target`.
- [ ] Source captions: poll `.ytp-caption-segment` @350ms, last 220 chars, gated on showSource.
- [ ] Toast built via DOM APIs (never innerHTML); 8000ms default; CTA `<a rel=noopener>`.
- [ ] SVG equalizer mark glyph (4 paths, viewBox 0 0 24 24); inline SVG chevron data-URI in `.ec-select`.
- [ ] Voice lists: REALTIME shows "Auto" + 9 capitalized; STANDARD 5 labels; LANGUAGES 13.

Popup:
- [ ] Fixed body width 380px; `:root` token names; Aurora gradient + radial bg.
- [ ] `body[data-state]` (idle/connecting/active/paused/error), `.account-band[data-state]` (loading/out/in/byok), `[data-tier]`, `.usage-fill[data-level]` driving CSS.
- [ ] Element IDs (load-bearing for popup.js `$()` lookups): tier, voice, lang, kymaKey, keyBadge, toggle, status, originalVolume, voiceVolume, originalOut, voiceOut, showSource, account-band, acct-email, acct-tier, signOutBtn, tier-badge, usage-std/-rt + label/used/cap/fill, usage-hint.
- [ ] Static #tier options text incl. "· clones speaker · <1s" / "· ~5s lag · cheaper"; dynamic " (Max only)" gating.
- [ ] keyBadge states missing/saved(.ok)/check(.warn) by `ky`/`kyma-` prefix.
- [ ] Usage caps {free 30, pro 600, max 3000+120rt}; meter levels ok/warning≥0.9/danger≥1.0; "Resets <date>".
- [ ] Custom checkbox switch (38×22 ::before), custom `<summary>` triangle, range `accent-color`.
- [ ] Default control values: originalVolume 18, voiceVolume 100, showSource off, lang vi, realtimeVoice marin, standardVoice English_magnetic_voiced_man.
- [ ] All copy verbatim (account msgs, Advanced plans paragraph + prices, hint, placeholders, status fallbacks, links).
- [ ] Message types emitted exactly: GET_STATE/UPDATE_SETTINGS/UPDATE_VOLUME/START/STOP/SIGN_OUT_ECHOLY; volume debounce 60ms.

---

## 6. Fidelity RISKS for the TS/Vite refactor

1. **Overlay built via one `innerHTML` template string** (content.js:193) injected into youtube.com. MV3 CSP for *content scripts* runs in the page's CSP context — `innerHTML` of a static literal is fine, but a TS/JSX/template-literal rebuild must produce **byte-identical resulting DOM** (same tag = `<aside>`, same attribute order doesn't matter to CSS but class lists do). If switching to `createElement`/template, verify the equalizer SVG + all `data-ec-*` survive. Toast MUST remain DOM-API-built (XSS guard) — a naïve JSX `dangerouslySetInnerHTML` would reintroduce the vuln.
2. **Two CSS files injected as single bundles.** content.css is injected via `manifest.content_scripts[].css` (no `<style>` tag, no scoping). A Vite build that emits hashed/split CSS or CSS-modules (class-name mangling) will **break** because: (a) the manifest references a fixed filename, (b) `.ec-*` names are queried implicitly by structure and the popup relies on stable IDs. Keep CSS as plain, non-modularized files with stable output names, or configure Vite to emit `content.css`/`popup.css` verbatim. **No CSS-modules / no class hashing.**
3. **Inline styles set by JS** (`applyLayout` writes `style.left/top/width/height/right/bottom` + `--ec-target-lines`). These must remain inline (layout persistence). Don't move to classes.
4. **Duplicated option lists** (LANGUAGES/REALTIME_VOICES/STANDARD_VOICES in BOTH content.js and popup.js with different shapes). Hoisting to a shared module is desirable but the two **rendered forms differ** (overlay "Auto" vs popup "Auto · clones speaker"; overlay voices = strings, popup = objects). The shared module must expose enough to reproduce both exactly — do not accidentally unify the "Auto" label.
5. **Dead CSS that must be kept or carefully pruned:** overlay `.ec-dot` + `ec-pulse` (no DOM node), popup `.dot` + `pulse` + `.mode-row/.mode-btn` (no DOM nodes). Pruning is "safe" but is a behavior-change risk if any future state added them back; for a *pixel-identical* rebuild, simplest is to carry them verbatim. Flag for human decision.
6. **Hard-coded caps & copy in popup.js** (`renderUsageMeters` caps, plans paragraph, prices). These are UI strings today; a rebuild might want them from config, but for fidelity they must render the exact same numbers/text.
7. **`ECHOLY_VERSION = "0.6.1"`** string in content.js is stale (file is 0.6.3) but functions as an idempotency guard token — changing it would orphan already-injected scripts on upgrade. Coordinate with Agent 1/4 before touching.
8. **localStorage LAYOUT_KEY** persists across the rebuild — users on 0.6.3 have `echolyOverlayLayout` saved. The rebuild MUST read the identical key/shape or users lose their saved overlay position.
9. **Light/dark mode** via `@media (prefers-color-scheme)` in both files — easy to drop tokens in a refactor; verify both schemes.
10. **`@media (prefers-reduced-motion)`** handling in both files — must survive.
