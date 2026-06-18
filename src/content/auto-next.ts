// Auto-next continuation — restart-in-place when the user navigates to the next
// video (SPA navigation or YouTube autoplay) while dubbing is active.
//
// Orchestrates SOLUTION §2.3: switching overlay/emit → wait video ready → rebind
// listeners → dispatch by tier → fallbacks (§2.4) → on any failure, clean stop.
// Guards against rapid re-entry via a module-level generation counter (activeGen).
// Each call increments activeGen and captures myGen; if a newer call supersedes this
// one, myGen !== activeGen and we bail cheaply at every async boundary.

import type { ContentApp } from "./index";
import { isSubtitleFirstSession, isWebRtcSession } from "./session-manager";
import { STOP_REASON } from "./stop-reasons";
import { shouldIgnoreSourcePlaybackEvent } from "./source-playback-guards";
import {
  STATUS_SWITCHING_VIDEO,
  STATUS_LOADING_NEXT,
} from "@/shared/product-copy";

/**
 * Module-level generation counter. Incremented on each continueOnNewVideo call.
 * A call captures myGen = ++activeGen at entry; if myGen !== activeGen at any
 * async boundary, a newer call has superseded this one and we bail.
 *
 * Unlike the pageToken approach, this does NOT depend on sm.nextToken(), so it
 * remains valid even after subtitleFirst.restart() or webrtc.continueOnNewVideo()
 * bump the pageToken internally (which is what caused the success block to be
 * unreachable in the old pageToken guard).
 */
let activeGen = 0;

/**
 * Continue dubbing on `newVideoId` without tearing down the overlay or the
 * background session. Called by NavigationWatcher when a new watch-URL is
 * detected while a session is running.
 *
 * Entry: session is running, overlay is mounted, `sm.session` is set.
 * Exit (success): overlay is `live`, dub is running on the new video.
 * Exit (failure): `stopSession(NEXT_VIDEO_LOAD_FAILED)` is called and the
 *   overlay is unmounted — never left stuck on `switching`.
 *
 * @param app       The shared ContentApp orchestration object.
 * @param newVideoId The stable per-video id for the destination video.
 */
export async function continueOnNewVideo(
  app: ContentApp,
  newVideoId: string,
): Promise<void> {
  const { sm, overlay } = app;

  // ── Increment generation counter at entry ────────────────────────────────
  // Rapid navigations increment activeGen; any earlier in-flight call sees
  // myGen !== activeGen at the next async boundary and bails without calling
  // stopSession (the newer call owns the session).
  const myGen = ++activeGen;
  console.info("[auto-next] continueOnNewVideo START", { newVideoId, gen: myGen });

  try {
    // ── 1. Switching state ───────────────────────────────────────────────────
    // Drive the lifecycle into `switching` (legal from dubbing/paused; a no-op if
    // a soft-stop already parked us there). The rebuild below transitions
    // switching → starting; success transitions starting → dubbing.
    if (
      app.lifecycle.state === "dubbing" ||
      app.lifecycle.state === "paused"
    ) {
      app.lifecycle.transition("switching");
    }
    // Drop the user pause reason WITHOUT issuing a video.play() — the rebuild
    // below owns playback of the NEW video (controller still points at the old
    // one here). The connection-lost reason (if any) is also cleared since this
    // path supersedes a resume-rebuild.
    app.lifecycle.dropReason("user");
    app.lifecycle.dropReason("connection-lost");
    overlay.setOverlayState("switching");
    overlay.setStatusText(STATUS_SWITCHING_VIDEO);
    sm.emitState({ running: true, paused: false, status: STATUS_SWITCHING_VIDEO });

    // ── 2. Wait for the new video element to be ready (ad-aware) ──────────────
    // Poll for:
    //   • readyState >= HAVE_FUTURE_DATA (3) — data is loaded and playing is possible
    //   • currentTime > 0 — the video has actually started loading frames
    //   • not an ad — shouldIgnoreSourcePlaybackEvent is true while a YouTube ad plays
    //
    // The base budget is ~9s. BUT a pre-roll ad between videos can run 15–30s
    // before the real content video is ready — during which the readiness probe
    // is the AD clock and shouldIgnoreSourcePlaybackEvent() is true. So while an
    // ad is playing we KEEP waiting (the ad isn't a load failure), bounded by an
    // absolute upper cap (~60s) so a genuinely stuck load still fails cleanly.
    const MAX_WAIT_MS = 9000;
    const AD_ABSOLUTE_CAP_MS = 60000;
    const POLL_INTERVAL_MS = 200;
    const waitStart = Date.now();

    let video: HTMLVideoElement | null = null;
    let ready = false;
    while (true) {
      // Bail if a newer auto-next has superseded this one.
      if (myGen !== activeGen) return;

      const elapsed = Date.now() - waitStart;
      const adPlaying = shouldIgnoreSourcePlaybackEvent(app.adapter);

      video = app.adapter.findVideo() ?? app.capture.findVideo();
      if (
        video &&
        video.readyState >= 3 /* HAVE_FUTURE_DATA */ &&
        video.currentTime > 0 &&
        !adPlaying
      ) {
        ready = true;
        break;
      }

      // Budget check: past the base budget, only keep waiting if an ad is still
      // playing (a long pre-roll). The absolute cap guards against a hung load.
      if (elapsed >= MAX_WAIT_MS && !adPlaying) break;
      if (elapsed >= AD_ABSOLUTE_CAP_MS) break;

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    if (myGen !== activeGen) { console.info("[auto-next] superseded after poll", { gen: myGen }); return; }
    if (!ready || !video) {
      console.warn("[auto-next] new video NOT ready within poll budget → STOP", {
        ready, hasVideo: !!video, elapsedMs: Date.now() - waitStart,
      });
      app.stopSession(STOP_REASON.NEXT_VIDEO_LOAD_FAILED);
      return;
    }
    console.info("[auto-next] new video ready", { readyState: video.readyState, currentTime: video.currentTime });

    // ── 3. Update capture references BEFORE the async caption fetch ─────────
    // Record the new video element so capture.videoEl is always current.
    // NOTE: for the subtitle-first path, the proper onSeeked/onEndedBefore
    // listeners are bound inside restart() itself (Fix #2) — binding an empty
    // set here would clobber them.  For the WebRTC path, webrtc.continueOnNewVideo
    // binds its own listeners internally.  So we intentionally skip the empty
    // bindCommonVideoListeners call here.
    app.capture.videoEl = video;
    // The controller owns video.pause()/play() — point it at the NEW video so
    // the rebuild's pause/resume route through the new element.
    app.lifecycle.setVideo(video);
    app.capture.bindVolumeDriftGuard(video);

    if (myGen !== activeGen) return;

    // ── 4. Determine the current session tier and dispatch ───────────────────
    const session = sm.session;
    const settings = sm.settings;
    if (!session || !settings) {
      app.stopSession(STOP_REASON.NEXT_VIDEO_LOAD_FAILED);
      return;
    }

    const isSubtitleFirst = isSubtitleFirstSession(session);
    const liveProbe = app.capture.isLive(video);
    console.info("[auto-next] dispatch", {
      isSubtitleFirst, liveProbe, hasVideoId: !!app.adapter.getVideoId(location.href),
    });

    // switching → starting: the new video is ready; we're about to (re)build the
    // dub pipeline on it. (No-op if a prior path already advanced the state.)
    if (app.lifecycle.state === "switching") {
      app.lifecycle.transition("starting");
    }

    // Subtitle-first is eligible when:
    //   • adapter supports it,
    //   • the URL yields a stable videoId, and
    //   • the new video is not a live stream.
    const subtitleFirstEligible =
      isSubtitleFirst &&
      app.adapter.capabilities.subtitleFirst &&
      !!app.adapter.getVideoId(location.href) &&
      !liveProbe;

    if (subtitleFirstEligible) {
      // ── Subtitle-first path ─────────────────────────────────────────────
      // Emit STATUS_LOADING_NEXT between video-ready and caption fetch so the
      // user sees "Loading next video…" rather than a frozen "Switching…".
      overlay.setStatusText(STATUS_LOADING_NEXT);
      sm.emitState({ running: true, paused: false, status: STATUS_LOADING_NEXT });

      // Thread the ready-poll-validated element so restart() does not re-query
      // findVideo() during Shaka's lecture-recreate window (which returned null /
      // a stale element → the no-dub-on-next-lecture bug).
      const r = await app.subtitleFirst.restart(settings, newVideoId, video);
      console.info("[auto-next] subtitleFirst.restart result", r);

      if (myGen !== activeGen) return;

      if (!r.ok) {
        // No captions for the new video — try to fall back to Standard-WebRTC.
        // Probe per-lecture (Udemy: non-DRM next video can still capture audio).
        const probeVideo = video ?? app.capture.videoEl ?? app.adapter.findVideo();
        const canCaptureAudio = probeVideo
          ? (app.adapter.canCaptureAudioNow?.(probeVideo) ??
             app.adapter.capabilities.audioCapture)
          : app.adapter.capabilities.audioCapture;
        if (canCaptureAudio) {
          const r2 = await app.webrtc.continueOnNewVideo({ ...settings });
          if (myGen !== activeGen) return;
          if (!r2.ok) {
            app.stopSession(STOP_REASON.NEXT_VIDEO_LOAD_FAILED);
            return;
          }
        } else {
          // DRM platform (Udemy) — no audio capture, no captions.
          app.stopSession(STOP_REASON.NO_CC_UNSUPPORTED);
          return;
        }
      }
    } else if (isWebRtcSession(session)) {
      // ── WebRTC path (Realtime or Standard-WebRTC) ───────────────────────
      const r = await app.webrtc.continueOnNewVideo({ ...settings });

      if (myGen !== activeGen) return;

      if (!r.ok) {
        app.stopSession(STOP_REASON.NEXT_VIDEO_LOAD_FAILED);
        return;
      }
    } else {
      // Unknown session kind — fall back to a clean stop.
      app.stopSession(STOP_REASON.NEXT_VIDEO_LOAD_FAILED);
      return;
    }

    if (myGen !== activeGen) return;

    // ── 5. Success — return to live state ───────────────────────────────────
    // This block is now reachable: the generation guard does NOT depend on
    // sm.pageToken, so bumps inside restart()/continueOnNewVideo() do not
    // falsely suppress the success transition.
    // Re-arm the AdWatcher on the NEW video — the soft-stop tore down the old
    // one, and YouTube re-creates #movie_player across the SPA nav so the
    // observer must re-attach (an ad can run on the next autoplay video).
    app.startAdWatcher();
    // starting → dubbing: the new video's dub is live.
    if (app.lifecycle.state === "starting") {
      app.lifecycle.transition("dubbing");
    }
    overlay.setOverlayState("live");
    overlay.setStatusText("Translating");
    sm.emitState({ running: true, paused: false, status: "Translating" });
  } catch {
    // Safety net — never leave the overlay stuck on "switching".
    // Only call stopSession if this is still the active generation.
    if (myGen === activeGen) {
      app.stopSession(STOP_REASON.NEXT_VIDEO_LOAD_FAILED);
    }
  }
}
