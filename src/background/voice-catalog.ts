// Standard voice catalog — server SoT (CLIENT-CACHE.md).
// Signed-in: bundled in GET /v1/session/bootstrap. Signed-out: GET /v1/config/voices (HTTP cache).

import { ECHOLY_PROXY_BASE } from "@/shared/constants";
import type { LangPair } from "@/shared/constants";
import {
  OFFLINE_STANDARD_DEFAULT_VOICE,
  offlineStandardVoices,
} from "@/lib/offline-voice-bootstrap";

export interface StandardVoiceSnapshot {
  voices: LangPair[];
  defaultId: string;
}

interface VoicesResponse {
  ok?: boolean;
  voices?: Array<{ id?: string; label?: string }>;
  defaultId?: string;
}

/** Parse server voice catalog JSON (bootstrap `voices` or GET /v1/config/voices). */
export function parseVoiceCatalog(
  raw: Record<string, object | string | number | boolean | null> | null | undefined,
): StandardVoiceSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as VoicesResponse;
  if (!o.ok || !Array.isArray(o.voices) || !o.defaultId) return null;
  const voices: LangPair[] = [];
  for (const v of o.voices) {
    if (v && typeof v.id === "string" && typeof v.label === "string") {
      voices.push([v.id, v.label]);
    }
  }
  if (voices.length === 0) return null;
  return { voices, defaultId: o.defaultId };
}

export function offlineVoiceCatalog(): StandardVoiceSnapshot {
  return {
    voices: offlineStandardVoices(),
    defaultId: OFFLINE_STANDARD_DEFAULT_VOICE,
  };
}

/** Map catalog snapshot → State fields (single mutation shape for Store). */
export function standardVoiceStateFields(snapshot: StandardVoiceSnapshot): {
  standardVoices: Array<{ id: string; label: string }>;
  standardVoiceDefaultId: string;
} {
  return {
    standardVoices: snapshot.voices.map(([id, label]) => ({ id, label })),
    standardVoiceDefaultId: snapshot.defaultId,
  };
}

/** Public standard voices — browser HTTP cache (server Cache-Control). */
export async function fetchPublicStandardVoices(
  signal?: AbortSignal,
): Promise<StandardVoiceSnapshot | null> {
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort("voice-catalog-timeout"), 5000);
  const composed = signal ? new AbortController() : ctrl;
  if (signal) {
    const linker = composed;
    signal.addEventListener("abort", () => linker.abort(signal.reason));
    ctrl.signal.addEventListener("abort", () => linker.abort(ctrl.signal.reason));
  }
  try {
    const res = await fetch(`${ECHOLY_PROXY_BASE}/config/voices`, {
      method: "GET",
      cache: "default",
      signal: composed.signal,
    });
    if (!res.ok) return null;
    return parseVoiceCatalog(await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Signed-out path: public config with offline fallback. */
export async function resolveStandardVoices(): Promise<StandardVoiceSnapshot> {
  const pub = await fetchPublicStandardVoices();
  return pub ?? offlineVoiceCatalog();
}
