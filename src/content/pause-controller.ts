// Pause/Resume controller — per-tier handling when the source <video> pauses/plays.
//
// Called by content/index.ts onPause / onPlay (after the ad guard and _systemPaused
// guard). Owns the canonical userPaused flag, overlay/emit transitions, and the
// session-limit timer freeze/thaw. Does NOT tear down the session.

import { STATUS_PAUSED_VIDEO } from "@/shared/product-copy";
import {
  isSubtitleFirstSession,
  isWebRtcSession,
} from "./session-manager";
import { STOP_REASON } from "./stop-reasons";
import { syncSourcePauseState } from "@/lib/rtc-media-sync";
import type { ContentApp } from "./index";

/**
 * The source <video> was paused by the user.
 * Freezes the dub (tier-specific), flips overlay to paused, and freezes the
 * session-limit timer. Safe to call when no session is active (no-op).
 */
export function pauseSession(app: ContentApp): void {
  const sess = app.sm.session;
  if (!sess) return;
  // Idempotency: if already user-paused, nothing to do.
  if (app.sm.userPaused) return;

  app.sm.userPaused = true;

  if (isWebRtcSession(sess)) {
    // Disable sender tracks + pause remoteAudio + suspend AudioContext +
    // POST media-pause to server. On a non-ok server response, syncSourcePauseState
    // sets sm.connectionLost = true so resumeSession can rebuild.
    syncSourcePauseState(app.sm, sess, true);
    if (sess.pipeline === "standard") {
      // Quiesce dub-sync so it doesn't apply a stale catch-up rate on resume.
      app.standardDubSync?.stop();
    }
  }
  // subtitle-first: the 250ms #playbackTick + #runRollingRenderer already idle
  // when sm.userPaused is true — no extra action needed.

  app.overlay.setOverlayState("paused");
  app.overlay.setStatusText(STATUS_PAUSED_VIDEO);
  app.sm.emitState({ running: true, paused: true, status: STATUS_PAUSED_VIDEO });
  app.sm.pauseSessionTimer();
}

/**
 * The source <video> started playing again.
 * Rebuilds the peer if it was lost during the pause, re-enables dub audio
 * (tier-specific), flips overlay back to live, and thaws the session-limit timer.
 * Safe to call when no session is active (no-op).
 */
export function resumeSession(app: ContentApp): void {
  const sess = app.sm.session;
  if (!sess) return;
  // Idempotency: if not user-paused, nothing to do.
  if (!app.sm.userPaused) return;

  // ── Peer-death recovery (WebRTC only) ──────────────────────────────────────
  if (app.sm.connectionLost && isWebRtcSession(sess)) {
    // Attempt one rebuild with the current settings — keeps overlay + bg session.
    const settings = app.sm.settings;
    if (!settings) {
      app.stopSession(STOP_REASON.CONNECTION_LOST);
      return;
    }
    // continueOnNewVideo rebuilds the peer in-place (same video, new session).
    void app.webrtc.continueOnNewVideo(settings).then((result) => {
      if (!result.ok) {
        app.stopSession(STOP_REASON.CONNECTION_LOST);
        return;
      }
      app.sm.connectionLost = false;
      app.sm.userPaused = false;
      // continueOnNewVideo already set overlay to live — emit state.
      app.sm.emitState({ running: true, paused: false, status: "Translating" });
      app.sm.resumeSessionTimer();
    });
    return;
  }

  app.sm.userPaused = false;

  if (isWebRtcSession(sess)) {
    // Re-enable sender tracks + resume remoteAudio + resume AudioContext +
    // POST media-resume to server.
    syncSourcePauseState(app.sm, sess, false);
    if (sess.pipeline === "standard") {
      // Re-anchor dub-sync at the current resume playhead so no stale rate is applied.
      app.standardDubSync?.snapPlaybackStart();
      app.standardDubSync?.start();
    }
  }
  // subtitle-first: the driver's next 250ms tick resumes naturally — no action needed.

  app.overlay.setOverlayState("live");
  app.overlay.setStatusText("Translating");
  app.sm.emitState({ running: true, paused: false, status: "Translating" });
  app.sm.resumeSessionTimer();
}
