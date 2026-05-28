// ────────────────────────────────────────────────────────────────────────────
// LOCKED CONTRACT — the UI↔logic seam. The overlay (UI agent) implements
// OverlayView and is render-only: it binds DOM events and only INVOKES the
// injected OverlayCallbacks — it never reaches into pipeline globals. The
// content-logic agent constructs the OverlayCallbacks (with the exact
// realtime-vs-standard branch) and drives the view via OverlayView.
//
// This decouples the two agents: UI builds byte-identical DOM behind this
// interface; logic codes against the interface without touching the DOM.
// ────────────────────────────────────────────────────────────────────────────

import type { HistoryTurn, TranslationTier } from "./types";

/** Drives the `data-state` attribute on `.ec-root` (legacy values). */
export type OverlayState = "ready" | "connecting" | "live" | "paused" | "error";

/** Toast options. A bare number is shorthand for `{ durationMs }` (legacy
 *  showToast accepted either a number or an opts object). `cta`/`ctaLabel`
 *  render a clickable `<a>` (e.g. the "Top up" billing link from parseKymaError
 *  on insufficient balance) — built via DOM APIs, never innerHTML. */
export interface ToastOptions {
  durationMs?: number;
  cta?: string;
  ctaLabel?: string;
}

/**
 * Intents the overlay dispatches when the user interacts with its controls.
 * The content-logic `controller` implements these with the EXACT legacy branch:
 *   • realtime tier  ⇒ requestHandover(newValue)
 *   • standard tier  ⇒ mutate settings in place + notifyBackground(UPDATE_SETTINGS)
 *                       + setStatusText("Switching to …") + setOverlayState("live")
 * (locked, characterization-tested — preserves BUGS C1/H3 behavior).
 */
export interface OverlayCallbacks {
  /** Target-language `<select>` change (legacy content.js:259). */
  onLanguageChange(lang: string): void;
  /** Voice `<select>` change (legacy content.js:270). */
  onVoiceChange(voiceId: string): void;
  /** Overlay Stop control (legacy content.js:282). */
  onStop(): void;
}

/**
 * Render-only surface the content logic calls. Method names mirror the legacy
 * functions 1:1 so behavior maps directly. Implemented by the UI agent in
 * `@/content/overlay`; consumed by the content-logic agent. Building the DOM
 * must be byte-identical to legacy (imperative DOM on document.documentElement,
 * NO Shadow DOM; toast built via DOM APIs, never innerHTML).
 */
export interface OverlayView {
  /** Build + mount the overlay DOM and bind its controls to `callbacks`. */
  buildOverlay(callbacks: OverlayCallbacks): void;
  /** Remove the overlay DOM (nulls internal root — ordering is load-bearing). */
  removeOverlay(): void;
  setOverlayState(state: OverlayState): void;
  setStatusText(text: string): void;
  /** Current translated text (target). */
  setTargetText(text: string): void;
  /** Current source-caption text. */
  setSourceText(text: string): void;
  applySourceVisibility(show: boolean): void;
  /** Append a finished turn to history (newest-first, capped HISTORY_MAX). */
  pushHistoryTurn(turn: HistoryTurn): void;
  /** Append a marker chip to history (legacy pushHistoryTurn({marker}) —
   *  e.g. "vi → en" on language swap, "Switching voice" on voice change).
   *  Rendered as `.ec-h-marker`/`.ec-h-marker-chip`. */
  pushHistoryMarker(text: string): void;
  /** Transient toast (DOM-API built, NOT innerHTML). `opts` is a duration in ms
   *  or a ToastOptions (with optional CTA link). Default 8000ms. */
  showToast(text: string, opts?: number | ToastOptions): void;
  /** Repopulate the voice `<select>` for the active tier, keeping selection. */
  populateVoicePicker(tier: TranslationTier, selectedVoiceId: string): void;
  /** Sync the target-language `<select>` value to `lang` (legacy
   *  applySettingsLive / post-handover langSelect.value sync). */
  setLanguageSelection(lang: string): void;
  /** Is the overlay currently mounted? (legacy `root != null`). */
  isMounted(): boolean;
}

/** Factory exported by `@/content/overlay`. The content-logic agent imports the
 *  concrete `createOverlay` from there; this type locks its shape. */
export type CreateOverlay = () => OverlayView;
