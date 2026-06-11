// Single source of truth for the account-plan → realtime-tier rule.
// The realtime translation tier is Max-only. Shared by the popup (tier-dropdown
// lock + Start gate), the popup-format helper, and the background store (tier
// normalization). Keep this the ONLY place the "realtime ⇔ max" rule lives.

import type { AccountTier } from "./types";

/** True iff the account plan may use the realtime translation tier (Max only). */
export function canUseRealtime(
  accountTier: AccountTier | string | null | undefined,
): boolean {
  return accountTier === "max";
}

/** True iff the account plan may use custom subtitle styling (Pro or Max). */
export function canUseSubtitleStyling(
  accountTier: AccountTier | string | null | undefined,
): boolean {
  return accountTier === "pro" || accountTier === "max";
}
