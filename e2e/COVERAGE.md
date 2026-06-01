# Extension E2E coverage

## Default suite (`product-e2e.spec.ts`)

One **serial** browser session — no per-test relaunch (was ~45s overhead × N).

| Step | Tier | What it proves |
|------|------|----------------|
| 1 | — | Welcome → locked shell |
| 2 | **Free** | FREE badge, usage, Realtime gated |
| 3 | **Pro** | Standard Start → `POST /translate/chunk` + dub audio + overlay |
| 4 | **Max** | Realtime Start → `/rtc/translate` + dub audio (needs `RTC_PEER_IMPL=mediasoup`) |
| 5 | **Pro** | Sign-out → locked |

Optional (separate files):

- `api-contract.spec.ts` — bootstrap vs catalog (no browser)
- `signin-login-code.spec.ts` — web login-code OTP (needs `:4321`; skipped unless `ECHOLY_E2E_CODE` or `ECHOLY_E2E_DEV_ENDPOINT=true` is set)
- `youtube-voice-chunked.spec.ts` — chunked path (`PW_YOUTUBE_CHUNKED_URL`)

## Env

| Variable | Effect |
|----------|--------|
| `PW_SKIP_VOICE=1` | Skip Pro/Max voice steps (UI only, ~2 min) |
| `PW_SKIP_REALTIME=1` | Skip Max WebRTC step |
| `PW_SLOW_MO=25` | Headed click delay (default 25ms) |
| `PLAYWRIGHT_SKIP_WEB_SERVER=1` | Do not spawn server (use running `make dev-server`) |
| `RTC_PEER_IMPL=mediasoup` | Required on API for Max step |

## Run

```bash
make dev-server   # mediasoup + keys for voice
cd extension && npm run test:e2e:headed
```

Fast UI-only: `npm run test:e2e:fast -- --headed`
