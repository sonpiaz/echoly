// Detach an outgoing WebRTC peer so the same capture MediaStream can join a new PC.

import type {
  WebRtcSession,
  WebRtcSignalingPipeline,
} from "@/content/session-manager";
import { RTC_LIVE_DURATION_HINT_SEC } from "@/shared/constants";

/**
 * Timeout (ms) the driver allows the remote audio to keep playing after a
 * WebRTC tear-down triggered by VIDEO_ENDED or handover. The MediaStream from
 * a live WebRTC peer never fires the "ended" event on the <audio> element, so
 * the only reliable drain signal is a fixed timeout.
 *
 * 600ms ≈ one short utterance tail. Tune upward if the model's final word is
 * still audibly clipped after upgrading to a faster provider.
 */
export const RTC_DRAIN_TIMEOUT_MS = 600;

/**
 * Let `remoteAudio` keep playing for up to `drainTimeoutMs`, then tear it down.
 *
 * A live WebRTC MediaStream NEVER fires "ended" on its <audio> element, so the
 * only reliable drain mechanism is a timeout. The audio is kept playing (not
 * paused) during the window so the current utterance's tail is not cut.
 *
 * After the timeout: pause → srcObject = null → remove(). Resolves when done.
 *
 * This mirrors the subtitle-first deferred ring-out discipline (content/index.ts
 * VIDEO_ENDED branch) applied to the WebRTC remote audio.
 */
export function drainRemoteAudio(
  remoteAudio: HTMLAudioElement,
  drainTimeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      try {
        remoteAudio.pause();
      } catch {
        /* ignore */
      }
      try {
        remoteAudio.srcObject = null;
      } catch {
        /* ignore */
      }
      try {
        remoteAudio.remove();
      } catch {
        /* ignore */
      }
      resolve();
    }, drainTimeoutMs);
  });
}

/**
 * Close dub + signaling on `session` but keep capture tracks alive for reuse.
 * Call before `buildSession()` on the same MediaStream during lang/voice handover.
 *
 * The remoteAudio teardown is deferred via drainRemoteAudio so the current
 * utterance's tail is not cut abruptly on handover.
 */
export function detachOutgoingPeer(session: WebRtcSession): void {
  if (session.remoteAudio) {
    // Drain: keep playing for up to RTC_DRAIN_TIMEOUT_MS then tear down.
    // No await — fire-and-forget; the session is already handed over.
    void drainRemoteAudio(session.remoteAudio, RTC_DRAIN_TIMEOUT_MS);
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
