// Layer B — session coordinator interaction tests against the chrome.* mock.
// Locks the load-bearing invariants: ensureContentScript injects the WXT-stable
// CONTENT_SCRIPT_PATH (NOT the literal "content.js"), PING-then-inject is
// idempotent, CONTENT_START carries a full snapshot with apiBase + bearer
// override, and the volume fallback reaches the active YT tab.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { resetChrome, type FakeChrome } from "../setup";
import { Store } from "@/background/store";
import { EcholyAuth } from "@/background/auth";
import { SessionCoordinator } from "@/background/session-coordinator";
import {
  CONTENT_SCRIPT_PATH,
  CONTENT_CSS_PATH,
  DEFAULT_TRANSLATION_TIER,
  ECHOLY_PROXY_BASE,
} from "@/shared/constants";
import type { SignedInUser } from "@/shared/types";

const SIGNED_IN: SignedInUser = { email: "a@b.com", tier: "max" };

function build(chromeMock: FakeChrome): {
  store: Store;
  session: SessionCoordinator;
  auth: EcholyAuth;
} {
  const auth = new EcholyAuth();
  const store = new Store(auth);
  const session = new SessionCoordinator(store, auth);
  return { store, session, auth };
}

describe("ensureContentScript — PING-then-inject at the WXT-stable path", () => {
  let chromeMock: FakeChrome;
  let session: SessionCoordinator;
  beforeEach(() => {
    chromeMock = resetChrome();
    session = build(chromeMock).session;
  });

  it("live content script (PING ok) → no injection", async () => {
    chromeMock.tabs.sendMessage.mockResolvedValue({ ok: true, version: "0.6.3" });
    await session.ensureContentScript(42);
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("no reply → injects CONTENT_SCRIPT_PATH + CONTENT_CSS_PATH (NOT literal content.js)", async () => {
    chromeMock.tabs.sendMessage.mockRejectedValue(new Error("no receiver"));
    await session.ensureContentScript(42);
    expect(chromeMock.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 42 },
      files: [CONTENT_SCRIPT_PATH],
    });
    expect(chromeMock.scripting.insertCSS).toHaveBeenCalledWith({
      target: { tabId: 42 },
      files: [CONTENT_CSS_PATH],
    });
    // guard against the legacy literal regressing back in
    expect(CONTENT_SCRIPT_PATH).not.toBe("content.js");
  });

  it("insertCSS failure is swallowed (manifest static match may have it)", async () => {
    chromeMock.tabs.sendMessage.mockRejectedValue(new Error("no receiver"));
    chromeMock.scripting.insertCSS.mockRejectedValue(new Error("dup"));
    await expect(session.ensureContentScript(42)).resolves.toBeUndefined();
  });
});

describe("start — signed-in proxy", () => {
  let chromeMock: FakeChrome;
  let store: Store;
  let session: SessionCoordinator;
  let auth: EcholyAuth;
  beforeEach(() => {
    chromeMock = resetChrome();
    ({ store, session, auth } = build(chromeMock));
    vi.spyOn(auth, "getSessionToken").mockResolvedValue("ec-session-tok");
    vi.spyOn(auth, "fetchUser").mockResolvedValue(SIGNED_IN);
    chromeMock.tabs.query.mockResolvedValue([
      { id: 9, url: "https://www.youtube.com/watch?v=abc" },
    ]);
    chromeMock.tabs.sendMessage.mockResolvedValue({ ok: true });
  });

  it("resolves proxy, injects, relays CONTENT_START with apiBase + session bearer", async () => {
    await store.loadSettings();
    const result = await session.start({ targetLanguage: "ja" });

    expect(result.ok).toBe(true);
    expect(store.state.running).toBe(true);
    expect(store.state.connecting).toBe(false);
    expect(store.state.status).toBe("Translating");
    expect(store.state.apiMode).toBe("proxy");
    expect(store.state.tabId).toBe(9);

    const startCall = chromeMock.tabs.sendMessage.mock.calls.find(
      (c) => (c[1] as { type?: string })?.type === "CONTENT_START",
    );
    expect(startCall).toBeDefined();
    const settings = (startCall![1] as { settings: Record<string, unknown> })
      .settings;
    expect(settings.apiBase).toBe(ECHOLY_PROXY_BASE);
    expect(settings.apiBearer).toBe("ec-session-tok");
    expect(settings.targetLanguage).toBe("ja");
    expect(settings.tier).toBe(DEFAULT_TRANSLATION_TIER);
  });

  it("rejects a second start while running/connecting", async () => {
    store.setRunning(true);
    const r = await session.start();
    expect(r).toEqual({ ok: false, error: "Session already running." });
  });

  it("starts on active non-YouTube web tab", async () => {
    chromeMock.tabs.query.mockResolvedValue([
      { active: true, id: 9, url: "https://www.coursera.org/learn/foo" },
    ]);
    await store.loadSettings();
    const r = await session.start();
    expect(r.ok).toBe(true);
    expect(store.state.tabId).toBe(9);
  });

  it("aborts when no web tab is available", async () => {
    chromeMock.tabs.query.mockResolvedValue([
      { id: 9, url: "chrome://settings/" },
    ]);
    await store.loadSettings();
    const r = await session.start();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/video/i);
  });
});

describe("stop — clean teardown", () => {
  let chromeMock: FakeChrome;
  let store: Store;
  let session: SessionCoordinator;
  beforeEach(() => {
    chromeMock = resetChrome();
    ({ store, session } = build(chromeMock));
  });

  it("resets session fields, relays CONTENT_STOP, nulls tabId after", async () => {
    store.setRunning(true);
    store.setTabId(5);
    const r = await session.stop();
    expect(r.ok).toBe(true);
    expect(store.state.running).toBe(false);
    expect(store.state.status).toBe("Stopped");
    expect(store.state.tabId).toBeNull();
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(5, {
      type: "CONTENT_STOP",
    });
  });

  it("tolerates a relay failure (tab gone)", async () => {
    store.setTabId(5);
    chromeMock.tabs.sendMessage.mockRejectedValue(new Error("gone"));
    await expect(session.stop()).resolves.toMatchObject({ ok: true });
    expect(store.state.tabId).toBeNull();
  });
});

describe("updateVolume / stop — active-tab fallback when tabId is null", () => {
  let chromeMock: FakeChrome;
  let store: Store;
  let session: SessionCoordinator;
  beforeEach(() => {
    chromeMock = resetChrome();
    ({ store, session } = build(chromeMock));
  });

  it("falls back to the active YT tab + ensureContentScript when tabId is null", async () => {
    store.setTabId(null);
    chromeMock.tabs.query.mockResolvedValue([
      { id: 3, url: "https://www.youtube.com/watch?v=z" },
    ]);
    chromeMock.tabs.sendMessage.mockResolvedValue({ ok: true });
    const r = await session.updateVolume(40, 90);
    expect(r).toEqual({ ok: true });
    expect(store.state.originalVolume).toBe(40);
    expect(store.state.voiceVolume).toBe(90);
    const volCall = chromeMock.tabs.sendMessage.mock.calls.find(
      (c) => (c[1] as { type?: string })?.type === "CONTENT_UPDATE_VOLUME",
    );
    expect(volCall).toBeDefined();
    expect(volCall![0]).toBe(3);
  });

  it("stop with null tabId falls back to active YT tab and relays CONTENT_STOP", async () => {
    store.setTabId(null);
    store.setRunning(true);
    chromeMock.tabs.query.mockResolvedValue([
      { id: 7, url: "https://www.youtube.com/watch?v=x" },
    ]);
    chromeMock.tabs.sendMessage.mockResolvedValue({ ok: true });
    const r = await session.stop();
    expect(r.ok).toBe(true);
    expect(store.state.running).toBe(false);
    const stopCall = chromeMock.tabs.sendMessage.mock.calls.find(
      (c) => (c[1] as { type?: string })?.type === "CONTENT_STOP",
    );
    expect(stopCall).toBeDefined();
    expect(stopCall![0]).toBe(7);
  });

  it("active non-YouTube tab → still applies volume to state and relays (platform-agnostic fallback)", async () => {
    // After removing the isYouTubeUrl gate, the fallback picks the active tab
    // regardless of platform — so a Coursera/Udemy/generic tab also receives the
    // volume update when tabId is null.
    store.setTabId(null);
    chromeMock.tabs.query.mockResolvedValue([
      { id: 3, url: "https://example.com/" },
    ]);
    chromeMock.tabs.sendMessage.mockResolvedValue({ ok: true });
    const r = await session.updateVolume(20, 60);
    expect(r).toEqual({ ok: true });
    expect(store.state.originalVolume).toBe(20);
    const volCall = chromeMock.tabs.sendMessage.mock.calls.find(
      (c) => (c[1] as { type?: string })?.type === "CONTENT_UPDATE_VOLUME",
    );
    // The relay now reaches any active tab, not only YouTube.
    expect(volCall).toBeDefined();
    expect(volCall![0]).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// start — signed-out / expired session relays CONTENT_SHOW_TOAST
// ─────────────────────────────────────────────────────────────────────────────

describe("start — signed-out/expired session → CONTENT_SHOW_TOAST relay", () => {
  let chromeMock: FakeChrome;
  let store: Store;
  let session: SessionCoordinator;
  let auth: EcholyAuth;

  beforeEach(() => {
    chromeMock = resetChrome();
    ({ store, session, auth } = build(chromeMock));
  });

  it("relays CONTENT_SHOW_TOAST to the active tab when resolveApiMode returns null (no session token)", async () => {
    // Simulate: getSessionToken returns null → resolveApiMode will return null
    // (no proxy mode available, user is signed out).
    vi.spyOn(auth, "getSessionToken").mockResolvedValue(null);
    vi.spyOn(auth, "fetchUser").mockResolvedValue(null);

    // Provide an active tab so the coordinator can find it.
    const TAB_ID = 42;
    chromeMock.tabs.query.mockImplementation(async (query: chrome.tabs.QueryInfo) => {
      // sessionTabForStart queries for all tabs; fallback queries active+currentWindow.
      // Return a valid web tab either way.
      if (query.active === true) {
        return [{ id: TAB_ID, url: "https://www.youtube.com/watch?v=xyz" }];
      }
      return [{ id: TAB_ID, url: "https://www.youtube.com/watch?v=xyz" }];
    });
    // sendMessage should succeed (content script is "injected").
    chromeMock.tabs.sendMessage.mockResolvedValue({ ok: true });

    await store.loadSettings();
    const result = await session.start({ targetLanguage: "vi" });

    // The call must return ok: false (sign-in required).
    expect(result.ok).toBe(false);

    // A CONTENT_SHOW_TOAST message must have been sent to a tab.
    const toastCall = chromeMock.tabs.sendMessage.mock.calls.find(
      (c: unknown[]) => (c[1] as { type?: string })?.type === "CONTENT_SHOW_TOAST",
    );
    expect(toastCall).toBeDefined();

    // The toast message must carry a non-empty text (the "sign in" message).
    const toastMsg = toastCall![1] as { type: string; text: string };
    expect(typeof toastMsg.text).toBe("string");
    expect(toastMsg.text.length).toBeGreaterThan(0);
  });

  it("returns { ok: false } even when the tab is missing (no tab → skip toast, never throw)", async () => {
    vi.spyOn(auth, "getSessionToken").mockResolvedValue(null);
    vi.spyOn(auth, "fetchUser").mockResolvedValue(null);

    // No tabs available — both queries return empty arrays.
    chromeMock.tabs.query.mockResolvedValue([]);
    chromeMock.tabs.sendMessage.mockResolvedValue({ ok: true });

    await store.loadSettings();
    const result = await session.start();

    // Must NOT throw — coordinator swallows tab-not-found gracefully.
    expect(result.ok).toBe(false);
    // No CONTENT_SHOW_TOAST was sent (no tab to send to — acceptable).
    const toastCall = chromeMock.tabs.sendMessage.mock.calls.find(
      (c: unknown[]) => (c[1] as { type?: string })?.type === "CONTENT_SHOW_TOAST",
    );
    expect(toastCall).toBeUndefined();
  });

  it("does NOT relay CONTENT_SHOW_TOAST when session is already running (benign guard)", async () => {
    // Already running → the early-return path runs before resolveApiMode.
    store.setRunning(true);

    const result = await session.start();

    expect(result).toEqual({ ok: false, error: "Session already running." });

    const toastCall = chromeMock.tabs.sendMessage.mock.calls.find(
      (c: unknown[]) => (c[1] as { type?: string })?.type === "CONTENT_SHOW_TOAST",
    );
    expect(toastCall).toBeUndefined();
  });
});
