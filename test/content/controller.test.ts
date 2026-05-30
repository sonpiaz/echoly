import { describe, it, expect, vi, beforeEach } from "vitest";
import { TIER_REALTIME, TIER_STANDARD, type TranslationTier } from "@/shared/constants";
import { createController } from "@/content/controller";
import type { ContentApp } from "@/content/index";
import type { OverlayCallbacks } from "@/shared/ports";

interface Spies {
  notifyBackground: ReturnType<typeof vi.fn>;
  emitEnded: ReturnType<typeof vi.fn>;
  requestHandover: ReturnType<typeof vi.fn>;
  stopSession: ReturnType<typeof vi.fn>;
  applyCaptionOnVideo: ReturnType<typeof vi.fn>;
  applyVolumes: ReturnType<typeof vi.fn>;
}

function makeApp(tier: TranslationTier): {
  cb: OverlayCallbacks;
  spies: Spies;
} {
  const spies: Spies = {
    notifyBackground: vi.fn(),
    emitEnded: vi.fn(),
    requestHandover: vi.fn(),
    stopSession: vi.fn(),
    applyCaptionOnVideo: vi.fn(),
    applyVolumes: vi.fn(),
  };
  const app = {
    sm: {
      settings: { tier, showTargetCaptions: true },
      notifyBackground: spies.notifyBackground,
      emitEnded: spies.emitEnded,
    },
    overlay: { applyCaptionOnVideo: spies.applyCaptionOnVideo },
    webrtc: { requestHandover: spies.requestHandover },
    capture: { applyVolumes: spies.applyVolumes },
    stopSession: spies.stopSession,
  } as unknown as ContentApp;
  return { cb: createController(app), spies };
}

describe("controller — lang/voice (WebRTC handover for both tiers)", () => {
  it("standard: requestHandover on language change", () => {
    const { cb, spies } = makeApp(TIER_STANDARD);
    cb.onLanguageChange("en");
    expect(spies.requestHandover).toHaveBeenCalledWith({ targetLanguage: "en" });
  });

  it("realtime: requestHandover on language change", () => {
    const { cb, spies } = makeApp(TIER_REALTIME);
    cb.onLanguageChange("ja");
    expect(spies.requestHandover).toHaveBeenCalledWith({ targetLanguage: "ja" });
  });

  it("standard: requestHandover with standardVoice", () => {
    const { cb, spies } = makeApp(TIER_STANDARD);
    cb.onVoiceChange("English_ConfidentWoman");
    expect(spies.requestHandover).toHaveBeenCalledWith({
      standardVoice: "English_ConfidentWoman",
    });
  });

  it("realtime: requestHandover with realtimeVoice", () => {
    const { cb, spies } = makeApp(TIER_REALTIME);
    cb.onVoiceChange("coral");
    expect(spies.requestHandover).toHaveBeenCalledWith({ realtimeVoice: "coral" });
  });
});

describe("controller — onStop", () => {
  it("stops locally and requests background STOP sync", () => {
    const { cb, spies } = makeApp(TIER_REALTIME);
    cb.onStop();
    expect(spies.stopSession).toHaveBeenCalledWith("user-stop");
  });
});
