// ────────────────────────────────────────────────────────────────────────────
// Pure — Kyma error parser. Maps an HTTP status + raw error body to a
// user-facing message (+ optional CTA). Ported verbatim from legacy/content.js
// parseKymaError (legacy lines 544-564). Keep the literal codes/copy — the
// proxy contract depends on these shapes.
// ────────────────────────────────────────────────────────────────────────────

/** A parsed, user-facing Kyma error. `cta`/`ctaLabel` present only for
 *  insufficient_balance (a "Top up" link). */
export interface ParsedKymaError {
  user: string;
  cta?: string;
  ctaLabel?: string;
}

export function parseKymaError(status: number, errText: string): ParsedKymaError {
  try {
    const parsed = JSON.parse(errText) as {
      error?: { code?: string; cta_url?: string; message?: string };
    };
    const err = parsed.error || {};
    if (err.code === "insufficient_balance") {
      const cta = err.cta_url || "https://kymaapi.com/billing";
      return { user: "Out of Kyma balance.", cta, ctaLabel: "Top up" };
    }
    if (err.code === "too_many_sessions") {
      return { user: "Three sessions already running. Stop one or wait." };
    }
    if (err.code === "upstream_error") {
      return { user: "Provider unreachable. Try again shortly." };
    }
    if (err.code === "rate_limited") {
      return { user: "Provider rate limit hit. Wait 30s." };
    }
    if (err.message) return { user: "Kyma " + status + ": " + err.message };
  } catch {
    // fall through to the generic slice-160 form
  }
  return { user: "Kyma " + status + ": " + (errText || "").slice(0, 160) };
}
