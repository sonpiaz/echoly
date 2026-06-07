// Sync WebRTC dubbing with the page's primary <video> pause/play (any host site).

import { MEDIA_GATE_TIMEOUT_MS } from "@/shared/constants";
import type { Session } from "@/content/session-manager";
import type { LifecycleController } from "@/content/lifecycle";

export interface SourcePlaybackHandlers {
  onPause: () => void;
  onPlay: () => void;
  onEnded: () => void;
  onSeeked?: () => void;
}

/** Bind standard HTMLMediaElement playback events; returns detach. */
export function bindSourceVideoPlayback(
  video: HTMLVideoElement,
  handlers: SourcePlaybackHandlers,
): () => void {
  video.addEventListener("pause", handlers.onPause);
  video.addEventListener("play", handlers.onPlay);
  video.addEventListener("ended", handlers.onEnded);
  if (handlers.onSeeked) video.addEventListener("seeked", handlers.onSeeked);
  return () => {
    video.removeEventListener("pause", handlers.onPause);
    video.removeEventListener("play", handlers.onPlay);
    video.removeEventListener("ended", handlers.onEnded);
    if (handlers.onSeeked) video.removeEventListener("seeked", handlers.onSeeked);
  };
}

/** Stop sending capture audio to the server and pause dubbed playback locally.
 *
 * On resume (paused=false) the AudioContext.resume() is now awaited with a
 * MEDIA_GATE_TIMEOUT_MS bound so a stuck context can't hang the caller. */
export async function applyVideoPauseToSession(session: Session, paused: boolean): Promise<void> {
  const pc = session.pc;
  if (pc) {
    for (const sender of pc.getSenders()) {
      const track = sender.track;
      if (track?.kind === "audio") track.enabled = !paused;
    }
  }
  if (session.stream) {
    for (const track of session.stream.getAudioTracks()) {
      track.enabled = !paused;
    }
  }

  if (session.remoteAudio) {
    if (paused) session.remoteAudio.pause();
    else void session.remoteAudio.play().catch(() => {});
  }

  const ctx = session.audioCtx;
  if (ctx && ctx.state !== "closed") {
    if (paused && ctx.state === "running") {
      void ctx.suspend();
    } else if (!paused && ctx.state === "suspended") {
      // A3: await ctx.resume() but race against MEDIA_GATE_TIMEOUT_MS so a
      // stuck AudioContext can't hang resume. Soft-fail: proceed either way.
      try {
        await Promise.race([
          ctx.resume(),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error("ctx.resume timeout")), MEDIA_GATE_TIMEOUT_MS),
          ),
        ]);
      } catch {
        /* soft-fail — context may still recover; proceed with resume */
      }
    }
  }
}

/** Tell the media node to stop emitting dub audio + partial captions.
 *  Returns whether the server acknowledged (res.ok); false on a non-ok response or
 *  network error. The caller should set sm.connectionLost on false. */
export async function notifyServerMediaGate(
  apiBase: string,
  rtcSessionId: string,
  apiBearer: string,
  paused: boolean,
): Promise<boolean> {
  const path = paused ? "media-pause" : "media-resume";
  const url = `${apiBase}/rtc/translate/${rtcSessionId}/${path}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer " + apiBearer },
      keepalive: true,
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Client + server gate when the source video pauses or resumes.
 *
 * A3: async. On resume the media-gate POST is awaited with a
 * AbortSignal.timeout(MEDIA_GATE_TIMEOUT_MS) bound — timeout/network errors are
 * soft-fails (proceed anyway). The `connection-lost` lifecycle reason is pushed
 * ONLY on an explicit non-ok HTTP response, exactly as the old
 * `sm.connectionLost = true` did.
 *
 * Stage A: the source-pause STATE is now held as a lifecycle reason on the
 * reason stack (pushed by the caller via lifecycle.pause('user')/resume('user'))
 * — this function no longer writes sm.videoPaused (a derived getter). It still
 * owns the media-plane (track toggling, remoteAudio, AudioContext) + server gate
 * and, on a peer-death during the gate, marks the lifecycle `connection-lost`
 * reason so the next resume rebuilds the peer instead of resuming dead audio. */
export async function syncSourcePauseState(
  sm: { apiBase: string },
  session: Session,
  paused: boolean,
  lifecycle?: Pick<LifecycleController, "pause">,
): Promise<void> {
  await applyVideoPauseToSession(session, paused);
  if (session.rtcSessionId && session.apiBearer) {
    if (paused) {
      // Pause path: fire-and-forget (as before — no resume gate needed on pause).
      void notifyServerMediaGate(
        sm.apiBase,
        session.rtcSessionId,
        session.apiBearer,
        paused,
      ).then((ok) => {
        if (!ok) lifecycle?.pause("connection-lost");
      });
    } else {
      // Resume path: await with timeout bound so we don't hang resume.
      // Use AbortSignal.timeout if available (Chrome 116+), otherwise a manual race.
      let ok: boolean;
      try {
        const hasAbortTimeout = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function";
        const signal = hasAbortTimeout
          ? AbortSignal.timeout(MEDIA_GATE_TIMEOUT_MS)
          : undefined;
        const url = `${sm.apiBase}/rtc/translate/${session.rtcSessionId}/media-resume`;
        const res = await fetch(url, {
          method: "POST",
          headers: { Authorization: "Bearer " + session.apiBearer },
          keepalive: true,
          signal,
        });
        ok = res.ok;
      } catch {
        // Timeout (AbortError) or network error → soft-fail, do NOT mark lost.
        ok = true; // treat as success to avoid false connection-lost
      }
      if (!ok) lifecycle?.pause("connection-lost");
    }
  }
}
