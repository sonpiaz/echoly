// ────────────────────────────────────────────────────────────────────────────
// Overlay DOM template + layout math — V5 glassmorphic in-page overlay.
// ────────────────────────────────────────────────────────────────────────────

import {
  captionStripPlacement,
  type CaptionPosition,
  type CaptionStripPlacement,
} from "@/shared/advanced";

/** Persisted overlay layout (dock drag offset + drawer + caption strip). */
export interface Layout {
  left: number | null;
  top: number | null;
  width: number | null;
  height: number | null;
  sideCollapsed: boolean;
  /** @deprecated Use panelExpanded — migrated on load. */
  drawerOpen?: boolean;
  /** Expanded control card (design GlassOverlayExpanded). */
  panelExpanded?: boolean;
  captionPlacement: CaptionStripPlacement;
  /** When false, hide the on-video caption strip (translation still in panel). */
  captionOnVideo?: boolean;
  /** Set after user drags the dock/panel; when false, position tracks the video stage. */
  dockUserPlaced?: boolean;
}

export const DEFAULT_LAYOUT: Layout = {
  left: null,
  top: null,
  width: null,
  height: null,
  sideCollapsed: true,
  panelExpanded: false,
  captionPlacement: "bottom",
  captionOnVideo: true,
};

export const PANEL_W = 280;
export const PANEL_H = 320;

export const OVERLAY_TEMPLATE = `
      <div class="ec-dock" data-ec-drag>
        <span class="ec-dock-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
            <path d="M7 9v6M11 6v12M15 8v8M19 11v2"/>
          </svg>
        </span>
        <span class="ec-live-dot" aria-hidden="true"></span>
        <span class="ec-dock-live">Live</span>
        <span class="ec-state" data-ec-status>Ready</span>
        <span class="ec-dock-sync" data-ec-sync-hint hidden aria-live="polite"></span>
        <button class="ec-dock-caption" type="button" data-ec-caption-toggle aria-pressed="true" aria-label="Subtitles on video" title="Subtitles on/off">CC</button>
        <button class="ec-dock-expand" type="button" data-ec-expand aria-label="Expand controls" title="Expand">⋯</button>
        <button class="ec-dock-stop" type="button" data-ec-stop aria-label="Stop translation" title="Stop"></button>
      </div>
      <div class="ec-panel" data-ec-panel hidden>
        <div class="ec-panel-head" data-ec-panel-drag>
          <span class="ec-panel-drag-ico" aria-hidden="true">
            <svg viewBox="0 0 10 14" width="10" height="14" fill="currentColor">
              <circle cx="3" cy="2" r="1"/><circle cx="7" cy="2" r="1"/>
              <circle cx="3" cy="7" r="1"/><circle cx="7" cy="7" r="1"/>
              <circle cx="3" cy="12" r="1"/><circle cx="7" cy="12" r="1"/>
            </svg>
          </span>
          <span class="ec-panel-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
              <path d="M7 9v6M11 6v12M15 8v8M19 11v2"/>
            </svg>
          </span>
          <span class="ec-panel-brand">echoly</span>
          <span class="ec-panel-live"><span class="ec-live-dot" aria-hidden="true"></span>Live</span>
          <div class="ec-panel-head-actions">
            <button type="button" class="ec-panel-collapse" data-ec-collapse aria-label="Collapse" title="Collapse">
              <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round">
                <path d="M5 1V4H2M11 4H8V1M8 11V8H11M2 8H5V11"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="ec-panel-body">
          <div class="ec-panel-voice">
            <span class="ec-panel-voice-avatar" data-ec-voice-avatar aria-hidden="true">M</span>
            <div class="ec-panel-voice-meta">
              <div class="ec-panel-voice-name"><span data-ec-voice-name>Voice</span> <span class="ec-speaking">speaking</span></div>
              <span class="ec-panel-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></span>
            </div>
            <div class="ec-panel-lag ec-lag-empty" data-ec-lag-wrap>
              <span class="ec-lag-line" data-ec-latency>—</span>
              <span class="ec-lag-label">lag</span>
            </div>
          </div>
          <div class="ec-panel-pickers">
            <div class="ec-picker-row">
              <label class="ec-picker-label">Language</label>
              <select class="ec-select" data-ec-language aria-label="Target language"></select>
            </div>
            <div class="ec-picker-row">
              <label class="ec-picker-label">Voice</label>
              <select class="ec-select" data-ec-voice aria-label="Voice"></select>
            </div>
          </div>
          <div class="ec-panel-preview" data-ec-panel-preview aria-live="polite"></div>
          <div class="ec-panel-source" data-ec-source hidden></div>
          <label class="ec-panel-toggle">
            <span>Subtitles on video</span>
            <input type="checkbox" data-ec-caption-visible checked />
          </label>
          <div class="ec-panel-mix">
            <div class="ec-mix-row">
              <label for="ec-original-vol">Original</label>
              <input id="ec-original-vol" type="range" data-ec-original-vol min="0" max="100" value="18" />
              <output data-ec-original-out>18</output>
            </div>
            <div class="ec-mix-row">
              <label for="ec-voice-vol">Voice</label>
              <input id="ec-voice-vol" type="range" data-ec-voice-vol min="0" max="100" value="100" />
              <output data-ec-voice-out>100</output>
            </div>
          </div>
          <div class="ec-panel-foot">
            <span class="ec-panel-elapsed" data-ec-elapsed>00:00</span>
            <button type="button" class="ec-panel-stop" data-ec-stop-panel aria-label="Stop translation">
              <span class="ec-panel-stop-ico" aria-hidden="true"></span> Stop
            </button>
          </div>
        </div>
      </div>
      <div class="ec-caption" data-ec-target></div>
    `;

export function isCompact(_w: number, _h: number): boolean {
  return false;
}

export function isRoomy(_w: number, _h: number): boolean {
  return false;
}

export function targetLines(_height: number): number {
  return 3;
}

export function applyCaptionPositionPreset(
  layout: Layout,
  preset: CaptionPosition,
): Layout {
  return {
    ...layout,
    captionPlacement: captionStripPlacement(preset),
  };
}

export function clampLayout(
  layout: Layout,
  vw: number,
  vh: number,
): Layout & { width: number; height: number } {
  const dockW = 248;
  const dockH = 46;
  const left =
    layout.left == null
      ? null
      : Math.min(Math.max(8, layout.left), vw - dockW - 8);
  const top =
    layout.top == null ? null : Math.min(Math.max(8, layout.top), vh - dockH - 8);
  return {
    ...layout,
    left,
    top,
    width: dockW,
    height: dockH,
  };
}
