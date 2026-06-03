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
    // POST media-pause to server (fire-and-forget; pause path is not awaited).
    // On a non-ok server response, syncSourcePauseState sets sm.connectionLost = true.
    void syncSourcePauseState(app.sm, sess, true);
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
 *
 * NON-BLOCKING by design. An earlier version held the video on resume behind an
 * awaited server media-gate POST + a dub-buffer gate (waitForFirstDub) + a fixed
 * settle sleep — which froze the video for hundreds of ms to several seconds on
 * every press-play (a worse regression than the brief A/V drift it tried to fix).
 * Instead we kick the re-enable off in the BACKGROUND (fire-and-forget) and let
 * the Standard-WebRTC drift corrector smooth any momentary dub lag via its rate
 * ramp — snapPlaybackStart() now resets stopped=false so the engine actually
 * ticks again after a pause (the one genuine fix worth keeping). Subtitle-first
 * resumes on its own 250ms #playbackTick.
 */
export function resumeSession(app: ContentApp): void {
  const sess = app.sm.session;
  if (!sess) return;
  // Idempotency: if not user-paused, nothing to do.
  if (!app.sm.userPaused) return;

  // ── Peer-death recovery (WebRTC only) — unchanged ──────────────────────────
  if (app.sm.connectionLost && isWebRtcSession(sess)) {
    const settings = app.sm.settings;
    if (!settings) {
      app.stopSession(STOP_REASON.CONNECTION_LOST);
      return;
    }
    void app.webrtc.continueOnNewVideo(settings).then((result) => {
      if (!result.ok) {
        app.stopSession(STOP_REASON.CONNECTION_LOST);
        return;
      }
      app.sm.connectionLost = false;
      app.sm.userPaused = false;
      app.sm.emitState({ running: true, paused: false, status: "Translating" });
      app.sm.resumeSessionTimer();
    });
    return;
  }

  app.sm.userPaused = false;

  if (isWebRtcSession(sess)) {
    // Fire-and-forget: re-enable sender tracks + remoteAudio + AudioContext +
    // media-resume POST. NOT awaited — awaiting it froze the video on resume.
    // The server gate reopens in the background; audio resumes as soon as it does.
    void syncSourcePauseState(app.sm, sess, false);
    if (sess.pipeline === "standard") {
      // Re-anchor + restart the drift corrector. snapPlaybackStart() resets
      // stopped=false (the real bug fix), so the engine ticks again and smooths
      // any brief dub-lag via its rate ramp — no video hold needed.
      app.standardDubSync?.snapPlaybackStart();
      app.standardDubSync?.start();
    }
  }
  // subtitle-first: the 250ms #playbackTick + #runRollingRenderer resume naturally
  // once userPaused is false; #playbackTick step 4 micro-pauses ONLY if the due
  // cue is genuinely un-buffered (same fallback as before). No proactive re-pause.

  app.overlay.setOverlayState("live");
  app.overlay.setStatusText("Translating");
  app.sm.emitState({ running: true, paused: false, status: "Translating" });
  app.sm.resumeSessionTimer();
}
