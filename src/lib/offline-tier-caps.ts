// Offline bootstrap — mirrors server/src/config/constants.ts CAPS_MIN (display minutes).
// Used only when bootstrap usage is unavailable. Runtime SoT: usage snapshot from server.

import type { AccountTier } from "@/shared/types";

export interface TierCap {
  readonly std: number;
  readonly rt: number;
}

/** Keep aligned with server CAPS_MIN / CAPS_CMIN ÷ 100. */
export const OFFLINE_TIER_CAPS: Readonly<Record<AccountTier, TierCap>> = {
  free: { std: 30, rt: 0 },
  pro: { std: 600, rt: 0 },
  max: { std: 3000, rt: 120 },
};

export function offlineCapsForTier(tier: string | null | undefined): TierCap {
  const key = (tier ?? "free") as AccountTier;
  return OFFLINE_TIER_CAPS[key] ?? OFFLINE_TIER_CAPS.free;
}
