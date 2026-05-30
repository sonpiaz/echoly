import { describe, it, expect } from "vitest";
import { computeGain } from "@/lib/audio";

describe("computeGain", () => {
  it("returns 0 at slider 0", () => {
    expect(computeGain(0)).toBe(0);
  });

  it("returns unity at 50", () => {
    expect(computeGain(50)).toBe(1);
  });

  it("returns 2× at 100", () => {
    expect(computeGain(100)).toBe(2);
  });
});
