// Tests for the renewsAtLabel function added for W2 (annual billing display).
import { describe, it, expect } from "vitest";
import { renewsAtLabel } from "@/lib/popup-format";

describe("renewsAtLabel — annual plan renewal date formatting", () => {
  it("formats a future renewal date as short month, day, year (en-US)", () => {
    // June 4, 2027
    expect(renewsAtLabel("2027-06-04T00:00:00.000Z")).toBe("Jun 4, 2027");
  });

  it("formats another date correctly", () => {
    // December 31, 2026
    expect(renewsAtLabel("2026-12-31T00:00:00.000Z")).toBe("Dec 31, 2026");
  });

  it("interprets the date in UTC (not local time)", () => {
    // Jan 1, 2027 at UTC midnight should still be Jan 1
    expect(renewsAtLabel("2027-01-01T00:00:00.000Z")).toBe("Jan 1, 2027");
  });

  it("returns empty string for null", () => {
    expect(renewsAtLabel(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(renewsAtLabel(undefined)).toBe("");
  });

  it("returns empty string for an invalid ISO string", () => {
    expect(renewsAtLabel("not-a-date")).toBe("");
    expect(renewsAtLabel("")).toBe("");
  });

  it("single-digit day is not zero-padded", () => {
    expect(renewsAtLabel("2027-06-04T00:00:00.000Z")).toBe("Jun 4, 2027");
  });

  it("handles March (3-letter abbreviation)", () => {
    expect(renewsAtLabel("2027-03-15T00:00:00.000Z")).toBe("Mar 15, 2027");
  });
});
