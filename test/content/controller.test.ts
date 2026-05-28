// AC1b (iv) — characterization test for the OverlayCallbacks realtime-vs-standard
// branch (src/content/controller.ts). This branch is load-bearing (preserves
// BUGS C1/H3): a language/voice change must tear down + re-handover on the
// realtime tier, but mutate-in-place + notify on the standard tier. onStop must
// stop + emit Stopped + ended. Verified against legacy/content.js:253-284.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createController } from "@/content/controller";
import type { ContentApp } from "@/content/index";
import type { OverlayCallbacks } from "@/shared/ports";

interface Spies {
  notifyBackground: ReturnType<typeof vi.fn>;
  emitEnded: ReturnType<typeof vi.fn>;
  setStatusText: ReturnType<typeof vi.fn>;
  setOverlayState: ReturnType<typeof vi.fn>;
  requestHandover: ReturnType<typeof vi.fn>;
  stopSession: ReturnType<typeof vi.fn>;
}

// Build a minimal fake ContentApp with the surface createController touches.
function makeApp(tier: "realtime" | "standard"): {
  cb: OverlayCallbacks;
  spies: Spies;
  settings: { tier: string; targetLanguage: string; standardVoice: string };
} {
  const spies: Spies = {
    notifyBackground: vi.fn(),
    emitEnded: vi.fn(),
    setStatusText: vi.fn(),
    setOverlayState: vi.fn(),
    requestHandover: vi.fn(),
    stopSession: vi.fn(),
  };
  const settings = { tier, targetLanguage: "vi", standardVoice: "English_magnetic_voiced_man" };
  const app = {
    sm: { settings, notifyBackground: spies.notifyBackground, emitEnded: spies.emitEnded },
    overlay: { setStatusText: spies.setStatusText, setOverlayState: spies.setOverlayState },
    realtime: { requestHandover: spies.requestHandover },
    stopSession: spies.stopSession,
  } as unknown as ContentApp;
  return { cb: createController(app), spies, settings };
}

describe("controller — onLanguageChange", () => {
  it("standard tier: mutates settings + notifies + status, NO handover", () => {
    const { cb, spies, settings } = makeApp("standard");
    cb.onLanguageChange("en");
    expect(settings.targetLanguage).toBe("en");
    expect(spies.notifyBackground).toHaveBeenCalledWith({
      type: "UPDATE_SETTINGS",
      settings: { targetLanguage: "en" },
    });
    expect(spies.setStatusText).toHaveBeenCalledWith("Switching to English");
    expect(spies.setOverlayState).toHaveBeenCalledWith("live");
    expect(spies.requestHandover).not.toHaveBeenCalled();
  });

  it("realtime tier: requestHandover only, NO settings mutation / notify", () => {
    const { cb, spies, settings } = makeApp("realtime");
    cb.onLanguageChange("ja");
    expect(spies.requestHandover).toHaveBeenCalledWith({ targetLanguage: "ja" });
    expect(spies.notifyBackground).not.toHaveBeenCalled();
    expect(spies.setStatusText).not.toHaveBeenCalled();
    // settings is NOT mutated in place on the realtime path (handover owns it)
    expect(settings.targetLanguage).toBe("vi");
  });
});

describe("controller — onVoiceChange", () => {
  it("standard tier: mutates standardVoice + notifies, NO handover", () => {
    const { cb, spies, settings } = makeApp("standard");
    cb.onVoiceChange("English_ConfidentWoman");
    expect(settings.standardVoice).toBe("English_ConfidentWoman");
    expect(spies.notifyBackground).toHaveBeenCalledWith({
      type: "UPDATE_SETTINGS",
      settings: { standardVoice: "English_ConfidentWoman" },
    });
    expect(spies.requestHandover).not.toHaveBeenCalled();
  });

  it("realtime tier: requestHandover with realtimeVoice, NO notify", () => {
    const { cb, spies } = makeApp("realtime");
    cb.onVoiceChange("coral");
    expect(spies.requestHandover).toHaveBeenCalledWith({ realtimeVoice: "coral" });
    expect(spies.notifyBackground).not.toHaveBeenCalled();
  });
});

describe("controller — onStop", () => {
  it("stops, emits Stopped CONTENT_STATE, and ends", () => {
    const { cb, spies } = makeApp("realtime");
    cb.onStop();
    expect(spies.stopSession).toHaveBeenCalledWith("user-stop");
    expect(spies.notifyBackground).toHaveBeenCalledWith({
      type: "CONTENT_STATE",
      running: false,
      status: "Stopped",
    });
    expect(spies.emitEnded).toHaveBeenCalledWith("Stopped");
  });
});
