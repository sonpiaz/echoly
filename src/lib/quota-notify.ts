import { post } from "@/shared/protocol";
import type { ParsedServerError } from "@/lib/server-errors";
import { ECHOLY_PROXY_BASE } from "@/shared/constants";

/** Push 402 metering fields to the SW (patch usage without bootstrap).
 *  Mode is no longer a quota dimension — the unified pool is patched directly. */
export function notifyQuotaToBackground(parsed: ParsedServerError): void {
  if (!parsed.isQuotaOrTier) return;
  post({
    type: "CONTENT_QUOTA",
    used_credits: parsed.usedCredits,
    cap_credits: parsed.capCredits,
    resets_at: parsed.resetsAt,
  });
}

/**
 * Fetch `/v1/usage` once and push the result to the SW as `CONTENT_QUOTA` so
 * the popup meter reflects the current balance immediately after a mid-session
 * data-channel `quota_exhausted` event (SOLUTION WS5.5 / S5-F9).
 *
 * The data-channel error frame carries no numeric usage fields, so without this
 * fetch the popup shows stale credit numbers after credit exhaustion mid-session.
 *
 * Fire-and-forget: errors are silently swallowed (the popup will refresh on
 * the next bootstrap or CONTENT_STATE if this fails).
 */
export function refreshUsageAfterExhaustion(apiBearer: string): void {
  if (!apiBearer) return;
  fetch(`${ECHOLY_PROXY_BASE}/usage`, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiBearer}` },
    cache: "no-store",
  })
    .then(async (res) => {
      if (!res.ok) return;
      const body = (await res.json()) as {
        credits?: {
          usedCredits?: number;
          capCredits?: number;
          remainingCredits?: number;
        };
        resetsAt?: string;
      };
      const credits = body?.credits;
      if (!credits) return;
      post({
        type: "CONTENT_QUOTA",
        used_credits: credits.usedCredits,
        cap_credits: credits.capCredits,
        resets_at: body.resetsAt,
      });
    })
    .catch(() => {});
}
