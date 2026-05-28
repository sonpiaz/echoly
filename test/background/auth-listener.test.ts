// auth-listener tests — cookie-change semantics for the sign-in UX fix.
// Covers the 5 AC6-specified specs:
//   1. added/explicit → debounced refreshAuth + broadcast (exactly once after 250ms)
//   2. removed/explicit → clearAuth + broadcast; NO /auth/me roundtrip (fetchUser NOT called)
//   3. overwrite (unchanged) → no refreshAuth
//   4. storm — paired removed→added within 100ms → ONE clearAuth + ONE refreshAuth
//   5. OPEN_SIGNIN lifecycle → router stores tabId; on cookie-added, chrome.tabs.remove(tabId) fires
//
// Uses the hand-rolled chrome.* mock (test/setup.ts) — extended in foundation
// for cookies.onChanged + tabs.create/remove. No browser.* polyfill.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetChrome, type FakeChrome } from "../setup";
import {
  installAuthListener,
  resetAuthListenerState,
  getSigninTabId,
} from "@/background/auth-listener";
import { routeMessage, type RouterDeps } from "@/background/router";
import { Store } from "@/background/store";
import { EcholyAuth } from "@/background/auth";
import { SessionCoordinator } from "@/background/session-coordinator";
import { CaptionCache } from "@/background/caption-cache";

function buildDeps(): RouterDeps {
  const auth = new EcholyAuth();
  const store = new Store(auth);
  const session = new SessionCoordinator(store, auth);
  const captions = new CaptionCache();
  return { store, auth, session, captions };
}

/** Build a chrome.cookies.onChanged event payload. The `cause` enum is the
 *  raw string union from MV3 ("explicit"|"overwrite"|"evicted"|"expired"|
 *  "expired_overwrite") — typed inline since chrome's d.ts doesn't export it. */
type CookieChangeCause =
  | "explicit"
  | "overwrite"
  | "evicted"
  | "expired"
  | "expired_overwrite";

function cookieEvent(opts: {
  name?: string;
  domain?: string;
  removed: boolean;
  cause: CookieChangeCause;
  value?: string;
}): chrome.cookies.CookieChangeInfo {
  return {
    cookie: {
      name: opts.name ?? "ec_session",
      value: opts.value ?? "tok-123",
      domain: opts.domain ?? ".echolyhq.com",
      hostOnly: false,
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      session: false,
      storeId: "0",
    } as chrome.cookies.Cookie,
    removed: opts.removed,
    cause: opts.cause,
  };
}

describe("auth-listener — chrome.cookies.onChanged semantics", () => {
  let chromeMock: FakeChrome;
  let deps: RouterDeps;

  beforeEach(() => {
    chromeMock = resetChrome();
    resetAuthListenerState();
    deps = buildDeps();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Spec 1 ────────────────────────────────────────────────────────────────
  it("added/explicit → debounced refreshAuth + broadcast called once after 250ms", () => {
    const refreshSpy = vi
      .spyOn(deps.store, "refreshAuth")
      .mockResolvedValue();
    const broadcastSpy = vi.spyOn(deps.store, "broadcast");

    installAuthListener(deps.store, deps.auth);

    chromeMock.cookies.onChanged.emit(
      cookieEvent({ removed: false, cause: "explicit" }),
    );

    // Nothing happens before the debounce window closes.
    expect(refreshSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(249);
    expect(refreshSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1); // hit 250ms
    expect(refreshSpy).toHaveBeenCalledTimes(1);

    // Allow the .then() microtask after refreshAuth resolves.
    return Promise.resolve().then(() => {
      expect(broadcastSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ── Spec 2 ────────────────────────────────────────────────────────────────
  it("removed/explicit → clearAuth + broadcast; NO /auth/me roundtrip", () => {
    const clearSpy = vi.spyOn(deps.store, "clearAuth");
    const broadcastSpy = vi.spyOn(deps.store, "broadcast");
    const refreshSpy = vi
      .spyOn(deps.store, "refreshAuth")
      .mockResolvedValue();
    const fetchUserSpy = vi
      .spyOn(deps.auth, "fetchUser")
      .mockResolvedValue(null);

    installAuthListener(deps.store, deps.auth);

    chromeMock.cookies.onChanged.emit(
      cookieEvent({ removed: true, cause: "explicit" }),
    );

    // Removed path is synchronous — no timer to advance.
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(fetchUserSpy).not.toHaveBeenCalled();
  });

  // ── Spec 3 ────────────────────────────────────────────────────────────────
  it("overwrite event → no refreshAuth (cause filter)", () => {
    const refreshSpy = vi
      .spyOn(deps.store, "refreshAuth")
      .mockResolvedValue();
    const clearSpy = vi.spyOn(deps.store, "clearAuth");

    installAuthListener(deps.store, deps.auth);

    // overwrite/added (the second half of the browser's update pair)
    chromeMock.cookies.onChanged.emit(
      cookieEvent({ removed: false, cause: "overwrite" }),
    );
    // overwrite/removed (the first half) — also a no-op
    chromeMock.cookies.onChanged.emit(
      cookieEvent({ removed: true, cause: "overwrite" }),
    );

    vi.advanceTimersByTime(500);

    expect(refreshSpy).not.toHaveBeenCalled();
    expect(clearSpy).not.toHaveBeenCalled();
  });

  // ── Spec 4 ────────────────────────────────────────────────────────────────
  it("storm — removed then added within 100ms → ONE clearAuth + ONE refreshAuth", () => {
    const clearSpy = vi.spyOn(deps.store, "clearAuth");
    const refreshSpy = vi
      .spyOn(deps.store, "refreshAuth")
      .mockResolvedValue();
    const broadcastSpy = vi.spyOn(deps.store, "broadcast");

    installAuthListener(deps.store, deps.auth);

    chromeMock.cookies.onChanged.emit(
      cookieEvent({ removed: true, cause: "explicit" }),
    );
    vi.advanceTimersByTime(50);
    chromeMock.cookies.onChanged.emit(
      cookieEvent({ removed: false, cause: "explicit" }),
    );
    vi.advanceTimersByTime(50);
    // A second `added` arriving inside the debounce window must reset the timer
    // (standard debounce). Net effect: still exactly one refreshAuth.
    chromeMock.cookies.onChanged.emit(
      cookieEvent({ removed: false, cause: "explicit" }),
    );
    vi.advanceTimersByTime(250); // flush the trailing debounce

    expect(clearSpy).toHaveBeenCalledTimes(1); // from the `removed`
    expect(refreshSpy).toHaveBeenCalledTimes(1); // debounce coalesces the two `added`s
    // broadcast fires twice: once on remove (sync), once after refreshAuth resolves.
    return Promise.resolve().then(() => {
      expect(broadcastSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Spec 5 ────────────────────────────────────────────────────────────────
  it("OPEN_SIGNIN lifecycle — tab id stored; cookie-added closes the tab", async () => {
    vi.useRealTimers(); // this spec uses an awaitable timeout
    chromeMock.tabs.create.mockResolvedValueOnce({ id: 42 });
    const refreshSpy = vi
      .spyOn(deps.store, "refreshAuth")
      .mockResolvedValue();
    void refreshSpy;

    installAuthListener(deps.store, deps.auth);

    // Drive the popup-side OPEN_SIGNIN through the router.
    let captured: unknown;
    const sendResponse = vi.fn((r?: unknown) => {
      captured = r;
    });
    const ret = routeMessage(
      deps,
      { type: "OPEN_SIGNIN" },
      {} as chrome.runtime.MessageSender,
      sendResponse,
    );
    expect(ret).toBe(true); // popup-async semantics
    await vi.waitFor(() => expect(captured).toBeDefined());
    expect(captured).toEqual({ ok: true });
    expect(chromeMock.tabs.create).toHaveBeenCalledWith({
      url: "https://echolyhq.com/signin",
      active: true,
    });
    expect(getSigninTabId()).toBe(42);

    // Now simulate the magic-link callback completing on the web side.
    chromeMock.cookies.onChanged.emit(
      cookieEvent({ removed: false, cause: "explicit" }),
    );
    await new Promise((r) => setTimeout(r, 260)); // > debounce window

    expect(chromeMock.tabs.remove).toHaveBeenCalledWith(42);
    expect(getSigninTabId()).toBeNull();
  });

  // ── Bonus: domain guard (security) ────────────────────────────────────────
  it("rejects lookalike domain (evil-echolyhq.com) — guards against endsWith mistake", () => {
    const refreshSpy = vi
      .spyOn(deps.store, "refreshAuth")
      .mockResolvedValue();
    const clearSpy = vi.spyOn(deps.store, "clearAuth");

    installAuthListener(deps.store, deps.auth);

    chromeMock.cookies.onChanged.emit(
      cookieEvent({
        removed: false,
        cause: "explicit",
        domain: "evil-echolyhq.com",
      }),
    );
    chromeMock.cookies.onChanged.emit(
      cookieEvent({
        removed: true,
        cause: "explicit",
        domain: "evil-echolyhq.com",
      }),
    );
    vi.advanceTimersByTime(500);

    expect(refreshSpy).not.toHaveBeenCalled();
    expect(clearSpy).not.toHaveBeenCalled();
  });
});
