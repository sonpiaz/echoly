# Research Slice 02 — Background Service Worker, Messaging & State Flow

**Branch:** `rebuild/ts-wxt`  
**Scope:** `src/entrypoints/background.ts`, `src/background/index.ts`, `src/background/store.ts`, `src/background/router.ts`, `src/background/session-coordinator.ts`, `src/background/auth-listener.ts`, `src/background/hydrate-signed-in.ts`, `src/background/auto-start.ts`, `src/shared/protocol.ts`, `src/shared/storage.ts`, `src/shared/types.ts`, plus popup and content entrypoints for cross-surface tracing.

---

## 1. Message Routing Audit

### Message Types — Complete Map

| Message | Sender | Handler | Handled? |
|---|---|---|---|
| `GET_STATE` | popup | `handlePopupMessage` → `store.loadSettings` + `hydrateSignedIn` + `refreshActiveSite` | YES |
| `SIGN_OUT_ECHOLY` | popup | `auth.signOut` + `store.refreshAuth` + `broadcast` | YES |
| `OPEN_SIGNIN` | popup | `chrome.tabs.create` + `setSigninTabId` | YES |
| `START` | popup | `session.start` | YES |
| `STOP` | popup | `session.stop` | YES |
| `UPDATE_SETTINGS` | popup | `session.updateSettings` | YES |
| `UPDATE_VOLUME` | popup | `session.updateVolume` | YES |
| `UPDATE_ADVANCED_SETTINGS` | popup | `session.updateAdvancedSettings` | YES |
| `UPDATE_SITE_OVERRIDE` | popup | `session.updateSiteOverride` | YES |
| `REMOVE_SITE_OVERRIDE` | popup | `session.removeSiteOverride` | YES |
| `SAVE_SITE_DEFAULT` | popup | `session.saveSiteDefault` | YES |
| `REFRESH_SETTINGS` | popup | `session.refreshSettings` | YES |
| `LIST_AUDIO_OUTPUT_DEVICES` | popup | `listAudioOutputDevices` | YES |
| `CONTENT_STATE` | content | `store.setRunning/setPaused/setStatus/setError + broadcast` | YES |
| `CONTENT_QUOTA` | content | `store.applyUsagePatch + state reset + broadcast` | YES |
| `CONTENT_STOP_REQUEST` | content | `session.stop()` | YES |
| `CONTENT_ENDED` | content | `store state reset + scheduleHydrateSignedIn` | YES |
| `UPDATE_SETTINGS` | content | `session.updateSettings` | YES |
| `BACKGROUND_STATE_UPDATE` | background | popup `applyState` listener | YES |
| `CONTENT_PING` | background | content `sendResponse({ok,version})` | YES |
| `CONTENT_START` | background | content `app.startSession` | YES |
| `CONTENT_STOP` | background | content `app.stopSession("backend-stop")` | YES |
| `CONTENT_UPDATE_SETTINGS` | background | content `app.applySettingsLive` | YES |
| `CONTENT_UPDATE_VOLUME` | background | content `app.applyVolumes` | YES |

**No unhandled, dead, or duplicated message types found.** The protocol type definitions in `shared/protocol.ts` are fully exhausted by the handlers.

### Potential Sender/Handler Mismatch — NONE CRITICAL

One subtle area: `UPDATE_SETTINGS` is typed as both `PopupToBgMessage` and `ContentToBgMessage` (same type name, different union members). The router distinguishes them by `isFromContent(sender)`. This is correct in implementation, but the shared type name collision is a latent confusion risk (see Finding 6 below).

---

## 2. Correctness Bugs

### FINDING 1 — HIGH: Async `GET_STATE` does full re-hydration on every popup open (performance + race)

**File:** `src/background/router.ts:97-100`

```typescript
case "GET_STATE":
  await store.loadSettings();
  await hydrateSignedIn(store, deps.settings);
  await session.refreshActiveSite();
  return { ok: true, state: store.snapshot() };
```

Every popup open triggers `store.loadSettings()` (chrome.storage read), `hydrateSignedIn` (network bootstrap fetch + optional settings GET), and `refreshActiveSite` (tabs.query). The `hydrateSignedIn` single-flight guard (`hydrateInFlight`) prevents parallel duplication, but a slow network fetch still serializes the whole GET_STATE response — the popup blocks showing state until the bootstrap call returns. The debounce (`scheduleHydrateSignedIn`) is bypassed here by calling directly. This is particularly painful on SW cold-start after idle (most common popup open scenario).

**Severity:** HIGH (user-visible latency — popup appears frozen on open after cold-start)  
**Fix:** Return `store.snapshot()` immediately from cached in-memory state; schedule background re-hydration asynchronously; push the update via `broadcast()`. The popup's existing `visibilitychange` listener already handles the re-sync case.

---

### FINDING 2 — HIGH: `UPDATE_VOLUME` from popup bypasses `routeMessage` return-value contract

**File:** `src/popup/index.ts:689-696`

```typescript
void chrome.runtime
  .sendMessage({
    type: "UPDATE_VOLUME",
    ...
  })
  ?.catch?.(() => {});
```

The popup sends `UPDATE_VOLUME` fire-and-forget (no `await`), and the router handles it as a popup message (async path, `return true`). This is intentional per the protocol comment ("Genuine fire-and-forget"). However the background's `handlePopupMessage` for `UPDATE_VOLUME` calls `session.updateVolume()` which does a `relayToContent` round-trip — that returned promise is fully awaited internally but the popup doesn't care about the reply. This is architecturally fine, but it means **if the relay fails, no error surfaces** and the volume silently doesn't apply. Combined with the `ensureContentScript` injection inside `updateVolume`, this is a hidden failure mode.

**Severity:** HIGH  
**Fix:** Either accept the fire-and-forget semantics explicitly (document it) or add a reply path that at least logs the relay failure.

---

### FINDING 3 — MED: `onMessage` in content is always `return true` even for synchronous paths

**File:** `src/content/index.ts:642-680`

```typescript
chrome.runtime.onMessage.addListener((...): boolean => {
  void (async () => {
    switch (msg?.type) {
      case "CONTENT_PING":
        sendResponse({ ok: true, version: ECHOLY_VERSION }); // sync
        break;
      ...
    }
  })();
  return true; // always
});
```

The listener always returns `true` (keep channel open) even for synchronous responses like `CONTENT_PING`. This is technically harmless — Chrome closes the channel when `sendResponse` is called regardless — but it creates a dangling open channel for any message where `sendResponse` is not actually called (unexpected `default` branch still calls it, so no real leak here). More importantly, if a future message type is added and the `sendResponse` call is forgotten inside the `void async` IIFE, the caller's promise will never resolve (no timeout on `relayToContent`).

**Severity:** MED  
**Fix:** For synchronous messages (`CONTENT_PING`, `CONTENT_STOP`, `CONTENT_UPDATE_VOLUME`), call `sendResponse` and `return false` outside the IIFE. Only use `return true` + async for `CONTENT_START` (which involves await). Prevents silent promise hangs from future mistakes.

---

### FINDING 4 — MED: `broadcast()` uses leading-edge-only debounce — trailing state may be lost

**File:** `src/background/store.ts:86-91`

```typescript
broadcast(): void {
  const now = Date.now();
  if (now - this.lastBroadcastAt < BROADCAST_DEBOUNCE_MS) return;
  this.lastBroadcastAt = now;
  post({ type: "BACKGROUND_STATE_UPDATE", state: this.snapshot() });
}
```

The debounce is leading-edge only — no trailing flush. If a burst of state updates happens (e.g., stop sequence: `setRunning(false)` → `setConnecting(false)` → `setPaused(false)` → `setTabId(null)` → `setStatus("Stopped")` → `broadcast()`), only the first `broadcast()` in each 50ms window fires. The comment acknowledges "popup self-heals because every explicit send() reply also carries state" — this is true for direct command replies (START/STOP return full state). But autonomous updates from `CONTENT_STATE` content pushes go through `broadcast()` only — a fast burst could silently drop intermediate states. On a 60fps UI, 50ms is 3 frames, so paused→translating state transitions could be missed.

**Severity:** MED  
**Fix:** Add trailing-flush: schedule a `setTimeout(() => post(snapshot), 0)` when debounce drops a call, cleared if a later call fires. Standard trailing-debounce pattern.

---

### FINDING 5 — MED: SW cold-start async init is fire-and-forget with no error boundary

**File:** `src/background/index.ts:57-61`

```typescript
void (async () => {
  await store.loadSettings();
  const token = await auth.getSessionToken();
  if (token) await hydrateSignedIn(store, settingsClient);
})();
```

This IIFE is detached (`void`). If `store.loadSettings()` throws (corrupted storage), or `hydrateSignedIn` throws after `store.refreshAuth()` fails, no error is reported and the SW is left in a partially-initialized state. The popup opens, sends `GET_STATE`, and gets default state + no auth — no visible error, but `signedInUser` is null and no catalog is loaded.

**Severity:** MED  
**Fix:** Wrap the IIFE in a try/catch; on failure, set `store.state.errorMessage` and call `store.broadcast()` so the popup can surface a "Could not load settings" state.

---

### FINDING 6 — MED: `removeSiteOverride` does not pass `expectedVersion` to server

**File:** `src/background/session-coordinator.ts:437-440`

```typescript
if (this.settingsClient) {
  await this.syncOrDirty(() =>
    this.settingsClient!.removeSiteOverride(norm),
  );
```

`putGlobal` and `putSiteOverride` both accept `expectedVersion` for optimistic concurrency — these call sites pass it. But `removeSiteOverride` calls `settingsClient.removeSiteOverride(norm)` without an `expectedVersion`. The server `DELETE` endpoint accepts it. This means a concurrent edit from another device could be silently overwritten by a remove operation.

**Severity:** MED  
**Fix:** Pass `this.store.state.advancedVersion` to `removeSiteOverride` (same pattern as `putSiteOverride`).

---

## 3. Service Worker Lifecycle Correctness

### FINDING 7 — LOW: Module-scoped state in `auth-listener.ts` and `hydrate-signed-in.ts` is ephemeral — by design, but could confuse

**Files:** `src/background/auth-listener.ts:29-30`, `src/background/hydrate-signed-in.ts:8-9`

```typescript
// auth-listener.ts
let pending: ReturnType<typeof setTimeout> | null = null;
let signinTabId: number | null = null;

// hydrate-signed-in.ts
let hydrateTimer: ReturnType<typeof setTimeout> | null = null;
let hydrateInFlight: Promise<void> | null = null;
```

These module-scoped variables reset on SW cold-start. This is intentional and documented (auto-start's `lastFireAt` map carries the same note). The risk: if the SW is recycled during a sign-in flow (user opens sign-in tab; browser idles; SW terminates), `signinTabId` is lost and the tab is never auto-closed after the magic link callback. The sign-in still completes (cookie fires `onChanged` which re-registers), but the signin tab lingers.

**Severity:** LOW  
**Fix:** Persist `signinTabId` to `chrome.storage.session` (MV3 session storage survives SW recycles, not full browser restarts). Restore on next `installAuthListener` call.

---

### FINDING 8 — LOW: `tabs.onUpdated` listener is registered TWICE

**File:** `src/background/index.ts:36-55`

```typescript
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== store.state.tabId || !changeInfo.url) return;
  void session.stop(); // LISTENER 1 — stops session on URL change
});
// ...
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => { // LISTENER 2 — refreshes site
  if (!changeInfo.url && changeInfo.status !== "complete") return;
  // ...debounced refreshActiveSite + broadcast
});
```

`registerAutoStart` adds a THIRD `tabs.onUpdated` listener. Three listeners for the same event, each firing on every tab update. Each is correctly scoped (different logic), but a future developer editing one may not notice the others. The three together do: stop session, refresh site label, auto-start. The stop listener's early return (`if (tabId !== store.state.tabId || !changeInfo.url) return`) means it fires on every tab update even when idle — trivial cost, but not obvious.

**Severity:** LOW  
**Fix:** (Cleanup) Consolidate all `tabs.onUpdated` logic into a single listener in `index.ts`; call `registerAutoStart` as a named function that adds to that listener's dispatch table, or simply inline it. Reduces event dispatch overhead and makes ordering guarantees explicit.

---

## 4. State Ownership Analysis

**Background is the sole mutation owner — no leaks found.** Specifically:

- **Popup never mutates state directly** — it reads from `state` (module-local copy) for rendering decisions (e.g., `tierSelect.value`, `state.standardVoice`), but all writes go through `sendToBackground()`. The `state.tier = tier as TranslationTier` assignments at lines 745, 759, 764 in `popup/index.ts` are local-only optimistic echoes that immediately `pushSettings()` — they do not bypass background.
- **Content never holds persistent state** — `SessionManager` fields are ephemeral and their authoritative counterparts (`running`, `paused`, `status`) flow via `emitState()` → `CONTENT_STATE` → background's `handleContentEvent` → `store.setRunning/setPaused/setStatus`.
- One subtle note: `popup/index.ts:469` calls `markHasEverSignedIn()` directly (writes to `chrome.storage.local`) from the popup context when `state.signedInUser` is truthy. This is a write from a non-background context, but `HAS_EVER_SIGNED_IN_KEY` is a separate key from the 8 settings keys — it is not tracked in `Store.state`, so there is no mutation-ownership conflict. Still worth noting as an exception to the "background owns storage" principle.

---

## 5. Async Correctness

### FINDING 9 — LOW: `routeMessage` returns `true` for async popup paths but the surrounding `onMessage.addListener` callback is synchronous

**File:** `src/background/index.ts:26-28`, `src/background/router.ts:183-207`

```typescript
chrome.runtime.onMessage.addListener((message, sender, sendResponse) =>
  routeMessage(deps, message as ToBackgroundMessage, sender, sendResponse),
);
```

`routeMessage` returns `boolean` synchronously (`true` for popup paths, `false` for content). This is correct MV3 pattern — `return true` keeps the channel open. However, the async IIFE inside (`void (async () => { ... sendResponse(result); })()`) is detached. If `handlePopupMessage` throws before calling `sendResponse`, the channel stays open until Chrome times it out (~5 minutes). The outer `try/catch` covers this: `sendResponse({ ok: false, error })` is always called in the catch block.

**Assessment:** No bug — the catch block ensures `sendResponse` is always called. Pattern is correct.

---

## 6. Simplification / Cleanup Opportunities

### FINDING 10 — LOW (CLEANUP): `store.clearAuth()` is deprecated but not removed

**File:** `src/background/store.ts:283-285`

```typescript
/** @deprecated Use resetSignedInState — kept for call sites migrating. */
clearAuth(): void {
  this.resetSignedInState(true);
}
```

No callers of `clearAuth` exist in the codebase (only the one that was migrated). Dead code.

**Fix:** Remove `clearAuth()`.

---

### FINDING 11 — LOW (CLEANUP): `store.mergeFromContent` is a broad `Object.assign` with no field whitelist

**File:** `src/background/store.ts:204-206`

```typescript
mergeFromContent(partial: Partial<State>): void {
  Object.assign(this.state, partial);
}
```

Called only from `session-coordinator.ts:318` when `CONTENT_UPDATE_SETTINGS` reply carries optional `reply.state`. The reply type is `{ ok: true; state?: Partial<State> }`. Since content echoes back only what it holds in `sm.settings`, this is benign in practice, but `Partial<State>` includes sensitive fields (`apiBearer`, `signedInUser`, etc.) — a malicious or buggy content script reply could overwrite them. The protocol comment notes "state OPTIONAL" for this response.

**Fix:** Either narrow `mergeFromContent`'s parameter to a whitelist of safe content-echo fields (e.g., only `Settings` keys), or validate the incoming partial before merging.

---

### FINDING 12 — LOW (CLEANUP): `isRealtimeStale` deprecated alias in `session-manager.ts`

**File:** `src/content/session-manager.ts:111-113`

```typescript
/** @deprecated Use isSessionStale */
isRealtimeStale(token: number): boolean {
  return this.isSessionStale(token);
}
```

Check callers — if none remain, remove.

---

### FINDING 13 — LOW (CLEANUP): `populateOutputDevices` error handling always falls back regardless of error type

**File:** `src/popup/index.ts:1029-1043`

```typescript
} catch (err) {
  const msg = (err as Error).message;
  if (!isBenign(msg)) {
    await fallbackEnumerate(); // same in both branches
  } else {
    await fallbackEnumerate();
  }
}
```

Both branches of the `if (!isBenign)` are identical — `fallbackEnumerate()` in all cases. The conditional is dead code.

**Fix:** Remove the `if/else`, unconditionally call `await fallbackEnumerate()`.

---

## 7. Flow Simplification Opportunities

### FINDING 14 — LOW (CLEANUP): `GET_STATE` triggers a full re-hydration round-trip that could be avoided

(See Finding 1 — the latency aspect was HIGH, this addendum is about the architecture.) The root cause is that `GET_STATE` is used for both "give me current state" and "please refresh everything." These could be split: a fast `GET_STATE` (return snapshot immediately) and an explicit `REFRESH` path (trigger hydration). The `REFRESH_SETTINGS` message already exists for the server-authoritative Advanced bundle — the bootstrap/auth piece lacks an equivalent.

**Fix:** Fast-path `GET_STATE` to return `store.snapshot()` and schedule hydration in the background. Only trigger full hydration eagerly if `!store.state.signedInUser` (cold/unknown state) or if a grace timer has expired (e.g., >5 minutes since last hydration). Track `lastHydratedAt` on the Store.

---

## Summary

| # | Severity | Category | File | Issue |
|---|---|---|---|---|
| 1 | HIGH | Correctness | `router.ts:97` | `GET_STATE` full-hydrates synchronously → popup blocked on cold-start |
| 2 | HIGH | Correctness | `popup/index.ts:689` | `UPDATE_VOLUME` fire-and-forget silently drops relay failures |
| 3 | MED | Correctness | `content/index.ts:642` | Content onMessage always returns `true` — future missing `sendResponse` will hang |
| 4 | MED | Correctness | `store.ts:86` | Leading-edge broadcast drops trailing state in rapid update bursts |
| 5 | MED | Correctness | `background/index.ts:57` | SW init IIFE is detached — errors leave state silently uninitialized |
| 6 | MED | Correctness | `session-coordinator.ts:437` | `removeSiteOverride` skips `expectedVersion` → concurrent edit clobbered |
| 7 | LOW | Lifecycle | `auth-listener.ts:29` | `signinTabId` lost on SW recycle → signin tab not auto-closed |
| 8 | LOW | Cleanup | `background/index.ts:36-55` | Three separate `tabs.onUpdated` listeners — hard to trace ordering |
| 9 | LOW | Async | `router.ts:197` | Detached IIFE catch guarantees — actually correct, no bug |
| 10 | LOW | Cleanup | `store.ts:283` | `clearAuth()` deprecated with no callers — remove |
| 11 | LOW | Correctness | `store.ts:204` | `mergeFromContent` accepts full `Partial<State>` — overly broad |
| 12 | LOW | Cleanup | `session-manager.ts:111` | `isRealtimeStale` deprecated alias — check callers, remove |
| 13 | LOW | Cleanup | `popup/index.ts:1033` | Both branches of `isBenign` check call `fallbackEnumerate` — dead branch |
| 14 | LOW | Cleanup | `router.ts:97` | `GET_STATE` conflates snapshot + refresh — split into two intents |
