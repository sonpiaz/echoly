// Signed-in session bootstrap — GET /v1/session/bootstrap (user + usage + language-pairs + voices).

import { ECHOLY_PROXY_BASE } from "@/shared/constants";
import type { SignedInUser, Usage } from "@/shared/types";
import {
  parseCatalog,
  type LanguageCatalogSnapshot,
} from "./language-catalog";
import {
  offlineVoiceCatalog,
  parseVoiceCatalog,
  type StandardVoiceSnapshot,
} from "./voice-catalog";

export interface SessionBootstrapSnapshot {
  user: SignedInUser;
  usage: Usage | null;
  catalog: LanguageCatalogSnapshot;
  voices: StandardVoiceSnapshot;
}

// Credit snapshot shape per CONTRACTS §D (UsageMeterC = {usedCredits, capCredits, remainingCredits}).
// Server emits camelCase from GET /v1/session/bootstrap.
type BootstrapUsageMeter = {
  usedCredits?: number;
  capCredits?: number;
  remainingCredits?: number;
};
type BootstrapUsage = {
  standard?: BootstrapUsageMeter;
  realtime?: BootstrapUsageMeter;
  resetsAt?: string;
};

function parseMeter(m: BootstrapUsageMeter | undefined): { used: number; cap: number | undefined; remaining: number | undefined } {
  if (!m) return { used: 0, cap: undefined, remaining: undefined };
  return {
    used: m.usedCredits ?? 0,
    cap: m.capCredits,
    remaining: m.remainingCredits,
  };
}

/** @internal exported for unit tests only — not part of the public API. */
export function parseUsage(raw: BootstrapUsage | null | undefined): Usage | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw;
  if (!d.standard && !d.realtime) return null;
  const std = parseMeter(d.standard);
  const rt = parseMeter(d.realtime);
  return {
    standard: std.used,
    realtime: rt.used,
    standardCap: std.cap,
    realtimeCap: rt.cap,
    standardRemaining: std.remaining,
    realtimeRemaining: rt.remaining,
    resetsAt: d.resetsAt,
  };
}

export async function fetchSessionBootstrap(
  token: string,
  signal?: AbortSignal,
): Promise<SessionBootstrapSnapshot | null> {
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort("session-bootstrap-timeout"), 8000);
  const composed = signal ? new AbortController() : ctrl;
  if (signal) {
    const linker = composed;
    signal.addEventListener("abort", () => linker.abort(signal.reason));
    ctrl.signal.addEventListener("abort", () => linker.abort(ctrl.signal.reason));
  }
  try {
    const res = await fetch(`${ECHOLY_PROXY_BASE}/session/bootstrap`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: composed.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      signed_in?: boolean;
      user?: {
        id?: string;
        email?: string;
        tier?: SignedInUser["tier"];
        cancel_at_period_end?: boolean;
      };
      usage?: BootstrapUsage;
      languagePairs?: Record<string, object | string | number | boolean | null> | null;
      voices?: Record<string, object | string | number | boolean | null> | null;
    };
    if (!body.signed_in || !body.user?.email || !body.user.tier) return null;
    const catalog = parseCatalog(body.languagePairs);
    if (!catalog) return null;
    const voices = parseVoiceCatalog(body.voices) ?? offlineVoiceCatalog();
    return {
      user: {
        id: body.user.id,
        email: body.user.email,
        tier: body.user.tier,
        cancel_at_period_end: body.user.cancel_at_period_end,
      },
      usage: parseUsage(body.usage),
      catalog,
      voices,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
