// Message-router dispatch — MV3 channel semantics and popup → session wiring.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetHydrateSignedInState } from "@/background/hydrate-signed-in";
import type { SettingsClient } from "@/background/settings-client";
import { resetChrome, type FakeChrome } from "../setup";
import {
  routeMessage,
  handleContentEvent,
  type RouterDeps,
} from "@/background/router";
import { Store } from "@/background/store";
import { EcholyAuth } from "@/background/auth";
import { SessionCoordinator } from "@/background/session-coordinator";
import { TIER_STANDARD } from "@/shared/constants";
import type { ToBackgroundMessage } from "@/shared/protocol";

const CONTENT_SENDER: chrome.runtime.MessageSender = {
  tab: { id: 7 } as chrome.tabs.Tab,
};
const POPUP_SENDER: chrome.runtime.MessageSender = {};

function buildDeps(): RouterDeps {
  const auth = new EcholyAuth();
  const store = new Store(auth);
  const session = new SessionCoordinator(store, auth);
  return { store, auth, session };
}

function route(
  deps: RouterDeps,
  message: ToBackgroundMessage,
  sender: chrome.runtime.MessageSender,
): { ret: boolean; response: () => unknown } {
  let captured: unknown;
  const sendResponse = vi.fn((r?: unknown) => {
    captured = r;
  });
  const ret = routeMessage(deps, message, sender, sendResponse);
  return { ret, response: () => captured };
}

describe("routeMessage — channel semantics (sender.tab pivot)", () => {
  let deps: RouterDeps;
  beforeEach(() => {
    resetChrome();
    deps = buildDeps();
  });

  it("popup message returns true (keeps channel open for async sendResponse)", () => {
    const { ret } = route(deps, { type: "STOP" }, POPUP_SENDER);
    expect(ret).toBe(true);
  });

  it("content event returns false (sync ack, no channel leak)", () => {
    const { ret, response } = route(
      deps,
      { type: "CONTENT_STATE", running: true },
      CONTENT_SENDER,
    );
    expect(ret).toBe(false);
    expect(response()).toEqual({ ok: true });
  });

  it("GET_LAUNCH_STATE (content) reports signed-out and keeps SW warm (sync)", () => {
    const { ret, response } = route(deps, { type: "GET_LAUNCH_STATE" }, CONTENT_SENDER);
    expect(ret).toBe(false);
    // R1: response now includes `tier` so the launcher can gate the pre-warm hover.
    const result = response() as { ok: boolean; signedIn: boolean; tier?: string };
    expect(result.ok).toBe(true);
    expect(result.signedIn).toBe(false);
    expect(typeof result.tier).toBe("string"); // tier is always present
  });

  it("GET_LAUNCH_STATE (content) reports signed-in when a user is present", () => {
    deps.store.setSignedInUser({ email: "u@x.com" } as never);
    const { response } = route(deps, { type: "GET_LAUNCH_STATE" }, CONTENT_SENDER);
    // R1: includes tier alongside signedIn.
    const result = response() as { ok: boolean; signedIn: boolean; tier?: string };
    expect(result.ok).toBe(true);
    expect(result.signedIn).toBe(true);
    expect(typeof result.tier).toBe("string");
  });

  it("START_REQUEST (launcher) runs the same start path as the popup", () => {
    const startSpy = vi.spyOn(deps.session, "start").mockResolvedValue({ ok: true } as never);
    const { ret, response } = route(deps, { type: "START_REQUEST" }, CONTENT_SENDER);
    expect(ret).toBe(false); // sync ack
    expect(response()).toEqual({ ok: true });
    expect(startSpy).toHaveBeenCalledTimes(1);
  });
});

describe("routeMessage — popup dispatch reaches the right handler", () => {
  let deps: RouterDeps;
  let chromeMock: FakeChrome;
  beforeEach(() => {
    chromeMock = resetChrome();
    deps = buildDeps();
  });

  afterEach(() => {
    resetHydrateSignedInState();
  });

  it("GET_STATE → replies {ok:true, state} immediately (fire-and-forget hydration)", async () => {
    // W5 contract: GET_STATE returns the local snapshot without waiting for
    // network hydration. sendResponse is called after loadSettings +
    // refreshActiveSite (both local). hydrateSignedIn is fire-and-forget.
    vi.spyOn(deps.store, "refreshAuth").mockResolvedValue();

    let captured: unknown;
    const sendResponse = vi.fn((r?: unknown) => {
      captured = r;
    });
    const ret = routeMessage(deps, { type: "GET_STATE" }, POPUP_SENDER, sendResponse);
    expect(ret).toBe(true);

    // Wait for the async GET_STATE handler to complete (loadSettings + refreshActiveSite).
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    const reply = captured as { ok: boolean; state: object };
    expect(reply.ok).toBe(true);
    expect(reply.state).toBeDefined();
  });

  it("GET_STATE → does NOT wait for network: returns before refreshAuth resolves", async () => {
    // Prove the fire-and-forget contract: sendResponse is called even if
    // refreshAuth is never resolved (blocked promise).
    let resolveRefreshAuth!: () => void;
    vi.spyOn(deps.store, "refreshAuth").mockReturnValue(
      new Promise<void>((r) => { resolveRefreshAuth = r; }),
    );

    let captured: unknown;
    const sendResponse = vi.fn((r?: unknown) => { captured = r; });
    routeMessage(deps, { type: "GET_STATE" }, POPUP_SENDER, sendResponse);

    // sendResponse IS called even though refreshAuth never resolves.
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    expect((captured as { ok?: boolean })?.ok).toBe(true);
    // Unblock the pending refreshAuth to avoid dangling promise leaks.
    resolveRefreshAuth();
  });
});

// ── Hard-nav continuation intent is cleared on a genuine user Stop ────────────
describe("routeMessage / handleContentEvent — user Stop clears continuation intent", () => {
  let deps: RouterDeps;
  beforeEach(() => {
    resetChrome();
    deps = buildDeps();
    // Spy stop so the real teardown / chrome relay is never reached.
    vi.spyOn(deps.session, "stop").mockResolvedValue({ ok: true } as never);
  });

  it("popup STOP clears a pending continuation intent before stopping", () => {
    deps.store.setContinuationIntent({ tabId: 7, at: Date.now() });
    route(deps, { type: "STOP" }, POPUP_SENDER);
    expect(deps.store.getContinuationIntent()).toBeNull();
    expect(deps.session.stop).toHaveBeenCalledTimes(1);
  });

  it("on-page CONTENT_STOP_REQUEST clears a pending continuation intent before stopping", () => {
    deps.store.setContinuationIntent({ tabId: 7, at: Date.now() });
    handleContentEvent(deps, { type: "CONTENT_STOP_REQUEST" });
    expect(deps.store.getContinuationIntent()).toBeNull();
    expect(deps.session.stop).toHaveBeenCalledTimes(1);
  });
});

describe("handleContentEvent — UPDATE_SETTINGS", () => {
  it("forwards settings patch to session coordinator", () => {
    const auth = new EcholyAuth();
    const store = new Store(auth);
    const session = new SessionCoordinator(store, auth);
    const updateSettings = vi.fn().mockResolvedValue({ ok: true, state: store.snapshot() });
    (session as unknown as { updateSettings: typeof updateSettings }).updateSettings = updateSettings;
    handleContentEvent(
      { store, auth, session },
      { type: "UPDATE_SETTINGS", settings: { tier: TIER_STANDARD } },
    );
    expect(updateSettings).toHaveBeenCalledWith({ tier: TIER_STANDARD });
  });
});

// ── GET_YT_PLAYER_RESPONSE — MAIN-world caption track retrieval ───────────────
describe("routeMessage — GET_YT_PLAYER_RESPONSE", () => {
  let chromeMock: FakeChrome;
  let deps: RouterDeps;

  beforeEach(() => {
    chromeMock = resetChrome();
    deps = buildDeps();
  });

  it("returns {ok:true, captionTracks} when executeScript resolves with tracks", async () => {
    const tracks = [{ baseUrl: "u", languageCode: "en", kind: undefined }];
    chromeMock.scripting.executeScript.mockResolvedValue([{ result: tracks }]);

    const sender: chrome.runtime.MessageSender = { tab: { id: 42 } as chrome.tabs.Tab };
    const { ret, response } = route(deps, { type: "GET_YT_PLAYER_RESPONSE" }, sender);

    // must return true (async channel kept open)
    expect(ret).toBe(true);

    await vi.waitFor(() => expect(response()).toBeDefined());
    expect(response()).toEqual({ ok: true, captionTracks: tracks });
    expect(chromeMock.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 42 }, world: "MAIN" }),
    );
  });

  it("returns {ok:false} when executeScript result is null (player not ready)", async () => {
    chromeMock.scripting.executeScript.mockResolvedValue([{ result: null }]);

    const sender: chrome.runtime.MessageSender = { tab: { id: 42 } as chrome.tabs.Tab };
    const { ret, response } = route(deps, { type: "GET_YT_PLAYER_RESPONSE" }, sender);

    expect(ret).toBe(true);
    await vi.waitFor(() => expect(response()).toBeDefined());
    expect(response()).toEqual({ ok: false });
  });

  it("returns {ok:false} immediately when sender.tab.id is undefined — no executeScript call", () => {
    const sender: chrome.runtime.MessageSender = { tab: {} as chrome.tabs.Tab };
    const { ret, response } = route(deps, { type: "GET_YT_PLAYER_RESPONSE" }, sender);

    expect(ret).toBe(true);
    // sendResponse is called synchronously in this guard path
    expect(response()).toEqual({ ok: false });
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("returns {ok:false} when executeScript throws", async () => {
    chromeMock.scripting.executeScript.mockRejectedValue(new Error("scripting denied"));

    const sender: chrome.runtime.MessageSender = { tab: { id: 42 } as chrome.tabs.Tab };
    const { ret, response } = route(deps, { type: "GET_YT_PLAYER_RESPONSE" }, sender);

    expect(ret).toBe(true);
    await vi.waitFor(() => expect(response()).toBeDefined());
    expect(response()).toEqual({ ok: false });
  });
});

// ── GAP-1: PREPARE_INTENT message handling ────────────────────────────────────
describe("routeMessage — PREPARE_INTENT relay", () => {
  let chromeMock: FakeChrome;
  let deps: RouterDeps;

  beforeEach(() => {
    chromeMock = resetChrome();
    deps = buildDeps();
  });

  afterEach(() => {
    resetHydrateSignedInState();
  });

  it("relays CONTENT_PREPARE_INTENT to the active tab when no session is running", async () => {
    // Simulate an active tab (id=42) returned by tabs.query.
    chromeMock.tabs.query.mockResolvedValue([{ id: 42, active: true }]);
    chromeMock.tabs.sendMessage.mockResolvedValue({ ok: true });

    // Store has no running session (default).
    const { ret } = route(deps, { type: "PREPARE_INTENT" }, POPUP_SENDER);
    expect(ret).toBe(true);

    await vi.waitFor(() =>
      expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(
        42,
        { type: "CONTENT_PREPARE_INTENT" },
      ),
    );
  });

  it("relays an intent (apiBearer/targetLanguage/pipeline) when signed in", async () => {
    chromeMock.tabs.query.mockResolvedValue([{ id: 42, active: true }]);
    chromeMock.tabs.sendMessage.mockResolvedValue({ ok: true });

    // Signed in: token (cookie) + cached user → decideApiMode resolves a mode.
    vi.spyOn(deps.auth, "getSessionToken").mockResolvedValue("tok-abc");
    deps.store.setSignedInUser({ email: "u@x.com", tier: "max" } as never);
    await deps.store.persistSettings({ targetLanguage: "es", tier: TIER_STANDARD });

    route(deps, { type: "PREPARE_INTENT" }, POPUP_SENDER);

    await vi.waitFor(() =>
      expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(42, {
        type: "CONTENT_PREPARE_INTENT",
        intent: { apiBearer: "tok-abc", targetLanguage: "es", pipeline: TIER_STANDARD },
      }),
    );
  });

  it("relays a bare message (no intent) when signed out — content no-ops", async () => {
    chromeMock.tabs.query.mockResolvedValue([{ id: 42, active: true }]);
    chromeMock.tabs.sendMessage.mockResolvedValue({ ok: true });

    // No token → decideApiMode returns null → no intent attached.
    vi.spyOn(deps.auth, "getSessionToken").mockResolvedValue(null);

    route(deps, { type: "PREPARE_INTENT" }, POPUP_SENDER);

    await vi.waitFor(() => expect(chromeMock.tabs.sendMessage).toHaveBeenCalled());
    const [, payload] = chromeMock.tabs.sendMessage.mock.calls[0] as [number, { intent?: unknown }];
    expect(payload).toEqual({ type: "CONTENT_PREPARE_INTENT", intent: undefined });
    expect(payload.intent).toBeUndefined();
  });

  it("does NOT relay CONTENT_PREPARE_INTENT when a session is already running", async () => {
    chromeMock.tabs.query.mockResolvedValue([{ id: 42, active: true }]);
    chromeMock.tabs.sendMessage.mockResolvedValue({ ok: true });

    // Mark session as running so the guard short-circuits.
    deps.store.setRunning(true);

    const { ret } = route(deps, { type: "PREPARE_INTENT" }, POPUP_SENDER);
    expect(ret).toBe(true);

    // Wait briefly; sendMessage should NOT have been called.
    await new Promise((r) => setTimeout(r, 20));
    expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it("does NOT relay when connecting is true (in-flight start)", async () => {
    chromeMock.tabs.query.mockResolvedValue([{ id: 42, active: true }]);
    chromeMock.tabs.sendMessage.mockResolvedValue({ ok: true });

    deps.store.setConnecting(true);

    route(deps, { type: "PREPARE_INTENT" }, POPUP_SENDER);
    await new Promise((r) => setTimeout(r, 20));
    expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalled();
  });
});
