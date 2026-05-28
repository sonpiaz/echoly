# Echoly Test Matrix

**Date:** 2026-05-19 · **Version:** v0.5.2
**Companion to:** [BUGS.md](BUGS.md)

Cách dùng: mỗi case có workflow chi tiết, delay đo được/dự kiến, và **lock status**.
- ✅ **LOCKED** — verified hoạt động end-to-end. Bất cứ commit nào break case này → revert ngay.
- ⚠️ **DEGRADED** — chạy nhưng có known issue. Liệt kê ticket blocker.
- 🔴 **BROKEN** — không dùng được.
- ❓ **UNTESTED** — chưa verify trên video thật.

**Convention số liệu:**
- *Measured* = Son test thực tế hoặc em đo qua DEBUG_TIMINGS
- *Inferred* = em đọc code + dùng known latencies của upstream APIs (Kyma p50, OpenAI Realtime cold-start, MiniMax TTS p50). Cần measure để confirm.

---

## Design Decisions (2026-05-19, Son confirmed)

### Pause policy

Pause khi user click Start nhằm đồng bộ "speaker bắt đầu nói = dub bắt đầu nói". Quyết định cuối cùng:

| Mode × Video | Pause? | Reasoning |
|--------------|--------|-----------|
| **Realtime + non-live** | ✅ YES | Build PC trong ~2-3s (trong gesture window). Tránh user nghe EN trước 5-6s rồi mới có VI. |
| **Realtime + live** | ❌ NO | captureStream cần audio liên tục; pause = silent stream = OpenAI đói. Pause = lùi live edge vĩnh viễn. |
| **Standard + non-live** | ✅ YES | Đã có pause (line 1619); fix wave 1 size để gesture không expire. |
| **Standard + live** | ❌ NO | Live CC là streaming format, snapshot fetch insufficient. Pause = DVR mode mất sync vĩnh viễn. |

**Detection:**
```js
const isLive = !isFinite(videoEl.duration);  // Infinity hoặc NaN
```

### Playback rate handling (SF8)

User speed up video 1.25x/1.5x/2x → pipeline KHÔNG handle hiện tại. Phase plan:
1. **Phase 1**: warn-only toast `Echoly works best at 1× speed`
2. **Phase 2**: subtitle-first chuyển sang poll-based scheduling (resilient rate + seek)
3. **Phase 3**: research Realtime model behavior với non-1.0 audio input

Live + speed up = double untested.

---

## Primary Matrix — 6 cases (3 video types × 2 modes)

### TC-1: YT video **có CC** + **Realtime** tier
**Status:** ⚠️ DEGRADED · **Locked:** ⏳ pending SF1, SF2
**Delay first output:** *measured 5-6s* (Son), target <1.5s

**Workflow (cold start):**
| t | Step | File:line | Inferred latency |
|---|------|-----------|------------------|
| T+0 | User click Start (popup) | popup.js:215 | — |
| T+30ms | Popup → background `START` msg | popup.js:230 | 10-50ms IPC |
| T+50ms | `handleStart` → `ensureContentScript` | background.js:168 | 0-100ms (skip if alive) |
| T+100ms | Content `startSession` → `findVideo` + `captureWithRetry` | content.js:1903, 495 | 100-2000ms (depends on YT play state) |
| T+200-2000ms | `captureStream` returns audio tracks | content.js:503 | bottleneck if video paused |
| T+2000ms | `buildRealtimeSession` mint `client_secrets` POST → Kyma | content.js:593 | 300-800ms |
| T+2500ms | RTCPeerConnection.createOffer + setLocalDescription | content.js:679 | 50-200ms |
| T+2700ms | POST SDP to `api.openai.com/v1/realtime/translations/calls` | content.js:683 | 500-1500ms |
| T+4000ms | ICE candidate gathering + connection | (browser internal) | 300-1000ms |
| T+4500ms | First `track` event → `remoteAudio.srcObject` set | content.js:642 | — |
| T+5500ms | First `delta` from data channel → `setTargetText` | content.js:721 | OpenAI model first-token ~1-2s |
| T+6000ms | First audio frame audible via Web Audio gain | content.js:651 | depends on model |

**CC tồn tại của video KHÔNG ảnh hưởng** Realtime tier — pipeline chỉ dùng audio stream.

**Pause policy:** ✅ pause khi Start, play sau khi PeerConnection `connected` (SF6 sẽ implement).

**Known issues:**
- **SF6** Realtime non-live hiện tại KHÔNG pause → user nghe EN trước 5-6s rồi mới có VI overlap. Sẽ fix.
- **SF1** lag tổng 5-6s vs spec promise <1s. Bottleneck chính: mint + SDP + ICE + model first frame.
- **SF2** Auto voice không giống speaker, đổi giọng giữa câu. Có thể là OpenAI Realtime model limitation, chưa research xong.
- **SF3** Volume sliders không tác động được.
- **SF8** Speed up 1.5x/2x → unknown model behavior, chưa test.

**Lock criteria (cần hết để LOCK):**
1. Pause-then-play hoạt động 100% lần Start (gesture window)
2. P50 first-output < 4s (pause 2-3s + model first-token 1-2s)
3. Volume slider có hiệu lực 100% lần kéo
4. SF2 đã research → hoặc fix được hoặc update copy honest
5. (Out of scope) SF8 playback rate — verify ở phase riêng

---

### TC-2: YT video **có CC** + **Standard** tier (→ subtitle-first path)
**Status:** 🔴 BROKEN auto-play · **Locked:** ⏳ pending SF6, SF3, SF4, SF7, C1, H1
**Delay first output:** *measured 8-10s* (Son), target <5s
**Auto-resume after wave 1:** 🔴 fails silently (Chrome autoplay block — SF6)

**Routing:** `startSession:1894` thấy hostname youtube.com → gọi `startSubtitleFirstSession` thay vì `startStandardSession`.

**Workflow:**
| t | Step | File:line | Inferred latency |
|---|------|-----------|------------------|
| T+0 | User click Start | popup.js:215 | — |
| T+100ms | `startSubtitleFirstSession` → `buildOverlay` + `audioCtx` setup | content.js:1565-1575 | 50-100ms |
| T+150ms | **`video.pause()`** | content.js:1619 | 0ms (synchronous) |
| T+200-2000ms | `fetchYouTubeCaptions` 3-layer | content.js:1365 | depends on Layer hit |
|  | · Layer 1: ask BG cache → trigger YT CC button → poll 1.8s | content.js:1275 | 0-1800ms |
|  | · Layer 2: DOM `ytInitialPlayerResponse` parse | content.js:1316 | 50-200ms |
|  | · Layer 3: plain URL fallback (often 0 bytes today) | content.js:1408 | 200-600ms |
| T+2200ms | `regroupToSentences` | content.js:1467 | <50ms |
| T+2300ms | `translateBatch(0, firstWaveEnd=5)` Gemini chat/completions | content.js:1491 | 1000-2000ms |
| T+3800ms | `renderWaveTTS(0, 5)` — 5 parallel MiniMax `audio/speech` | content.js:1757 | slowest ~1500-2500ms |
| T+6300ms | `scheduleWindow` + `audioOffset` calc | content.js:1785 | <10ms |
| T+6400ms | **`video.play()`** | content.js:1739 | 0ms |
| T+6500-8000ms | First scheduled AudioBufferSource starts (cue.start aligned) | content.js:1796 | depends on first sentence.start |

**Known issues:**
- **SF6** 🔴 Video không tự resume sau wave 1 (Chrome autoplay gesture expired). User phải click play tay → audioOffset stale → dub lệch.
- **SF7** Dub drift cumulative theo time vì TTS VI dài hơn EN source ~1.6x → queue dồn → delay xa dần
- **SF4** Tổng 8-10s lag (chủ yếu Gemini + MiniMax round trips)
- **SF3** Volume slider không tác động
- **H1** Toggle "Show source" → YT caption poll + subtitle-first source ghi đè nhau (flicker)
- **C1** Đổi ngôn ngữ/giọng mid-session từ popup → fail âm thầm (handover gọi sai code path)
- ~~H4~~ → reclassified as SF6 (original analysis was inverted)

**Lock criteria:**
1. P50 first-output < 5s
2. Video tự resume sau wave 1 (100% lần click Start)
3. Sau 30+ phút session, drift dub vs speaker < 3s
4. Volume slider hoạt động
5. Đổi lang/voice từ popup hoạt động (overlay path đã ổn)
6. Source pane không flicker khi toggle showSource

---

### TC-3: YT video **không CC** + **Realtime** tier
**Status:** ⚠️ DEGRADED · **Locked:** ⏳ same blockers as TC-1
**Delay first output:** *inferred 5-6s* (same as TC-1)

**Workflow:** **giống hệt TC-1** — Realtime không dùng CC. Distinguisher: không có pipeline khác.

**Known issues:** giống TC-1 (SF1, SF2, SF3).

**Lock criteria:** giống TC-1.

---

### TC-4: YT video **không CC** + **Standard** tier (→ chunked path)
**Status:** ❓ UNTESTED · **Locked:** ⏳ pending SF3, SF4, SF7, + verification
**Delay first output:** *inferred 7-9s* (Son đã đo "Standard" 8-10s, nhưng đó là subtitle-first; chunked có thể nhỏ hơn hoặc gần bằng)
**Cumulative drift:** 🔴 affected by SF7 (TTS VI dài hơn EN chunk)

**Routing:** `startSubtitleFirstSession` chạy trước, `fetchYouTubeCaptions` return null → falls back `startStandardSession` (`content.js:1632-1654`).

**Workflow:**
| t | Step | File:line | Inferred latency |
|---|------|-----------|------------------|
| T+0 | User click Start | popup.js:215 | — |
| T+100ms | `startSubtitleFirstSession` start | content.js:1557 | — |
| T+200-2000ms | `fetchYouTubeCaptions` exhausts 3 layers → null | content.js:1365-1427 | 1800-3000ms (full timeout) |
| T+2000ms | Subtitle-first teardown + fallback toast "No captions — using live mode" | content.js:1632-1654 | <100ms |
| T+2100ms | `startStandardSession` → `captureWithRetry` | content.js:861, 870 | 200-1000ms |
| T+2400ms | `MediaRecorder` start | content.js:1067 | — |
| T+7400ms | MediaRecorder stop (5s chunk) → blob → `webmToWav` | content.js:1071, 965 | ~30ms transcode |
| T+7500ms | POST `audio/understand` (Vertex Gemini) | content.js:1120 | 1000-2000ms |
| T+9000ms | POST `audio/speech` (MiniMax) | content.js:1151 | 1500-2500ms |
| T+10500ms | First AudioBufferSource starts | content.js:1196 | <50ms |

**Critical observation:** subtitle-first **always runs first** trên youtube.com, ngốn 1.8-3s timeout trước khi fallback. Đối với non-CC video, đó là lag waste. Cần early-detect (check `ytInitialPlayerResponse.captions === undefined` → skip Layer 1 polling).

**Known issues:**
- **SF7** 🟠 Dub drift cumulative cho VI/JA/KO (TTS dài hơn 5s chunk source)
- **SF4** subtitle-first wasted timeout adds ~2s lag trước chunked
- **SF3** Volume slider
- **M3** Layer 1 timeout 1.8s đôi khi không đủ — nhưng ở case này càng nên rút
- **M4** MediaRecorder không dùng timeslice → first chunk delayed 200-300ms

**Lock criteria:**
1. P50 first-output < 7s (acceptable cho chunked-by-design)
2. Sau 30+ phút, drift < 3s
3. Volume slider hoạt động
4. Subtitle-first fallback path quick-detect khi captions không có
5. Verify trên video thật không CC (Son chỉ định 1 video không CC để test)

---

### TC-5: YT **live stream** + **Realtime** tier
**Status:** ❓ UNTESTED · **Locked:** ⏳ chưa test
**Delay first output:** *inferred 3-5s* (có thể nhanh hơn TC-1 vì SF6 sẽ skip pause cho live)

**Pause policy:** ❌ NO pause (Q2 design decision). Skip pause path khi `!isFinite(videoEl.duration)`.

**Workflow:** giống TC-1 nhưng:
- `captureStream` trên live → audio tracks có sẵn ngay (không cần `nudgePlay`)
- `videoEl.duration === Infinity` — SF6 detection sẽ skip pause-then-play orchestration
- `videoEl.ended` không fire → 60-min session timer là cách duy nhất tự stop
- `onYTPause`/`onYTPlay` vẫn hoạt động nếu user pause live tay

**Potential issues:**
- Khi user pause live tay rồi play lại, YT jumps to live edge → captureStream stream có thể glitch một chút → OpenAI có thể tưởng silence
- 60-min hard limit có thể annoying cho live stream dài (event, esports). Spec cố ý.

**Lock criteria:**
1. Test trên 1 live stream tiếng Anh thực tế (vd Apple/Google keynote live, hoặc 1 livestream tiếng Anh phổ biến)
2. Confirm first-output < 5s
3. Confirm session chạy ổn 10+ phút không drop
4. Volume slider hoạt động
5. Verify pause-skip detection đúng (không vô tình pause live)

---

### TC-6: YT **live stream** + **Standard** tier
**Status:** ❓ UNTESTED, **likely BROKEN** · **Locked:** ⏳ cần test rồi quyết
**Delay first output:** unknown

**Vấn đề tiên đoán nghiêm trọng:**

1. **subtitle-first path trên live:**
   - `video.pause()` (line 1619) trên live stream → user rời live edge, lùi về timestamp đang xem
   - `fetchYouTubeCaptions` cho live: captions là realtime-generated, baseUrl có thể dạng streaming endpoint, fetch một lần không return toàn bộ
   - Nếu Layer 1/2/3 đều fail → fallback chunked (~ 2s waste)
   - Nếu Layer 1 catch được URL nhưng chỉ có vài cue (live mới bắt đầu) → wave 1 ngắn, lag ngắn nhưng catch-up sai
   - **Audio sync break**: TTS được schedule dựa trên `audioOffset = audioCtx.currentTime - video.currentTime`. Nếu video bị YT đẩy back live edge sau khi resume, audioOffset sai → dub vang trễ/lệch.

2. **chunked path trên live:**
   - Lý thuyết: MediaRecorder + captureStream hoạt động bình thường
   - 5s recording window OK trên live
   - **Pause-aware skip** (line 1041) sẽ không trigger trên live nếu user không pause → OK

**Recommendation:** force chunked path cho live stream (skip subtitle-first), HOẶC disable Standard tier hoàn toàn cho live, chỉ cho Realtime.

**Pause policy:** ❌ NO pause (Q2). Live + Std nếu support → force chunked, không pause.

**Lock criteria:**
1. Test trên 1 live stream thực
2. Quyết định: support hay không
3. Nếu support: phải có path-routing logic phân biệt `!isFinite(videoEl.duration)` → force chunked, skip subtitle-first
4. Confirm pause-skip không vô tình pause

---

## Secondary Matrix — State Transitions

Áp dụng cho session đang chạy. Mỗi ô = trạng thái hiện tại.

| Action | TC-1 (CC+RT) | TC-2 (CC+Std) | TC-3 (noCC+RT) | TC-4 (noCC+Std) | TC-5 (Live+RT) | TC-6 (Live+Std) |
|--------|--------------|---------------|----------------|------------------|----------------|------------------|
| Pause/Resume video | ✅ silent then resume | ✅ stops scheduling | ✅ same as TC-1 | ✅ recorder skips | ❓ live edge jump | ❓ broken sync |
| Seek forward | ✅ no-op (RT realtime) | ⚠️ `seeked` listener re-schedules | ✅ same | ⚠️ chunk in flight wasted | n/a (live) | n/a (live) |
| Seek backward | ✅ no-op | ⚠️ replays buffered, may miss un-buffered | ✅ same | ⚠️ same | n/a | n/a |
| **Change playback rate** | 🔴 **SF8** unknown model behavior | 🔴 **SF8** drift cumulative | 🔴 **SF8** | 🔴 **SF8** queue chaos at 2x | 🔴 **SF8** | 🔴 **SF8** |
| Change lang from **overlay** | ✅ requestHandover hot-swap ~1.5s | ✅ next-batch swap | ✅ | ✅ | ❓ | ❓ |
| Change lang from **popup** | ✅ ditto overlay (same path) | 🔴 **C1: fail silently** | ✅ | 🔴 **C1** | ❓ | ❓ |
| Change voice from popup | ✅ | 🔴 **C1** | ✅ | 🔴 **C1** | ❓ | ❓ |
| Volume slider | 🔴 **SF3** | 🔴 **SF3** | 🔴 **SF3** | 🔴 **SF3** | 🔴 **SF3** | 🔴 **SF3** |
| Toggle showSource | ✅ shows YT native CC | ⚠️ **H1 flicker** | ✅ | ✅ shows YT native CC | ❓ | ❓ |
| Tab switch (background) | ✅ Web Audio keeps playing | ✅ | ✅ | ✅ | ❓ | ❓ |
| Window minimize | ✅ | ✅ | ✅ | ✅ | ❓ | ❓ |
| Close tab | ✅ keepalive `/end` fire | ✅ no Kyma session to end | ✅ | ✅ | ❓ | ❓ |
| YT autoplay next | ✅ SPA polling stops session | ✅ | ✅ | ✅ | n/a | n/a |
| 60-min auto-stop | ✅ warning at 55 + stop at 60 | ✅ | ✅ | ✅ | ✅ | ✅ |

---

## Suggested Lock Order

Lock từ case có ít blocker nhất:

```
TC-1 (CC + RT)        ← SF1, SF2, SF3   (3 tickets)
TC-3 (noCC + RT)      ← same as TC-1    (0 extra, locks together with TC-1)
TC-2 (CC + Std)       ← SF3, SF4, C1, H1, H4   (5 tickets)
TC-4 (noCC + Std)     ← SF3, SF4, M3 fast-skip   (3 tickets nhưng share SF3+SF4 với TC-2)
TC-5 (Live + RT)      ← test only, no expected fix
TC-6 (Live + Std)     ← decision needed: support or block
```

**Group fix dependencies:**
- **SF6 (auto-play)** 🔴 blocks TC-2/TC-4 hoàn toàn → ưu tiên cao nhất cho Standard tier
- **SF3 (volume)** unlocks 6 cases cùng lúc → fix sớm
- **SF7 (drift)** standalone, fix riêng được, unlock long-session quality
- **SF2 (research)** — chạy subagent song song, không block code
- **C1 + H1 + applySettingsLive cleanup** = 1 commit (cùng vùng code)
- **SF1 + SF4 (latency)** — cần Phase A DEBUG_TIMINGS để có data trước, fix sau

Đề xuất sequence — **một ticket một commit, không bundle** (Son rule):

| Round | Ticket | Touch files | Lock case sau khi xong |
|-------|--------|-------------|------------------------|
| 1 | **SF6** auto-play + pause Realtime non-live | `content.js` (startSession RT branch, startSubtitleFirstSession wave 1 size) | TC-1, TC-3 (Realtime), partial TC-2 |
| 2 | **SF3** volume slider | `content.js` (applyVolumes), maybe `background.js` | Lock volume row in secondary matrix cho 6 cases |
| 3 | **SF7** adaptive TTS speed | `content.js` (processStandardChunk + renderTTSForSentence body) | TC-2, TC-4 long session |
| 4 | **C1** subtitle-first lang/voice handover | `content.js` (applySettingsLive) | TC-2 partial (settings flow) |
| 5 | **H1** source pane flicker | `content.js` (applySettingsLive caption poll guard) | TC-2 partial (source pane) |
| 6 | **Phase A** add DEBUG_TIMINGS — measure baseline | `content.js` (top of IIFE, ~15 tlog points) | — instrumentation only |
| 7 | **SF1** Realtime latency optimizations | depends on Round 6 evidence | TC-1, TC-3 fully |
| 8 | **SF4** Standard latency optimizations | depends on Round 6 evidence | TC-2 fully, partial TC-4 |
| 9 | **TC-4 verify** non-CC test + subtitle-first fast-skip | `content.js` (fetchYouTubeCaptions early exit) | TC-4 |
| 10 | **TC-5 verify** live + Realtime smoke test | mostly manual test + small adjustments | TC-5 |
| 11 | **TC-6 decision** live + Std support? + SF8 Phase 1 warn | `content.js` (live detection routing, rate warning) | TC-6, partial SF8 |
| 12 | **SF8 Phase 2** poll-based subtitle-first scheduling | `content.js` (scheduleWindow → poll loop refactor) | All cases with rate change |
| 13 | **SF2** Realtime voice clone research + copy update | research subagent + `popup.js` copy edit | TC-1, TC-3 SF2 row |

**Rules:**
- 1 ticket = 1 commit. Không bundle khi có chung file.
- Sau mỗi commit: chạy lại đủ 6 TCs (5 phút manual smoke) — confirm no regression
- Lock case → ghi vào "Lock Log" cuối file với commit hash + verified date
- Bất kỳ commit nào break một locked case → revert ngay, không debug-and-patch

---

## Lock Log

Khi case ✅ LOCKED, ghi entry ở đây với commit hash + verification evidence.

| Case | Locked at | Commit | Verified by |
|------|-----------|--------|-------------|
| — | — | — | — |

## In-flight Rounds

| Round | Ticket | Status | Files changed | Commit(s) | Verification needed |
|-------|--------|--------|---------------|-----------|---------------------|
| 1 | SF6 (auto-play + pause RT non-live + wave 1 playhead-relative) | ⏳ awaiting hands-on verification (blocked: Kyma/Railway down 2026-05-19) | `content.js`, `manifest.json` | `8548329`, `ad7ccb5` | Test 3 scenarios: (1) CC video + RT, (2) CC video + Std, (3) live + RT. Each: click Start → confirm video pauses (or stays playing for live), confirm dub starts within ~3s of resume **AND audio actually plays within first 5s of resume**, confirm no "video stuck paused" |
| 2 | SF3 (volume sliders: drift guard + Realtime gain pre-create) | ⏳ awaiting hands-on verification (blocked: Kyma/Railway down) | `content.js`, `manifest.json` | `80e4465` | Test: (1) Original slider during session — drag to 0, confirm video mutes and stays muted (no YT re-apply); (2) Voice slider in first 5s of Realtime session — confirm drag has immediate effect (not silent until first track); (3) Voice slider mid-session both tiers — confirm smooth volume change; (4) After Stop, confirm YT's own slider is responsive again (guard unbound) |
| 3 | SF7 (adaptive TTS speed + concise prompt) | ⏳ awaiting long-session verification (blocked: Kyma/Railway down) | `content.js`, `manifest.json` | `27fe50e` | Test: (1) 20+ min Standard session on VI target — confirm dub stays within ~3s of speaker, doesn't drift further over time; (2) compare against pre-SF7 baseline if memorable; (3) confirm speech doesn't sound rushed in normal flow (most chunks should use speed=1.0); (4) optional: trigger drift > 10s and confirm chunk skip with no crash |
| 4 | SF8 Phase 1 (playback rate warn toast) | ✅ testable offline | `content.js`, `manifest.json` | `72f74f7` | Test offline (no Kyma needed): (1) set YT speed to 1.5× before clicking Start — confirm toast appears within 1s of Start; (2) start at 1× then change to 1.25× via YT speed menu — confirm toast appears; (3) rapidly change rate 1×→1.25×→1.5×→2× — confirm toast doesn't spam (4s debounce); (4) change back to 1× — confirm no toast |
