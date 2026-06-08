// Tier usage caps for popup meters — server SoT via bootstrap usage (capCredits,
// realtimeAllowed). Offline bootstrap when usage is missing or fetch failed.
// All values are CREDITS (1000 credits = $1 provider cost).

import { offlineCapsForTier, type TierCap } from "@/lib/offline-tier-caps";
import type { Usage } from "@/shared/types";

export type { TierCap };

/** Offline fallback only — mirrors server CAPS_CREDITS. Values are credits. */
export function capsForTier(tier: string | null | undefined): TierCap {
  return offlineCapsForTier(tier);
}

/** Prefer credit caps embedded in the usage snapshot; fall back to offline tier table. */
export function capsForUsage(
  tier: string | null | undefined,
  usage: Usage | null | undefined,
): TierCap {
  const fallback = offlineCapsForTier(tier);
  if (!usage) return fallback;
  return {
    cap: usage.cap ?? fallback.cap,
    realtimeAllowed: usage.realtimeAllowed ?? fallback.realtimeAllowed,
  };
}
