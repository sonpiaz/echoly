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
  KYMA_DIRECT_BASE,
} from "@/shared/constants";

function build(chromeMock: FakeChrome): {
  store: Store;
  session: SessionCoordinator;
} {
  const auth = new EcholyAuth();
  const store = new Store(auth);
  const session = new SessionCoordinator(store, auth);
  return { store, session };
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

describe("start — happy path with BYOK key", () => {
  let chromeMock: FakeChrome;
  let store: Store;
  let session: SessionCoordinator;
  beforeEach(() => {
    chromeMock = resetChrome();
    ({ store, session } = build(chromeMock));
    // BYOK key present → resolveApiMode = byok, no cookie/fetch needed
    chromeMock.storage.local._data["kymaKey"] = "sk-kyma-xyz";
    chromeMock.tabs.query.mockResolvedValue([
      { id: 9, url: "https://www.youtube.com/watch?v=abc" },
    ]);
    chromeMock.tabs.sendMessage.mockResolvedValue({ ok: true });
  });

  it("resolves BYOK, injects, relays CONTENT_START with apiBase + overridden bearer", async () => {
    await store.loadSettings(); // hydrate kymaKey into state
    const result = await session.start({ targetLanguage: "ja" });

    expect(result.ok).toBe(true);
    expect(store.state.running).toBe(true);
    expect(store.state.connecting).toBe(false);
    expect(store.state.status).toBe("Translating");
    expect(store.state.apiMode).toBe("byok");
    expect(store.state.tabId).toBe(9);

    // find the CONTENT_START relay among the tabs.sendMessage calls
    const startCall = chromeMock.tabs.sendMessage.mock.calls.find(
      (c) => (c[1] as { type?: string })?.type === "CONTENT_START",
    );
    expect(startCall).toBeDefined();
    const settings = (startCall![1] as { settings: Record<string, unknown> })
      .settings;
    // apiBase injected, kymaKey overridden to the resolved bearer
    expect(settings.apiBase).toBe(KYMA_DIRECT_BASE);
    expect(settings.kymaKey).toBe("sk-kyma-xyz");
    // full snapshot fields present
    expect(settings.targetLanguage).toBe("ja");
    expect(settings.tier).toBe("realtime");
  });

  it("rejects a second start while running/connecting", async () => {
    store.setRunning(true);
    const r = await session.start();
    expect(r).toEqual({ ok: false, error: "Session already running." });
  });

  it("aborts when not on a YouTube tab", async () => {
    chromeMock.tabs.query.mockResolvedValue([
      { id: 9, url: "https://example.com/" },
    ]);
    await store.loadSettings();
    const r = await session.start();
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ error: "Open a YouTube video first." });
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

describe("updateVolume — active-tab fallback when tabId is null", () => {
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

  it("no active YT tab → applies volume to state but relays nothing", async () => {
    store.setTabId(null);
    chromeMock.tabs.query.mockResolvedValue([
      { id: 3, url: "https://example.com/" },
    ]);
    const r = await session.updateVolume(20, 60);
    expect(r).toEqual({ ok: true });
    expect(store.state.originalVolume).toBe(20);
    const volCall = chromeMock.tabs.sendMessage.mock.calls.find(
      (c) => (c[1] as { type?: string })?.type === "CONTENT_UPDATE_VOLUME",
    );
    expect(volCall).toBeUndefined();
  });
});
