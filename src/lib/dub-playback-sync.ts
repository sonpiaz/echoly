// Standard-tier VOD — smooth drift sync (rate ramp + hysteresis) + UI readout.
// One-time pause only: SF6 + waitForFirstDub in ContentApp.

import { DUB_SYNC_POLL_MS, DUB_TTFA_GATE_MS } from "@/shared/constants";
import {
  blendPlaybackRate,
  isMatchingMode,
  nextDubSyncMode,
  rateToPercent,
  smoothAheadEma,
  targetRateForMode,
  type DubSyncMode,
} from "./dub-sync-engine";

export type DubSyncReadout = {
  /** Smoothed seconds video is ahead of dub (display). */
  lagSec: number;
  mode: DubSyncMode;
  ratePct: number;
};

export interface StandardDubPlaybackSyncOptions {
  video: HTMLVideoElement;
  getDubAudio: () => HTMLAudioElement | null;
  isUserPaused: () => boolean;
  onReadout?: (readout: DubSyncReadout | null) => void;
}

export interface StandardDubPlaybackSyncHandle {
  waitForFirstDub(timeoutMs?: number): Promise<boolean>;
  /** Reset anchors — call immediately before video.play() + dub.play(). */
  snapPlaybackStart(): void;
  start(): void;
  stop(): void;
}

export function computeVideoAheadSec(
  videoCurrentSec: number,
  dubCurrentSec: number,
  videoAnchorSec: number,
  dubAnchorSec: number,
): number {
  const expectedVideo = videoAnchorSec + (dubCurrentSec - dubAnchorSec);
  return videoCurrentSec - expectedVideo;
}

export function bindStandardDubPlaybackSync(
  opts: StandardDubPlaybackSyncOptions,
): StandardDubPlaybackSyncHandle {
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let videoAnchor: number | null = null;
  let dubAnchor: number | null = null;
  let aheadEma: number | null = null;
  let syncMode: DubSyncMode = "normal";
  let appliedRate = 1;

  const pushReadout = (): void => {
    if (aheadEma == null) {
      opts.onReadout?.(null);
      return;
    }
    opts.onReadout?.({
      lagSec: Math.max(0, Math.round(aheadEma * 10) / 10),
      mode: syncMode,
      ratePct: rateToPercent(appliedRate),
    });
  };

  const tick = (): void => {
    if (stopped || opts.isUserPaused()) return;
    const dub = opts.getDubAudio();
    if (!dub) return;

    let vAnchor = videoAnchor;
    let dAnchor = dubAnchor;
    if (vAnchor == null || dAnchor == null) {
      if (dub.currentTime < 0.05 || opts.video.paused) return;
      // 1:1 at joint start (SF6 pause + TTFA already aligned content clocks).
      vAnchor = opts.video.currentTime;
      dAnchor = dub.currentTime;
      videoAnchor = vAnchor;
      dubAnchor = dAnchor;
      pushReadout();
      return;
    }

    const ahead = computeVideoAheadSec(
      opts.video.currentTime,
      dub.currentTime,
      vAnchor,
      dAnchor,
    );
    aheadEma = smoothAheadEma(aheadEma, ahead);
    const prevMode = syncMode;
    syncMode = nextDubSyncMode(aheadEma, syncMode);
    const target = targetRateForMode(syncMode);
    appliedRate = blendPlaybackRate(appliedRate, target);

    try {
      opts.video.playbackRate = appliedRate;
    } catch {
      /* ignore */
    }

    if (prevMode !== syncMode || isMatchingMode(syncMode)) {
      pushReadout();
    } else if (aheadEma != null) {
      pushReadout();
    }
  };

  return {
    waitForFirstDub(timeoutMs = DUB_TTFA_GATE_MS): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      return new Promise((resolve) => {
        const poll = (): void => {
          if (stopped) {
            resolve(false);
            return;
          }
          const dub = opts.getDubAudio();
          if (dub && dub.currentTime > 0.04) {
            resolve(true);
            return;
          }
          if (Date.now() >= deadline) {
            resolve(false);
            return;
          }
          setTimeout(poll, 80);
        };
        poll();
      });
    },

    snapPlaybackStart(): void {
      videoAnchor = null;
      dubAnchor = null;
      aheadEma = null;
      syncMode = "normal";
      appliedRate = 1;
      try {
        opts.video.playbackRate = 1;
      } catch {
        /* ignore */
      }
    },

    start(): void {
      if (timer != null) return;
      timer = setInterval(tick, DUB_SYNC_POLL_MS);
      tick();
    },

    stop(): void {
      stopped = true;
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
      try {
        opts.video.playbackRate = 1;
      } catch {
        /* ignore */
      }
      appliedRate = 1;
      aheadEma = null;
      syncMode = "normal";
      videoAnchor = null;
      dubAnchor = null;
      opts.onReadout?.(null);
    },
  };
}
