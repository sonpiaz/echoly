// User-facing error shape for pipeline toasts (from server envelope).

import type { ParsedServerError } from "@/lib/server-errors";

export interface PipelineToastError {
  user: string;
  cta?: string;
  ctaLabel?: string;
}

export function pipelineToastFromServer(parsed: ParsedServerError): PipelineToastError {
  return {
    user: parsed.user,
    ...(parsed.cta ? { cta: parsed.cta } : {}),
    ...(parsed.ctaLabel ? { ctaLabel: parsed.ctaLabel } : {}),
  };
}
