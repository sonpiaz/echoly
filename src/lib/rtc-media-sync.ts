// Sync WebRTC dubbing with the page's primary <video> pause/play (any host site).

import type { Session } from "@/content/session-manager";

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

/** Stop sending capture audio to the server and pause dubbed playback locally. */
export function applyVideoPauseToSession(session: Session, paused: boolean): void {
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
    if (paused && ctx.state === "running") void ctx.suspend();
    else if (!paused && ctx.state === "suspended") void ctx.resume();
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

/** Client + server gate when the source video pauses or resumes. */
export function syncSourcePauseState(
  sm: { videoPaused: boolean; apiBase: string; connectionLost?: boolean },
  session: Session,
  paused: boolean,
): void {
  sm.videoPaused = paused;
  applyVideoPauseToSession(session, paused);
  if (session.rtcSessionId && session.apiBearer) {
    void notifyServerMediaGate(
      sm.apiBase,
      session.rtcSessionId,
      session.apiBearer,
      paused,
    ).then((ok) => {
      if (!ok) sm.connectionLost = true;
    });
  }
}
