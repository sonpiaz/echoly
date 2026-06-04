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

  try {
    // ── 1. Switching state ───────────────────────────────────────────────────
    sm.userPaused = false;
    overlay.setOverlayState("switching");
    overlay.setStatusText(STATUS_SWITCHING_VIDEO);
    sm.emitState({ running: true, paused: false, status: STATUS_SWITCHING_VIDEO });

    // ── 2. Wait for the new video element to be ready ────────────────────────
    // Poll up to ~9 s (200ms × 45) for:
    //   • readyState >= HAVE_FUTURE_DATA (3) — data is loaded and playing is possible
    //   • currentTime > 0 — the video has actually started loading frames
    //   • not an ad — shouldIgnoreSourcePlaybackEvent suppresses ad-driven states
    const MAX_WAIT_MS = 9000;
    const POLL_INTERVAL_MS = 200;
    const waitStart = Date.now();

    let video: HTMLVideoElement | null = null;
    let ready = false;
    while (Date.now() - waitStart < MAX_WAIT_MS) {
      // Bail if a newer auto-next has superseded this one.
      if (myGen !== activeGen) return;

      video = app.adapter.findVideo() ?? app.capture.findVideo();
      if (
        video &&
        video.readyState >= 3 /* HAVE_FUTURE_DATA */ &&
        video.currentTime > 0 &&
        !shouldIgnoreSourcePlaybackEvent(app.adapter)
      ) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    if (myGen !== activeGen) return;
    if (!ready || !video) {
      app.stopSession(STOP_REASON.NEXT_VIDEO_LOAD_FAILED);
      return;
    }

    // ── 3. Update capture references BEFORE the async caption fetch ─────────
    // Record the new video element so capture.videoEl is always current.
    // NOTE: for the subtitle-first path, the proper onSeeked/onEndedBefore
    // listeners are bound inside restart() itself (Fix #2) — binding an empty
    // set here would clobber them.  For the WebRTC path, webrtc.continueOnNewVideo
    // binds its own listeners internally.  So we intentionally skip the empty
    // bindCommonVideoListeners call here.
    app.capture.videoEl = video;
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

      const r = await app.subtitleFirst.restart(settings, newVideoId);

      if (myGen !== activeGen) return;

      if (!r.ok) {
        // No captions for the new video — try to fall back to Standard-WebRTC.
        if (app.adapter.capabilities.audioCapture) {
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
