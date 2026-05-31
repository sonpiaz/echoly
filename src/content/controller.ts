// OverlayCallbacks — lang/voice changes trigger WebRTC handover on both tiers.

import type { OverlayCallbacks } from "@/shared/ports";
import { post } from "@/shared/protocol";
import { isSubtitleFirstSession } from "./session-manager";
import { STOP_REASON } from "./stop-reasons";
import type { ContentApp } from "./index";

export function createController(app: ContentApp): OverlayCallbacks {
  const { sm, overlay } = app;
  return {
    onLanguageChange(lang: string): void {
      if (isSubtitleFirstSession(sm.session) && sm.settings) {
        sm.settings = { ...sm.settings, targetLanguage: lang };
        sm.notifyBackground({
          type: "UPDATE_SETTINGS",
          settings: { targetLanguage: lang },
        });
        overlay.setStatusText("Switching to " + lang);
        overlay.setOverlayState("live");
        return;
      }
      void app.webrtc.requestHandover({ targetLanguage: lang });
    },
    onVoiceChange(voiceId: string): void {
      const patch =
        sm.settings?.tier === "standard"
          ? { standardVoice: voiceId }
          : { realtimeVoice: voiceId };
      if (isSubtitleFirstSession(sm.session) && sm.settings) {
        sm.settings = { ...sm.settings, ...patch };
        sm.notifyBackground({ type: "UPDATE_SETTINGS", settings: patch });
        overlay.setStatusText("Switching voice");
        overlay.setOverlayState("live");
        return;
      }
      void app.webrtc.requestHandover(patch);
    },
    onTargetCaptionVisibilityChange(show: boolean): void {
      sm.settings = {
        ...(sm.settings || {}),
        showTargetCaptions: show,
      } as typeof sm.settings;
      sm.notifyBackground({
        type: "UPDATE_SETTINGS",
        settings: { showTargetCaptions: show },
      });
      overlay.applyCaptionOnVideo(show);
    },
    onMixChange(originalVolume: number, voiceVolume: number): void {
      sm.settings = {
        ...(sm.settings || {}),
        originalVolume,
        voiceVolume,
      } as typeof sm.settings;
      sm.notifyBackground({
        type: "UPDATE_SETTINGS",
        settings: { originalVolume, voiceVolume },
      });
      app.capture.applyVolumes(originalVolume, voiceVolume);
    },
    onStop(): void {
      app.stopSession(STOP_REASON.USER_STOP);
      post({ type: "CONTENT_STOP_REQUEST" });
    },
  };
}
