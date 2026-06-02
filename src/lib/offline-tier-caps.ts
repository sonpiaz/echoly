// Offline bootstrap — mirrors server/src/config/constants.ts CAPS_CREDITS.
// Used only when bootstrap usage is unavailable. Runtime SoT: usage snapshot from server.
// Values are CREDITS (1000 credits = $1 provider cost).

import type { AccountTier } from "@/shared/types";

export interface TierCap {
  readonly std: number; // standard credits cap
  readonly rt: number;  // realtime credits cap (0 for non-Max plans)
}

/** Keep aligned with server CAPS_CREDITS: free {std:1000,rt:0}, pro {std:10000,rt:0}, max {std:28000,rt:6000}. */
export const OFFLINE_TIER_CAPS: Readonly<Record<AccountTier, TierCap>> = {
  free: { std: 1000, rt: 0 },
  pro: { std: 10000, rt: 0 },
  max: { std: 28000, rt: 6000 },
};

export function offlineCapsForTier(tier: string | null | undefined): TierCap {
  const key = (tier ?? "free") as AccountTier;
  return OFFLINE_TIER_CAPS[key] ?? OFFLINE_TIER_CAPS.free;
}
