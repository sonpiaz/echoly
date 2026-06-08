# R6 — sourceLanguage Plumbing: Mirror Checklist

> READ-ONLY research. Working dir: `extension/`. Branch: `wave/ad-seek-ended-autonext`.

---

## 1. Type Definitions — `src/shared/types.ts`

| Symbol | Line | Notes |
|---|---|---|
| `Settings` interface | 19–30 | Has `targetLanguage: string` at line 21. No `sourceLanguage` yet. |
| `DEFAULT_SETTINGS` | 32–42 | `targetLanguage: "vi"` at line 34. |
| `State extends Settings` | 66–107 | Inherits all Settings fields including `targetLanguage`. |
| `INITIAL_STATE` | 110–131 | Spreads `...DEFAULT_SETTINGS` at line 130 — picks up `targetLanguage` automatically. |
| `StartSettings extends State` | 153–155 | Adds `apiBase: string`; inherits everything from State. |

### Mirror edit
- **`Settings` interface (line 30, after `apiBearer`):** add `sourceLanguage: string;`
- **`DEFAULT_SETTINGS` (line 34, after `targetLanguage`):** add `sourceLanguage: "auto",`
- `State` and `StartSettings` inherit automatically — no additional edits.
- `INITIAL_STATE` inherits via `...DEFAULT_SETTINGS` spread — no additional edits.

---

## 2. Storage — `src/shared/storage.ts` + `src/shared/storage-keys.ts`

**Key mechanism:** `SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS)` (line 10 of `storage.ts`). `loadSettings()` calls `chrome.storage.local.get(DEFAULT_SETTINGS)` which uses the `DEFAULT_SETTINGS` object as both the key list AND default-value map. `saveSettings(partial)` filters to `SETTINGS_KEYS`.

**No explicit per-field key constants exist** — the keys are the raw property names (`"targetLanguage"`, etc.). `storage-keys.ts` only contains the `HAS_EVER_SIGNED_IN_KEY` flag.

**Is targetLanguage server-synced?** NO. It is part of `Settings` (the 8-key `DEFAULT_SETTINGS` bundle), persisted to `chrome.storage.local`. The server-synced bundle is `AdvancedSettings` (`captionPosition`, `autoStartHosts`, `outputDeviceId`) stored separately under `ADVANCED_STORAGE_KEY = "echoly_advanced"` in `store.ts:54`. `settings-client.ts` only handles `AdvancedSettings` — not any `Settings` field.

### Mirror edit
- **No edit needed in `storage.ts` or `storage-keys.ts`** — adding `sourceLanguage` to `DEFAULT_SETTINGS` is sufficient. The generic `SETTINGS_KEYS` derivation and `chrome.storage.local.get(DEFAULT_SETTINGS)` pattern picks it up automatically.

### Recommendation for sourceLanguage
**Do NOT add a server field.** `targetLanguage` is purely local; mirror exactly. `sourceLanguage` should also be local-only, stored in `chrome.storage.local` under the key `"sourceLanguage"` (same as the property name, automatic).

---

## 3. Background Store — `src/background/store.ts`

| Method | Line | Role |
|---|---|---|
| `state` | 67 | `readonly state: State = { ...INITIAL_STATE }` — initializes with `DEFAULT_SETTINGS` spread |
| `loadSettings()` | 103–109 | Calls `loadStoredSettings()` → `Object.assign(this.state, stored)` — auto-picks up new key |
| `persistSettings(partial)` | 204–209 | `Object.assign(this.state, rest)` then `saveSettings(rest)` — generic; no per-field code |
| `snapshot()` | 88–90 | `{ ...this.state }` shallow copy — generic |
| `mergeFromContent(partial)` | 213–215 | `Object.assign(this.state, partial)` — generic |

**No explicit `setTargetLanguage()` setter exists.** Changes flow through `persistSettings()` (from the router/coordinator) which is generic over `Partial<Settings>`. There is no dedicated setter to add.

### Mirror edit
- **No store.ts edit needed.** The generic methods handle any `Settings` key. `sourceLanguage` will be automatically loaded, persisted, snapshotted, and merged.

---

## 4. Popup UI — `src/popup/index.ts` + `src/entrypoints/popup/index.html` + `src/popup/dropdown.ts`

### HTML structure (index.html lines 133–155)
The "Translating row" (`session-row--trans`) already has a **left side** showing source:
```html
<div class="lang-side">
  <span class="flag-chip flag-chip--auto" id="src-flag">??</span>
  <span class="lang-name" id="src-name">Auto-detect</span>
  <span class="lang-auto-badge">auto</span>
</div>
```
This `src-flag` / `src-name` section is **static/display-only** (no select, no dropdown). The right side (`id="lang-trigger"`) hosts the `<select id="lang">` target dropdown (line 152).

### Popup state cache (index.ts lines 78–96)
`cachePopupState` explicitly lists `targetLanguage` at line 82 in the slim object. **Must add `sourceLanguage`** to this slim cache object.

### Popup local state initializer (index.ts lines 227–245)
Explicit local `state` object lists `targetLanguage: "vi"` at line 232. **Must add `sourceLanguage: "auto"`**.

### `applyState` (index.ts)
- Line 557: `let effectiveLang = state.targetLanguage ?? "vi"` — reads targetLanguage from state, sets `langSelect.value` and renders the flag/name. A parallel `effectiveSrcLang` variable needs to be added.
- Line 580: `langSelect.value = effectiveLang` — sets the target select.
- Line 581: `renderTargetLang(effectiveLang)` — renders the target name/flag.
- **No `applySignedLanguageGate`-equivalent is needed for source** — sources are not gated by tier.

### `readSettings` (index.ts lines 725–737)
Returns `{ tier, targetLanguage: langSelect.value, ... }`. **Must add `sourceLanguage: srcLangSelect.value`**.

### `langSelect` change handler (index.ts line 857)
```ts
langSelect.addEventListener("change", () => {
  state.targetLanguage = langSelect.value;
  renderTargetLang(langSelect.value);
  void pushSettings();
});
```
**Must add a parallel handler for `srcLangSelect`.**

### `langItems()` function (index.ts lines 957–963)
Populates the glass-morphic dropdown from `langSelect.options`. A parallel `srcLangItems()` must be added.

### Custom dropdown wiring (index.ts lines 974–979)
```ts
const langTrigger = $("lang-trigger");
if (langTrigger) dropdowns.lang = attachDropdown({ trigger: langTrigger, select: langSelect, items: langItems, ... });
```
**Must add parallel src trigger + dropdown.**

### `populateLanguages` (index.ts lines 280–292)
Populates `langSelect`. **Must add `populateSourceLanguages()` that prepends `["auto", "Auto-detect"]`** as the first option.

### `renderTargetLang` (index.ts lines 410–414)
Renders `tgt-name` / `tgt-flag`. **Must add `renderSourceLang(code)` that renders `src-name` / `src-flag`** — with "auto" mapping to the existing static label "Auto-detect".

### `updateLiveSummary` (index.ts lines 415–425)
Line 418: `liveSrcFlag.textContent = "??"` — hardcoded. **Must update to reflect `state.sourceLanguage ?? "auto"`**.

### `dropdowns.ts` — `attachDropdown` API (lines 51+)
The `DropdownConfig` interface takes `{ trigger, select, items, align?, panelClass? }`. The `items` is a lazy supplier `() => DropdownItem[]`. This is fully reusable — no changes needed to dropdown.ts itself.

### "Auto" option pattern
The `POPUP_REALTIME_VOICES` list (index.ts line 118) uses `{ id: "", name: "Auto · OpenAI output" }` as an auto sentinel. The source language equivalent should be a `LangPair`-shaped tuple: `["auto", "Auto-detect"]` prepended to the source language list.

### Source language list
Use the same `langSelect.options` source list (which comes from `state.languagePicker` or `offlineLanguagePicker()`), but **build a separate `<select id="src-lang">` and populate it with `["auto", "Auto-detect"]` prepended**. The source language picker should include all target languages (the video can be in any of those languages) plus the "auto" entry.

---

## 5. Propagation to Content

### On START (`session-coordinator.ts` lines 238–250)
`this.store.snapshot()` is taken at line 238 — already includes all `State` fields. `startSettings = { ...snapshot, apiBase, apiBearer }` at line 246. `CONTENT_START` carries the full `StartSettings` which includes `sourceLanguage`. **No coordinator edit needed.**

However, at line 265:
```ts
void recordLanguagePairRecent(token, this.store.state.targetLanguage, "en");
```
The `"en"` hardcode is the source language. **Should update to `this.store.state.sourceLanguage` when it's not `"auto"`, else fall back to `"en"`.**

### Live update path (session-coordinator.ts lines 338–355, `updateSettings`)
Line 346: `relayToContent(state.tabId, { type: "CONTENT_UPDATE_SETTINGS", settings: this.store.snapshot() })` — broadcasts the full snapshot including `sourceLanguage`. **No edit needed.**

### Content-side `applySettingsLive` (content/index.ts lines 1043–1109)
Lines 1060–1066 detect `targetLanguage` changes to trigger handover/voice switch. `sourceLanguage` changes should be added to `langOrVoiceChanged` check (line 1060), since changing source language mid-session needs a WebRTC handover on the realtime pipeline.

### WebRTC pipeline use of targetLanguage (content/pipelines/webrtc-pipeline.ts)
- Line 39: `targetLanguage: string` on the opts interface → API call body uses `target_language: opts.targetLanguage` (line 150).
- Line 138: `targetLanguage: string` on the negotiate opts.
- **Source language** is not currently passed to the server. When `sourceLanguage !== "auto"`, a `source_language` param should be added to the API call body.

### `onLanguageChange` in `controller.ts` (lines 12–23)
Only handles target language changes via the overlay picker. The overlay has no source language picker currently (the source side is static display-only in the HTML). If a source language overlay picker is added, a parallel `onSourceLanguageChange` callback must be added to `OverlayCallbacks` in `src/shared/ports.ts`.

### `CONTENT_PREPARE_INTENT` message (protocol.ts lines 93–96)
`intent` carries `{ apiBearer, targetLanguage, pipeline }`. **Should add `sourceLanguage` to the intent** so pre-warm uses the correct source.

---

## 6. Server Settings — Is targetLanguage Server-Synced?

**No.** `targetLanguage` is a `Settings` field, persisted to `chrome.storage.local`. The server-authoritative bundle (`AdvancedSettings`) lives under `ADVANCED_STORAGE_KEY` in `store.ts:54` and is managed by `settings-client.ts` which only handles `AdvancedSettings` (captionPosition / autoStartHosts / outputDeviceId).

**Recommendation:** `sourceLanguage` should be purely local, matching `targetLanguage` exactly. No server field needed, no `SettingsClient` change needed.

---

## 7. Language Name Resolution & Catalog

- **`resolveLangName(code, languageNames)` in `src/lib/resolve-lang-name.ts`:** resolves a code like `"vi"` → `"Vietnamese"` via server catalog then offline fallback. Reuse for source language display name, but handle `"auto"` specially: `code === "auto"` → display `"Auto-detect"`.
- **`OFFLINE_LANGUAGE_NAMES` in `src/lib/offline-language-bootstrap.ts`:** 17-language map. The source picker can reuse this exact list.
- **`offlineLanguagePicker()` in `src/lib/offline-language-bootstrap.ts`:** returns sorted `LangPair[]`. Prepend `["auto", "Auto-detect"] as LangPair` before rendering the source picker.
- **`langPickerFromPairs` in `src/lib/language-picker.ts` line 22:** builds target picker from `pairs[].target`. A hypothetical source picker would use `pairs[].source` codes — but in practice the offline list covers all real sources. Simplest approach: use the same target catalog list (all languages the server supports) plus "auto".
- **No filtering needed for source:** `filterPickerForRealtime` and `applySignedLanguageGate` apply only to the target picker. Source has no tier gate.

---

## Step-by-Step Mirror Checklist

### A. `src/shared/types.ts`
1. Line 29 (after `showTargetCaptions`): add `sourceLanguage: string;` to `Settings`.
2. Line 40 (after `targetLanguage: "vi"`): add `sourceLanguage: "auto",` to `DEFAULT_SETTINGS`.

### B. `src/shared/storage.ts`
No edit — `SETTINGS_KEYS` is derived dynamically.

### C. `src/background/store.ts`
No edit — all methods are generic over `Partial<Settings>`.

### D. `src/entrypoints/popup/index.html`
1. Lines 136–140 (the static `src-flag`/`src-name` div): convert to a clickable trigger row matching the `lang-trigger` pattern. Add `<select id="src-lang" class="dropdown-mirror-select" aria-label="Source language"></select>` inside it. Add `id="src-trigger"` to the wrapper div.

### E. `src/popup/index.ts`
1. **Line 155** (after `const langSelect`): add `const srcLangSelect = $("src-lang") as HTMLSelectElement;`.
2. **Line 232** (local state initializer): add `sourceLanguage: "auto",`.
3. **Lines 78–96** (`cachePopupState` slim): add `sourceLanguage: s.sourceLanguage,`.
4. **Add `populateSourceLanguages()`** function (after `populateLanguages` ~line 292): prepend `["auto", "Auto-detect"]` to the same catalog list, populate `srcLangSelect`.
5. **Add `renderSourceLang(code: string)`** (after `renderTargetLang` ~line 414): if `code === "auto"`, set `src-name = "Auto-detect"`, `src-flag = "??"`. Else resolve via `resolveLangName` and set flag to `code.slice(0,2).toUpperCase()`.
6. **`applyState`** (after line 580 `langSelect.value = effectiveLang`): set `srcLangSelect.value = state.sourceLanguage ?? "auto"` and call `renderSourceLang(state.sourceLanguage ?? "auto")`.
7. **`updateLiveSummary`** (line 418): replace hardcoded `"??"` with `(state.sourceLanguage === "auto" || !state.sourceLanguage) ? "??" : (state.sourceLanguage || "??").slice(0,2).toUpperCase()`.
8. **`readSettings`** (line 730): add `sourceLanguage: srcLangSelect.value,` to the returned object.
9. **Add `srcLangItems()`** function (after `langItems()` ~line 963): same pattern as `langItems()` but from `srcLangSelect.options`.
10. **Add change handler** (after `langSelect` handler ~line 861): `srcLangSelect.addEventListener("change", () => { state.sourceLanguage = srcLangSelect.value; renderSourceLang(srcLangSelect.value); void pushSettings(); });`.
11. **Attach dropdown** (after lang dropdown ~line 979): `const srcTrigger = $("src-trigger"); if (srcTrigger) dropdowns.src = attachDropdown({ trigger: srcTrigger, select: srcLangSelect, items: srcLangItems, align: "left", panelClass: "dropdown-panel--lang" });`.
12. **Init block** (~line 1182): call `populateSourceLanguages()` and `renderSourceLang(state.sourceLanguage ?? "auto")`.

### F. `src/background/session-coordinator.ts`
1. **Line 265** (`recordLanguagePairRecent`): update source arg from hardcoded `"en"` to `this.store.state.sourceLanguage !== "auto" ? this.store.state.sourceLanguage : "en"`.

### G. `src/content/index.ts` — `applySettingsLive`
1. **Line 1061** (`langOrVoiceChanged` check): add `|| ("sourceLanguage" in newSettings && newSettings.sourceLanguage !== prev.sourceLanguage)` so a source language change triggers WebRTC handover on the realtime pipeline.

### H. `src/shared/ports.ts` — `OverlayCallbacks`
1. After line 39 (`onLanguageChange`): add `onSourceLanguageChange?(lang: string): void;` (optional callback, since the overlay currently has no source picker — but locked for future use).

### I. `src/shared/protocol.ts` — `CONTENT_PREPARE_INTENT`
1. Lines 93–96: add `sourceLanguage?: string` to the `intent` payload shape.

### J. Server API calls (optional, backend-dependent)
- `src/lib/echoly-api.ts` line 59: add `source_language: opts.sourceLanguage` to the POST body when `sourceLanguage` is not `"auto"`.
- `src/content/pipelines/webrtc-pipeline.ts` line 150: same — pass `source_language` when not `"auto"`.

---

## Key Gotchas

1. **State vs Settings duplication**: `State extends Settings` so adding to `Settings` is sufficient — no separate `State`-only field needed.
2. **Default seeding in TWO places**: `DEFAULT_SETTINGS` (types.ts) AND the popup's local `state` initializer (index.ts ~line 232). Both must be updated.
3. **`cachePopupState` explicit field list** (index.ts ~line 78): the slim cache object is NOT a spread — `sourceLanguage` must be explicitly added or it won't survive optimistic pre-render.
4. **Dropdown component API** (`dropdown.ts:51`): `attachDropdown({ trigger, select, items, align?, panelClass? })` — `items` is a lazy `() => DropdownItem[]` supplier. Add `["auto", "Auto-detect"]` as the first entry in `srcLangItems()`.
5. **No `applySignedLanguageGate` for source**: the target picker gates on server catalog. The source picker needs no gating — it just uses the full language list + "auto".
6. **`populateLanguages` is called in `applyState`** on picker key change (line 559–579). A parallel `populateSourceLanguages()` should similarly be called (can be called once on init, then on state updates — source catalog doesn't change per-tier).
7. **`recordLanguagePairRecent`** in `language-catalog.ts` (line 103–121) accepts `source = "en"` as default. Update the coordinator call to pass the actual source language.
8. **`src-flag` and `src-name` DOM nodes already exist** (index.html lines 137–138). They're currently static. The popup's `updateLiveSummary` writes to `liveSrcFlag` (line 418) not `src-flag`. Both need to be updated to reflect `sourceLanguage`.
9. **Live session handover**: `onLanguageChange` in `controller.ts` (line 12) is the overlay callback for target language changes. A parallel `onSourceLanguageChange` would need to call `app.webrtc.requestHandover({ sourceLanguage: lang })` — or update `sm.settings.sourceLanguage` + `notifyBackground` for subtitle-first sessions.
