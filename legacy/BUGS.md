# Echoly — Bug Audit (2026-05-19)

Full-codebase audit at v0.5.2 (`manifest.json`, `background.js`, `content.js`, `popup.js`, `popup.html`). Each bug includes file:line, repro steps, root cause, and fix direction so we can patch at root — not paper over.

Section [Son's Feedback](#sons-feedback) at the bottom is left open for additional symptoms / context to fold into the fix plan.

---

## Severity Legend

- 🔴 **CRITICAL** — silent data loss or feature completely broken under normal use
- 🟠 **HIGH** — degrades the v0.5.2 subtitle-first path or has clear user-visible regression
- 🟡 **MEDIUM** — edge case / suboptimal but recoverable
- 🟢 **LOW** — cosmetic, dead code, minor polish

---

## 🔴 CRITICAL

### C1 — Changing language/voice during subtitle-first session fails silently

**Files:** `content.js:2077`, `content.js:780-825`, `content.js:1583`

**Repro:**
1. Open YouTube video that has CC
2. Start in Standard tier → falls into subtitle-first path (`startSubtitleFirstSession`)
3. Once translating, change language or voice from the **popup** (not the overlay)
4. Background relays `CONTENT_UPDATE_SETTINGS` → `applySettingsLive`
5. Toast appears: *"Switch failed — keeping current session"*. Language never changes.

**Root cause:**
`applySettingsLive` (line 2077) gates on `session?.type !== "standard"` to decide whether to call `requestHandover`. Subtitle-first session has `type: "subtitle-first"` (line 1585), which is **also not `"standard"`** ⇒ falls into handover path.

`requestHandover` then calls:
```js
buildRealtimeSession(newToken, session.stream, {...})  // line 808
```
But subtitle-first session has `stream: null` (line 1588) → inside `buildRealtimeSession` line 622 `audioStream.getAudioTracks()` throws TypeError → caught at line 818 → user sees toast, no actual change.

Side effect: `++pageToken` at line 800 runs **before** the throw, but is never reverted. Subtitle-first uses `s !== session || s.stopFlag` (no `pageToken` check) so it survives, but if a standard-chunk session were in the same tab it would invalidate.

**Fix at root:**
1. Mark realtime sessions explicitly: add `type: "realtime"` to `newSession` in `buildRealtimeSession` (line 630).
2. Change the gate to `session?.type === "realtime"` (positive match).
3. Subtitle-first must accept lang/voice changes on the next wave — the overlay path already does this correctly (line 230-251); replicate that behavior in `applySettingsLive` for `type === "subtitle-first"`: update `settings`, let `runRollingRenderer` pick up the new lang/voice on next batch. No stream needed.

---

### C2 — Typing Kyma key gets wiped when volume slider changes state

**Files:** `popup.js:117-140`, `popup.js:138`, `popup.js:202-213`, `background.js:98-107`

**Repro:**
1. Open popup with empty key field
2. Start pasting/typing `kyma-...`
3. Without blurring the input (no `change` event yet), drag the volume slider
4. `onVolumeChange` → `UPDATE_VOLUME` → background `broadcastToPopup()` → popup receives `BACKGROUND_STATE_UPDATE` → `applyState` runs → `kymaKeyInput.value = state.kymaKey` (= `""` from storage) → user's typing erased

**Root cause:**
`applyState` line 138 unconditionally syncs the input to stored state. The guard `if (kymaKeyInput.value !== state.kymaKey)` is intended to avoid no-op writes, but doesn't account for the case where the input is *more current* than storage.

**Fix at root:**
```js
if (typeof state.kymaKey === "string") {
  // Don't clobber an in-progress edit. Storage is only canonical when
  // input isn't focused (i.e. user has committed via blur/change).
  if (document.activeElement !== kymaKeyInput &&
      kymaKeyInput.value !== state.kymaKey) {
    kymaKeyInput.value = state.kymaKey;
  }
  setKeyBadge(state.kymaKey || kymaKeyInput.value);
}
```

Alternative: switch key persistence to `input` event (debounced) so storage is always ahead — but exposes partial keys to background broadcast loop.

---

## 🟠 HIGH

### H1 — Source caption pane flickers in subtitle-first (two writers, same node)

**Files:** `content.js:2069-2073`, `content.js:461-472`, `content.js:1842-1844`

**Repro:**
1. Subtitle-first session running
2. Toggle **Show source captions** in popup
3. Source pane shows YT native CC text and subtitle-first source sentences alternating each ~350ms

**Root cause:**
- `applySettingsLive` line 2071 starts `startCaptionPoll()` regardless of session type.
- `startCaptionPoll` writes to `elements.source` from YT's `.ytp-caption-segment` DOM.
- `updateLiveDisplay` (subtitle-first) also writes `elements.source` from `s.sentences[idx].text`.

Both are active simultaneously → flicker.

**Fix at root:**
In `applySettingsLive`, only start the YT caption poll when the source isn't already populated by subtitle-first:
```js
if (settings.showSource && session && session.type !== "subtitle-first") {
  startCaptionPoll();
} else {
  stopCaptionPoll();
}
```

---

### H2 — Standard chunk pipeline silently swallows TTS/network errors

**Files:** `content.js:1118-1128`, `content.js:1148-1167`, `content.js:1776-1779`

**Repro:**
1. Standard tier session running
2. Mid-session, Kyma key runs out of balance, or network blip, or rate limit on `/audio/speech`
3. `fetch()` throws → `catch { return; }` → no toast, no status change, no log
4. User sees overlay still says "Translating" but hears silence

**Root cause:**
Bare `catch { return; }` on `fetch` errors (lines 1126, 1165). Distinguishes from the `!resp.ok` branch which DOES call `showStandardError`. Aborted requests (intentional stop) get bundled with real failures.

**Fix at root:**
```js
} catch (err) {
  if (err?.name === "AbortError") return;  // intentional stop
  if (s !== session || s.token !== t) return;  // stale
  showStandardError({ user: "Network error — retrying next chunk." });
  return;
}
```

Same treatment for `webmBlobToWav` decode failure (line 1093) — currently `return` with no signal.

Apply the same pattern in subtitle-first's per-sentence TTS error swallow (`content.js:1776-1778`) — surface a count of failed sentences in the status.

---

### H3 — `pageToken` permanently bumped on failed handover

**Files:** `content.js:800`, `content.js:818-825`

**Repro:** (linked to C1)
1. Anything that calls `requestHandover` and fails before swap (e.g. C1 path, or network drop during mint)
2. `++pageToken` at line 800 runs first; catch at 818 returns without revert
3. Any subsequent code that checks `s.token !== pageToken` in the current session aborts

**Affects:** Standard chunked pipeline (`processStandardChunk:1079`) — chunks already in flight short-circuit. Subtitle-first happens to survive because it uses `stopFlag`, not `pageToken`.

**Fix at root:**
Capture token before bump, revert on failure path before the catch returns:
```js
const previousToken = pageToken;
const newToken = ++pageToken;
// ...
} catch (err) {
  if (newToken !== pageToken) return;
  pageToken = previousToken;  // restore so existing session keeps running cleanly
  ...
}
```

---

### H4 — ~~Subtitle-first always plays the video after wave 1~~ → **CORRECTED → see SF6**

**Original analysis was inverted.** I assumed `await video.play()` always succeeds. In reality Chrome autoplay policy revokes the user gesture after ~5s of awaited async work, so `play()` throws and the catch swallows it → video stays paused. Son confirmed this in live testing.

Reclassified as **SF6** below (real symptom is the opposite: video doesn't resume).

---

## 🟡 MEDIUM

### M1 — Background `state.tabId` cleared after `relayToContent` race

**File:** `background.js:209-225`

If `relayToContent(tabId, CONTENT_STOP)` is slow or throws, tabId stays set briefly. `onRemoved`/`onUpdated` checks `tabId === state.tabId` so a late event could re-trigger `handleStop`. Idempotent so harmless, but `state.tabId = null` should happen before the relay, not after.

---

### M2 — Subtitle-first `pendingSources` array grows unbounded

**File:** `content.js:1796-1802`, `content.js:1822-1828`

Every scheduled `AudioBufferSourceNode` pushed; only cleared on seek or stop. For a 60-min session this is ~3000+ refs. GC reclaims on `audioCtx.close()` but memory creeps until then.

**Fix at root:**
```js
src.onended = () => {
  s.pendingSources = s.pendingSources.filter((x) => x !== src);
};
```

---

### M3 — `fetchCCViaIntercept` 1800ms timeout occasionally too short

**File:** `content.js:1275`

On slow networks or first-load with cold YT JS bundle, the timedtext request takes longer. Layer 2 (DOM `ytInitialPlayerResponse`) almost always catches it, but Layer 1 miss adds visible delay (poll interval is 100ms, so ~1.8s of "Loading captions" toast).

**Fix at root:** bump to 3000ms, OR fire both Layer 1 + Layer 2 in parallel and race.

---

### M4 — `MediaRecorder` started without `timeslice` — first 5s lag is real 5-6s

**File:** `content.js:1067`, `content.js:1071-1073`

`recorder.start()` without arg emits `dataavailable` only on `stop`. So full chunk → stop event → process. Effective latency = 5s + pipeline (~1-2s). Could shave ~200ms by `recorder.start(STANDARD_CHUNK_MS - 200)` so the blob is mostly assembled by the time stop fires.

---

### M5 — Both background AND content listen for SPA URL change → double `stopSession`

**Files:** `background.js:358-364`, `content.js:2092-2100`

`chrome.tabs.onUpdated` (background) and `setInterval` polling (content) both detect /watch?v=A → /watch?v=B and call stop. Idempotent so no crash, but redundant cleanup logs and one extra `endKymaSession` POST. Pick one source of truth — content's polling is needed anyway for in-page SPA history changes, so background should skip URL-change handling.

---

### M6 — `parseKymaError` doesn't handle non-JSON error bodies cleanly

**File:** `content.js:514-534`

If Kyma gateway returns an HTML 502 (Cloudflare/origin proxy hiccup), the JSON.parse catches but the fallback message returns `"Kyma 502: <!DOCTYPE html>..."` truncated at 160 chars. Ugly user-facing string. Add a quick HTML sniff: if first non-whitespace is `<`, return generic `"Kyma unreachable — retry in a moment."`

---

## 🟢 LOW

### L1 — Redundant prefix check

**File:** `popup.js:108`

```js
} else if (k.startsWith("ky") || k.startsWith("kyma-")) {
```
`"kyma-".startsWith("ky")` is already `true`. The OR branch is dead. If the intent was to accept legacy keys `ky-...` AND new `kyma-...`, just use `startsWith("ky")`.

---

### L2 — Popup placeholder doesn't match actual key format

**File:** `popup.html:51`

Placeholder is `ky-...` but real Kyma keys are `kyma-...`. Users paste and wonder if format is wrong.

---

### L3 — Dead field `_sentenceIdx`

**File:** `content.js:1800`

`src._sentenceIdx = i;` assigned, never read.

---

### L4 — `audio.muted = true` then never unmuted in realtime fallback path

**File:** `content.js:644-665`

If the Web Audio setup throws (very unusual), fallback at 663 sets `audio.muted = false` but doesn't reset volume from the initial Web Audio gain plan. Reads confusingly. Harmless.

---

### L5 — Subtitle-first shows "Translating" with no progress between waves

**File:** `content.js:1847-1879`

`runRollingRenderer` silently translates/renders next wave. User sees no indication. A subtle `setStatusText("Preparing next ~30s")` during the heavy work and `"Translating"` after would close the loop.

---

### L6 — `host_permissions` requests `api.openai.com` unconditionally

**File:** `manifest.json:13-15`

Only the Realtime tier touches OpenAI directly (SDP exchange). Could be moved to `optional_host_permissions` and requested when Realtime starts — improves trust signal on Web Store review.

---

## Cross-cutting Observations

1. **Session type discriminator is asymmetric.** Standard chunked has `type: "standard"`, subtitle-first has `type: "subtitle-first"`, but realtime has no `type` field. Fix: tag all three explicitly. Eliminates C1 root cause and similar future bugs.

2. **Error handling in chunked pipeline is too forgiving.** Bare `catch { return; }` patterns make production debugging painful and hide real outages from the user. Consider a single `handlePipelineError(err, { session, stage, recoverable })` helper.

3. **Token vs stopFlag inconsistency.** Subtitle-first checks `s !== session || s.stopFlag`; standard chunked checks `s !== session || s.token !== pageToken`. Pick one staleness contract — preferably `s !== session || s.stopFlag` since `session` reassignment already invalidates everyone, and `pageToken` is fragile (see H3).

4. **No telemetry / debug log.** When users report bugs, there's no console signal indicating which fallback layer was used (intercept / DOM / plain-URL) or where the chunk failed. A `if (DEBUG) console.debug(...)` gated on `localStorage.echolyDebug === "1"` would massively shorten future bug reports.

---

## Fix Priority

**Round 1 (this session, ~30-45 min):**
- C1, C2 — silent user-visible breakage
- L1, L2 — trivial cleanups while we're in those files

**Round 2 (~1-2h):**
- H1, H2, H3, H4 — subtitle-first regressions and pipeline error surfacing
- Cross-cutting #1 (session type tagging) — enables clean C1 fix and prevents reoccurrence

**Round 3 (when convenient):**
- M1-M6, L3-L6
- Cross-cutting #2 (centralized error helper) + #4 (debug flag)

---

## Son's Feedback (2026-05-19, live testing on Google I/O '26 keynote)

Ghi nhận từng case anh báo cáo. Phase 1: **chỉ document — chưa fix**. Phase 2 deepdive từng cái sẽ chạy sau khi đã list đủ.

---

### SF1 — Realtime: 5-6 giây mới có output đầu tiên (spec hứa <1s) 🔴

**Symptom:** Chọn Realtime tier → click Start → phải đợi 5-6s mới nghe được câu dịch đầu tiên. Tier label trên popup ghi `<1s` nên user expectation rất cao.

**Đoán nguyên nhân (chưa verify):**
- `KYMA_BASE/realtime/translations/client_secrets` mint (`content.js:593`) — Kyma → OpenAI ephemeral token mint
- SDP exchange với `api.openai.com/v1/realtime/translations/calls` (`content.js:683`)
- ICE candidate gathering trong `RTCPeerConnection` — Chrome gather có thể chậm nếu nhiều interface
- OpenAI Realtime model cold-start: lần đầu nhận audio mất 2-4s mới phát ra audio dịch
- `captureWithRetry` (`content.js:495`) retry loop 300ms ticks, timeout 9s — nếu first stream không có audio tracks thì stall

**Cần đo:**
- Log `Date.now()` ở mỗi điểm: click Start → mint resp → SDP resp → first `track` event → first `delta` event → first audio actually heard
- So sánh cold start vs warm restart trong cùng tab
- Verify Kyma `client_secrets` p50 latency

**Liên đới:** "Connecting" status không update theo từng giai đoạn nên user nghĩ extension đứng. Cần status sequence: `Acquiring audio → Minting key → Connecting → Speaker warming → Live`.

**Task:** #1 (Investigate Realtime first-output latency)

---

### SF2 — Auto voice clone: không giống giọng + đổi giọng giữa các câu 🟠

**Symptom:** Chọn Voice = `Auto · clones speaker` ở Realtime tier:
- Voice output không giống giọng người trong video
- Câu này nói giọng A, câu sau bị chuyển sang giọng B (voice drift mid-session)

**Đoán nguyên nhân (cần research — có thể KHÔNG phải bug Echoly):**
- Echoly gửi `voice: ""` (empty string) tới Kyma khi user chọn Auto (`content.js:599`). Kyma chuyển sang OpenAI Realtime model với voice unset → model tự quyết.
- OpenAI Realtime gpt-realtime-translate model **không chính thức hỗ trợ voice cloning** — nó dùng preset voices và có thể drift giữa các response turns.
- "Clones speaker" trong copy của Echoly có thể đang **oversell** capability của model.

**Cần research:**
- OpenAI docs về `gpt-realtime-translate` voice handling
- Community reports về voice drift trong Realtime sessions
- Có endpoint/parameter nào lock voice không (e.g. `voice_clone_audio`)?
- Có nên đổi copy thành `Auto · model-decided voice` để khỏi mislead?

**Quyết định pending sau research:**
- Nếu là model limitation: update copy + show disclaimer
- Nếu Echoly thiếu param khi mint: thêm vào `client_secrets` body
- Nếu cần custom voice clone: cân nhắc tier mới dùng MiniMax voice clone API (đã có sẵn ở Standard tier)

**Task:** #2 (Research GPT Realtime Auto voice-clone limitation)

---

### SF3 — Volume sliders KHÔNG hoạt động ở cả Realtime + Standard 🔴

**Symptom:** Trong session đang chạy, kéo **Original** hoặc **Voice** slider:
- "Lúc bị to lúc bị bé, kéo xuống 0 nhưng nhiều lúc vẫn bị to" — intermittent
- Đa số lần, kéo slider không có thay đổi audible

**Đoán nguyên nhân (đa nghi):**
1. **YouTube re-applies own volume:** YT player tự đồng bộ `video.volume` từ localStorage/internal state. `applyVolumes` (`content.js:744`) ghi `video.volume = vol` một lần, sau đó YT có thể override khi user click bất kỳ đâu trên player, khi seek, khi pause/play.
2. **Voice slider on Realtime:** đường đi `applyVolumes` → `session.outputGain.gain.linearRampToValueAtTime` cần `session.audioCtx` và `session.outputGain`. Nếu Web Audio fallback path activated (line 663-665 trong `buildRealtimeSession`), `outputGain` là null → rơi xuống `remoteAudio.volume` max 1.0 → không có amplification trên 1.0.
3. **Message delivery:** `UPDATE_VOLUME` từ popup → `handleUpdateVolume` → `relayToContent` → content listener. Nếu `state.tabId` lệch với active tab, message gửi nhầm tab hoặc fail. Background fallback to active YT tab nhưng cũng `ensureContentScript` mỗi lần kéo slider → có thể chậm/lỗi.
4. **Async race:** popup debounce 60ms, broadcast debounce 50ms (background). Có thể slider value cuối cùng không tới content nếu user release ngay.

**Cần verify:**
- Console log trong content `CONTENT_UPDATE_VOLUME` handler — confirm message reach + value
- `video.volume` post-write — kiểm tra có bị YT override không (poll 100ms sau khi set)
- Realtime: `outputGain` có null khi fallback không
- Test với DevTools open trên YT tab

**Fix direction (sau khi xác nhận root cause):**
- Hook `volumechange` event trên videoEl để re-apply desiredVolume nếu drift
- OR: dùng `audioCtx.createMediaElementSource(videoEl)` để route YT audio qua Web Audio gain — full control, không cần fight với YT
- Đảm bảo `outputGain` luôn tồn tại (kể cả fallback path) để Voice slider có hiệu lực

**Task:** #3 (Fix volume sliders)

---

### SF4 — Standard tier: 8-10+ giây mới có output đầu tiên 🟠

**Symptom:** Standard tier (mà thực tế là subtitle-first nếu YT có CC) — click Start → đợi 8-10+ giây mới nghe được câu đầu.

**Đoán nguyên nhân theo pipeline:**

**Subtitle-first path (`startSubtitleFirstSession`):**
1. `pause video` (`content.js:1619`)
2. `fetchYouTubeCaptions` — Layer 1 intercept timeout 1.8s (`M3`), Layer 2 DOM parse, Layer 3 plain URL (`content.js:1365`)
3. `regroupToSentences` (`content.js:1467`) — fast
4. `translateBatch` first wave (~5 sentences, 1 Gemini call ≈ 1-2s)
5. `renderWaveTTS` first wave — 5 parallel MiniMax TTS calls, each ~1-2s
6. `video.play()` (`content.js:1739`)
7. Schedule playback — first source plays at audioOffset + sentence.start

**Total floor:** ~3-5s nếu mọi thứ song song hoàn hảo. 8-10s = pipeline bottleneck.

**Chunked path (`startStandardSession`, khi không có CC):**
- Recorder cycle = 5s full chunk before emit
- + WAV transcode ~30ms
- + Gemini audio understand ~1-2s
- + MiniMax TTS ~1-2s
- **Floor: 7-9s** — matches Son's report nếu video không có CC

**Cần verify:**
- Log per-stage timings trong subtitle-first
- Confirm Google I/O '26 keynote thực sự có CC (Son's test video) — nếu có CC mà vẫn 8-10s thì là subtitle-first pipeline chậm
- Nếu không có CC → fallback chunked → 8-10s là expected, cần update copy "~5s lag" thành thực tế

**Fix direction (sau khi đo):**
- Subtitle-first: parallel `fetchCaptions` + `audioCtx warmup`; reduce first wave size từ 5 → 3 sentences
- Chunked: dùng `MediaRecorder.start(STANDARD_CHUNK_MS - 200)` để emit data sớm (`M4`)
- Status update từng stage để user thấy progress

**Task:** #4 (Investigate Standard latency)

---

### SF6 — Non-live video: pause OK, NHƯNG không tự auto-play khi wave 1 sẵn sàng 🔴

**Symptom (Son confirm 2026-05-19):**
- Click Start trên video non-live có CC → video pause (đúng intent, để dub đồng bộ với speaker khi resume)
- Wave 1 render xong → video **vẫn pause**
- User phải bấm play YouTube tay → mới load lại, lúc đó dub ĐÃ render xong nhưng audioOffset stale → vẫn delay tiếp

**Root cause (Chrome autoplay policy):**
- User click Start là user gesture, "transient user activation" trong Chrome.
- Activation **survives** vài async hops, nhưng bị invalidate sau ~5s of cumulative await.
- Subtitle-first wave 1 path: `pause()` → `fetchCaptions` (1-3s await) → `translateBatch` (1-2s) → `renderWaveTTS` (3-5s, max của 5 parallel TTS) = **5-10s tổng await chain**.
- Đến lúc `await video.play()` ở line 1739 chạy thì activation hết hạn → `play()` throw `NotAllowedError: play() failed because the user didn't interact with the document first` → bị `try { ... } catch {}` (line 1739) nuốt mất hoàn toàn.

**Audio sync side effect:**
Khi user tay click play sau đó, `audioOffset` đã được set tại line 1698 (`audioCtx.currentTime - video.currentTime` lúc video chưa play, tức currentTime của lúc pause). Schedule dựa trên offset này → khi video resume từ điểm khác hoặc gap đã trôi, dub không khớp với speaker.

**Fix direction (phân tích trade-off):**

| Approach | Pros | Cons |
|----------|------|------|
| **A. Pre-play immediately**, mute video, render wave 1 in background, unmute khi dub bắt đầu | Gesture còn warm, không cần user click | User nghe ~5-10s muted original, mất sync visual lip |
| **B. Shrink wave 1 to 1-2 sentences** thay vì 5 | Wave 1 xong trong ~3-4s, gesture còn → `play()` thành công | Vẫn risky nếu Gemini/MiniMax slow |
| **C. Overlay show "Click to start" button** sau wave 1 ready | Reliable 100%, fresh user gesture | Thêm 1 click friction |
| **D. Không pause video at all**; render dub song song, schedule at sentence.start + audioOffset; bỏ qua các sentence đã trôi qua trong khi render | Zero pause friction, đúng spirit của "live translation" | User mất ~5-10s đầu của nội dung (intro thường filler) |

**FINAL APPROACH (2026-05-19, Son's design decision — Q1/Q2):**

Son confirmed: muốn dub bắt đầu **cùng lúc** với speaker, không overlap quá khứ → **pause cho cả Realtime và Standard non-live**. Live → KHÔNG pause (Q2 reasoning bên dưới).

**Detection live vs non-live:**
```js
const isLive = !isFinite(videoEl.duration);  // live = Infinity / NaN
```

**Non-live Realtime (NEW behavior):**
1. Click Start → `videoEl.pause()` ngay (gesture warm)
2. `buildRealtimeSession`: mint client_secret + SDP exchange + ICE (~2-3s tổng)
3. Khi `pc.connectionState === "connected"` (hoặc `iceConnectionState === "connected"`):
4. `videoEl.play()` ngay (gesture vẫn warm vì <5s)
5. captureStream emit audio → WebRTC nhận → model output dub
6. First dub frame audible ~1-2s sau (model first-token)
7. **Tổng pause window ~3-4s**, sau đó speaker EN + dub VI chạy gần như đồng bộ

**Non-live Standard subtitle-first (REVISED from "don't pause B+D" to "keep pause + shrink wave 1"):**
1. Click Start → `videoEl.pause()` (đã có sẵn line 1619, giữ nguyên)
2. `fetchYouTubeCaptions` (~1-2s)
3. `translateBatch` first wave = **2 sentences thay vì 5** → 1 Gemini call ~1s
4. `renderWaveTTS` first wave = 2 parallel MiniMax → max ~2s (chứ không phải 5 parallel x 2.5s)
5. **Tổng wave 1 ~3-4s** → vẫn trong gesture window
6. `videoEl.play()` → thành công vì gesture chưa expired
7. Background: wave 2+ render tiếp, không block playback

**Non-live Standard chunked (no-CC):**
- Hiện tại: không pause. Cần thêm pause path tương tự Realtime: pause → buildOverlay + captureWithRetry → ngay khi MediaRecorder ready → play()
- Tuy nhiên chunked vẫn cần 5s recording trước khi có chunk đầu → first dub ~7-9s sau play
- Trade-off: nếu pause 0.5s rồi play, user hear 5s EN silence/raw rồi mới có VI overlay. Acceptable.

**Live (cả Realtime + Standard) — NO pause:**
- `isLive === true` → skip pause path hoàn toàn, fallback current behavior
- Live = continuous content, pause = lùi DVR mode vĩnh viễn
- captureStream cần audio liên tục cho RT; Std subtitle-first không work với streaming CC

**Trade-offs đã accept:**
- Non-live Realtime: thêm 3-4s pause window trước first audio. Đổi lại: sync hoàn hảo.
- Non-live Standard: wave 1 từ 5 → 2 sentences = first output ~6s nội dung thay vì ~15s. Wave 2+ render background bù sau.
- Live: giữ inherent lag (RT 5-6s, Std 8-10s) như current. Không thay đổi.

**Files affected:**
- `content.js:1903-1976` (`startSession` Realtime branch) — thêm pause/play orchestration cho non-live
- `content.js:1665-1667` (`firstWaveEnd` calc) — clamp max 2 thay vì 5
- `content.js:1610-1611` (`wasPlaying`) — logic mới: non-live luôn play sau handshake, live giữ user intent
- `content.js:861-870` (`startStandardSession`) — optional thêm pause trước captureWithRetry

**Affected cases:** TC-1, TC-2, TC-3, TC-4 (non-live). TC-5, TC-6 (live) không thay đổi.
**Linked tickets:** SF1 (Realtime latency giảm tự nhiên), SF4 (Standard latency giảm tự nhiên), SF8 (cần check pause logic không conflict với playback rate handling)

---

### SF7 — Standard mode: dub delay **càng lúc càng xa** do TTS dài hơn source (language verbosity) 🟠

**Symptom (Son insight 2026-05-19):**
- Tiếng Việt nói **dài hơn tiếng Anh** ~1.4-1.8x (cùng nội dung)
- Mỗi chunk 5s tiếng Anh → TTS tiếng Việt mất 7-9s đọc
- Chunk N+1 record xong (5s sau) mà TTS chunk N chưa đọc xong → queue dồn
- 60 phút session → drift có thể 30-60s, user nghe dub về sự kiện quá khứ

**Root cause (math):**
```
English chunk:   5.0s audio → translate → Vietnamese TTS: 5.0 × 1.6 = 8.0s
Drift per chunk: 8.0 - 5.0 = 3.0s
After 10 chunks (~1 phút): drift = 30s
```

`processStandardChunk` (line 1186-1197) schedule TTS via `nextPlayAt`:
```js
if (s.nextPlayAt < s.audioCtx.currentTime) s.nextPlayAt = 0;  // queue empty, reset
const startAt = Math.max(s.audioCtx.currentTime + 0.05, s.nextPlayAt);
// ...
s.nextPlayAt = startAt + audioBuf.duration;
```

`nextPlayAt` chỉ reset khi queue **empty** (đã play hết). Nếu chunk N+1 TTS xong trước khi chunk N TTS hết → N+1 nối vào sau N → growth tích lũy.

**Subtitle-first cũng cùng vấn đề** (line 1799): `src.start(Math.max(at, now + 0.02))` — `at = audioOffset + sentence.start`. Nếu TTS dài hơn `sentence.end - sentence.start`, overlap với sentence kế tiếp HOẶC delay nó.

**Fix options (analysis):**

| Approach | Effect | Risk |
|----------|--------|------|
| **1. Hardcode TTS speed** = 1.2 cho VI/JA/KO; 1.0 cho EN | Đơn giản, deterministic | Voice sounds rushed kể cả khi không cần |
| **2. Adaptive TTS speed** dựa trên `queueDepth = nextPlayAt - currentTime` | Tự điều chỉnh, natural khi không drift | Speed oscillation, cần test |
| **3. Concise translation prompt** — yêu cầu Gemini dịch ngắn gọn | Giải quyết tại nguồn (output text ngắn → TTS ngắn) | Có thể mất nuance |
| **4. Skip catch-up chunks** nếu queue depth > 8s | Hard guarantee on drift | User mất nội dung |
| **5. Web Audio `playbackRate`** trên `AudioBufferSourceNode` | Không cần API change | Pitch lên (chipmunk) ở >1.2x |

**Recommend Approach 2 + 3 combo (smart, không hardcode):**

```js
// Trong processStandardChunk, trước khi gọi audio/speech:
const queueDepth = Math.max(0, s.nextPlayAt - s.audioCtx.currentTime);
let speed = 1.0;
if (queueDepth > 6) speed = 1.30;       // strong catch-up
else if (queueDepth > 4) speed = 1.20;
else if (queueDepth > 2) speed = 1.10;
else if (queueDepth > 1) speed = 1.05;

// Hard cap: nếu queue > 10s, skip this chunk
if (queueDepth > 10) {
  console.warn("Echoly drift > 10s, skipping chunk to catch up");
  return;
}

const ttsBody = {
  model: "minimax-speech-turbo",
  input: targetText,
  voice_id: voiceId,
  response_format: "mp3",
  speed,  // ← pass to Kyma → MiniMax
};
```

Và concise prompt cho Gemini (line 1112):
```
Translate the spoken English in this audio into ${langName}. Output should be CONCISE — match the original speech duration. Prefer shorter natural phrasing over literal word-for-word. Preserve names, brand names, and technical terms. ...
```

**Verified (2026-05-19):**
- ✅ Kyma `/v1/audio/speech` route forward `speed` từ request body → MiniMax provider (`kyma-api/src/routes/multimodal.ts:1089`)
- ✅ MiniMax speech-02-turbo accepts `speed: 0.5..2.0` (`kyma-api/src/providers/minimax.ts:42, 113`)
- ✅ Echoly side chỉ cần thêm 1 field `speed: N` vào TTS body — 0 thay đổi Kyma cần thiết

**Affected cases:** TC-2 (long sessions), TC-4 (long sessions), TC-6 (live + Std nếu support)
**Linked tickets:** standalone, không depend gì khác

---

### SF8 — User đổi playback rate (1.25x / 1.5x / 2x) — pipeline KHÔNG handle 🟠

**Symptom (Son's question 2026-05-19, chưa repro):**
- User play YouTube ở 1.5x/2x speed (phổ biến với tutorial/podcast)
- Dub không khớp speaker — có thể đi nhanh không kịp, hoặc trễ tăng dần
- User đổi rate liên tục giữa session → mismatch tích lũy

**Đoán nguyên nhân theo từng tier:**

**Realtime + speed up:**
- YT applies `playbackRate` lên `<video>` element → `captureStream` emit audio ở rate đó (YT default pitch-preserving)
- Captured audio → WebRTC → OpenAI Realtime model nhận audio bị tempo-shifted
- **Unknown behavior:** model có thể bị confused, dịch sai, output rỗng, hoặc xử lý OK (cần test thực nghiệm)
- Risk: model train chủ yếu trên 1.0x speech → off-distribution input

**Standard subtitle-first + speed up:**
- `sentence.start`/`end` ở **video-time** (giây trong video), không scale theo `playbackRate`
- `audioOffset = audioCtx.currentTime - video.currentTime` (line 1698) capture **1 lần** tại moment wave 1 done
- Schedule: `at = audioOffset + sentence.start` (line 1792)
- Nếu user đổi rate 1.0 → 1.5x sau khi audioOffset capture:
  - `video.currentTime` tiến 1.5x trong khi `audioCtx.currentTime` tiến 1.0x
  - `at` tính cho sentence index N nằm ở video time T, nhưng video reaches T sớm hơn 1.5x
  - Dub phát trễ vì schedule wall-clock dựa trên offset 1x
- Mỗi giây video qua → dub lệch thêm 0.5s

**Standard chunked + speed up:**
- MediaRecorder records 5s **wall-clock** → captures `5 × rate` giây video content
- 1.5x: 5s wall-clock = 7.5s nội dung → Whisper/Gemini transcribe nhiều hơn → pipeline OK
- TTS output = ~7.5s VI content × 1.6 verbosity = 12s phát
- Nhưng MediaRecorder cycle lại bắt đầu sau 5s wall-clock → chunk N+1 đến lúc chunk N TTS chưa hết → queue dồn nhanh hơn
- 2x: chaos, queue grow ~5s/chunk

**Khó: user thay đổi rate liên tục:**
- Cần listen `ratechange` event trên videoEl
- Mỗi lần change → cancel pending sources → reschedule

**Fix direction (TICKET RIÊNG, không bundle với SF6/SF7):**

**Phase 1 — Warning only (RoundX, dễ):**
- Tại `startSession`: detect `videoEl.playbackRate !== 1.0` → toast `"Echoly works best at 1× speed. Translation may drift at ${rate}× speed."`
- Listen `ratechange` mid-session → toast tương tự
- Log to `tlog()` cho debug
- Không thay đổi pipeline → ship nhanh, set user expectation đúng

**Phase 2 — Subtitle-first rate-aware scheduling (RoundX+1, medium):**
- Thay pre-schedule pattern bằng **poll-based**: every 200ms check `videoEl.currentTime` so với sentence list → find next un-played sentence with `sentence.start <= currentTime + 0.3` → start AudioBufferSource
- Tự động resilient với rate change + seek (đã solve cả 2 cùng lúc)
- Refactor `scheduleWindow` (line 1785) + `runRollingRenderer` (line 1847) sang poll model
- Trade-off: chính xác kém hơn pre-schedule ở rate 1.0 (200ms granularity vs sample-accurate), nhưng người dùng không nghe được khác biệt

**Phase 3 — Realtime model behavior research (RoundX+2, research-gated):**
- Test gpt-realtime-translate với 1.5x audio input → đo output quality
- Nếu OK: support rate ≠ 1.0 cho Realtime as-is
- Nếu degraded: detect rate change, show warning, hoặc force back to 1.0

**Phase 4 (optional) — Chunked rate-aware speed param:**
- Khi user ở 1.5x, set TTS `speed: 1.5` để TTS phát nhanh hơn → match tempo speaker
- Combine với SF7 adaptive speed (queue depth driven) — pick max của 2 yếu tố

**Affected cases:** All 6 TCs nếu user đổi rate
**Linked tickets:** SF7 (chia sẻ `speed` param logic), SF6 (pause logic phải respect ban đầu rate khi resume)

**Task:** #7 (sẽ tạo sau khi Son approve)

---

### SF5 — Cần status sequence rõ ràng cho cả 2 tier (cross-cutting UX)

**Symptom (implicit):** SF1, SF3, SF4 đều có common pain point — user không thấy progress giữa click Start và hear first output. Status hiện chỉ nhảy `Ready → Connecting → Translating`. Khi 5-10s "đứng yên" ở Connecting, user không biết extension chết hay đang xử lý.

**Đề xuất status states:**
- Realtime: `Acquiring audio → Minting key → Negotiating connection → Speaker warming up → Live`
- Subtitle-first: `Loading captions (CC layer) → Translating N lines → Rendering voices → Live`
- Chunked: `Recording first 5s → Transcribing → Translating → Voicing → Live`

Mỗi state có timestamp log để debug latency sau này.

Không phải bug, nhưng nếu không có cái này thì SF1+SF4 cảm giác tệ hơn thực tế.

---

## Verification Recipe (cho phase 2 deepdive)

Trước khi fix bất cứ cái nào ở Son's Feedback, làm chung 1 lần để có baseline:

```js
// Tạm thêm vào content.js đầu IIFE
const DEBUG_TIMINGS = localStorage.echolyDebug === "1";
const T0 = Date.now();
const tlog = (label) => DEBUG_TIMINGS && console.log(`[echoly] +${Date.now() - T0}ms ${label}`);
```

Rồi sprinkle `tlog("mint sent")`, `tlog("mint resp")`, `tlog("first track")`, `tlog("first delta")`, `tlog("first audio play")` ở các điểm critical. Set `localStorage.echolyDebug = "1"`, reload, click Start, đọc console. Có baseline numbers rồi mới quyết định fix path.
