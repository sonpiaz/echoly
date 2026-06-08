# Round-2 Agent B — sourceLanguage Propagation Trace

> READ-ONLY investigation. Working dir: `extension/`. Branch: `wave/ad-seek-ended-autonext`.

---

## Full propagation chain (end to end)

### 1. Popup → chrome.storage → background (UPDATE_SETTINGS)

**HTML** `src/entrypoints/popup/index.html:136-142` — `<select id="src-lang">` IS present inside `id="src-trigger"`. All required DOM nodes exist (`src-flag`, `src-name`, `src-lang`, `src-trigger`).

**popup/index.ts binding** `src/popup/index.ts:157`:
```ts
const srcLangSelect = $("src-lang") as HTMLSelectElement;
```
The element is found correctly.

**`populateSourceLanguages()`** `index.ts:297-312` — populates `srcLangSelect` with `"auto"` first then the full language catalog. Called at init `index.ts:1248`.

**Change handler** `index.ts:910-914`:
```ts
srcLangSelect?.addEventListener("change", () => {
  state.sourceLanguage = srcLangSelect.value;
  renderSourceLang(srcLangSelect.value);
  void pushSettings();
});
```
This sends `UPDATE_SETTINGS { ...readSettings() }` to the background.

**`readSettings()`** `index.ts:772-784`:
```ts
sourceLanguage: srcLangSelect?.value ?? "auto",
```
The chosen value IS included in the settings object sent to the background.

**`cachePopupState`** `index.ts:77-101` — explicitly includes `sourceLanguage: s.sourceLanguage` at line 83. Round-trips through the optimistic cache correctly.

**Custom dropdown attachment** `index.ts:1041-1044`:
```ts
const srcTrigger = $("src-trigger");
if (srcTrigger && srcLangSelect) dropdowns.src = attachDropdown({
  trigger: srcTrigger, select: srcLangSelect, items: srcLangItems, ...
});
```
The dropdown IS wired, so selecting via the UI sets `srcLangSelect.value` before the change event fires.

**`applyState`** `index.ts:619-628`:
```ts
const effectiveSrcLang = state.sourceLanguage ?? "auto";
if (srcLangSelect) {
  srcLangSelect.value = effectiveSrcLang;
  if (srcLangSelect.value !== effectiveSrcLang) {
    populateSourceLanguages();
    srcLangSelect.value = effectiveSrcLang;
  }
}
renderSourceLang(effectiveSrcLang);
```
On re-open, the popup restores the select's value from state. The dropdown reflects the stored selection.

**VERDICT for step 1:** The popup correctly reads the chosen value and sends it via `UPDATE_SETTINGS`. No wiring bug here.

---

### 2. Background `persistSettings` → `snapshot()` → `StartSettings`

**`store.persistSettings(partial)`** `src/background/store.ts:204-209`:
```ts
Object.assign(this.state, rest);
if (Object.keys(rest).length) await saveSettings(rest);
```
`sourceLanguage` is an ordinary `Settings` key — it's picked up generically by `Object.assign` (state) and by `saveSettings` (which filters to `SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS)`, which now includes `"sourceLanguage"`).

**`snapshot()`** `store.ts:88-90` — `{ ...this.state }` — includes `sourceLanguage` automatically.

**`startSettings`** `session-coordinator.ts:246-250`:
```ts
const startSettings: StartSettings = {
  ...snapshot,
  apiBase: mode.apiBase,
  apiBearer: mode.apiKey,
};
```
`sourceLanguage` is in the spread. `StartSettings extends State extends Settings`, so the field is typed and present.

**`CONTENT_UPDATE_SETTINGS`** `session-coordinator.ts:348-349`:
```ts
settings: this.store.snapshot()
```
Full snapshot including `sourceLanguage` — correct.

**VERDICT for step 2:** Background correctly persists, snapshots, and carries `sourceLanguage` in both `CONTENT_START` and `CONTENT_UPDATE_SETTINGS`. No bug here.

---

### 3. Content `sm.settings.sourceLanguage` at start and live update

**`startSession`** `src/content/index.ts:486`:
```ts
sm.settings = { ...incomingSettings };
```
Full spread — `sourceLanguage` lands in `sm.settings` at session start.

**`applySettingsLive`** `index.ts:1110-1155`:
```ts
sm.settings = { ...prev, ...newSettings } as StartSettings;
```
Then at `:1127-1135`:
```ts
const langOrVoiceChanged =
  ("targetLanguage" in newSettings && ...) ||
  ("sourceLanguage" in newSettings &&
    newSettings.sourceLanguage !== prev.sourceLanguage) || ...
```
`sourceLanguage` change IS detected and triggers the handover/subtitle-first switch path. Applied correctly.

**VERDICT for step 3:** `sm.settings.sourceLanguage` equals the user's chosen value at start AND on live updates.

---

## WHERE IS THE BUG?

After a thorough trace, **the propagation chain itself is complete and correct** in the current code. The settings flow is:

```
user picks "en" in popup dropdown
  → srcLangSelect.value = "en"
  → change event → pushSettings()
  → readSettings() includes sourceLanguage: "en"
  → UPDATE_SETTINGS → background persistSettings()
  → state.sourceLanguage = "en" + chrome.storage.local("sourceLanguage"="en")
  → CONTENT_UPDATE_SETTINGS snapshot → applySettingsLive()
  → sm.settings.sourceLanguage = "en"
  → next fetchCaptions call reads sm.settings.sourceLanguage
```

**The actual bug is upstream of this propagation** — in how the caption picker USES `sourceLanguage`. The SOLUTION doc (Fix D) documents that `subtitle-first-pipeline.ts` at call sites `:156/176/498/515` currently passes `preferLang: sm.settings.targetLanguage` (the OUTPUT language) to `fetchCaptions` instead of `sm.settings.sourceLanguage`. So even with the correct value in `sm.settings`, it is **never read** by the caption selection logic.

This is **RC-D** as confirmed in SOLUTION.md: the source track selection is driven by `targetLanguage`, so whatever the user sets for `sourceLanguage` is ignored at the call sites.

There is one secondary concern (not a bug per se, but a risk): **the first popup open after installation** (no stored `sourceLanguage` yet) — `chrome.storage.local.get(DEFAULT_SETTINGS)` returns `DEFAULT_SETTINGS.sourceLanguage = "auto"` as the Chrome default value for missing keys, which is correct. No silent defaulting bug.

---

## Fix options

**Option 1 (Fix D-picker — Agent 2's scope):** At the four `fetchCaptions` call sites in `subtitle-first-pipeline.ts`, replace:
```ts
preferLang: settings.targetLanguage
```
with:
```ts
preferLang: (settings.sourceLanguage && settings.sourceLanguage !== "auto")
  ? settings.sourceLanguage
  : undefined,
avoidLang: settings.targetLanguage,
```
This is what SOLUTION.md already specifies. The propagation is correct; the consumption is wrong.

**Option 2 (Add a debug log):** Temporarily log `sm.settings.sourceLanguage` at the pipeline call sites to confirm the value reaching content vs the `preferLang` actually passed to `fetchCaptions`. Useful to verify the diagnosis before shipping.

**Option 3 (Guard against stale-select on popup re-open):** If the `languagePicker` is not yet loaded when the popup first opens, `populateSourceLanguages` uses `offlineLanguagePicker()`. Once the server catalog loads and `applyState` is called again, `populateSourceLanguages` is NOT re-called (unlike the target picker, which re-populates on `lastLangPickerKey` change at `index.ts:594-615` — the source picker has no equivalent re-populate gate). In practice this is benign (auto is the default and the offline list covers common sources), but worth noting.

---

## What to ask the user to check

1. Open DevTools on the popup; in the Console tab, after picking a source language, check `chrome.storage.local.get("sourceLanguage")` — confirm the correct value is persisted.
2. In the content script's console, add `console.log(sm?.settings?.sourceLanguage)` at the `fetchCaptions` call site (or log the `preferLang` argument) — this will confirm the value reaches content but is not forwarded to the picker.
3. Confirm the source dropdown retains its value across popup close/re-open (it should — the cache includes `sourceLanguage`).

---

## Summary

The propagation chain is **fully wired and correct** from popup → chrome.storage → background → CONTENT_START / CONTENT_UPDATE_SETTINGS → `sm.settings.sourceLanguage`. The bug reported ("uses the default") is caused by `subtitle-first-pipeline.ts` **reading `targetLanguage` instead of `sourceLanguage`** as the `preferLang` argument to `fetchCaptions` at four call sites — the setting is stored and transported correctly but never consumed. The fix is entirely in Agent 2's scope (Fix D-picker).
