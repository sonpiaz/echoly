# Research 05 — Build / Packaging / CI · Test Strategy · Behavioral Invariants · Migration Mechanics

**Agent 5 of 5.** Slice: build/packaging/CI, test strategy, acceptance criteria the rebuild must not regress, migration mechanics.
**Baseline:** committed `0.6.3` (working tree at `5c35eb5`). Repo is its own git repo (`sonpiaz/echoly`), plain JS, **no build step today**.
**Read-only on source.** Findings only.

---

## 0. TL;DR for the planner

- **Headline acceptance contract:** the rebuild must reproduce the **6 TEST-MATRIX cases (TC-1…TC-6)** + the **state-transition matrix** (pause/seek/rate/lang-swap/volume/showSource/tab-switch/close/60-min auto-stop) **identically**, preserve the **F1–F9 / SF1–SF8 named behaviors**, and re-emit the exact same **MV3 manifest surface** (permissions, CSP, host_permissions, content-script match/run_at). It must NOT re-introduce the **known-bug regressions catalogued in BUGS.md** (C1, C2, H1–H4, M1–M6, SF3/SF6/SF7/SF8).
- **Recommended test stack:** **Vitest** (matches the server repo's runner; zero new mental model) + a tiny hand-rolled `chrome.*` mock (or `@types/chrome` + `vitest-chrome`/`sinon-chrome` if a dep is acceptable) + **jsdom** environment for DOM-touching pure fns. Characterization (golden) tests on the extracted pure functions PROVE "new == old". Real YouTube capture / WebRTC / MediaRecorder stay **manual** against a 5-point smoke checklist mapped to TC-1…TC-6.
- **Build target:** Vite + `@crxjs/vite-plugin` (Agent 4's call) must emit a `dist/` that is a drop-in for today's flat folder: `dist/manifest.json` + bundled `service-worker` + `content` + `popup.html/js` + `content.css`/`popup.css` + `icons/`. `pack.sh` then zips `dist/` instead of repo root. **CSP `script-src 'self'` forbids inline scripts and `eval`** — the bundler MUST be configured for IIFE/ES-module output with **no inline runtime, no eval, no dynamic `new Function`** (rules out default Vite dev-HMR injection in the packaged artifact).
- **Migration:** `git mv` the four source files into `legacy/` in one commit (history-preserving), scaffold `src/` + `vite.config`, port behavior, gate on `tsc --noEmit` + `vitest` + the manual smoke checklist, then delete `legacy/` only after the smoke checklist passes on a loaded-unpacked build.

---

## 1. Current build / packaging mechanics

### 1.1 How a zip is produced today (no build step)
`pack.sh` zips the **repo root directly** — there is no transform, no bundle:
```
VERSION=$(node -p "require('./manifest.json').version")   # filename auto-tracks bump
OUT=$HOME/echoly-v${VERSION}.zip
zip -rq "$OUT" .  -x "*.DS_Store" "node_modules/*" ".git/*" "*.swp" "Thumbs.db" "pack.sh"
```
- Output: `~/echoly-v<version>.zip`, version read from `manifest.json`.
- Exclusions are **denylist-based** (`.git`, `node_modules`, OS cruft, `pack.sh`). **Everything else ships** — including `BUGS.md`, `TEST-MATRIX.md`, `SPEC-SUBSCRIPTION.md`, `README.md`, `docs/`, `store-assets/`, `LICENSE`. (i.e. the current store zip carries dev docs — a pre-existing wart the rebuild can fix by zipping `dist/` only.)
- `.gitignore`: `.DS_Store`, `node_modules/`, `*.swp`, `Thumbs.db`, `*.zip`, `store-assets/_*`.

### 1.2 `release.sh` — the version contract (LOAD-BEARING)
`release.sh <patch|minor|major|x.y.z>` does the full ritual: bump → pack → diff → confirm → commit → tag → push → `gh release create`. Critically it **updates two files in lock-step**:
```
manifest.json   .version
content.js      const ECHOLY_VERSION = "x.y.z";    (regex replace)
```
> **Known drift to fix during rebuild:** committed `content.js` has `ECHOLY_VERSION = "0.6.1"` while `manifest.json` is `0.6.3` (release.sh's regex was evidently skipped on the 0.6.2/0.6.3 hand-edits). The uncommitted server-repoint patch already corrects this to `0.6.3`. **In the rebuild, version must come from ONE source** — `manifest.json` (or a generated constant injected at build, e.g. Vite `define` / reading `package.json`). This kills the lock-step regex hack entirely and removes a whole class of release bug. F9's idempotent version guard depends on this value, so it must be a build-time constant, not hand-typed.

### 1.3 What the new Vite build must emit (pack-equivalent `dist/`)
A `dist/` that is structurally a valid unpacked MV3 extension:
```
dist/
  manifest.json          # GENERATED (see §1.4) — same fields as §2
  service-worker.js       (or background.js) — bundled, type:module
  content.js              — bundled IIFE (single injected file; see §4 ownership note)
  popup.html             — references bundled popup js/css with hashed or fixed names
  popup.js / popup.css
  content.css
  icons/icon-{16,32,48,128}.png
```
`store-assets/` and `icons/` are **inputs**, not build outputs. `icons/` MUST be copied into `dist/` (referenced by manifest `icons` + `action.default_icon`). `store-assets/` (promo tiles, screenshots, web-store-metadata.md, privacy-policy.html) are **Web-Store console uploads, NOT part of the extension zip** — exclude from `dist/`. `docs/` is dev-only — exclude.

`pack.sh` rewrite (minimal): change `cd "$(dirname "$0")"` packing of `.` to `npm run build && cd dist && zip -rq "$OUT" .`. Version still read from `manifest.json` (now the generated one in `dist/`, or the source manifest stub). `release.sh` loses its `content.js ECHOLY_VERSION` regex step.

### 1.4 manifest generation
Today `manifest.json` is hand-maintained. With `@crxjs/vite-plugin` the manifest becomes an **input** (`manifest.config.{js,ts}` or `manifest.json` imported into `vite.config`) and crxjs **rewrites the asset paths** (hashed bundles, HMR wiring stripped in build mode) into the emitted `dist/manifest.json`. The planner must confirm Agent 4's plugin choice **emits a build-mode manifest with no `use_dynamic_url`/inline-script CSP relaxations** (crxjs's dev manifest injects a localhost script for HMR — that is dev-only and must not leak into the packaged zip).

---

## 2. Permissions / CSP / host_permissions surface (must be preserved verbatim)

From `manifest.json` (v0.6.3):

| Field | Value | Load-bearing? Why |
|---|---|---|
| `manifest_version` | 3 | required |
| `minimum_chrome_version` | `"116"` | `chrome.storage.setAccessLevel({TRUSTED_CONTEXTS})` (bg:187) + MV3 features need it. Keep. |
| `permissions` | `activeTab`, `scripting`, `storage`, `webRequest`, `cookies` | **All load-bearing — keep every one.** `scripting` = `ensureContentScript` injection (bg:235); `webRequest` = YouTube `/api/timedtext` URL cache (bg:33-63, the F3 caption Layer-1 source); `cookies` = read HttpOnly `ec_session` cookie for proxy auth (bg:85, sign-out removal bg:469); `storage` = settings persistence + `TRUSTED_CONTEXTS` lock; `activeTab` = active YT tab resolution. |
| `content_security_policy.extension_pages` | `script-src 'self'; object-src 'none'` | **Hard constraint on the bundler.** No inline `<script>`, no `eval`, no `new Function`, no remote script. popup.html must load popup.js via `<script src>` (it already does). Bundler output must be plain `'self'`-served files. |
| `host_permissions` | `https://*.youtube.com/*`, `https://youtube.com/*`, `https://api.kymaapi.com/*`, `https://api.openai.com/*`, `https://api.echolyhq.com/*`, `https://echolyhq.com/*` | youtube = capture + caption fetch; kymaapi = BYOK + (legacy) proxy chain; **openai = client-direct WebRTC SDP POST (`OPENAI_CALLS_URL`, content:24)**; echolyhq = proxy + auth/usage/sign-out. **See migration note below.** |
| `icons` / `action` | 16/32/48/128 + popup.html | keep; icons must be copied to `dist/`. |
| `background` | `service_worker: background.js`, `type: module` | bg is an ES module today (`type: module`) → bundler must emit ESM SW or crxjs handles it. |
| `content_scripts` | match `*.youtube.com` + `youtube.com`, `js:[content.js]`, `css:[content.css]`, `run_at: document_idle` | **Match patterns + `document_idle` are behavioral — keep exact.** Single content file (see §4). |

> **Migration-aware manifest note (do NOT silently regress, but track the target):** the uncommitted `docs/rebuild/uncommitted-server-repoint.patch` (the in-progress server re-point) **removes `https://api.openai.com/*`** from host_permissions (SDP no longer sent client-direct; the Echoly media plane relays OpenAI server-side per UNIFIED-AUDIO-API §5.1) and points `ECHOLY_PROXY_BASE` at `https://api.echolyhq.com/v1` (was `/v1/proxy`). BUGS L6 also flagged `api.openai.com` as unconditionally requested. **Decision for the rebuild scope:** the wave preserves **committed 0.6.3** behavior, so the rebuild's generated manifest should keep all six host_permissions **as committed** unless the planner explicitly folds in the server-repoint (a separate concern owned elsewhere in this wave). Flag this as a cross-slice question (§6).

---

## 3. Behavioral invariants & acceptance criteria (the regression contract)

Mined from README.md, content.js section headers, TEST-MATRIX.md, BUGS.md, SPEC-SUBSCRIPTION.md. **Priority: P0 = must work identically or the product is broken; P1 = visible-quality; P2 = edge.**

### 3.1 Architecture invariants (CLAUDE.md + README "How it works") — P0
- **Background is the single source of truth for `state`.** Popup is a passive renderer (never reads `chrome.storage` to decide running state). Content owns the WebRTC PeerConnection / capture lifecycle.
- **Message protocol (must be byte-identical — the three-process seam):**
  - popup→bg: `GET_STATE`, `GET_AUTH`, `START`, `STOP`, `UPDATE_SETTINGS`, `UPDATE_VOLUME`, `SIGN_OUT_ECHOLY`
  - bg→popup: `BACKGROUND_STATE_UPDATE` (debounced 50 ms)
  - bg→content: `CONTENT_PING`, `CONTENT_START`, `CONTENT_STOP`, `CONTENT_UPDATE_SETTINGS`, `CONTENT_UPDATE_VOLUME`, `GET_YT_CC_URL` (reply)
  - content→bg: `CONTENT_STATE`, `CONTENT_ENDED`, `GET_YT_CC_URL` (request)
  - Any rename here breaks the wiring — characterization-test the dispatcher (see §4).
- **`ensureContentScript(tabId)`** must inject content+CSS via `chrome.scripting` so Start works without a page refresh (bg:228-249).
- **`chrome.storage.local.setAccessLevel({TRUSTED_CONTEXTS})`** must run so rogue YouTube page scripts can't read the Kyma key (bg:187).
- **State cold-starts clean** on SW restart (in-memory `state`, intentional).

### 3.2 The two named-feature layers — P0 (every F and SF must survive)
content.js is explicitly "Layered: F9 version guard, F6 token-guarded async, F5 captureStream retry, F1 overlay panel, F2 history, F3 source captions, F4 handover." Plus Son's SF series.

| ID | Behavior | Must preserve |
|---|---|---|
| **F1** | Draggable/resizable overlay panel, layout persisted (`echolyOverlayLayout`) | drag move + edge/corner resize; `clampLayout` keeps it on-screen |
| **F2** | Translation history, last **16** turns, scrollable (`HISTORY_MAX=16`) | ring-buffer cap |
| **F3** | Source caption rendering toggle (`showSource`), 350 ms poll (`CAPTION_POLL_MS`) | shows YT native CC; 3-layer caption fetch (intercept→DOM→plain URL) |
| **F4** | Voice/language handover zero-gap; Realtime hot-swap <1s, Standard next-batch | `requestHandover` no-op short-circuit when settings unchanged |
| **F5** | `captureStream` re-acquisition with playback nudge; live (`duration===Infinity`) handling | retry loop (cap 2 post-SF6) |
| **F6** | **`pageToken` captured-in-closure guard** — stale async callbacks check token before mutating state | the core correctness pattern |
| **F9** | Idempotent version guard (`window.__echolyContentVersion === ECHOLY_VERSION → return`); removes stale `.ec-root` UI first | prevents double-install on re-inject |
| **SF3** | Original-volume drift guard (hook `volumechange`, snap back); Realtime gain pre-create | volume slider behavior, both tiers |
| **SF6** | Auto-play / pause-Realtime-non-live: pause non-live before capture, keep live playing | gesture-window logic (TEST-MATRIX pause policy) |
| **SF7** | Adaptive TTS speed + concise prompt to bound TTS-vs-source drift on long sessions | speed=1.0 normal, speed-up on drift, skip chunk if drift >threshold |
| **SF8** | Playback-rate awareness — warn toast on rate change, 4s debounce (Phase 1 shipped) | toast on start-at-≠1× and on change; no spam |
| — | **`AbortController` per Standard session** — Stop cancels in-flight fetches so credits aren't burned | P0 anti-cost-burn |
| — | **60-min hard auto-stop** (`SESSION_LIMIT_MS`) + one-shot **55-min warning** (`SESSION_WARNING_MS`) | exact thresholds |
| — | **Heartbeat 30s** (`HEARTBEAT_MS`) to keep Kyma session alive | |
| — | **Tab-close cleanup** via keepalive POST (`/end`) so provider sees session end | bg:504 `onRemoved` |
| — | **Voice gain up to 2×** (`VOICE_GAIN_MAX=2.0`, unity at slider 50) — `computeGain` | exact curve |

### 3.3 Pipeline & data invariants — P0
- **13 target languages** (exact list/order, content:34-40): en, vi, ja, ko, zh, fr, es, de, pt, hi, id, it, ru. `LANG_NAME` lookup, RTL set `{ar,fa,he,ur}`.
- **9 Realtime voices** (`marin, alloy, ash, ballad, coral, echo, sage, shimmer, verse`); default `marin`.
- **5 Standard voices** (exact MiniMax IDs, content:48-54); default `English_magnetic_voiced_man`.
- **Standard pipeline tunables:** chunk 5000 ms (`STANDARD_CHUNK_MS`), min-chunk-bytes 2000 (silence cutoff), recorder MIME preference order (`STANDARD_RECORDER_MIMES`).
- **Standard chunked path:** MediaRecorder → `webmBlobToWav`/`audioBufferToWavBlob`/`downmixAndResample` → Whisper/Gemini `audio/understand` → MiniMax `audio/speech` → Web-Audio back-to-back scheduling. Subtitle-first path: 3-layer caption fetch → `regroupToSentences` → `batchTranslateSubtitles` → `renderWaveTTS` → `scheduleWindow`.
- **Realtime path:** mint ephemeral token → `RTCPeerConnection` → POST SDP to `OPENAI_CALLS_URL` (client-direct, committed behavior) → data-channel transcript deltas → Web-Audio gain.
- **API-mode resolution (BYOK vs proxy):** **BYOK (Kyma key present) always wins** even when signed in (`resolveApiMode` bg:153; `refreshAuth` bg:129). `apiMode ∈ {byok, proxy, null}`. Proxy uses `ec_session` cookie as Bearer. content.js stays agnostic — same fetch shape, different `apiBase`+bearer injected via settings.
- **DEFAULT_SETTINGS** (bg:9): tier `realtime`, lang `vi`, realtimeVoice `marin`, standardVoice `English_magnetic_voiced_man`, originalVolume 18, voiceVolume 100, showSource false, kymaKey "". **Must match exactly** — defaults are user-visible.

### 3.4 Popup / tier / billing UI invariants — P0
- **Tier caps (popup:189, must equal SPEC §3.2):** `free {std:30, rt:0}`, `pro {std:600, rt:0}`, `max {std:3000, rt:120}` (minutes). Usage meters: Standard always shown for signed-in; Realtime meter Max-only (`rt>0`). `meterLevel`: ≥1.0 danger, ≥0.9 warning, else ok.
- **Tier gating:** Realtime option enabled only if BYOK **or** `user.tier === 'max'`; otherwise grayed `(Max only)` and auto-flip to Standard (`applyTierGating`).
- **Key badge** (`setKeyBadge`): empty=`missing`, starts `ky`/`kyma-`=`saved`(ok), else=`check`(warn).
- **Ready logic:** v0.6.2/0.6.3 — Ready when **EITHER** BYOK key **OR** signed-in `ec_session`. Free signed-in users can Start without a key (the 0.6.3 commit headline).
- **`nextResetLabel`** = first of next month (UTC) for "Resets …" hint. **`fmtMin`** rounds + `toLocaleString('en-US')`.
- **Voice key partitioning** (`readSettings`): writes only `standardVoice` OR `realtimeVoice` for the active tier, so the other tier's pick survives a toggle round-trip (this is the C-class bug avoidance).
- **Status/button states:** connecting / paused / running (`Translating to <lang>.`) / error / idle. `is-live` class on Stop.

### 3.5 Known-bug regressions to NOT re-introduce — P0/P1 (BUGS.md)
The rebuild is a behavior-preserving port; do not resurrect these (several are FIXED in 0.6.3, some are still OPEN — preserve the *fixed* state, and don't make OPEN ones worse):
- **C1** — changing lang/voice during subtitle-first session fails silently (`applySettingsLive`). Don't regress the handover wiring.
- **C2** — typing Kyma key wiped when volume slider changes state (popup state-clobber). Preserve the input-vs-state guard (`kymaKeyInput.value !== state.kymaKey`).
- **H1** — source-caption pane flicker (two writers, same node). Single-writer caption guard.
- **H2** — Standard chunk pipeline silently swallows TTS/network errors. Keep error surfacing.
- **H3** — `pageToken` permanently bumped on failed handover. Token discipline (relates F6).
- **H4** → corrected to **SF6** (autoplay-policy gesture revocation). Keep SF6 pause-policy.
- **M1** `state.tabId` race; **M2** unbounded `pendingSources`; **M3** 1800 ms CC timeout; **M4** MediaRecorder timeslice; **M5** double-stop (bg+content both watch SPA URL change); **M6** non-JSON Kyma error parse.
- **SF1/SF4** latency; **SF3** volume; **SF7** drift; **SF8** rate. The TEST-MATRIX "In-flight Rounds" + "Lock Log" are the authoritative status of which of these are verified vs blocked (Kyma/Railway was down 2026-05-19, so many remained "awaiting hands-on verification"). The rebuild should not claim a behavior is locked that the matrix lists as unverified.

### 3.6 SPEC-SUBSCRIPTION billing/UX contracts the popup must respect — P1
- 3 tiers Free/Pro/Max (no Ultra). FUP **hard-block at 100%** (no overage, no auto-top-up). BYOK Kyma free forever.
- Session max **60 min** all tiers (matches `SESSION_LIMIT_MS`).
- Hard-block UX (§3.3): <90% normal · 90% → email warning + **extension overlay banner** w/ "View usage" link · 100% → block + upgrade modal (buttons: Upgrade to Max / Use Kyma key / Cancel; `upgrade_url: https://echolyhq.com/upgrade`). Free-tier modal: "Upgrade to Pro — $9/mo or $89/yr". (Banner/modal are rendered inside the on-page panel.) The extension must handle the server's `insufficient`-style payloads → modal. (Note: this overlay-banner/modal flow may be partly aspirational vs shipped 0.6.3 — verify against current content.js error handling; `parseKymaError` is the shipped surface.)

---

## 4. Test strategy for the rebuilt extension

### 4.1 What's tested today
**Nothing automated.** Gate today is `node --check {content,background,popup}.js` (syntax-only, README PR checklist) + **manual smoke** via TEST-MATRIX.md (6 TCs + state matrix), executed by hand on real YouTube. No package.json, no test runner, no CI. (All three files `node --check` clean today; node v22.)

### 4.2 Recommended automated stack
- **Vitest** — same runner as `server/` (consistency, zero new tooling), fast, native ESM/TS.
- **Environments:** `node` for I/O-free pure logic; **`jsdom`** (or `happy-dom`) for DOM-touching fns (overlay clamp, caption parsing, popup render reducers).
- **`chrome.*` mock:** a small hand-rolled `test/mocks/chrome.ts` (`vi.fn()` stubs for `runtime.sendMessage/onMessage`, `storage.local.get/set`, `tabs.query/sendMessage`, `scripting.executeScript`, `cookies.get/remove`, `webRequest.onCompleted`) is enough and keeps deps minimal. If a dep is acceptable, `sinon-chrome`/`vitest-chrome` + `@types/chrome`. Inject via Vitest `setupFiles` (`globalThis.chrome = mockChrome`).
- **Web-Audio / MediaRecorder / RTCPeerConnection:** **not** mockable meaningfully → those stay manual. Test the *pure transforms around them* (PCM/WAV math, gain curve, chunk-size gating) instead.

### 4.3 How we PROVE "new == old" — characterization (golden) tests on extracted pure fns
Before porting, extract these from the legacy single-file source into pure modules, then **capture their current outputs as golden fixtures from the legacy code** (run legacy fn against a corpus, snapshot results), and assert the rebuilt fn reproduces them.

| Pure/extractable fn | File:line (legacy) | Test type | Why it proves parity |
|---|---|---|---|
| `parseKymaError(status, errText)` | content:544 | unit (table) | error→user-message mapping (insufficient_balance/too_many_sessions/upstream/rate_limited/fallback) is user-visible contract; M6 (non-JSON) edge |
| `pickCaptionTrack(tracks, targetLang)` | content:1528 | unit (table) | scoring (target+100/en+50/manual+10) decides which CC is dubbed — deterministic, golden-able |
| `parseJson3Events(events)` | content:1610 | unit (fixtures) | YT json3 → caption objects; feed real json3 sample |
| `regroupToSentences(captions)` | content:1647 | unit (fixtures) | sentence grouping drives translation batches |
| `computeGain(voiceVolume)` | content:831 | unit (table) | 0→0, 50→1.0, 100→2.0 curve; user-audible |
| `downmixAndResample(audioBuf, rate)` / `audioBufferToWavBlob` | content:1158/1134 | unit (math) | PCM math; assert sample counts/header bytes on synthetic buffers (no real audio) |
| `pickRecorderMime()` | content:1103 | unit | MIME preference order given a fake `MediaRecorder.isTypeSupported` |
| `clampLayout()` | content:152 | jsdom unit | overlay stays on-screen for given viewport+layout |
| **popup reducers** `fmtMin`, `meterLevel`, `nextResetLabel`, `renderTierBadge`, tier-cap table, `applyTierGating` logic, `readSettings` voice-partition | popup:132-326 | unit (table) | billing/tier UI math — high regression risk (C2-class), easy to golden |
| **bg** `resolveApiMode` / `refreshAuth` apiMode decision (byok>proxy>null) | bg:129-166 | unit w/ chrome+fetch mock | the BYOK-wins invariant |
| **message dispatcher** (bg `onMessage` switch, content `onMessage` switch) | bg:426 / content:2380 | unit w/ chrome mock | every message type routes correctly; protocol can't drift |
| **F6 token guard** + **F9 version guard** + **AbortController-on-Stop** | content | unit (state machine) | extract the guard predicate as a pure fn and assert stale-token callbacks are rejected |

**Test-plan table — coverage tiers:**

| Layer | Mechanism | Coverage target | CI? |
|---|---|---|---|
| Pure logic (the table above) | Vitest unit + golden fixtures | ~all extracted fns | yes (fast, deterministic) |
| Message protocol / state reducers | Vitest + chrome mock | all message types, apiMode, tier-gating, default-settings round-trip | yes |
| DOM render (popup states, overlay) | Vitest + jsdom | status/button states, meters, overlay clamp/drag math | yes |
| `tsc --noEmit` | hard gate | 0 errors (matches server convention) | yes |
| `node --check` parity / build smoke | `vite build` succeeds + `dist/manifest.json` valid | build emits loadable dist | yes |
| **Real capture / WebRTC / MediaRecorder / live YouTube** | **manual** smoke checklist (§4.4) | TC-1…TC-6 + state matrix | **no — manual** |

### 4.4 Manual smoke checklist (maps 1:1 to TEST-MATRIX, the "new==old" UI proof)
Run on a freshly reloaded unpacked `dist/`, on a real account/key (or Kyma when up):
1. **TC-1** CC video + Realtime → Start, dub audible within ~5s, transcript renders, lang shown in popup status.
2. **TC-2** CC video + Standard (subtitle-first) → video pauses for wave-1, plays, dub schedules aligned.
3. **TC-4** no-CC + Standard → caption fetch exhausts → "No captions — using live mode" toast → chunked path produces audio.
4. **TC-5** live stream + Realtime → no pause (live edge), dub starts.
5. **State matrix spot-checks:** pause/resume; change lang from **overlay** AND from **popup** (C1 area); volume sliders both tiers (SF3); toggle showSource (H1); set playback rate ≠1× → toast (SF8, offline-testable); close tab → keepalive `/end`; let 55-min warning + 60-min auto-stop fire (or shorten constants in a debug build to verify).

Agent 3 (UI fidelity) owns the popup/overlay visual diff; this checklist is the *behavioral* counterpart they should co-own.

---

## 5. Migration mechanics

The extension is its own git repo (`sonpiaz/echoly`); commit here only. Feature-wave convention (CLAUDE.md §4): **archive old code into `legacy/` before rewriting.**

**Step list:**
1. **Branch.** `main` is the default; per house rule, branch first (e.g. `rebuild/vite-ts`). Note: committed tree is at `0.6.3`; there are uncommitted in-tree changes elsewhere (`extension/ main` per CLAUDE.md "State of play"), but this wave's baseline is the committed 0.6.3 — confirm the working tree is clean of the server-repoint edits before starting, or stash them (the patch is preserved at `docs/rebuild/uncommitted-server-repoint.patch`).
2. **Archive (history-preserving):** one commit — `git mv content.js background.js popup.js popup.html content.css popup.css legacy/`. `git mv` keeps blame/history. Keep `legacy/` runnable as the reference oracle for golden-fixture capture (§4.3) until cutover.
3. **Scaffold tooling:** add `package.json`, `vite.config.{ts}`, `tsconfig.json`, `@crxjs/vite-plugin` (Agent 4's call), `manifest.config.ts` (or import `manifest.json`), Vitest config + `test/setup` chrome mock. `.gitignore` add `dist/`, `node_modules/`, keep `*.zip`.
4. **Lock shared contracts first** (feature-wave §4): the message-type union, settings shape, state shape, port interfaces — so parallel build agents own non-overlapping files. This slice's contribution: the **message protocol enum** (§3.1) and **DEFAULT_SETTINGS/state shape** (§3.3) are the contract surface.
5. **Capture golden fixtures** from `legacy/` for every pure fn in §4.3 (run legacy fn → snapshot).
6. **Port** into `src/` modules (Agents 1-3 territory: SW, content pipeline, popup UI). Each ported pure fn must pass its golden test.
7. **Gate after each integration:** `tsc --noEmit` (0 errors) + `vitest run` green + `vite build` emits a valid `dist/`.
8. **Build artifact = `dist/`.** Confirm `dist/manifest.json` is **generated** (crxjs), carries the §2 surface verbatim, references bundled files, **no dev-HMR script / no CSP relaxation**. Load `dist/` unpacked.
9. **Manual smoke** (§4.4) on loaded `dist/`. Only when the smoke checklist passes (UI + behavior == legacy) →
10. **Cut over:** repoint `pack.sh` to zip `dist/`; update `release.sh` to drop the `content.js ECHOLY_VERSION` regex (version now single-sourced from manifest/package.json); **delete `legacy/`** in a final commit. Bump version via `release.sh` as usual.
11. **CI (optional but recommended):** add `.github/workflows/ci.yml` → `npm ci && tsc --noEmit && vitest run && vite build`. No CI exists today; this is greenfield and cheap.

**Dist output path:** `extension/dist/` (Vite default `outDir`). `pack.sh` zips its contents (not the folder) so the zip root is the manifest, identical to today's flat-zip layout.

---

## 6. Risks & open questions + cross-slice flags

**Risks:**
- **R1 — CSP `script-src 'self'`** is the single biggest bundler constraint. Default Vite *dev* mode injects inline/HMR scripts that violate it; the *build* output must be CSP-clean. crxjs handles this in build mode but **must be verified in the emitted `dist/manifest.json`** (no `localhost` script, no `'unsafe-inline'`/`'unsafe-eval'`). **Hard gate before any cutover.**
- **R2 — Content script must stay a single injected file.** Background injects `content.js` via `chrome.scripting.executeScript({files:['content.js']})` (bg:235) AND the manifest declares it as a content_script. Vite naturally code-splits → if `content.js` imports chunks, dynamic-import/chunk loading inside a content script needs `web_accessible_resources` and a single-IIFE output. **crxjs supports content-script bundling, but the build must emit ONE self-contained content file** (IIFE, inlined deps) or both injection paths break. Coordinate with Agent 4.
- **R3 — Version single-sourcing.** The 0.6.1/0.6.3 drift proves the lock-step regex is fragile. Rebuild MUST inject `ECHOLY_VERSION` at build time from one source; F9's guard depends on it.
- **R4 — Behaviors the TEST-MATRIX lists as UNVERIFIED** (SF1/SF3/SF6/SF7 "awaiting hands-on verification", Kyma/Railway down 2026-05-19). The rebuild can only *preserve the code*, not prove the runtime behavior, for those. Manual smoke is the only proof and depends on a live provider/account.
- **R5 — Web-Audio/WebRTC/MediaRecorder unmockable** → real parity proof is manual only. Mitigate by maximizing pure-fn extraction so the *math* is unit-covered.
- **R6 — `store-assets/` accidentally shipped today.** Rebuild's `dist/`-only zip fixes this but means the Web-Store privacy-policy/screenshots upload path is now separate from the zip — document it in `release.sh`/README so it's not forgotten.

**Open questions for convergence:**
- **Q1 (manifest scope):** does this wave preserve **committed 0.6.3** host_permissions verbatim (keep `api.openai.com`, `ECHOLY_PROXY_BASE=/v1/proxy`), or fold in the uncommitted server-repoint (drop `api.openai.com`, `/v1`)? Recommendation: **preserve 0.6.3** and treat the server-repoint as a separate follow-up, since the wave's stated goal is "100% of current 0.6.3 behavior." Needs human/checkpoint decision.
- **Q2:** add GitHub Actions CI, or keep gates local-only? (Recommend minimal CI — it's free here.)
- **Q3:** the SPEC overlay-banner/upgrade-modal FUP flow (§3.6) — is it actually shipped in 0.6.3 content.js, or aspirational? If aspirational, don't build it (preserve current `parseKymaError` surface); if shipped, port it. Needs a content.js error-path audit (Agent 2's pipeline slice should confirm).

**Cross-slice flags:**
- **→ Agent 4 (tooling):** your bundler choice MUST (a) emit a CSP-clean build-mode `dist/manifest.json` (no inline/HMR/eval), (b) emit a **single self-contained content.js** (IIFE, inlined deps) usable by *both* the declared content_script *and* `chrome.scripting.executeScript`, (c) copy `icons/` into `dist/`, (d) leave `store-assets/`+`docs/` out of `dist/`, (e) single-source the version. `pack.sh` will zip `dist/` contents.
- **→ Agent 3 (UI fidelity):** the §4.4 manual smoke checklist is your behavioral acceptance counterpart — co-own it. Popup states (connecting/paused/running/error/idle), tier badges, usage meters, tier gating, and the overlay drag/resize+persist are the visual contracts; the popup reducers in §4.3 are unit-testable so lean on those for non-visual parity.
- **→ Agent 1/2 (SW + content pipeline):** the message protocol (§3.1), DEFAULT_SETTINGS/state shape (§3.3), and apiMode/BYOK-wins logic (§3.3) are the locked contracts; extract the pure fns in §4.3 as the parity oracle. Preserve every F/SF behavior and the AbortController/60-min/heartbeat invariants. Confirm the FUP-modal question (Q3).
- **→ Convergence/planner:** resolve Q1 (manifest scope) at the human checkpoint before any destructive `git mv`/delete.

---

### Appendix — file inventory (baseline 0.6.3)
- Source: `content.js` (95.9 KB / 2406 ln), `background.js` (17.7 KB / 517 ln), `popup.js` (16.5 KB / 455 ln), `popup.html` (5.2 KB), `content.css` (8.7 KB), `popup.css` (14 KB), `manifest.json` (1.4 KB).
- Build: `pack.sh`, `release.sh`, `.gitignore`.
- Assets: `icons/{16,32,48,128}.png` + `brand.svg`; `store-assets/` (promo tiles, screenshots, web-store-metadata.md, privacy-policy.html) — **Web-Store uploads, not zip contents**.
- Docs (dev-only, currently shipped in zip — exclude in rebuild): `README.md`, `BUGS.md` (35 KB), `TEST-MATRIX.md` (20 KB), `SPEC-SUBSCRIPTION.md` (66 KB), `LICENSE`, `docs/`.
- In-progress: `docs/rebuild/uncommitted-server-repoint.patch` (the server re-point — touches background.js/content.js/manifest.json; relevant to Q1).
- Tooling today: **none** (no package.json/runner/CI). Node v22 available.
