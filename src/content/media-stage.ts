// Platform-agnostic media stage: find the primary <video>, track its rect, and
// anchor overlay UI (caption pill, default dock) inside the player safe zone.

import type { CaptionStripPlacement } from "@/shared/advanced";

export type MediaPlatform = "youtube" | "generic";

export interface MediaStageInsets {
  /** px above the stage bottom edge (player controls). */
  bottom: number;
  /** px below the stage top edge. */
  top: number;
  /** horizontal padding inside the stage. */
  side: number;
}

export interface MediaStageSnapshot {
  rect: DOMRectReadOnly;
  insets: MediaStageInsets;
}

export function detectMediaPlatform(): MediaPlatform {
  const host = location.hostname.replace(/^www\./, "");
  if (host === "youtube.com" || host.endsWith(".youtube.com")) return "youtube";
  return "generic";
}

export function findPrimaryVideo(): HTMLVideoElement | null {
  const platform = detectMediaPlatform();
  if (platform === "youtube") {
    return (
      document.querySelector<HTMLVideoElement>("video.html5-main-video") ||
      document.querySelector<HTMLVideoElement>(".html5-video-player video") ||
      document.querySelector<HTMLVideoElement>("video")
    );
  }
  return pickLargestVisibleVideo();
}

function pickLargestVisibleVideo(): HTMLVideoElement | null {
  let best: HTMLVideoElement | null = null;
  let bestArea = 0;
  for (const el of document.querySelectorAll("video")) {
    const r = el.getBoundingClientRect();
    if (r.width < 160 || r.height < 90) continue;
    const area = r.width * r.height;
    if (area > bestArea) {
      bestArea = area;
      best = el;
    }
  }
  return best;
}

export function stageInsets(platform: MediaPlatform): MediaStageInsets {
  switch (platform) {
    case "youtube":
      return { bottom: 72, top: 52, side: 20 };
    default:
      return { bottom: 56, top: 44, side: 16 };
  }
}

export function captionAnchorStyles(
  snapshot: MediaStageSnapshot,
  placement: CaptionStripPlacement,
): Partial<CSSStyleDeclaration> {
  const { rect, insets } = snapshot;
  const inner = rect.width - insets.side * 2;
  const maxWidth = `${Math.min(720, Math.max(280, Math.round(inner * 0.92)))}px`;
  const centerX = rect.left + rect.width / 2;
  if (placement === "top") {
    return {
      left: `${centerX}px`,
      right: "auto",
      top: `${rect.top + insets.top}px`,
      bottom: "auto",
      transform: "translateX(-50%)",
      maxWidth,
    };
  }
  return {
    left: `${centerX}px`,
    right: "auto",
    top: "auto",
    bottom: `${window.innerHeight - rect.bottom + insets.bottom}px`,
    transform: "translateX(-50%)",
    maxWidth,
  };
}

/** Default dock: top-right inside the video stage (any site with a <video>). */
export function defaultDockPosition(
  snapshot: MediaStageSnapshot,
  dockW = 220,
  dockH = 46,
): { left: number; top: number } {
  const { rect, insets } = snapshot;
  const padX = insets.side;
  const padTop = Math.min(insets.top, 14);
  return {
    left: rect.right - dockW - padX,
    top: rect.top + padTop,
  };
}

export function clampDockToStage(
  left: number,
  top: number,
  snapshot: MediaStageSnapshot,
  dockW = 220,
  dockH = 46,
): { left: number; top: number } {
  const { rect, insets } = snapshot;
  const padX = insets.side;
  const padTop = Math.min(insets.top, 14);
  const padBottom = insets.bottom;
  return {
    left: Math.min(Math.max(rect.left + padX, left), rect.right - dockW - padX),
    top: Math.min(
      Math.max(rect.top + padTop, top),
      rect.bottom - dockH - Math.min(padBottom, 24),
    ),
  };
}

export type MediaStageListener = (snapshot: MediaStageSnapshot | null) => void;

const scheduleFrame =
  typeof globalThis.requestAnimationFrame === "function"
    ? (cb: FrameRequestCallback) => globalThis.requestAnimationFrame(cb)
    : (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 0) as unknown as number;

const cancelFrame =
  typeof globalThis.cancelAnimationFrame === "function"
    ? (id: number) => globalThis.cancelAnimationFrame(id)
    : (id: number) => clearTimeout(id);

let activeStageUnwatch: (() => void) | null = null;

/** Test-only: overlay specs remove DOM without calling removeOverlay(). */
export function disposeMediaStageWatch(): void {
  activeStageUnwatch?.();
  activeStageUnwatch = null;
}

/** Poll + resize/scroll observers — works on any site with a visible <video>. */
export function watchMediaStage(onUpdate: MediaStageListener): () => void {
  activeStageUnwatch?.();
  let raf = 0;
  let disposed = false;
  let observed: HTMLVideoElement | null = null;
  const ro =
    typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => schedule())
      : null;
  const mo = new MutationObserver(() => schedule());

  const emit = () => {
    const video = findPrimaryVideo();
    if (video !== observed) {
      if (observed && ro) ro.unobserve(observed);
      observed = video;
      if (observed && ro) ro.observe(observed);
    }
    if (!video) {
      onUpdate(null);
      return;
    }
    onUpdate({
      rect: video.getBoundingClientRect(),
      insets: stageInsets(detectMediaPlatform()),
    });
  };

  const schedule = () => {
    if (disposed) return;
    cancelFrame(raf);
    raf = scheduleFrame(emit);
  };

  mo.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style"],
  });
  window.addEventListener("resize", schedule, { passive: true });
  window.addEventListener("scroll", schedule, { passive: true, capture: true });
  const poll = window.setInterval(schedule, 400);
  schedule();

  const unwatch = () => {
    if (disposed) return;
    disposed = true;
    cancelFrame(raf);
    clearInterval(poll);
    mo.disconnect();
    ro?.disconnect();
    window.removeEventListener("resize", schedule);
    window.removeEventListener("scroll", schedule, true);
    if (activeStageUnwatch === unwatch) activeStageUnwatch = null;
  };
  activeStageUnwatch = unwatch;
  return unwatch;
}
