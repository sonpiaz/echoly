# Echoly — Live YouTube Translation (Chrome MV3 extension)

Hear any YouTube video in your language. Live AI dubbing with a draggable in-page
overlay. Two tiers: **Realtime** (low-latency WebRTC) and **Standard** (chunked
STT→translate→TTS / subtitle-first). Free tier or bring-your-own **Kyma** key.

> **Rebuild in progress (branch `rebuild/ts-wxt`).** The extension was ported
> from plain-JS single files to a modular **TypeScript + [WXT](https://wxt.dev)**
> (Vite) codebase, **preserving 100% of 0.6.3 behavior and UI**. Wiring to the
> new Echoly server (and removing BYOK/Kyma) is a separate, later wave. The
> original 0.6.3 sources are archived verbatim in [`legacy/`](./legacy/).

## Develop

```bash
npm install            # also runs `wxt prepare` (generates .wxt types)
npm run dev            # WXT dev server → loads chrome-mv3 with HMR
npm run build          # production build → .output/chrome-mv3/
npm run zip            # package a store/sideload zip (replaces the old pack.sh)
npm run typecheck      # wxt prepare && tsc --noEmit  (the gate — keep at 0 errors)
npm test               # vitest run
npm run test:watch     # vitest watch
```

**Load unpacked:** `npm run build`, then in `chrome://extensions` (Developer mode)
→ **Load unpacked** → select `.output/chrome-mv3/`. Reload after rebuilds.
`minimum_chrome_version: 116`.

## Architecture

Three surfaces (service worker / content script / popup), one locked contract
layer, pure logic split out for testing.

```
src/
  shared/        # LOCKED contracts: protocol (typed chrome.* message DU),
                 #   types, ports (UI↔logic seam), storage schema, constants
  lib/           # pure, chrome-free, fully unit-tested (audio, caption, kyma,
                 #   api-mode, popup-format)
  background/    # SW: Store (single source of truth) · router (sender.tab) ·
                 #   auth · session-coordinator · caption-cache
  content/       # session-manager (module-global pageToken + AbortController) ·
                 #   capture · controller · pipelines/{realtime,standard-chunked,
                 #   subtitle-first,captions} · overlay/ (render-only, byte-identical DOM)
  popup/         # passive renderer (applyState in, runtime messages out)
  entrypoints/   # WXT entrypoints (background.ts, content/index.ts, popup/)
  public/icons/  # extension icons (copied to the build root)
test/            # vitest: Layer A pure-fn goldens + Layer B state-machine/interaction
legacy/          # verbatim 0.6.3 originals (a complete, loadable old build) — kept for reference
docs/rebuild/    # the rebuild's research, SOLUTION, FEATURE-MAP, audit artifacts
```

### Load-bearing invariants (do not break without re-reading `docs/rebuild/SOLUTION.md`)
- **F9 version guard** is the first statement in the content `main()`; idempotent
  re-injection (version-keyed), our own lifecycle (not WXT's `ctx`).
- **`pageToken`** is module-global, bumped on Stop to invalidate all in-flight work.
  Two distinct guard idioms (realtime dual-check vs chunked/subtitle identity-check).
- **Per-session `AbortController`** cancels in-flight fetches on Stop (no credit burn);
  `processStandardChunk` re-guards after every await.
- Realtime SDP POSTs **directly to OpenAI**; mint/heartbeat/end go via the gateway.
- Background is the **single source of truth**; popup is a passive renderer; content
  holds no persistent state. Strict CSP (`script-src 'self'`), `chrome.*` only.

## Testing

`vitest` covers the automatable surface: pure-function golden/characterization
tests (Layer A) and state-machine/interaction tests with a hand-rolled `chrome.*`
mock (Layer B). The realtime WebRTC / MediaRecorder / live-YouTube paths are
**manual-only** (provider/browser-gated) — see the smoke checklist in
`legacy/TEST-MATRIX.md` (TC-1…TC-6).

## License

See [`LICENSE`](./LICENSE).
