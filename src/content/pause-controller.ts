// Pause/Resume controller — per-tier handling when the source <video> pauses/plays.
//
// Called by content/index.ts onPause / onPlay (after the self-issued + ad guards).
// Routes the user pause/resume through the LifecycleController's reason stack
// (the single owner of video.pause()/play()), drives the tier-specific dub
// freeze/thaw, overlay/emit transitions, and the session-limit timer freeze/thaw.
// Does NOT tear down the session.

import { STATUS_PAUSED_VIDEO } from "@/shared/product-copy";
import { isWebRtcSession, isSubtitleFirstSession } from "./session-manager";
import { STOP_REASON } from "./stop-reasons";
import { syncSourcePauseState } from "@/lib/rtc-media-sync";
import type { ContentApp } from "./index";

/** A source-time delta (seconds) above this between pause and resume means the
 *  user SEEKED while paused (browsers do not fire 'seeked' for a paused seek), so
 *  the subtitle-first dub must re-anchor to the new playhead. 0.5s is comfortably
 *  above normal frame/rounding jitter and below any deliberate scrub. */
const SEEK_WHILE_PAUSED_EPSILON_SEC = 0.5;

/**
 * The source <video> was paused by the user.
 * Routes through `lifecycle.pause('user')` (the controller issues the actual
 * video.pause()), freezes the dub (tier-specific), flips the overlay to paused,
 * and freezes the session-limit timer. Safe to call when no session is active
 * (no-op).
 */
export function pauseSession(app: ContentApp): void {
  const sess = app.sm.session;
  if (!sess) return;
  // Idempotency: if the user reason is already held, nothing to do.
  if (app.lifecycle.isPausedFor("user")) return;

  // Push the 'user' reason → controller calls video.pause() iff the stack was
  // empty (e.g. not already ad-paused). effectivePaused → true → the derived
  // sm.userPaused/videoPaused getters now read paused.
  app.lifecycle.pause("user");

  if (isWebRtcSession(sess)) {
    // Disable sender tracks + pause remoteAudio + suspend AudioContext +
    // POST media-pause to server (fire-and-forget; pause path is not awaited).
    // On a non-ok server response, syncSourcePauseState marks the lifecycle
    // 'connection-lost' reason so the next resume rebuilds the peer.
    void syncSourcePauseState(app.sm, sess, true, app.lifecycle);
    if (sess.pipeline === "standard") {
      // Quiesce dub-sync so it doesn't apply a stale catch-up rate on resume.
      app.standardDubSync?.stop();
    }
  }
  // subtitle-first: the 250ms #playbackTick + #runRollingRenderer already idle
  // when effectivePaused (sm.userPaused) is true. Record the playhead so resume can
  // detect a seek-while-paused (which fires no 'seeked' event → #onSeek never runs).
  if (isSubtitleFirstSession(sess)) {
    const video = app.capture.videoEl;
    sess._pausedAtTime = video ? video.currentTime : undefined;
  }

  app.overlay.setOverlayState("paused");
  app.overlay.setStatusText(STATUS_PAUSED_VIDEO);
  app.sm.emitState({ running: true, paused: true, status: STATUS_PAUSED_VIDEO });
  app.sm.pauseSessionTimer();
}

/**
 * The source <video> started playing again.
 * Rebuilds the peer if it was lost during the pause, re-enables dub audio
 * (tier-specific), flips overlay back to live, and thaws the session-limit timer.
 * Routes the resume through `lifecycle.resume('user')` (the controller issues the
 * actual video.play()). Safe to call when no session is active (no-op).
 *
 * Returns the play() promise from the underlying lifecycle.resume so the caller
 * can await it; the value is not depended on by the onPlay handler (fire-and-
 * forget) but is awaitable for symmetry with the dub-start lock-step (Stage D).
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
export function resumeSession(app: ContentApp): Promise<void> {
  const sess = app.sm.session;
  if (!sess) return Promise.resolve();
  // Idempotency: if the user reason is not held, nothing to do.
  if (!app.lifecycle.isPausedFor("user")) return Promise.resolve();

  // ── Peer-death recovery (WebRTC only) — unchanged ──────────────────────────
  if (app.lifecycle.isPausedFor("connection-lost") && isWebRtcSession(sess)) {
    const settings = app.sm.settings;
    if (!settings) {
      app.stopSession(STOP_REASON.CONNECTION_LOST);
      return Promise.resolve();
    }
    void app.webrtc.continueOnNewVideo(settings).then((result) => {
      if (!result.ok) {
        app.stopSession(STOP_REASON.CONNECTION_LOST);
        return;
      }
      // Rebuilt OK — pop both the connection-lost and user reasons. resume('user')
      // (popped last) issues the controller's video.play() since the stack empties.
      void app.lifecycle.resume("connection-lost");
      void app.lifecycle.resume("user").catch(() => {});
      app.sm.emitState({ running: true, paused: false, status: "Translating" });
      app.sm.resumeSessionTimer();
    });
    return Promise.resolve();
  }

  // Pop the 'user' reason → controller calls video.play() iff the stack becomes
  // empty. Returns the play() promise (may reject on autoplay-block — fire-and-
  // forget here; the overlay already reflects live).
  const playPromise = app.lifecycle.resume("user");
  playPromise.catch(() => {});

  if (isWebRtcSession(sess)) {
    // Fire-and-forget: re-enable sender tracks + remoteAudio + AudioContext +
    // media-resume POST. NOT awaited — awaiting it froze the video on resume.
    // The server gate reopens in the background; audio resumes as soon as it does.
    void syncSourcePauseState(app.sm, sess, false, app.lifecycle);
    if (sess.pipeline === "standard") {
      // Re-anchor + restart the drift corrector. snapPlaybackStart() resets
      // stopped=false (the real bug fix), so the engine ticks again and smooths
      // any brief dub-lag via its rate ramp — no video hold needed.
      app.standardDubSync?.snapPlaybackStart();
      app.standardDubSync?.start();
    }
  } else if (isSubtitleFirstSession(sess)) {
    // If the user SEEKED while paused, the browser fired no 'seeked' event (see
    // pauseSession), so #onSeek never re-anchored and the dub would resume on the
    // STALE pre-seek line (the "lồng tiếng sai sau khi tua lúc pause" bug). Detect
    // the moved playhead and re-anchor to the new position. resume('user') above
    // already cleared the pause, so reAnchor's #playbackTick plays the right line
    // immediately. A plain pause/resume (no seek) skips this → no needless replay.
    const video = app.capture.videoEl;
    const pausedAt = sess._pausedAtTime;
    sess._pausedAtTime = undefined;
    if (
      video &&
      pausedAt != null &&
      Math.abs(video.currentTime - pausedAt) > SEEK_WHILE_PAUSED_EPSILON_SEC
    ) {
      app.subtitleFirst.reAnchor(sess, video);
    }
  }
  // subtitle-first (no seek): the 250ms #playbackTick + #runRollingRenderer resume
  // naturally once effectivePaused is false; #playbackTick micro-pauses ONLY if the
  // due cue is genuinely un-buffered (same fallback as before). No proactive re-pause.

  app.overlay.setOverlayState("live");
  app.overlay.setStatusText("Translating");
  app.sm.emitState({ running: true, paused: false, status: "Translating" });
  app.sm.resumeSessionTimer();
  return playPromise;
}
