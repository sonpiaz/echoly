// User-facing error shape for pipeline toasts (from server envelope).

import type { ParsedServerError } from "@/lib/server-errors";
import { isExpiryLike } from "@/lib/server-errors";

export interface PipelineToastError {
  user: string;
  cta?: string;
  ctaLabel?: string;
  /** How long the toast should stay visible (ms). Defaults to 8000 in the overlay. */
  durationMs?: number;
  /**
   * True when the error is "expiry-like" (quota / auth / access) — the user
   * cannot translate due to their account/credit/license state, not a bug.
   * Content catches check this to decide whether to show a persistent CTA toast.
   */
  expiryLike?: boolean;
}

export function pipelineToastFromServer(parsed: ParsedServerError): PipelineToastError {
  return {
    user: parsed.user,
    ...(parsed.cta ? { cta: parsed.cta } : {}),
    ...(parsed.ctaLabel ? { ctaLabel: parsed.ctaLabel } : {}),
    expiryLike: isExpiryLike(parsed),
  };
}

/**
 * Type predicate: true when `e` is an Error that also carries a
 * `PipelineToastError` payload (duck-typed by the presence of `user: string`).
 *
 * Centralized here; re-exported from `@/lib/echoly-api` for back-compat so
 * existing importers (e.g. subtitle-first-pipeline.ts) continue to work.
 */
export function isPipelineToastError(e: unknown): e is Error & PipelineToastError {
  return (
    typeof e === "object" &&
    e !== null &&
    "user" in e &&
    typeof (e as PipelineToastError).user === "string"
  );
}
