// Language picker helpers — build option lists from the server catalog and
// gate the target <select> for signed-in users.

import { offlineLanguagePicker } from "@/lib/offline-language-bootstrap";
import {
  GPT_REALTIME_TRANSLATE_OUTPUT_LANGS,
  type LangPair,
} from "@/shared/constants";

export interface CatalogPair {
  source: string;
  target: string;
}

export interface LanguageGateOutput {
  renderable: LangPair[];
  effectiveLang: string;
  autoSwitched: boolean;
}

/** Unique target codes from tier-filtered directed pairs, sorted by display name. */
export function langPickerFromPairs(
  pairs: readonly CatalogPair[],
  languages: Record<string, string>,
): LangPair[] {
  const codes = new Set<string>();
  for (const p of pairs) codes.add(p.target.toLowerCase());
  return [...codes]
    .sort((a, b) => {
      const na = languages[a] ?? a;
      const nb = languages[b] ?? b;
      return na.localeCompare(nb);
    })
    .map((code) => [code, languages[code] ?? code] as LangPair);
}

/** Restrict the picker to OpenAI Realtime output languages (Max tier). */
export function filterPickerForRealtime(picker: readonly LangPair[]): LangPair[] {
  const allowed = new Set(GPT_REALTIME_TRANSLATE_OUTPUT_LANGS);
  const filtered = picker.filter(([code]) => allowed.has(code.toLowerCase()));
  return filtered.length > 0 ? filtered : [...offlineLanguagePicker()].filter(([code]) => allowed.has(code));
}

export function applySignedLanguageGate(input: {
  currentLang: string;
  picker: readonly LangPair[];
}): LanguageGateOutput {
  const { currentLang, picker } = input;
  if (picker.length === 0) {
    const fallback = [...offlineLanguagePicker()];
    return {
      renderable: fallback,
      effectiveLang: currentLang,
      autoSwitched: false,
    };
  }
  const allowed = new Set(picker.map(([c]) => c));
  if (allowed.has(currentLang)) {
    return { renderable: [...picker], effectiveLang: currentLang, autoSwitched: false };
  }
  const effective = picker[0]![0];
  return {
    renderable: [...picker],
    effectiveLang: effective,
    autoSwitched: effective !== currentLang,
  };
}
