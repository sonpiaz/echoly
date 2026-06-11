// Tests for applyServerBundle split (C7):
//   • 3 Advanced keys → state.advanced
//   • 7 synced Settings keys → flat Settings (state.tier/targetLanguage/…)
//   • realtime coercion for non-Max
//   • No push triggered (applyServerBundle is a pure pull)
import { describe, it, expect, vi, beforeEach } from "vitest";
import { resetChrome } from "../setup";
import { Store } from "@/background/store";
import { EcholyAuth } from "@/background/auth";
import { DEFAULT_ADVANCED } from "@/shared/advanced";
import { TIER_REALTIME, TIER_STANDARD } from "@/shared/constants";
import type { SignedInUser } from "@/shared/types";

function buildStore(): Store {
  const auth = new EcholyAuth();
  return new Store(auth);
}

const BASE_BUNDLE = {
  settings: {
    // 3 Advanced keys
    captionPosition: "top" as const,
    autoStartHosts: { "youtube.com": true },
    outputDeviceId: "device-abc",
    // 7 synced Settings keys
    mode: "standard" as const,
    targetLanguage: "ja",
    sourceLanguage: "en",
    standardVoice: "English_captivating_female1",
    realtimeVoice: "coral",
    showSource: true,
    showTargetCaptions: false,
  },
  siteOverrides: { "youtube.com": { captionPosition: "bottom" as const } },
  version: 5,
  updatedAt: "2026-06-01T00:00:00.000Z",
};

beforeEach(() => {
  resetChrome();
});

describe("Store.applyServerBundle — 3/7 split (C7)", () => {
  it("routes captionPosition, autoStartHosts, outputDeviceId to state.advanced", async () => {
    const store = buildStore();
    await store.applyServerBundle(BASE_BUNDLE);

    expect(store.state.advanced.captionPosition).toBe("top");
    expect(store.state.advanced.autoStartHosts).toEqual({ "youtube.com": true });
    expect(store.state.advanced.outputDeviceId).toBe("device-abc");
  });

  it("routes the 7 synced keys to flat state fields", async () => {
    const store = buildStore();
    await store.applyServerBundle(BASE_BUNDLE);

    expect(store.state.tier).toBe(TIER_STANDARD);
    expect(store.state.targetLanguage).toBe("ja");
    expect(store.state.sourceLanguage).toBe("en");
    expect(store.state.standardVoice).toBe("English_captivating_female1");
    expect(store.state.realtimeVoice).toBe("coral");
    expect(store.state.showSource).toBe(true);
    expect(store.state.showTargetCaptions).toBe(false);
  });

  it("sets siteOverrides and version, clears dirty flag", async () => {
    const store = buildStore();
    store.setAdvancedDirty(true);
    await store.applyServerBundle(BASE_BUNDLE);

    expect(store.state.siteOverrides).toEqual({ "youtube.com": { captionPosition: "bottom" } });
    expect(store.state.advancedVersion).toBe(5);
    expect(store.state.advancedDirty).toBe(false);
  });

  it("coerces mode:realtime → standard for non-Max user", async () => {
    const store = buildStore();
    const nonMaxUser: SignedInUser = { email: "u@example.com", tier: "pro" };
    store.setSignedInUser(nonMaxUser);

    const realtimeBundle = {
      ...BASE_BUNDLE,
      settings: { ...BASE_BUNDLE.settings, mode: "realtime" as const },
    };
    await store.applyServerBundle(realtimeBundle);

    // non-Max cannot use realtime → coerced to standard
    expect(store.state.tier).toBe(TIER_STANDARD);
  });

  it("allows mode:realtime for Max user", async () => {
    const store = buildStore();
    const maxUser: SignedInUser = { email: "u@example.com", tier: "max" };
    store.setSignedInUser(maxUser);

    const realtimeBundle = {
      ...BASE_BUNDLE,
      settings: { ...BASE_BUNDLE.settings, mode: "realtime" as const },
    };
    await store.applyServerBundle(realtimeBundle);

    expect(store.state.tier).toBe(TIER_REALTIME);
  });

  it("does NOT trigger any chrome.runtime.sendMessage (no push)", async () => {
    const store = buildStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chromeMock = (globalThis as any).chrome as { runtime: { sendMessage: ReturnType<typeof vi.fn> } };
    const origSendMessage = chromeMock.runtime.sendMessage;
    chromeMock.runtime.sendMessage = vi.fn();
    await store.applyServerBundle(BASE_BUNDLE);

    // applyServerBundle is a pure pull — it must not push to server.
    expect(chromeMock.runtime.sendMessage).not.toHaveBeenCalled();
    chromeMock.runtime.sendMessage = origSendMessage;
  });

  it("falls back to current state.advanced values when Advanced keys are absent from bundle", async () => {
    const store = buildStore();
    // First set a known advanced state
    await store.applyServerBundle(BASE_BUNDLE);
    expect(store.state.advanced.captionPosition).toBe("top");

    // Bundle with only synced keys, no Advanced overrides
    const partialBundle = {
      settings: {
        mode: "standard" as const,
        targetLanguage: "fr",
        sourceLanguage: "auto",
        standardVoice: "English_magnetic_voiced_man",
        realtimeVoice: "marin",
        showSource: false,
        showTargetCaptions: true,
        // captionPosition/autoStartHosts/outputDeviceId absent
      },
      siteOverrides: {},
      version: 6,
      updatedAt: "2026-06-02T00:00:00.000Z",
    };
    await store.applyServerBundle(partialBundle as typeof BASE_BUNDLE);

    // captionPosition should keep the value applied in the first bundle
    expect(store.state.advanced.captionPosition).toBe("top");
    expect(store.state.targetLanguage).toBe("fr");
  });

  it("does NOT overwrite a good language with an empty-string code from the bundle (lang-default-empty fix)", async () => {
    const store = buildStore();
    // First a healthy bundle sets concrete language codes.
    await store.applyServerBundle(BASE_BUNDLE);
    expect(store.state.targetLanguage).toBe("ja");
    expect(store.state.sourceLanguage).toBe("en");

    // A later (legacy/corrupt) bundle carries empty-string codes. The truthy guard
    // must keep the existing good values rather than propagating "" to the overlay
    // LANGUAGE dropdown (which would render blank). Voices keep `!== undefined`.
    const emptyLangBundle = {
      ...BASE_BUNDLE,
      settings: { ...BASE_BUNDLE.settings, targetLanguage: "", sourceLanguage: "" },
      version: 7,
    };
    await store.applyServerBundle(emptyLangBundle);

    expect(store.state.targetLanguage).toBe("ja");
    expect(store.state.sourceLanguage).toBe("en");
  });
});
