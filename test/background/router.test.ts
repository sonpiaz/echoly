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

  it("GET_STATE → loads settings + refreshes auth, replies {ok:true, state}", async () => {
    const { ret } = route(deps, { type: "GET_STATE" }, POPUP_SENDER);
    expect(ret).toBe(true);
    await vi.waitFor(() => expect(chromeMock.runtime.sendMessage).toHaveBeenCalled());
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
