import { describe, expect, it } from "vitest";
import { TIER_STANDARD } from "@/shared/constants";
import {
  usagePatchFromServerError,
  parseServerError,
  isExpiryLike,
  type ParsedServerError,
} from "@/lib/server-errors";
import { ECHOLY_WEB_URLS } from "@/shared/echoly-config";

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Pattern A (from SOLUTION.md): build a real Response with a JSON error
 * envelope so parseServerError sees the actual fetch-API surface.
 */
function jsonResponse(body: object, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function envelope(
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): object {
  return { error: { code, message, ...extra } };
}

// ── parseServerError — kind classification ────────────────────────────────

describe("parseServerError — kind classification", () => {
  it("402 → kind='quota'", async () => {
    const parsed = await parseServerError(
      jsonResponse(envelope("quota_exhausted", "Credits used up"), 402),
    );
    expect(parsed.kind).toBe("quota");
    expect(parsed.status).toBe(402);
  });

  it("401 → kind='auth'", async () => {
    const parsed = await parseServerError(
      jsonResponse(envelope("unauthorized", "Session expired"), 401),
    );
    expect(parsed.kind).toBe("auth");
    expect(parsed.status).toBe(401);
  });

  it("403 → kind='access'", async () => {
    const parsed = await parseServerError(
      jsonResponse(envelope("forbidden", "Access denied"), 403),
    );
    expect(parsed.kind).toBe("access");
    expect(parsed.status).toBe(403);
  });

  it("429 → kind='rate'", async () => {
    const parsed = await parseServerError(
      jsonResponse(envelope("too_many_inflight", "Too many requests"), 429),
    );
    expect(parsed.kind).toBe("rate");
    expect(parsed.status).toBe(429);
  });

  it("413 → kind='too_large'", async () => {
    const parsed = await parseServerError(
      jsonResponse(envelope("request_too_large", "Payload too large"), 413),
    );
    expect(parsed.kind).toBe("too_large");
    expect(parsed.status).toBe(413);
  });

  it("500 → kind='other'", async () => {
    const parsed = await parseServerError(
      jsonResponse(envelope("internal_error", "Internal server error"), 500),
    );
    expect(parsed.kind).toBe("other");
    expect(parsed.status).toBe(500);
  });
});

// ── parseServerError — cta / ctaLabel population ─────────────────────────

describe("parseServerError — cta and ctaLabel", () => {
  it("402 with upgrade_url → cta=upgrade_url, ctaLabel='Upgrade'", async () => {
    const parsed = await parseServerError(
      jsonResponse(
        envelope("quota_exhausted", "Credits used up", {
          upgrade_url: "https://echolyhq.com/upgrade",
        }),
        402,
      ),
    );
    expect(parsed.cta).toBe("https://echolyhq.com/upgrade");
    expect(parsed.ctaLabel).toBe("Upgrade");
  });

  it("402 without upgrade_url → no cta, no ctaLabel", async () => {
    const parsed = await parseServerError(
      jsonResponse(envelope("tier_locked", "Tier not available"), 402),
    );
    expect(parsed.cta).toBeUndefined();
    expect(parsed.ctaLabel).toBeUndefined();
  });

  it("403 with upgrade_url → cta=upgrade_url, ctaLabel='Upgrade'", async () => {
    const parsed = await parseServerError(
      jsonResponse(
        envelope("forbidden", "Plan lapsed", {
          upgrade_url: "https://echolyhq.com/upgrade",
        }),
        403,
      ),
    );
    expect(parsed.cta).toBe("https://echolyhq.com/upgrade");
    expect(parsed.ctaLabel).toBe("Upgrade");
  });

  it("403 without upgrade_url → no cta, no ctaLabel", async () => {
    const parsed = await parseServerError(
      jsonResponse(envelope("forbidden", "Access revoked"), 403),
    );
    expect(parsed.cta).toBeUndefined();
    expect(parsed.ctaLabel).toBeUndefined();
  });

  it("401 → cta=ECHOLY_WEB_URLS.signin(), ctaLabel='Sign in'", async () => {
    const parsed = await parseServerError(
      jsonResponse(envelope("unauthorized", "Session expired"), 401),
    );
    expect(parsed.cta).toBe(ECHOLY_WEB_URLS.signin());
    expect(parsed.ctaLabel).toBe("Sign in");
  });

  it("429 → no cta, no ctaLabel", async () => {
    const parsed = await parseServerError(
      jsonResponse(envelope("too_many_inflight", "Too many requests"), 429),
    );
    expect(parsed.cta).toBeUndefined();
    expect(parsed.ctaLabel).toBeUndefined();
  });
});

// ── isExpiryLike ──────────────────────────────────────────────────────────

describe("isExpiryLike", () => {
  it("returns true for kind='quota' (402)", async () => {
    const parsed = await parseServerError(
      jsonResponse(envelope("quota_exhausted", "Credits used up"), 402),
    );
    expect(isExpiryLike(parsed)).toBe(true);
  });

  it("returns true for kind='auth' (401)", async () => {
    const parsed = await parseServerError(
      jsonResponse(envelope("unauthorized", "Session expired"), 401),
    );
    expect(isExpiryLike(parsed)).toBe(true);
  });

  it("returns true for kind='access' (403)", async () => {
    const parsed = await parseServerError(
      jsonResponse(envelope("forbidden", "Plan lapsed"), 403),
    );
    expect(isExpiryLike(parsed)).toBe(true);
  });

  it("returns false for kind='rate' (429)", async () => {
    const parsed = await parseServerError(
      jsonResponse(envelope("too_many_inflight", "Rate limited"), 429),
    );
    expect(isExpiryLike(parsed)).toBe(false);
  });

  it("returns false for kind='too_large' (413)", async () => {
    const parsed = await parseServerError(
      jsonResponse(envelope("request_too_large", "Too large"), 413),
    );
    expect(isExpiryLike(parsed)).toBe(false);
  });

  it("returns false for kind='other' (500)", async () => {
    const parsed = await parseServerError(
      jsonResponse(envelope("internal_error", "Server error"), 500),
    );
    expect(isExpiryLike(parsed)).toBe(false);
  });
});

// ── isQuotaOrTier regression guard (402-only) ────────────────────────────

describe("isQuotaOrTier — regression guard (402-only)", () => {
  it("isQuotaOrTier=true only for 402", async () => {
    const r402 = await parseServerError(
      jsonResponse(envelope("quota_exhausted", "Credits"), 402),
    );
    expect(r402.isQuotaOrTier).toBe(true);

    for (const status of [401, 403, 429, 413, 500]) {
      const parsed = await parseServerError(
        jsonResponse(envelope("some_code", "some message"), status),
      );
      expect(parsed.isQuotaOrTier).toBe(false);
    }
  });
});

// ── original usagePatchFromServerError tests (unchanged) ─────────────────

describe("usagePatchFromServerError", () => {
  it("maps standard 402 credit fields", () => {
    const parsed: ParsedServerError = {
      status: 402,
      code: "quota_exhausted",
      user: "Quota exhausted",
      isQuotaOrTier: true,
      kind: "quota",
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
        kind: "other",
      }),
    ).toBeNull();
  });
});
