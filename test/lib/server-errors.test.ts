import { describe, expect, it } from "vitest";
import { TIER_STANDARD } from "@/shared/constants";
import {
  usagePatchFromServerError,
  type ParsedServerError,
} from "@/lib/server-errors";

describe("usagePatchFromServerError", () => {
  it("maps standard 402 fields", () => {
    const parsed: ParsedServerError = {
      status: 402,
      code: "quota_exhausted",
      user: "Quota exhausted",
      isQuotaOrTier: true,
      mode: TIER_STANDARD,
      usedMinutes: 29.5,
      capMinutes: 30,
    };
    expect(usagePatchFromServerError(parsed)).toEqual({
      standard: 29.5,
      standardCap: 30,
      standardRemaining: 0.5,
    });
  });

  it("returns null for non-402", () => {
    expect(
      usagePatchFromServerError({
        status: 500,
        code: "internal_error",
        user: "err",
        isQuotaOrTier: false,
      }),
    ).toBeNull();
  });
});
