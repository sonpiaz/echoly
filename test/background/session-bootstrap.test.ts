// Credit snapshot parse — unit tests for parseUsage (session-bootstrap.ts).
// Covers CONTRACTS §D: UsageMeterC shape → Usage stored values.
// NOTE: parseUsage is exported with @internal for test-only use.

import { describe, expect, it } from "vitest";
import { parseUsage } from "@/background/session-bootstrap";

describe("parseUsage — credit snapshot parse (CONTRACTS §D)", () => {
  it("parses a canonical max-tier snapshot with all fields", () => {
    const raw = {
      standard: { usedCredits: 4200, capCredits: 28000, remainingCredits: 23800 },
      realtime: { usedCredits: 150, capCredits: 6000, remainingCredits: 5850 },
      resetsAt: "2026-07-01T00:00:00.000Z",
    };
    const usage = parseUsage(raw);
    expect(usage).not.toBeNull();
    expect(usage!.standard).toBe(4200);
    expect(usage!.standardCap).toBe(28000);
    expect(usage!.standardRemaining).toBe(23800);
    expect(usage!.realtime).toBe(150);
    expect(usage!.realtimeCap).toBe(6000);
    expect(usage!.realtimeRemaining).toBe(5850);
    expect(usage!.resetsAt).toBe("2026-07-01T00:00:00.000Z");
  });

  it("parses a canonical non-max snapshot: realtime capCredits=0, remainingCredits=0", () => {
    // CONTRACTS §D: Server MUST send realtime.capCredits=0 for non-Max plans.
    const raw = {
      standard: { usedCredits: 7500, capCredits: 10000, remainingCredits: 2500 },
      realtime: { usedCredits: 0, capCredits: 0, remainingCredits: 0 },
      resetsAt: "2026-07-01T00:00:00.000Z",
    };
    const usage = parseUsage(raw);
    expect(usage).not.toBeNull();
    expect(usage!.standard).toBe(7500);
    expect(usage!.standardCap).toBe(10000);
    expect(usage!.standardRemaining).toBe(2500);
    expect(usage!.realtime).toBe(0);
    expect(usage!.realtimeCap).toBe(0);
    expect(usage!.realtimeRemaining).toBe(0);
  });

  it("parses a free-tier snapshot: standard used 200, realtime cap=0", () => {
    const raw = {
      standard: { usedCredits: 200, capCredits: 1000, remainingCredits: 800 },
      realtime: { usedCredits: 0, capCredits: 0, remainingCredits: 0 },
      resetsAt: "2026-07-01T00:00:00.000Z",
    };
    const usage = parseUsage(raw);
    expect(usage).not.toBeNull();
    expect(usage!.standard).toBe(200);
    expect(usage!.standardCap).toBe(1000);
    expect(usage!.realtimeCap).toBe(0);
  });

  it("defaults usedCredits to 0 when absent", () => {
    const raw = {
      standard: { capCredits: 10000 },
      realtime: { capCredits: 6000 },
    };
    const usage = parseUsage(raw);
    expect(usage).not.toBeNull();
    expect(usage!.standard).toBe(0);
    expect(usage!.realtime).toBe(0);
  });

  it("cap and remaining are undefined when absent from server (offline fallback)", () => {
    const raw = {
      standard: { usedCredits: 100 },
      realtime: { usedCredits: 0 },
    };
    const usage = parseUsage(raw);
    expect(usage).not.toBeNull();
    expect(usage!.standardCap).toBeUndefined();
    expect(usage!.realtimeCap).toBeUndefined();
    expect(usage!.standardRemaining).toBeUndefined();
    expect(usage!.realtimeRemaining).toBeUndefined();
  });

  it("returns null for null / undefined input", () => {
    expect(parseUsage(null)).toBeNull();
    expect(parseUsage(undefined)).toBeNull();
  });

  it("returns null when neither standard nor realtime is present", () => {
    expect(parseUsage({})).toBeNull();
    expect(parseUsage({ resetsAt: "2026-07-01T00:00:00.000Z" })).toBeNull();
  });

  it("returns non-null when only standard is present (no realtime field)", () => {
    const raw = { standard: { usedCredits: 500, capCredits: 1000, remainingCredits: 500 } };
    const usage = parseUsage(raw);
    expect(usage).not.toBeNull();
    expect(usage!.standard).toBe(500);
    expect(usage!.realtime).toBe(0);
    expect(usage!.realtimeCap).toBeUndefined();
  });

  it("preserves resetsAt ISO anchor", () => {
    const iso = "2026-08-01T00:00:00.000Z";
    const usage = parseUsage({
      standard: { usedCredits: 0, capCredits: 1000, remainingCredits: 1000 },
      resetsAt: iso,
    });
    expect(usage!.resetsAt).toBe(iso);
  });
});
