// ────────────────────────────────────────────────────────────────────────────
// AudioCapture — video-element acquisition, F5 captureStream retry, the Web
// Audio gain graph, volume application (incl. VOICE_GAIN_MAX boost), the SF3
// original-volume drift guard, and the SF8 playback-rate warning.
//
// Owns `videoEl` (set on session start, nulled on stop) + the drift/rate state.
// Reads the active session + live settings from the injected SessionManager and
// emits the SF8 toast through the OverlayView. (legacy/content.js: findVideo
// 509, isLive 516, nudgePlay 519, captureWithRetry 525, waitForPCConnected 616,
// applyVolumes 835, bindVolumeDriftGuard 877, bindRateChangeWarn 902.)
// ────────────────────────────────────────────────────────────────────────────

import { computeGain } from "@/lib/audio";
import type { OverlayView } from "@/shared/ports";
import type { SessionManager } from "./session-manager";

export class AudioCapture {
  videoEl: HTMLVideoElement | null = null;

  // SF3 — original-volume drift guard state. `desiredOriginalVol` < 0 means
  // "not engaged" (no session active); >= 0 is the value we enforce.
  private desiredOriginalVol = -1;
  private lastOriginalWriteAt = 0;
  private onVolumeDrift: (() => void) | null = null;

  // SF8 — playback-rate awareness (debounced warn toast).
  private onRateChange: (() => void) | null = null;
  private lastRateToastAt = 0;

  constructor(
    private readonly sm: SessionManager,
    private readonly overlay: OverlayView,
  ) {}

  // ───── Video element acquisition ──────────────────────────────────────────

  findVideo(): HTMLVideoElement | null {
    return (
      document.querySelector<HTMLVideoElement>("video.html5-main-video") ||
      document.querySelector<HTMLVideoElement>("video")
    );
  }

  /** Live streams report duration === Infinity/NaN. Pausing a live stream
   *  evicts the viewer from the live edge permanently — load-bearing gate. */
  isLive(video: HTMLVideoElement | null): boolean {
    return !video || !isFinite(video.duration);
  }

  private nudgePlay(video: HTMLVideoElement): Promise<unknown> {
    if (!video.paused) return Promise.resolve();
    const p = video.play();
    if (!p?.then) return Promise.resolve();
    return Promise.race([
      p.catch(() => {}),
      new Promise((r) => setTimeout(r, 250)),
    ]);
  }

  /** F5 — captureStream re-acquisition with playback nudge. Retries until the
   *  stream has audio tracks (YT returns a track-less stream until the media
   *  pipeline is hot). (legacy captureWithRetry.) */
  async captureWithRetry(
    video: HTMLVideoElement,
    timeoutMs = 9000,
  ): Promise<MediaStream> {
    const cap = video as HTMLVideoElement & {
      captureStream?: () => MediaStream;
      mozCaptureStream?: () => MediaStream;
    };
    if (
      typeof cap.captureStream !== "function" &&
      typeof cap.mozCaptureStream !== "function"
    ) {
      throw new Error("This Chrome build cannot capture YouTube audio.");
    }
    const start = Date.now();
    let lastStream: MediaStream;
    while (Date.now() - start < timeoutMs) {
      if (video.paused) await this.nudgePlay(video);
      const grab = cap.captureStream || cap.mozCaptureStream;
      lastStream = grab!.call(video);
      if (lastStream.getAudioTracks().length) {
        return new MediaStream(lastStream.getAudioTracks());
      }
      lastStream.getTracks().forEach((t) => t.stop());
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error("YouTube audio not ready. Press play, then Start again.");
  }

  /** Resolves true once the PeerConnection reaches "connected"; false on
   *  failed/closed/timeout. Gates video.play() on non-live realtime (SF6). */
  waitForPCConnected(pc: RTCPeerConnection, timeoutMs = 3000): Promise<boolean> {
    if (pc.connectionState === "connected") return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok: boolean): void => {
        if (done) return;
        done = true;
        pc.removeEventListener("connectionstatechange", handler);
        clearTimeout(timer);
        resolve(ok);
      };
      const handler = (): void => {
        if (pc.connectionState === "connected") finish(true);
        else if (
          pc.connectionState === "failed" ||
          pc.connectionState === "closed"
        )
          finish(false);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      pc.addEventListener("connectionstatechange", handler);
    });
  }

  // ───── Volume application ──────────────────────────────────────────────────

  /**
   * Apply original (YT video element) + voice (dub) volumes. Original audio
   * locates the video on-demand so the slider works pre-session. Voice path A
   * is a Web Audio GainNode with an anti-crackle ramp; path B is the HTMLAudio
   * fallback capped at unity. (legacy applyVolumes.)
   */
  applyVolumes(originalVolume: number, voiceVolume: number): void {
    const video = this.videoEl || this.findVideo();
    if (video) {
      const vol = Math.max(0, Math.min(1, (originalVolume ?? 18) / 100));
      this.desiredOriginalVol = vol;
      this.lastOriginalWriteAt = Date.now();
      video.volume = vol;
      video.muted = vol === 0;
    }
    const session = this.sm.session;
    if (session?.outputGain && session?.audioCtx) {
      const target = computeGain(voiceVolume ?? 100);
      const ctx = session.audioCtx;
      const gain = session.outputGain.gain;
      const now = ctx.currentTime;
      try {
        gain.cancelScheduledValues(now);
        gain.setValueAtTime(gain.value, now);
        gain.linearRampToValueAtTime(target, now + 0.04);
      } catch {
        // Older AudioContext impls may reject scheduling — direct assignment.
        gain.value = target;
      }
    } else if (session?.remoteAudio) {
      session.remoteAudio.volume = Math.min((voiceVolume ?? 100) / 100, 1.0);
      session.remoteAudio.muted = voiceVolume === 0;
    }
  }

  // ───── SF3 — original-volume drift guard ────────────────────────────────────

  /** Snap the original volume back when YouTube re-applies its own (ad
   *  insertion, element refresh). Ignores events within ~200ms of our own
   *  write to avoid a feedback loop. (legacy bindVolumeDriftGuard.) */
  bindVolumeDriftGuard(video: HTMLVideoElement | null): void {
    if (!video) return;
    this.unbindVolumeDriftGuard();
    this.onVolumeDrift = () => {
      if (this.desiredOriginalVol < 0 || !video) return;
      if (Date.now() - this.lastOriginalWriteAt < 200) return;
      if (Math.abs(video.volume - this.desiredOriginalVol) > 0.01) {
        this.lastOriginalWriteAt = Date.now();
        video.volume = this.desiredOriginalVol;
        video.muted = this.desiredOriginalVol === 0;
      }
    };
    video.addEventListener("volumechange", this.onVolumeDrift);
  }

  unbindVolumeDriftGuard(): void {
    if (this.videoEl && this.onVolumeDrift) {
      try {
        this.videoEl.removeEventListener("volumechange", this.onVolumeDrift);
      } catch {
        /* element may be gone */
      }
    }
    this.onVolumeDrift = null;
    this.desiredOriginalVol = -1;
  }

  // ───── SF8 — playback-rate warning (debounced) ─────────────────────────────

  /** Toast a warning when playback isn't 1×. Must be called AFTER buildOverlay
   *  so showToast has a panel. (legacy bindRateChangeWarn.) */
  bindRateChangeWarn(video: HTMLVideoElement | null): void {
    if (!video) return;
    this.unbindRateChangeWarn();
    const warn = (rate: number): void => {
      if (Date.now() - this.lastRateToastAt < 4000) return;
      this.lastRateToastAt = Date.now();
      const r = Math.round(rate * 100) / 100;
      this.overlay.showToast(
        `Echoly works best at 1× speed (current: ${r}×). Translation may drift behind the speaker.`,
        5000,
      );
    };
    if (Math.abs(video.playbackRate - 1.0) > 0.01) warn(video.playbackRate);
    this.onRateChange = () => {
      if (!video) return;
      if (Math.abs(video.playbackRate - 1.0) < 0.01) return;
      warn(video.playbackRate);
    };
    video.addEventListener("ratechange", this.onRateChange);
  }

  unbindRateChangeWarn(): void {
    if (this.videoEl && this.onRateChange) {
      try {
        this.videoEl.removeEventListener("ratechange", this.onRateChange);
      } catch {
        /* element may be gone */
      }
    }
    this.onRateChange = null;
  }
}
