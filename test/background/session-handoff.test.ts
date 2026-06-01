// Web↔extension session-handoff completeness (specs A–E of SOLUTION
// web-ext-session-handoff). Covers: OPEN_SIGNIN pre-check (no redundant sign-in),
// signin-tab dedup/focus, the tabs.onUpdated→/account already-signed-in handoff,
// orphan-tab cleanup (tabs.onRemoved), and storage.session persistence of the
// signin tab id across SW recycles. Uses the hand-rolled chrome.* mock.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { resetChrome, type FakeChrome } from "../setup";
import {
  installAuthListener,
  resetAuthListenerState,
  setSigninTabId,
  getSigninTabId,
  restoreSigninTabId,
} from "@/background/auth-listener";
import { routeMessage, type RouterDeps } from "@/background/router";
import { Store } from "@/background/store";
import { EcholyAuth } from "@/background/auth";
import { SessionCoordinator } from "@/background/session-coordinator";
import type { SignedInUser } from "@/shared/types";

const USER = { id: "u1", email: "a@b.com", tier: "free" } as unknown as SignedInUser;

function buildDeps(): RouterDeps {
  const auth = new EcholyAuth();
  const store = new Store(auth);
  const session = new SessionCoordinator(store, auth);
  return { store, auth, session };
}

/** Drive a popup OPEN_SIGNIN through the router and resolve its response. */
async function openSignin(deps: RouterDeps): Promise<unknown> {
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
  return captured;
}

describe("session-handoff — OPEN_SIGNIN pre-check + tab lifecycle", () => {
  let chromeMock: FakeChrome;
  let deps: RouterDeps;

  beforeEach(() => {
    chromeMock = resetChrome();
    resetAuthListenerState();
    deps = buildDeps();
  });

  // ── Spec A ──────────────────────────────────────────────────────────────────
  it("A: already signed in (store warm) → no tab opened, broadcasts, ok:true", async () => {
    deps.store.state.signedInUser = USER;
    const broadcastSpy = vi.spyOn(deps.store, "broadcast");

    const res = await openSignin(deps);

    expect(res).toEqual({ ok: true });
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
    expect(broadcastSpy).toHaveBeenCalled();
  });

  // ── Spec B ──────────────────────────────────────────────────────────────────
  it("B: store cold but session cookie exists → hydrate, no tab", async () => {
    vi.spyOn(deps.auth, "getSessionToken").mockResolvedValue("tok-xyz");
    // Simulate hydrate populating the user from the shared cookie.
    vi.spyOn(deps.store, "refreshAuth").mockImplementation(async () => {
      deps.store.state.signedInUser = USER;
    });

    const res = await openSignin(deps);

    expect(res).toEqual({ ok: true });
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
    expect(deps.store.state.signedInUser).toBe(USER);
  });

  // ── Spec C ──────────────────────────────────────────────────────────────────
  it("C: signed out → opens tab; second OPEN_SIGNIN focuses it (create once)", async () => {
    // No user, no cookie (getSessionToken → null via default cookies.get).
    chromeMock.tabs.create.mockResolvedValue({ id: 42, windowId: 100 });
    chromeMock.tabs.get.mockResolvedValue({ id: 42, windowId: 100 });

    const first = await openSignin(deps);
    expect(first).toEqual({ ok: true });
    expect(chromeMock.tabs.create).toHaveBeenCalledTimes(1);
    expect(getSigninTabId()).toBe(42);

    const second = await openSignin(deps);
    expect(second).toEqual({ ok: true });
    expect(chromeMock.tabs.create).toHaveBeenCalledTimes(1); // NOT opened again
    expect(chromeMock.tabs.update).toHaveBeenCalledWith(42, { active: true });
    expect(chromeMock.windows.update).toHaveBeenCalledWith(100, { focused: true });
  });

  it("C2: stale tracked tab (tabs.get throws) → clears + opens a fresh tab", async () => {
    chromeMock.tabs.create.mockResolvedValue({ id: 7, windowId: 1 });
    setSigninTabId(999); // points at a closed tab
    chromeMock.tabs.get.mockRejectedValue(new Error("No tab with id: 999"));

    const res = await openSignin(deps);

    expect(res).toEqual({ ok: true });
    expect(chromeMock.tabs.create).toHaveBeenCalledTimes(1);
    expect(getSigninTabId()).toBe(7);
  });

  // ── Spec D ──────────────────────────────────────────────────────────────────
  it("D: signin tab lands on /account + hydrate confirms session → tab closed", async () => {
    vi.spyOn(deps.store, "refreshAuth").mockImplementation(async () => {
      deps.store.state.signedInUser = USER;
    });
    installAuthListener(deps.store, deps.auth);
    setSigninTabId(42);

    chromeMock.tabs.onUpdated.emit(42, { url: "https://echolyhq.com/account" }, {});

    await vi.waitFor(() => expect(chromeMock.tabs.remove).toHaveBeenCalledWith(42));
    expect(getSigninTabId()).toBeNull();
  });

  it("D2: /account but hydrate finds NO session → tab NOT closed (no false-close)", async () => {
    vi.spyOn(deps.store, "refreshAuth").mockImplementation(async () => {
      deps.store.state.signedInUser = null;
    });
    installAuthListener(deps.store, deps.auth);
    setSigninTabId(42);

    chromeMock.tabs.onUpdated.emit(42, { url: "https://echolyhq.com/account" }, {});

    await Promise.resolve();
    await Promise.resolve();
    expect(chromeMock.tabs.remove).not.toHaveBeenCalled();
    expect(getSigninTabId()).toBe(42);
  });

  it("D3: onUpdated ignores a different tab + non-/account url + no-url events", async () => {
    const refreshSpy = vi.spyOn(deps.store, "refreshAuth").mockResolvedValue();
    installAuthListener(deps.store, deps.auth);
    setSigninTabId(42);

    chromeMock.tabs.onUpdated.emit(99, { url: "https://echolyhq.com/account" }, {}); // wrong tab
    chromeMock.tabs.onUpdated.emit(42, { url: "https://echolyhq.com/pricing" }, {}); // wrong path
    chromeMock.tabs.onUpdated.emit(42, { status: "loading" }, {}); // no url

    await Promise.resolve();
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(chromeMock.tabs.remove).not.toHaveBeenCalled();
  });

  // ── Spec E ──────────────────────────────────────────────────────────────────
  it("E: tabs.onRemoved on the signin tab clears the tracked id", async () => {
    installAuthListener(deps.store, deps.auth);
    setSigninTabId(42);

    chromeMock.tabs.onRemoved.emit(42);

    expect(getSigninTabId()).toBeNull();
  });

  it("E2: setSigninTabId persists to storage.session; restore repopulates after SW recycle", async () => {
    setSigninTabId(55);
    expect(chromeMock.storage.session._data["ec_signin_tab_id"]).toBe(55);

    // Simulate an SW recycle: module var lost, storage.session survives.
    resetAuthListenerState();
    expect(getSigninTabId()).toBeNull();

    await restoreSigninTabId();
    expect(getSigninTabId()).toBe(55);

    // Clearing removes the persisted key.
    setSigninTabId(null);
    expect("ec_signin_tab_id" in chromeMock.storage.session._data).toBe(false);
  });
});
