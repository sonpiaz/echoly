// ────────────────────────────────────────────────────────────────────────────
// Guest-mode language policy fetcher — talks to the public server endpoint
// GET /v1/config/guest (no auth) and caches the result. Fails safe: on any
// network/shape error returns DEFAULT_GUEST_LANGUAGE_POLICY (en→vi) so the
// popup is always usable even when offline or when the server is unreachable.
//
// Caller (router on GET_STATE) sets state.guestPolicy from this; the popup
// reads it and gates the language <select> when apiMode === "byok".
// ────────────────────────────────────────────────────────────────────────────

import { ECHOLY_GUEST_CONFIG_URL } from "@/shared/constants";
import {
  DEFAULT_GUEST_LANGUAGE_POLICY,
  type GuestLanguagePolicy,
} from "@/shared/types";

/** Cache TTL — matches the server-side service TTL so admin edits land within
 *  ~1 minute on every client even without an explicit invalidate. */
const TTL_MS = 60_000;

let cache: { value: GuestLanguagePolicy; expiresAt: number } | null = null;

/** Fetch the policy, with a 60s in-process cache and a hard 5s network
 *  timeout. Always resolves — falls back to default on any failure. */
export async function fetchGuestPolicy(
  signal?: AbortSignal,
): Promise<GuestLanguagePolicy> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.value;

  // Hard timeout: even with a good network we don't want to block GET_STATE
  // (popup open) on a slow server. 5s is generous; default fallback otherwise.
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort("guest-policy-timeout"), 5000);
  const composed = signal
    ? new AbortController()
    : ctrl;
  if (signal) {
    const linker = composed;
    signal.addEventListener("abort", () => linker.abort(signal.reason));
    ctrl.signal.addEventListener("abort", () => linker.abort(ctrl.signal.reason));
  }

  try {
    const res = await fetch(ECHOLY_GUEST_CONFIG_URL, {
      method: "GET",
      signal: composed.signal,
      // Guest endpoint is public — no credentials needed and we explicitly
      // don't send the ec_session cookie (defense-in-depth: keep the public
      // policy request anonymous).
      credentials: "omit",
    });
    if (!res.ok) return DEFAULT_GUEST_LANGUAGE_POLICY;
    const raw = (await res.json()) as { ok?: boolean; policy?: unknown };
    const validated = validateGuestPolicy(raw?.policy);
    const value = validated ?? DEFAULT_GUEST_LANGUAGE_POLICY;
    cache = { value, expiresAt: now + TTL_MS };
    return value;
  } catch {
    // Network error, abort, or JSON parse error — fall back without caching
    // (so the next call retries fresh).
    return DEFAULT_GUEST_LANGUAGE_POLICY;
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Force the next fetch to bypass cache. */
export function invalidateGuestPolicy(): void {
  cache = null;
}

// ── Local shape validator ────────────────────────────────────────────────────
// Mirrors server/src/domain/guest-policy.ts validateGuestLanguagePolicy.
// Kept local because the two repos don't share a TS package; the validator is
// small + deterministic, so duplication is cheaper than a shared dependency.

function validateGuestPolicy(p: unknown): GuestLanguagePolicy | null {
  if (!p || typeof p !== "object") return null;
  const o = p as Record<string, unknown>;
  const src = o["allowedSource"];
  const tgt = o["allowedTarget"];
  const defs = o["defaults"];
  if (!Array.isArray(src) || !Array.isArray(tgt)) return null;
  if (src.length === 0 || tgt.length === 0) return null;
  if (!src.every(isLangCode) || !tgt.every(isLangCode)) return null;
  if (!defs || typeof defs !== "object") return null;
  const d = defs as Record<string, unknown>;
  const dSrc = d["source"];
  const dTgt = d["target"];
  if (!isLangCode(dSrc) || !isLangCode(dTgt)) return null;
  if (!src.includes(dSrc) || !tgt.includes(dTgt)) return null;
  return {
    allowedSource: src as string[],
    allowedTarget: tgt as string[],
    defaults: { source: dSrc, target: dTgt },
  };
}

function isLangCode(v: unknown): v is string {
  return typeof v === "string" && /^[a-z][a-z0-9-]{1,15}$/i.test(v);
}
