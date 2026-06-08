# R4 — Symptom D: Continuation Translation Config Not Following User Settings

## 1. Exact Settings Field Names — Source of Truth

### Settings interface (`src/shared/types.ts:19-30`)

```ts
export interface Settings {
  tier: TranslationTier;          // "realtime" | "standard"
  targetLanguage: string;         // e.g. "vi" — the TARGET (output) language
  realtimeVoice: string;
  standardVoice: string;
  originalVolume: number;
  voiceVolume: number;
  showSource: boolean;
  showTargetCaptions: boolean;
  apiBearer: string;
}
```

**There is NO `sourceLanguage` / `langSource` field in `Settings`, `State`, or `StartSettings`.**

`sourceLang` exists only as the *output* of `CaptionFetchResult` (`src/shared/platform-ports.ts:92`) — it is the language of the caption track that was fetched, detected per-video, not a persisted user preference.

The adapter's `fetchCaptions` accepts `preferLang?: string` (`src/shared/platform-ports.ts:176`), but in practice this is **always wired to `settings.targetLanguage`** (the output language), NOT a user-configured source language. See:

- `subtitle-first-pipeline.ts:156` → `preferLang: sm.settings.targetLanguage`
- `subtitle-first-pipeline.ts:498` → `preferLang: settings.targetLanguage`
- `youtube/adapter.ts:78` → `preferLang ?? "en"` fallback

**Key finding:** `preferLang` in `fetchCaptions` is being passed the TARGET (output) language but the YouTube adapter's `pickCaptionTrack` uses it to pick a *source-language track* that best matches. This is a semantic mismatch — the caption source track selection is driven by the target language ("vi"), so YouTube's caption picker tries to find a "vi"-language track. When none exists, it falls back: first to English tracks (score +50 for `code === "en"`), then ASR auto-captions (`captions.ts:34-43`).

### Persisted config storage (`src/shared/storage.ts` + `src/background/store.ts`)

Only `Settings` keys are persisted (`chrome.storage.local`). Loaded via `loadSettings()` (`storage.ts:20-25`). The store's `persistSettings()` (`store.ts:204-209`) saves any subset of `Settings`. **No source language is ever persisted.** The source language is always auto-detected per-video from caption track metadata.

---

## 2. `continueOnNewVideo` (Content Soft Restart) — Does It Carry Full Settings?

### Path: `src/content/auto-next.ts:149`

```ts
const session = sm.session;
const settings = sm.settings;       // LiveSettings = StartSettings (full snapshot)
if (!session || !settings) { ... }
```

Then dispatched to:

- **Subtitle-first path** (`auto-next.ts:184`):
  ```ts
  const r = await app.subtitleFirst.restart(settings, newVideoId);
  ```
  Passes the **full** `sm.settings` (`StartSettings`) — includes `targetLanguage`, `tier`, all voice/volume fields.

- **WebRTC path** (`auto-next.ts:193, 206`):
  ```ts
  const r2 = await app.webrtc.continueOnNewVideo({ ...settings });
  // OR
  const r = await app.webrtc.continueOnNewVideo({ ...settings });
  ```
  Also passes the **full** `sm.settings` spread.

So the content soft restart **does carry the full `sm.settings`** including `targetLanguage`. No fields are dropped at the dispatch level.

### Inside `subtitle-first-pipeline.ts` `restart()` (`line 364-651`)

The `settings` param is used as-is:
- `settings.apiBearer` → stored in `newSession.apiBearer` (line 449)
- `settings.targetLanguage` → `preferLang` for caption fetch (line 498, 515) and TTS render (line 656)
- `settings.voiceVolume` → gain (line 428)

The `restart()` method **does NOT re-read from storage**; it uses the passed `settings` directly. Settings survival is intact here.

### Inside `webrtc-pipeline.ts` `continueOnNewVideo()` (`line 486-604`)

Uses `settings.targetLanguage`, `settings.standardVoice`/`settings.realtimeVoice`, `settings.apiBearer` — all from the passed snapshot. Also intact.

---

## 3. Background Auto-Start (Fresh Restart) — Where Do Settings Come From?

### `src/background/auto-start.ts:99`

```ts
void session.start({});
```

The settings argument is an **empty object `{}`**. No source language, no target language, no tier — nothing.

### `src/background/session-coordinator.ts:156-161` — `start(settings?)`:

```ts
async start(settings?: Partial<Settings>): Promise<StateResult> {
  const { state } = this.store;
  if (state.running || state.connecting) { ... }
  await this.store.persistSettings(settings ?? {});  // line 161
```

With `settings = {}`, `persistSettings({})` is a no-op (no keys to merge). The store's existing `state` (loaded from `chrome.storage.local` on boot) is used unchanged.

Then at line 246–250:

```ts
const snapshot = this.store.snapshot();  // full state clone
const startSettings: StartSettings = {
  ...snapshot,
  apiBase: mode.apiBase,
  apiBearer: mode.apiKey,
};
```

**The `StartSettings` sent to content is a full snapshot of the current store state** — which includes `targetLanguage` as persisted.

**Conclusion for path 3:** Background auto-start uses the store's persisted `targetLanguage`. If the user's stored `targetLanguage` is correct (e.g. "vi"), it is sent correctly. This path does NOT lose the target language.

---

## 4. Why Does the Source Language Differ Between Original and Continuation?

### Root Cause 1 (PRIMARY): No User-Configurable Source Language — It's Always Auto-Detected

The user's phrase "tiếng gốc không theo cấu hình" is a symptom of **the absence of any source-language field in `Settings`**. There is no `sourceLanguage` key the user can configure or that persists. The source language is determined by whatever caption track YouTube/the platform returns for that video.

On each restart, `fetchCaptions()` re-runs track selection (`pickCaptionTrack`, `captions-fetch.ts:279, 355`). The track selection is **per-video** and driven by the video's available tracks + the scoring heuristic. If video A has an "en" auto-caption track and video B only has "ko" and "vi" tracks, the selected caption source track will differ between them — producing different "tiếng gốc" for the same user session.

**File:line:** `src/platforms/youtube/captions.ts:28-43` — `pickCaptionTrack` scoring:
- +100 if code matches target lang (e.g. "vi") — this is WRONG for source selection
- +50 if code is "en"
- +10 for non-ASR tracks

This means `preferLang: settings.targetLanguage` ("vi") causes the picker to prefer a Vietnamese-language caption track as the "source" — i.e., the picker tries to use the target language as source, which is semantically backwards. When the video has an "en" track, "en" still wins (+50 vs 0 for mismatch), but the ordering is fragile.

### Root Cause 2: Layer 0 `capturedNetwork` ignores `targetLang` entirely

`fetchViaCapturedNetwork()` (`captions-fetch.ts:227`) replays whatever the YouTube player captured from the network. This is the PRIMARY path (pot-proof). The captured CC track is whichever track the user's YouTube player was showing — which may differ across videos, auto-advance sessions, or player state changes. `targetLang` is only used in Layer 0 for the fallback `captionTracks` picked from `/youtubei/v1/player` response, not for the raw captured body/URL paths.

**Net effect:** On a continuation, the new video's CC track may be a different language than the previous video because:
1. The player captured a different language track for the new video.
2. `pickCaptionTrack`'s scoring picks the "best" available track (not necessarily "en") based on what's available.

### Root Cause 3: `continueOnNewVideo` Fallback Path Omits `sm.settings` Update on Settings Mismatch

`auto-next.ts:192-196` — when subtitle-first `restart()` returns `!r.ok`, the fallback to WebRTC-Standard is:

```ts
const r2 = await app.webrtc.continueOnNewVideo({ ...settings });
```

This still uses the right settings. But the subtitle-first `restart()` itself may internally redetect the caption source track via a fresh `adapter.fetchCaptions()` call (line 496-503), picking a different source language track for the new video. This is expected behavior but produces "dịch tiếp khác nhau" because the source text (and thus translation context) changes when the caption source track changes language.

### Root Cause 4 (Inconsistency): `sm.settings` Updated After Each Restart

In `webrtc-pipeline.ts:573`: `sm.settings = { ...settings }` — settings are re-stamped with the passed-in snapshot. In `subtitle-first-pipeline.ts:129`: `sm.settings = { ...incomingSettings }`. These are consistent. However, the actual caption `sourceLang` is stored only in `CaptionFetchResult.sourceLang` and is NOT fed back into `sm.settings`. The "source language" shown to the user (if the overlay shows it) is derived from the fetched caption track metadata, not from any user config, so it changes per video.

---

## 5. Single Source of Truth for Source Language?

**No.** There is no single source of truth for the user's chosen source language, because **source language is not a user-chosen setting** — it does not exist in `Settings`, `State`, or `StartSettings`. Each restart path calls `adapter.fetchCaptions({ preferLang: settings.targetLanguage })` and accepts whatever track the platform returns.

For `targetLanguage` (the output/translation target), there IS a single source of truth: `chrome.storage.local` → loaded into `store.state.targetLanguage` → sent in every `CONTENT_START`/auto-start as `StartSettings.targetLanguage`. This field does survive all restart paths correctly.

---

## Fix Options

### Option A: Add `sourceLanguage` to `Settings` + Persist It (Full Fix)

**Mechanism:** Add `sourceLanguage: string` (default `"en"`, user-selectable in popup) to `Settings` and `DEFAULT_SETTINGS`. Persist it to `chrome.storage.local`. Pass through `StartSettings` → `continueOnNewVideo` → `fetchCaptions({ preferLang: settings.sourceLanguage })` (renaming the current misnamed `targetLang` param usage to actually represent the source language preference).

**Files touched:**
- `src/shared/types.ts` — add `sourceLanguage: string` to `Settings` + `DEFAULT_SETTINGS`
- `src/shared/storage.ts` — included automatically (SETTINGS_KEYS from `DEFAULT_SETTINGS` keys)
- `src/content/pipelines/subtitle-first-pipeline.ts:156,176,498,515` — change `preferLang: sm.settings.targetLanguage` → `preferLang: sm.settings.sourceLanguage`
- `src/platforms/youtube/adapter.ts:78` — change fallback from `"en"` to `settings.sourceLanguage ?? "en"`
- Popup UI — add source language selector

**Tradeoff:** Requires UI work + storage migration. The `preferLang → targetLanguage` usage may have been intentional (to prefer captions in the same language you're translating TO for pass-through dubbing), but this is unclear from the code. This is the correct semantic fix.

**Cross-slice conflict:** R3 identifies two restart mechanisms (soft content restart vs hard bg auto-start). Both would benefit from this fix since both already carry `StartSettings` through correctly — the issue is that the field doesn't exist yet.

### Option B: Fix `pickCaptionTrack` Scoring (Partial Fix, No Storage Change)

**Mechanism:** Change `pickCaptionTrack`'s `targetLang` param semantics: instead of preferring a track matching the user's output language, prefer "en" (or a hardcoded set of common source languages) as the first choice, with the current language preference logic removed. Rename param to `preferSourceLang` and default to `"en"`.

**Files touched:**
- `src/platforms/youtube/captions.ts:28-43` — revise scoring
- `src/platforms/youtube/adapter.ts:78` — change `preferLang ?? "en"` to always pass `"en"` (or a resolved source lang)
- `src/platforms/youtube/captions-fetch.ts:279,355` — ensure `targetLang` means source preference

**Tradeoff:** Doesn't expose a user-configurable source language. Fixes the semantic confusion but doesn't let users set non-English source languages. Low UI cost.

### Option C: Lock Source Language to First-Session Detected Track (Minimal Patch)

**Mechanism:** On session start, capture the detected `sourceLang` from `CaptionFetchResult` into `sm.settings` (add a transient field `detectedSourceLang`) and pass it through `continueOnNewVideo` so subsequent videos prefer the same source language track.

**Files touched:**
- `src/content/session-manager.ts` — add `detectedSourceLang: string | null`
- `src/content/pipelines/subtitle-first-pipeline.ts:start()` — store `captionResult.sourceLang` → `sm.detectedSourceLang`
- `src/content/auto-next.ts` — pass `detectedSourceLang` as `preferLang` override in the `settings` spread
- `src/content/pipelines/subtitle-first-pipeline.ts:restart()` — use `detectedSourceLang` as `preferLang`

**Tradeoff:** Cheapest fix, no storage change, no UI. Locks the source lang to what the first video's player happened to have. Breaks on user switching playlists across language regions. Not user-configurable.

---

## Cross-Slice Conflicts

- **R3 (two restart mechanisms):** Both mechanisms correctly carry `StartSettings` through. The bug is not in how settings are passed but in what settings exist. The fix (Option A/B/C) must be applied at the `fetchCaptions` call site inside both `subtitle-first-pipeline.ts:restart()` and `webrtc-pipeline.ts` (though WebRTC doesn't call `fetchCaptions` — it streams audio, so source lang is irrelevant there; the "inconsistency" complaint is subtitle-first specific).
- **R3's hard-nav auto-start path** (`auto-start.ts:99` calls `session.start({})`) correctly uses the persisted store state for all `Settings` fields. Once `sourceLanguage` is added to `Settings`, it will be included automatically.
- The Layer-0 captured-network path (`fetchViaCapturedNetwork`) bypasses `preferLang` for the first two sub-layers and uses whatever the YT player captured. No code change can override this without switching away from the captured-network approach.
