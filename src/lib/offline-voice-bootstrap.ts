// Offline standard-voice fallback — mirrors server/src/domain/standard-voices.ts.
// Used only when GET /v1/config/voices fails. Runtime SoT: server config API.

import type { LangPair } from "@/shared/constants";

export const OFFLINE_STANDARD_DEFAULT_VOICE = "English_magnetic_voiced_man";

const ENTRIES: readonly LangPair[] = [
  [OFFLINE_STANDARD_DEFAULT_VOICE, "Magnetic Man"],
  ["English_captivating_female1", "Captivating Female"],
  ["English_ManWithDeepVoice", "Deep Voice Man"],
  ["English_ConfidentWoman", "Confident Woman"],
  ["Chinese (Mandarin)_News_Anchor", "News Anchor"],
] as const;

export function offlineStandardVoices(): LangPair[] {
  return [...ENTRIES];
}
