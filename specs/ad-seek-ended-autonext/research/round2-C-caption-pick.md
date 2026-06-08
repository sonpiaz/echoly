# Round-2 Research — Agent C: Caption SOURCE-track selection & post-ad path

Slug: `ad-seek-ended-autonext` · Focus: `subtitle-first-pipeline.ts`, `captions-fetch.ts`, `captions.ts`, `adapter.ts`

---

## 1. Does the post-ad path re-fetch captions?

**NO. The post-ad path does NOT re-fetch captions.**

Trace: `AdWatcher #evaluate` (true→false) → `this.#onAdEnd?.()` → `index.ts:365` `void this.#exitAdPause()` → `index.ts:456–461` `this.subtitleFirst.reAnchor(sess, video)` → `subtitle-first-pipeline.ts:1038–1039` `reAnchor()` calls `this.#onSeek(s, video)`.

`#onSeek` (`subtitle-first-pipeline.ts:1054–1089`) does NOT call `adapter.fetchCaptions`. It only:
1. Calls `this.app.ad?.reseed()` (Fix C — re-reads ad state).
2. Guards on `isPausedFor("ad")` (returns early if ad is still active).
3. Resets `_played` flags + `renderCursor` to the new playhead anchor.
4. Calls `#stopCurrent(s)` + `#playbackTick(s)`.

**The cues that drive the post-ad dub are those fetched at `start()` (or `restart()` for auto-next). The post-ad recovery replays cues already in memory. The "wrong Original" is therefore determined at START time (or restart time for auto-next), not at ad-end.**

---

## 2. The default chain when `sourceLanguage="auto"`

With the Fix-D code already applied on this branch, the chain is:

1. **Pipeline** (`subtitle-first-pipeline.ts:156–159`):
   ```ts
   preferLang: (sm.settings.sourceLanguage && sm.settings.sourceLanguage !== "auto")
     ? sm.settings.sourceLanguage
     : undefined,
   avoidLang: sm.settings.targetLanguage,
   ```
   `sourceLanguage="auto"` → `preferLang: undefined`, `avoidLang: "vi"`.

2. **Adapter** (`adapter.ts:81`):
   ```ts
   return fetchYouTubeCaptionsWithSettle(opts.videoId, opts.preferLang ?? "en", ...)
   ```
   `preferLang=undefined` → `sourcePref="en"`.

3. **`pickCaptionTrack`** (`captions.ts:53–57`) with `sourcePref="en"`, `avoidLang="vi"`:
   - ASR track: +100 (original spoken language) — wins if present.
   - Any "en" track: +60 (sourcePref match) + 20 (en bonus) = +80.
   - Other tracks: 0 (or −200 if code==="vi").

4. **Result**: "auto" → always picks the ASR track (original spoken language, e.g. English spoken video → English ASR), or if no ASR, the "en" track, or the highest non-vi scorer.

This is the **correct behaviour** for Fix D. Before Fix D, `preferLang` was `targetLanguage` ("vi"), which scored +60 for any Vietnamese track and +10 for non-ASR, causing the picker to prefer a "vi"-language caption track as the source. That was the actual bug. The branch has already applied the fix.

---

## 3. Layer-0 dominance — does it override the user's sourceLanguage?

**Yes — for sub-layers (a) and (b) — but the avoidLang guard prevents the worst case.**

Layer-0 sub-layers (a) and (b) (`captions-fetch.ts:281–313`) return whatever timedtext the YouTube player captured from its own network requests, **ignoring `sourcePref` entirely** — they only apply the `avoidLang` guard (skipping entries where `primarySubtag(lang)===avoidCode OR primarySubtag(tlang)===avoidCode`). Sub-layer (c) routes through `pickCaptionTrack` and does honor `sourcePref`.

**Quantifying Layer-0 dominance:**

When CC is on (or when the pipeline nudges it), the player captures its currently-shown track body (sub-layer a) or its pot'd URL (sub-layer b). These win before `pickCaptionTrack` is ever consulted. The user's `sourceLanguage` setting has **zero effect** on which track Layer-0 returns, except that it will not be the target/avoidLang track (guard filters those).

Concrete scenario: video spoken in English, user target="vi", user source="en". YouTube's CC button shows "vi" (user had native CC in Vietnamese). Sub-layer (a) body or (b) URL has `lang=vi` and/or `tlang=vi`. The avoidLang guard (`avoidCode="vi"`) correctly **skips** this entry. But if the player shows "en" auto-captions (CC was already showing English), Layer-0 returns the "en" body regardless of sourceLanguage="ko" — the explicit source preference is ignored.

**After-ad scenario specifically:** When the ad ends and the player reloads the content track, the MAIN-world hook captures the newly-fetched content track. However, this capture only populates the NEXT session's `fetchCaptions` call (at `start()` or `restart()`). The post-ad `reAnchor()` path does NOT call `fetchCaptions` at all, so Layer-0 is not involved post-ad — the already-fetched cues are replayed.

---

## 4. What happens when user sets source="en" but video is not English?

`pickCaptionTrack` with `sourcePref="en"`, say the video has only `[{lang:"ko", kind:"asr"}, {lang:"ja"}]`:

- "ko" ASR: +100 (asr) + 0 (not "en") + 0 = 100.
- "ja": 0.

ASR wins (score 100 > 0). The "en" sourcePref hint (+60) is outweighed by the ASR bonus (+100). So for a Korean-spoken video, the Korean ASR track is returned even when `sourcePref="en"` — which is CORRECT (original spoken language is the best source). The user's explicit "en" hint is overridden by ASR.

Edge case: video has `[{lang:"en", kind:"manual"}, {lang:"ko", kind:"asr"}]` and sourcePref="en":
- "en" manual: +80 (60+20).
- "ko" ASR: +100.

Korean ASR still wins. If the user EXPLICITLY wants the English manual track, the current scoring cannot honor that — ASR always beats explicit `sourcePref`.

---

## Fix Options

### Option F1 — Accept current behaviour (no change)
**File:line:** None. The branch already has Fix D applied. `sourceLanguage="auto"` → `preferLang=undefined` → `sourcePref="en"` → picks ASR or English. This is correct for the common case (original spoken language). Layer-0 overrides sourceLanguage when the player's CC track differs, but the avoidLang guard prevents target→source corruption.
**Tradeoff:** Layer-0 still ignores sourcePref for (a)/(b) sub-layers. Explicit `sourceLanguage="ko"` would be honored only in sub-layer (c) and Layer-2/3. Low fix cost; acceptable for the reported bug.

### Option F2 — Honor sourcePref in Layer-0 sub-layers (a)/(b) by matching `lang` to sourcePref
**File:line:** `captions-fetch.ts:281–313`. After the avoidLang skip, also skip entries where `primarySubtag(lang) !== primarySubtag(sourcePref)` (when sourcePref is explicitly set, i.e. not the default "en" fallback).
**Tradeoff:** Would cause Layer-0 to fall through to sub-layer (c) / Layer-2 when the player captured a different-language track. Risk: if the player only has the "wrong" language captured, nothing is returned and the pipeline falls to audio-capture. Only worthwhile when the user sets an explicit non-default source. Complex to gate "explicit vs default-en".

### Option F3 — Reduce ASR bonus so explicit sourcePref can override it
**File:line:** `captions.ts:53`. Reduce ASR from +100 to +60, raise explicit sourcePref match from +60 to +80.
New scoring: explicit-source-match: +80, ASR: +60, en: +20. User setting "en" + video has [en-manual, ko-asr]: en-manual scores +100, ko-asr scores +60 → explicit wins.
**Tradeoff:** Changes pick semantics. ASR is the original spoken-language track; reducing its priority means manual-translated tracks can beat the original audio for non-source-pref-matching ASR tracks. Could introduce regressions for the common "auto" case. Should be paired with a unit test D1-variant.

---

## Key findings summary

1. **Post-ad does NOT re-fetch captions.** `exitAdPause → reAnchor → #onSeek` only replays in-memory cues. "Wrong Original after ad" is caused by the track selected at `start()` time.

2. **With `sourceLanguage="auto"` (default)**, the chain is: `preferLang=undefined` → adapter defaults `sourcePref="en"` → `pickCaptionTrack` prefers ASR (+100) over "en" (+80), always avoiding avoidLang (−200). This is the correct post-Fix-D behaviour; before Fix D, `preferLang=targetLanguage` caused a backwards pick.

3. **Layer-0 sub-layers (a) and (b) ignore `sourcePref`** entirely, only applying the avoidLang guard. When the YT player's CC button is showing a track, Layer-0 wins and the user's explicit sourceLanguage is not honored (except for avoidLang). Sub-layer (c) and Layer-2 do honor `sourcePref` via `pickCaptionTrack`.

4. **Explicit sourceLanguage vs ASR:** if the user sets `sourceLanguage="ko"` but the video has `[en-manual, ko-asr]`, Korean ASR wins regardless (score +100 vs +80 for en-manual). ASR always beats explicit sourcePref at the current weights — see Option F3 if this matters.
