// Layer A — golden/characterization tests for the pure audio math
// (src/lib/audio.ts). Inputs/outputs captured from legacy/content.js behavior:
//   computeGain 831-833, downmixAndResample 1158-1182, audioBufferToWavBlob
//   1134-1156 (16 kHz mono 16-bit PCM WAV).
import { describe, it, expect } from "vitest";
import {
  audioBufferToWavBlob,
  computeGain,
  computeRmsDbFs,
  downmixAndResample,
  type DecodedAudio,
} from "@/lib/audio";

describe("computeGain (legacy curve: unity at 50, 2× at 100, hard 0 at 0)", () => {
  it("is exactly 0 at slider 0", () => {
    expect(computeGain(0)).toBe(0);
  });
  it("is unity (1.0) at slider 50", () => {
    expect(computeGain(50)).toBeCloseTo(1.0, 10);
  });
  it("is 2.0 at slider 100 (VOICE_GAIN_MAX boost)", () => {
    expect(computeGain(100)).toBeCloseTo(2.0, 10);
  });
  it("is linear in between (25 → 0.5)", () => {
    expect(computeGain(25)).toBeCloseTo(0.5, 10);
  });
});

/** Build a minimal DecodedAudio from per-channel sample arrays. */
function makeAudio(
  channels: Float32Array[],
  sampleRate: number,
): DecodedAudio {
  return {
    sampleRate,
    numberOfChannels: channels.length,
    length: channels[0]!.length,
    getChannelData: (ch: number) => channels[ch]!,
  };
}

describe("downmixAndResample", () => {
  it("returns the mono buffer unchanged when rates match", () => {
    const mono = new Float32Array([0.1, -0.2, 0.3, -0.4]);
    const out = downmixAndResample(makeAudio([mono], 16000), 16000);
    expect(out.length).toBe(4);
    expect(out[0]).toBeCloseTo(0.1, 6);
    expect(out[1]).toBeCloseTo(-0.2, 6);
    expect(out[2]).toBeCloseTo(0.3, 6);
    expect(out[3]).toBeCloseTo(-0.4, 6);
  });

  it("averages channels to mono", () => {
    const l = new Float32Array([1.0, 0.0, -1.0, 0.5]);
    const r = new Float32Array([0.0, 1.0, 1.0, -0.5]);
    const out = downmixAndResample(makeAudio([l, r], 16000), 16000);
    expect(out[0]).toBeCloseTo(0.5, 6);
    expect(out[1]).toBeCloseTo(0.5, 6);
    expect(out[2]).toBeCloseTo(0.0, 6);
    expect(out[3]).toBeCloseTo(0.0, 6);
  });

  it("linearly downsamples (32k → 16k halves the length)", () => {
    const src = new Float32Array([0, 0.25, 0.5, 0.75, 1.0, 0.75, 0.5, 0.25]);
    const out = downmixAndResample(makeAudio([src], 32000), 16000);
    expect(out.length).toBe(4); // floor(8 / (32000/16000))
    // ratio=2 → out[i] = src[2i]
    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[1]).toBeCloseTo(0.5, 6);
    expect(out[2]).toBeCloseTo(1.0, 6);
    expect(out[3]).toBeCloseTo(0.5, 6);
  });
});

describe("audioBufferToWavBlob (16 kHz mono 16-bit PCM WAV header)", () => {
  it("emits a 44-byte RIFF/WAVE header with correct fields", async () => {
    const samples = new Float32Array([0, 1.0, -1.0, 0.5]); // 4 samples @16k
    const blob = audioBufferToWavBlob(makeAudio([samples], 16000));
    expect(blob.type).toBe("audio/wav");
    const buf = await blob.arrayBuffer();
    const view = new DataView(buf);
    const ascii = (o: number, n: number): string =>
      String.fromCharCode(...new Uint8Array(buf, o, n));
    const dataSize = samples.length * 2;
    expect(blob.size).toBe(44 + dataSize);
    expect(ascii(0, 4)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + dataSize);
    expect(ascii(8, 4)).toBe("WAVE");
    expect(ascii(12, 4)).toBe("fmt ");
    expect(view.getUint32(16, true)).toBe(16); // fmt chunk size
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000); // sample rate
    expect(view.getUint32(28, true)).toBe(32000); // byte rate (rate*2)
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16); // bits/sample
    expect(ascii(36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(dataSize);
  });

  it("clamps + scales samples to int16 (1.0→0x7FFF, -1.0→-0x8000)", async () => {
    const samples = new Float32Array([0, 1.0, -1.0, 0.5]);
    const blob = audioBufferToWavBlob(makeAudio([samples], 16000));
    const view = new DataView(await blob.arrayBuffer());
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(0x7fff);
    expect(view.getInt16(48, true)).toBe(-0x8000);
    // setInt16 truncates toward zero: 0.5 * 0x7FFF = 16383.5 → 16383 (legacy).
    expect(view.getInt16(50, true)).toBe(16383);
  });
});

/** Synthesise N samples of a full-amplitude sine wave at `freq` Hz, scaled by
 *  `amplitude`. Used to verify the dBFS calculation against known references. */
function sine(
  amplitude: number,
  freq: number,
  sampleRate: number,
  n: number,
): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  }
  return out;
}

describe("computeRmsDbFs (noise-gate floor)", () => {
  it("returns -Infinity for an empty buffer", () => {
    expect(computeRmsDbFs(new Float32Array(0))).toBe(-Infinity);
  });

  it("returns -Infinity for an all-zero buffer (digital silence)", () => {
    expect(computeRmsDbFs(new Float32Array(1024))).toBe(-Infinity);
  });

  it("full-scale sine (amplitude 1.0) is ~-3 dBFS (RMS = 1/√2)", () => {
    const buf = sine(1.0, 1000, 16000, 16000);
    const db = computeRmsDbFs(buf);
    // RMS of a unit-amplitude sine = 1/√2 ≈ 0.7071 → 20*log10(0.7071) ≈ -3.01 dB.
    expect(db).toBeGreaterThan(-3.5);
    expect(db).toBeLessThan(-2.5);
  });

  it("amplitude 0.1 sine is ~-23 dBFS (20 dB drop per ÷10 amplitude)", () => {
    const buf = sine(0.1, 1000, 16000, 16000);
    const db = computeRmsDbFs(buf);
    // 0.1× amplitude = -20 dB from full-scale → ~-23 dBFS RMS.
    expect(db).toBeGreaterThan(-23.5);
    expect(db).toBeLessThan(-22.5);
  });

  it("very quiet content (amplitude 0.001) is well below the -45 dBFS gate", () => {
    const buf = sine(0.001, 1000, 16000, 16000);
    const db = computeRmsDbFs(buf);
    // 0.001× amplitude = -60 dB from full-scale → ~-63 dBFS RMS.
    expect(db).toBeLessThan(-45);
  });
});
