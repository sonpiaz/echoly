// ────────────────────────────────────────────────────────────────────────────
// Controller — constructs the OverlayCallbacks (the UI↔logic seam). The overlay
// binds the <select>/Stop DOM events and only INVOKES these callbacks; the EXACT
// realtime-vs-standard branch lives here. This branch is load-bearing — it
// preserves BUGS C1/H3 behavior (characterization-tested), so the branch is NOT
// "fixed" here. (legacy/content.js: langSelect change 253-265, voiceSelect
// change 266-274, stopBtn click 280-284.)
//
// Branch (locked in @/shared/ports):
//   • realtime tier  ⇒ requestHandover(newValue)
//   • standard tier  ⇒ mutate settings in place + notifyBackground(UPDATE_SETTINGS)
//                       [+ for language: setStatusText("Switching to …") +
//                          setOverlayState("live")]
//   • onStop         ⇒ stopSession("user-stop") + emit Stopped state + ended
// ────────────────────────────────────────────────────────────────────────────

import { LANG_NAME } from "@/shared/constants";
import type { OverlayCallbacks } from "@/shared/ports";
import type { ContentApp } from "./index";

export function createController(app: ContentApp): OverlayCallbacks {
  const { sm, overlay } = app;
  return {
    onLanguageChange(lang: string): void {
      if (sm.settings?.tier === "standard") {
        // Standard pipeline picks up the new prompt on the next chunk; no
        // tear-down. Push to background so the popup stays in sync.
        sm.settings.targetLanguage = lang;
        sm.notifyBackground({
          type: "UPDATE_SETTINGS",
          settings: { targetLanguage: lang },
        });
        overlay.setStatusText("Switching to " + (LANG_NAME[lang] || lang));
        overlay.setOverlayState("live");
      } else {
        void app.realtime.requestHandover({ targetLanguage: lang });
      }
    },
    onVoiceChange(voiceId: string): void {
      if (sm.settings?.tier === "standard") {
        sm.settings.standardVoice = voiceId;
        sm.notifyBackground({
          type: "UPDATE_SETTINGS",
          settings: { standardVoice: voiceId },
        });
      } else {
        void app.realtime.requestHandover({ realtimeVoice: voiceId });
      }
    },
    onStop(): void {
      app.stopSession("user-stop");
      sm.notifyBackground({
        type: "CONTENT_STATE",
        running: false,
        status: "Stopped",
      });
      sm.emitEnded("Stopped");
    },
  };
}
