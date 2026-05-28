// ────────────────────────────────────────────────────────────────────────────
// Overlay DOM template + layout math — byte-identical to legacy/content.js
// (buildOverlay innerHTML at content.js:193-227 + clampLayout/applyLayout at
// content.js:152-186). Kept render-only and pure where possible: the template
// is the exact static literal; the layout helpers compute the inline styles
// that applyLayout writes (left/top/width/height + classes + --ec-target-lines).
//
// The .ec-* classes, data-ec-* hooks, and data-ec-resize values are LOAD-BEARING
// (CSS targets classes; JS queries data-ec-*; drag/resize keys off data-ec-resize)
// — reproduce verbatim.
// ────────────────────────────────────────────────────────────────────────────

/** Persisted overlay layout (localStorage[LAYOUT_KEY]). Verbatim shape from
 *  legacy loadLayout (content.js:139-148). */
export interface Layout {
  left: number | null;
  top: number | null;
  width: number | null;
  height: number | null;
  sideCollapsed: boolean;
}

export const DEFAULT_LAYOUT: Layout = {
  left: null,
  top: null,
  width: null,
  height: null,
  sideCollapsed: false,
};

/** The exact overlay innerHTML the pipeline expects. Byte-identical to
 *  legacy/content.js:193-227. Static literal (no interpolation) — safe to
 *  assign via innerHTML; never interpolate user/provider text here. */
export const OVERLAY_TEMPLATE = `
      <div class="ec-toolbar" data-ec-drag>
        <span class="ec-brand">
          <span class="ec-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
              <path d="M7 9v6M11 6v12M15 8v8M19 11v2"/>
            </svg>
          </span>
          <span class="ec-wordmark">Echoly</span>
          <span class="ec-state" data-ec-status>Ready</span>
        </span>
        <span class="ec-spacer"></span>
        <select class="ec-select" data-ec-language aria-label="Target language"></select>
        <select class="ec-select" data-ec-voice aria-label="Voice"></select>
        <button class="ec-btn" type="button" data-ec-hide>Hide</button>
        <button class="ec-btn ec-btn-primary" type="button" data-ec-stop>Stop</button>
      </div>
      <div class="ec-body">
        <div class="ec-main">
          <div class="ec-target" data-ec-target></div>
        </div>
        <div class="ec-side" data-ec-side>
          <div class="ec-source" data-ec-source hidden></div>
          <div class="ec-history" data-ec-history hidden></div>
        </div>
      </div>
      <span class="ec-resize-edge ec-resize-edge-n" data-ec-resize="n"></span>
      <span class="ec-resize-edge ec-resize-edge-e" data-ec-resize="e"></span>
      <span class="ec-resize-edge ec-resize-edge-s" data-ec-resize="s"></span>
      <span class="ec-resize-edge ec-resize-edge-w" data-ec-resize="w"></span>
      <span class="ec-resize-corner ec-resize-corner-nw" data-ec-resize="nw"></span>
      <span class="ec-resize-corner ec-resize-corner-ne" data-ec-resize="ne"></span>
      <span class="ec-resize-corner ec-resize-corner-sw" data-ec-resize="sw"></span>
      <span class="ec-resize-corner ec-resize-corner-se" data-ec-resize="se"></span>
    `;

/** Clamp a (possibly partial) layout into the viewport. Verbatim from legacy
 *  clampLayout (content.js:152-166): min 300×130, defaults 560×200, bottom-right
 *  with 24px margin, ≥12px from edges. Returns a fully-resolved layout. */
export function clampLayout(
  layout: Layout,
  innerWidth: number,
  innerHeight: number,
): Layout {
  const maxW = Math.max(300, innerWidth - 24);
  const maxH = Math.max(130, innerHeight - 24);
  const w = Math.min(Math.max(layout.width || 560, 300), maxW);
  const h = Math.min(Math.max(layout.height || 200, 130), maxH);
  const left = Math.min(
    Math.max(layout.left ?? innerWidth - w - 24, 12),
    Math.max(12, innerWidth - w - 12),
  );
  const top = Math.min(
    Math.max(layout.top ?? innerHeight - h - 96, 12),
    Math.max(12, innerHeight - h - 12),
  );
  return { ...layout, left, top, width: w, height: h };
}

/** --ec-target-lines value: clamp(2, floor((height-74)/38), 8). Verbatim from
 *  legacy applyLayout (content.js:179-182). */
export function targetLines(height: number): number {
  return Math.max(2, Math.min(8, Math.floor((height - 74) / 38)));
}

/** is-compact threshold (width < 560 || height < 210) — legacy content.js:177. */
export function isCompact(width: number, height: number): boolean {
  return width < 560 || height < 210;
}

/** is-roomy threshold (width > 760 && height > 235) — legacy content.js:178. */
export function isRoomy(width: number, height: number): boolean {
  return width > 760 && height > 235;
}
