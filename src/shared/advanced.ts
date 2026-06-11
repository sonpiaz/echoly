// Per-user advanced settings (server-authoritative, cached in chrome.storage).
//
// Two-layer model:
//  • LOCAL "Advanced" (3 keys): captionPosition, autoStartHosts, outputDeviceId.
//    Stored in state.advanced; synced via /v1/me/settings global PUT.
//  • SYNCED "Settings" (7 keys): mode, targetLanguage, sourceLanguage,
//    standardVoice, realtimeVoice, showSource, showTargetCaptions.
//    Live in flat Settings (state.tier / targetLanguage / …); synced via the
//    SAME /v1/me/settings bundle (10 keys total).
//
// Site overrides stay restricted to the 3 Advanced keys only.

export type CaptionPosition = "top" | "bottom" | "float";

export type CaptionFontSize = "small" | "medium" | "large" | "xlarge";
export type CaptionBgOpacity = "transparent" | "low" | "medium" | "high";
export type CaptionFontWeight = "normal" | "semibold" | "bold";

export interface AdvancedSettings {
  captionPosition: CaptionPosition;
  /** hostname → auto-start when a watch page loads. */
  autoStartHosts: Record<string, boolean>;
  /** HTMLMediaElement.sinkId; empty = system default. */
  outputDeviceId: string;
  /** Subtitle font size (Pro/Max only; defaults to today's 15px = "medium"). */
  captionFontSize: CaptionFontSize;
  /** Subtitle background opacity (Pro/Max only; defaults to "high" = .82). */
  captionBgOpacity: CaptionBgOpacity;
  /** Subtitle font weight (Pro/Max only; defaults to "semibold" = 600). */
  captionFontWeight: CaptionFontWeight;
}

export const DEFAULT_ADVANCED: AdvancedSettings = {
  captionPosition: "bottom",
  autoStartHosts: {},
  outputDeviceId: "",
  captionFontSize: "medium",
  captionBgOpacity: "high",
  captionFontWeight: "semibold",
};

export type AdvancedPatch = Partial<AdvancedSettings>;
export type SiteOverrideMap = Record<string, AdvancedPatch>;

// ── Server settings bundle (10 keys = 3 Advanced + 7 synced Settings) ─────────

/** The 7 Settings keys that are synced to the server bundle (flat Settings fields). */
export const SYNCED_SETTINGS_KEYS = [
  "mode",
  "targetLanguage",
  "sourceLanguage",
  "standardVoice",
  "realtimeVoice",
  "showSource",
  "showTargetCaptions",
] as const;

export type SyncedSettingsKey = (typeof SYNCED_SETTINGS_KEYS)[number];

/** Full 13-key server bundle shape (as received from GET /v1/me/settings). */
export interface ServerSettingsBundle {
  // 3 Advanced keys
  captionPosition?: CaptionPosition;
  autoStartHosts?: Record<string, boolean>;
  outputDeviceId?: string;
  // 7 synced Settings keys
  mode?: "standard" | "realtime";
  targetLanguage?: string;
  sourceLanguage?: string;
  standardVoice?: string;
  realtimeVoice?: string;
  showSource?: boolean;
  showTargetCaptions?: boolean;
  // 3 subtitle styling keys (W6 / C8)
  captionFontSize?: CaptionFontSize;
  captionBgOpacity?: CaptionBgOpacity;
  captionFontWeight?: CaptionFontWeight;
}

/** Partial bundle sent as PUT patch (any subset of the 13 keys). */
export type ServerSettingsPatch = Partial<ServerSettingsBundle>;

const LANG_RE = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{1,8})*$/;

/**
 * Sanitize a global server patch (10 keys). Used when pushing synced settings
 * edits from the extension. Returns only the valid subset.
 */
export function sanitizeServerPatch(
  input: Record<string, object | string | number | boolean | null> | null,
): ServerSettingsPatch {
  if (!input || typeof input !== "object") return {};
  const out: ServerSettingsPatch = {};

  // 3 Advanced keys (same rules as sanitizePatch)
  const CAPTION_POSITIONS: readonly CaptionPosition[] = ["top", "bottom", "float"];
  if (
    typeof input.captionPosition === "string" &&
    (CAPTION_POSITIONS as readonly string[]).includes(input.captionPosition)
  ) {
    out.captionPosition = input.captionPosition as CaptionPosition;
  }
  if (
    input.autoStartHosts &&
    typeof input.autoStartHosts === "object" &&
    !Array.isArray(input.autoStartHosts)
  ) {
    const hosts: Record<string, boolean> = {};
    for (const [host, on] of Object.entries(
      input.autoStartHosts as Record<string, boolean>,
    )) {
      if (typeof on === "boolean" && /^[a-z0-9.-]{1,253}$/i.test(host)) {
        hosts[host.toLowerCase()] = on;
      }
    }
    out.autoStartHosts = hosts;
  }
  if (typeof input.outputDeviceId === "string" && input.outputDeviceId.length <= 256) {
    out.outputDeviceId = input.outputDeviceId;
  }

  // 7 synced Settings keys
  if (
    typeof input.mode === "string" &&
    (input.mode === "standard" || input.mode === "realtime")
  ) {
    out.mode = input.mode;
  }
  if (
    typeof input.targetLanguage === "string" &&
    input.targetLanguage.length <= 16 &&
    LANG_RE.test(input.targetLanguage)
  ) {
    out.targetLanguage = input.targetLanguage;
  }
  if (
    typeof input.sourceLanguage === "string" &&
    input.sourceLanguage.length <= 16 &&
    (input.sourceLanguage === "auto" || LANG_RE.test(input.sourceLanguage))
  ) {
    out.sourceLanguage = input.sourceLanguage;
  }
  if (typeof input.standardVoice === "string" && input.standardVoice.length <= 128) {
    out.standardVoice = input.standardVoice;
  }
  if (typeof input.realtimeVoice === "string" && input.realtimeVoice.length <= 64) {
    out.realtimeVoice = input.realtimeVoice;
  }
  if (typeof input.showSource === "boolean") {
    out.showSource = input.showSource;
  }
  if (typeof input.showTargetCaptions === "boolean") {
    out.showTargetCaptions = input.showTargetCaptions;
  }

  // 3 subtitle styling keys
  const CAPTION_FONT_SIZES: readonly CaptionFontSize[] = ["small", "medium", "large", "xlarge"];
  const CAPTION_BG_OPACITIES: readonly CaptionBgOpacity[] = ["transparent", "low", "medium", "high"];
  const CAPTION_FONT_WEIGHTS: readonly CaptionFontWeight[] = ["normal", "semibold", "bold"];
  if (
    typeof input.captionFontSize === "string" &&
    (CAPTION_FONT_SIZES as readonly string[]).includes(input.captionFontSize)
  ) {
    out.captionFontSize = input.captionFontSize as CaptionFontSize;
  }
  if (
    typeof input.captionBgOpacity === "string" &&
    (CAPTION_BG_OPACITIES as readonly string[]).includes(input.captionBgOpacity)
  ) {
    out.captionBgOpacity = input.captionBgOpacity as CaptionBgOpacity;
  }
  if (
    typeof input.captionFontWeight === "string" &&
    (CAPTION_FONT_WEIGHTS as readonly string[]).includes(input.captionFontWeight)
  ) {
    out.captionFontWeight = input.captionFontWeight as CaptionFontWeight;
  }

  return out;
}

/**
 * Sanitize a SITE-OVERRIDE patch — restricted to the 3 site-scoped legacy keys
 * (captionPosition / autoStartHosts / outputDeviceId). The 7 synced Settings
 * keys AND the 3 subtitle-style keys are GLOBAL-only and stripped here — the
 * server's siteOverridePatchSchema strict-rejects them with a 400.
 */
export function sanitizeSiteOverridePatch(
  input: Record<string, object | string | number | boolean | null> | null,
): AdvancedPatch {
  const p = sanitizePatch(input);
  const out: AdvancedPatch = {};
  if (p.captionPosition !== undefined) out.captionPosition = p.captionPosition;
  if (p.autoStartHosts !== undefined) out.autoStartHosts = p.autoStartHosts;
  if (p.outputDeviceId !== undefined) out.outputDeviceId = p.outputDeviceId;
  return out;
}

/**
 * Heal a persisted SiteOverrideMap: strip global-only keys (the 3 subtitle-style
 * keys) from every entry and drop entries that become empty. Overrides written
 * by the pre-fix saveSiteDefault (full 6-key snapshot) poisoned storage with
 * pinned style values that mask global style edits via effectiveAdvanced —
 * this is the load-time self-heal.
 */
export function sanitizeSiteOverrideMap(map: unknown): SiteOverrideMap {
  if (!map || typeof map !== "object" || Array.isArray(map)) return {};
  const out: SiteOverrideMap = {};
  for (const [domain, patch] of Object.entries(map as Record<string, unknown>)) {
    if (!patch || typeof patch !== "object") continue;
    const safe = sanitizeSiteOverridePatch(
      patch as Record<string, object | string | number | boolean | null>,
    );
    if (Object.keys(safe).length > 0) out[domain] = safe;
  }
  return out;
}

export interface OverlayPreset {
  left: string;
  top: string;
}

export const CAPTION_PRESETS = {
  top: { left: "50%", top: "8%" },
  bottom: { left: "50%", top: "78%" },
  float: { left: "20%", top: "40%" },
} as const satisfies Record<CaptionPosition, OverlayPreset>;

export type CaptionStripPlacement = "top" | "bottom";

export function captionStripPlacement(preset: CaptionPosition): CaptionStripPlacement {
  return preset === "top" ? "top" : "bottom";
}

const CAPTION_POSITIONS: readonly CaptionPosition[] = ["top", "bottom", "float"];
const CAPTION_FONT_SIZES_LOCAL: readonly CaptionFontSize[] = ["small", "medium", "large", "xlarge"];
const CAPTION_BG_OPACITIES_LOCAL: readonly CaptionBgOpacity[] = ["transparent", "low", "medium", "high"];
const CAPTION_FONT_WEIGHTS_LOCAL: readonly CaptionFontWeight[] = ["normal", "semibold", "bold"];

export function sanitizePatch(
  input: Record<string, object | string | number | boolean | null> | null,
): AdvancedPatch {
  if (!input || typeof input !== "object") return {};
  const out: AdvancedPatch = {};
  const v = input;
  if (
    typeof v.captionPosition === "string" &&
    (CAPTION_POSITIONS as readonly string[]).includes(v.captionPosition)
  ) {
    out.captionPosition = v.captionPosition as CaptionPosition;
  }
  if (v.autoStartHosts && typeof v.autoStartHosts === "object" && !Array.isArray(v.autoStartHosts)) {
    const hosts: Record<string, boolean> = {};
    for (const [host, on] of Object.entries(v.autoStartHosts as Record<string, boolean>)) {
      if (typeof on === "boolean" && /^[a-z0-9.-]{1,253}$/i.test(host)) {
        hosts[host.toLowerCase()] = on;
      }
    }
    out.autoStartHosts = hosts;
  }
  if (typeof v.outputDeviceId === "string" && v.outputDeviceId.length <= 256) {
    out.outputDeviceId = v.outputDeviceId;
  }
  // 3 subtitle styling keys (local AdvancedPatch)
  if (
    typeof v.captionFontSize === "string" &&
    (CAPTION_FONT_SIZES_LOCAL as readonly string[]).includes(v.captionFontSize)
  ) {
    out.captionFontSize = v.captionFontSize as CaptionFontSize;
  }
  if (
    typeof v.captionBgOpacity === "string" &&
    (CAPTION_BG_OPACITIES_LOCAL as readonly string[]).includes(v.captionBgOpacity)
  ) {
    out.captionBgOpacity = v.captionBgOpacity as CaptionBgOpacity;
  }
  if (
    typeof v.captionFontWeight === "string" &&
    (CAPTION_FONT_WEIGHTS_LOCAL as readonly string[]).includes(v.captionFontWeight)
  ) {
    out.captionFontWeight = v.captionFontWeight as CaptionFontWeight;
  }
  return out;
}

export function mergeAdvanced(base: AdvancedSettings, patch: AdvancedPatch): AdvancedSettings {
  const merged: AdvancedSettings = {
    ...base,
    ...patch,
    // always ensure defaults for new style keys
    captionFontSize: patch.captionFontSize ?? base.captionFontSize ?? DEFAULT_ADVANCED.captionFontSize,
    captionBgOpacity: patch.captionBgOpacity ?? base.captionBgOpacity ?? DEFAULT_ADVANCED.captionBgOpacity,
    captionFontWeight: patch.captionFontWeight ?? base.captionFontWeight ?? DEFAULT_ADVANCED.captionFontWeight,
  };
  if (patch.autoStartHosts) {
    merged.autoStartHosts = { ...base.autoStartHosts, ...patch.autoStartHosts };
  }
  return merged;
}

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

export function normalizeDomain(host: string | null | undefined): string | null {
  if (!host || typeof host !== "string") return null;
  let h = host.trim().toLowerCase();
  if (h.startsWith("www.")) h = h.slice(4);
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (!h || !/^[a-z0-9.-]{1,253}$/.test(h)) return null;
  return h;
}
