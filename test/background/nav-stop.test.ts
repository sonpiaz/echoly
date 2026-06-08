// nav-stop tests — gates the bg tabs.onUpdated session-stop listener.
//
// FIX 1 (Bug A — auto-next): the listener must NOT call session.stop() on a
// YouTube SPA watch→watch url change while a session is running/connecting (the
// content NavigationWatcher owns that auto-next continuation). It MUST still stop
// on a hard nav (status:"loading"), on leaving the watch context, and on any url
// change while no session is active.
//
// Each spec builds a Store + SessionCoordinator, registers the listener (which
// returns the fn so we can invoke it directly with synthetic onUpdated payloads),
// and spies on session.stop. We assert stop was (or wasn't) called per case.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetChrome, type FakeChrome } from "../setup";
import { registerNavStop, resetNavStopState } from "@/background/nav-stop";
import { Store } from "@/background/store";
import { EcholyAuth } from "@/background/auth";
import { SessionCoordinator } from "@/background/session-coordinator";
import { NAV_STOP_RECHECK_MS } from "@/shared/constants";

type Listener = (tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => void;

interface Harness {
  store: Store;
  session: SessionCoordinator;
  stopSpy: ReturnType<typeof vi.fn>;
  listener: Listener;
}

const SESSION_TAB = 42;
const WATCH_A = "https://www.youtube.com/watch?v=AAAAAAAAAAA";
const WATCH_B = "https://www.youtube.com/watch?v=BBBBBBBBBBB";
const YT_HOME = "https://www.youtube.com/";

function build(): Harness {
  const auth = new EcholyAuth();
  const store = new Store(auth);
  const session = new SessionCoordinator(store, auth);
  // Replace stop with a spy so we never reach the real teardown / chrome relay.
  const stopSpy = vi.fn().mockResolvedValue({ ok: true });
  Object.defineProperty(session, "stop", {
    value: stopSpy,
    configurable: true,
    writable: true,
  });
  // The listener only acts on the tracked session tab.
  store.setTabId(SESSION_TAB);
  const listener = registerNavStop(store, session);
  return { store, session, stopSpy, listener };
}

describe("nav-stop — bg tabs.onUpdated session-stop gating (FIX 1, Bug A auto-next)", () => {
  let chromeMock: FakeChrome;
  beforeEach(() => {
    chromeMock = resetChrome();
    void chromeMock;
    resetNavStopState();
  });

  afterEach(() => {
    resetNavStopState();
  });

  // ── (a) watch→watch SPA url change while running → SKIP the stop ──────────────
  // This is the regression the fix targets. Without the fix the listener called
  // session.stop() here → CONTENT_STOP → killed the very session auto-next needs.
  it("(a) running + SPA watch→watch url change → session.stop NOT called", () => {
    const { store, stopSpy, listener } = build();
    store.setRunning(true);
    // SPA nav: url present, NO status (history.pushState does not set loading).
    listener(SESSION_TAB, { url: WATCH_B });
    expect(stopSpy).not.toHaveBeenCalled();
  });

  it("(a') connecting + SPA watch→watch url change → session.stop NOT called", () => {
    const { store, stopSpy, listener } = build();
    store.setConnecting(true);
    listener(SESSION_TAB, { url: WATCH_B });
    expect(stopSpy).not.toHaveBeenCalled();
  });

  // ── (b) status:"loading" (hard nav) → STOP, even on a watch url ───────────────
  it("(b) running + status:loading on a watch url (hard nav) → session.stop IS called", () => {
    const { store, stopSpy, listener } = build();
    store.setRunning(true);
    listener(SESSION_TAB, { url: WATCH_B, status: "loading" });
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  // ── (c) leaving the watch context while running → STOP ────────────────────────
  it("(c) running + url change to a non-watch (off-platform) url → session.stop IS called (after recheck)", async () => {
    const { store, stopSpy, listener } = build();
    store.setRunning(true);
    vi.useFakeTimers();
    // chrome.tabs.get returns still-non-watch URL at expiry
    chromeMock.tabs.get.mockResolvedValue({ id: SESSION_TAB, url: YT_HOME });
    // YouTube home is a youtube.com url but NOT a watch URL → adapter.isWatchUrl=false.
    listener(SESSION_TAB, { url: YT_HOME });
    // stop is NOT immediate with an active session
    expect(stopSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(NAV_STOP_RECHECK_MS + 50);
    expect(stopSpy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("(c'') running + url change to a non-supported scheme/url → session.stop IS called (after recheck)", async () => {
    const { store, stopSpy, listener } = build();
    store.setRunning(true);
    vi.useFakeTimers();
    // chrome.tabs.get returns still-non-watch URL at expiry
    chromeMock.tabs.get.mockResolvedValue({
      id: SESSION_TAB,
      url: "https://www.youtube.com/results?search_query=x",
    });
    // A chrome:// page is not parseable as a supported watch URL
    // (detectAdapterForUrl → generic, whose isWatchUrl can't apply to a
    // chrome-internal page) → falls through to stop. We use a clearly
    // non-dubbable destination distinct from the YT-home case above.
    listener(SESSION_TAB, { url: "https://www.youtube.com/results?search_query=x" });
    // youtube.com but NOT /watch and NOT /embed → YouTube adapter.isWatchUrl=false → stop.
    expect(stopSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(NAV_STOP_RECHECK_MS + 50);
    expect(stopSpy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  // NOTE on generic platforms: a destination on an UNKNOWN site (e.g. vimeo.com)
  // resolves to the GENERIC adapter whose isWatchUrl() returns true, so leaving a
  // YouTube watch page for a generic site is NOT a stop — the content side may
  // continue on the generic page. The "off-watch → stop" cases that actually fire
  // are leaving the watch CONTEXT on a platform whose adapter rejects the new url
  // (YouTube → home/search/results), which (c) and (c'') above cover.
  it("(c-generic) running + url change to a generic (unknown) site → session.stop NOT called (generic isWatchUrl=true)", () => {
    const { store, stopSpy, listener } = build();
    store.setRunning(true);
    listener(SESSION_TAB, { url: "https://vimeo.com/12345" });
    // Generic adapter treats any unknown page as a watch context → kept, not stopped.
    expect(stopSpy).not.toHaveBeenCalled();
  });

  // ── (d) url change while NOT running/connecting → STOP ────────────────────────
  it("(d) NOT running + watch→watch url change → session.stop IS called", () => {
    const { stopSpy, listener } = build();
    // store.state.running and connecting are both false by default.
    listener(SESSION_TAB, { url: WATCH_B });
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  // ── Guards: wrong tab / no url are ignored entirely ───────────────────────────
  it("ignores onUpdated on a different tab", () => {
    const { store, stopSpy, listener } = build();
    store.setRunning(true);
    listener(99, { url: YT_HOME }); // not the session tab
    expect(stopSpy).not.toHaveBeenCalled();
  });

  it("ignores onUpdated with no url (status-only event)", () => {
    const { store, stopSpy, listener } = build();
    store.setRunning(true);
    listener(SESSION_TAB, { status: "loading" }); // no url
    expect(stopSpy).not.toHaveBeenCalled();
  });

  it("registers the listener with chrome.tabs.onUpdated (real wiring path)", () => {
    const { listener } = build();
    expect(chromeMock.tabs.onUpdated.listeners.has(listener as never)).toBe(true);
  });

  // The starting URL (WATCH_A) is referenced to keep the watch→watch framing
  // explicit; the listener does not read the previous URL (chrome only gives the
  // delta), so the running-guard + isSupportedWatchUrl(new url) IS the SPA signal.
  it("watch→watch is recognised purely from the new url being a watch page", () => {
    const { store, stopSpy, listener } = build();
    store.setRunning(true);
    expect(WATCH_A).not.toBe(WATCH_B);
    listener(SESSION_TAB, { url: WATCH_A }); // even same-ish watch url ⇒ skip
    expect(stopSpy).not.toHaveBeenCalled();
  });

  // ── Hard-nav continuation intent (playlist auto-advance) ──────────────────────
  // On a status:"loading" hard nav to ANOTHER supported watch page while a dub is
  // RUNNING, nav-stop records a continuation intent so auto-start re-dubs the fresh
  // page. It also pre-clears running synchronously so the fresh page's `complete`
  // (Gate-5 !running) is not blocked by stop()'s async running-clear.
  describe("hard-nav continuation intent", () => {
    it("SETS the intent on (status:loading + running + supported watch url)", () => {
      const { store, listener } = build();
      store.setRunning(true);
      listener(SESSION_TAB, { url: WATCH_B, status: "loading" });
      const intent = store.getContinuationIntent();
      expect(intent).not.toBeNull();
      expect(intent?.tabId).toBe(SESSION_TAB);
      expect(typeof intent?.at).toBe("number");
    });

    it("SETS the intent when CONNECTING (mid-connect hard nav) — symmetric with the SPA-skip branch", () => {
      const { store, listener } = build();
      // A dub that is still connecting (CONTENT_START in flight) when the playlist
      // hard-navigates must still continue on the fresh page.
      store.setConnecting(true);
      listener(SESSION_TAB, { url: WATCH_B, status: "loading" });
      expect(store.getContinuationIntent()?.tabId).toBe(SESSION_TAB);
    });

    it("CLEARS the intent (null) when the loading destination is NOT a supported watch url", () => {
      const { store, listener } = build();
      store.setRunning(true);
      // Seed a stale intent to prove the unsupported-destination branch clears it.
      store.setContinuationIntent({ tabId: SESSION_TAB, at: Date.now() });
      // youtube.com home is loading but NOT a watch page → leaving the dub context.
      listener(SESSION_TAB, { url: YT_HOME, status: "loading" });
      expect(store.getContinuationIntent()).toBeNull();
    });

    it("does NOT set the intent when NOT running (even on a watch url hard nav)", () => {
      const { store, listener } = build();
      // running=false by default (e.g. a stray reload with no active dub).
      listener(SESSION_TAB, { url: WATCH_B, status: "loading" });
      expect(store.getContinuationIntent()).toBeNull();
    });

    it("pre-clears running synchronously so Gate-5 won't block the continuation (Gap-3)", () => {
      const { store, listener } = build();
      store.setRunning(true);
      store.setConnecting(true);
      listener(SESSION_TAB, { url: WATCH_B, status: "loading" });
      // session.stop is a spy here (never flips running), so a false here would
      // ONLY come from nav-stop's own synchronous pre-clear — i.e. the fix.
      expect(store.state.running).toBe(false);
      expect(store.state.connecting).toBe(false);
    });

    it("still calls session.stop() on the hard nav (cleanup is not skipped)", () => {
      const { store, stopSpy, listener } = build();
      store.setRunning(true);
      listener(SESSION_TAB, { url: WATCH_B, status: "loading" });
      expect(stopSpy).toHaveBeenCalledTimes(1);
    });
  });
});

// ── Fix B — deferred-stop re-check tests ──────────────────────────────────────
// These specs cover the new deferred stop mechanism added to the SPA non-watch
// branch. All use fake timers to control the NAV_STOP_RECHECK_MS window.

describe("nav-stop — Fix B deferred-stop re-check (B1/B1b/B3/B4/B2)", () => {
  let chromeMock: FakeChrome;

  beforeEach(() => {
    chromeMock = resetChrome();
    resetNavStopState();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetNavStopState();
  });

  // B1 — active session + transient non-watch URL: before expiry a new onUpdated
  // arrives with a watch URL for the same tab → session.stop MUST NOT be called.
  it("B1: active session + transient non-watch → watch URL arrives before expiry → stop NOT called", async () => {
    const { store, stopSpy, listener } = build();
    store.setRunning(true);
    store.setTabId(SESSION_TAB);

    // Trigger the deferred-stop path: SPA nav to non-watch URL.
    listener(SESSION_TAB, { url: YT_HOME });
    expect(stopSpy).not.toHaveBeenCalled();

    // Before expiry, a watch URL arrives for the same tab (transient resolved).
    listener(SESSION_TAB, { url: WATCH_A });
    expect(stopSpy).not.toHaveBeenCalled();

    // Advance past the window — the timer was cancelled; stop must STILL not fire.
    await vi.advanceTimersByTimeAsync(NAV_STOP_RECHECK_MS + 100);
    expect(stopSpy).not.toHaveBeenCalled();
  });

  // B1b — active session + non-watch URL; at expiry chrome.tabs.get returns a
  // WATCH url → session.stop MUST NOT be called (tab recovered).
  it("B1b: active session + non-watch → at expiry tabs.get returns watch URL → stop NOT called", async () => {
    const { store, stopSpy, listener } = build();
    store.setRunning(true);
    store.setTabId(SESSION_TAB);

    // chrome.tabs.get will return a watch URL at expiry.
    chromeMock.tabs.get.mockResolvedValue({ id: SESSION_TAB, url: WATCH_A });

    listener(SESSION_TAB, { url: YT_HOME });
    expect(stopSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(NAV_STOP_RECHECK_MS + 50);
    expect(stopSpy).not.toHaveBeenCalled();
  });

  // B3 — active session + non-watch URL; at expiry chrome.tabs.get returns a
  // non-watch URL (still left the context) → session.stop IS called.
  it("B3: active session + non-watch → at expiry tabs.get still non-watch → stop IS called", async () => {
    const { store, stopSpy, listener } = build();
    store.setRunning(true);
    store.setTabId(SESSION_TAB);

    // chrome.tabs.get still returns the non-watch URL at expiry.
    chromeMock.tabs.get.mockResolvedValue({ id: SESSION_TAB, url: YT_HOME });

    listener(SESSION_TAB, { url: YT_HOME });
    expect(stopSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(NAV_STOP_RECHECK_MS + 50);
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  // B4 — active session on tab A schedules a deferred stop; before expiry
  // store.state.tabId changes (different session) → at expiry stop NOT called.
  it("B4: tabId changes before expiry → stale deferred-stop does NOT call stop", async () => {
    const { store, stopSpy, listener } = build();
    store.setRunning(true);
    store.setTabId(SESSION_TAB);

    // chrome.tabs.get returns the non-watch URL at expiry (URL not recovered).
    chromeMock.tabs.get.mockResolvedValue({ id: SESSION_TAB, url: YT_HOME });

    listener(SESSION_TAB, { url: YT_HOME });
    expect(stopSpy).not.toHaveBeenCalled();

    // Simulate a different session taking over (different tabId).
    store.setTabId(99);

    await vi.advanceTimersByTimeAsync(NAV_STOP_RECHECK_MS + 50);
    // The stale-guard sees store.state.tabId !== SESSION_TAB → no stop.
    expect(stopSpy).not.toHaveBeenCalled();
  });

  // B2 — regression: hard nav (status:"loading") to a watch URL still stops
  // immediately and sets continuation intent (hard-nav branch is UNCHANGED).
  it("B2: hard nav status:loading to watch url → immediate stop + continuation intent (unchanged)", () => {
    const { store, stopSpy, listener } = build();
    store.setRunning(true);
    store.setTabId(SESSION_TAB);

    listener(SESSION_TAB, { url: WATCH_B, status: "loading" });

    // Hard nav: stop is immediate (no deferred timer involved).
    expect(stopSpy).toHaveBeenCalledTimes(1);
    const intent = store.getContinuationIntent();
    expect(intent).not.toBeNull();
    expect(intent?.tabId).toBe(SESSION_TAB);
  });

  // Additional: tab gone at expiry (chrome.tabs.get throws) → stop IS called.
  it("tab removed before expiry (tabs.get throws) → stop IS called for cleanup", async () => {
    const { store, stopSpy, listener } = build();
    store.setRunning(true);
    store.setTabId(SESSION_TAB);

    chromeMock.tabs.get.mockRejectedValue(new Error("No tab with id: 42"));

    listener(SESSION_TAB, { url: YT_HOME });
    expect(stopSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(NAV_STOP_RECHECK_MS + 50);
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  // Additional: session ends before expiry (running→false) → stop NOT called.
  it("session ends via another path before expiry → stop NOT called (not running at expiry)", async () => {
    const { store, stopSpy, listener } = build();
    store.setRunning(true);
    store.setTabId(SESSION_TAB);

    chromeMock.tabs.get.mockResolvedValue({ id: SESSION_TAB, url: YT_HOME });

    listener(SESSION_TAB, { url: YT_HOME });
    expect(stopSpy).not.toHaveBeenCalled();

    // Session ended via another path before the timer fires.
    store.setRunning(false);
    store.setConnecting(false);

    await vi.advanceTimersByTimeAsync(NAV_STOP_RECHECK_MS + 50);
    // The stale-guard sees !running && !connecting → no stop.
    expect(stopSpy).not.toHaveBeenCalled();
  });

  // Additional: hard nav clears a pending deferred stop (real nav supersedes transient check).
  it("hard nav after deferred-stop scheduled → clears the pending timer (no double-stop)", async () => {
    const { store, stopSpy, listener } = build();
    store.setRunning(true);
    store.setTabId(SESSION_TAB);

    chromeMock.tabs.get.mockResolvedValue({ id: SESSION_TAB, url: YT_HOME });

    // First: schedule a deferred stop.
    listener(SESSION_TAB, { url: YT_HOME });
    expect(stopSpy).not.toHaveBeenCalled();

    // Before expiry: hard nav arrives → immediate stop + clears the pending timer.
    store.setRunning(true); // re-arm running for the hard-nav check
    listener(SESSION_TAB, { url: WATCH_B, status: "loading" });
    expect(stopSpy).toHaveBeenCalledTimes(1);

    // Advance past the original deferred window — it was cleared, so no second stop.
    await vi.advanceTimersByTimeAsync(NAV_STOP_RECHECK_MS + 100);
    expect(stopSpy).toHaveBeenCalledTimes(1); // still only 1
  });
});
