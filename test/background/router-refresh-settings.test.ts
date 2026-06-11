// Tests that the router accepts REFRESH_SETTINGS from content-script senders (C4).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { resetChrome } from "../setup";
import { routeMessage, handleContentEvent, type RouterDeps } from "@/background/router";
import { Store } from "@/background/store";
import { EcholyAuth } from "@/background/auth";
import { SessionCoordinator } from "@/background/session-coordinator";
import type { ToBackgroundMessage } from "@/shared/protocol";

const CONTENT_SENDER: chrome.runtime.MessageSender = {
  tab: { id: 99 } as chrome.tabs.Tab,
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
): { ret: boolean; captured: unknown } {
  let captured: unknown;
  const sendResponse = vi.fn((r?: unknown) => {
    captured = r;
  });
  const ret = routeMessage(deps, message, sender, sendResponse);
  return { ret, captured };
}

beforeEach(() => {
  resetChrome();
});

describe("REFRESH_SETTINGS from content-script sender (C4)", () => {
  it("calls session.refreshSettings when received from a content sender", () => {
    const deps = buildDeps();
    const refreshSpy = vi
      .spyOn(deps.session, "refreshSettings")
      .mockResolvedValue({ ok: true, state: deps.store.snapshot() });

    const { ret } = route(
      deps,
      { type: "REFRESH_SETTINGS" } as ToBackgroundMessage,
      CONTENT_SENDER,
    );

    // Content messages return false (sync ack)
    expect(ret).toBe(false);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  it("REFRESH_SETTINGS from popup sender also works (existing popup behaviour)", async () => {
    const deps = buildDeps();
    const refreshSpy = vi
      .spyOn(deps.session, "refreshSettings")
      .mockResolvedValue({ ok: true, state: deps.store.snapshot() });

    const { ret } = route(
      deps,
      { type: "REFRESH_SETTINGS" } as ToBackgroundMessage,
      POPUP_SENDER,
    );

    // Popup messages return true (async)
    expect(ret).toBe(true);
    // Wait for the async popup handler to complete
    await new Promise((r) => setTimeout(r, 0));
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });
});

describe("handleContentEvent — REFRESH_SETTINGS", () => {
  it("calls session.refreshSettings when the message type is REFRESH_SETTINGS", () => {
    const deps = buildDeps();
    const refreshSpy = vi
      .spyOn(deps.session, "refreshSettings")
      .mockResolvedValue({ ok: true, state: deps.store.snapshot() });

    handleContentEvent(deps, { type: "REFRESH_SETTINGS" });

    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });
});
