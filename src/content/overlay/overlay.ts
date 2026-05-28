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

import {
  HISTORY_MAX,
  LANGUAGES,
  LAYOUT_KEY,
  REALTIME_VOICES,
  RTL_LANGS,
  STANDARD_DEFAULT_VOICE,
  STANDARD_VOICES,
} from "@/shared/constants";
import type {
  CreateOverlay,
  OverlayCallbacks,
  OverlayState,
  OverlayView,
  ToastOptions,
} from "@/shared/ports";
import type { HistoryTurn, TranslationTier } from "@/shared/types";
import {
  clampLayout,
  DEFAULT_LAYOUT,
  isCompact,
  isRoomy,
  OVERLAY_TEMPLATE,
  targetLines,
  type Layout,
} from "./template";

/** Internal cached element refs (legacy `elements` map, content.js:230-240). */
interface Elements {
  status: HTMLElement | null;
  langSelect: HTMLSelectElement | null;
  voiceSelect: HTMLSelectElement | null;
  target: HTMLElement | null;
  source: HTMLElement | null;
  history: HTMLElement | null;
  hideBtn: HTMLElement | null;
  stopBtn: HTMLElement | null;
  drag: HTMLElement | null;
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
    source: null,
    history: null,
    hideBtn: null,
    stopBtn: null,
    drag: null,
  };
}

export const createOverlay: CreateOverlay = (): OverlayView => {
  let root: HTMLElement | null = null;
  let elements: Elements = emptyElements();
  let layout: Layout = loadLayout();
  let history: RenderedTurn[] = [];
  let currentTargetText = "";
  let currentSourceText = "";
  // Active tier + selected voice/language — the view tracks just enough to
  // re-render the voice picker and apply RTL on target text. These mirror the
  // legacy `settings?.tier`/`settings?.targetLanguage` reads inside the overlay.
  let activeTier: TranslationTier = "realtime";
  let selectedLanguage = "vi";
  let selectedRealtimeVoice = "marin";
  let selectedStandardVoice = STANDARD_DEFAULT_VOICE;

  // Keep a stable bound reference so removeOverlay can unbind the window listener.
  const onWindowResize = () => applyLayout();

  function loadLayout(): Layout {
    try {
      return {
        ...DEFAULT_LAYOUT,
        ...JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}"),
      };
    } catch {
      return { ...DEFAULT_LAYOUT };
    }
  }
  function saveLayout(): void {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {
      /* localStorage may be unavailable — ignore (legacy behavior) */
    }
  }

  function applyLayout(): void {
    if (!root) return;
    layout = clampLayout(layout, window.innerWidth, window.innerHeight);
    root.style.left = layout.left + "px";
    root.style.top = layout.top + "px";
    root.style.width = layout.width + "px";
    root.style.height = layout.height + "px";
    root.style.right = "auto";
    root.style.bottom = "auto";
    root.classList.toggle("is-side-collapsed", !!layout.sideCollapsed);
    root.classList.toggle("is-compact", isCompact(layout.width!, layout.height!));
    root.classList.toggle("is-roomy", isRoomy(layout.width!, layout.height!));
    root.style.setProperty(
      "--ec-target-lines",
      String(targetLines(layout.height!)),
    );
    if (elements.hideBtn) {
      elements.hideBtn.textContent = layout.sideCollapsed ? "Show" : "Hide";
    }
  }

  // Tier-aware voice list rebuild. Realtime exposes the 9 voices + "Auto";
  // Standard exposes the 5 curated voices. (Overlay renders "Auto" — the popup
  // renders "Auto · clones speaker"; the difference is intentional.)
  function populateVoicePicker(
    tier: TranslationTier,
    selectedVoiceId?: string,
  ): void {
    if (!elements.voiceSelect) return;
    elements.voiceSelect.replaceChildren();
    if (tier === "standard") {
      for (const [id, name] of STANDARD_VOICES) {
        const opt = document.createElement("option");
        opt.value = id;
        opt.textContent = name;
        elements.voiceSelect.appendChild(opt);
      }
      elements.voiceSelect.value =
        selectedVoiceId ?? selectedStandardVoice ?? STANDARD_DEFAULT_VOICE;
    } else {
      const autoOpt = document.createElement("option");
      autoOpt.value = "";
      autoOpt.textContent = "Auto";
      elements.voiceSelect.appendChild(autoOpt);
      for (const v of REALTIME_VOICES) {
        const opt = document.createElement("option");
        opt.value = v;
        opt.textContent = v.charAt(0).toUpperCase() + v.slice(1);
        elements.voiceSelect.appendChild(opt);
      }
      elements.voiceSelect.value =
        selectedVoiceId ?? selectedRealtimeVoice ?? "marin";
    }
  }

  function buildOverlay(callbacks: OverlayCallbacks): void {
    if (root) return;
    root = document.createElement("aside");
    root.className = "ec-root";
    root.dataset.state = "ready";
    root.innerHTML = OVERLAY_TEMPLATE;
    document.documentElement.appendChild(root);

    elements = {
      status: root.querySelector("[data-ec-status]"),
      langSelect: root.querySelector("[data-ec-language]"),
      voiceSelect: root.querySelector("[data-ec-voice]"),
      target: root.querySelector("[data-ec-target]"),
      source: root.querySelector("[data-ec-source]"),
      history: root.querySelector("[data-ec-history]"),
      hideBtn: root.querySelector("[data-ec-hide]"),
      stopBtn: root.querySelector("[data-ec-stop]"),
      drag: root.querySelector("[data-ec-drag]"),
    };

    // Populate language picker (verbatim from legacy buildOverlay).
    if (elements.langSelect) {
      for (const [code, name] of LANGUAGES) {
        const opt = document.createElement("option");
        opt.value = code;
        opt.textContent = name;
        elements.langSelect.appendChild(opt);
      }
    }

    populateVoicePicker(activeTier);
    if (elements.langSelect) elements.langSelect.value = selectedLanguage;

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
      if (activeTier === "standard") selectedStandardVoice = newVoice;
      else selectedRealtimeVoice = newVoice;
      callbacks.onVoiceChange(newVoice);
    });
    // Hide toggle is pure UI (legacy mutated layout + saved + re-applied).
    elements.hideBtn?.addEventListener("click", () => {
      layout.sideCollapsed = !layout.sideCollapsed;
      saveLayout();
      applyLayout();
    });
    elements.stopBtn?.addEventListener("click", () => {
      callbacks.onStop();
    });

    bindDragResize();
    applyLayout();

    window.addEventListener("resize", onWindowResize);
  }

  function removeOverlay(): void {
    if (!root) return;
    window.removeEventListener("resize", onWindowResize);
    root.remove();
    root = null;
    elements = emptyElements();
  }

  // ───── Drag + resize (legacy bindDragResize, content.js:363-418) ─────
  function bindDragResize(): void {
    if (!root || !elements.drag) return;
    let dragMode: string | null = null;
    let pointer: PointerOrigin | null = null;

    elements.drag.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if ((e.target as Element).closest("button, select, input")) return;
      dragMode = "move";
      pointer = capturePointer(e);
      root!.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    });

    for (const handle of root.querySelectorAll<HTMLElement>(
      "[data-ec-resize]",
    )) {
      handle.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        dragMode = "resize-" + handle.dataset.ecResize;
        pointer = capturePointer(e);
        handle.setPointerCapture?.(e.pointerId);
        e.preventDefault();
      });
    }

    root.addEventListener("pointermove", (e) => {
      if (!dragMode || !pointer) return;
      const dx = e.clientX - pointer.x;
      const dy = e.clientY - pointer.y;
      if (dragMode === "move") {
        layout.left = pointer.left + dx;
        layout.top = pointer.top + dy;
      } else {
        const m = dragMode.slice(7); // remove "resize-"
        if (m.includes("e")) layout.width = pointer.width + dx;
        if (m.includes("s")) layout.height = pointer.height + dy;
        if (m.includes("w")) {
          layout.width = pointer.width - dx;
          layout.left = pointer.left + dx;
        }
        if (m.includes("n")) {
          layout.height = pointer.height - dy;
          layout.top = pointer.top + dy;
        }
      }
      applyLayout();
    });

    root.addEventListener("pointerup", () => {
      if (dragMode) saveLayout();
      dragMode = null;
      pointer = null;
    });
    root.addEventListener("pointercancel", () => {
      dragMode = null;
      pointer = null;
    });
  }

  function capturePointer(e: PointerEvent): PointerOrigin {
    const rect = root!.getBoundingClientRect();
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
  }
  function setStatusText(text: string): void {
    if (elements.status) elements.status.textContent = text;
  }
  function setTargetText(text: string): void {
    if (!elements.target) return;
    currentTargetText = text;
    elements.target.textContent = text;
    elements.target.dir = RTL_LANGS.has(selectedLanguage) ? "rtl" : "ltr";
  }
  function setSourceText(text: string): void {
    currentSourceText = text;
    if (elements.source) elements.source.textContent = text.slice(-220);
  }
  function applySourceVisibility(show: boolean): void {
    if (!elements.source) return;
    elements.source.hidden = !show;
  }
  // Sync the target-language <select> value (legacy applySettingsLive
  // content.js:2325-2326 + post-handover sync content.js:953). No-op if not
  // mounted. Tracks selectedLanguage so subsequent setTargetText applies the
  // correct RTL/LTR direction.
  function setLanguageSelection(lang: string): void {
    selectedLanguage = lang;
    if (elements.langSelect) elements.langSelect.value = lang;
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
  }

  function isMounted(): boolean {
    return root != null;
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
    setLanguageSelection,
    isMounted,
  };
};
