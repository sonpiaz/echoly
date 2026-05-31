# Echoly — AI voice dubbing for video (Chrome MV3 extension)

Voice-to-voice AI dubbing and translation on any site with a video player (YouTube,
courses, and more). Draggable in-page overlay with dubbed audio and optional captions.

Two tiers: **Realtime** (live voice-to-voice WebRTC, &lt;1s, Max) and **Standard**
(voice dub ~5s; on YouTube VOD uses captions when available). Sign in for subscription minutes.

TypeScript + [WXT](https://wxt.dev). All provider traffic goes through the Echoly
server (`ec_session`); no BYOK.

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

### Dev vs production origins

All Echoly API/web URLs are **build-time** config — no hardcoded `echolyhq.com` in
popup links. Single module: `src/shared/echoly-config.ts`.

| Build | Command | Env file | API | Web |
|-------|---------|----------|-----|-----|
| Dev | `npm run dev` | `.env.development` | `http://localhost:8787` | `http://localhost:4321` |
| Prod | `npm run build` / `npm run zip` | `.env.production` | `https://api.echolyhq.com` | `https://echolyhq.com` |

Override locally with `.env.development.local` (gitignored). `wxt.config.ts` mirrors
the same origins in `host_permissions`.

## Architecture

Three surfaces (service worker / content script / popup), one locked contract
layer, pure logic split out for testing.

```
src/
  shared/        # LOCKED contracts: protocol (typed chrome.* message DU),
                 #   types, ports (UI↔logic seam), storage schema, constants
  lib/           # pure, chrome-free, unit-tested (audio, caption, api-mode, …)
  background/    # SW: Store (single source of truth) · router (sender.tab) ·
                 #   auth · session-coordinator · caption-cache
  content/       # session-manager (module-global pageToken + AbortController) ·
                 #   capture · controller · pipelines/{realtime,standard-chunked,
                 #   subtitle-first,captions} · overlay/ (render-only, byte-identical DOM)
  popup/         # passive renderer (applyState in, runtime messages out)
  entrypoints/   # WXT entrypoints (background.ts, content/index.ts, popup/)
  public/icons/  # extension icons (copied to the build root)
test/            # vitest: Layer A pure-fn goldens + Layer B state-machine/interaction
docs/rebuild/    # design artifacts from the TS/WXT migration
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
**manual-only** (provider/browser-gated) — smoke on a real YouTube tab: sign in,
start Realtime and Standard, lang/voice swap mid-session, Stop aborts in-flight
work, session timer warning.

## License

See [`LICENSE`](./LICENSE).
