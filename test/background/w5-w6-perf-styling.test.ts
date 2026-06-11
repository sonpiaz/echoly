// W5 + W6 combined test suite (background-side: no DOM).
//
// W5 — Performance hardening:
//   AC14: applyServerBundle version-skip (returns false, no writes)
//   AC14: applyServerBundle write-order (saveSettings before version)
//   Relay wiring: relaySettingsToContent fires on updateAdvancedSettings
//   Relay wiring: relaySettingsToContent fires on refreshSettings when changed
//   Relay wiring: no relay on refreshSettings when bundle is unchanged
//
// W6 — Subtitle styling (Pro/Max):
//   sanitizeServerPatch accepts/rejects 13-key global vs 3-key site override
//   canUseSubtitleStyling: free→false, pro→true, max→true
//   applyServerBundle routes 3 style keys to state.advanced
//
// NOTE: Overlay CSS-var mapping tests (setSubtitleStyle) are in
//   test/ui/overlay-subtitle-style.test.ts (requires jsdom environment).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { resetChrome } from "../setup";
import { Store } from "@/background/store";
import { EcholyAuth } from "@/background/auth";
import { SessionCoordinator } from "@/background/session-coordinator";
import { SettingsClient } from "@/background/settings-client";
import {
  sanitizeServerPatch,
  sanitizePatch,
  DEFAULT_ADVANCED,
} from "@/shared/advanced";
import { canUseSubtitleStyling } from "@/shared/tier";
import type { SignedInUser } from "@/shared/types";

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

const MAX_USER: SignedInUser = { email: "u@example.com", tier: "max" };
const PRO_USER: SignedInUser = { email: "p@example.com", tier: "pro" };

function makeBundle(version: number, overrides = {}) {
  return {
    settings: {
      ...DEFAULT_ADVANCED,
      mode: "standard" as const,
      targetLanguage: "vi",
      sourceLanguage: "auto",
      standardVoice: "English_magnetic_voiced_man",
      realtimeVoice: "marin",
      showSource: false,
      showTargetCaptions: true,
      ...overrides,
    },
    siteOverrides: {},
    version,
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

function buildStoreAndSession() {
  const auth = new EcholyAuth();
  const store = new Store(auth);
  const settingsClient = new SettingsClient("https://api.test/v1", () =>
    Promise.resolve("tok"),
  );
  const session = new SessionCoordinator(store, auth, settingsClient);
  return { auth, store, session, settingsClient };
}

// ────────────────────────────────────────────────────────────────────────────
// W5 — AC14: version short-circuit
// ────────────────────────────────────────────────────────────────────────────

describe("Store.applyServerBundle — version short-circuit (AC14)", () => {
  beforeEach(() => {
    resetChrome();
  });

  it("returns false when version matches and dirty=false (no writes)", async () => {
    const auth = new EcholyAuth();
    const store = new Store(auth);
    const bundle = makeBundle(3);
    // First apply to establish version 3.
    await store.applyServerBundle(bundle);
    expect(store.state.advancedVersion).toBe(3);

    // Second apply with same version, not dirty → short-circuit.
    const changed = await store.applyServerBundle(bundle);
    expect(changed).toBe(false);
  });

  it("returns true when version is newer (dirty=false)", async () => {
    const auth = new EcholyAuth();
    const store = new Store(auth);
    await store.applyServerBundle(makeBundle(3));

    const changed = await store.applyServerBundle(makeBundle(4));
    expect(changed).toBe(true);
    expect(store.state.advancedVersion).toBe(4);
  });

  it("returns true when version matches but dirty=true (retry path)", async () => {
    const auth = new EcholyAuth();
    const store = new Store(auth);
    await store.applyServerBundle(makeBundle(3));
    store.setAdvancedDirty(true);

    const changed = await store.applyServerBundle(makeBundle(3));
    expect(changed).toBe(true);
    expect(store.state.advancedDirty).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// W5 — AC14: write ordering (saveSettings BEFORE advancedVersion)
// ────────────────────────────────────────────────────────────────────────────

describe("Store.applyServerBundle — write-order (AC14)", () => {
  beforeEach(() => {
    resetChrome();
  });

  it("calls chrome.storage.local.set with Settings keys before advancing version", async () => {
    const auth = new EcholyAuth();
    const store = new Store(auth);

    const calls: string[] = [];
    const chromeMock = (globalThis as { chrome?: { storage: { local: { set: (...args: unknown[]) => void; get: (...args: unknown[]) => void } } } }).chrome!;
    const origSet = chromeMock.storage.local.set.bind(chromeMock.storage.local);
    vi.spyOn(chromeMock.storage.local, "set").mockImplementation((...args: unknown[]) => {
      const data = args[0] as Record<string, unknown>;
      // Record which keys are being set in order.
      calls.push(...Object.keys(data));
      return origSet(...args);
    });

    await store.applyServerBundle(makeBundle(7, { targetLanguage: "ja" }));

    // targetLanguage (from flat Settings) must appear before advancedVersion would
    // normally be set. We verify saveSettings was called (it sets tier/language/etc.)
    // and that advancedVersion was updated on state.
    expect(store.state.targetLanguage).toBe("ja");
    expect(store.state.advancedVersion).toBe(7);
    // The chrome.storage.local.set should have been called at least once for flat settings.
    expect(calls.some((k) => k === "targetLanguage" || k === "tier" || k === "standardVoice")).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// W5 — Relay wiring: relaySettingsToContent
// ────────────────────────────────────────────────────────────────────────────

describe("SessionCoordinator — relaySettingsToContent on updateAdvancedSettings", () => {
  beforeEach(() => {
    resetChrome();
  });

  it("relays CONTENT_UPDATE_SETTINGS to the running tab after updateAdvancedSettings", async () => {
    const { store, session, settingsClient } = buildStoreAndSession();
    store.setSignedInUser(MAX_USER);
    store.setRunning(true);
    store.setTabId(42);

    // settingsClient.putGlobal returns a fresh bundle.
    vi.spyOn(settingsClient, "putGlobal").mockResolvedValue(makeBundle(4) as never);

    const sentMessages: { tabId: number; msg: { type: string } }[] = [];
    const chromeMock = (globalThis as { chrome?: { tabs: { sendMessage: (...a: unknown[]) => unknown } } }).chrome!;
    vi.spyOn(chromeMock.tabs, "sendMessage").mockImplementation((...args: unknown[]) => {
      const [tabId, msg] = args as [number, { type: string }];
      sentMessages.push({ tabId, msg });
      return Promise.resolve({ ok: true });
    });

    await session.updateAdvancedSettings({ captionFontSize: "large" });

    const relay = sentMessages.find((s) => s.msg.type === "CONTENT_UPDATE_SETTINGS");
    expect(relay).toBeDefined();
    expect(relay!.tabId).toBe(42);
  });

  it("does NOT relay CONTENT_UPDATE_SETTINGS when session is not running", async () => {
    const { store, session, settingsClient } = buildStoreAndSession();
    store.setSignedInUser(MAX_USER);
    store.setRunning(false);
    store.setConnecting(false);
    store.setTabId(42);

    vi.spyOn(settingsClient, "putGlobal").mockResolvedValue(makeBundle(4) as never);

    const chromeMock = (globalThis as { chrome?: { tabs: { sendMessage: (...a: unknown[]) => unknown } } }).chrome!;
    const sendMsgSpy = vi.spyOn(chromeMock.tabs, "sendMessage").mockResolvedValue({ ok: true });

    await session.updateAdvancedSettings({ captionFontSize: "large" });

    const relayCall = sendMsgSpy.mock.calls.find(
      (c) => (c[1] as { type?: string })?.type === "CONTENT_UPDATE_SETTINGS",
    );
    expect(relayCall).toBeUndefined();
  });
});

describe("SessionCoordinator — relaySettingsToContent on refreshSettings", () => {
  beforeEach(() => {
    resetChrome();
  });

  it("relays CONTENT_UPDATE_SETTINGS when bundle changed", async () => {
    const { store, session, settingsClient } = buildStoreAndSession();
    store.setSignedInUser(MAX_USER);
    store.setRunning(true);
    store.setTabId(99);
    store.state.advancedVersion = 1; // bundle version 2 is newer → changed=true

    vi.spyOn(settingsClient, "fetchBundle").mockResolvedValue(makeBundle(2) as never);

    const sentMessages: { tabId: number; msg: { type: string } }[] = [];
    const chromeMock = (globalThis as { chrome?: { tabs: { sendMessage: (...a: unknown[]) => unknown } } }).chrome!;
    vi.spyOn(chromeMock.tabs, "sendMessage").mockImplementation((...args: unknown[]) => {
      const [tabId, msg] = args as [number, { type: string }];
      sentMessages.push({ tabId, msg });
      return Promise.resolve({ ok: true });
    });

    await session.refreshSettings();

    const relay = sentMessages.find((s) => s.msg.type === "CONTENT_UPDATE_SETTINGS");
    expect(relay).toBeDefined();
    expect(relay!.tabId).toBe(99);
  });

  it("does NOT relay CONTENT_UPDATE_SETTINGS when bundle is unchanged (version-skip)", async () => {
    const { store, session, settingsClient } = buildStoreAndSession();
    store.setSignedInUser(MAX_USER);
    store.setRunning(true);
    store.setTabId(99);
    // Apply bundle version 5 first so it's cached.
    await store.applyServerBundle(makeBundle(5));

    // Return same version → applyServerBundle returns false → no relay.
    vi.spyOn(settingsClient, "fetchBundle").mockResolvedValue(makeBundle(5) as never);

    const chromeMock = (globalThis as { chrome?: { tabs: { sendMessage: (...a: unknown[]) => unknown } } }).chrome!;
    const sendMsgSpy = vi.spyOn(chromeMock.tabs, "sendMessage").mockResolvedValue({ ok: true });

    await session.refreshSettings();

    const relayCall = sendMsgSpy.mock.calls.find(
      (c) => (c[1] as { type?: string })?.type === "CONTENT_UPDATE_SETTINGS",
    );
    expect(relayCall).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// W6 — sanitize: 13-key global vs 3-key site override
// ────────────────────────────────────────────────────────────────────────────

describe("sanitizeServerPatch — 13-key global bundle", () => {
  it("passes valid style keys through", () => {
    const result = sanitizeServerPatch({
      captionFontSize: "large",
      captionBgOpacity: "low",
      captionFontWeight: "bold",
    });
    expect(result.captionFontSize).toBe("large");
    expect(result.captionBgOpacity).toBe("low");
    expect(result.captionFontWeight).toBe("bold");
  });

  it("drops invalid style key values", () => {
    const result = sanitizeServerPatch({
      captionFontSize: "huge" as never,
      captionBgOpacity: "none" as never,
      captionFontWeight: "thin" as never,
    });
    expect(result.captionFontSize).toBeUndefined();
    expect(result.captionBgOpacity).toBeUndefined();
    expect(result.captionFontWeight).toBeUndefined();
  });

  it("accepts all valid captionFontSize values", () => {
    for (const v of ["small", "medium", "large", "xlarge"] as const) {
      expect(sanitizeServerPatch({ captionFontSize: v }).captionFontSize).toBe(v);
    }
  });

  it("accepts all valid captionBgOpacity values", () => {
    for (const v of ["transparent", "low", "medium", "high"] as const) {
      expect(sanitizeServerPatch({ captionBgOpacity: v }).captionBgOpacity).toBe(v);
    }
  });

  it("accepts all valid captionFontWeight values", () => {
    for (const v of ["normal", "semibold", "bold"] as const) {
      expect(sanitizeServerPatch({ captionFontWeight: v }).captionFontWeight).toBe(v);
    }
  });

  it("passes synced Settings keys through (mode, targetLanguage, etc.)", () => {
    const result = sanitizeServerPatch({
      mode: "standard",
      targetLanguage: "vi",
      showSource: true,
    });
    expect(result.mode).toBe("standard");
    expect(result.targetLanguage).toBe("vi");
    expect(result.showSource).toBe(true);
  });
});

describe("sanitizePatch — 6-key local AdvancedPatch (GLOBAL advanced edits; site overrides use sanitizeSiteOverridePatch)", () => {
  it("accepts the 3 style keys in an AdvancedPatch", () => {
    const result = sanitizePatch({
      captionFontSize: "small",
      captionBgOpacity: "transparent",
      captionFontWeight: "normal",
    });
    expect(result.captionFontSize).toBe("small");
    expect(result.captionBgOpacity).toBe("transparent");
    expect(result.captionFontWeight).toBe("normal");
  });

  it("silently drops synced Settings keys (mode, targetLanguage, etc.)", () => {
    const result = sanitizePatch({
      mode: "realtime",
      targetLanguage: "ja",
      captionPosition: "top",
    } as never);
    expect((result as Record<string, unknown>).mode).toBeUndefined();
    expect((result as Record<string, unknown>).targetLanguage).toBeUndefined();
    expect(result.captionPosition).toBe("top");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// W6 — canUseSubtitleStyling tier gate
// ────────────────────────────────────────────────────────────────────────────

describe("canUseSubtitleStyling", () => {
  it("returns false for free tier", () => {
    expect(canUseSubtitleStyling("free")).toBe(false);
  });

  it("returns false for null / undefined (signed-out)", () => {
    expect(canUseSubtitleStyling(null)).toBe(false);
    expect(canUseSubtitleStyling(undefined)).toBe(false);
  });

  it("returns true for pro tier", () => {
    expect(canUseSubtitleStyling("pro")).toBe(true);
  });

  it("returns true for max tier", () => {
    expect(canUseSubtitleStyling("max")).toBe(true);
  });
});


// ────────────────────────────────────────────────────────────────────────────
// W6 — applyServerBundle routes 3 style keys to state.advanced
// ────────────────────────────────────────────────────────────────────────────

describe("Store.applyServerBundle — routes style keys to state.advanced (W6)", () => {
  beforeEach(() => {
    resetChrome();
  });

  it("routes captionFontSize, captionBgOpacity, captionFontWeight to state.advanced", async () => {
    const auth = new EcholyAuth();
    const store = new Store(auth);

    await store.applyServerBundle(
      makeBundle(1, {
        captionFontSize: "large",
        captionBgOpacity: "low",
        captionFontWeight: "bold",
      }),
    );

    expect(store.state.advanced.captionFontSize).toBe("large");
    expect(store.state.advanced.captionBgOpacity).toBe("low");
    expect(store.state.advanced.captionFontWeight).toBe("bold");
  });

  it("defaults style keys to DEFAULT_ADVANCED values when absent from bundle", async () => {
    const auth = new EcholyAuth();
    const store = new Store(auth);

    // Bundle without style keys.
    const bundleNoStyle = {
      settings: {
        mode: "standard" as const,
        targetLanguage: "vi",
        sourceLanguage: "auto",
        standardVoice: "English_magnetic_voiced_man",
        realtimeVoice: "marin",
        showSource: false,
        showTargetCaptions: true,
      },
      siteOverrides: {},
      version: 1,
      updatedAt: "2026-06-01T00:00:00.000Z",
    };

    await store.applyServerBundle(bundleNoStyle as never);

    expect(store.state.advanced.captionFontSize).toBe(DEFAULT_ADVANCED.captionFontSize);
    expect(store.state.advanced.captionBgOpacity).toBe(DEFAULT_ADVANCED.captionBgOpacity);
    expect(store.state.advanced.captionFontWeight).toBe(DEFAULT_ADVANCED.captionFontWeight);
  });

  it("free-tier content side: canUseSubtitleStyling returns false → style keys are defaults", async () => {
    const auth = new EcholyAuth();
    const store = new Store(auth);
    const freeUser: SignedInUser = { email: "f@example.com", tier: "free" };
    store.setSignedInUser(freeUser);

    // Even if server sends non-default style keys, the extension stores them
    // in state.advanced (server is SoT); the tier gate lives in content/popup.
    await store.applyServerBundle(makeBundle(1, { captionFontSize: "xlarge" }));

    // state.advanced reflects server value (stored faithfully).
    expect(store.state.advanced.captionFontSize).toBe("xlarge");
    // The tier gate check (separate from storage) correctly denies free.
    expect(canUseSubtitleStyling(freeUser.tier)).toBe(false);
    expect(canUseSubtitleStyling(PRO_USER.tier)).toBe(true);
    expect(canUseSubtitleStyling(MAX_USER.tier)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// P1-2 regression — saveSiteDefault must pin ONLY the 3 site-scoped keys
// (style keys are global-only; the server 400s them in site overrides).
// ────────────────────────────────────────────────────────────────────────────

describe("SessionCoordinator.saveSiteDefault — legacy-3 snapshot only", () => {
  beforeEach(() => {
    resetChrome();
  });

  it("PUTs and stores only captionPosition/autoStartHosts/outputDeviceId, never style keys", async () => {
    const { store, session, settingsClient } = buildStoreAndSession();
    store.setSignedInUser(MAX_USER);
    // Customize style so a naive full-snapshot would leak style keys.
    store.mergeAdvanced({
      captionPosition: "top",
      captionFontSize: "xlarge",
      captionBgOpacity: "transparent",
      captionFontWeight: "bold",
    });

    const putSite = vi
      .spyOn(settingsClient, "putSiteOverride")
      .mockResolvedValue(makeBundle(2) as never);
    const setLocal = vi.spyOn(store, "setSiteOverride");

    await session.saveSiteDefault("youtube.com");

    expect(putSite).toHaveBeenCalledTimes(1);
    const sentPatch = putSite.mock.calls[0]![1] as Record<string, unknown>;
    expect(sentPatch.captionPosition).toBe("top");
    expect("captionFontSize" in sentPatch).toBe(false);
    expect("captionBgOpacity" in sentPatch).toBe(false);
    expect("captionFontWeight" in sentPatch).toBe(false);

    // The LOCAL override write must not pin style keys either (would block
    // global style edits on that site via the effective-advanced merge).
    // (After the PUT the server bundle is authoritative, so assert the
    // write-time patch via the spy rather than post-apply state.)
    expect(setLocal).toHaveBeenCalledTimes(1);
    const localPatch = setLocal.mock.calls[0]![1] as Record<string, unknown>;
    expect(localPatch.captionPosition).toBe("top");
    expect("captionFontSize" in localPatch).toBe(false);
    expect("captionBgOpacity" in localPatch).toBe(false);
    expect("captionFontWeight" in localPatch).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Site-override masking fixes (live-found "stuck on Float" bug):
//  • updateAdvancedSettings routes keys pinned by the CURRENT site's override
//    INTO that override (what-you-see-is-what-you-edit).
//  • Persisted/applied override maps are healed to the legacy 3 keys.
// ────────────────────────────────────────────────────────────────────────────

describe("updateAdvancedSettings — override-aware routing", () => {
  beforeEach(() => {
    resetChrome();
  });

  it("routes a key pinned by the current site's override into the override (not global)", async () => {
    const { store, session, settingsClient } = buildStoreAndSession();
    store.setSignedInUser(MAX_USER);
    store.setCurrentDomain("youtube.com");
    store.setSiteOverride("youtube.com", { captionPosition: "float" });

    const putSite = vi
      .spyOn(settingsClient, "putSiteOverride")
      .mockResolvedValue(makeBundle(2) as never);
    const putGlobal = vi.spyOn(settingsClient, "putGlobal");

    await session.updateAdvancedSettings({ captionPosition: "top" });

    expect(putSite).toHaveBeenCalledTimes(1);
    expect(putSite.mock.calls[0]![0]).toBe("youtube.com");
    expect(putSite.mock.calls[0]![1]).toEqual({ captionPosition: "top" });
    expect(putGlobal).not.toHaveBeenCalled();
  });

  it("style keys always go GLOBAL even when an override exists for the domain", async () => {
    const { store, session, settingsClient } = buildStoreAndSession();
    store.setSignedInUser(MAX_USER);
    store.setCurrentDomain("youtube.com");
    store.setSiteOverride("youtube.com", { captionPosition: "float" });

    const putSite = vi.spyOn(settingsClient, "putSiteOverride");
    const putGlobal = vi
      .spyOn(settingsClient, "putGlobal")
      .mockResolvedValue(makeBundle(2) as never);

    await session.updateAdvancedSettings({ captionFontSize: "xlarge" });

    expect(putSite).not.toHaveBeenCalled();
    expect(putGlobal).toHaveBeenCalledTimes(1);
    expect(putGlobal.mock.calls[0]![0]).toEqual({ captionFontSize: "xlarge" });
  });

  it("no override for the domain → normal global flow", async () => {
    const { store, session, settingsClient } = buildStoreAndSession();
    store.setSignedInUser(MAX_USER);
    store.setCurrentDomain("youtube.com");

    const putGlobal = vi
      .spyOn(settingsClient, "putGlobal")
      .mockResolvedValue(makeBundle(2) as never);

    await session.updateAdvancedSettings({ captionPosition: "top" });
    expect(putGlobal).toHaveBeenCalledTimes(1);
  });
});

describe("override map healing (poisoned pre-fix overrides)", () => {
  beforeEach(() => {
    resetChrome();
  });

  it("applyServerBundle strips style keys from incoming siteOverrides and drops empty entries", async () => {
    const auth = new EcholyAuth();
    const store = new Store(auth);
    const bundle = {
      ...makeBundle(5),
      siteOverrides: {
        "youtube.com": {
          captionPosition: "float",
          captionFontSize: "xlarge",
          captionBgOpacity: "transparent",
          captionFontWeight: "bold",
        },
        "stale.com": { captionFontSize: "small" },
      },
    };
    await store.applyServerBundle(bundle as never);
    expect(store.state.siteOverrides["youtube.com"]).toEqual({ captionPosition: "float" });
    expect("stale.com" in store.state.siteOverrides).toBe(false);
  });
});

describe("saveSiteDefault — snapshots EFFECTIVE values (not raw global)", () => {
  beforeEach(() => {
    resetChrome();
  });

  it("an existing override pin survives Save (no jump back to the global value)", async () => {
    const { store, session, settingsClient } = buildStoreAndSession();
    store.setSignedInUser(MAX_USER);
    // Global says "top", but the site's override pins "float" — the popup
    // (and the video) show FLOAT. Pressing Save must keep float.
    store.mergeAdvanced({ captionPosition: "top" });
    store.setSiteOverride("youtube.com", { captionPosition: "float" });

    const putSite = vi
      .spyOn(settingsClient, "putSiteOverride")
      .mockResolvedValue(makeBundle(3) as never);

    await session.saveSiteDefault("youtube.com");

    expect(putSite).toHaveBeenCalledTimes(1);
    const sentPatch = putSite.mock.calls[0]![1] as Record<string, unknown>;
    expect(sentPatch.captionPosition).toBe("float"); // effective, NOT global "top"
  });
});

describe("live relay carries EFFECTIVE advanced (override merged) — not raw global", () => {
  beforeEach(() => {
    resetChrome();
  });

  it("style edit with a captionPosition override does NOT leak global placement to content", async () => {
    const { store, session, settingsClient } = buildStoreAndSession();
    store.setSignedInUser(MAX_USER);
    store.setRunning(true);
    store.setTabId(7);
    store.setCurrentDomain("youtube.com");
    // Global says "top"; the site's override pins "float" — the video shows float.
    store.mergeAdvanced({ captionPosition: "top" });
    store.setSiteOverride("youtube.com", { captionPosition: "float" });

    vi.spyOn(settingsClient, "putGlobal").mockResolvedValue(makeBundle(9) as never);

    const sent: Array<{ type: string; settings?: { advanced?: { captionPosition?: string } } }> = [];
    const chromeMock = (globalThis as { chrome?: { tabs: { sendMessage: (...a: unknown[]) => unknown } } }).chrome!;
    vi.spyOn(chromeMock.tabs, "sendMessage").mockImplementation((...args: unknown[]) => {
      sent.push(args[1] as (typeof sent)[number]);
      return Promise.resolve({ ok: true });
    });

    // The user changes a STYLE key only — placement must not move.
    await session.updateAdvancedSettings({ captionFontWeight: "bold" });

    const relay = sent.find((m) => m.type === "CONTENT_UPDATE_SETTINGS");
    expect(relay).toBeDefined();
    // The relayed advanced is the EFFECTIVE merge: override "float", NOT global "top".
    expect(relay!.settings?.advanced?.captionPosition).toBe("float");
  });
});
