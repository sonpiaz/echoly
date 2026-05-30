import { describe, it, expect } from "vitest";
import {
  blendPlaybackRate,
  nextDubSyncMode,
  smoothAheadEma,
  targetRateForMode,
} from "@/lib/dub-sync-engine";

describe("dub-sync-engine", () => {
  it("hysteresis: stays slow until drift drops below exit", () => {
    expect(nextDubSyncMode(2.5, "normal")).toBe("slow");
    expect(nextDubSyncMode(1.5, "slow")).toBe("slow");
    expect(nextDubSyncMode(0.8, "slow")).toBe("normal");
  });

  it("blendPlaybackRate moves gradually toward target", () => {
    const r1 = blendPlaybackRate(1, 0.92);
    expect(r1).toBeGreaterThan(0.92);
    expect(r1).toBeLessThan(1);
    const r2 = blendPlaybackRate(r1, 0.92);
    expect(r2).toBeLessThanOrEqual(r1);
  });

  it("smoothAheadEma dampens spikes", () => {
    const a = smoothAheadEma(null, 10);
    const b = smoothAheadEma(a, 0);
    expect(b).toBeLessThan(a);
    expect(b).toBeGreaterThan(0);
  });

  it("targetRateForMode maps modes", () => {
    expect(targetRateForMode("hard")).toBeLessThan(targetRateForMode("slow"));
    expect(targetRateForMode("normal")).toBe(1);
  });
});
