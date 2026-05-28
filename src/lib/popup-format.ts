// ────────────────────────────────────────────────────────────────────────────
// Pure popup reducers — chrome-free, fully unit-tested (Layer A). Extracted
// verbatim from legacy/popup.js so the rendered numbers/labels/gating stay
// byte-identical. No DOM, no chrome.* — just data → data.
// ────────────────────────────────────────────────────────────────────────────

import { TIER_CAPS, type TierCap } from "@/shared/constants";
import type { AccountTier } from "@/shared/types";

/** Round minutes and format with en-US grouping (legacy/popup.js:132). */
export function fmtMin(n: number): string {
  return Math.round(n || 0).toLocaleString("en-US");
}

/** Usage-fill `data-level` bucket (legacy/popup.js:136).
 *  No cap ⇒ "ok"; ≥1.0 ⇒ "danger"; ≥0.9 ⇒ "warning"; else "ok". */
export function meterLevel(used: number, cap: number): "ok" | "warning" | "danger" {
  if (!cap) return "ok";
  const pct = used / cap;
  if (pct >= 1.0) return "danger";
  if (pct >= 0.9) return "warning";
  return "ok";
}

/** Tier-cap lookup (legacy/popup.js:189-190). Unknown tier ⇒ free. */
export function capsForTier(tier: string | null | undefined): TierCap {
  return TIER_CAPS[tier ?? "free"] ?? TIER_CAPS.free!;
}

/** Fill-bar width %, clamped 0–100 (legacy/popup.js:199, 210).
 *  No cap ⇒ 0% (matches legacy `c.std ? … : 0`). */
export function fillPercent(used: number, cap: number): number {
  if (!cap) return 0;
  return Math.min(100, (used / cap) * 100);
}

/** Is Realtime allowed? BYOK key present OR account tier "max"
 *  (legacy/popup.js:292-293, applyTierGating). */
export function allowRealtime(
  userTier: AccountTier | undefined,
  kymaKey: string,
): boolean {
  const hasByok = !!(kymaKey || "").trim();
  return hasByok || userTier === "max";
}

/** Tier-badge label + data-tier (legacy/popup.js:150 renderTierBadge).
 *  BYOK key ⇒ "BYOK"; else Max/Pro/Free by tier. */
export function tierBadge(
  tier: AccountTier | string | undefined,
  hasKey: boolean,
): { label: string; dataTier: string } {
  if (hasKey) return { label: "BYOK", dataTier: "byok" };
  const dataTier = tier || "free";
  const label = tier === "max" ? "Max" : tier === "pro" ? "Pro" : "Free";
  return { label, dataTier };
}

/** Key-badge state by prefix (legacy/popup.js:119 setKeyBadge).
 *  empty ⇒ "missing"/none; ky|kyma- ⇒ "saved"/ok; else ⇒ "check"/warn. */
export function keyBadge(
  k: string,
): { label: string; cls: "" | "ok" | "warn" } {
  if (!k) return { label: "missing", cls: "" };
  if (k.startsWith("ky") || k.startsWith("kyma-")) {
    return { label: "saved", cls: "ok" };
  }
  return { label: "check", cls: "warn" };
}

/** Next monthly reset label, UTC 1st of next month (legacy/popup.js:144). */
export function nextResetLabel(now: Date = new Date()): string {
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  );
  return next.toLocaleDateString("en-US", { month: "long", day: "numeric" });
}

/** Darken a hex color by `pct` percent (negative ⇒ darker). Ported verbatim
 *  from the design's `echoly-shared.jsx:251`. Used by the popup to render
 *  per-voice gradient avatars; kept here so the math is goldened in tests
 *  (regression risk: a future voice swatch addition flips a sign).
 *  Returns `rgb(r, g, b)` with channels integer-clamped to 0–255. */
export function shade(hex: string, pct: number): string {
  const num = parseInt(hex.replace("#", ""), 16);
  const r = Math.max(0, Math.min(255, (num >> 16) + pct * 2.55));
  const g = Math.max(0, Math.min(255, ((num >> 8) & 0xff) + pct * 2.55));
  const b = Math.max(0, Math.min(255, (num & 0xff) + pct * 2.55));
  return `rgb(${r | 0}, ${g | 0}, ${b | 0})`;
}

/** Format seconds as `mm:ss` (or `h:mm:ss` over an hour). Used by the popup's
 *  elapsed counter. Negative and NaN inputs collapse to `00:00`. */
export function fmtElapsed(seconds: number): string {
  const s = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
}
