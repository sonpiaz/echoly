// ────────────────────────────────────────────────────────────────────────────
// Server error parsing — turns the Echoly server's 402/429/413 envelopes
// (src/http/reserve-rejection.ts on the server) into a typed shape pipelines
// can act on. The envelope is unified for tier_locked / quota_exhausted /
// too_many_inflight / too_many_sessions / request_too_large:
//
//   {
//     error: {
//       code, message,
//       tier, mode,
//       used_minutes?, cap_minutes?,    // present on 402 paths
//       resets_at?,                     // ISO string
//       upgrade_url?,
//     }
//   }
//
// On 402 (quota/tier) we want to surface a tappable "Upgrade" toast via the
// overlay's showToast CTA. Other statuses bubble as plain errors.
// ────────────────────────────────────────────────────────────────────────────

import type { ToastOptions } from "@/shared/ports";

export type ServerErrorCode =
  | "tier_locked"
  | "quota_exhausted"
  | "too_many_inflight"
  | "too_many_sessions"
  | "request_too_large"
  | "unauthorized"
  | "forbidden"
  | "invalid_request"
  | "upstream_error"
  | "internal_error"
  | string; // forward-compatibility

export interface ParsedServerError {
  /** HTTP status from the response. */
  status: number;
  /** Server error.code (or "http_<status>" if the body wasn't an envelope). */
  code: ServerErrorCode;
  /** User-facing message (server's `error.message`, or a status fallback). */
  user: string;
  /** Server's upgrade_url, if present on the 402 paths. */
  cta?: string;
  /** Suggested CTA label ("Upgrade" by default for 402s). */
  ctaLabel?: string;
  /** True if the status was 402 — used to drive the upgrade-toast UX. */
  isQuotaOrTier: boolean;
}

/**
 * Parse a non-OK Response into the typed shape above. Best-effort on bodies
 * that aren't JSON or don't match the envelope — we still return SOMETHING so
 * the pipeline can show a toast instead of a stack trace.
 */
export async function parseServerError(res: Response): Promise<ParsedServerError> {
  const status = res.status;
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Not JSON — try text for the user message.
    try {
      const text = await res.text();
      return {
        status,
        code: `http_${status}`,
        user: text.slice(0, 200) || `Server returned ${status}.`,
        isQuotaOrTier: false,
      };
    } catch {
      return {
        status,
        code: `http_${status}`,
        user: `Server returned ${status}.`,
        isQuotaOrTier: false,
      };
    }
  }

  const err = readError(body);
  const isQuota = status === 402;
  return {
    status,
    code: err?.code ?? `http_${status}`,
    user: err?.message ?? `Server returned ${status}.`,
    cta: isQuota ? err?.upgrade_url : undefined,
    ctaLabel: isQuota && err?.upgrade_url ? "Upgrade" : undefined,
    isQuotaOrTier: isQuota,
  };
}

interface ErrorFields {
  code?: string;
  message?: string;
  upgrade_url?: string;
}

function readError(body: unknown): ErrorFields | null {
  if (!body || typeof body !== "object") return null;
  const e = (body as { error?: unknown }).error;
  if (!e || typeof e !== "object") return null;
  const o = e as Record<string, unknown>;
  return {
    code: typeof o["code"] === "string" ? (o["code"] as string) : undefined,
    message: typeof o["message"] === "string" ? (o["message"] as string) : undefined,
    upgrade_url:
      typeof o["upgrade_url"] === "string" ? (o["upgrade_url"] as string) : undefined,
  };
}

/** Convert a ParsedServerError into ToastOptions the overlay can render
 *  directly (with the Upgrade CTA on 402). */
export function toToast(parsed: ParsedServerError, durationMs = 8000): ToastOptions {
  return {
    durationMs,
    ...(parsed.cta ? { cta: parsed.cta } : {}),
    ...(parsed.ctaLabel ? { ctaLabel: parsed.ctaLabel } : {}),
  };
}
