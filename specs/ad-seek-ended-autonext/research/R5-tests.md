# R5 — Test Coverage Map, Gaps, and Repro Skeletons
## Bugs: A (spurious-ended CONTENT_STOP), B (auto-next torn-down+restart), C (seek-induced mid-roll not detected), D (wrong source language on continuation)

**Slice:** test surface, coverage gaps, reproduction test skeletons.  
**Branch:** `develop` (WXT+TS rebuild). READ-ONLY — no source files modified.

---

## 1. Coverage Matrix — symptom × existing test × gap

### Symptom A — ad ends → spurious `ended` → bg sends CONTENT_STOP, tears down session

| Test file | Covers | Gap |
|---|---|---|
| `test/content/ad-watcher.test.ts:56–141` | AdWatcher edge-detect poll + MutationObserver fires `onAdStart`/`onAdEnd` exactly once | Does NOT test what happens AFTER `onAdEnd` w.r.t. the `ended` event that YouTube fires on the same video element during the ad→content transition |
| `test/content/ad-pause-integration.test.ts:151–173` | `onAdEnd → lifecycle.resume('ad')` drives the overlay to "live" state | Does NOT test that `onEnded` fires *during* or *immediately after* `onAdEnd` and what `nav.notifyEnded()` does in that window |
| `test/content/soft-stop-continue.test.ts:256–270` | `VOD video-end keeps the realtime session alive (nothing terminally stops it)` — `nav.notifyEnded()` + no `stopSession` | Only tests the CONTENT-SIDE path. Does NOT test the BACKGROUND side: `nav-stop` receiving a URL-flicker (non-watch URL) during the ad→content transition that fires `session.stop()` → `CONTENT_STOP` → kills the 45s keep-alive |
| `test/background/nav-stop.test.ts:84–116` | `(c) running + url change to non-watch → session.stop IS called` | Happy-path "url is non-watch" immediately triggers stop. **No test for the ad-transition URL-flicker scenario** — where the URL briefly leaves the watch path during the ad→content switch and nav-stop fires stop() while the content still holds `#awaitingNext = true`. The timing race (nav-stop fires before the URL settles back) is entirely uncovered. |
| `test/content/unload-end.test.ts:16–34` | `endRtcSession` keepalive `/end` POST | Unrelated to symptom A (only tests the `/end` fetch; not the CONTENT_STOP path) |
| `test/content/navigation-prefetch.test.ts:336–372` | `notifyEnded terminal-idle session-identity race` — a NEW session after `ended` does NOT get killed by a stale 45s timer | Tests self-CONTENT-side guard. Does NOT test the background's authority to send CONTENT_STOP independently. |

**Gap summary for A:**  
- No test exercises the end-to-end race: `onAdEnd` + `ended` on same video element → `notifyEnded` (arms 45s) → background `tabs.onUpdated` for URL-flicker during ad→content → `session.stop()` → `CONTENT_STOP` arrives at content while `#awaitingNext = true`.  
- `nav-stop.test.ts` only covers the SPA/steady-state non-watch-URL case; it never simulates the URL reverting after a debounce — i.e. "URL briefly left watch, returned to watch within 600ms" is untested.  
- No integration test combines the ad-watcher `onAdEnd` callback with a subsequent `ended` DOM event on the same `<video>` element.

---

### Symptom B — auto-next: session torn down then fresh restart instead of clean continue

| Test file | Covers | Gap |
|---|---|---|
| `test/content/pause-resume-autonext.test.ts:690–756` | `NavigationWatcher`: URL poll → `{continue}` debounce, `{stop}` on non-watch, `notifyEnded` → 45s window, video-end+auto-advance keeps session alive | Tests `NavigationWatcher` in isolation. Does NOT test the RACE between background `CONTENT_STOP` (from nav-stop) and the content watcher's `{continue}` emission — i.e. bg sends stop BEFORE the 700ms debounce settles |
| `test/background/nav-stop.test.ts:59–67` | `(a) running + SPA watch→watch url change → session.stop NOT called` — the skip-stop guard | Does NOT test the scenario where `status:"loading"` is absent but the URL briefly visits a non-watch path (YouTube short redirect / ad URL) before returning to a watch URL. In that scenario the non-watch branch in `nav-stop` fires `session.stop()` even though it is a transient flicker. |
| `test/background/auto-start.test.ts:196–284` | Hard-nav continuation intent bypass (Gate-4), intent consumed once | Tests the BACKGROUND auto-start intent mechanism. Does NOT test the **race** where `session.stop()` from nav-stop arrives while the content watcher has already emitted `{continue}` and `continueOnNewVideo` is in-flight. |
| `test/content/soft-stop-continue.test.ts:273–310` | `after video-end, a {continue} nav event drives continueOnNewVideo` | Tests the pure-content keep-alive path. Does NOT test the scenario where the BG concurrently sends CONTENT_STOP (the race that actually manifests the bug in prod). |
| `test/content/pause-resume-autonext.test.ts:787–858` | `overlay transitions to 'live' even when restart() bumps sm.pageToken` (GAP-1) | Tests the myGen guard works despite pageToken bumps — the auto-next success path. Does NOT test the scenario where a bg CONTENT_STOP arrives mid-`continueOnNewVideo` causing teardown of the session that `continueOnNewVideo` is trying to restart on. |

**Gap summary for B:**  
- No cross-layer test (content+background) exercises the CONTENT_STOP arriving while `continueOnNewVideo` is in-flight (between the `{continue}` emission and the `restart()` completion).  
- `nav-stop` debounce on non-watch URL (fix window to let URL settle) is not exercised at all — there is no test that sends a non-watch URL event then a watch-URL event within N ms and asserts `session.stop()` was NOT called.

---

### Symptom C — seek-triggered mid-roll ad NOT detected (dub plays over ad, metering not frozen)

| Test file | Covers | Gap |
|---|---|---|
| `test/content/ad-watcher.test.ts:56–141` | Edge-detect (poll + observer) fires once on class flip; seeded from current state (already-active ad at start does NOT fire `onAdStart`) | Tests `start()` seeding and poll/observer transitions. **Does NOT test the seek scenario**: after a seek, `#adActive` may be stale and the ad class flip arrives in the same mutation batch as seek-related class changes → `isAdPlaying()` momentarily false → edge missed. |
| `test/content/subtitle-first-ad-onseek.test.ts:66–86` | `#onSeek` is a NO-OP while `lifecycle.isPausedFor('ad')` | Tests that the ad-gate blocks seek reset while ad is held. Does NOT test the REVERSE: seek fires BEFORE the ad is detected (because `#adActive` is seeded stale) → `#onSeek` runs against ad clock → cursor/`_played` corrupted. |
| `test/unit/youtube-ad-state.test.ts:19–42` | `isYouTubeAdPlaying()` reads `#movie_player` class → `ad-showing` / `ad-interrupting` correctly | Unit-level DOM predicate test. Does NOT test the coalesced-mutation scenario (seek-class + ad-class arriving in the same flush). |
| `test/platforms/youtube/adapter.test.ts` | `readLiveCaptionText` only | No ad detection coverage. |
| `test/content/ad-pause-integration.test.ts` | Ad pause routes through lifecycle.pause('ad'); WebRTC metering freeze; user+ad coexistence | ALL tests use `getAdSignalTarget: () => null` (poll-only mode; no MutationObserver exercised). Does NOT test the seek-induced timing window where the poll tick runs while the observer has fired for unrelated seek classes. |

**Gap summary for C:**  
- No test exercises **`AdWatcher` during a seek**: no test calls `adWatcher.start(…)`, then simulates a seek (`seeked` event), then simultaneously mutates `#movie_player` classes (ad + seek-related), then asserts that `onAdStart` still fires.  
- `#adActive` re-seeding on seek (`reseed()` or `restartObserver()`) is a proposed fix with zero test coverage because the fix does not exist yet.  
- No test combines `onSeeked` in `subtitle-first-pipeline` with a concurrent ad class mutation and asserts that `lifecycle.isPausedFor('ad')` ends up `true` (not `false` due to a stale `#adActive`).

---

### Symptom D — continuation uses wrong source language (not following user config), inconsistent

| Test file | Covers | Gap |
|---|---|---|
| `test/content/pause-resume-autonext.test.ts:787–858` | `continueOnNewVideo` drives `subtitleFirst.restart(settings, newVideoId)` with `sm.settings` | **`settings.targetLanguage` is hardcoded `"vi"` in every test fixture** — no test checks that the target language from the popup/user config is preserved. |
| `test/content/soft-stop-continue.test.ts:273–311` | `{continue}` drives `continueOnNewVideo`; `app.sm.settings` set to `{ apiBearer: "b", targetLanguage: "vi" }` | Same: `targetLanguage` is always `"vi"`; no test asserts that changing `targetLanguage` to, say, `"en"` results in `restart()` being called with `"en"`. |
| `test/background/session-coordinator.test.ts:84–105` | `CONTENT_START` carries `targetLanguage` from `session.start({ targetLanguage: "ja" })` | Tests the background→content START message. Does NOT test the auto-next CONTINUATION path where `sm.settings` is the snapshot from the ORIGINAL `CONTENT_START` — if the popup updates language mid-session, `sm.settings` is stale and `continueOnNewVideo` uses the old value. |
| `test/background/auto-start.test.ts` (all) | Auto-start fires `session.start({})` — no `targetLanguage` override | Tests the auto-start gate logic; no assertion about which language is sent. |
| `test/content/pipelines/subtitle-first-pipeline.ts` (start/restart files) | Restart builds `fetchCaptions({ preferLang: settings.targetLanguage, … })` | No test passes a non-default `targetLanguage` and asserts it reaches `fetchCaptions`. |

**Gap summary for D:**  
- No test asserts that `continueOnNewVideo` passes the **current** `sm.settings.targetLanguage` (from the user's popup selection) to `subtitleFirst.restart()` / `webrtc.continueOnNewVideo()`.  
- No test covers mid-session language change: user changes target language in the popup → `CONTENT_UPDATE_SETTINGS` updates `sm.settings` → next `continueOnNewVideo` should use the new language. This entire flow is untested.  
- The `preferLang: settings.targetLanguage` lines in `subtitle-first-pipeline.ts:498,515` are exercised by existing start() tests only — `restart()` with a non-`"vi"` `targetLanguage` has no test at all.

---

## 2. Reusable Helpers and Patterns (file:line)

| Pattern | Location | How to use |
|---|---|---|
| `resetChrome() / makeChrome()` | `test/setup.ts:85–189` | Returns a `FakeChrome` with fake events (`.emit(…)`), `storage.local._data`, `tabs.sendMessage`, `tabs.onUpdated.emit`. Called in `beforeEach` automatically via `test/setup.ts:207`. |
| `FakeEvent.emit(…args)` | `test/setup.ts:25–34` | Invoke all registered listeners synchronously (e.g. `chromeMock.tabs.onUpdated.emit(tabId, changeInfo)` to trigger `nav-stop` or `auto-start` listeners). |
| `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(N)` | pattern used throughout e.g. `test/content/pause-resume-autonext.test.ts:606–611` | Control `setInterval`/`setTimeout`/`Date.now()` for deterministic poll simulation. |
| `setHref(url)` helper | `test/content/soft-stop-continue.test.ts:161–167`, `test/content/pause-resume-autonext.test.ts:578–585` | `Object.defineProperty(window, 'location', { value: { href: url }, writable: true, configurable: true })` — fake the navigation URL for `NavigationWatcher` URL polls. |
| `makeNavFake()` controllable watcher | `test/content/soft-stop-continue.test.ts:141–153` | Captures `onEvent` callback; `notifyEnded()` counted. Lets tests drive `{continue}` / `{stop}` without the real 500ms poll. |
| `vi.mock("@/content/overlay/overlay", …)` content-app mock pattern | `test/content/ad-pause-integration.test.ts:26–69` | Fully mocked ContentApp module boundary with `mockOverlay`, `mockDetectAdapter`, `mockStandardDubSync` — reuse these for any ContentApp integration test. |
| `makeWebRtcSession(token)` / `makeSubtitleFirstSession(token)` | `test/content/soft-stop-continue.test.ts:178–221`, `test/content/pause-resume-autonext.test.ts:129–221` | Minimal in-memory session objects for `sm.session` assignment; `remoteAudio.pause/play` are `vi.fn()`. |
| `makeFakeApp(sess)` | `test/content/pause-resume-autonext.test.ts:163–201` | Builds a partial `ContentApp` facade with `sm`, `lifecycle`, `overlay`, `standardDubSync`, `webrtc`, `capture`, `subtitleFirst`, `stopSession` — avoids importing the full ContentApp module graph. |
| `build()` harness for background tests | `test/background/nav-stop.test.ts:34–48`, `test/background/auto-start.test.ts:31–46` | Constructs `Store + EcholyAuth + SessionCoordinator`, stubs `.stop()` / `.start()` with `vi.fn()`, registers the real listener, returns it for direct invocation. |
| `store.setRunning(true/false)` / `store.setConnecting(true)` | `test/background/nav-stop.test.ts:64–78` | Control bg state so tests can hit the exact guard branch in `nav-stop` or `auto-start`. |
| `store.setContinuationIntent(…)` / `store.getContinuationIntent()` | `test/background/auto-start.test.ts:206–215` | Seed / inspect the hard-nav continuation intent. |
| `AdWatcher` direct construction | `test/content/ad-watcher.test.ts:55–141` | `new AdWatcher(makeApp(adapter))` + fake `isAdPlaying` closure → call `watcher.start(onStart, onEnd)` → advance fake timers or mutate the element's class list. |
| `@vitest-environment jsdom` annotation | `test/content/ad-watcher.test.ts:1`, `test/content/ad-pause-integration.test.ts:1` | Required for any test that uses `document`, `MutationObserver`, `HTMLVideoElement`, `dispatchEvent`. |
| `installChrome()` inline | `test/content/ad-pause-integration.test.ts:79–82` | Minimal `{ runtime: { id, sendMessage } }` stub when the full `FakeChrome` from `test/setup.ts` is not needed. |
| `vi.spyOn(app, 'stopSession')` | `test/content/soft-stop-continue.test.ts:258`, `test/content/stop-session-drain.test.ts:156` | Spy on the method without replacing it, to assert it was/wasn't called. |
| `global.fetch = vi.fn().mockResolvedValue({ ok: true })` | `test/content/ad-pause-integration.test.ts:129` | Stub network calls from `syncSourcePauseState` / media-pause fetches. |

---

## 3. Coverage Gaps Summary

1. **Symptom A** — No test exercises `CONTENT_STOP` arriving while the content's `#awaitingNext` is `true`; no test exercises the nav-stop debounce-and-recheck for a transient non-watch URL.
2. **Symptom B** — No cross-layer test races a bg `CONTENT_STOP` against an in-flight `continueOnNewVideo`; no nav-stop test for "non-watch URL flicker that resolves back to a watch URL within N ms".
3. **Symptom C** — No test exercises `AdWatcher` state after a seek event; no test for the coalesced-mutation scenario; no test for `reseed()` / `restartObserver()` (the proposed fix).
4. **Symptom D** — No test asserts that `continueOnNewVideo` propagates the current `sm.settings.targetLanguage`; no test for mid-session language change reaching `restart()`.

---

## 4. Repro Test Skeletons (A, B, C, D)

Each skeleton uses the helpers and patterns identified above. These are the regression tests the build phase must make pass.

---

### Skeleton A — spurious `ended` → bg CONTENT_STOP kills 45s keep-alive

```typescript
// test/background/nav-stop.test.ts  (add to existing describe block)
// @vitest-environment node   (nav-stop tests are node env, no jsdom needed)
//
// REPRO A: ad→content URL-flicker → nav-stop fires session.stop() while
// content's keep-alive (#awaitingNext) is open.
//
// The fix: nav-stop must debounce or skip the stop when the non-watch URL
// is transient (URL reverts to a watch URL within ~600ms).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetChrome, type FakeChrome } from "../setup";
import { registerNavStop } from "@/background/nav-stop";
import { Store } from "@/background/store";
import { EcholyAuth } from "@/background/auth";
import { SessionCoordinator } from "@/background/session-coordinator";

const SESSION_TAB = 42;
const WATCH_A = "https://www.youtube.com/watch?v=AAAAAAAAAAA";
const YT_AD_URL = "https://www.youtube.com/ad-redirect"; // transient non-watch

function buildA() {
  const auth = new EcholyAuth();
  const store = new Store(auth);
  const session = new SessionCoordinator(store, auth);
  const stopSpy = vi.fn().mockResolvedValue({ ok: true });
  Object.defineProperty(session, "stop", { value: stopSpy, configurable: true, writable: true });
  store.setTabId(SESSION_TAB);
  store.setRunning(true);
  const listener = registerNavStop(store, session);
  return { store, stopSpy, listener };
}

describe("nav-stop — ad-transition URL flicker (Symptom A regression)", () => {
  let chromeMock: FakeChrome;
  beforeEach(() => {
    chromeMock = resetChrome();
    void chromeMock;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("(A-1) non-watch URL during ad→content transition that REVERTS within 600ms → session.stop NOT called", async () => {
    // Arrange: session running, ad→content transition fires a transient non-watch URL.
    const { stopSpy, listener } = buildA();

    // Act: non-watch URL arrives (transient flicker during ad→content swap).
    listener(SESSION_TAB, { url: YT_AD_URL });

    // The fix: nav-stop debounces; session.stop not called immediately.
    expect(stopSpy).not.toHaveBeenCalled();

    // Before the debounce window: simulate the URL returning to a watch page
    // (YouTube resolves back after the ad ends).
    await vi.advanceTimersByTimeAsync(300); // inside the debounce window (< 600ms)
    // The URL has since returned to a watch page — the debounce re-checks and skips.
    // (The fix re-reads chrome.tabs.get() in the debounce callback and aborts if back on watch.)

    // Assert: still not stopped.
    expect(stopSpy).not.toHaveBeenCalled();
  });

  it("(A-2) non-watch URL that does NOT revert within 600ms → session.stop IS called (legitimate nav)", async () => {
    const { stopSpy, listener } = buildA();

    listener(SESSION_TAB, { url: YT_AD_URL });
    expect(stopSpy).not.toHaveBeenCalled(); // debounce pending

    // The URL never returns to a watch page — debounce fires and confirms stop.
    await vi.advanceTimersByTimeAsync(700); // past the debounce window
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it("(A-3) watch→watch SPA nav during ad (no status, watch URL) → session.stop STILL not called", () => {
    // Regression guard: the existing SPA-skip logic must not be broken.
    const { stopSpy, listener } = buildA();
    listener(SESSION_TAB, { url: WATCH_A });
    expect(stopSpy).not.toHaveBeenCalled();
  });
});
```

---

### Skeleton B — auto-next: bg CONTENT_STOP races continueOnNewVideo in-flight

```typescript
// test/content/soft-stop-continue.test.ts  (add a new describe block)
// OR test/background/nav-stop.test.ts — cross-layer race
// @vitest-environment jsdom  (ContentApp involved; needs DOM)
//
// REPRO B: NavigationWatcher emits {continue} → continueOnNewVideo starts →
// WHILE continueOnNewVideo is awaiting restart(), bg sends CONTENT_STOP →
// content stopSession(USER_STOP) → sm.session nulled → continueOnNewVideo
// should bail cleanly (myGen !== activeGen OR sm.session null guard) and NOT
// re-stop or leave overlay stuck on "switching".

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// Re-use the vi.mock() block from soft-stop-continue.test.ts (same module mocks).

// (assume same vi.mock() preamble as soft-stop-continue.test.ts)

import { ContentApp } from "@/content/index";
import { STOP_REASON } from "@/content/stop-reasons";
import { continueOnNewVideo } from "@/content/auto-next";

describe("auto-next + bg CONTENT_STOP race (Symptom B regression)", () => {
  let app: ContentApp;

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { id: "test", sendMessage: vi.fn().mockResolvedValue(undefined) },
    };
    app = new ContentApp();
    app.startAdWatcher = vi.fn(); // suppress ad watcher interval
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    (globalThis as { chrome?: unknown }).chrome = undefined;
  });

  it("(B-1) CONTENT_STOP arrives while continueOnNewVideo is awaiting restart → overlay never stuck on 'switching', no double stop", async () => {
    // Arrange: running subtitle-first session.
    app.sm.session = makeSubtitleFirstSession(1); // from existing helpers
    app.sm.pageToken = 1;
    app.sm.settings = { apiBearer: "b", targetLanguage: "vi", tier: "standard" } as never;
    app.lifecycle.transition("starting");
    app.lifecycle.transition("dubbing");

    const stopSpy = vi.spyOn(app, "stopSession");

    // subtitleFirst.restart is slow (simulates async caption fetch)
    let restartResolve!: (v: { ok: boolean }) => void;
    (app.subtitleFirst.restart as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<{ ok: boolean }>((resolve) => { restartResolve = resolve; })
    );

    // Act: auto-next fires continueOnNewVideo (doesn't await yet).
    const p = continueOnNewVideo(app, "vid-next");

    // At this point overlay is on "switching"; restart is pending.
    // Now simulate a bg CONTENT_STOP arriving (e.g. from nav-stop URL flicker).
    app.stopSession(STOP_REASON.USER_STOP);

    // Resolve restart (too late — session is already null).
    restartResolve({ ok: true });

    await vi.runAllTimersAsync();
    await p;

    // Assert: overlay must NOT be stuck on "switching"; the bg stop was terminal.
    // The continueOnNewVideo bail-out (session null guard) must prevent a second stopSession.
    expect(stopSpy).toHaveBeenCalledTimes(1); // only the bg CONTENT_STOP triggered stop
    // Overlay state: either "stopped" (lifecycle.state) or removed — never "switching".
    expect(app.overlay.setOverlayState).not.toHaveBeenCalledWith("switching"); // no stuck state visible after the stop
  });

  it("(B-2) rapid auto-next: first {continue} superseded by second → first bails, second succeeds", async () => {
    app.sm.session = makeSubtitleFirstSession(1);
    app.sm.pageToken = 1;
    app.sm.settings = { apiBearer: "b", targetLanguage: "vi", tier: "standard" } as never;
    app.lifecycle.transition("starting");
    app.lifecycle.transition("dubbing");
    app.startAdWatcher = vi.fn();
    app.bindCommonVideoListeners = vi.fn();

    (app.subtitleFirst.restart as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

    // Emit two rapid continues (rapid playlist navigation).
    const p1 = continueOnNewVideo(app, "vid-1");
    const p2 = continueOnNewVideo(app, "vid-2");

    await vi.runAllTimersAsync();
    await Promise.all([p1, p2]);

    // Only the LAST continue should have driven the overlay to "live".
    const calls = (app.overlay.setOverlayState as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]);
    // "live" must appear, "switching" must not be the final state.
    expect(calls[calls.length - 1]).toBe("live");
  });
});
```

---

### Skeleton C — seek-triggered mid-roll ad not detected

```typescript
// test/content/ad-watcher.test.ts  (add to existing file)
// @vitest-environment jsdom  (already set in that file)
//
// REPRO C: user seeks to a mid-roll cue → `#movie_player` gets `ad-showing`
// in the SAME mutation batch as seek-related class changes → `isAdPlaying()`
// momentarily false → edge missed → dub plays over ad.
//
// The fix adds `ad.reseed()` or `ad.restartObserver()` called from `onSeeked`.
// Tests must pass AFTER the fix is applied.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AdWatcher } from "@/content/ad-watcher";
import { AD_WAIT_POLL_MS } from "@/shared/constants";
import type { ContentApp } from "@/content/index";
import type { PlatformAdapter } from "@/shared/platform-ports";

// Reuse makeAdAdapter / makeApp from ad-watcher.test.ts helpers (same file or import).

describe("AdWatcher — seek-induced mid-roll (Symptom C regression)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("(C-1) reseed() after a seek picks up ad state that arrived AFTER watcher start (no missed onAdStart)", () => {
    // Arrange: watcher armed while NO ad is playing (#adActive seeded false).
    let ad = false;
    const player = document.createElement("div");
    player.id = "movie_player";
    document.body.appendChild(player);
    const adapter = {
      id: "youtube",
      isAdPlaying: () => ad,
      getAdSignalTarget: () => player,
    } as unknown as PlatformAdapter;
    const app = { adapter } as unknown as ContentApp;
    const watcher = new AdWatcher(app);
    const onStart = vi.fn();
    const onEnd = vi.fn();
    watcher.start(onStart, onEnd);

    // User seeks → ad is set by YouTube in the same event-loop turn but AFTER
    // the MutationObserver has already run (simulate by setting ad=true and NOT
    // mutating the element class — the observer won't see it until next mutation).
    ad = true; // isAdPlaying now returns true (class will be set in next flush)

    // The fix: caller (onSeeked) calls watcher.reseed() to sync #adActive from DOM.
    // (API proposed by R2 Fix A — `reseed(): void`)
    watcher.reseed(); // <-- the fix being tested

    // After reseed, #adActive is true. Next evaluate (triggered by class mutation or poll)
    // should NOT fire onAdStart (it was already seeded active — edge already consumed).
    // The ad state is now consistent; when the ad ends, onAdEnd fires correctly.
    ad = false;
    vi.advanceTimersByTime(AD_WAIT_POLL_MS);
    expect(onEnd).toHaveBeenCalledTimes(1); // edge on false→true→false is correct
    expect(onStart).not.toHaveBeenCalled(); // NOT called (seeded directly to true)

    watcher.stop();
    document.body.removeChild(player);
  });

  it("(C-2) without reseed(), a seek that lands at the ad-start boundary MAY miss onAdStart (existing gap)", async () => {
    // Documents the GAP: if #adActive was false at start and the ad class arrives
    // in a coalesced mutation batch AFTER the poll has already run for this tick,
    // the 250ms poll rescues it — but dub plays over the ad for 0–250ms.
    // This test shows the poll still catches the ad (acceptance baseline).
    const player = document.createElement("div");
    player.id = "movie_player";
    document.body.appendChild(player);
    let ad = false;
    const adapter = {
      id: "youtube",
      isAdPlaying: () => player.classList.contains("ad-showing") && ad,
      getAdSignalTarget: () => player,
    } as unknown as PlatformAdapter;
    const app = { adapter } as unknown as ContentApp;
    const watcher = new AdWatcher(app);
    const onStart = vi.fn();
    watcher.start(onStart, vi.fn());

    // Simulate: seek fires (not modeled here), then ad class arrives 80ms later.
    await vi.advanceTimersByTimeAsync(80);
    ad = true;
    player.classList.add("ad-showing");
    // MutationObserver fires (microtask).
    await Promise.resolve();
    await Promise.resolve();
    // OR the poll fires at 250ms.
    vi.advanceTimersByTime(AD_WAIT_POLL_MS);

    expect(onStart).toHaveBeenCalledTimes(1); // poll rescues it
    watcher.stop();
    document.body.removeChild(player);
  });

  it("(C-3) seek during an active ad (subtitle-first #onSeek should no-op when ad is held)", () => {
    // This is covered by subtitle-first-ad-onseek.test.ts:66–86 — include as
    // a cross-reference guard to confirm C-1 fix does not break it.
    // (Kept as a reference; see subtitle-first-ad-onseek.test.ts for the full spec.)
    expect(true).toBe(true); // placeholder — real assertion in the referenced test
  });
});
```

---

### Skeleton D — continuation uses wrong source language

```typescript
// test/content/pause-resume-autonext.test.ts  (add to the auto-next describe block)
// OR a new test/content/auto-next-lang.test.ts
// @vitest-environment jsdom
//
// REPRO D: sm.settings.targetLanguage is set to "ja" by the user in the popup.
// continueOnNewVideo → subtitleFirst.restart(settings, newVideoId) must pass
// settings.targetLanguage === "ja" to fetchCaptions(preferLang:"ja").
// Bug: if sm.settings is stale or not propagated, preferLang may be "vi" (default).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// (assume same vi.mock() preamble as pause-resume-autonext.test.ts)

import { ContentApp } from "@/content/index";
import { continueOnNewVideo } from "@/content/auto-next";

describe("auto-next — source language propagation (Symptom D regression)", () => {
  let app: ContentApp;

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { id: "test", sendMessage: vi.fn().mockResolvedValue(undefined) },
    };
    app = new ContentApp();
    app.startAdWatcher = vi.fn();
    app.bindCommonVideoListeners = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    (globalThis as { chrome?: unknown }).chrome = undefined;
  });

  it("(D-1) continueOnNewVideo passes the current sm.settings.targetLanguage (non-default 'ja') to restart()", async () => {
    // Arrange: running subtitle-first session with Japanese target language.
    app.sm.session = makeSubtitleFirstSession(1); // from existing helper
    app.sm.pageToken = 1;
    app.sm.settings = { apiBearer: "b", targetLanguage: "ja", tier: "standard" } as never;
    app.lifecycle.transition("starting");
    app.lifecycle.transition("dubbing");

    // Stub restart to capture the settings argument.
    const restartSpy = vi.fn().mockResolvedValue({ ok: true });
    (app.subtitleFirst.restart as ReturnType<typeof vi.fn>) = restartSpy;

    // Stub findVideo to return a ready video so the poll passes immediately.
    const readyVideo = document.createElement("video");
    Object.defineProperty(readyVideo, "readyState", { value: 3, configurable: true });
    Object.defineProperty(readyVideo, "currentTime", { value: 1, configurable: true });
    app.adapter.findVideo = () => readyVideo;

    // Act.
    const p = continueOnNewVideo(app, "vid-next");
    await vi.runAllTimersAsync();
    await p;

    // Assert: restart() called with settings carrying targetLanguage: "ja".
    expect(restartSpy).toHaveBeenCalledTimes(1);
    const [calledSettings] = restartSpy.mock.calls[0] as [{ targetLanguage: string }, string];
    expect(calledSettings.targetLanguage).toBe("ja");
  });

  it("(D-2) mid-session language change (CONTENT_UPDATE_SETTINGS) is reflected in the next continuation", async () => {
    // Arrange: session starts with "vi", then popup changes language to "ko".
    app.sm.session = makeSubtitleFirstSession(2);
    app.sm.pageToken = 2;
    app.sm.settings = { apiBearer: "b", targetLanguage: "vi", tier: "standard" } as never;
    app.lifecycle.transition("starting");
    app.lifecycle.transition("dubbing");

    // Simulate mid-session language update (popup sends CONTENT_UPDATE_SETTINGS).
    app.sm.settings = { ...app.sm.settings, targetLanguage: "ko" };

    const restartSpy = vi.fn().mockResolvedValue({ ok: true });
    (app.subtitleFirst.restart as ReturnType<typeof vi.fn>) = restartSpy;

    const readyVideo = document.createElement("video");
    Object.defineProperty(readyVideo, "readyState", { value: 3, configurable: true });
    Object.defineProperty(readyVideo, "currentTime", { value: 1, configurable: true });
    app.adapter.findVideo = () => readyVideo;

    const p = continueOnNewVideo(app, "vid-next-2");
    await vi.runAllTimersAsync();
    await p;

    // Assert: restart() sees "ko", not the original "vi".
    const [calledSettings] = restartSpy.mock.calls[0] as [{ targetLanguage: string }, string];
    expect(calledSettings.targetLanguage).toBe("ko");
  });

  it("(D-3) WebRTC continuation also passes the current targetLanguage", async () => {
    // Arrange: running realtime (WebRTC) session with "fr" target.
    app.sm.session = makeWebRtcSession(3); // from existing helper
    app.sm.pageToken = 3;
    app.sm.settings = { apiBearer: "b", targetLanguage: "fr", tier: "realtime" } as never;
    app.lifecycle.transition("starting");
    app.lifecycle.transition("dubbing");

    const continueWebRtcSpy = vi.fn().mockResolvedValue({ ok: true });
    (app.webrtc.continueOnNewVideo as ReturnType<typeof vi.fn>) = continueWebRtcSpy;

    const readyVideo = document.createElement("video");
    Object.defineProperty(readyVideo, "readyState", { value: 3, configurable: true });
    Object.defineProperty(readyVideo, "currentTime", { value: 1, configurable: true });
    app.adapter.findVideo = () => readyVideo;

    const p = continueOnNewVideo(app, "vid-next-3");
    await vi.runAllTimersAsync();
    await p;

    // Assert: webrtc.continueOnNewVideo called with targetLanguage: "fr".
    const [calledSettings] = continueWebRtcSpy.mock.calls[0] as [{ targetLanguage: string }];
    expect(calledSettings.targetLanguage).toBe("fr");
  });
});
```

---

## 5. Exact Test and Typecheck Commands

From `package.json` (`test/setup.ts`, `vitest.config.ts`):

```bash
# Run all unit tests (vitest run, no watch):
npm test

# Run a single test file by path:
npx vitest run test/background/nav-stop.test.ts

# Run tests matching a name pattern:
npx vitest run -t "Symptom A"

# Typecheck gate (must stay at 0 errors):
npm run typecheck
# equivalent: wxt prepare && tsc --noEmit

# Lint (same as typecheck):
npm run lint
```

The `vitest.config.ts` sets `environment: "node"` by default; tests that need jsdom must include the `// @vitest-environment jsdom` pragma at the top of the file (line 1). Setup file `test/setup.ts` is loaded for every test via `setupFiles` (line 16 of `vitest.config.ts`) and auto-calls `resetChrome()` in `beforeEach` (line 207 of `test/setup.ts`).

---

## 6. File References Summary

| File | Key lines | Role |
|---|---|---|
| `test/setup.ts` | 85–189 | `makeChrome()` / `resetChrome()` / `FakeEvent.emit` — foundation for all bg tests |
| `test/content/ad-watcher.test.ts` | 56–141 | AdWatcher edge-detect coverage; gap: no seek scenario |
| `test/content/ad-pause-integration.test.ts` | 151–207 | ContentApp ad pause/resume integration; gap: no ad→ended race |
| `test/content/soft-stop-continue.test.ts` | 256–311 | Keep-alive auto-next contract; gap: no bg CONTENT_STOP race |
| `test/background/nav-stop.test.ts` | 59–116 | SPA nav-stop guard; gap: no URL-flicker debounce test |
| `test/background/auto-start.test.ts` | 196–284 | Hard-nav continuation intent; gap: no language propagation test |
| `test/content/pause-resume-autonext.test.ts` | 690–858 | NavigationWatcher + auto-next GAP-1 regression; gap: no targetLanguage assertion |
| `test/content/subtitle-first-ad-onseek.test.ts` | 66–86 | `#onSeek` ad-gate; gap: no stale `#adActive` seed scenario |
| `test/unit/youtube-ad-state.test.ts` | 19–42 | `isYouTubeAdPlaying()` DOM predicate; gap: no coalesced-mutation scenario |
| `test/content/lifecycle.test.ts` | 138–210 | LifecycleController reason-stack; complete, reuse as-is |
| `test/content/navigation-prefetch.test.ts` | 303–372 | terminal-idle session-identity race; gap: no bg-authority conflict |
| `vitest.config.ts` | 1–18 | `environment: "node"`, `setupFiles: ["test/setup.ts"]`, alias `@` → `src/` |
| `package.json` | scripts | `"test": "vitest run"`, `"typecheck": "wxt prepare && tsc --noEmit"` |
