// auto-start tests — gates the listener against accidental session starts.
// Each spec sets up a Store + SessionCoordinator, registers the listener, then
// invokes it directly with synthetic chrome.tabs.onUpdated payloads. We assert
// session.start was (or wasn't) called.
//
// Per-tab debounce is deterministic via vi.useFakeTimers + Date.now() control.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetChrome, type FakeChrome } from "../setup";
import {
  registerAutoStart,
  resetAutoStartState,
} from "@/background/auto-start";
import { Store } from "@/background/store";
import { EcholyAuth } from "@/background/auth";
import { SessionCoordinator } from "@/background/session-coordinator";

type Listener = (
  tabId: number,
  changeInfo: chrome.tabs.TabChangeInfo,
  tab: chrome.tabs.Tab,
) => void;

interface Harness {
  store: Store;
  session: SessionCoordinator;
  startSpy: ReturnType<typeof vi.fn>;
  listener: Listener;
}

function build(): Harness {
  const auth = new EcholyAuth();
  const store = new Store(auth);
  const session = new SessionCoordinator(store, auth);
  // Replace start with a spy so we never reach the real activeYouTubeTab().
  const startSpy = vi
    .fn()
    .mockResolvedValue({ ok: true, state: store.snapshot() });
  Object.defineProperty(session, "start", {
    value: startSpy,
    configurable: true,
    writable: true,
  });
  const listener = registerAutoStart(store, session);
  return { store, session, startSpy, listener };
}

function signIn(store: Store): void {
  store.setSignedInUser({ email: "u@e.com", tier: "max" });
}

function enableHost(store: Store, host: string): void {
  store.state.advanced = {
    ...store.state.advanced,
    autoStartHosts: { ...store.state.advanced.autoStartHosts, [host]: true },
  };
}

const YT_TAB = {
  id: 42,
  url: "https://www.youtube.com/watch?v=abc",
} as chrome.tabs.Tab;

describe("auto-start — chrome.tabs.onUpdated gating", () => {
  let chromeMock: FakeChrome;
  beforeEach(() => {
    chromeMock = resetChrome();
    void chromeMock;
    resetAutoStartState();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("happy path — signed in + host enabled + complete + YT url → start called once", () => {
    const { store, startSpy, listener } = build();
    signIn(store);
    enableHost(store, "youtube.com");

    listener(42, { status: "complete" }, YT_TAB);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledWith({});
  });

  it("flag off → no call", () => {
    const { store, startSpy, listener } = build();
    signIn(store);
    // autoStartHosts has no entry for youtube.com
    listener(42, { status: "complete" }, YT_TAB);
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("not signed in → no call (even with host enabled)", () => {
    const { store, startSpy, listener } = build();
    enableHost(store, "youtube.com");
    listener(42, { status: "complete" }, YT_TAB);
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("wrong host (vimeo) → no call", () => {
    const { store, startSpy, listener } = build();
    signIn(store);
    enableHost(store, "youtube.com");
    listener(
      42,
      { status: "complete" },
      { id: 42, url: "https://vimeo.com/12345" } as chrome.tabs.Tab,
    );
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("YT homepage (no /watch) → no call (we only auto-start on watch URLs)", () => {
    const { store, startSpy, listener } = build();
    signIn(store);
    enableHost(store, "youtube.com");
    listener(
      42,
      { status: "complete" },
      { id: 42, url: "https://www.youtube.com/" } as chrome.tabs.Tab,
    );
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("status=loading → no call (gates on complete only)", () => {
    const { store, startSpy, listener } = build();
    signIn(store);
    enableHost(store, "youtube.com");
    listener(42, { status: "loading" }, YT_TAB);
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("already running → no call (no chain-start)", () => {
    const { store, startSpy, listener } = build();
    signIn(store);
    enableHost(store, "youtube.com");
    store.setRunning(true);
    listener(42, { status: "complete" }, YT_TAB);
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("connecting → no call", () => {
    const { store, startSpy, listener } = build();
    signIn(store);
    enableHost(store, "youtube.com");
    store.setConnecting(true);
    listener(42, { status: "complete" }, YT_TAB);
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("debounces multiple complete events on the same tab (SPA URL change storm)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const { store, startSpy, listener } = build();
    signIn(store);
    enableHost(store, "youtube.com");

    listener(42, { status: "complete" }, YT_TAB);
    expect(startSpy).toHaveBeenCalledTimes(1);

    // Second fire inside the debounce window: blocked. Reset running so we
    // measure the debounce gate, not the running gate.
    vi.setSystemTime(10_500);
    store.setRunning(false);
    listener(42, { status: "complete" }, YT_TAB);
    expect(startSpy).toHaveBeenCalledTimes(1);

    // After the window: fires again.
    vi.setSystemTime(12_000);
    store.setRunning(false);
    listener(42, { status: "complete" }, YT_TAB);
    expect(startSpy).toHaveBeenCalledTimes(2);
  });

  it("normalizes www. prefix when matching autoStartHosts", () => {
    const { store, startSpy, listener } = build();
    signIn(store);
    // user enabled "youtube.com" but the URL is "www.youtube.com" — must match.
    enableHost(store, "youtube.com");
    listener(
      42,
      { status: "complete" },
      { id: 42, url: "https://www.youtube.com/watch?v=z" } as chrome.tabs.Tab,
    );
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it("registers the listener with chrome.tabs.onUpdated (real wiring path)", () => {
    const { listener } = build();
    expect(chromeMock.tabs.onUpdated.listeners.has(listener as never)).toBe(
      true,
    );
  });

  // ── Hard-nav continuation: bypass Gate-4 for a fresh same-tab intent ──────────
  // After a playlist auto-advance hard nav, nav-stop recorded {tabId, at}. The
  // fresh page's `complete` must auto-continue the dub EVEN on a host the user
  // never opted into via autoStartHosts — but only Gate-4 is bypassed; Gates
  // 1/2/3/5 + the per-tab debounce still apply, and the intent is consumed once.
  describe("hard-nav continuation (Gate-4 bypass)", () => {
    it("BYPASSES Gate-4 — start fires on a host NOT in autoStartHosts when a fresh same-tab intent exists", () => {
      const { store, startSpy, listener } = build();
      signIn(store);
      // NB: host (youtube.com) is NOT enabled — normally Gate-4 would reject.
      store.setContinuationIntent({ tabId: 42, at: Date.now() });
      listener(42, { status: "complete" }, YT_TAB);
      expect(startSpy).toHaveBeenCalledTimes(1);
      expect(startSpy).toHaveBeenCalledWith({});
    });

    it("IGNORES an expired intent (> CONTINUATION_WINDOW_MS) → falls back to Gate-4 (no host → no call)", () => {
      vi.useFakeTimers();
      vi.setSystemTime(100_000);
      const { store, startSpy, listener } = build();
      signIn(store);
      // Intent recorded 13s ago — outside the 12s window.
      store.setContinuationIntent({ tabId: 42, at: 100_000 - 13_000 });
      listener(42, { status: "complete" }, YT_TAB);
      expect(startSpy).not.toHaveBeenCalled();
    });

    it("IGNORES a wrong-tabId intent → falls back to Gate-4 (no host → no call)", () => {
      const { store, startSpy, listener } = build();
      signIn(store);
      // Intent for a DIFFERENT tab (99); the complete is for tab 42.
      store.setContinuationIntent({ tabId: 99, at: Date.now() });
      listener(42, { status: "complete" }, YT_TAB);
      expect(startSpy).not.toHaveBeenCalled();
    });

    it("CONSUMES the intent once — a second complete for the same tab does NOT start again", () => {
      vi.useFakeTimers();
      vi.setSystemTime(50_000);
      const { store, startSpy, listener } = build();
      signIn(store);
      store.setContinuationIntent({ tabId: 42, at: 50_000 });

      listener(42, { status: "complete" }, YT_TAB);
      expect(startSpy).toHaveBeenCalledTimes(1);
      expect(store.getContinuationIntent()).toBeNull(); // consumed

      // A second complete past the debounce window: intent is gone, host not
      // enabled → Gate-4 now rejects, so NO second start.
      vi.setSystemTime(52_000);
      store.setRunning(false);
      store.setConnecting(false);
      listener(42, { status: "complete" }, YT_TAB);
      expect(startSpy).toHaveBeenCalledTimes(1);
    });

    it("does NOT consume the intent when an earlier gate early-returns (wrong url)", () => {
      const { store, startSpy, listener } = build();
      signIn(store);
      store.setContinuationIntent({ tabId: 42, at: Date.now() });
      // Gate-2 (watch-url) fails on YT home → early return BEFORE the intent peek.
      listener(
        42,
        { status: "complete" },
        { id: 42, url: "https://www.youtube.com/" } as chrome.tabs.Tab,
      );
      expect(startSpy).not.toHaveBeenCalled();
      expect(store.getContinuationIntent()).not.toBeNull(); // still pending
    });

    it("does NOT consume the intent when signed out (Gate-3 early-returns)", () => {
      const { store, startSpy, listener } = build();
      // NOT signed in → Gate-3 rejects before the intent is consumed.
      store.setContinuationIntent({ tabId: 42, at: Date.now() });
      listener(42, { status: "complete" }, YT_TAB);
      expect(startSpy).not.toHaveBeenCalled();
      expect(store.getContinuationIntent()).not.toBeNull(); // still pending
    });

    it("still honours Gate-5 — a fresh intent does NOT start when already running", () => {
      const { store, startSpy, listener } = build();
      signIn(store);
      store.setContinuationIntent({ tabId: 42, at: Date.now() });
      store.setRunning(true);
      listener(42, { status: "complete" }, YT_TAB);
      expect(startSpy).not.toHaveBeenCalled();
      // Gate-5 returns before the consume point → intent untouched.
      expect(store.getContinuationIntent()).not.toBeNull();
    });
  });
});
