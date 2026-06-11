// Tests for SessionCoordinator.pushSyncedSettings path:
//   • Success: PUT → applyServerBundle
//   • 409: adopt fresh bundle → retry once with fresh version → success
//   • 409 retry twice: mark advancedDirty
//   • No push when no settings client
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetChrome } from "../setup";
import { Store } from "@/background/store";
import { EcholyAuth } from "@/background/auth";
import { SessionCoordinator } from "@/background/session-coordinator";
import { SettingsClient, SettingsHttpError } from "@/background/settings-client";
import { DEFAULT_ADVANCED } from "@/shared/advanced";
import { TIER_STANDARD, TIER_REALTIME } from "@/shared/constants";
import type { SignedInUser } from "@/shared/types";

const MAX_USER: SignedInUser = { email: "u@example.com", tier: "max" };

function makeBundle(version: number, lang = "vi") {
  return {
    settings: {
      ...DEFAULT_ADVANCED,
      mode: "standard" as const,
      targetLanguage: lang,
      sourceLanguage: "auto",
      standardVoice: "English_magnetic_voiced_man",
      realtimeVoice: "marin",
      showSource: false,
      showTargetCaptions: true,
    },
    siteOverrides: {},
    version,
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

function build() {
  resetChrome();
  const auth = new EcholyAuth();
  const store = new Store(auth);
  const settingsClient = new SettingsClient("https://api.test/v1", () =>
    Promise.resolve("tok"),
  );
  const session = new SessionCoordinator(store, auth, settingsClient);
  store.setSignedInUser(MAX_USER);
  store.state.advancedVersion = 3;
  return { store, session, settingsClient, auth };
}

describe("pushSyncedSettings — success path", () => {
  afterEach(() => vi.useRealTimers());

  it("PUT is called with the diff patch when a synced Setting changes", async () => {
    vi.useFakeTimers();
    const { store, session, settingsClient } = build();
    const putSpy = vi
      .spyOn(settingsClient, "putGlobal")
      .mockResolvedValue(makeBundle(4, "fr") as never);

    // Simulate a user edit that changes targetLanguage
    store.state.targetLanguage = "vi"; // original
    await session.updateSettings({ targetLanguage: "fr" });

    // Timer hasn't fired yet
    expect(putSpy).not.toHaveBeenCalled();

    // Advance the debounce
    await vi.runAllTimersAsync();

    expect(putSpy).toHaveBeenCalledTimes(1);
    const call0 = putSpy.mock.calls[0] as [Record<string, unknown>, number | undefined];
    expect(call0[0].targetLanguage).toBe("fr");
    expect(call0[1]).toBe(3);
    // After success, version should be updated
    expect(store.state.advancedVersion).toBe(4);
  });
});

describe("pushSyncedSettings — 409 retry-once path", () => {
  afterEach(() => vi.useRealTimers());

  it("on 409: adopts fresh bundle, retries same patch once, succeeds on retry", async () => {
    vi.useFakeTimers();
    const { store, session, settingsClient } = build();

    const freshBundle = makeBundle(7, "vi"); // server's current version
    const conflict409 = new SettingsHttpError(409, freshBundle, "Conflict");
    const successBundle = makeBundle(8, "fr"); // after retry

    const putSpy = vi
      .spyOn(settingsClient, "putGlobal")
      .mockRejectedValueOnce(conflict409)
      .mockResolvedValueOnce(successBundle as never);

    store.state.targetLanguage = "vi";
    await session.updateSettings({ targetLanguage: "fr" });
    await vi.runAllTimersAsync();

    // Called twice: once on first try, once on retry
    expect(putSpy).toHaveBeenCalledTimes(2);
    // Second call uses the fresh version (7)
    const call1 = putSpy.mock.calls[1] as [Record<string, unknown>, number | undefined];
    expect(call1[1]).toBe(7);
    // Final state reflects successful retry
    expect(store.state.advancedVersion).toBe(8);
    expect(store.state.advancedDirty).toBe(false);
  });

  it("on 409 retry also fails: sets advancedDirty flag", async () => {
    vi.useFakeTimers();
    const { store, session, settingsClient } = build();

    const freshBundle = makeBundle(7, "vi");
    const conflict = new SettingsHttpError(409, freshBundle, "Conflict");
    const conflict2 = new SettingsHttpError(409, makeBundle(8, "vi"), "Conflict again");

    vi.spyOn(settingsClient, "putGlobal")
      .mockRejectedValueOnce(conflict)
      .mockRejectedValueOnce(conflict2);

    store.state.targetLanguage = "vi";
    await session.updateSettings({ targetLanguage: "fr" });
    await vi.runAllTimersAsync();

    expect(store.state.advancedDirty).toBe(true);
  });
});

describe("pushSyncedSettings — no push on non-synced fields", () => {
  afterEach(() => vi.useRealTimers());

  it("does NOT call putGlobal when only volume changes (not a synced key)", async () => {
    vi.useFakeTimers();
    const { store, session, settingsClient } = build();
    const putSpy = vi.spyOn(settingsClient, "putGlobal");

    await session.updateSettings({ originalVolume: 50 });
    await vi.runAllTimersAsync();

    expect(putSpy).not.toHaveBeenCalled();
  });
});

describe("pushSyncedSettings — no settings client", () => {
  afterEach(() => vi.useRealTimers());

  it("does NOT push and does NOT set dirty when no settingsClient (no-op; pull will heal on next hydrate)", async () => {
    vi.useFakeTimers();
    resetChrome();
    const auth = new EcholyAuth();
    const store = new Store(auth);
    // SessionCoordinator WITHOUT settingsClient
    const session = new SessionCoordinator(store, auth);
    store.setSignedInUser(MAX_USER);
    store.state.advancedVersion = 3;

    store.state.targetLanguage = "vi";
    await session.updateSettings({ targetLanguage: "fr" });
    await vi.runAllTimersAsync();

    // With no settingsClient the coordinator skips the push entirely;
    // advancedDirty is owned by the Advanced-settings path (updateAdvancedSettings),
    // not by synced-settings changes (which self-heal on the next hydrateSignedIn).
    expect(store.state.advancedDirty).toBe(false);
    // The setting itself was persisted locally
    expect(store.state.targetLanguage).toBe("fr");
  });
});
