// On-page quick-start launcher.
//
// A small Echoly button injected on supported pages when the user is signed in,
// there's a dubbable video, and no session is active — so they can start dubbing
// without opening the popup. Clicking sends START_REQUEST (the same start path as
// the popup). While the launcher is plausibly useful it also pings the background
// every KEEPALIVE_MS, keeping the MV3 service worker warm (P2) so the first
// connect is off the cold-start path.
//
// Visibility is DERIVED state: signedIn && hasVideo && !sm.session && !starting.
// The host (content/index.ts) calls refresh() on session start/stop; a periodic
// tick re-evaluates for SPA navigation + sign-in changes.

import type { ContentApp } from "./index";

const KEEPALIVE_MS = 20_000;
const START_OPTIMISTIC_HIDE_MS = 3000;
const LAUNCHER_POS_KEY = "echolyLauncherPos";
const DRAG_THRESHOLD_PX = 5;
// Fallback height used when getBoundingClientRect returns 0×0 (e.g. jsdom).
// Keep in sync with overlay.css: 46px mark + 8px click-halo padding top/bottom.
const LAUNCHER_H = 62;
const VIEWPORT_PAD = 8;

const LAUNCHER_MARK_SVG = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 9v6M11 6v12M15 8v8M19 11v2" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>`;

// The launcher is ALWAYS docked flush to the right viewport edge; the user can
// only slide it up/down, so the persisted position is the vertical center alone.
// (Older records also carried a `left` — it is intentionally ignored on load,
// which heals any stale mid-screen placement from the previous free-drag design.)
interface LauncherPos {
  /** Vertical center (px) when userPlaced. */
  centerY: number | null;
  userPlaced: boolean;
}

const DEFAULT_LAUNCHER_POS: LauncherPos = {
  centerY: null,
  userPlaced: false,
};

function loadLauncherPos(): LauncherPos {
  try {
    const raw = localStorage.getItem(LAUNCHER_POS_KEY);
    if (!raw) return { ...DEFAULT_LAUNCHER_POS };
    const parsed = JSON.parse(raw) as Partial<LauncherPos>;
    if (!parsed.userPlaced) return { ...DEFAULT_LAUNCHER_POS };
    return {
      centerY: typeof parsed.centerY === "number" ? parsed.centerY : null,
      userPlaced: true,
    };
  } catch {
    return { ...DEFAULT_LAUNCHER_POS };
  }
}

function saveLauncherPos(pos: LauncherPos): void {
  try {
    localStorage.setItem(LAUNCHER_POS_KEY, JSON.stringify(pos));
  } catch {
    /* quota / private mode */
  }
}

// Pure clamping helper — height is parameterized so the measured BCR value can
// be passed in; LAUNCHER_H serves as the fallback for 0×0 environments.
export function clampLauncherCenterY(
  centerY: number,
  vh: number,
  h: number = LAUNCHER_H,
): number {
  const halfH = h / 2;
  return Math.min(
    Math.max(halfH + VIEWPORT_PAD, centerY),
    vh - halfH - VIEWPORT_PAD,
  );
}

export class QuickStartLauncher {
  #app: ContentApp;
  #el: HTMLButtonElement | null = null;
  #signedIn = false;
  #starting = false;
  #tickTimer: ReturnType<typeof setInterval> | null = null;
  #startResetTimer: ReturnType<typeof setTimeout> | null = null;
  #resaveTimer: ReturnType<typeof setTimeout> | null = null;
  #unbindDrag: (() => void) | null = null;
  #pos: LauncherPos = loadLauncherPos();
  #suppressClick = false;
  #destroyed = false;

  constructor(app: ContentApp) {
    this.#app = app;
  }

  async init(): Promise<void> {
    await this.#refreshSignedIn();
    this.#update();
    this.#tickTimer = setInterval(() => void this.#tick(), KEEPALIVE_MS);
    document.addEventListener("visibilitychange", this.#onVisibility);
    window.addEventListener("resize", this.#onResize);
  }

  /** Re-evaluate visibility now (called by the host on session start/stop). */
  refresh(): void {
    this.#update();
  }

  destroy(): void {
    this.#destroyed = true;
    if (this.#tickTimer) clearInterval(this.#tickTimer);
    if (this.#startResetTimer) clearTimeout(this.#startResetTimer);
    if (this.#resaveTimer) {
      clearTimeout(this.#resaveTimer);
      this.#resaveTimer = null;
    }
    document.removeEventListener("visibilitychange", this.#onVisibility);
    window.removeEventListener("resize", this.#onResize);
    this.#remove();
  }

  #onVisibility = (): void => {
    if (document.visibilityState === "visible") void this.#tick();
  };

  #onResize = (): void => {
    if (!this.#el || !this.#pos.userPlaced) return;
    if (this.#pos.centerY == null) return;
    const centerY = clampLauncherCenterY(
      this.#pos.centerY,
      window.innerHeight,
      this.#measuredHeight(),
    );
    this.#pos = { centerY, userPlaced: true };
    this.#applyPos();
    // Debounce the localStorage write ~150 ms to avoid spamming storage on
    // rapid resize events (e.g. window-resize animation).
    if (this.#resaveTimer !== null) clearTimeout(this.#resaveTimer);
    this.#resaveTimer = setTimeout(() => {
      this.#resaveTimer = null;
      saveLauncherPos(this.#pos);
    }, 150);
  };

  async #tick(): Promise<void> {
    if (this.#destroyed) return;
    await this.#refreshSignedIn();
    this.#update();
  }

  async #refreshSignedIn(): Promise<void> {
    try {
      const reply = (await chrome.runtime.sendMessage({
        type: "GET_LAUNCH_STATE",
      })) as { ok: true; signedIn: boolean } | { ok: false } | undefined;
      this.#signedIn = !!(reply && reply.ok && reply.signedIn);
    } catch {
      /* keep last known sign-in state */
    }
  }

  #hasVideo(): boolean {
    try {
      return !!(this.#app.adapter.findVideo() ?? this.#app.capture.findVideo());
    } catch {
      return false;
    }
  }

  #shouldShow(): boolean {
    return (
      this.#signedIn &&
      !this.#starting &&
      !this.#app.sm.session &&
      this.#hasVideo()
    );
  }

  #update(): void {
    if (this.#destroyed) return;
    if (this.#shouldShow()) this.#mount();
    else this.#remove();
  }

  /** Returns the button's rendered height; falls back to LAUNCHER_H when 0
   *  (jsdom / not yet painted). */
  #measuredHeight(): number {
    if (!this.#el) return LAUNCHER_H;
    const rect = this.#el.getBoundingClientRect();
    return rect.height > 0 ? rect.height : LAUNCHER_H;
  }

  #applyPos(): void {
    if (!this.#el) return;
    // Always docked flush to the right viewport edge — only `top` is variable.
    this.#el.style.left = "auto";
    this.#el.style.right = "0";
    if (this.#pos.userPlaced && this.#pos.centerY != null) {
      const centerY = clampLauncherCenterY(
        this.#pos.centerY,
        window.innerHeight,
        this.#measuredHeight(),
      );
      this.#el.style.top = `${centerY}px`;
    } else {
      this.#el.style.top = "50%";
    }
    this.#el.style.transform = "translateY(-50%)";
  }

  #mount(): void {
    if (this.#el) return;
    const btn = document.createElement("button");
    btn.className = "ec-launcher";
    btn.type = "button";
    btn.title = "Dub with Echoly · drag up or down to move";
    btn.setAttribute("aria-label", "Start dubbing with Echoly");

    const mark = document.createElement("span");
    mark.className = "ec-launcher-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.innerHTML = LAUNCHER_MARK_SVG;
    btn.appendChild(mark);

    // Hover label — floating chip positioned to the left of the button.
    // Created via createElement + textContent (no innerHTML) per contract.
    const label = document.createElement("span");
    label.className = "ec-launcher-label";
    label.textContent = "Start dubbing";
    btn.appendChild(label);

    btn.addEventListener("click", this.#onClick);
    this.#bindDrag(btn);
    document.body.appendChild(btn);
    this.#el = btn;
    this.#applyPos();
  }

  #bindDrag(btn: HTMLButtonElement): void {
    let originCenterY = 0;
    let startX = 0;
    let startY = 0;
    let lastCenterY = 0;
    let dragging = false;

    const onPointerDown = (e: PointerEvent): void => {
      if (e.button !== 0) return;
      dragging = false;
      this.#suppressClick = false;
      const rect = btn.getBoundingClientRect();
      originCenterY = rect.top + rect.height / 2;
      startX = e.clientX;
      startY = e.clientY;
      btn.setPointerCapture(e.pointerId);
      e.preventDefault();
    };

    // Vertical-only drag: the launcher never leaves the right edge — the
    // horizontal pointer delta only counts toward the click-vs-drag threshold.
    const onPointerMove = (e: PointerEvent): void => {
      if (!btn.hasPointerCapture(e.pointerId)) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      dragging = true;
      this.#suppressClick = true;
      btn.classList.add("ec-launcher-dragging");
      lastCenterY = clampLauncherCenterY(
        originCenterY + dy,
        window.innerHeight,
        this.#measuredHeight(),
      );
      btn.style.top = `${lastCenterY}px`;
      btn.style.transform = "translateY(-50%)";
    };

    const onPointerEnd = (e: PointerEvent): void => {
      if (!btn.hasPointerCapture(e.pointerId)) return;
      btn.releasePointerCapture(e.pointerId);
      btn.classList.remove("ec-launcher-dragging");
      if (dragging) {
        this.#pos = { centerY: lastCenterY, userPlaced: true };
        saveLauncherPos(this.#pos);
        this.#applyPos();
        e.preventDefault();
      }
      dragging = false;
    };

    btn.addEventListener("pointerdown", onPointerDown);
    btn.addEventListener("pointermove", onPointerMove);
    btn.addEventListener("pointerup", onPointerEnd);
    btn.addEventListener("pointercancel", onPointerEnd);

    this.#unbindDrag = () => {
      btn.removeEventListener("pointerdown", onPointerDown);
      btn.removeEventListener("pointermove", onPointerMove);
      btn.removeEventListener("pointerup", onPointerEnd);
      btn.removeEventListener("pointercancel", onPointerEnd);
    };
  }

  #remove(): void {
    this.#unbindDrag?.();
    this.#unbindDrag = null;
    if (this.#el) {
      this.#el.removeEventListener("click", this.#onClick);
      this.#el.remove();
      this.#el = null;
    }
  }

  #onClick = (e: MouseEvent): void => {
    if (this.#suppressClick) {
      this.#suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    this.#starting = true;
    this.#remove();
    void chrome.runtime.sendMessage({ type: "START_REQUEST" })?.catch?.(() => {});
    if (this.#startResetTimer) clearTimeout(this.#startResetTimer);
    this.#startResetTimer = setTimeout(() => {
      this.#starting = false;
      this.#update();
    }, START_OPTIMISTIC_HIDE_MS);
  };
}
