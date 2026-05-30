// Tier usage caps for popup meters — server SoT via bootstrap usage (standard.cap,
// realtime.cap). Offline bootstrap when usage is missing or fetch failed.

import { offlineCapsForTier, type TierCap } from "@/lib/offline-tier-caps";
import type { Usage } from "@/shared/types";

export type { TierCap };

/** Offline fallback only — mirrors server CAPS_MIN. */
export function capsForTier(tier: string | null | undefined): TierCap {
  return offlineCapsForTier(tier);
}

/** Prefer caps embedded in the usage snapshot; fall back to offline tier table. */
export function capsForUsage(
  tier: string | null | undefined,
  usage: Usage | null | undefined,
): TierCap {
  const fallback = offlineCapsForTier(tier);
  if (!usage) return fallback;
  return {
    std: usage.standardCap ?? fallback.std,
    rt: usage.realtimeCap ?? fallback.rt,
  };
}
