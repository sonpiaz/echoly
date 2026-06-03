# SOLUTION — Codex PR review fixes (commit 16b47911ae)

Two Codex findings, both **confirmed real** by code-trace + web verification.

---

## P1 — Cross-video caption leak in `yt-mainworld-cache.ts` (CONFIRMED, broader than reported)

### Problem
`getYtMainWorldData(videoId)` (lines 114-122) falls back to the module-global
`latest` bucket for every field when the per-video entry is empty:
```ts
ccUrls:        e?.ccUrls.length    ? e.ccUrls    : latest.ccUrls,
ccBodies:      e?.ccBodies.length  ? e.ccBodies  : latest.ccBodies,
captionTracks: e?.captionTracks ?? latest.captionTracks,
poToken:       e?.poToken       ?? latest.poToken,
```
But `latest` is populated for **every** capture, including keyed ones, by the
producer (lines 84, 90, 97, 102):
```ts
for (const tgt of vid ? [entryFor(vid), latest] : [latest]) { ... }   // cc-url/cc-body
...
latest.captionTracks = d.captionTracks;   // player
latest.poToken       = d.poToken;
```
So `latest` always holds the **most recent video's** caption data. On SPA /
autoplay navigation to video B, before B's own `/api/timedtext` request is
captured, `byVideo.get(B)` is empty → `getYtMainWorldData(B)` returns video A's
`ccBodies`/`ccUrls`. The nudge-loop guard in `captions-fetch.ts`
(`!cap.ccBodies.length && !cap.ccUrls.length && ...`) then sees data, skips the
nudge/poll, parses A's captions, and returns them as a "successful" result →
**the dub uses the wrong video's captions.**

### Confirmation (web)
- YouTube `/api/timedtext` URLs **reliably carry `v=<videoId>`** — it is a
  required parameter. → real player captures are *always* keyable; `latest`
  should only ever hold genuinely-unkeyable captures (effectively never, in
  practice). (Grokipedia "YouTube timedtext endpoint", Scrapfly 2026.)
- The YouTube **`pot` (PO) token is video-scoped** for web Player/GVS — "a new
  token is required for each video." → the `?? latest.poToken` *and*
  `?? latest.captionTracks` fallbacks are the **same class of cross-video leak**,
  not just `ccUrls`/`ccBodies`. Codex flagged only the first two; a correct fix
  must cover all four. (yt-dlp PO Token Guide; DeepWiki PO Token System.)

### Chosen approach — `latest` = unkeyed-only bucket (restore documented intent)
The file's own comment (lines 35-36) already declares `latest` is "Fallback
bucket for captures whose videoId we couldn't key (used only when the per-video
entry has nothing)." The bug is purely that the **producer pollutes it with
keyed captures.** Fix the producer so `latest` holds **only** captures we could
not associate to a videoId:

- `cc-url` / `cc-body`: `for (const tgt of vid ? [entryFor(vid)] : [latest])`
  (drop the extra `, latest` on the keyed branch).
- `player`: write `captionTracks` / `poToken` only to `entryFor(d.videoId ?? null)`
  (which already returns `latest` when `videoId` is null). Drop the
  unconditional `latest.captionTracks = …` / `latest.poToken = …`.

`getYtMainWorldData` is left **unchanged** — its `?? latest` / `.length ? :`
fallbacks now surface only genuinely-unkeyed data, never a *known different*
video's. For a fresh video B: `byVideo.get(B)` empty + `latest` empty (all real
captures are keyed) → all fields empty → the nudge/poll path runs (or layers
1/2 take over) exactly as intended.

### Rejected alternatives
- *Tag `latest` with `latestVideoId`, gate fallback on match-or-null.* Provably
  **equivalent in effect** (the match branch implies `byVideo` already has the
  data, so latest never actually serves a keyed video) but adds state for no
  behavioral gain. Rejected for simplicity.
- *Remove `latest` entirely.* Drops the last-resort unkeyed path; unnecessary.

### Acceptance criteria
1. After seeding a **keyed** capture for video A (cc-url, cc-body, or player),
   `getYtMainWorldData("B")` (B≠A) returns **empty** `ccUrls`/`ccBodies` and
   `undefined` `captionTracks`/`poToken` — A's data must NOT leak to B.
2. An **unkeyed** capture (URL with no `v=`, or player with no `videoId`) is
   still served by `getYtMainWorldData` for any requested videoId (last-resort
   fallback preserved).
3. Same-video lookups still work: seed keyed capture for A → `getYtMainWorldData("A")`
   returns it. (Locks the existing layer-0 tests green.)
4. `tsc --noEmit` clean; full vitest suite green.

### Known limitation (documented, not a regression)
If YouTube ever issues a `/api/timedtext` request with no `v=` param, that
unkeyed body is still served best-effort to any video — irreducible, since an
unkeyed capture has no video association by definition. Web-confirmed: `v=` is a
required param, so this path is effectively dead.

---

## P2 — `prepareIntent` pre-warm is a no-op on first start (CONFIRMED)

### Problem
`CONTENT_PREPARE_INTENT` is a **bare** message (no payload). The content handler
(`src/content/index.ts` 990-1010) reads `sm.settings`:
```ts
const s = sm.settings;
if (!sm.session && s?.apiBearer && s?.targetLanguage) { … prepareIntent(…) }
```
`SessionManager.settings` initializes to `null` and is only set on
`CONTENT_START` (startSession, line 288) or while a session is live. In the
normal pre-start path the content script has **never received CONTENT_START**,
so `sm.settings` is `null` → the guard fails → **pre-warm never fires on first
start.** After a session ends, `sm.settings` retains the *old* bearer (possibly
expired) and target language → **stale-settings reuse.** Either way the intended
WebRTC/provider warm slot is not created before Start. Confirmed.

### Chosen approach — push resolved settings through the relay
The background already has the authoritative settings the Start would use:
- bearer: resolve via **`decideApiMode({ token: await auth.getSessionToken(), user: store.state.signedInUser })`** — NOT `resolveApiMode`. `resolveApiMode`'s
  `cachedUser`-falsy branch calls `auth.fetchUser()` → a real `GET /auth/me`
  network request on **every hover** when the SW is cold (`signedInUser` null).
  `decideApiMode` is pure: returns a mode only when **both** token (cheap cookie
  read) and the cached `user` are present, else `null` → no network, ever. If
  `signedInUser` is null (cold SW, not yet hydrated) we simply forgo the warm
  slot on that first hover — acceptable. `mode.apiKey` is the `ec_session` token.
- `store.state.targetLanguage`, `store.state.tier` (already plan-coerced;
  `TIER_STANDARD="standard"` / `TIER_REALTIME="realtime"` == the `pipeline`
  string `/rtc/prepare` expects). `apiBase` is the constant `ECHOLY_PROXY_BASE`,
  which `sm.apiBase` already defaults to — no need to pass it.

Changes:
- **`src/shared/protocol.ts`**: extend the relay message to carry an optional intent:
  ```ts
  | { type: "CONTENT_PREPARE_INTENT"; intent?: { apiBearer: string; targetLanguage: string; pipeline: string } };
  ```
- **`src/background/router.ts`** `prepareIntentOnActiveTab(store, auth)`: resolve
  the mode via the pure `decideApiMode` (no network); attach `intent` when a mode
  resolves; **always** relay (intent omitted when signed out / cold SW → content
  no-ops, existing relay test stays green because deep-equality ignores
  `undefined` keys). Call site becomes `prepareIntentOnActiveTab(store, auth)`.
- **`src/content/index.ts`** handler: read `msg.intent` instead of `sm.settings`:
  ```ts
  const intent = msg.intent;
  if (!sm.session && intent?.apiBearer && intent?.targetLanguage) {
    void app.webrtc.prepareIntent({
      apiBearer: intent.apiBearer,
      pipeline: intent.pipeline || TIER_REALTIME,
      targetLanguage: intent.targetLanguage,
    });
  }
  ```
  This removes the `sm.settings` dependency entirely → fixes both no-op-on-first-
  start and stale-after-old-session.

### Rejected alternatives
- *Relay current settings to content pre-start so `sm.settings` is populated.*
  Larger surface, leaves the stale-after-session window open. Rejected.

### Acceptance criteria
1. With a signed-in store (token + targetLanguage + tier), `PREPARE_INTENT`
   relays `CONTENT_PREPARE_INTENT` carrying `intent.apiBearer` / `targetLanguage`
   / `pipeline` (= `store.state.tier`).
2. Content's handler calls `app.webrtc.prepareIntent` using `msg.intent`,
   independent of `sm.settings` — fires on first start (no prior CONTENT_START).
3. Signed-out / no-token store still relays a bare message (no `intent`) and
   content no-ops; existing router relay + session-guard tests stay green.
4. `tsc --noEmit` clean; full vitest suite green; new tests for (1)+(2).

---

## File ownership (no overlaps)
- P1: `src/platforms/youtube/yt-mainworld-cache.ts` + a new
  `test/platforms/youtube/yt-mainworld-cache.test.ts` (or a new describe block).
- P2: `src/shared/protocol.ts`, `src/background/router.ts`,
  `src/content/index.ts`, `test/background/router.test.ts`.
No file is touched by both fixes.
