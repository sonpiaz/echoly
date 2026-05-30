// Per-user advanced settings (server-authoritative, cached in chrome.storage).

export type CaptionPosition = "top" | "bottom" | "float";

export interface AdvancedSettings {
  captionPosition: CaptionPosition;
  /** hostname → auto-start when a watch page loads. */
  autoStartHosts: Record<string, boolean>;
  /** HTMLMediaElement.sinkId; empty = system default. */
  outputDeviceId: string;
}

export const DEFAULT_ADVANCED: AdvancedSettings = {
  captionPosition: "bottom",
  autoStartHosts: {},
  outputDeviceId: "",
};

export type AdvancedPatch = Partial<AdvancedSettings>;
export type SiteOverrideMap = Record<string, AdvancedPatch>;

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
  return out;
}

export function mergeAdvanced(base: AdvancedSettings, patch: AdvancedPatch): AdvancedSettings {
  const merged: AdvancedSettings = { ...base, ...patch };
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
