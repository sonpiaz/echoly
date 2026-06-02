// Layer A — pure-fn golden tests for the popup reducers (chrome-free, node env).
// Values are credits (1000 credits = $1). fmtCredits for meters; fmtElapsed for timer.
import { describe, expect, it, vi } from "vitest";
import { capsForTier } from "@/lib/tier-cap";
import {
  allowRealtime,
  daysLeftLabel,
  daysUntilReset,
  fillPercent,
  fmtCredits,
  fmtElapsed,
  meterLevel,
  nextResetLabel,
  resetsAtLabel,
  shade,
  tierBadge,
} from "@/lib/popup-format";

describe("shade", () => {
  it("darkens with a negative percent", () => {
    // -18 % of 255 ≈ 45.9 → channel subtracts ~46 then int-truncates.
    expect(shade("#7B5BFF", -18)).toBe("rgb(77, 45, 209)");
    expect(shade("#FF6FB1", -18)).toBe("rgb(209, 65, 131)");
  });
  it("clamps to [0, 255]", () => {
    expect(shade("#000000", -50)).toBe("rgb(0, 0, 0)");
    expect(shade("#FFFFFF", 50)).toBe("rgb(255, 255, 255)");
  });
  it("tolerates inputs without the '#'", () => {
    expect(shade("8B5BFF", 0)).toBe("rgb(139, 91, 255)");
  });
});

describe("fmtElapsed", () => {
  it("formats minutes and seconds with zero-padding", () => {
    expect(fmtElapsed(0)).toBe("00:00");
    expect(fmtElapsed(9)).toBe("00:09");
    expect(fmtElapsed(60)).toBe("01:00");
    expect(fmtElapsed(3599)).toBe("59:59");
  });
  it("switches to h:mm:ss past one hour", () => {
    expect(fmtElapsed(3600)).toBe("1:00:00");
    expect(fmtElapsed(3661)).toBe("1:01:01");
    expect(fmtElapsed(36000)).toBe("10:00:00");
  });
  it("collapses negative / NaN inputs to 00:00", () => {
    expect(fmtElapsed(-5)).toBe("00:00");
    expect(fmtElapsed(NaN)).toBe("00:00");
  });
  it("floors fractional seconds", () => {
    expect(fmtElapsed(9.9)).toBe("00:09");
  });
});

describe("fmtCredits", () => {
  it("formats credit integers with thousands separators", () => {
    expect(fmtCredits(0)).toBe("0");
    expect(fmtCredits(1000)).toBe("1,000");
    expect(fmtCredits(4200)).toBe("4,200");
    expect(fmtCredits(10000)).toBe("10,000");
    expect(fmtCredits(28000)).toBe("28,000");
    expect(fmtCredits(6000)).toBe("6,000");
  });
  it("rounds fractional credits to nearest integer", () => {
    expect(fmtCredits(999.7)).toBe("1,000");
    expect(fmtCredits(999.4)).toBe("999");
  });
  it("treats falsy as 0", () => {
    expect(fmtCredits(NaN)).toBe("0");
    // @ts-expect-error tolerated undefined
    expect(fmtCredits(undefined)).toBe("0");
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

describe("capsForTier (offline bootstrap — credits)", () => {
  it("matches CAPS_CREDITS: free 1000, pro 10000, max 28000/6000", () => {
    expect(capsForTier("free")).toEqual({ std: 1000, rt: 0 });
    expect(capsForTier("pro")).toEqual({ std: 10000, rt: 0 });
    expect(capsForTier("max")).toEqual({ std: 28000, rt: 6000 });
  });
  it("unknown / nullish tier falls back to free", () => {
    expect(capsForTier("unknown")).toEqual({ std: 1000, rt: 0 });
    expect(capsForTier(undefined)).toEqual({ std: 1000, rt: 0 });
    expect(capsForTier(null)).toEqual({ std: 1000, rt: 0 });
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
  it("only max tier allows realtime", () => {
    expect(allowRealtime("max")).toBe(true);
    expect(allowRealtime("pro")).toBe(false);
    expect(allowRealtime("free")).toBe(false);
    expect(allowRealtime(undefined)).toBe(false);
  });
});

describe("tierBadge", () => {
  it("maps account tiers to labels", () => {
    expect(tierBadge("max")).toEqual({ label: "Max", dataTier: "max" });
    expect(tierBadge("pro")).toEqual({ label: "Pro", dataTier: "pro" });
    expect(tierBadge("free")).toEqual({ label: "Free", dataTier: "free" });
    expect(tierBadge(undefined)).toEqual({ label: "Free", dataTier: "free" });
  });
});

describe("nextResetLabel", () => {
  it("is the 1st of the next month (UTC), en-US month + day", () => {
    expect(nextResetLabel(new Date(Date.UTC(2026, 4, 27)))).toBe("June 1");
    expect(nextResetLabel(new Date(Date.UTC(2026, 11, 15)))).toBe("January 1");
    expect(nextResetLabel(new Date(Date.UTC(2026, 0, 1)))).toBe("February 1");
  });
});

describe("resetsAtLabel", () => {
  it("formats server anchor ISO in UTC", () => {
    expect(resetsAtLabel("2026-06-15T10:00:00.000Z")).toBe("June 15");
  });

  it("falls back to next calendar month when ISO missing", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 4, 27)));
    expect(resetsAtLabel(undefined)).toBe("June 1");
    vi.useRealTimers();
  });
});

describe("daysUntilReset / daysLeftLabel", () => {
  const now = new Date(Date.UTC(2026, 4, 14, 12, 0, 0));

  it("counts whole days until resets_at (ceil)", () => {
    expect(daysUntilReset("2026-06-01T00:00:00.000Z", now)).toBe(18);
  });

  it("returns 0 when the period already ended", () => {
    expect(daysUntilReset("2026-05-01T00:00:00.000Z", now)).toBe(0);
  });

  it("returns null for missing or invalid ISO", () => {
    expect(daysUntilReset(undefined, now)).toBeNull();
    expect(daysUntilReset("not-a-date", now)).toBeNull();
  });

  it("formats the account-menu suffix", () => {
    expect(daysLeftLabel("2026-06-01T00:00:00.000Z", now)).toBe("· 18 days left");
    expect(daysLeftLabel("2026-05-15T00:00:00.000Z", now)).toBe("· 1 day left");
  });
});
