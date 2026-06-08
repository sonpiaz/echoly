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
//       used_credits?, cap_credits?,    // present on 402 paths (CONTRACTS §D)
//       resets_at?,                     // ISO string
//       upgrade_url?,
//     }
//   }
//
// On 402 (quota/tier) we want to surface a tappable "Upgrade" toast via the
// overlay's showToast CTA. Other statuses bubble as plain errors.
// ────────────────────────────────────────────────────────────────────────────

import type { ToastOptions } from "@/shared/ports";
import { TIER_REALTIME, TIER_STANDARD, type TranslationTier } from "@/shared/constants";
import type { Usage } from "@/shared/types";
import { ECHOLY_WEB_URLS } from "@/shared/echoly-config";

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
  /** Server's upgrade_url, if present on the 402/403 paths. */
  cta?: string;
  /** Suggested CTA label ("Upgrade" for 402/403, "Sign in" for 401). */
  ctaLabel?: string;
  /** True if the status was 402 — used to drive the upgrade-toast UX. */
  isQuotaOrTier: boolean;
  /**
   * Coarse classification of the HTTP status for downstream error routing.
   *   402 → 'quota'     (credit/tier gate)
   *   401 → 'auth'      (session expired / signed out)
   *   403 → 'access'    (plan lapsed / access revoked)
   *   429 → 'rate'      (too many requests)
   *   413 → 'too_large' (request body too large)
   *   else → 'other'
   */
  kind: 'quota' | 'auth' | 'access' | 'rate' | 'too_large' | 'other';
  /** Present on 402 reserve-rejection envelopes. */
  mode?: TranslationTier;
  usedCredits?: number;
  capCredits?: number;
  resetsAt?: string;
}

type JsonValue = string | number | boolean | null | JsonObject | JsonArray;
interface JsonObject {
  [key: string]: JsonValue;
}
type JsonArray = JsonValue[];

/** Derive the `kind` discriminant from an HTTP status. */
function kindFromStatus(status: number): ParsedServerError['kind'] {
  if (status === 402) return 'quota';
  if (status === 401) return 'auth';
  if (status === 403) return 'access';
  if (status === 429) return 'rate';
  if (status === 413) return 'too_large';
  return 'other';
}

/**
 * Parse a non-OK Response into the typed shape above. Best-effort on bodies
 * that aren't JSON or don't match the envelope — we still return SOMETHING so
 * the pipeline can show a toast instead of a stack trace.
 */
export async function parseServerError(res: Response): Promise<ParsedServerError> {
  const status = res.status;
  const kind = kindFromStatus(status);
  let body: JsonObject | JsonArray | string | null = null;
  try {
    body = await res.json();
  } catch {
    // Not JSON — try text for the user message.
    try {
      const text = await res.text();
      const user = text.slice(0, 200) || `Server returned ${status}.`;
      const cta = kind === 'auth' ? ECHOLY_WEB_URLS.signin() : undefined;
      const ctaLabel = kind === 'auth' ? "Sign in" : undefined;
      return {
        status,
        code: `http_${status}`,
        user,
        isQuotaOrTier: false,
        kind,
        ...(cta ? { cta } : {}),
        ...(ctaLabel ? { ctaLabel } : {}),
      };
    } catch {
      const cta = kind === 'auth' ? ECHOLY_WEB_URLS.signin() : undefined;
      const ctaLabel = kind === 'auth' ? "Sign in" : undefined;
      return {
        status,
        code: `http_${status}`,
        user: `Server returned ${status}.`,
        isQuotaOrTier: false,
        kind,
        ...(cta ? { cta } : {}),
        ...(ctaLabel ? { ctaLabel } : {}),
      };
    }
  }

  const err = readError(body);
  const isQuota = status === 402;

  // Determine cta/ctaLabel based on status:
  //   402 → upgrade_url (if present), "Upgrade"
  //   403 → upgrade_url (if present), "Upgrade"
  //   401 → signin URL, "Sign in"
  let cta: string | undefined;
  let ctaLabel: string | undefined;
  if (isQuota) {
    cta = err?.upgrade_url;
    ctaLabel = err?.upgrade_url ? "Upgrade" : undefined;
  } else if (status === 403) {
    cta = err?.upgrade_url;
    ctaLabel = err?.upgrade_url ? "Upgrade" : undefined;
  } else if (status === 401) {
    cta = ECHOLY_WEB_URLS.signin();
    ctaLabel = "Sign in";
  }

  return {
    status,
    code: err?.code ?? `http_${status}`,
    user: err?.message ?? `Server returned ${status}.`,
    isQuotaOrTier: isQuota,
    kind,
    ...(cta !== undefined ? { cta } : {}),
    ...(ctaLabel !== undefined ? { ctaLabel } : {}),
    mode: err?.mode,
    usedCredits: err?.used_credits,
    capCredits: err?.cap_credits,
    resetsAt: err?.resets_at,
  };
}

/**
 * Returns true when the error represents an "expiry-like" condition — the user
 * cannot translate right now because of their account / credit / license state,
 * and it is NOT a transient bug (quota, session expired, access revoked).
 * Used by pipelines to decide whether to show a persistent CTA toast on the page.
 */
export function isExpiryLike(p: ParsedServerError): boolean {
  return p.kind === 'quota' || p.kind === 'auth' || p.kind === 'access';
}

/** Map a parsed 402 into store.usage fields (O(1), no bootstrap).
 *  Patches the unified pool — mode is no longer a quota dimension. */
export function usagePatchFromServerError(parsed: ParsedServerError): Partial<Usage> | null {
  if (!parsed.isQuotaOrTier) return null;
  const patch: Partial<Usage> = {};
  if (parsed.resetsAt) patch.resetsAt = parsed.resetsAt;
  if (parsed.usedCredits != null) patch.used = parsed.usedCredits;
  if (parsed.capCredits != null) patch.cap = parsed.capCredits;
  if (parsed.usedCredits != null && parsed.capCredits != null) {
    patch.remaining = Math.max(0, parsed.capCredits - parsed.usedCredits);
  }
  return Object.keys(patch).length ? patch : null;
}

interface ErrorFields {
  code?: string;
  message?: string;
  upgrade_url?: string;
  mode?: TranslationTier;
  used_credits?: number;
  cap_credits?: number;
  resets_at?: string;
}

function readError(body: JsonObject | JsonArray | string | null): ErrorFields | null {
  if (!body || typeof body !== "object") return null;
  const e = (body as { error?: JsonObject | JsonArray | string | null }).error;
  if (!e || typeof e !== "object") return null;
  const o = e as JsonObject;
  return {
    code: typeof o["code"] === "string" ? (o["code"] as string) : undefined,
    message: typeof o["message"] === "string" ? (o["message"] as string) : undefined,
    upgrade_url:
      typeof o["upgrade_url"] === "string" ? (o["upgrade_url"] as string) : undefined,
    mode:
      o["mode"] === TIER_STANDARD || o["mode"] === TIER_REALTIME
        ? (o["mode"] as TranslationTier)
        : undefined,
    used_credits: typeof o["used_credits"] === "number" ? o["used_credits"] : undefined,
    cap_credits: typeof o["cap_credits"] === "number" ? o["cap_credits"] : undefined,
    resets_at: typeof o["resets_at"] === "string" ? o["resets_at"] : undefined,
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
