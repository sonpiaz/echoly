# Extension E2E

## Default: product suite (headed)

```bash
make dev-server          # :8787 — use RTC_PEER_IMPL=mediasoup for Max realtime
cd extension
npm run test:e2e:headed  # 5 serial steps, one browser
```

| Script | What |
|--------|------|
| `npm run test:e2e` | Product + API contract |
| `npm run test:e2e:headed` | Product only, visible browser |
| `npm run test:e2e:fast` | Skip live AI (`PW_SKIP_VOICE=1`) |
| `npm run test:e2e:optional` | Magic-link + chunked voice |

See `COVERAGE.md` for the step matrix.

## Popup opening

Headed: `chrome.action.openPopup` when available; else `popup.html` tab + YouTube tab refocus. Site label uses `resolveSiteDomainFromTabs` in the extension.

## Start / translation in voice tests

Every voice step:

1. Assert nút idle: `#actionLabel` = **Start dubbing**, `body[data-state=idle]`
2. **DOM click** `#toggle` (via `evaluate` — YouTube tab stays active, không steal focus như Playwright `.click()`)
3. Assert nút live: **Stop translating**, `.is-live`, `data-state` = connecting|active|paused
4. Headed: popup được `bringToFront` ~2.5s (`PW_HOLD_POPUP_MS`) để bạn **nhìn thấy nút đổi**
5. Log: `[e2e] ✓ PASS — Start OK` rồi `[e2e] ✓✓✓ VOICE TEST PASSED` khi overlay + dub OK

Playwright report có `test.step` từng bước (Start → overlay → audio).

Fallback chỉ khi click không đổi nút: `PW_START_VIA_MESSAGE=1` ép message-only (debug).

## Removed duplicates (consolidated into `product-e2e.spec.ts`)

Previously separate files for popup-auth, tier matrix, sign-out, site-detect, youtube-session, voice-subtitle/realtime, and full-journey — merged to avoid relaunching Chromium every test.
