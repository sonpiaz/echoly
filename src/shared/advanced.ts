// ────────────────────────────────────────────────────────────────────────────
// LOCKED CONTRACT — Advanced settings (per-user, server-authoritative).
//
// The popup persists each control via UPDATE_ADVANCED_SETTINGS → SW → PUT
// /v1/me/settings. Server is source of truth; chrome.storage.local is the
// offline cache. Per-site overrides live in a separate map keyed by hostname.
//
// The 6 surviving SHIP controls (8 minus 2 expert-confirmed DROPs):
//   1. translationStyle — Standard pipeline prompt prefix (literal/natural/casual)
//   2. latencyPreset    — Standard chunk window (snappy/smooth)
//   3. captionPosition  — Overlay docked position preset (top/bottom/float)
//   4. autoStartHosts   — Per-host map { hostname: true }
//   5. outputDeviceId   — HTMLMediaElement.setSinkId target ("" = default)
//   6. noiseGate        — Standard pipeline RMS gate (off/on)
//
// DROP'd controls (do not add back without provider-level support):
//   • voice clone strength — OpenAI Realtime + MiniMax don't expose the knob
//   • pause-on-video-pause — default already correct; off-state has no use case
//
// Pure module: no chrome.*, no DOM, no fetch. Importable by content, popup,
// background, and (via the server-side mirror in domain/settings.ts) the
// server's settings.service.
// ────────────────────────────────────────────────────────────────────────────

export type TranslationStyle = "literal" | "natural" | "casual";
export type LatencyPreset = "snappy" | "smooth";
export type CaptionPosition = "top" | "bottom" | "float";

export interface AdvancedSettings {
  translationStyle: TranslationStyle;
  latencyPreset: LatencyPreset;
  captionPosition: CaptionPosition;
  /** Map of hostname → boolean. Only present-and-true entries auto-start. */
  autoStartHosts: Record<string, boolean>;
  /** HTMLMediaElement.sinkId. Empty string means system default. */
  outputDeviceId: string;
  /** When true, the Standard pipeline drops chunks below NOISE_GATE_DBFS. */
  noiseGate: boolean;
}

export const DEFAULT_ADVANCED: AdvancedSettings = {
  translationStyle: "natural",
  latencyPreset: "smooth",
  captionPosition: "bottom",
  autoStartHosts: {},
  outputDeviceId: "",
  noiseGate: true,
};

/** A partial of AdvancedSettings — what the popup sends in UPDATE_ADVANCED_SETTINGS. */
export type AdvancedPatch = Partial<AdvancedSettings>;

/** Per-domain overrides. Each value is a partial — only fields the user set
 *  on that site. Merged client-side: effective = { ...global, ...overrides[domain] }. */
export type SiteOverrideMap = Record<string, AdvancedPatch>;

// ── Lookup tables (the values each control influences) ──────────────────────

/** Standard / subtitle-first pipeline prompt prefix per style. The prompt is
 *  prepended to the existing translation question so the LLM steers tone. */
export const STYLE_PROMPTS: Record<TranslationStyle, string> = {
  literal:
    "Translate word-for-word, preserving structure. Be faithful even if it sounds awkward. ",
  natural:
    "Translate naturally — match accuracy and readability, prefer everyday phrasing. ",
  casual:
    "Translate casually — use conversational phrasing, contractions, light idioms. ",
};

/** Standard pipeline MediaRecorder window per preset. Realtime tier ignores
 *  this — it relies on server-VAD silence detection. */
export const LATENCY_CHUNK_MS: Record<LatencyPreset, number> = {
  snappy: 3000,
  smooth: 5000,
};

/** Overlay docked layout per preset. `left/top` in % strings (so the overlay
 *  scales with the viewport). `width/height` are content-script defaults from
 *  template.ts (clamped); applied via applyLayout(). User drag overrides
 *  these (LAYOUT_KEY persists the explicit position). */
export interface OverlayPreset {
  left: string;
  top: string;
}
export const CAPTION_PRESETS: Record<CaptionPosition, OverlayPreset> = {
  top:    { left: "50%", top: "8%"  },
  bottom: { left: "50%", top: "78%" },
  float:  { left: "20%", top: "40%" },
};

/** RMS threshold (dBFS) — chunks whose RMS is below this are dropped when
 *  noiseGate=true. -45 dBFS is conservative: drops near-silence + background
 *  music while letting through quiet speech (which lives around -35 to -25
 *  dBFS in normal recordings). */
export const NOISE_GATE_DBFS = -45;

// ── Validators (no zod dep in extension) ────────────────────────────────────
// Server has zod (see domain/settings.ts mirror); client uses these manual
// guards so the popup can fail-fast on a bad SW push.

const TRANSLATION_STYLES: readonly TranslationStyle[] = ["literal", "natural", "casual"];
const LATENCY_PRESETS:    readonly LatencyPreset[]    = ["snappy", "smooth"];
const CAPTION_POSITIONS:  readonly CaptionPosition[]  = ["top", "bottom", "float"];

/** Validate + sanitize a patch. Drops unknown keys, coerces invalid enum
 *  values to undefined (so the merger keeps the existing value). Returns a
 *  fresh object — never mutates input. */
export function sanitizePatch(input: unknown): AdvancedPatch {
  if (!input || typeof input !== "object") return {};
  const out: AdvancedPatch = {};
  const v = input as Record<string, unknown>;
  if (typeof v.translationStyle === "string" &&
      (TRANSLATION_STYLES as readonly string[]).includes(v.translationStyle)) {
    out.translationStyle = v.translationStyle as TranslationStyle;
  }
  if (typeof v.latencyPreset === "string" &&
      (LATENCY_PRESETS as readonly string[]).includes(v.latencyPreset)) {
    out.latencyPreset = v.latencyPreset as LatencyPreset;
  }
  if (typeof v.captionPosition === "string" &&
      (CAPTION_POSITIONS as readonly string[]).includes(v.captionPosition)) {
    out.captionPosition = v.captionPosition as CaptionPosition;
  }
  if (v.autoStartHosts && typeof v.autoStartHosts === "object" && !Array.isArray(v.autoStartHosts)) {
    const hosts: Record<string, boolean> = {};
    for (const [host, on] of Object.entries(v.autoStartHosts as Record<string, unknown>)) {
      if (typeof on === "boolean" && /^[a-z0-9.-]{1,253}$/i.test(host)) {
        hosts[host.toLowerCase()] = on;
      }
    }
    out.autoStartHosts = hosts;
  }
  if (typeof v.outputDeviceId === "string" && v.outputDeviceId.length <= 256) {
    out.outputDeviceId = v.outputDeviceId;
  }
  if (typeof v.noiseGate === "boolean") {
    out.noiseGate = v.noiseGate;
  }
  return out;
}

/** Shallow-merge a patch over a base; unset fields keep their existing value.
 *  autoStartHosts is also shallow-merged (so a single-host toggle doesn't
 *  clobber other hosts). */
export function mergeAdvanced(base: AdvancedSettings, patch: AdvancedPatch): AdvancedSettings {
  const merged: AdvancedSettings = { ...base, ...patch };
  if (patch.autoStartHosts) {
    merged.autoStartHosts = { ...base.autoStartHosts, ...patch.autoStartHosts };
  }
  return merged;
}

/** Compute effective settings for a given domain: global merged with the
 *  per-site override (if any). The override is a partial — unset fields fall
 *  back to global. domain=null (e.g. chrome:// pages) returns base unchanged. */
export function effectiveAdvanced(
  base: AdvancedSettings,
  overrides: SiteOverrideMap,
  domain: string | null,
): AdvancedSettings {
  if (!domain) return base;
  const ov = overrides[domain];
  if (!ov) return base;
  return mergeAdvanced(base, ov);
}

/** Normalize a hostname for use as a per-site key. Lowercase, strip leading
 *  "www.", strip trailing dot. Empty / invalid returns null. */
export function normalizeDomain(host: string | null | undefined): string | null {
  if (!host || typeof host !== "string") return null;
  let h = host.trim().toLowerCase();
  if (h.startsWith("www.")) h = h.slice(4);
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (!h || !/^[a-z0-9.-]{1,253}$/.test(h)) return null;
  return h;
}
