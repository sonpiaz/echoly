import { describe, expect, it } from "vitest";
import { TIER_STANDARD } from "@/shared/constants";
import {
  usagePatchFromServerError,
  type ParsedServerError,
} from "@/lib/server-errors";

describe("usagePatchFromServerError", () => {
  it("maps standard 402 credit fields", () => {
    const parsed: ParsedServerError = {
      status: 402,
      code: "quota_exhausted",
      user: "Quota exhausted",
      isQuotaOrTier: true,
      mode: TIER_STANDARD,
      usedCredits: 9500,
      capCredits: 10000,
    };
    expect(usagePatchFromServerError(parsed)).toEqual({
      standard: 9500,
      standardCap: 10000,
      standardRemaining: 500,
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
