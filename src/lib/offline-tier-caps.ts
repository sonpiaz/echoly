// Offline bootstrap — mirrors server/src/config/constants.ts CAPS_CREDITS.
// Used only when bootstrap usage is unavailable. Runtime SoT: usage snapshot from server.
// Values are CREDITS (1000 credits = $1 provider cost).

import type { AccountTier } from "@/shared/types";

export interface TierCap {
  readonly cap: number;            // unified pool credits cap
  readonly realtimeAllowed: boolean; // Max-only feature entitlement (replaces rt > 0 trick)
}

/** Keep aligned with server CAPS_CREDITS: free {cap:500}, pro {cap:6000}, max {cap:17000, realtimeAllowed:true}. */
export const OFFLINE_TIER_CAPS: Readonly<Record<AccountTier, TierCap>> = {
  free: { cap: 500,   realtimeAllowed: false },
  pro:  { cap: 6000,  realtimeAllowed: false },
  max:  { cap: 17000, realtimeAllowed: true  },
};

export function offlineCapsForTier(tier: string | null | undefined): TierCap {
  const key = (tier ?? "free") as AccountTier;
  return OFFLINE_TIER_CAPS[key] ?? OFFLINE_TIER_CAPS.free;
}
