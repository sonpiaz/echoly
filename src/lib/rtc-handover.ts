// Detach an outgoing WebRTC peer so the same capture MediaStream can join a new PC.

import type {
  WebRtcSession,
  WebRtcSignalingPipeline,
} from "@/content/session-manager";
import { RTC_LIVE_DURATION_HINT_SEC } from "@/shared/constants";

/**
 * Close dub + signaling on `session` but keep capture tracks alive for reuse.
 * Call before `buildSession()` on the same MediaStream during lang/voice handover.
 */
export function detachOutgoingPeer(session: WebRtcSession): void {
  try {
    if (session.remoteAudio) {
      session.remoteAudio.pause();
      session.remoteAudio.srcObject = null;
      session.remoteAudio.remove();
    }
  } catch {
    /* ignore */
  }
  session.remoteAudio = null;

  const pc = session.pc;
  if (pc) {
    try {
      for (const sender of pc.getSenders()) {
        try {
          pc.removeTrack(sender);
        } catch {
          /* ignore */
        }
      }
      pc.close();
    } catch {
      /* ignore */
    }
  }
  session.pc = null;

  try {
    session.dc?.close();
  } catch {
    /* ignore */
  }
  session.dc = null;

  try {
    session.outputGain?.disconnect();
  } catch {
    /* ignore */
  }
  try {
    if (session.audioCtx && session.audioCtx.state !== "closed") {
      void session.audioCtx.close();
    }
  } catch {
    /* ignore */
  }
  session.audioCtx = null;
  session.outputGain = null;

  if (session.stream) {
    for (const track of session.stream.getAudioTracks()) {
      track.enabled = true;
    }
  }
}

/** Reserve hint for the new signaling POST (remaining VOD time when known). */
export function handoverDurationHintSec(
  video: HTMLVideoElement | null,
  pipeline: WebRtcSignalingPipeline,
  isLive: boolean,
): number | undefined {
  if (!video) return undefined;
  if (pipeline === "realtime") {
    if (isLive) return RTC_LIVE_DURATION_HINT_SEC;
    if (isFinite(video.duration) && video.duration > 0) {
      return Math.ceil(Math.max(1, video.duration - video.currentTime));
    }
    return undefined;
  }
  if (isFinite(video.duration) && video.duration > 0) {
    return Math.ceil(Math.max(1, video.duration - video.currentTime));
  }
  return undefined;
}
