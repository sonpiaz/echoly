// Layer A — golden/characterization tests for parseKymaError (src/lib/kyma.ts).
// Captured from legacy/content.js:544-564 — keep the literal codes/copy.
import { describe, it, expect } from "vitest";
import { parseKymaError } from "@/lib/kyma";

describe("parseKymaError", () => {
  it("insufficient_balance → user + CTA (default billing url)", () => {
    const out = parseKymaError(
      402,
      JSON.stringify({ error: { code: "insufficient_balance" } }),
    );
    expect(out).toEqual({
      user: "Out of Kyma balance.",
      cta: "https://kymaapi.com/billing",
      ctaLabel: "Top up",
    });
  });

  it("insufficient_balance honors a server-provided cta_url", () => {
    const out = parseKymaError(
      402,
      JSON.stringify({ error: { code: "insufficient_balance", cta_url: "https://x/y" } }),
    );
    expect(out.cta).toBe("https://x/y");
  });

  it("too_many_sessions → fixed copy, no CTA", () => {
    const out = parseKymaError(
      429,
      JSON.stringify({ error: { code: "too_many_sessions" } }),
    );
    expect(out).toEqual({
      user: "Three sessions already running. Stop one or wait.",
    });
  });

  it("upstream_error → provider unreachable copy", () => {
    const out = parseKymaError(
      502,
      JSON.stringify({ error: { code: "upstream_error" } }),
    );
    expect(out.user).toBe("Provider unreachable. Try again shortly.");
  });

  it("rate_limited → wait 30s copy", () => {
    const out = parseKymaError(
      429,
      JSON.stringify({ error: { code: "rate_limited" } }),
    );
    expect(out.user).toBe("Provider rate limit hit. Wait 30s.");
  });

  it("unknown code with a message → 'Kyma <status>: <message>'", () => {
    const out = parseKymaError(
      400,
      JSON.stringify({ error: { code: "weird", message: "bad input" } }),
    );
    expect(out.user).toBe("Kyma 400: bad input");
  });

  it("non-JSON body → 'Kyma <status>: <slice160>'", () => {
    const out = parseKymaError(500, "Internal Server Error");
    expect(out.user).toBe("Kyma 500: Internal Server Error");
  });

  it("non-JSON body is sliced to 160 chars", () => {
    const long = "x".repeat(300);
    const out = parseKymaError(500, long);
    expect(out.user).toBe("Kyma 500: " + "x".repeat(160));
  });

  it("empty body → 'Kyma <status>: '", () => {
    const out = parseKymaError(503, "");
    expect(out.user).toBe("Kyma 503: ");
  });
});
