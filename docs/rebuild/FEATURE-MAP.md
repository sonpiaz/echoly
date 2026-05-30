# FEATURE-MAP — file ownership for the contract-locked parallel build

Three build agents, **strictly non-overlapping** file ownership. Two agents must
never edit the same file. The `src/shared/**` contract layer + all config are
LOCKED (read-only for every agent — escalate to the orchestrator to change one).

## Locked (read-only for all build agents)
- `src/shared/{constants,types,protocol,ports,storage}.ts` — the contracts
- `package.json`, `tsconfig.json`, `wxt.config.ts`, `vitest.config.ts`
- `test/setup.ts` — shared `chrome.*` mock
- `.wxt/**`, `legacy/**`, `docs/**`
- Build agents do NOT run `npm install`, `wxt prepare`, or `wxt build` (the
  orchestrator owns those + the integration gate). Agents MAY run
  `npx vitest run <their own spec>` and `npx tsc --noEmit` (read-only).

---

## Agent B — Background service worker
**Owns (create/edit only these):**
- `src/entrypoints/background.ts` (already final glue — keep as-is unless needed)
- `src/background/**` — `index.ts` (initBackground: register listeners synchronously),
  plus `store.ts`, `router.ts`, `auth.ts`, `session-coordinator.ts`, `caption-cache.ts` (your split)
- `src/lib/api-mode.ts` — `resolveApiMode` + the BYOK-wins precedence (the pure part is unit-tested)
- `test/background/**`

**Source of truth:** `legacy/background.js` (port verbatim behavior),
`docs/rebuild/research/01-background-state-messaging.md`.
**Imports from contracts:** `@/shared/protocol` (messages + `isFromContent` + `post`/`relayToContent`),
`@/shared/types` (State/Settings/…), `@/shared/storage`, `@/shared/constants`.
**Hard invariants:** single source of truth `state`; popup = passive renderer;
`ensureContentScript` uses `CONTENT_SCRIPT_PATH` (NOT literal "content.js");
50ms broadcast debounce; `sender.tab` routing; async popup branch returns `true`,
content branch returns `false`; webRequest caption cache verbatim; TRUSTED_CONTEXTS;
all listeners registered synchronously in initBackground (M-a: no dynamic import before registration).

---

## Agent C — UI (overlay + popup), render-only
**Owns (create/edit only these):**
- `src/content/overlay/**` — `overlay.ts` (implements `OverlayView`, exports `createOverlay: CreateOverlay`),
  `template.ts` (the exact innerHTML template + applyLayout inline styles),
  `overlay.css` (REPLACE placeholder with VERBATIM `legacy/content.css`)
- `src/entrypoints/popup/**` — `index.html` (byte-identical legacy/popup.html DOM, same element IDs,
  wired to `./main.ts` + `./style.css`), `main.ts`, `style.css` (VERBATIM `legacy/popup.css`)
- `src/popup/**` — `index.ts` (initPopup: passive renderer; `applyState(state)`; control handlers send
  via `@/shared/protocol`)
- `src/lib/popup-format.ts` — `fmtMin`, `meterLevel`, tier-gating reducers (pure, unit-tested)
- `test/ui/**`

**Source of truth:** `legacy/content.css`, `legacy/popup.{html,css,js}`, the overlay-DOM
parts of `legacy/content.js` (buildOverlay/applyLayout/showToast/history/voice picker),
`docs/rebuild/research/03-ui-surfaces.md`.
**Imports from contracts:** `@/shared/ports` (OverlayView/OverlayCallbacks/OverlayState),
`@/shared/types`, `@/shared/constants` (voices/HISTORY_MAX/RTL_LANGS/LAYOUT_KEY), `@/lib/offline-tier-caps`,
`@/shared/protocol` (popup → bg sends; popup ← BACKGROUND_STATE_UPDATE).
**Hard invariants:** byte-identical DOM + CSS; NO Shadow DOM; NO CSS-module hashing
(`overlay.css` plain); toast built via DOM APIs (never innerHTML); preserve the
overlay-vs-popup "Auto" label difference; all element IDs + `data-*`/`[data-state]`
selectors verbatim; render-only — the `<select>` handlers only call the injected
OverlayCallbacks (the realtime-vs-standard branch lives in Agent D's controller).

---

## Agent D — Content-script logic
**Owns (create/edit only these):**
- `src/entrypoints/content/index.ts` (already final glue — keep; imports overlay css + initContent)
- `src/content/index.ts` — `initContent`: **F9 version-keyed guard as the FIRST statement**,
  bootstrap, the `chrome.runtime.onMessage` listener (CONTENT_PING/START/STOP/UPDATE_SETTINGS/UPDATE_VOLUME)
- `src/content/session-manager.ts` — **module-global `pageToken`** + per-session `AbortController` + timers
- `src/content/capture.ts` — captureStream + F5 retry + Web Audio gain graph + volume drift guard
- `src/content/controller.ts` — implements `OverlayCallbacks` (realtime⇒requestHandover; standard⇒mutate
  settings + notifyBackground(UPDATE_SETTINGS) + setStatusText("Switching to …") + setOverlayState("live"))
- `src/content/pipelines/**` — `realtime.ts` (WebRTC; SDP POST DIRECT to `OPENAI_CALLS_URL`; dual token-guard),
  `standard-chunked.ts` (Gemini understand + MiniMax speech; **guard after EVERY await**),
  `subtitle-first.ts` (default non-live Standard path), `captions.ts` (3-layer acquisition:
  webRequest cache via GET_YT_CC_URL → DOM scrape → plain timedtext; CAPTION_POLL_MS)
- `src/lib/audio.ts` (computeGain, WAV/resample), `src/lib/caption.ts` (pickCaptionTrack,
  parseJson3Events, regroupToSentences), `src/lib/kyma.ts` (parseKymaError) — pure, unit-tested
- `test/content/**`

**Source of truth:** `legacy/content.js` (everything except overlay DOM/CSS),
`docs/rebuild/research/02-content-pipelines.md`.
**Imports from contracts:** `@/shared/constants`, `@/shared/types` (StartSettings/Session/…),
`@/shared/protocol` (content ↔ bg: `post` for CONTENT_STATE/ENDED, `sendFromContent` for GET_YT_CC_URL,
the onMessage handler types), `@/shared/ports` (OverlayView/OverlayCallbacks types),
and the concrete `createOverlay` from `@/content/overlay` (Agent C's export).
**Hard invariants:** F9 first statement, version-keyed, cleans stale `.ec-root`; own lifecycle
(NOT WXT `ctx`); `pageToken` MODULE-GLOBAL, bumped on Stop; dual guard (realtime
`token!==pageToken && session?.token!==token`) vs identity guard (chunked/subtitle `s!==session`) — NOT
interchangeable; guard after every await in `processStandardChunk` (credit-burn protection);
AbortController aborts in-flight fetches on Stop; realtime SDP goes DIRECT to OpenAI (bypasses apiBase);
SESSION_LIMIT/WARNING/HEARTBEAT/CAPTION_POLL timings; handover 400ms prevSession window;
removeOverlay-nulls-root ordering in the no-caption fallback.

---

## Cross-agent seams (the only inter-agent dependencies)
- **C ⇄ D:** D imports `createOverlay` (concrete) from `@/content/overlay` and the
  `OverlayView`/`OverlayCallbacks` types from `@/shared/ports`. C implements them. The
  interface is LOCKED in `src/shared/ports.ts` — neither agent changes it without escalation.
- **B ⇄ C ⇄ D:** all share `@/shared/{protocol,types,constants}` (locked). The message
  protocol + state shape are the integration contract.

## Integration gate (orchestrator, after all three finish)
`npx tsc --noEmit` (0 errors) → `npx vitest run` (green) → `npx wxt build` (CSP-clean
manifest, stable `content-scripts/` paths, M-a SW single-chunk check) → resolve any
interface mismatches against the locked contracts.
