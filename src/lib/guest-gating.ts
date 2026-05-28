// ────────────────────────────────────────────────────────────────────────────
// Pure language-gating reducer for the popup in guest (BYOK) mode.
//
// When apiMode === "byok" and a guestPolicy is available, the language picker
// only shows the languages allowed by the policy; if the user's currently
// selected target language is outside the allowed set, we report an
// auto-switch to policy.defaults.target. Outside guest mode (signed-in or no
// resolved mode yet) all languages are shown unchanged.
//
// Enforcement is a UX nudge (not a security boundary) — the guest spends
// their own Kyma credit, so client-side gating is acceptable. See the
// approved plan §4.
// ────────────────────────────────────────────────────────────────────────────

import type { LangPair } from "@/shared/constants";
import type { ApiMode, GuestLanguagePolicy } from "@/shared/types";

export interface LanguageGateInput {
  apiMode: ApiMode;
  currentLang: string;
  policy: GuestLanguagePolicy | null;
  allLangs: readonly LangPair[];
}

export interface LanguageGateOutput {
  /** The langs the picker should render (a subset of allLangs in guest mode,
   *  the whole list otherwise). */
  renderable: LangPair[];
  /** The value the picker should set: currentLang if allowed, else the policy
   *  default (only in guest mode). */
  effectiveLang: string;
  /** True iff effectiveLang differs from currentLang (caller pushes
   *  UPDATE_SETTINGS so background persists the new value). */
  autoSwitched: boolean;
}

export function applyLanguageGate(input: LanguageGateInput): LanguageGateOutput {
  const { apiMode, currentLang, policy, allLangs } = input;

  // Not in guest mode, or no policy fetched yet → no gating.
  if (apiMode !== "byok" || !policy) {
    return {
      renderable: [...allLangs],
      effectiveLang: currentLang,
      autoSwitched: false,
    };
  }

  const allowed = new Set(policy.allowedTarget);
  const renderable = allLangs.filter(([code]) => allowed.has(code));

  // Defense-in-depth: if the policy somehow yields an empty render list (e.g.
  // every allowed code is unknown to the extension's LANGUAGES table), fall
  // back to the full list to keep the picker usable.
  if (renderable.length === 0) {
    return {
      renderable: [...allLangs],
      effectiveLang: currentLang,
      autoSwitched: false,
    };
  }

  if (allowed.has(currentLang)) {
    return { renderable, effectiveLang: currentLang, autoSwitched: false };
  }

  const fallback = policy.defaults.target;
  // Only auto-switch if the default is actually renderable; otherwise pick the
  // first allowed entry (and still report a switch).
  const effective = allowed.has(fallback)
    ? fallback
    : (renderable[0]?.[0] ?? currentLang);
  return {
    renderable,
    effectiveLang: effective,
    autoSwitched: effective !== currentLang,
  };
}
