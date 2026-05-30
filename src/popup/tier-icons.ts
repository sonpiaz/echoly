import { TIER_REALTIME, TIER_STANDARD, type TranslationTier } from "@/shared/constants";

/** Inline SVG for tier row + dropdown (12×12 viewBox). */
export const TIER_SVG_REALTIME =
  '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6.2 1.2 4.1 6.5H6.8L5.6 10.8l4.3-5.4H7.2l1-4.2z" fill="currentColor"/></svg>';

export const TIER_SVG_STANDARD =
  '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 8.2c1.4-2.8 3.2-4.2 4-4.2s2.6 1.4 4 4.2" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/><path d="M3.2 9.4h5.6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';

export function tierIconHtml(tier: TranslationTier | string): string {
  return tier === TIER_STANDARD ? TIER_SVG_STANDARD : TIER_SVG_REALTIME;
}

export function tierRowIconClass(tier: TranslationTier | string): string {
  return tier === TIER_STANDARD
    ? "row-icon row-icon--tier-standard"
    : "row-icon row-icon--tier-realtime";
}
