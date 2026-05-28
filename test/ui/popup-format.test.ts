// Layer A — pure-fn golden tests for the popup reducers (chrome-free, node env).
// Values are the real ones from legacy/popup.js (fmtMin/meterLevel/tier-gating).
import { describe, expect, it } from "vitest";
import {
  allowRealtime,
  capsForTier,
  fillPercent,
  fmtMin,
  keyBadge,
  meterLevel,
  nextResetLabel,
  tierBadge,
} from "@/lib/popup-format";

describe("fmtMin", () => {
  it("rounds and groups with en-US locale", () => {
    expect(fmtMin(0)).toBe("0");
    expect(fmtMin(30)).toBe("30");
    expect(fmtMin(600)).toBe("600");
    expect(fmtMin(3000)).toBe("3,000");
    expect(fmtMin(12.4)).toBe("12");
    expect(fmtMin(12.5)).toBe("13");
  });
  it("treats falsy as 0 (legacy `n || 0`)", () => {
    expect(fmtMin(NaN)).toBe("0");
    // @ts-expect-error legacy tolerated undefined input
    expect(fmtMin(undefined)).toBe("0");
  });
});

describe("meterLevel", () => {
  it("returns ok when there is no cap (rt cap 0)", () => {
    expect(meterLevel(50, 0)).toBe("ok");
  });
  it("buckets by ratio: <0.9 ok, >=0.9 warning, >=1.0 danger", () => {
    expect(meterLevel(0, 30)).toBe("ok");
    expect(meterLevel(26, 30)).toBe("ok"); // 0.866
    expect(meterLevel(27, 30)).toBe("warning"); // 0.9
    expect(meterLevel(29, 30)).toBe("warning"); // 0.966
    expect(meterLevel(30, 30)).toBe("danger"); // 1.0
    expect(meterLevel(45, 30)).toBe("danger"); // over cap
  });
  it("boundary exactly 0.9 → warning, exactly 1.0 → danger", () => {
    expect(meterLevel(540, 600)).toBe("warning"); // 0.9
    expect(meterLevel(600, 600)).toBe("danger"); // 1.0
  });
});

describe("capsForTier (TIER_CAPS)", () => {
  it("matches legacy caps exactly", () => {
    expect(capsForTier("free")).toEqual({ std: 30, rt: 0 });
    expect(capsForTier("pro")).toEqual({ std: 600, rt: 0 });
    expect(capsForTier("max")).toEqual({ std: 3000, rt: 120 });
  });
  it("unknown / nullish tier falls back to free", () => {
    expect(capsForTier("byok")).toEqual({ std: 30, rt: 0 });
    expect(capsForTier(undefined)).toEqual({ std: 30, rt: 0 });
    expect(capsForTier(null)).toEqual({ std: 30, rt: 0 });
  });
});

describe("fillPercent", () => {
  it("clamps to 100 and is 0 when no cap", () => {
    expect(fillPercent(0, 30)).toBe(0);
    expect(fillPercent(15, 30)).toBe(50);
    expect(fillPercent(30, 30)).toBe(100);
    expect(fillPercent(45, 30)).toBe(100); // clamped
    expect(fillPercent(50, 0)).toBe(0); // no cap → 0%
  });
});

describe("allowRealtime (tier gating)", () => {
  it("BYOK key always allows realtime", () => {
    expect(allowRealtime("free", "ky-abc")).toBe(true);
    expect(allowRealtime(undefined, "kyma-xyz")).toBe(true);
    expect(allowRealtime("pro", "  ky-spaces  ")).toBe(true);
  });
  it("no key: only max tier allows realtime", () => {
    expect(allowRealtime("max", "")).toBe(true);
    expect(allowRealtime("pro", "")).toBe(false);
    expect(allowRealtime("free", "")).toBe(false);
    expect(allowRealtime(undefined, "")).toBe(false);
  });
  it("whitespace-only key counts as no key", () => {
    expect(allowRealtime("free", "   ")).toBe(false);
  });
});

describe("tierBadge", () => {
  it("BYOK wins when a key is present", () => {
    expect(tierBadge("max", true)).toEqual({ label: "BYOK", dataTier: "byok" });
    expect(tierBadge(undefined, true)).toEqual({
      label: "BYOK",
      dataTier: "byok",
    });
  });
  it("maps tiers to labels when no key", () => {
    expect(tierBadge("max", false)).toEqual({ label: "Max", dataTier: "max" });
    expect(tierBadge("pro", false)).toEqual({ label: "Pro", dataTier: "pro" });
    expect(tierBadge("free", false)).toEqual({
      label: "Free",
      dataTier: "free",
    });
    expect(tierBadge(undefined, false)).toEqual({
      label: "Free",
      dataTier: "free",
    });
  });
});

describe("keyBadge", () => {
  it("empty → missing (no class)", () => {
    expect(keyBadge("")).toEqual({ label: "missing", cls: "" });
  });
  it("ky / kyma- prefix → saved (ok)", () => {
    expect(keyBadge("ky-123")).toEqual({ label: "saved", cls: "ok" });
    expect(keyBadge("kyma-xyz")).toEqual({ label: "saved", cls: "ok" });
    expect(keyBadge("ky")).toEqual({ label: "saved", cls: "ok" });
  });
  it("other → check (warn)", () => {
    expect(keyBadge("sk-openai")).toEqual({ label: "check", cls: "warn" });
    expect(keyBadge("random")).toEqual({ label: "check", cls: "warn" });
  });
});

describe("nextResetLabel", () => {
  it("is the 1st of the next month (UTC), en-US month + day", () => {
    expect(nextResetLabel(new Date(Date.UTC(2026, 4, 27)))).toBe("June 1");
    expect(nextResetLabel(new Date(Date.UTC(2026, 11, 15)))).toBe("January 1");
    expect(nextResetLabel(new Date(Date.UTC(2026, 0, 1)))).toBe("February 1");
  });
});
