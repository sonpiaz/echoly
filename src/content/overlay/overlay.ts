// ────────────────────────────────────────────────────────────────────────────
// Echoly in-page overlay — render-only view (implements OverlayView). Ported
// from the overlay-DOM parts of legacy/content.js (buildOverlay, applyLayout,
// drag/resize, showToast, history, populateVoicePicker, source-caption display,
// setOverlayState/setStatusText/setTargetText). NO Shadow DOM: imperative DOM
// appended to document.documentElement, manifest-injected plain CSS.
//
// RENDER-ONLY SEAM (locked, src/shared/ports.ts): buildOverlay binds the
// <select>/Stop DOM events and ONLY invokes the injected OverlayCallbacks
// (onLanguageChange/onVoiceChange/onStop). The realtime-vs-standard branch lives
// in the content-logic controller (Agent D) — this module never reaches into
// pipeline globals. Hide toggle + drag/resize + layout persistence are pure UI
// and stay here.
//
// Toast is built via DOM APIs (NEVER innerHTML) — text may be a provider error
// body, so innerHTML would be an XSS vector inside youtube.com's origin.
// ────────────────────────────────────────────────────────────────────────────

import { offlineLanguagePicker } from "@/lib/offline-language-bootstrap";
import {
  DEFAULT_TRANSLATION_TIER,
  HISTORY_MAX,
  LAYOUT_KEY,
  RTL_LANGS,
  STANDARD_DEFAULT_VOICE,
  TIER_REALTIME,
  TIER_STANDARD,
  type LangPair,
  type TranslationTier,
} from "@/shared/constants";
import { offlineStandardVoices } from "@/lib/offline-voice-bootstrap";
import type {
  CreateOverlay,
  OverlayCallbacks,
  OverlayState,
  OverlayView,
  ToastOptions,
} from "@/shared/ports";
import type { HistoryTurn, StartSettings } from "@/shared/types";
import type { CaptionPosition } from "@/shared/advanced";
import { fmtElapsed } from "@/lib/popup-format";
import {
  applyCaptionPositionPreset,
  clampLayout,
  DEFAULT_LAYOUT,
  OVERLAY_TEMPLATE,
  PANEL_H,
  PANEL_W,
  type Layout,
} from "./template";
import {
  captionAnchorStyles,
  clampDockToStage,
  defaultDockPosition,
  watchMediaStage,
  type MediaStageSnapshot,
} from "../media-stage";

/** Internal cached element refs (legacy `elements` map, content.js:230-240). */
interface Elements {
  status: HTMLElement | null;
  langSelect: HTMLSelectElement | null;
  voiceSelect: HTMLSelectElement | null;
  target: HTMLElement | null;
  /** Positioned wrapper holding the on-video source + target rows. */
  captionStack: HTMLElement | null;
  /** On-video original-language row (gated by showSource). */
  capSrcRow: HTMLElement | null;
  capSrcText: HTMLElement | null;
  panelPreview: HTMLElement | null;
  source: HTMLElement | null;
  history: HTMLElement | null;
  stopBtn: HTMLButtonElement | null;
  stopPanelBtn: HTMLButtonElement | null;
  expandBtn: HTMLButtonElement | null;
  collapseBtn: HTMLButtonElement | null;
  panel: HTMLElement | null;
  captionVisible: HTMLInputElement | null;
  captionToggle: HTMLButtonElement | null;
  originalVol: HTMLInputElement | null;
  voiceVol: HTMLInputElement | null;
  originalOut: HTMLOutputElement | null;
  voiceOut: HTMLOutputElement | null;
  voiceName: HTMLElement | null;
  voiceAvatar: HTMLElement | null;
  elapsed: HTMLElement | null;
  lagLine: HTMLElement | null;
  lagLabel: HTMLElement | null;
  lagWrap: HTMLElement | null;
  syncHint: HTMLElement | null;
  drag: HTMLElement | null;
  panelDrag: HTMLElement | null;
}

/** A rendered history entry (extends the contract HistoryTurn with the legacy
 *  render fields the overlay computes itself: time + optional marker chip). */
interface RenderedTurn extends HistoryTurn {
  time: string;
  marker: string | null;
}

interface PointerOrigin {
  x: number;
  y: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

function emptyElements(): Elements {
  return {
    status: null,
    langSelect: null,
    voiceSelect: null,
    target: null,
    captionStack: null,
    capSrcRow: null,
    capSrcText: null,
    panelPreview: null,
    source: null,
    history: null,
    stopBtn: null,
    stopPanelBtn: null,
    expandBtn: null,
    collapseBtn: null,
    panel: null,
    captionVisible: null,
    captionToggle: null,
    originalVol: null,
    voiceVol: null,
    originalOut: null,
    voiceOut: null,
    voiceName: null,
    voiceAvatar: null,
    elapsed: null,
    lagLine: null,
    lagLabel: null,
    lagWrap: null,
    syncHint: null,
    drag: null,
    panelDrag: null,
  };
}

function setSliderFill(input: HTMLInputElement): void {
  const min = Number(input.min || "0");
  const max = Number(input.max || "100");
  const val = Number(input.value || "0");
  const pct = max === min ? 0 : ((val - min) / (max - min)) * 100;
  input.style.setProperty("--v", `${pct}%`);
}

/** Remove every overlay root in the page (handles orphaned DOM after reinject). */
export function purgeEcholyOverlayRoots(): void {
  document.querySelectorAll(".ec-root").forEach((el) => el.remove());
}

export const createOverlay: CreateOverlay = (): OverlayView => {
  let root: HTMLElement | null = null;
  let elements: Elements = emptyElements();
  let layout: Layout = loadLayout(null);
  let history: RenderedTurn[] = [];
  let currentTargetText = "";
  let currentSourceText = "";
  let lastRenderedCaption = "";
  // Whether the on-video original-language row may show (mirrors showSource).
  let sourceOnVideo = false;
  // Active tier + selected voice/language — the view tracks just enough to
  // re-render the voice picker and apply RTL on target text. These mirror the
  // legacy `settings?.tier`/`settings?.targetLanguage` reads inside the overlay.
  let activeTier: TranslationTier = DEFAULT_TRANSLATION_TIER;
  let selectedLanguage = "vi";
  let selectedRealtimeVoice = "marin";
  let selectedStandardVoice = STANDARD_DEFAULT_VOICE;
  let standardVoiceOptions: readonly LangPair[] = offlineStandardVoices();
  let stageSnapshot: MediaStageSnapshot | null = null;
  let unwatchStage: (() => void) | null = null;
  let elapsedInterval: ReturnType<typeof setInterval> | null = null;
  let sessionStartedAt: number | null = null;
  let overlayCallbacks: OverlayCallbacks | null = null;
  let signedInProxyMode = false;
  let lastSyncSettings: StartSettings | null = null;

  const DOCK_W = 248;
  const DOCK_H = 46;

  // Keep a stable bound reference so removeOverlay can unbind the window listener.
  const onWindowResize = () => applyLayout();

  /** Load persisted Layout, optionally seeding from the Advanced caption-position
   *  preset when nothing is persisted. The user's drag still wins — localStorage
   *  takes precedence over the preset. (Caption-position Advanced setting.) */
  function loadLayout(captionPosition: CaptionPosition | null): Layout {
    let stored: Partial<Layout> = {};
    let hasStored = false;
    try {
      const raw = localStorage.getItem(LAYOUT_KEY);
      if (raw && raw !== "{}") {
        stored = JSON.parse(raw) as Partial<Layout>;
        hasStored = true;
      }
    } catch {
      /* localStorage may throw on access — fall through to defaults */
    }
    if (hasStored) {
      return {
        ...DEFAULT_LAYOUT,
        ...stored,
        panelExpanded:
          stored.panelExpanded ??
          stored.drawerOpen ??
          DEFAULT_LAYOUT.panelExpanded,
        captionPlacement:
          stored.captionPlacement ?? DEFAULT_LAYOUT.captionPlacement,
        captionOnVideo:
          stored.captionOnVideo ?? DEFAULT_LAYOUT.captionOnVideo,
      };
    }
    if (captionPosition) {
      return applyCaptionPositionPreset({ ...DEFAULT_LAYOUT }, captionPosition);
    }
    return { ...DEFAULT_LAYOUT };
  }
  function saveLayout(): void {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {
      /* localStorage may be unavailable — ignore (legacy behavior) */
    }
  }

  /** Side pane only when source captions and/or history have content. */
  function sidePanelHasContent(): boolean {
    const sourceOn =
      !!elements.source &&
      !elements.source.hidden &&
      currentSourceText.trim().length > 0;
    return sourceOn || history.length > 0;
  }

  function anchorChrome(
    el: HTMLElement | null,
    w: number,
    h: number,
  ): void {
    if (!el) return;
    if (!stageSnapshot) {
      const left = layout.left ?? Math.max(8, window.innerWidth - w - 12);
      const top = layout.top ?? 12;
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      el.style.right = "auto";
      return;
    }
    const def = defaultDockPosition(stageSnapshot, w, h);
    if (layout.dockUserPlaced && layout.left != null && layout.top != null) {
      const r = stageSnapshot.rect;
      const outside =
        layout.left < r.left - 48 ||
        layout.left > r.right + 48 ||
        layout.top < r.top - 48 ||
        layout.top > r.bottom + 48;
      if (outside) {
        layout.dockUserPlaced = false;
        layout.left = null;
        layout.top = null;
      }
    }
    const trackVideo = layout.dockUserPlaced !== true;
    const rawLeft = trackVideo ? def.left : (layout.left ?? def.left);
    const rawTop = trackVideo ? def.top : (layout.top ?? def.top);
    const clamped = clampDockToStage(rawLeft, rawTop, stageSnapshot, w, h);
    if (trackVideo) {
      layout.left = clamped.left;
      layout.top = clamped.top;
    }
    el.style.left = `${clamped.left}px`;
    el.style.top = `${clamped.top}px`;
    el.style.right = "auto";
  }

  function applyStageAnchors(): void {
    if (!root) return;
    // Position the whole bilingual stack; the target text element scrolls
    // within its own row, so anchoring/sizing belongs on the wrapper.
    const caption = elements.captionStack;
    const dock = root.querySelector<HTMLElement>(".ec-dock");
    if (!stageSnapshot) {
      root.removeAttribute("data-stage");
      if (caption) {
        caption.style.left = "";
        caption.style.right = "";
        caption.style.top = "";
        caption.style.bottom = "";
        caption.style.transform = "";
        caption.style.maxWidth = "";
      }
      anchorChrome(dock, DOCK_W, DOCK_H);
      anchorChrome(elements.panel, PANEL_W, PANEL_H);
      return;
    }
    root.dataset.stage = "anchored";
    if (caption) {
      Object.assign(
        caption.style,
        captionAnchorStyles(stageSnapshot, layout.captionPlacement),
      );
    }
    anchorChrome(dock, DOCK_W, DOCK_H);
    anchorChrome(elements.panel, PANEL_W, PANEL_H);
  }

  function applyLayout(): void {
    if (!root) return;
    layout = clampLayout(layout, window.innerWidth, window.innerHeight);
    const expanded = !!layout.panelExpanded;
    if (elements.panel) elements.panel.hidden = !expanded;
    root.classList.toggle("ec-panel-open", expanded);
    syncCaptionToggleUi();
    root.classList.toggle("ec-caption-top", layout.captionPlacement === "top");
    applyStageAnchors();
  }

  function paintElapsed(): void {
    if (!elements.elapsed) return;
    if (sessionStartedAt == null) {
      elements.elapsed.textContent = "00:00";
      return;
    }
    const sec = Math.floor((Date.now() - sessionStartedAt) / 1000);
    elements.elapsed.textContent = fmtElapsed(sec);
  }

  function startElapsedTimer(): void {
    paintElapsed();
    if (elapsedInterval) return;
    elapsedInterval = setInterval(paintElapsed, 1000);
  }

  function stopElapsedTimer(): void {
    if (elapsedInterval) {
      clearInterval(elapsedInterval);
      elapsedInterval = null;
    }
    sessionStartedAt = null;
    paintElapsed();
  }

  function applyCaptionOnVideoState(on: boolean): void {
    layout.captionOnVideo = on;
    saveLayout();
    syncCaptionToggleUi();
  }

  function emitCaptionOnVideo(on: boolean): void {
    applyCaptionOnVideoState(on);
    overlayCallbacks?.onTargetCaptionVisibilityChange?.(on);
  }

  function syncCaptionToggleUi(): void {
    const on = layout.captionOnVideo !== false;
    if (elements.captionVisible) elements.captionVisible.checked = on;
    if (elements.captionToggle) elements.captionToggle.setAttribute("aria-pressed", on ? "true" : "false");
    if (root) root.classList.toggle("ec-caption-off", !on);
  }

  function syncVoiceChrome(): void {
    const name =
      elements.voiceSelect?.selectedOptions[0]?.textContent?.split("·")[0]?.trim() ||
      "Voice";
    const initial = (name[0] || "·").toUpperCase();
    if (elements.voiceName) elements.voiceName.textContent = name;
    if (elements.voiceAvatar) elements.voiceAvatar.textContent = initial;
  }

  /** Pixels from the bottom edge that still count as "following live". */
  const CAPTION_PIN_PX = 14;

  interface CaptionFollowSlot {
    userReadingBack: boolean;
    onScroll: () => void;
  }

  const captionFollowByEl = new WeakMap<HTMLElement, CaptionFollowSlot>();

  function captionMaxScroll(el: HTMLElement): number {
    return Math.max(0, el.scrollHeight - el.clientHeight);
  }

  function isCaptionAtBottom(el: HTMLElement): boolean {
    return captionMaxScroll(el) - el.scrollTop <= CAPTION_PIN_PX;
  }

  /** Track manual scroll-up so we do not yank the viewport while reading back. */
  function bindCaptionFollow(el: HTMLElement): void {
    if (captionFollowByEl.has(el)) return;
    const onScroll = (): void => {
      const slot = captionFollowByEl.get(el);
      if (!slot) return;
      slot.userReadingBack = !isCaptionAtBottom(el);
    };
    captionFollowByEl.set(el, { userReadingBack: false, onScroll });
    el.addEventListener("scroll", onScroll, { passive: true });
  }

  function unbindCaptionFollow(el: HTMLElement | null): void {
    if (!el) return;
    const slot = captionFollowByEl.get(el);
    if (!slot) return;
    el.removeEventListener("scroll", slot.onScroll);
    captionFollowByEl.delete(el);
  }

  /** Scroll to the newest subtitle line (double rAF so layout is settled). */
  function scrollCaptionToLatest(
    el: HTMLElement,
    opts?: { force?: boolean },
  ): void {
    bindCaptionFollow(el);
    const slot = captionFollowByEl.get(el)!;
    const force = opts?.force === true;
    const run = (): void => {
      if (!force && slot.userReadingBack) return;
      const max = captionMaxScroll(el);
      el.scrollTop = max;
      if (max <= 0 || isCaptionAtBottom(el)) slot.userReadingBack = false;
    };
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => requestAnimationFrame(run));
    } else {
      run();
    }
  }

  function resetCaptionScroll(el: HTMLElement | null): void {
    if (!el) return;
    const slot = captionFollowByEl.get(el);
    if (slot) slot.userReadingBack = false;
    el.scrollTop = 0;
  }

  function paintTargetPane(): void {
    if (!elements.target) return;
    const dir = RTL_LANGS.has(selectedLanguage) ? "rtl" : "ltr";
    elements.target.dir = dir;
    if (currentTargetText.trim()) {
      const prev = lastRenderedCaption;
      const next = currentTargetText;
      const newUtterance =
        !!prev.trim() &&
        !next.startsWith(prev) &&
        !prev.startsWith(next);
      elements.target.textContent = next;
      if (elements.panelPreview) {
        elements.panelPreview.dir = dir;
        elements.panelPreview.textContent = next;
      }
      elements.target.classList.remove("ec-target--placeholder");
      elements.target.classList.add("ec-caption--rolling");
      const followOpts = { force: newUtterance };
      scrollCaptionToLatest(elements.target, followOpts);
      if (elements.panelPreview) {
        scrollCaptionToLatest(elements.panelPreview, followOpts);
      }
      lastRenderedCaption = next;
    } else {
      const hint =
        elements.status?.textContent?.trim() || "Preparing translation…";
      elements.target.textContent = hint;
      if (elements.panelPreview) elements.panelPreview.textContent = "";
      elements.target.classList.remove("ec-caption--rolling");
      elements.target.classList.add("ec-target--placeholder");
      resetCaptionScroll(elements.target);
      resetCaptionScroll(elements.panelPreview);
      lastRenderedCaption = "";
    }
  }

  function setSelectValue(
    sel: HTMLSelectElement,
    want: string | undefined,
    fallback: string,
  ): void {
    const target = want ?? fallback;
    if (Array.from(sel.options).some((o) => o.value === target)) {
      sel.value = target;
    } else {
      sel.selectedIndex = 0;
    }
  }

  function repopulateLanguagePicker(list: readonly LangPair[]): void {
    if (!elements.langSelect || !list.length) return;
    const prev = elements.langSelect.value;
    elements.langSelect.replaceChildren();
    for (const [code, name] of list) {
      const opt = document.createElement("option");
      opt.value = code;
      opt.textContent = name;
      elements.langSelect.appendChild(opt);
    }
    setSelectValue(elements.langSelect, prev, list[0]![0]);
    selectedLanguage = elements.langSelect.value;
  }

  // Realtime: Auto only (server ignores voice; language drives output).
  // Standard: voice list from bootstrap / GET /v1/config/voices.
  function populateVoicePicker(
    tier: TranslationTier,
    selectedVoiceId?: string,
    signedInProxy?: boolean,
  ): void {
    if (!elements.voiceSelect) return;
    const proxy = signedInProxy ?? signedInProxyMode;
    elements.voiceSelect.replaceChildren();
    if (tier === TIER_STANDARD) {
      for (const [id, name] of standardVoiceOptions) {
        const opt = document.createElement("option");
        opt.value = id;
        opt.textContent = name;
        elements.voiceSelect.appendChild(opt);
      }
      const want =
        selectedVoiceId ?? selectedStandardVoice ?? STANDARD_DEFAULT_VOICE;
      setSelectValue(elements.voiceSelect, want, STANDARD_DEFAULT_VOICE);
      selectedStandardVoice = elements.voiceSelect.value;
      syncVoiceChrome();
    } else {
      const autoOpt = document.createElement("option");
      autoOpt.value = "";
      autoOpt.textContent = "Auto";
      elements.voiceSelect.appendChild(autoOpt);
      const want = selectedVoiceId ?? selectedRealtimeVoice ?? "";
      setSelectValue(elements.voiceSelect, want, "");
      selectedRealtimeVoice = elements.voiceSelect.value;
      syncVoiceChrome();
    }
  }

  function syncFromSettings(settings: StartSettings): void {
    if (!root) return;
    lastSyncSettings = settings;
    if (settings.tier) activeTier = settings.tier;
    signedInProxyMode = settings.apiMode === "proxy";
    if (settings.languagePicker?.length) {
      repopulateLanguagePicker(settings.languagePicker);
    }
    if (settings.standardVoices?.length) {
      standardVoiceOptions = settings.standardVoices.map((v) => [
        v.id,
        v.label,
      ]);
    }
    if (settings.targetLanguage) {
      setLanguageSelection(settings.targetLanguage);
    }
    const tier = activeTier;
    const voiceId =
      tier === TIER_STANDARD
        ? settings.standardVoice
        : "";
    populateVoicePicker(tier, voiceId, signedInProxyMode);
    setMixVolumes(
      settings.originalVolume ?? 18,
      settings.voiceVolume ?? 100,
    );
    applyCaptionOnVideoState(settings.showTargetCaptions !== false);
    paintTargetPane();
  }

  function buildOverlay(
    callbacks: OverlayCallbacks,
    captionPosition?: CaptionPosition | null,
    pickerLanguages?: readonly LangPair[],
    signedInProxy?: boolean,
    standardVoices?: readonly LangPair[],
    initialTier?: TranslationTier,
  ): void {
    if (initialTier) activeTier = initialTier;
    if (standardVoices?.length) standardVoiceOptions = standardVoices;
    signedInProxyMode = !!signedInProxy;
    overlayCallbacks = callbacks;
    if (root) return;
    // Re-seed the layout from the Advanced caption-position preset (only when
    // nothing persisted yet). This is the right moment — by buildOverlay time,
    // the SW has merged effective Advanced into StartSettings.advanced and the
    // controller passes it through. (No-op when the user has already dragged.)
    layout = loadLayout(captionPosition ?? null);
    root = document.createElement("aside");
    root.className = "ec-root";
    root.dataset.state = "ready";
    root.innerHTML = OVERLAY_TEMPLATE;
    // Prefer body — YouTube's html layer can interact badly with fixed UI.
    (document.body ?? document.documentElement).appendChild(root);

    elements = {
      status: root.querySelector("[data-ec-status]"),
      langSelect: root.querySelector("[data-ec-language]"),
      voiceSelect: root.querySelector("[data-ec-voice]"),
      target: root.querySelector("[data-ec-target]"),
      captionStack: root.querySelector("[data-ec-cap-stack]"),
      capSrcRow: root.querySelector("[data-ec-cap-src]"),
      capSrcText: root.querySelector("[data-ec-cap-src-text]"),
      panelPreview: root.querySelector("[data-ec-panel-preview]"),
      source: root.querySelector("[data-ec-source]"),
      history: null,
      stopBtn: root.querySelector("[data-ec-stop]"),
      stopPanelBtn: root.querySelector("[data-ec-stop-panel]"),
      expandBtn: root.querySelector("[data-ec-expand]"),
      collapseBtn: root.querySelector("[data-ec-collapse]"),
      panel: root.querySelector("[data-ec-panel]"),
      captionVisible: root.querySelector("[data-ec-caption-visible]"),
      captionToggle: root.querySelector("[data-ec-caption-toggle]"),
      originalVol: root.querySelector("[data-ec-original-vol]"),
      voiceVol: root.querySelector("[data-ec-voice-vol]"),
      originalOut: root.querySelector("[data-ec-original-out]"),
      voiceOut: root.querySelector("[data-ec-voice-out]"),
      voiceName: root.querySelector("[data-ec-voice-name]"),
      voiceAvatar: root.querySelector("[data-ec-voice-avatar]"),
      elapsed: root.querySelector("[data-ec-elapsed]"),
      lagLine: root.querySelector("[data-ec-latency]"),
      lagLabel: root.querySelector(".ec-lag-label"),
      lagWrap: root.querySelector("[data-ec-lag-wrap]"),
      syncHint: root.querySelector("[data-ec-sync-hint]"),
      drag: root.querySelector("[data-ec-drag]"),
      panelDrag: root.querySelector("[data-ec-panel-drag]"),
    };

    const langOptions = pickerLanguages?.length
      ? pickerLanguages
      : offlineLanguagePicker();
    if (elements.langSelect) {
      for (const [code, name] of langOptions) {
        const opt = document.createElement("option");
        opt.value = code;
        opt.textContent = name;
        elements.langSelect.appendChild(opt);
      }
    }

    populateVoicePicker(activeTier, undefined, signedInProxy);
    if (elements.langSelect) elements.langSelect.value = selectedLanguage;
    syncVoiceChrome();

    const bindMix = (input: HTMLInputElement | null, out: HTMLOutputElement | null) => {
      if (!input) return;
      const emit = (): void => {
        if (out) out.textContent = input.value;
        setSliderFill(input);
        const orig = Number(elements.originalVol?.value ?? 18);
        const voice = Number(elements.voiceVol?.value ?? 100);
        callbacks.onMixChange?.(orig, voice);
      };
      input.addEventListener("input", emit);
      setSliderFill(input);
    };
    bindMix(elements.originalVol, elements.originalOut);
    bindMix(elements.voiceVol, elements.voiceOut);

    // ── Render-only event seam ──
    // The overlay binds the DOM events; it ONLY invokes the injected callbacks.
    // The realtime-vs-standard decision (requestHandover vs UPDATE_SETTINGS)
    // lives in the content-logic controller, behind onLanguageChange/onVoiceChange.
    elements.langSelect?.addEventListener("change", () => {
      const newLang = elements.langSelect!.value;
      selectedLanguage = newLang;
      callbacks.onLanguageChange(newLang);
    });
    elements.voiceSelect?.addEventListener("change", () => {
      const newVoice = elements.voiceSelect!.value;
      if (activeTier === TIER_STANDARD) selectedStandardVoice = newVoice;
      else selectedRealtimeVoice = newVoice;
      syncVoiceChrome();
      callbacks.onVoiceChange(newVoice);
    });
    elements.expandBtn?.addEventListener("click", () => {
      layout.panelExpanded = true;
      saveLayout();
      applyLayout();
      if (lastSyncSettings) syncFromSettings(lastSyncSettings);
      if (elements.panelPreview?.textContent.trim()) {
        scrollCaptionToLatest(elements.panelPreview, { force: true });
      }
    });
    elements.collapseBtn?.addEventListener("click", () => {
      layout.panelExpanded = false;
      saveLayout();
      applyLayout();
    });
    elements.captionVisible?.addEventListener("change", () => {
      emitCaptionOnVideo(elements.captionVisible!.checked);
    });
    elements.captionToggle?.addEventListener("click", () => {
      emitCaptionOnVideo(layout.captionOnVideo === false);
    });
    const onStop = (): void => {
      stopElapsedTimer();
      callbacks.onStop();
    };
    elements.stopBtn?.addEventListener("click", onStop);
    elements.stopPanelBtn?.addEventListener("click", onStop);

    if (elements.target) bindCaptionFollow(elements.target);
    if (elements.panelPreview) bindCaptionFollow(elements.panelPreview);

    bindDragResize(elements.drag);
    bindDragResize(elements.panelDrag);
    unwatchStage = watchMediaStage((snapshot) => {
      stageSnapshot = snapshot;
      applyLayout();
    });
    applyLayout();
    paintTargetPane();

    window.addEventListener("resize", onWindowResize);
  }

  function removeOverlay(): void {
    stopElapsedTimer();
    if (root) {
      unbindCaptionFollow(elements.target);
      unbindCaptionFollow(elements.panelPreview);
      unwatchStage?.();
      unwatchStage = null;
      stageSnapshot = null;
      window.removeEventListener("resize", onWindowResize);
      root.remove();
      root = null;
    }
    purgeEcholyOverlayRoots();
    elements = emptyElements();
    overlayCallbacks = null;
    lastRenderedCaption = "";
  }

  // ───── Drag + resize (legacy bindDragResize, content.js:363-418) ─────
  function bindDragResize(handle: HTMLElement | null): void {
    if (!root || !handle) return;
    let dragging = false;
    let pointer: PointerOrigin | null = null;

    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if ((e.target as Element).closest("button, select, input, label")) return;
      dragging = true;
      pointer = capturePointer(e, handle);
      handle.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    });

    handle.addEventListener("pointermove", (e) => {
      if (!dragging || !pointer) return;
      layout.left = pointer.left + (e.clientX - pointer.x);
      layout.top = pointer.top + (e.clientY - pointer.y);
      applyLayout();
    });

    const endDrag = (): void => {
      if (dragging) {
        layout.dockUserPlaced = true;
        saveLayout();
      }
      dragging = false;
      pointer = null;
    };
    handle.addEventListener("pointerup", endDrag);
    handle.addEventListener("pointercancel", endDrag);
  }

  function capturePointer(e: PointerEvent, handle: HTMLElement): PointerOrigin {
    const dock = handle;
    const rect = dock.getBoundingClientRect();
    return {
      x: e.clientX,
      y: e.clientY,
      left: layout.left ?? rect.left,
      top: layout.top ?? rect.top,
      width: layout.width ?? rect.width,
      height: layout.height ?? rect.height,
    };
  }

  // ───── State / text setters (legacy content.js:318-329) ─────
  function setOverlayState(state: OverlayState): void {
    if (root) root.dataset.state = state;
    if (state === "live" || state === "connecting" || state === "switching") {
      // "switching" is a brief in-session transition — the clock keeps running
      // (the session is still alive; only "paused" freezes it).
      if (sessionStartedAt == null) sessionStartedAt = Date.now();
      startElapsedTimer();
    } else if (state === "ready" || state === "error" || state === "paused") {
      // "paused" must stop the running clock so the overlay doesn't look live.
      stopElapsedTimer();
    }
  }

  function setMixVolumes(originalVolume: number, voiceVolume: number): void {
    if (elements.originalVol) {
      elements.originalVol.value = String(originalVolume);
      if (elements.originalOut) elements.originalOut.textContent = String(originalVolume);
      setSliderFill(elements.originalVol);
    }
    if (elements.voiceVol) {
      elements.voiceVol.value = String(voiceVolume);
      if (elements.voiceOut) elements.voiceOut.textContent = String(voiceVolume);
      setSliderFill(elements.voiceVol);
    }
  }

  function applyCaptionOnVideo(show: boolean): void {
    applyCaptionOnVideoState(show);
  }
  function setStatusText(text: string): void {
    if (elements.status) elements.status.textContent = text;
    if (!currentTargetText.trim()) paintTargetPane();
  }
  function setTargetText(text: string): void {
    if (!elements.target) return;
    currentTargetText = text;
    paintTargetPane();
  }
  function setSourceText(text: string): void {
    currentSourceText = text;
    const trimmed = text.slice(-220);
    if (elements.source) elements.source.textContent = trimmed;
    if (elements.capSrcText) elements.capSrcText.textContent = trimmed;
    syncSourceRow();
  }
  function applySourceVisibility(show: boolean): void {
    sourceOnVideo = show;
    if (elements.source) elements.source.hidden = !show;
    syncSourceRow();
  }
  // The on-video original-language row shows only when the user has enabled
  // "show original" (showSource) AND there is source text to display. Driven by
  // the same flag as the panel source, so the CC/source controls stay in sync.
  function syncSourceRow(): void {
    if (elements.capSrcRow) {
      const visible = sourceOnVideo && currentSourceText.trim().length > 0;
      elements.capSrcRow.hidden = !visible;
    }
    applyLayout();
  }
  // Sync the target-language <select> value (legacy applySettingsLive
  // content.js:2325-2326 + post-handover sync content.js:953). No-op if not
  // mounted. Tracks selectedLanguage so subsequent setTargetText applies the
  // correct RTL/LTR direction.
  function setLanguageSelection(lang: string): void {
    selectedLanguage = lang;
    if (elements.langSelect) elements.langSelect.value = lang;
  }

  /** Apply a caption-position preset live (Advanced setting hot-swap). Writes
   *  the preset's left/top into the in-memory Layout + re-applies — does NOT
   *  call saveLayout, so the user's subsequent drag still wins on the next
   *  session via the LAYOUT_KEY persistence path. Safe to call when unmounted. */
  function setCaptionPosition(pos: CaptionPosition): void {
    layout = applyCaptionPositionPreset(layout, pos);
    if (root) applyLayout();
  }

  // Toast — built via DOM APIs (NEVER innerHTML). Default 8000ms; replaces any
  // existing toast; auto-removes. (legacy showToast, content.js:333-353.)
  function showToast(text: string, opts?: number | ToastOptions): void {
    if (!root) return;
    const o: ToastOptions =
      typeof opts === "number" ? { durationMs: opts } : (opts ?? {});
    const ms = o.durationMs ?? 8000;
    let toast = root.querySelector(".ec-toast");
    if (toast) toast.remove();
    toast = document.createElement("div");
    toast.className = "ec-toast";
    toast.textContent = String(text || "");
    // Optional CTA link (e.g. "Top up" on insufficient balance). DOM APIs only —
    // the text/href may originate from a provider error body (XSS guard).
    if (o.cta) {
      toast.append(" ");
      const a = document.createElement("a");
      a.href = String(o.cta);
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = String(o.ctaLabel || "Open");
      toast.appendChild(a);
    }
    root.appendChild(toast);
    setTimeout(() => toast!.remove(), ms);
  }

  // ───── History (legacy pushHistoryTurn/renderHistory, content.js:431-475) ──
  // Shared entry-builder — verbatim from legacy pushHistoryTurn(opts): flushes
  // the current in-progress turn (currentTargetText/currentSourceText) into a
  // history entry, optionally with a marker chip. Skips when there is neither a
  // turn nor a marker. Newest-first, capped HISTORY_MAX; clears currentTargetText.
  function flushHistoryEntry(marker: string | null): void {
    if (!currentTargetText && !marker) return;
    const entry: RenderedTurn = {
      time: new Date().toTimeString().slice(0, 5),
      target: currentTargetText.slice(0, 280),
      source: currentSourceText.slice(0, 220),
      marker: marker || null,
    };
    history.unshift(entry);
    if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
    currentTargetText = "";
    renderHistory();
  }
  // Append a finished turn (legacy pushHistoryTurn() — the no-arg call sites at
  // content.js:826, 1379). The contract supplies the turn's text; we mirror it
  // into the current-turn buffer so the flush captures it byte-identically.
  function pushHistoryTurn(turn: HistoryTurn): void {
    if (turn.target) currentTargetText = turn.target;
    if (turn.source) currentSourceText = turn.source;
    flushHistoryEntry(null);
  }
  // Append a marker chip (legacy pushHistoryTurn({marker}) — content.js:942/945:
  // "vi → en" on language swap, "Switching voice" on voice change).
  function pushHistoryMarker(text: string): void {
    flushHistoryEntry(text);
  }
  function renderHistory(): void {
    if (!elements.history) return;
    elements.history.replaceChildren();
    if (!history.length) {
      elements.history.hidden = true;
      applyLayout();
      paintTargetPane();
      return;
    }
    elements.history.hidden = false;
    for (const turn of history) {
      if (turn.marker) {
        const wrap = document.createElement("div");
        wrap.className = "ec-h-marker";
        const chip = document.createElement("span");
        chip.className = "ec-h-marker-chip";
        chip.textContent = turn.marker;
        wrap.appendChild(chip);
        elements.history.appendChild(wrap);
      }
      const item = document.createElement("div");
      item.className = "ec-h-item";
      const meta = document.createElement("span");
      meta.className = "ec-h-meta";
      meta.textContent = turn.time;
      const text = document.createElement("span");
      text.className = "ec-h-text";
      text.textContent = turn.target;
      item.append(meta, text);
      elements.history.appendChild(item);
    }
    applyLayout();
  }

  function isMounted(): boolean {
    return root != null;
  }

  function setDubSyncReadout(
    readout: import("@/lib/dub-playback-sync").DubSyncReadout | null,
  ): void {
    if (!elements.lagLine || !elements.lagWrap) return;
    const hint = elements.syncHint;
    if (readout == null) {
      elements.lagLine.textContent = "—";
      elements.lagWrap.classList.add("ec-lag-empty");
      elements.lagWrap.classList.remove("ec-lag-matching");
      if (elements.lagLabel) elements.lagLabel.textContent = "lag";
      if (hint) hint.hidden = true;
      return;
    }

    elements.lagWrap.classList.remove("ec-lag-empty");
    const matching =
      readout.mode === "slow" ||
      readout.mode === "hard" ||
      readout.mode === "catchup";
    if (matching) {
      elements.lagWrap.classList.add("ec-lag-matching");
      elements.lagLine.textContent = String(readout.ratePct);
      if (elements.lagLabel) elements.lagLabel.textContent = "sync";
      if (hint) {
        const verb =
          readout.mode === "catchup" ? "Catching up" : "Matching dub";
        hint.textContent = `${verb} · ${readout.ratePct}%`;
        hint.hidden = false;
      }
    } else {
      elements.lagWrap.classList.remove("ec-lag-matching");
      elements.lagLine.textContent = String(readout.lagSec);
      if (elements.lagLabel) elements.lagLabel.textContent = "lag";
      if (hint) hint.hidden = true;
    }
  }

  return {
    buildOverlay,
    removeOverlay,
    setOverlayState,
    setStatusText,
    setTargetText,
    setSourceText,
    applySourceVisibility,
    pushHistoryTurn,
    pushHistoryMarker,
    showToast,
    populateVoicePicker,
    syncFromSettings,
    setLanguageSelection,
    setCaptionPosition,
    setMixVolumes,
    applyCaptionOnVideo,
    isMounted,
    setDubSyncReadout,
  };
};
