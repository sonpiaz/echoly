import { post } from "@/shared/protocol";
import type { ParsedServerError } from "@/lib/server-errors";

/** Push 402 metering fields to the SW (patch usage without bootstrap). */
export function notifyQuotaToBackground(parsed: ParsedServerError): void {
  if (!parsed.isQuotaOrTier) return;
  post({
    type: "CONTENT_QUOTA",
    mode: parsed.mode,
    used_minutes: parsed.usedMinutes,
    cap_minutes: parsed.capMinutes,
    resets_at: parsed.resetsAt,
  });
}
