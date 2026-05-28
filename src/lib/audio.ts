// ────────────────────────────────────────────────────────────────────────────
// Pure — audio math. `computeGain` (gain curve), `downmixAndResample` (mono +
// linear resample), and `audioBufferToWavBlob` (16-bit PCM WAV encode). Ported
// verbatim from legacy/content.js (computeGain 831-833, audioBufferToWavBlob
// 1134-1156, downmixAndResample 1158-1182).
//
// These take only plain data (numbers / channel Float32Arrays), so they're
// chrome-free and decode-free — the only browser thing left in the pipeline is
// `decodeAudioData`, which stays in capture.ts (it needs a live AudioContext).
// ────────────────────────────────────────────────────────────────────────────

import { VOICE_GAIN_MAX } from "@/shared/constants";

/** Voice-volume slider (0..100) → Web Audio GainNode value. Unity at 50,
 *  2× at 100; hard zero at 0. (legacy computeGain.) */
export function computeGain(voiceVolume: number): number {
  return voiceVolume === 0 ? 0 : (voiceVolume / 100) * VOICE_GAIN_MAX;
}

/** A minimal structural view of a decoded AudioBuffer — only the fields the WAV
 *  encoder reads. Lets the math be tested without a real AudioContext. */
export interface DecodedAudio {
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly length: number;
  getChannelData(channel: number): Float32Array;
}

/** Downmix to mono (channel-average) then linear-resample to `targetRate`.
 *  Returns the source mono buffer unchanged when rates already match.
 *  (legacy downmixAndResample.) */
export function downmixAndResample(
  audioBuf: DecodedAudio,
  targetRate: number,
): Float32Array {
  const srcRate = audioBuf.sampleRate;
  const channels = audioBuf.numberOfChannels;
  const srcLen = audioBuf.length;
  // Mono mix first (avg across channels).
  const mono = new Float32Array(srcLen);
  for (let ch = 0; ch < channels; ch++) {
    const data = audioBuf.getChannelData(ch);
    for (let i = 0; i < srcLen; i++) mono[i]! += data[i]!;
  }
  if (channels > 1) for (let i = 0; i < srcLen; i++) mono[i]! /= channels;
  if (srcRate === targetRate) return mono;
  // Linear resample — adequate for speech intelligibility at 16 kHz target.
  const ratio = srcRate / targetRate;
  const outLen = Math.floor(srcLen / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, srcLen - 1);
    const f = src - i0;
    out[i] = mono[i0]! * (1 - f) + mono[i1]! * f;
  }
  return out;
}

/** Encode a decoded buffer to a 16 kHz mono 16-bit PCM WAV Blob (the format
 *  Kyma's audio gateway whitelists). (legacy audioBufferToWavBlob.) */
export function audioBufferToWavBlob(audioBuf: DecodedAudio): Blob {
  // Whisper handles mono fine; downmix to mono and resample to 16 kHz to
  // match Whisper's internal rate — saves bandwidth without quality loss.
  const targetRate = 16000;
  const monoSamples = downmixAndResample(audioBuf, targetRate);
  const dataSize = monoSamples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  let p = 0;
  const wstr = (s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(p++, s.charCodeAt(i));
  };
  const w32 = (n: number): void => {
    view.setUint32(p, n, true);
    p += 4;
  };
  const w16 = (n: number): void => {
    view.setUint16(p, n, true);
    p += 2;
  };
  wstr("RIFF");
  w32(36 + dataSize);
  wstr("WAVE");
  wstr("fmt ");
  w32(16);
  w16(1);
  w16(1);
  w32(targetRate);
  w32(targetRate * 2);
  w16(2);
  w16(16);
  wstr("data");
  w32(dataSize);
  for (let i = 0; i < monoSamples.length; i++) {
    const s = Math.max(-1, Math.min(1, monoSamples[i]!));
    view.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    p += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}
