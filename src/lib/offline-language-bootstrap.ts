// Offline bootstrap — mirrors server/domain/language-catalog-bootstrap.ts (17 langs).
// Used only when GET /v1/config/language-pairs fails (signed-out path).

import type { LangPair } from "@/shared/constants";

/** Keep in sync with server LANGUAGE_NAMES (migration 0007 seed). */
export const OFFLINE_LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  en: "English",
  vi: "Vietnamese",
  es: "Spanish",
  pt: "Portuguese",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
  fr: "French",
  de: "German",
  it: "Italian",
  ru: "Russian",
  ar: "Arabic",
  id: "Indonesian",
  th: "Thai",
  hi: "Hindi",
  tr: "Turkish",
  pl: "Polish",
};

export function offlineLanguagePicker(): readonly LangPair[] {
  return Object.entries(OFFLINE_LANGUAGE_NAMES)
    .sort(([, a], [, b]) => a.localeCompare(b))
    .map(([code, name]) => [code, name] as LangPair);
}
