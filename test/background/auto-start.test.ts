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
});
