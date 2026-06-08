// Credit snapshot parse — unit tests for parseUsage (session-bootstrap.ts).
// Covers D5 unified pool shape: { credits: {usedCredits, capCredits, remainingCredits},
// realtimeAllowed: boolean, resetsAt: string }.
// NOTE: parseUsage is exported with @internal for test-only use.

import { describe, expect, it } from "vitest";
import { parseUsage } from "@/background/session-bootstrap";

describe("parseUsage — unified pool snapshot parse (D5)", () => {
  it("parses a canonical max-tier snapshot with all fields", () => {
    const raw = {
      credits: { usedCredits: 4200, capCredits: 17000, remainingCredits: 12800 },
      realtimeAllowed: true,
      resetsAt: "2026-07-01T00:00:00.000Z",
    };
    const usage = parseUsage(raw);
    expect(usage).not.toBeNull();
    expect(usage!.used).toBe(4200);
    expect(usage!.cap).toBe(17000);
    expect(usage!.remaining).toBe(12800);
    expect(usage!.realtimeAllowed).toBe(true);
    expect(usage!.resetsAt).toBe("2026-07-01T00:00:00.000Z");
  });

  it("parses a pro-tier snapshot: realtimeAllowed=false, cap=6000", () => {
    const raw = {
      credits: { usedCredits: 5000, capCredits: 6000, remainingCredits: 1000 },
      realtimeAllowed: false,
      resetsAt: "2026-07-01T00:00:00.000Z",
    };
    const usage = parseUsage(raw);
    expect(usage).not.toBeNull();
    expect(usage!.used).toBe(5000);
    expect(usage!.cap).toBe(6000);
    expect(usage!.remaining).toBe(1000);
    expect(usage!.realtimeAllowed).toBe(false);
  });

  it("parses a free-tier snapshot: cap=500, realtimeAllowed=false", () => {
    const raw = {
      credits: { usedCredits: 200, capCredits: 500, remainingCredits: 300 },
      realtimeAllowed: false,
      resetsAt: "2026-07-01T00:00:00.000Z",
    };
    const usage = parseUsage(raw);
    expect(usage).not.toBeNull();
    expect(usage!.used).toBe(200);
    expect(usage!.cap).toBe(500);
    expect(usage!.remaining).toBe(300);
    expect(usage!.realtimeAllowed).toBe(false);
  });

  it("defaults usedCredits to 0 when absent", () => {
    const raw = {
      credits: { capCredits: 17000 },
      realtimeAllowed: true,
    };
    const usage = parseUsage(raw);
    expect(usage).not.toBeNull();
    expect(usage!.used).toBe(0);
    expect(usage!.cap).toBe(17000);
  });

  it("cap and remaining are undefined when absent from server (offline fallback applies)", () => {
    const raw = {
      credits: { usedCredits: 100 },
      realtimeAllowed: false,
    };
    const usage = parseUsage(raw);
    expect(usage).not.toBeNull();
    expect(usage!.used).toBe(100);
    expect(usage!.cap).toBeUndefined();
    expect(usage!.remaining).toBeUndefined();
  });

  it("realtimeAllowed defaults to false when absent", () => {
    const raw = {
      credits: { usedCredits: 0, capCredits: 500, remainingCredits: 500 },
    };
    const usage = parseUsage(raw);
    expect(usage).not.toBeNull();
    expect(usage!.realtimeAllowed).toBe(false);
  });

  it("returns null for null / undefined input", () => {
    expect(parseUsage(null)).toBeNull();
    expect(parseUsage(undefined)).toBeNull();
  });

  it("returns null when credits field is absent", () => {
    expect(parseUsage({})).toBeNull();
    expect(parseUsage({ realtimeAllowed: false, resetsAt: "2026-07-01T00:00:00.000Z" })).toBeNull();
  });

  it("returns null for non-object input", () => {
    // @ts-expect-error testing bad input
    expect(parseUsage("string")).toBeNull();
    // @ts-expect-error testing bad input
    expect(parseUsage(42)).toBeNull();
  });

  it("preserves resetsAt ISO anchor", () => {
    const iso = "2026-08-01T00:00:00.000Z";
    const usage = parseUsage({
      credits: { usedCredits: 0, capCredits: 6000, remainingCredits: 6000 },
      realtimeAllowed: false,
      resetsAt: iso,
    });
    expect(usage!.resetsAt).toBe(iso);
  });

  it("no standard/realtime split in output — single used/cap/remaining (A2/D5)", () => {
    const raw = {
      credits: { usedCredits: 3000, capCredits: 17000, remainingCredits: 14000 },
      realtimeAllowed: true,
      resetsAt: "2026-07-01T00:00:00.000Z",
    };
    const usage = parseUsage(raw);
    expect(usage).not.toBeNull();
    // Unified shape only — no per-mode split
    expect("used" in usage!).toBe(true);
    expect("cap" in usage!).toBe(true);
    expect("remaining" in usage!).toBe(true);
    // @ts-expect-error old field must not exist
    expect(usage!.standard).toBeUndefined();
    // @ts-expect-error old field must not exist
    expect(usage!.realtime).toBeUndefined();
    // @ts-expect-error old field must not exist
    expect(usage!.standardCap).toBeUndefined();
    // @ts-expect-error old field must not exist
    expect(usage!.realtimeCap).toBeUndefined();
  });

  it("A10: isRealtimeAllowed from server — free plan gets false", () => {
    const raw = {
      credits: { usedCredits: 0, capCredits: 500, remainingCredits: 500 },
      realtimeAllowed: false,
    };
    const usage = parseUsage(raw);
    expect(usage!.realtimeAllowed).toBe(false);
  });

  it("A10: isRealtimeAllowed from server — max plan gets true", () => {
    const raw = {
      credits: { usedCredits: 100, capCredits: 17000, remainingCredits: 16900 },
      realtimeAllowed: true,
    };
    const usage = parseUsage(raw);
    expect(usage!.realtimeAllowed).toBe(true);
  });
});
