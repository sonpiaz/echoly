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

import type { CaptionPosition } from "./advanced";
import type { HistoryTurn, TranslationTier } from "./types";

/** Drives the `data-state` attribute on `.ec-root` (legacy values).
 *  "ad-wait": a YouTube ad is playing; translation is deferred until it ends. */
export type OverlayState = "ready" | "connecting" | "live" | "paused" | "switching" | "buffering" | "error" | "ad-wait";

/** Toast options. A bare number is shorthand for `{ durationMs }` (legacy
 *  showToast accepted either a number or an opts object). `cta`/`ctaLabel`
 *  render a clickable `<a>` (e.g. upgrade link from server error envelope
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
  /** Mix sliders in the expanded panel. */
  onMixChange?(originalVolume: number, voiceVolume: number): void;
  /** Translated subtitles on/off on the video strip (persisted via Settings). */
  onTargetCaptionVisibilityChange?(show: boolean): void;
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
  /** Build + mount the overlay DOM and bind its controls to `callbacks`.
   *  Optional `captionPosition` seeds the layout from the Advanced preset when
   *  nothing is persisted in localStorage[LAYOUT_KEY] (the user's drag wins). */
  buildOverlay(
    callbacks: OverlayCallbacks,
    captionPosition?: CaptionPosition | null,
    pickerLanguages?: readonly import("./constants").LangPair[],
    signedInProxy?: boolean,
    standardVoices?: readonly import("./constants").LangPair[],
    initialTier?: import("./types").TranslationTier,
  ): void;
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
  /** Refresh lang/voice pickers, mix sliders, and caption toggle from the
   *  extension settings snapshot (popup / background → content). */
  syncFromSettings(settings: import("./types").StartSettings): void;
  /** Apply a caption-position preset live (Advanced setting hot-swap). Updates
   *  the in-memory Layout.left/top to the preset's percentage targets, snaps via
   *  clampLayout + applyLayout. Does NOT write LAYOUT_KEY — the user's
   *  subsequent drag still persists and wins on the next session. */
  setCaptionPosition(pos: CaptionPosition): void;
  /** Sync Original/Voice mix sliders (popup → overlay live update). */
  setMixVolumes(originalVolume: number, voiceVolume: number): void;
  /** Show or hide the on-video caption strip (panel toggle + layout persistence). */
  applyCaptionOnVideo(show: boolean): void;
  /** Is the overlay currently mounted? (legacy `root != null`). */
  isMounted(): boolean;
  /** Standard sync readout (lag + matching state); null clears. */
  setDubSyncReadout(
    readout: import("@/lib/dub-playback-sync").DubSyncReadout | null,
  ): void;
  /** Apply custom subtitle styling CSS custom properties to the overlay root.
   *  Values must already be gated by the caller (free tier → defaults). */
  setSubtitleStyle(style: {
    fontSize: import("@/shared/advanced").CaptionFontSize;
    bgOpacity: import("@/shared/advanced").CaptionBgOpacity;
    fontWeight: import("@/shared/advanced").CaptionFontWeight;
  }): void;
}

/** Factory exported by `@/content/overlay`. The content-logic agent imports the
 *  concrete `createOverlay` from there; this type locks its shape. */
export type CreateOverlay = () => OverlayView;
