import { post } from "@/shared/protocol";
import type { ParsedServerError } from "@/lib/server-errors";

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
