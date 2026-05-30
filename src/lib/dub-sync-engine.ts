// Pure Standard VOD sync math — hysteresis, smoothed lag, gentle playbackRate ramp.

import {
  DUB_SYNC_CATCHUP_RATE,
  DUB_SYNC_ENTER_CATCHUP_SEC,
  DUB_SYNC_ENTER_HARD_SEC,
  DUB_SYNC_ENTER_SOFT_SEC,
  DUB_SYNC_EXIT_CATCHUP_SEC,
  DUB_SYNC_EXIT_HARD_SEC,
  DUB_SYNC_EXIT_SOFT_SEC,
  DUB_SYNC_HARD_SLOW_RATE,
  DUB_SYNC_LAG_EMA_ALPHA,
  DUB_SYNC_RATE_BLEND,
  DUB_SYNC_SLOW_RATE,
} from "@/shared/constants";

export type DubSyncMode = "normal" | "slow" | "hard" | "catchup";

export function smoothAheadEma(prev: number | null, sample: number): number {
  if (prev == null) return sample;
  return prev + DUB_SYNC_LAG_EMA_ALPHA * (sample - prev);
}

export function nextDubSyncMode(aheadEma: number, mode: DubSyncMode): DubSyncMode {
  switch (mode) {
    case "normal":
      if (aheadEma >= DUB_SYNC_ENTER_HARD_SEC) return "hard";
      if (aheadEma >= DUB_SYNC_ENTER_SOFT_SEC) return "slow";
      if (aheadEma <= DUB_SYNC_ENTER_CATCHUP_SEC) return "catchup";
      return "normal";
    case "slow":
      if (aheadEma >= DUB_SYNC_ENTER_HARD_SEC) return "hard";
      if (aheadEma <= DUB_SYNC_ENTER_CATCHUP_SEC) return "catchup";
      if (aheadEma <= DUB_SYNC_EXIT_SOFT_SEC) return "normal";
      return "slow";
    case "hard":
      if (aheadEma <= DUB_SYNC_EXIT_HARD_SEC) {
        return aheadEma <= DUB_SYNC_EXIT_SOFT_SEC ? "normal" : "slow";
      }
      return "hard";
    case "catchup":
      if (aheadEma >= DUB_SYNC_ENTER_HARD_SEC) return "hard";
      if (aheadEma >= DUB_SYNC_ENTER_SOFT_SEC) return "slow";
      if (aheadEma >= DUB_SYNC_EXIT_CATCHUP_SEC) return "normal";
      return "catchup";
  }
}

export function targetRateForMode(mode: DubSyncMode): number {
  switch (mode) {
    case "hard":
      return DUB_SYNC_HARD_SLOW_RATE;
    case "slow":
      return DUB_SYNC_SLOW_RATE;
    case "catchup":
      return DUB_SYNC_CATCHUP_RATE;
    default:
      return 1;
  }
}

/** Ease current rate toward target (per tick). */
export function blendPlaybackRate(current: number, target: number): number {
  const next = current + (target - current) * DUB_SYNC_RATE_BLEND;
  return Math.round(next * 1000) / 1000;
}

export function rateToPercent(rate: number): number {
  return Math.round(rate * 100);
}

export function isMatchingMode(mode: DubSyncMode): boolean {
  return mode === "slow" || mode === "hard" || mode === "catchup";
}
