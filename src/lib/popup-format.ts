// Pure popup reducers — chrome-free, fully unit-tested (Layer A).

import type { AccountTier } from "@/shared/types";
import { canUseRealtime } from "@/shared/tier";

export { capsForTier, capsForUsage, type TierCap } from "@/lib/tier-cap";

/**
 * Format a credits integer with thousands separators (en-US locale).
 * e.g. fmtCredits(4200) → "4,200"
 * Credits are always integers; no decimal display.
 */
export function fmtCredits(n: number): string {
  const v = Math.round(n || 0);
  return v.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

export function meterLevel(used: number, cap: number): "ok" | "warning" | "danger" {
  if (!cap) return "ok";
  const pct = used / cap;
  if (pct >= 1.0) return "danger";
  if (pct >= 0.9) return "warning";
  return "ok";
}

export function fillPercent(used: number, cap: number): number {
  if (!cap) return 0;
  return Math.min(100, (used / cap) * 100);
}

/** Realtime tier requires Max subscription. Delegates to the shared SoT. */
export function allowRealtime(userTier: AccountTier | undefined): boolean {
  return canUseRealtime(userTier);
}

export function tierBadge(
  tier: AccountTier | string | undefined,
): { label: string; dataTier: string } {
  const dataTier = tier || "free";
  const label = tier === "max" ? "Max" : tier === "pro" ? "Pro" : "Free";
  return { label, dataTier };
}

export function nextResetLabel(now: Date = new Date()): string {
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  );
  return next.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

export function resetsAtLabel(resetsAtIso: string | undefined): string {
  if (!resetsAtIso) return nextResetLabel();
  const d = new Date(resetsAtIso);
  if (!Number.isFinite(d.getTime())) return nextResetLabel();
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

/** Whole days until `resetsAt` (UTC ISO). Null when unknown or invalid. */
export function daysUntilReset(
  resetsAtIso: string | undefined,
  now: Date = new Date(),
): number | null {
  if (!resetsAtIso) return null;
  const end = new Date(resetsAtIso);
  if (!Number.isFinite(end.getTime())) return null;
  const ms = end.getTime() - now.getTime();
  if (ms <= 0) return 0;
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

/** Account menu plan line, e.g. "· 18 days left". */
export function daysLeftLabel(
  resetsAtIso: string | undefined,
  now: Date = new Date(),
): string | null {
  const days = daysUntilReset(resetsAtIso, now);
  if (days === null) return null;
  const n = days === 1 ? 1 : days;
  return `· ${n} day${n === 1 ? "" : "s"} left`;
}

/**
 * Format a renewal date ISO string as short-form en-US date with year,
 * e.g. "Jun 4, 2027". Used for annual-plan popup display.
 */
export function renewsAtLabel(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function shade(hex: string, pct: number): string {
  const num = parseInt(hex.replace("#", ""), 16);
  const r = Math.max(0, Math.min(255, (num >> 16) + pct * 2.55));
  const g = Math.max(0, Math.min(255, ((num >> 8) & 0xff) + pct * 2.55));
  const b = Math.max(0, Math.min(255, (num & 0xff) + pct * 2.55));
  return `rgb(${r | 0}, ${g | 0}, ${b | 0})`;
}

export function fmtElapsed(seconds: number): string {
  const s = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
}
