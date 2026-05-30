// Pure Web Audio gain curve for dub mix (chrome-free).

import { VOICE_GAIN_MAX } from "@/shared/constants";

/** Voice-volume slider (0..100) → GainNode value. Unity at 50, 2× at 100; zero at 0. */
export function computeGain(voiceVolume: number): number {
  return voiceVolume === 0 ? 0 : (voiceVolume / 100) * VOICE_GAIN_MAX;
}
